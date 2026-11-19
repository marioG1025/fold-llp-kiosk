import { once } from 'node:events';
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCounter } from './counter.mjs';
import { startLiveLayer } from './live.mjs';
import { createOrders, locations, posPolicy } from './orders.mjs';
import { salesCsv, salesReport } from './reports.mjs';
import { now, openStore } from './store.mjs';
import { HttpError } from './validation.mjs';

const port = Number(process.env.FOLD_PORT ?? '17730');
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('FOLD_PORT must be a TCP port from 0 to 65535.');
const publicDirectory = fileURLToPath(new URL('./public/', import.meta.url));
const data = resolve(process.env.FOLD_DATA ?? fileURLToPath(new URL('./.fold-data/', import.meta.url)));
const root = resolve(process.env.LLP_ROOT ?? fileURLToPath(new URL('../live-layer-protocol/', import.meta.url)));
mkdirSync(data, { recursive: true, mode: 0o700 });
const store = openStore(data);

const listeners = new Set();
function event(res, message) {
  if (res.writableLength > 8192) res.destroy();
  else res.write(message);
}
function notify(type) {
  for (const res of listeners) event(res, `data: ${JSON.stringify({ type })}\n\n`);
}
const heartbeat = setInterval(() => {
  for (const res of listeners) event(res, ': heartbeat\n\n');
}, 15000);
heartbeat.unref();

let live;
try {
  live = await startLiveLayer({ root, data, store, notify });
} catch (error) {
  store.close();
  throw error;
}
const orders = createOrders({ store, live, notify });
const counter = createCounter({ store, live, orders, notify });
const drillEnabled = process.env.FOLD_DRILL === '1';
const baseline = { version: 1, channel: 'all', deviceId: null, percentage: 100 };
if (!store.read('rollout')) {
  store.write('rollout', { ...baseline, selected: live.list().map(device => device.id), time: now(), kind: 'baseline' });
}
function fleetState() {
  return { devices: live.list(), releases: live.releases(), rollout: store.read('rollout'), audit: store.history('fleet') };
}

let releaseQueue = Promise.resolve();
function updateFleet(selection, kind) {
  const run = releaseQueue.then(async () => {
    await live.deploy(selection, kind);
    return fleetState();
  });
  releaseQueue = run.catch(() => {});
  return run;
}

function rolloutSelection(input) {
  const { version, channel, deviceId = null, percentage = 100 } = input;
  if (!live.menu(version)) throw new HttpError(422, 'Choose a known menu release.');
  if (!['all', 'stable', 'beta'].includes(channel)) throw new HttpError(422, 'Choose all kiosks, stable or beta.');
  if (!Number.isInteger(percentage) || percentage < 0 || percentage > 100) {
    throw new HttpError(422, 'Rollout percentage must be a whole number from 0 to 100.');
  }
  if (deviceId !== null && deviceId !== '') {
    const device = live.device(deviceId);
    if (!device || (channel !== 'all' && channel !== device.channel)) throw new HttpError(422, 'Choose a registered kiosk in the selected channel.');
    if (percentage !== 100) throw new HttpError(422, 'Choose an exact kiosk or a percentage.');
  }
  return { version, channel, deviceId: deviceId || null, percentage };
}

const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};
const contentPolicy = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'";
function staticFile(path, method, res) {
  const route = /^\/(register|kiosk|ops|pickup|kitchen|counter|terminal-lab|improvements|sales)\/?$/.exec(path)?.[1];
  const page = path === '/' ? 'register' : route === 'kiosk' ? 'index' : route;
  const file = page ? `/${page}.html` : path;
  const type = types[extname(file)];
  if (!type || !/^\/(?:[a-z0-9_-]+\/)*[a-z0-9_.-]+$/i.test(file)) throw new HttpError(404, 'Page was not found.');
  let buffer;
  try {
    buffer = readFileSync(join(publicDirectory, file.slice(1)));
  } catch (error) {
    if (['ENOENT', 'EISDIR'].includes(error.code)) throw new HttpError(404, 'Page was not found.');
    throw error;
  }
  res.writeHead(200, {
    'Content-Type': type, 'Content-Length': buffer.byteLength, 'Content-Security-Policy': contentPolicy,
    'Cache-Control': 'no-cache',
  });
  res.end(method === 'HEAD' ? undefined : buffer);
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function body(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'Send a JSON request.');
  const maxBytes = 32768;
  if (Number(req.headers['content-length']) > maxBytes) {
    req.resume();
    throw new HttpError(413, 'Request is too large.');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > maxBytes) {
      req.resume();
      throw new HttpError(413, 'Request is too large.');
    }
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks, length));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Not an object');
    return value;
  } catch {
    throw new HttpError(400, 'Send a valid JSON object.');
  }
}

