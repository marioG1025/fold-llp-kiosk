import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const data = mkdtempSync(join(tmpdir(), 'fold-cafe-drill-'));
const beta = 'market-02';
const stable = 'market-01';
const privateNote = 'DRILL KITCHEN NOTE: separate cups';
const profileProcesses = [];
let server;
let base;
let phase = 'start isolated server';

function executable() {
  if (process.env.FOLD_BROWSER) return process.env.FOLD_BROWSER;
  const windowsRoots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const browserPaths = process.platform === 'win32'
    ? windowsRoots.flatMap((directory) => [
      join(directory, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(directory, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(directory, 'Chromium', 'Application', 'chrome.exe'),
    ])
    : process.platform === 'darwin'
      ? ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium']
      : ['/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const found = browserPaths.find(existsSync);
  if (!found) throw new Error('Install Microsoft Edge or Chromium, or set FOLD_BROWSER to its executable path.');
  return found;
}

function launch(file, args, options) {
  const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...options });
  const handle = { child, output: '', error: null };
  handle.exited = new Promise((done) => {
    child.once('error', (error) => { handle.error = error; done(); });
    child.once('exit', done);
  });
  const append = (chunk) => { handle.output = (handle.output + chunk).slice(-6000); };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  return handle;
}

async function until(description, read, timeout = 11_000) {
  const end = Date.now() + timeout;
  let lastError;
  do {
    try {
      const value = await read();
      if (value) return value;
    } catch (error) { lastError = error; }
    await wait(100);
  } while (Date.now() < end);
  throw new Error(`${description} timed out after ${timeout} ms.${lastError ? ' ' + lastError.message : ''}`);
}

async function stop(handle) {
  if (!handle) return;
  if (handle.child.exitCode === null && handle.child.signalCode === null && !handle.error) handle.child.kill();
  await handle.exited;
}

async function stopBrowser(handle) {
  let tab = handle.tab;
  if (!tab && handle.readyFile && existsSync(handle.readyFile)) {
    const [port, browserPath] = readFileSync(handle.readyFile, 'utf8').trim().split(/\r?\n/);
    if (port && browserPath) tab = await connectTab('ws://127.0.0.1:' + port + browserPath, 'cleanup').catch(() => null);
  }
  if (tab?.socket.readyState === WebSocket.OPEN) {
    tab.call('Browser.close').catch(() => {});
    await Promise.race([handle.exited, wait(1200)]);
    tab.socket.close();
  }
  await stop(handle);
}

async function start() {
  server = launch(process.execPath, [join(root, 'server.mjs')], {
    cwd: root, env: { ...process.env, FOLD_DATA: join(data, 'data'), FOLD_PORT: '0', FOLD_DRILL: '1' },
  });
  base = await until('loopback HTTP server', () => {
    if (server.error || server.child.exitCode !== null) throw new Error(server.error?.message || server.output);
    return server.output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  }, 25_000);
}

async function api(route, payload, expectedStatus) {
  const response = await fetch(base + '/api/' + route, {
    signal: AbortSignal.timeout(9000),
    ...(payload === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    }),
  });
  const result = await response.json();
  if (expectedStatus === undefined) assert(response.ok, `${route} HTTP ${response.status} ${JSON.stringify(result)}`);
  else assert.equal(response.status, expectedStatus, `${route} ${JSON.stringify(result)}`);
  return result;
}

async function connectTab(wsUrl, identity) {
  const socket = new WebSocket(wsUrl);
  const pending = new Map();
  let callId = 0;
  const connected = once(socket, 'open');
  const failed = once(socket, 'error').then(() => { throw new Error(identity + ' DevTools connection failed.'); });
  await Promise.race([connected, failed, wait(8000).then(() => { throw new Error(identity + ' DevTools connection timed out.'); })]);
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const operation = pending.get(message.id);
    if (!operation) return;
    clearTimeout(operation.timer);
    pending.delete(message.id);
    if (message.error) operation.reject(new Error(message.error.message));
    else operation.resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const operation of pending.values()) {
      clearTimeout(operation.timer);
      operation.reject(new Error(identity + ' DevTools connection closed.'));
    }
    pending.clear();
  });
  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++callId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(identity + ' ' + method + ' timed out.'));
      }, 9000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result.value;
  }
  const element = (selector) => `document.querySelector(${JSON.stringify(selector)})`;
  return {
    call, evaluate, socket,
    navigate: async (path) => {
      const result = await call('Page.navigate', { url: base + path });
      if (result.errorText) throw new Error(identity + ' navigation: ' + result.errorText);
    },
    text: (selector) => evaluate(`${element(selector)}?.textContent.trim()`),
    has: (selector) => evaluate(`Boolean(${element(selector)})`),
    click: (selector) => evaluate(`${element(selector)}.click()`),
    setValue: (selector, value, event = 'input') => evaluate(`(() => {
      const control = ${element(selector)};
      control.value = ${JSON.stringify(value)};
      control.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true }));
    })()`),
  };
}

