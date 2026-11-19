import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const serverFile = fileURLToPath(new URL('../server.mjs', import.meta.url));
const cart = (sessionId, options = {}) => ({
  sessionId, fulfillment: 'here', items: [{ itemId: 'flat-white', quantity: 2, modifiers: { milk: 'oat', shot: 'extra' } }],
  idempotencyKey: randomUUID(), ...options,
});
const bucket = (id, channel) => parseInt(createHash('sha256').update(`fold.kiosk/${channel}\n${id}`).digest('hex').slice(0, 8), 16) % 10_000;

test('signed kiosk fleet, pinned checkout, kitchen state and restart', { timeout: 60_000 }, async t => {
  const data = mkdtempSync(join(tmpdir(), 'fold-integration-'));
  const env = { ...process.env, FOLD_PORT: '0', FOLD_DATA: data };
  let child;
  let origin;
  function spawnServer() {
    const candidate = spawn(process.execPath, [serverFile], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    candidate.log = '';
    for (const stream of [candidate.stdout, candidate.stderr]) stream.on('data', chunk => { candidate.log += chunk; });
    return candidate;
  }
  async function start() {
    child = spawnServer();
    for (let i = 0; i < 300 && child.exitCode === null; i++) {
      const ready = child.log.match(/Fold kiosk ready at (http:\/\/127\.0\.0\.1:\d+)/);
      if (ready) {
        origin = ready[1];
        assert.deepEqual(await request('health'), { ok: true, app: 'fold-kiosk' });
        return;
      }
      await wait(50);
    }
    throw new Error(`Fold server did not become ready.\n${child.log}`);
  }
  async function stop(signal = 'SIGTERM') {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill(signal);
    await exited;
  }
  t.after(async () => {
    await stop();
    rmSync(data, { recursive: true, force: true });
  });
  async function request(path, payload, expected = 200, headers = {}) {
    const options = { signal: AbortSignal.timeout(12_000), headers };
    if (payload) Object.assign(options, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(payload),
    });
    const response = await fetch(`${origin}/api/${path}`, options);
    const value = await response.json();
    assert.equal(response.status, expected, `${path}: ${JSON.stringify(value)}`);
    return value;
  }
  const open = id => request('sessions', { deviceId: id }, 201);
  const checkout = (payload, status = 201) => request('orders', payload, status);
  const state = id => request('devices').then(result => result.devices.find(device => device.id === id));
  const release = (selection = {}) => request('rollout', { version: 2, channel: 'all', ...selection });
  const rollback = () => request('rollback', {});
  const status = ({ id }, newStatus, expected = 200) => request(`orders/${id}/status`, { status: newStatus }, expected);

  await start();
  let oldSession;
  let seasonalSession;
  let firstOrder;
  let seasonalOrder;
  let originalRollout;

  await t.test('initial signed WASM is acknowledged in three stores and two channels', async () => {
    const initial = await request('devices');
    assert.equal(initial.devices.length, 6);
    assert.equal(new Set(initial.devices.map(device => device.storeId)).size, 3);
    assert.equal(new Set(initial.devices.map(device => device.channel)).size, 2);
    assert.ok(initial.devices.every(device =>
      device.status === 'live' && device.installedVersion === 1 && device.wireVersion === 1 && device.ackMs >= 0));
    assert.equal(initial.audit.filter(entry => entry.event === 'Device acknowledged').length, 6);
    assert.match(initial.releases[0].hash, /^[0-9a-f]{64}$/);
    assert.notEqual(initial.releases[0].hash, initial.releases[1].hash);
    const candidate = await request('releases/2');
    assert.ok(candidate.menu.items.length >= 50);
    assert.ok(candidate.menu.items.some(item => item.id === 'maple-cloud-latte'));
    assert.equal((await state('market-02')).installedVersion, 1);
    await request('releases/42', undefined, 404);
    await request('sessions', { deviceId: 'unknown' }, 404);
    await request('rollout', { version: 2, channel: 'beta' }, 403, { Origin: 'https://example.com' });
    await request('rollout', { version: 2, channel: 'stable', deviceId: 'market-02' }, 422);
    await request('rollout', { version: 2, channel: 'all', percentage: 101 }, 422);
    oldSession = await open('market-02');
    assert.equal(oldSession.menu.version, 1);
    assert.ok(oldSession.menu.items.length >= 50);
    for (const menu of [oldSession.menu, candidate.menu]) {
      assert.equal(new Set(menu.items.map(item => item.id)).size, menu.items.length);
      assert.ok(menu.items.every(item => menu.categories.some(category => category.id === item.categoryId)));
    }
  });

  await t.test('channel, exact device and deterministic percentage targeting', async () => {
    const zero = await release({ percentage: 0 });
    assert.deepEqual(zero.rollout.selected, []);
    const stream = await fetch(`${origin}/api/events`, { signal: AbortSignal.timeout(10_000) });
    const reader = stream.body.getReader();
    try {
      const beta = await release({ channel: 'beta' });
      assert.equal(beta.rollout.selected.length, 3);
      for (const device of beta.devices) assert.equal(device.installedVersion, device.channel === 'beta' ? 2 : 1);
      let message = '';
      while (!message.includes('data: {"type":"fleet"}')) {
        const { value, done } = await reader.read();
        assert.equal(done, false, 'Expected an SSE fleet notification');
        message += new TextDecoder().decode(value);
      }
    } finally {
      await reader.cancel();
    }

    const exact = await release({ deviceId: 'market-01' });
    assert.deepEqual(exact.rollout.selected, ['market-01']);
    assert.equal(exact.devices.find(device => device.id === 'north-01').installedVersion, 1);
    assert.equal(exact.devices.find(device => device.id === 'market-01').installedVersion, 2);
    const stableShare = exact.devices.filter(device => device.channel === 'stable' && bucket(device.id, 'stable') < 5_000).map(device => device.id);
    assert.ok(stableShare.length > 0 && stableShare.length < 3);
    originalRollout = await release({ channel: 'stable', percentage: 50 });
    assert.deepEqual(originalRollout.rollout.selected, stableShare);
    assert.ok(originalRollout.devices.every(device => device.installedVersion ===
      (stableShare.includes(device.id) || device.id === 'market-01' || device.channel === 'beta' ? 2 : 1)));
    const repeat = await release({ channel: 'stable', percentage: 50 });
    assert.deepEqual(repeat.rollout.selected, stableShare);
    assert.deepEqual(repeat.devices, originalRollout.devices, 'Repeated identical rollout should not republish installed devices');
    originalRollout = repeat;
    seasonalSession = await open('market-02');
    assert.equal(seasonalSession.session.version, 2);
  });

  await t.test('server prices pinned menus and atomically deduplicates concurrent checkout retries', async () => {
    const old = cart(oldSession.session.id, {
      items: [{ itemId: 'flat-white', quantity: 2, priceCents: 1, modifiers: { milk: 'oat', shot: 'extra' } }],
      totalCents: 1,
    });
    const { quote } = await request('quote', old);
    assert.equal(quote.items[0].unitPriceCents, 625);
    assert.equal(quote.subtotalCents, 1250);
    assert.equal(quote.taxCents, 103);
    assert.equal(quote.totalCents, 1353);
    assert.equal((await request('quote', cart(seasonalSession.session.id))).quote.totalCents, 1407);
    await request('quote', cart(oldSession.session.id, { items: [{ itemId: 'maple-cloud-latte', quantity: 1 }] }), 422);
    await request('quote', cart(oldSession.session.id, { items: [{ itemId: 'flat-white', quantity: 1 }] }), 422);
    await request('quote', cart(oldSession.session.id, { items: [{ itemId: 'flat-white', quantity: 1, modifiers: { milk: 'rice' } }] }), 422);
    await request('quote', cart(oldSession.session.id, { items: [{ itemId: 'pain-au-chocolat', quantity: 21 }] }), 422);

    const attempts = await Promise.all(Array.from({ length: 12 }, async () => {
      const response = await fetch(`${origin}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(old),
        signal: AbortSignal.timeout(5000),
      });
      assert.ok([200, 201].includes(response.status));
      return { statusCode: response.status, ...await response.json() };
    }));
    assert.equal(attempts.filter(result => result.statusCode === 201 && !result.duplicate).length, 1);
    assert.ok(attempts.filter(result => result.statusCode === 200).every(result => result.duplicate));
    assert.equal(new Set(attempts.map(result => result.order.id)).size, 1);
    firstOrder = attempts[0].order;
    assert.equal(firstOrder.version, 1);
    assert.equal(firstOrder.pickup.title, oldSession.menu.pickup.title);
    assert.equal(firstOrder.totalCents, quote.totalCents);
    assert.deepEqual(await request('pickup?store=market'), { storeId: 'market', orders: [] });
    await checkout({ ...old, fulfillment: 'to-go' }, 409);
    await checkout({ ...old, idempotencyKey: randomUUID() }, 409);
    const { orders, counts } = await request('orders');
    assert.equal(orders.length, 1);
    assert.equal(counts.received, 1);
    assert.equal((await request('sessions/' + oldSession.session.id)).session.orderId, firstOrder.id);
    assert.deepEqual((await request(`orders/${firstOrder.id}?sessionId=${oldSession.session.id}`)).order, firstOrder);
    await request(`orders/${firstOrder.id}?sessionId=${seasonalSession.session.id}`, undefined, 404);
    await status(firstOrder, 'ready', 409);
    assert.equal((await status(firstOrder, 'preparing')).order.status, 'preparing');
    await status(firstOrder, 'preparing');
    await status(firstOrder, 'ready');
    assert.equal((await status(firstOrder, 'completed')).order.status, 'completed');
    await status(firstOrder, 'received', 409);
    assert.equal((await checkout(old, 200)).order.status, 'completed');
  });

  await t.test('restart restores channel assignments and rollback preserves both orders and open carts', async () => {
    const locked = spawnServer();
    const [exit] = await once(locked, 'exit');
    assert.notEqual(exit, 0);
    assert.match(locked.log, /already using this data directory/i);
    await stop('SIGKILL');
    await start();
    const restored = await request('devices');
    assert.deepEqual(restored.devices, originalRollout.devices);
    assert.deepEqual(restored.rollout, originalRollout.rollout);
    assert.deepEqual((await request(`sessions/${seasonalSession.session.id}`)).menu, seasonalSession.menu);
    const reverted = await rollback();
    for (const device of reverted.devices) {
      const previous = restored.devices.find(entry => entry.id === device.id);
      assert.equal(device.installedVersion, 1);
      assert.equal(device.status, 'live');
      assert.equal(device.wireVersion, previous.wireVersion + Number(previous.installedVersion !== 1));
    }
    assert.equal((await open('market-02')).session.version, 1);
    assert.equal((await request('orders')).orders[0].status, 'completed');
    await stop();
    await start();
    assert.deepEqual((await request('devices')).devices, reverted.devices);
    const payload = cart(seasonalSession.session.id, { items: [{ itemId: 'maple-cloud-latte', quantity: 1, modifiers: { milk: 'oat' } }] });
    seasonalOrder = (await checkout(payload)).order;
    assert.equal(seasonalOrder.version, 2);
    assert.equal(seasonalOrder.pickup.title, seasonalSession.menu.pickup.title);
    assert.equal(seasonalOrder.totalCents, 785);
    assert.equal((await checkout(payload, 200)).duplicate, true);
    const audit = (await request('audit')).audit;
    assert.equal(audit.filter(entry => entry.event === 'Order received').length, 2);
    assert.equal(audit.filter(entry => entry.event === 'Kitchen status updated').length, 3);
    assert.equal(audit.filter(entry => entry.event === 'Fleet rolled back').length, 1);
  });

  await t.test('the pickup shelf displays only active v2 order numbers for the selected store', async () => {
    const visible = (status) => ({ storeId: 'market', orders: [{ number: seasonalOrder.number, status }] });
    assert.deepEqual(await request('pickup?store=market'), visible('received'));
    assert.deepEqual(await request('pickup?store=north'), { storeId: 'north', orders: [] });
    await request('pickup?store=other', undefined, 422);
    await status(seasonalOrder, 'preparing');
    await status(seasonalOrder, 'ready');
    assert.deepEqual(await request('pickup?store=market'), visible('ready'));
    await status(seasonalOrder, 'completed');
    assert.deepEqual(await request('pickup?store=market'), { storeId: 'market', orders: [] });
  });

  await t.test('a corrupted pending manifest is rejected while the last verified menu stays available', async () => {
    const before = await state('north-01');
    await stop();
    const database = new DatabaseSync(join(data, 'fold.sqlite'));
    const row = database.prepare('SELECT desired FROM device WHERE id = ?').get('north-01');
    const bad = JSON.parse(row.desired);
    bad.manifest.version++;
    bad.manifest['x-fold-catalog'] = 2;
    database.prepare('UPDATE device SET desired = ? WHERE id = ?').run(JSON.stringify(bad), 'north-01');
    database.close();
    await start();
    const rejected = await state('north-01');
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.installedVersion, 1);
    assert.equal(rejected.wireVersion, before.wireVersion);
    assert.match(rejected.error, /signature/i);
    assert.equal((await open('north-01')).session.version, 1);
    const recovered = await release({ deviceId: 'north-01' });
    const device = recovered.devices.find(entry => entry.id === 'north-01');
    assert.equal(device.status, 'live');
    assert.equal(device.installedVersion, 2);
    assert.equal((await request('orders')).orders.find(order => order.id === seasonalOrder.id).totalCents, 785);
  });

  await t.test('cashier checkout validates tender and persists exact change without duplicate sales', async () => {
    const cashSession = (await open('market-01')).session;
    const sale = cart(cashSession.id);
    const { quote } = await request('quote', sale);
    await checkout({ ...sale, tender: { method: 'cash', receivedCents: quote.totalCents - 1 } }, 422);
    await checkout({ ...sale, tender: { method: 'cash', receivedCents: quote.totalCents + 0.1 } }, 422);
    assert.equal((await request(`sessions/${cashSession.id}`)).session.orderId, null);
    const tendered = { ...sale, tender: { method: 'cash', receivedCents: quote.totalCents + 237 } };
    const cash = (await checkout(tendered)).order;
    assert.deepEqual(cash.tender, { method: 'cash', receivedCents: quote.totalCents + 237, changeCents: 237 });
    const replay = await checkout(tendered, 200);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.order.id, cash.id);
    await checkout({ ...tendered, tender: { method: 'card-demo' } }, 409);
    await checkout({ ...tendered, tender: { method: 'cash', receivedCents: quote.totalCents + 500 } }, 409);
    const { order: reread } = await request(`orders/${cash.id}?sessionId=${cashSession.id}`);
    assert.deepEqual(reread.tender, cash.tender);

    const cardSession = (await open('market-01')).session;
    const cardData = cart(cardSession.id);
    await checkout({ ...cardData, tender: { method: 'card-demo', receivedCents: 1000 } }, 422);
    const cardSale = (await checkout({ ...cardData, tender: { method: 'card-demo' } })).order;
    assert.deepEqual(cardSale.tender, { method: 'card-demo' });
  });
});
