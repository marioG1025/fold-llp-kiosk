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

  let adjustedOrder;
  let refundRequest;
  let refundedOrder;
  const stock = (storeId, itemId, available, quantity) => request('availability', { storeId, itemId, available, quantity });
  const refund = (order, input, expected = 200) => request(`orders/${order.id}/refund`, input, expected);

  await t.test('register adjustments use server policy, reduced taxable subtotal and immutable receipts', async () => {
    const policy = await request('pos-policy');
    assert.deepEqual(policy.discounts.map(preset => preset.id), ['none', 'staff-10', 'service-15']);
    assert.equal(policy.tipLimitCents, 5000);
    assert.equal(policy.noteLimit, 240);
    const { session } = await open('north-01');
    const line = { itemId: 'pain-au-chocolat', quantity: 1 };
    const sale = cart(session.id, {
      items: [line], discount: 'staff-10', note: '  Wrap separately  ', tipCents: 123,
      discountCents: 9999, taxableSubtotalCents: 1, totalCents: 1,
    });
    const { quote } = await request('quote', sale);
    assert.equal(quote.subtotalCents, 525);
    assert.equal(quote.discountCents, 53);
    assert.equal(quote.taxableSubtotalCents, 472);
    assert.equal(quote.taxCents, 39);
    assert.equal(quote.tipCents, 123);
    assert.equal(quote.totalCents, 634);
    assert.equal(quote.note, 'Wrap separately');
    for (const extras of [{ discount: '90%-off' }, { tipCents: -1 }, { tipCents: 5001 }, { tipCents: 0.1 },
      { note: 'x'.repeat(241) }, { note: 'one\u0000two' }]) {
      await request('quote', { ...sale, ...extras }, 422);
    }
    await checkout({ ...sale, tender: { method: 'cash', receivedCents: policy.cashLimitCents + 1 } }, 422);
    await stock('north', line.itemId, true, 2);
    const paid = { ...sale, tender: { method: 'cash', receivedCents: 700 } };
    adjustedOrder = (await checkout(paid)).order;
    assert.equal(adjustedOrder.version, 2);
    assert.equal(adjustedOrder.totalCents, quote.totalCents);
    assert.equal(adjustedOrder.tender.changeCents, 66);
    assert.equal(adjustedOrder.note, quote.note);
    assert.equal((await checkout({ ...paid, note: quote.note }, 200)).duplicate, true);
    await checkout({ ...paid, discount: 'service-15' }, 409);
    await checkout({ ...paid, tipCents: 124 }, 409);
    await checkout({ ...paid, note: 'Different note' }, 409);
    assert.deepEqual((await request('recent-sales?device=north-01&limit=1')).orders, [adjustedOrder]);
    assert.ok(!(await request('recent-sales?device=north-02')).orders.some(order => order.id === adjustedOrder.id));
    await request('recent-sales?device=north-01&limit=51', undefined, 422);
  });

  await t.test('store stock aggregates variants and two terminals cannot sell the same remaining units', async () => {
    await stock('lake', 'flat-white', true, 3);
    assert.equal((await request('availability?storeId=lake')).items[0].quantity, 3);
    assert.ok(!(await request('availability?storeId=market')).items.some(item => item.itemId === 'flat-white'));
    await request('availability', { storeId: 'lake', itemId: 'flat-white', available: true, quantity: -1 }, 422);
    await request('availability', { storeId: 'lake', itemId: 'unlisted', available: true }, 422);
    const sessions = await Promise.all([open('lake-01'), open('lake-02')]);
    const sales = sessions.map(({ session }) => cart(session.id));
    const split = { ...sales[0], items: [sales[0].items[0], { ...sales[0].items[0], modifiers: { milk: 'whole' } }] };
    const limited = await request('quote', split, 409);
    assert.equal(limited.code, 'inventory_unavailable');
    assert.equal(limited.remaining, 3);
    assert.equal(limited.itemId, 'flat-white');
    await stock('lake', 'almond-croissant', false, null);
    await checkout({ ...sales[0], items: [...sales[0].items, { itemId: 'almond-croissant', quantity: 1 }] }, 409);
    assert.equal((await request('availability?storeId=lake')).items.find(item => item.itemId === 'flat-white').quantity, 3);
    const stream = await fetch(`${origin}/api/events`, { signal: AbortSignal.timeout(8000) });
    const reader = stream.body.getReader();
    try {
      const results = await Promise.all(sales.map(async payload => {
        const response = await fetch(`${origin}/api/orders`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        });
        return { status: response.status, payload, value: await response.json() };
      }));
      assert.deepEqual(results.map(item => item.status).sort(), [201, 409]);
      assert.equal(results.find(item => item.status === 409).value.remaining, 1);
      let notifications = '';
      while (!notifications.includes('data: {"type":"inventory"}')) {
        const { value, done } = await reader.read();
        assert.equal(done, false);
        notifications += new TextDecoder().decode(value);
      }
      assert.ok(notifications.includes('data: {"type":"orders"}'));
      const accepted = results.find(item => item.status === 201);
      const blocked = results.find(item => item.status === 409);
      const lastUnit = { ...blocked.payload, items: [{ ...blocked.payload.items[0], quantity: 1 }] };
      await checkout(lastUnit);
      const depleted = (await request('availability?storeId=lake')).items.find(item => item.itemId === 'flat-white');
      assert.equal(depleted.quantity, 0);
      assert.equal(depleted.available, false);
      assert.equal(depleted.manualBlock, false);
      assert.equal((await checkout(accepted.payload, 200)).duplicate, true);
      const reset = await stock('lake', 'flat-white', true, null);
      assert.ok(!reset.items.some(item => item.itemId === 'flat-white'));
      assert.equal(reset.items.find(item => item.itemId === 'almond-croissant').manualBlock, true);
      const { audit } = await request('audit');
      assert.ok(audit.some(entry => entry.event === 'Stock updated' && entry.detail.includes('Lakeside · Flat White')));
      assert.ok(audit.some(entry => entry.event === 'Stock exhausted' && entry.detail.includes('Lakeside · Flat White')));
    } finally {
      await reader.cancel();
    }
  });

  await t.test('full demo refunds are replay safe, retain stock consumption and leave the active pickup queue', async () => {
    assert.ok((await request('pickup?store=north')).orders.some(order => order.number === adjustedOrder.number));
    const before = await request('availability?storeId=north');
    assert.equal(before.items.find(item => item.itemId === 'pain-au-chocolat').quantity, 1);
    refundRequest = { idempotencyKey: randomUUID(), reason: '  Customer changed plans  ', amountCents: 1 };
    await refund(adjustedOrder, { ...refundRequest, reason: ' ' }, 422);
    await refund(adjustedOrder, { ...refundRequest, reason: 'x'.repeat(161) }, 422);
    const attempts = await Promise.all(Array.from({ length: 8 }, () => refund(adjustedOrder, refundRequest)));
    assert.equal(attempts.filter(record => !record.duplicate).length, 1);
    assert.equal(new Set(attempts.map(record => record.order.refund.id)).size, 1);
    refundedOrder = attempts[0].order;
    assert.equal(refundedOrder.refund.amountCents, adjustedOrder.totalCents);
    assert.equal(refundedOrder.refund.reason, 'Customer changed plans');
    assert.equal(refundedOrder.tender.method, 'cash');
    assert.equal(refundedOrder.status, adjustedOrder.status);
    await refund(adjustedOrder, { ...refundRequest, idempotencyKey: randomUUID() }, 409);
    await refund(adjustedOrder, { ...refundRequest, reason: 'Different reason' }, 409);
    await refund(firstOrder, refundRequest, 409);
    await status(adjustedOrder, 'preparing', 409);
    assert.deepEqual(await request('availability?storeId=north'), before);
    assert.ok(!(await request('pickup?store=north')).orders.some(order => order.number === adjustedOrder.number));
    assert.equal((await request('orders')).counts.refunded, 1);
    const audits = (await request('audit')).audit.filter(entry => entry.event === 'Demo refund recorded');
    assert.equal(audits.length, 1);
    assert.ok(audits[0].detail.includes(`${adjustedOrder.number} · North Loop · 634 cents`));
  });

  await t.test('UTC sales and CSV reconcile orders and refunds, and survive restart with inventory', async () => {
    const date = adjustedOrder.createdAt.slice(0, 10);
    const end = refundedOrder.refund.createdAt.slice(0, 10);
    const filters = `storeId=north&from=${date}&to=${end}`;
    const report = await request('reports/sales?' + filters);
    assert.deepEqual(report.totals, {
      orderCount: 1, grossCents: 525, discountCents: 53, taxCents: 39, tipCents: 123,
      chargedCents: 634, refundCount: 1, refundCents: 634, netCents: 0,
    });
    assert.equal(report.stores.length, 1);
    assert.equal(report.stores[0].storeName, 'North Loop');
    assert.equal(report.days[0].date, date);
    assert.equal(report.days.at(-1).date, end);
    assert.equal((await request('reports/sales?storeId=north&from=2098-01-01')).totals.orderCount, 0);
    await request('reports/sales?from=2026-02-30', undefined, 422);
    await request('reports/sales?from=2026-01-10&to=2026-01-09', undefined, 422);
    await request('reports/sales?storeId=bogus', undefined, 422);
    const response = await fetch(`${origin}/api/reports/sales.csv?${filters}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/csv/);
    assert.match(response.headers.get('content-disposition'), /fold-sales\.csv/);
    const csv = await response.text();
    assert.match(csv, /"total","","north","","1","525","53","39","123","634","1","634","0"/);
    assert.ok(!csv.includes(adjustedOrder.note) && !csv.includes(refundedOrder.refund.reason));
    await stop('SIGKILL');
    await start();
    assert.deepEqual(await request('reports/sales?' + filters), report);
    assert.equal((await request('availability?storeId=north')).items[0].quantity, 1);
    const reopened = await refund(adjustedOrder, refundRequest);
    assert.equal(reopened.duplicate, true);
    assert.deepEqual(reopened.order, refundedOrder);
  });

  await t.test('reports attribute a later refund to its own date and retain older order receipts', async () => {
    const { session } = await open('market-01');
    const original = cart(session.id);
    const { order } = await checkout(original);
    await stop();
    const database = new DatabaseSync(join(data, 'fold.sqlite'));
    database.prepare(`
      UPDATE orders SET receipt = json_remove(receipt, '$.discount', '$.discountCents', '$.taxableSubtotalCents', '$.tipCents', '$.note')
      WHERE id = ?
    `).run(order.id);
    database.prepare(`
      UPDATE orders SET receipt = json_set(receipt, '$.createdAt', '2026-01-06T23:59:59.999Z') WHERE id = ?
    `).run(adjustedOrder.id);
    database.prepare("UPDATE refund SET created_at = '2026-01-07T00:00:00.000Z' WHERE order_id = ?").run(adjustedOrder.id);
    database.close();
    await start();
    const replay = await checkout({ ...original, discount: 'none', tipCents: 0, note: '' }, 200);
    assert.equal(replay.duplicate, true);
    assert.deepEqual(replay.order, order);
    const sold = await request('reports/sales?storeId=north&from=2026-01-06&to=2026-01-06');
    const returned = await request('reports/sales?storeId=north&from=2026-01-07&to=2026-01-07');
    assert.equal(sold.totals.netCents, 634);
    assert.equal(sold.totals.refundCount, 0);
    assert.equal(returned.totals.netCents, -634);
    assert.equal(returned.totals.orderCount, 0);
    assert.equal(returned.totals.refundCount, 1);
  });
});