async function browser(file, identity, width, height) {
  const profile = join(data, identity);
  const args = ['--headless=new', '--no-first-run', '--disable-background-networking', '--disable-extensions',
    '--disable-gpu', '--disable-component-update', '--disable-breakpad',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'];
  if (process.platform === 'win32' && /msedge\.exe$/i.test(file)) args.unshift('--edge-skip-compat-layer-relaunch');
  if (process.getuid?.() === 0) args.unshift('--no-sandbox');
  const processHandle = launch(file, args, { cwd: root });
  profileProcesses.push(processHandle);
  const readyFile = join(profile, 'DevToolsActivePort');
  processHandle.readyFile = readyFile;
  const port = await until(identity + ' browser process', () => {
    return existsSync(readyFile) && readFileSync(readyFile, 'utf8').split(/\s+/)[0];
  }, 38_000).catch((error) => { throw new Error(error.message + ' ' + (processHandle.error?.message || processHandle.output)); });
  const target = await until(identity + ' browser page', async () => {
    const tabs = await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(2000) }).then((reply) => reply.json());
    return tabs.find((entry) => entry.type === 'page' && entry.url === 'about:blank');
  });
  const tab = await connectTab(target.webSocketDebuggerUrl, identity);
  processHandle.tab = tab;
  await tab.call('Page.enable');
  await tab.call('Network.enable');
  await tab.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  return tab;
}

function offline(tab, value) {
  return tab.call('Network.emulateNetworkConditions', {
    offline: value, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  });
}

async function findItem(register, name, id) {
  await register.setValue('#reg-search', name);
  const button = `#reg-products [data-product="${id}"]`;
  await until(name + ' product key', () => register.has(button));
  await register.click(button);
}

async function subtotalReady(register, amount) {
  await until('authoritative register total ' + amount, async () =>
    await register.text('#reg-total') === amount && await register.has('#reg-tender:not(:disabled)'));
}

async function payCard(register) {
  await register.click('#reg-tender');
  await waitFor(register, '#reg-payment-form');
  await register.click('[data-method="card-demo"]');
  await register.click('#reg-confirm-payment');
  await waitFor(register, '.reg-receipt-number');
  return register.text('.reg-receipt-number');
}

function waitFor(tab, selector) {
  return until(selector, () => tab.has(selector));
}

async function receipt(number) {
  const { orders } = await api('orders');
  const matches = orders.filter((entry) => entry.number === number);
  assert.equal(matches.length, 1, 'receipt must be stored once');
  return matches[0];
}

function pickupCatalog(order, version, total, title) {
  assert.equal(order.version, version);
  assert.equal(order.totalCents, total);
  assert.equal(order.pickup.title, title);
}

function privateDisplay(snapshot) {
  const allowed = ['type', 'state', 'version', 'fulfillment', 'items', 'subtotalCents', 'discountCents', 'taxCents', 'tipCents',
    'totalCents', 'orderNumber', 'pickup'];
  assert(snapshot);
  assert(Object.keys(snapshot).every((field) => allowed.includes(field)), 'relay exposed operator metadata');
  for (const item of snapshot.items) {
    assert(Object.keys(item).every((field) => ['name', 'quantity', 'lineTotalCents', 'modifiers'].includes(field)));
  }
  if (snapshot.pickup) assert(Object.keys(snapshot.pickup).every((field) => ['title', 'description'].includes(field)));
  assert(!JSON.stringify(snapshot).includes(privateNote), 'relay exposed the kitchen note');
}

function targetOf(fleet) {
  return fleet.devices.find((entry) => entry.id === beta);
}

const observations = {};

