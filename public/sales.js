const $ = selector => document.querySelector(selector);
const form = $('#sales-filters');
const inputs = form.elements;
const status = $('#sales-status');
const output = $('#sales-results');
const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const money = value => currency.format((value ?? 0) / 100);
const metrics = [['netCents', 'Net collections'], ['orderCount', 'Orders'], ['grossCents', 'Gross sales'],
  ['discountCents', 'Discounts'], ['taxCents', 'Tax'], ['tipCents', 'Tips'], ['chargedCents', 'Collected'],
  ['refundCount', 'Refunds'], ['refundCents', 'Refunded']];
const columns = [['orderCount', 'Orders'], ['chargedCents', 'Collected'], ['refundCents', 'Refunded'], ['netCents', 'Net']];
let loading;

function element(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatMetric(key, value) { return key.endsWith('Cents') ? money(value) : String(value ?? 0); }

function table(rows, label, nameOf, cols) {
  if (!rows.length) return element('p', 'No activity for this period.');
  const table = element('table');
  table.setAttribute('aria-label', label);
  const head = table.createTHead().insertRow();
  for (const title of [label, ...cols.map(([, name]) => name)]) {
    const cell = element('th', title); cell.scope = 'col'; head.append(cell);
  }
  const body = table.createTBody();
  for (const row of rows) {
    const tr = body.insertRow();
    const name = element('th', nameOf(row)); name.scope = 'row'; tr.append(name);
    for (const [key] of cols) tr.append(element('td', formatMetric(key, row[key])));
  }
  return table;
}

function updateChart(days) {
  const chart = $('#sales-chart');
  if (!days.length) { chart.replaceChildren(element('li', 'No activity to chart.')); return; }
  const visible = days.slice(-14);
  const peak = Math.max(1, ...visible.map(day => Math.abs(day.netCents)));
  chart.replaceChildren(...visible.map(day => {
    const row = element('li');
    const date = element('time', day.date.slice(5)); date.dateTime = day.date;
    const track = element('span'); track.className = 'track'; track.setAttribute('aria-hidden', 'true');
    const fill = element('span'); fill.className = 'bar'; fill.style.width = `${Math.abs(day.netCents) / peak * 100}%`;
    const amount = element('strong', money(day.netCents));
    fill.toggleAttribute('data-negative', day.netCents < 0); amount.toggleAttribute('data-negative', day.netCents < 0);
    track.append(fill); row.append(date, track, amount); return row;
  }));
}

function render(report, query) {
  const location = [...inputs.storeId.options].find(option => option.value === (report.storeId ?? ''))?.textContent ?? 'All stores';
  $('#sales-period-title').textContent = `${location} · ${report.from || report.to ? `${report.from ?? 'Start'} to ${report.to ?? 'present'} UTC` : 'All time'}`;
  $('#sales-metrics').replaceChildren(...metrics.map(([key, label]) => {
    const group = element('div'); group.append(element('dt', label), element('dd', formatMetric(key, report.totals[key]))); return group;
  }));
  const days = [...report.days].sort((a, b) => a.date.localeCompare(b.date));
  updateChart(days);
  $('#sales-stores').replaceChildren(table(report.stores, 'Store', row => row.storeName, columns));
  $('#sales-days').replaceChildren(table([...days].reverse(), 'Date (UTC)', row => row.date,
    [['grossCents', 'Gross'], ['discountCents', 'Discounts'], ['taxCents', 'Tax'], ['tipCents', 'Tips'], ...columns]));
  $('#sales-csv').href = '/api/reports/sales.csv' + (query.size ? `?${query}` : '');
  status.textContent = report.totals.orderCount || report.totals.refundCount
    ? `${days.length} day${days.length === 1 ? '' : 's'} with activity${days.length > 14 ? ' · chart shows the latest 14' : ''}`
    : 'No orders or refunds in this period.';
  output.hidden = false;
}

function isoDay(offset = 0) {
  const date = new Date(); date.setUTCDate(date.getUTCDate() - offset);
  return date.toISOString().slice(0, 10);
}

function updateDateControls() {
  const custom = inputs.period.value === 'custom';
  for (const label of form.querySelectorAll('[data-custom]')) label.hidden = !custom;
  inputs.from.disabled = inputs.to.disabled = !custom;
}

async function load() {
  const query = new URLSearchParams();
  if (inputs.storeId.value) query.set('storeId', inputs.storeId.value);
  const period = inputs.period.value;
  if (period === 'custom') {
    if (inputs.from.value) query.set('from', inputs.from.value);
    if (inputs.to.value) query.set('to', inputs.to.value);
  } else if (period !== 'all') {
    query.set('from', isoDay(period === 'today' ? 0 : Number(period) - 1));
    query.set('to', isoDay());
  }

  loading?.abort();
  const abort = loading = new AbortController();
  if (query.has('from') && query.has('to') && query.get('from') > query.get('to')) {
    output.hidden = true; status.textContent = 'Choose an end date on or after the start date.'; return;
  }
  const currentUrl = new URL(location.href);
  currentUrl.search = query;
  currentUrl.searchParams.set('period', period);
  history.replaceState(null, '', currentUrl);
  status.textContent = 'Loading sales…';
  output.hidden = true;
  try {
    const response = await fetch('/api/reports/sales?' + query, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(12000)]), cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? 'Sales report unavailable.');
    if (!abort.signal.aborted) render(data, query);
  } catch (error) {
    if (!abort.signal.aborted) status.textContent = error.name === 'TimeoutError' ? 'The report timed out. Run it again.' : error.message;
  }
}

const initial = new URLSearchParams(location.search);
if ([...inputs.storeId.options].some(option => option.value === initial.get('storeId'))) inputs.storeId.value = initial.get('storeId');
if ([...inputs.period.options].some(option => option.value === initial.get('period'))) inputs.period.value = initial.get('period');
else if (initial.has('from') || initial.has('to')) inputs.period.value = 'custom';
inputs.from.value = initial.get('from') ?? '';
inputs.to.value = initial.get('to') ?? '';
updateDateControls();
inputs.period.addEventListener('change', updateDateControls);
form.addEventListener('submit', event => { event.preventDefault(); void load(); });
$('#sales-print').addEventListener('click', () => window.print());
void load();