const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  try {
    const bound = server.address().port;
    const host = req.headers.host;
    if (host !== `127.0.0.1:${bound}` && host !== `localhost:${bound}`) throw new HttpError(403, 'Open the local Fold pilot URL.');
    const origin = `http://${host}`;
    const { pathname, searchParams } = new URL(req.url, origin);
    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method is unavailable.');
      return staticFile(pathname, req.method, res);
    }
    if ((req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') {
      throw new HttpError(403, 'Only same-origin requests are accepted by this local pilot.');
    }
    if (req.method === 'GET') {
      if (pathname === '/api/health') return json(res, 200, { ok: true, app: 'fold-kiosk' });
      if (pathname === '/api/devices') return json(res, 200, fleetState());
      if (pathname === '/api/counter') return json(res, 200, counter.read(searchParams.get('device')));
      if (pathname === '/api/orders') return json(res, 200, orders.list());
      if (pathname === '/api/pickup') return json(res, 200, orders.pickup(searchParams.get('store')));
      if (pathname === '/api/pos-policy') return json(res, 200, posPolicy);
      if (pathname === '/api/recent-sales') return json(res, 200, orders.recent(searchParams.get('device'), searchParams.get('limit')));
      if (pathname === '/api/availability') return json(res, 200, orders.inventory.list(searchParams.get('storeId')));
      if (pathname === '/api/reports/sales') return json(res, 200, salesReport(store, locations, searchParams));
      if (pathname === '/api/reports/sales.csv') {
        const csv = salesCsv(salesReport(store, locations, searchParams));
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="fold-sales.csv"',
          'Cache-Control': 'no-store',
        });
        return res.end(csv);
      }
      const receipt = /^\/api\/orders\/([^/]+)$/.exec(pathname);
      if (receipt) return json(res, 200, { order: orders.get(receipt[1], searchParams.get('sessionId')) });
      if (pathname === '/api/audit') return json(res, 200, { audit: store.history() });
      if (pathname === '/api/events') {
        if (listeners.size >= 64) throw new HttpError(503, 'All live connections are in use. Try again shortly.');
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'Connection': 'keep-alive' });
        listeners.add(res);
        res.on('close', () => listeners.delete(res));
        return event(res, 'retry: 1500\n\n');
      }
      const release = /^\/api\/releases\/(\d+)$/.exec(pathname);
      if (release) {
        const menu = live.menu(Number(release[1]));
        if (!menu) throw new HttpError(404, 'Release was not found.');
        return json(res, 200, { menu });
      }
      const session = /^\/api\/sessions\/([^/]+)$/.exec(pathname);
      if (session) return json(res, 200, orders.session(session[1]));
    }
    if (req.method === 'POST') {
      if (pathname === '/api/sessions') return json(res, 201, orders.openSession((await body(req)).deviceId));
      if (pathname === '/api/counter') return json(res, 200, counter.publish(await body(req)));
      if (pathname === '/api/quote') return json(res, 200, { quote: orders.quote(await body(req)) });
      if (pathname === '/api/availability') return json(res, 200, orders.inventory.update(await body(req)));
      if (pathname === '/api/orders') {
        const result = orders.order(await body(req));
        return json(res, result.duplicate ? 200 : 201, result);
      }
      if (pathname === '/api/rollout') return json(res, 200, await updateFleet(rolloutSelection(await body(req)), 'publish'));
      if (pathname === '/api/drill/device' && drillEnabled) {
        const { deviceId, connected } = await body(req);
        if (!live.device(deviceId) || typeof connected !== 'boolean') throw new HttpError(422, 'Choose a registered kiosk and connection state.');
        await live.setConnected(deviceId, connected);
        return json(res, 200, fleetState());
      }
      if (pathname === '/api/rollback') {
        await body(req);
        return json(res, 200, await updateFleet(baseline, 'rollback'));
      }
      const orderStatus = /^\/api\/orders\/([^/]+)\/status$/.exec(pathname);
      if (orderStatus) return json(res, 200, { order: orders.update(orderStatus[1], (await body(req)).status) });
      const refund = /^\/api\/orders\/([^/]+)\/refund$/.exec(pathname);
      if (refund) {
        const result = orders.refund(refund[1], await body(req));
        counter.revoke(result.order);
        return json(res, 200, result);
      }
    }
    throw new HttpError(404, 'API route was not found.');
  } catch (error) {
    const expected = error instanceof HttpError;
    if (!expected) console.error(error);
    if (!res.headersSent) json(res, expected ? error.status : 500, {
      error: expected ? error.message : 'Fold could not complete this request.',
      ...(expected && error.details),
    });
    else res.destroy();
  }
});

try {
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
} catch (error) {
  live.close();
  store.close();
  throw error;
}
console.log(`Fold kiosk ready at http://127.0.0.1:${server.address().port}`);

function close() {
  clearInterval(heartbeat);
  for (const res of listeners) res.end();
  server.close(() => {
    live.close();
    store.close();
  });
}
process.once('SIGINT', close);
process.once('SIGTERM', close);
