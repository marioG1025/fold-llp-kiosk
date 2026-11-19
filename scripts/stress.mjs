import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

function integerOption(name, defaultValue, min, max) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return defaultValue;
  const value = Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`--${name} must be between ${min} and ${max}`);
  return value;
}

const rounds = integerOption('rounds', 12, 1, 1000);
const clients = integerOption('clients', 12, 6, 96);
const runId = new Date().toISOString().replaceAll(':', '-');
const data = fileURLToPath(new URL(`../.soak/${runId}/`, import.meta.url));
mkdirSync(data, { recursive: true });
const server = spawn(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url))], {
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  env: { ...process.env, FOLD_PORT: '0', FOLD_DATA: data },
});
const exited = once(server, 'exit');
const samples = {};
let output = '';
let url;
let accepted = 0;
let checkedRetries = 0;
let completedRounds = 0;
const orderIds = new Set();
const startTime = performance.now();
server.stdout.on('data', chunk => {
  output += chunk;
  url ??= output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
});
server.stderr.on('data', chunk => { output += chunk; });

function percentiles(values) {
  const ordered = values.toSorted((a, b) => a - b);
  const value = p => +ordered[Math.ceil(ordered.length * p) - 1].toFixed(2);
  return { count: ordered.length, p50: value(.5), p95: value(.95), p99: value(.99), max: value(1) };
}
function report(error) {
  const stats = {
    status: error ? 'failed' : completedRounds === rounds ? 'passed' : 'running', clients, requestedRounds: rounds, completedRounds,
    acceptedOrders: accepted, verifiedDuplicateRetries: checkedRetries, seconds: +((performance.now() - startTime) / 1000).toFixed(2),
    milliseconds: Object.fromEntries(Object.entries(samples).map(([key, values]) => [key, percentiles(values)])),
    ...(error ? { error: error.message } : {}),
  };
  writeFileSync(resolve(data, 'summary.json'), JSON.stringify(stats, null, 2) + '\n');
  return stats;
}
async function api(route, body, metric) {
  const started = performance.now();
  const options = { signal: AbortSignal.timeout(15000) };
  if (body) Object.assign(options, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const response = await fetch(`${url}/api/${route}`, options);
  const result = await response.json();
  assert.ok(response.ok, `${route} returned ${response.status}: ${JSON.stringify(result)}`);
  if (metric) (samples[metric] ??= []).push(performance.now() - started);
  return result;
}
async function begin(device) {
  const { session, menu } = await api('sessions', { deviceId: device.id }, 'session');
  assert.equal(session.version, menu.version);
  const item = menu.items.find(entry => entry.id === 'flat-white');
  assert.ok(item);
  const milk = item.modifiers.find(group => group.id === 'milk').options.find(option => option.id === 'oat');
  return { session, menu, expectedSubtotal: item.priceCents + milk.priceCents };
}
async function checkout(pin, compareRetry = false) {
  const request = {
    sessionId: pin.session.id, fulfillment: 'to-go',
    items: [{ itemId: 'flat-white', quantity: 1, modifiers: { milk: 'oat' } }],
    idempotencyKey: crypto.randomUUID(),
  };
  const { order, duplicate } = await api('orders', request, 'checkout');
  assert.equal(duplicate, false);
  assert.equal(order.version, pin.menu.version);
  assert.equal(order.wireVersion, pin.session.wireVersion);
  assert.equal(order.subtotalCents, pin.expectedSubtotal);
  assert.deepEqual(order.pickup, pin.menu.pickup);
  assert.equal(orderIds.has(order.id), false);
  orderIds.add(order.id);
  accepted++;
  if (compareRetry) {
    const retried = await api('orders', request, 'retry');
    assert.equal(retried.duplicate, true);
    assert.equal(retried.order.id, order.id);
    checkedRetries++;
  }
}

try {
  for (let i = 0; i < 200 && !url; i++) {
    assert.equal(server.exitCode, null, `Server stopped before readiness. ${output}`);
    await wait(100);
  }
  assert.ok(url, `Server never became ready. ${output}`);
  await api('health');
  const { devices } = await api('devices');
  assert.ok(devices.some(device => device.channel === 'beta') && devices.some(device => device.channel === 'stable'));
  const kioskClients = Array.from({ length: clients }, (_, i) => devices[i % devices.length]);
  for (let round = 0; round < rounds; round++) {
    await api('rollback', {}, 'rollback');
    const held = await Promise.all(kioskClients.map(begin));
    assert.ok(held.every(pin => pin.menu.version === 1));
    const rollout = api('rollout', { version: 2, channel: 'beta', percentage: 100 }, 'rollout');
    await Promise.all([rollout, ...held.map((pin, i) => checkout(pin, i < devices.length))]);
    const after = await Promise.all(kioskClients.map(begin));
    after.forEach((pin, i) => assert.equal(pin.menu.version, kioskClients[i].channel === 'beta' ? 2 : 1));
    const rollback = api('rollback', {}, 'rollback');
    await Promise.all([rollback, ...after.map((pin, i) => checkout(pin, i < devices.length))]);
    completedRounds++;
    report();
  }
  console.log(JSON.stringify(report(), null, 2));
  console.log(`Report: ${resolve(data, 'summary.json')}`);
} catch (error) {
  report(error);
  throw error;
} finally {
  if (server.exitCode === null && server.signalCode === null) server.kill();
  await exited;
}
