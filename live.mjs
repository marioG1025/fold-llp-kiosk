import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { catalogs, devices, layerSource } from './catalog.mjs';
import { now } from './store.mjs';

const app = 'fold.kiosk';
const curve = { name: 'ECDSA', namedCurve: 'P-256' };
const versionOf = manifest => manifest['x-fold-catalog'];

async function compile(root, output, menu) {
  const { default: asc } = await import(pathToFileURL(join(root, 'node_modules/assemblyscript/dist/asc.js')));
  mkdirSync(output, { recursive: true });
  copyFileSync(join(root, 'sdk/assemblyscript/llp.ts'), join(output, 'llp.ts'));
  const source = join(output, `catalog-${menu.version}.ts`);
  const wasm = join(output, `catalog-${menu.version}.wasm`);
  writeFileSync(source, layerSource(menu));
  const result = await asc.main([source, '-o', wasm, '-O3', '--noColors']);
  if (result.error) throw new Error(`Compiling Fold catalog ${menu.version} failed: ${result.stderr.toString()}`, { cause: result.error });
  return readFileSync(wasm);
}

export async function startLiveLayer({ root, data, store, notify }) {
  const core = await import(pathToFileURL(join(root, 'host/llp-core.js')));
  const { bucketOf } = await import(pathToFileURL(join(root, 'host/fleet.js')));
  const { WebSocket, WebSocketServer } = createRequire(join(root, 'package.json'))('ws');
  const { LiveHost, b64, canonical, generatePublisherKey, sha256, signManifest } = core;
  let keys = store.read('signingKey');
  if (!keys) {
    if (store.get('SELECT count(*) AS count FROM release').count) throw new Error('Publisher key missing from existing Fold data.');
    const kp = await generatePublisherKey();
    keys = { public: kp.publicJwk, private: await crypto.subtle.exportKey('jwk', kp.privateKey) };
    store.write('signingKey', keys);
  }
  const signingKey = await crypto.subtle.importKey('jwk', keys.private, curve, false, ['sign']);
  const makeHost = () => new LiveHost({ app, trustedKeys: [keys.public] });

  async function signed(version, hash, catalogVersion, device) {
    const manifest = {
      llp: 1, app, version, layers: { menu: hash }, order: ['menu'],
      caps: {}, keys: { menu: { own: ['catalog'] } },
      'x-fold-catalog': catalogVersion,
    };
    if (device) {
      manifest.channel = device.channel;
      manifest['x-fold-device'] = device.id;
    }
    return { manifest, sig: await signManifest(manifest, signingKey) };
  }
  function readMenu(host, manifest) {
    const menu = JSON.parse(host.kv.get('catalog'));
    if (menu?.version !== versionOf(manifest) || !Array.isArray(menu.items) || !Array.isArray(menu.categories) ||
      typeof menu.pickup?.title !== 'string') throw new Error('Signed menu did not render its expected version.');
    return menu;
  }

  const releases = new Map();
  const blobs = new Map();
  for (const source of catalogs) {
    const record = store.get('SELECT * FROM release WHERE version = ?', source.version);
    const wasm = record?.wasm ?? await compile(root, join(data, 'build'), source);
    const archive = record
      ? { manifest: JSON.parse(record.manifest), sig: record.signature }
      : await signed(source.version, await sha256(wasm), source.version);
    const host = makeHost();
    let menu;
    try {
      const result = await host.apply(archive.manifest, archive.sig, () => wasm);
      if (!result.ok || versionOf(archive.manifest) !== source.version) {
        throw new Error(`Catalog ${source.version} archive failed verification: ${result.reason ?? 'incorrect version'}`);
      }
      menu = readMenu(host, archive.manifest);
      if (!record && canonical(menu) !== canonical(source)) throw new Error(`Catalog ${source.version} candidate failed its render check.`);
    } finally {
      host.close();
    }
    const hash = archive.manifest.layers.menu;
    if (!record) store.run('INSERT INTO release VALUES (?, ?, ?, ?)', source.version, JSON.stringify(archive.manifest), archive.sig, wasm);
    releases.set(source.version, { menu, hash });
    blobs.set(hash, wasm);
  }

  const fleet = new Map(devices.map(device => {
    const token = randomBytes(32).toString('hex');
    return [device.id, { device, token, verified: null, queue: Promise.resolve(), connectionQueue: Promise.resolve() }];
  }));
  const tokens = new Map([...fleet.values()].map(runtime => [`Bearer ${runtime.token}`, runtime]));
  for (const [id] of fleet) {
    if (!store.get('SELECT id FROM device WHERE id = ?', id)) {
      const initial = await signed(1, releases.get(1).hash, 1, fleet.get(id).device);
      store.run('INSERT INTO device(id, desired) VALUES (?, ?)', id, JSON.stringify(initial));
    }
  }
  const records = id => {
    const row = store.get('SELECT * FROM device WHERE id = ?', id);
    return { ...row, desired: JSON.parse(row.desired), installed: row.installed ? JSON.parse(row.installed) : null };
  };

  let closing = false;
  const broker = new WebSocketServer({ port: 0, host: '127.0.0.1', maxPayload: 256 * 1024, perMessageDeflate: false });
  await once(broker, 'listening');
  const url = `ws://127.0.0.1:${broker.address().port}`;
  const send = (socket, message) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };

  broker.on('connection', (peer, request) => {
    const runtime = tokens.get(request.headers.authorization);
    peer.on('error', () => {});
    if (!runtime || runtime.peer || runtime.paused) return peer.close(1008, 'Unavailable device');
    let greeted = false;
    peer.on('message', raw => {
      try {
        const message = JSON.parse(raw);
        if (!greeted) {
          if (runtime.paused || runtime.peer || message.t !== 'hello' || message.llp !== 1 || message.app !== app || message.id !== runtime.device.id ||
            message.channel !== runtime.device.channel || message.version !== 0) return peer.close(1008, 'Invalid LLP hello');
          greeted = true;
          runtime.peer = peer;
          send(peer, { t: 'hello', llp: 1, app });
          return;
        }
        const delivery = runtime.delivery;
        if (!delivery) return;
        if (message.t === 'want' && Array.isArray(message.hashes) && message.hashes.length === 1 &&
          message.hashes[0] === delivery.release.manifest.layers.menu) {
          const hash = message.hashes[0];
          send(peer, { t: 'blob', hash, data: b64.enc(blobs.get(hash)) });
        }
        if (['ack', 'nack'].includes(message.t) && message.version === delivery.release.manifest.version) {
          delivery.finish(message);
        }
      } catch (error) {
        console.error(`LLP broker error for ${runtime.device.id}`, error);
        peer.close(1011);
      }
    });
    peer.on('close', () => {
      if (runtime.peer !== peer) return;
      runtime.peer = null;
      runtime.delivery?.finish({ t: 'offline' });
    });
  });

  async function deliver(runtime, release, { restore = false } = {}) {
    const id = runtime.device.id;
    const wireVersion = release.manifest.version;
    if (!runtime.peer || runtime.peer.readyState !== WebSocket.OPEN) return false;
    const result = await new Promise(resolve => {
      const timer = setTimeout(() => runtime.delivery?.finish({ t: 'timeout' }), 6500);
      runtime.delivery = { release, finish(message) {
        clearTimeout(timer);
        runtime.delivery = null;
        resolve(message);
      } };
      send(runtime.peer, { t: 'manifest', ...release });
    });
    if (closing || runtime.paused || result.t === 'offline') return false;
    const checked = runtime.checked;
    if (result.t === 'ack' && checked?.wireVersion === wireVersion) {
      if (!restore) store.transaction(() => {
        store.run('UPDATE device SET installed = ?, applied_at = ?, ack_ms = ?, error = NULL WHERE id = ?',
          JSON.stringify(release), now(), result.ms, id);
        store.audit('fleet', 'Device acknowledged',
          `${runtime.device.storeName} · ${runtime.device.name} verified menu v${checked.version} over LLP (wire v${wireVersion}, ${result.ms} ms).`);
      });
      runtime.verified = checked;
      notify('fleet');
      return true;
    }
    const reason = result.reason ?? (result.t === 'timeout' ? 'LLP acknowledgement timed out.' : 'Device did not verify the signed release.');
    store.transaction(() => {
      store.run('UPDATE device SET error = ? WHERE id = ?', reason, id);
      store.audit('fleet', 'Device rejected release', `${id} · LLP v${wireVersion} · ${reason}`);
    });
    if (result.t === 'timeout') runtime.peer?.terminate();
    notify('fleet');
    return false;
  }

  function synchronize(runtime) {
    const client = runtime.client;
    const ready = runtime.ready;
    const run = runtime.queue.then(async () => {
      if (!client || !await ready || closing || runtime.paused || runtime.client !== client) return false;
      // An acknowledged release remains usable even if a subsequent staged deployment is rejected.
      const { installed } = records(runtime.device.id);
      if (!runtime.verified && installed && !await deliver(runtime, installed, { restore: true })) return false;
      const { desired } = records(runtime.device.id);
      if (runtime.verified?.wireVersion === desired.manifest.version) return true;
      return deliver(runtime, desired);
    });
    runtime.queue = run.catch(() => {});
    return run;
  }

  async function connect(runtime) {
    if (closing || runtime.paused || runtime.client) return false;
    const { device } = runtime;
    const host = makeHost();
    const client = new WebSocket(url, { headers: { Authorization: `Bearer ${runtime.token}` } });
    runtime.client = client;
    runtime.host = host;
    let want = null;
    let hello;
    runtime.ready = new Promise(resolve => { hello = resolve; });
    const timer = setTimeout(() => { hello(false); client.terminate(); }, 4000);
    client.on('error', () => {});
    client.on('open', () => send(client, { t: 'hello', llp: 1, app, id: device.id, channel: device.channel, version: 0, have: [] }));
    client.on('close', () => {
      clearTimeout(timer);
      hello(false);
      want?.finish(null);
      if (runtime.client !== client) return;
      runtime.client = null;
      runtime.verified = null;
      runtime.checked = null;
      host.queue.finally(() => host.close()).catch(() => {});
      if (closing) return;
      notify('fleet');
      if (!runtime.paused) {
        runtime.retry = setTimeout(() => connect(runtime).catch(error => console.error('LLP reconnect failed', error)), 500);
      }
    });
    client.on('message', async raw => {
      const message = JSON.parse(raw);
      if (message.t === 'hello') {
        clearTimeout(timer);
        hello(true);
      }
      if (message.t === 'blob' && want?.hash === message.hash) want.finish(b64.dec(message.data));
      if (message.t !== 'manifest') return;
      const manifest = message.manifest;
      try {
        if (manifest['x-fold-device'] !== device.id || manifest.channel !== device.channel) throw new Error('Signed release targets a different device.');
        const result = await host.apply(manifest, message.sig, hash => new Promise(resolve => {
          const deadline = setTimeout(() => want?.finish(null), 4000);
          want = { hash, finish(bytes) { clearTimeout(deadline); want = null; resolve(bytes); } };
          send(client, { t: 'want', hashes: [hash] });
        }));
        if (!result.ok) throw new Error(result.reason);
        const menu = readMenu(host, manifest);
        if (canonical(menu) !== canonical(releases.get(menu.version)?.menu)) throw new Error('Signed menu differs from the approved archive.');
        if (runtime.client !== client) return;
        runtime.checked = { wireVersion: manifest.version, version: menu.version, menu };
        send(client, { t: 'ack', version: result.version, ms: result.ms });
      } catch (error) {
        send(client, { t: 'nack', version: manifest.version, reason: error.message });
      }
    });
    return synchronize(runtime).finally(() => { if (!closing) notify('fleet'); });
  }

  function terminate(socket) {
    if (!socket || socket.readyState === WebSocket.CLOSED) return Promise.resolve();
    const closed = new Promise(resolve => socket.once('close', resolve));
    socket.terminate();
    return closed;
  }

  function setConnected(id, connected) {
    const runtime = fleet.get(id);
    const run = runtime.connectionQueue.then(async () => {
      const changed = Boolean(runtime.paused) === connected;
      runtime.paused = !connected;
      clearTimeout(runtime.retry);
      if (connected) {
        if (runtime.client) await synchronize(runtime);
        else await connect(runtime);
      } else {
        // Pause automatic recovery before closing both ends of the real LLP transport.
        await Promise.all([terminate(runtime.client), terminate(runtime.peer)]);
        await runtime.queue;
      }
      if (changed) {
        store.audit('fleet', connected ? 'Drill link resumed' : 'Drill link disconnected',
          `${runtime.device.storeName} · ${runtime.device.name} · ${connected ? 'connection resumed' : 'WebSocket closed'}.`);
      }
      notify('fleet');
    });
    runtime.connectionQueue = run.catch(() => {});
    return run;
  }

  async function deploy(selection, kind) {
    const selected = [];
    for (const device of devices) {
      if (selection.channel !== 'all' && selection.channel !== device.channel) continue;
      if (selection.deviceId && selection.deviceId !== device.id) continue;
      if (await bucketOf(device.id, `${app}/${selection.channel}`) < selection.percentage * 100) selected.push(device.id);
    }
    const rollout = { ...selection, selected, time: now(), kind };
    const { hash } = releases.get(selection.version);
    const assignments = [];
    for (const id of selected) {
      const current = records(id);
      if (versionOf(current.desired.manifest) === selection.version && !current.error) continue;
      const release = await signed(current.desired.manifest.version + 1, hash, selection.version, fleet.get(id).device);
      assignments.push({ id, release });
    }
    store.transaction(() => {
      for (const { id, release } of assignments) {
        store.run('UPDATE device SET desired = ?, error = NULL WHERE id = ?', JSON.stringify(release), id);
      }
      store.write('rollout', rollout);
      const target = selection.deviceId ?? `${selection.channel} · ${selection.percentage}%`;
      store.audit('fleet', kind === 'rollback' ? 'Fleet rolled back' : 'Rollout published',
        `Menu v${selection.version} · ${target} · ${selected.length} targeted, ${assignments.length} changed.`);
    });
    notify('fleet');
    await Promise.all(assignments.map(({ id }) => synchronize(fleet.get(id))));
    return rollout;
  }

  function list() {
    return devices.map(device => {
      const runtime = fleet.get(device.id);
      const row = records(device.id);
      const desiredVersion = versionOf(row.desired.manifest);
      const targetWireVersion = row.desired.manifest.version;
      const wireVersion = row.installed?.manifest.version ?? null;
      const status = !runtime.peer ? 'offline' : row.error ? 'rejected'
        : runtime.verified?.wireVersion === targetWireVersion ? 'live' : 'pending';
      return { ...device, desiredVersion, targetWireVersion, wireVersion, status,
        installedVersion: row.installed ? versionOf(row.installed.manifest) : null,
        appliedAt: row.applied_at, ackMs: row.ack_ms, error: row.error };
    });
  }

  function close() {
    closing = true;
    for (const runtime of fleet.values()) {
      clearTimeout(runtime.retry);
      runtime.delivery?.finish({ t: 'offline' });
      runtime.client?.terminate();
      runtime.host?.close();
    }
    for (const connection of broker.clients) connection.terminate();
    broker.close();
  }

  try {
    const ready = await Promise.all([...fleet.values()].map(connect));
    if (ready.some((installed, index) => !installed && !fleet.get(devices[index].id).verified)) {
      throw new Error('One or more simulated kiosks could not restore a verified menu.');
    }
  } catch (error) {
    close();
    throw error;
  }
  return {
    list, deploy, close, setConnected,
    device: id => fleet.get(id)?.device,
    installed: id => fleet.get(id)?.verified,
    menu: version => releases.get(version)?.menu,
    releases: () => [...releases.values()].map(({ menu, hash }) => ({
      version: menu.version, name: menu.name, description: menu.description, hash,
    })),
  };
}
