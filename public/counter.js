const $ = selector => document.querySelector(selector);
const format = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const money = cents => format.format(cents / 100);
const text = (value, length) => typeof value === 'string' ? value.slice(0, length) : '';
const cents = value => Number.isSafeInteger(value) && value >= 0 && value <= 10_000_000 ? value : null;
const states = new Set(['idle', 'ticket', 'payment', 'complete']);
const device = $('#counter-device');
const ticket = $('#counter-ticket');
let devices = [];
let connection;
let activeId;
let seenAt;
let current;
let liveSummary = '';

function displaySnapshot(raw) {
  if (raw?.type !== 'snapshot' || !states.has(raw.state) || (raw.items && !Array.isArray(raw.items))) return null;
  // Project the buyer-visible fields. Operator data never becomes display content.
  const items = (raw.items ?? []).slice(0, 20).flatMap(item => {
    if (typeof item?.name !== 'string' || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 20) return [];
    return [{ name: text(item.name, 110), quantity: item.quantity, lineTotalCents: cents(item.lineTotalCents),
      modifiers: Array.isArray(item.modifiers) ? item.modifiers.slice(0, 12).map(value => text(value, 65)).filter(Boolean) : [] }];
  });
  return { state: raw.state, fulfillment: raw.fulfillment === 'to-go' ? 'To go' : 'For here', items,
    subtotal: cents(raw.subtotalCents), discount: cents(raw.discountCents), tax: cents(raw.taxCents),
    tip: cents(raw.tipCents), total: cents(raw.totalCents), orderNumber: text(raw.orderNumber, 22),
    pickupTitle: text(raw.pickup?.title ?? raw.pickup, 115), pickupDescription: text(raw.pickup?.description, 165) };
}

function element(tag, value, className = '') {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  return node;
}

function render() {
  const selected = devices.find(entry => entry.id === activeId);
  const isWaiting = !current;
  const ready = current?.state === 'complete';
  const hasTicket = Boolean(current?.items.length && current.state !== 'idle');
  $('#counter-store').textContent = selected?.storeName ?? 'FOLD COFFEE & PATISSERIE';
  $('#counter-headline').textContent = ready ? (current.orderNumber || 'Thank you.')
    : current?.state === 'payment' ? 'Your total.' : hasTicket ? 'Made for you.' : 'Welcome to Fold.';
  $('#counter-message').textContent = ready ? [current.pickupTitle, current.pickupDescription].filter(Boolean).join('. ').replaceAll('..', '.') || 'Thank you. Keep your receipt for pickup.'
    : current?.state === 'payment' ? 'Follow the cashier’s instructions to finish.'
    : hasTicket ? 'Check your items as we ring them up.'
    : isWaiting ? 'Waiting for the register. Your order will appear here.' : 'Your order will appear here.';
  $('#counter-main').classList.toggle('has-ticket', hasTicket);
  ticket.hidden = !hasTicket;
  if (!hasTicket) {
    $('#counter-lines').replaceChildren();
    $('#counter-totals').replaceChildren();
  } else {
    $('#counter-service').textContent = current.fulfillment;
    $('#counter-ticket-title').textContent = ready ? 'Receipt' : 'Your order';
    const quantity = current.items.reduce((sum, item) => sum + item.quantity, 0);
    $('#counter-count').textContent = `${quantity} item${quantity === 1 ? '' : 's'}`;
    const list = current.items.map(item => {
      const line = document.createElement('li');
      line.append(element('span', `${item.quantity} × ${item.name}`), element('strong', item.lineTotalCents === null ? '—' : money(item.lineTotalCents)));
      if (item.modifiers.length) line.append(element('small', item.modifiers.join(' · ')));
      return line;
    });
    $('#counter-lines').replaceChildren(...list);
    const breakdown = [['Subtotal', current.subtotal], ['Discount', current.discount, false, true], ['Tax', current.tax],
      ['Tip', current.tip, false, true], [ready ? 'Total paid' : 'Total', current.total, true]];
    $('#counter-totals').replaceChildren(...breakdown.flatMap(([label, value, grand, omitZero]) => {
      if ((value === null && !grand) || (omitZero && !value)) return [];
      const cls = grand ? 'counter-grand' : '';
      const amount = value === null ? 'Calculating…' : label === 'Discount' ? `−${money(value)}` : money(value);
      return [element('dt', label, cls), element('dd', amount, cls)];
    }));
  }
  const nextSummary = ready ? `Sale complete. Order ${current.orderNumber}. ${current.pickupTitle}`
    : hasTicket ? `${$('#counter-count').textContent}. ${current.total === null ? 'Calculating total.' : 'Total ' + money(current.total)}`
    : isWaiting ? 'Waiting for the register.' : 'Register ready.';
  if (nextSummary !== liveSummary) $('#counter-announce').textContent = liveSummary = nextSummary;
}

function connect(id) {
  connection?.close();
  connection = null;
  activeId = id;
  current = null;
  if ('BroadcastChannel' in window) {
    connection = new BroadcastChannel(`fold-counter-${id}`);
    connection.onmessage = ({ data }) => {
      const safe = displaySnapshot(data);
      if (!safe) return;
      seenAt = Date.now();
      const changed = JSON.stringify(current) !== JSON.stringify(safe);
      current = safe;
      if (changed) render();
    };
    connection.postMessage({ type: 'request' });
  }
  render();
}

device.addEventListener('change', () => {
  if (!devices.some(entry => entry.id === device.value)) return;
  const url = new URL(location.href);
  url.searchParams.set('device', device.value);
  history.replaceState(null, '', url);
  connect(device.value);
  $('#counter-settings').open = false;
});

const full = $('#counter-fullscreen');
if (document.fullscreenEnabled) {
  full.hidden = false;
  full.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else { await document.documentElement.requestFullscreen(); $('#counter-settings').open = false; }
    } catch { $('#counter-announce').textContent = 'Full screen is unavailable.'; }
  });
  document.addEventListener('fullscreenchange', () => { full.textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen'; });
}

async function init() {
  try {
    const response = await fetch('/api/devices', { signal: AbortSignal.timeout(4500), cache: 'no-store' });
    if (!response.ok) throw new Error('Could not load registers');
    devices = (await response.json()).devices;
    const requested = new URLSearchParams(location.search).get('device');
    const initial = devices.find(entry => entry.id === requested) ?? devices[0];
    if (!initial) throw new Error('No registers are available');
    device.replaceChildren(...devices.map(entry => new Option(`${entry.storeName} · ${entry.name.replace(/^Kiosk/, 'Register')}`, entry.id)));
    device.value = initial.id;
    device.disabled = false;
    connect(initial.id);
  } catch {
    $('#counter-message').textContent = 'Connecting to the store. Please wait.';
    setTimeout(init, 5000);
  }
}

setInterval(() => {
  if (current && Date.now() - seenAt > 18000) { current = null; render(); }
  connection?.postMessage({ type: 'request' });
}, 4000);
window.addEventListener('pagehide', () => { connection?.close(); connection = null; });
window.addEventListener('pageshow', event => { if (event.persisted && activeId) connect(activeId); });
void init();