try {
  const file = executable();
  await start();
  phase = 'start separate register, counter, kitchen and pickup profiles';
  const profiles = await Promise.allSettled([
    browser(file, 'register', 1366, 768), browser(file, 'counter', 1280, 800),
    browser(file, 'kitchen', 1280, 800), browser(file, 'pickup', 1280, 800),
  ]);
  for (const result of profiles) if (result.status === 'rejected') throw result.reason;
  const [register, counter, kitchen, pickup] = profiles.map((result) => result.value);
  await Promise.all([
    register.navigate('/register?device=' + beta), counter.navigate('/counter?device=' + beta),
    kitchen.navigate('/kitchen?store=market'), pickup.navigate('/pickup?store=market'),
  ]);
  await until('register Menu v1', async () => await register.text('#reg-version') === 'Menu v1' && await register.has('#reg-search:not(:disabled)'));
  await until('counter matched beta terminal', () => counter.evaluate(`document.querySelector('#counter-device')?.value === '${beta}'`));
  await until('kitchen live in separate profile', async () => await kitchen.text('#kds-connection') === 'Live');
  const baseline = targetOf(await api('devices'));
  assert.equal(baseline.installedVersion, 1);

  phase = 'record a paid v1 sale and mirror its public receipt';
  await findItem(register, 'chocolate chunk cookie', 'chocolate-cookie');
  await subtotalReady(register, '$4.06');
  const firstNumber = await payCard(register);
  const first = await receipt(firstNumber);
  pickupCatalog(first, 1, 406, 'Collect at the bar');
  await until('same v1 receipt on separate customer display', async () => await counter.text('#counter-headline') === firstNumber);
  const paid = (await api('counter?device=' + beta)).snapshot;
  privateDisplay(paid);
  assert.equal(paid.orderNumber, firstNumber);
  assert.equal(paid.totalCents, 406);
  await register.click('#reg-dialog [data-next]');
  await until('counter clears previous receipt', async () => await counter.text('#counter-headline') === 'Welcome to Fold.');
  await waitFor(register, '#reg-search:not(:disabled)');

  phase = 'park a v1 ticket and prepare a second v1 draft';
  await findItem(register, 'chocolate chunk cookie', 'chocolate-cookie');
  await subtotalReady(register, '$4.06');
  await register.click('#reg-park');
  await register.setValue('#reg-park-label', 'Training hold');
  await register.click('#reg-park-form [type=submit]');
  await until('parked draft saved', async () => await register.text('#reg-held-count') === '1' && await register.has('#reg-search:not(:disabled)'));
  await findItem(register, 'flat white', 'flat-white');
  await register.click('#reg-lines [data-edit]');
  await register.click('#reg-dialog input[name=milk][value=oat]');
  await register.click('#reg-edit-form [type=submit]');
  await register.click('#reg-adjust');
  await register.setValue('#reg-adjust-form [name=note]', privateNote);
  await register.click('#reg-adjust-form [type=submit]');
  await subtotalReady(register, '$5.68');
  await until('draft arrives in separate customer display', async () =>
    (await counter.text('#counter-lines'))?.includes('Flat White') && (await counter.text('#counter-totals'))?.includes('$5.68'));
  assert(!(await counter.text('#counter-main')).includes(privateNote));
  const draft = (await api('counter?device=' + beta)).snapshot;
  privateDisplay(draft);
  assert.equal(draft.orderNumber, null);
  assert.equal(draft.version, 1);
  assert.equal((await api('counter?device=' + stable)).snapshot, null);
  await counter.setValue('#counter-device', stable, 'change');
  await until('other terminal cannot see beta ticket', async () => await counter.text('#counter-headline') === 'Welcome to Fold.' &&
    await counter.has('#counter-ticket[hidden]'));
  await counter.setValue('#counter-device', beta, 'change');
  await until('returning to beta restores only its ticket', async () => (await counter.text('#counter-lines'))?.includes('Flat White'));
  await until('register controlled by its offline service worker', () => register.evaluate('Boolean(navigator.serviceWorker.controller)'));
  await register.click('#reg-tender');
  await waitFor(register, '#reg-dialog[open] #reg-payment-form');
  await until('customer display shows payment before the outage', async () => await counter.text('#counter-headline') === 'Your total.');

  phase = 'disconnect register network and its LLP agent independently';
  await offline(register, true);
  await until('register is genuinely offline', async () => await register.evaluate('navigator.onLine === false'));
  await until('offline immediately closes tender and invalidates the old quote', async () =>
    await register.has('#reg-tender:disabled') && !(await register.has('#reg-dialog[open] #reg-payment-form')));
  assert(await register.has('#reg-void:disabled'), 'offline cashier cannot replace a draft with a fresh ticket');
  assert(await register.evaluate(`fetch('/api/health?fresh=' + Date.now(), { cache: 'no-store' }).then(() => false, () => true)`));
  assert(await counter.evaluate('navigator.onLine'));
  assert(await kitchen.evaluate('navigator.onLine'));
  const disconnected = targetOf(await api('drill/device', { deviceId: beta, connected: false }));
  assert.equal(disconnected.status, 'offline');
  await api('rollout', { version: 2, channel: 'beta', percentage: 100 });
  const fleet = await api('devices');
  const staged = targetOf(fleet);
  assert.equal(staged.status, 'offline');
  assert.equal(staged.desiredVersion, 2);
  assert.equal(staged.installedVersion, 1);
  const stablePeers = fleet.devices.filter((entry) => entry.channel === 'stable');
  const betaPeers = fleet.devices.filter((entry) => entry.channel === 'beta' && entry.id !== beta);
  assert(stablePeers.length > 0 && stablePeers.every((entry) =>
    entry.status === 'live' && entry.installedVersion === 1 && entry.desiredVersion === 1));
  assert(betaPeers.length > 0 && betaPeers.every((entry) =>
    entry.status === 'live' && entry.installedVersion === 2 && entry.desiredVersion === 2));
  const other = await api('sessions', { deviceId: stable });
  assert.equal(other.menu.version, 1, 'stable stores still accept v1 customers');
  const paymentCount = (await api('orders')).orders.length;

  phase = 'reload and keep editing the offline v1 draft while kitchen stays online';
  await register.call('Page.reload', { ignoreCache: false });
  await until('cached v1 register and draft after offline reload', async () =>
    await register.evaluate('!navigator.onLine') && await register.text('#reg-version') === 'Menu v1' &&
    (await register.text('#reg-lines'))?.includes('Flat White') && await register.text('#reg-held-count') === '1');
  assert.equal(await register.text('#reg-connection'), 'Offline');
  assert.match(await register.text('#reg-link-note'), /Tender is paused/i);
  assert(await register.has('#reg-tender:disabled'), 'payment must be unavailable offline');
  await register.click('#reg-lines [data-step="1"]');
  assert.equal(await register.text('#reg-lines .stepper span'), '2');
  await register.click('#reg-tender');
  assert(!(await register.has('#reg-payment-form')), 'offline cannot open payment');
  assert.equal((await api('orders')).orders.length, paymentCount);
  await register.navigate('/register?device=' + stable);
  await until('fresh terminal has no writable sale while offline', async () =>
    await register.text('#reg-connection') === 'Offline' &&
    await register.has('#reg-search:disabled') && await register.has('#reg-tender:disabled') &&
    (await register.text('#reg-products'))?.includes('Register menu unavailable'));
  await register.navigate('/register?device=' + beta);
  await until('return to saved terminal without discarding its draft', async () =>
    await register.text('#reg-version') === 'Menu v1' && await register.text('#reg-lines .stepper span') === '2');
  const firstTicket = `[data-ticket="${first.id}"]`;
  await waitFor(kitchen, `[data-lane="received"] ${firstTicket} [data-bump]`);
  await kitchen.click(`${firstTicket} [data-bump]`);
  await waitFor(kitchen, `[data-lane="preparing"] ${firstTicket}`);
  await kitchen.click(`${firstTicket} [data-bump]`);
  await waitFor(kitchen, `[data-lane="ready"] ${firstTicket}`);
  assert.equal(await kitchen.text('#kds-connection'), 'Live');
  await until('separate counter clears when its relay heartbeat expires', async () =>
    (await api('counter?device=' + beta)).snapshot === null && await counter.text('#counter-headline') === 'Welcome to Fold.', 29_000);
  observations.outage = { offline: staged.status, installed: staged.installedVersion, desired: staged.desiredVersion,
    stableV1: stablePeers.length, connectedBetaV2: betaPeers.length, stableMenu: other.menu.version };
  observations.offlineDraft = { code: beta, version: 1, quantity: 2, parked: 1, tenderClosed: true,
    freshSaleBlocked: true, paymentsRecorded: 0, counterExpired: true };

  phase = 'reconnect browser and LLP independently, then recover a lost v1 checkout reply';
  await offline(register, false);
  await until('network restored in the register profile', () => register.evaluate('navigator.onLine'));
  assert.equal(targetOf(await api('devices')).status, 'offline', 'browser connectivity cannot reconnect the LLP agent');
  const reconnected = targetOf(await api('drill/device', { deviceId: beta, connected: true }));
  assert.equal(reconnected.status, 'live');
  assert.equal(reconnected.installedVersion, 2);
  assert(reconnected.wireVersion > baseline.wireVersion && Number.isFinite(reconnected.ackMs));
  await subtotalReady(register, '$11.37');
  assert.equal(await register.text('#reg-version'), 'Menu v1');
  await until('old draft restored on separate customer display', async () => (await counter.text('#counter-totals'))?.includes('$11.37'));
  await register.evaluate(`(() => {
    const forward = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const response = await forward(input, init);
      if (input === '/api/orders' && init?.method === 'POST' && !window.foldDrillAttempt) {
        window.foldDrillAttempt = JSON.parse(init.body);
        await response.text();
        throw new TypeError('Drill dropped the reply after commit');
      }
      return response;
    };
  })()`);
  const oldNumber = await payCard(register);
  const old = await receipt(oldNumber);
  pickupCatalog(old, 1, 1137, 'Collect at the bar');
  assert.equal(old.note, privateNote);
  assert.equal(old.items[0].quantity, 2);
  assert.equal((await api('orders')).orders.length, paymentCount + 1);
  const replay = await api('orders', await register.evaluate('window.foldDrillAttempt'), 200);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.order.id, old.id);
  await until('counter shows v1 receipt after lost reply recovery', async () => await counter.text('#counter-headline') === oldNumber);
  privateDisplay((await api('counter?device=' + beta)).snapshot);
  assert(!(await counter.text('#counter-main')).includes(privateNote));
  await register.click('#reg-dialog [data-next]');
  await until('new register sale uses installed v2', async () => await register.text('#reg-version') === 'Menu v2' && await register.has('#reg-search:not(:disabled)'));
  await until('old receipt cleared after the next sale', async () => await counter.text('#counter-headline') === 'Welcome to Fold.');
  assert.equal(await register.text('#reg-held-count'), '1');
  await register.click('#reg-held');
  assert((await register.text('#reg-dialog')).includes('Training hold'));
  await register.click('#reg-dialog [data-close]');
  observations.reconnect = { installed: reconnected.installedVersion, wireVersion: reconnected.wireVersion, ackMs: reconnected.ackMs,
    v1Receipt: old.number, v1TotalCents: old.totalCents, replayReusedReceipt: replay.duplicate };

  phase = 'accept v2 at the register, bump it in kitchen, and show pickup number';
  await findItem(register, 'flat white', 'flat-white');
  await subtotalReady(register, '$5.14');
  const newNumber = await payCard(register);
  const next = await receipt(newNumber);
  pickupCatalog(next, 2, 514, 'Collect at the Fold pickup shelf');
  const newTicket = `[data-ticket="${next.id}"]`;
  await waitFor(kitchen, `[data-lane="received"] ${newTicket} [data-bump]`);
  await until('new v2 ticket appears on public pickup display', async () => (await pickup.text('#pickup-preparing'))?.includes(newNumber));
  await kitchen.click(`${newTicket} [data-bump]`);
  await waitFor(kitchen, `[data-lane="preparing"] ${newTicket}`);
  await kitchen.click(`${newTicket} [data-bump]`);
  await waitFor(kitchen, `[data-lane="ready"] ${newTicket}`);
  await until('shelf number moved to Ready', async () => (await pickup.text('#pickup-ready'))?.includes(newNumber));
  assert(!(await pickup.text('#main')).includes(privateNote));
  const publicQueue = await api('pickup?store=market');
  assert(publicQueue.orders.some((entry) => entry.number === newNumber && entry.status === 'ready'));
  assert(publicQueue.orders.every((entry) => ![oldNumber, firstNumber].includes(entry.number)));
  assert((await api('orders')).orders.some((entry) => entry.id === first.id && entry.totalCents === 406));
  await register.click('#reg-dialog [data-next]');
  await waitFor(register, '#reg-search:not(:disabled)');
  await register.click('#reg-held');
  await register.click('#reg-dialog [data-recall]');
  await subtotalReady(register, '$4.06');
  assert.equal(await register.text('#reg-version'), 'Menu v1', 'a recalled ticket retains the signed menu it was parked with');
  assert.equal(await register.text('#reg-held-count'), '0');
  observations.fulfillment = { paidDuringOutage: 0, oldSaleRemains: firstNumber, nextReceipt: newNumber,
    v2TotalCents: next.totalCents, v2Pickup: next.pickup.title, kitchen: 'ready', recalledParkedMenu: 1 };
  console.log(JSON.stringify({ result: 'passed', separateProfiles: ['register', 'counter', 'kitchen', 'pickup'], ...observations }, null, 2));
} catch (error) {
  console.error(`FOLD café drill failed during "${phase}". Isolated data: ${resolve(data)}`);
  console.error(error);
  if (server?.output) console.error(server.output);
  process.exitCode = 1;
} finally {
  await Promise.allSettled(profileProcesses.map(stopBrowser));
  await stop(server);
}
