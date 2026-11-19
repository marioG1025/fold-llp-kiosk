import { HttpError } from './validation.mjs';

const measures = {
  orderCount: 'order_count',
  grossCents: 'gross_cents',
  discountCents: 'discount_cents',
  taxCents: 'tax_cents',
  tipCents: 'tip_cents',
  chargedCents: 'charged_cents',
  refundCount: 'refund_count',
  refundCents: 'refund_cents',
  netCents: 'net_cents',
};
const keys = Object.keys(measures);
const empty = () => Object.fromEntries(keys.map(key => [key, 0]));
const add = (target, source) => { for (const key of keys) target[key] += source[key]; };
const created = "json_extract(orders.receipt, '$.createdAt')";
const location = "json_extract(orders.receipt, '$.storeId')";

function calendarDate(value) {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HttpError(422, 'Enter UTC report dates as YYYY-MM-DD.');
  const time = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(time.getTime()) || time.toISOString().slice(0, 10) !== value) {
    throw new HttpError(422, 'Enter an actual calendar date.');
  }
  return value;
}

function windowSql(column, options) {
  const clauses = [];
  const args = [];
  if (options.from) { clauses.push(`${column} >= ?`); args.push(`${options.from}T00:00:00.000Z`); }
  if (options.to) { clauses.push(`${column} <= ?`); args.push(`${options.to}T23:59:59.999Z`); }
  if (options.storeId) { clauses.push(`${location} = ?`); args.push(options.storeId); }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', args };
}

export function salesReport(store, locations, query) {
  const from = calendarDate(query.get('from'));
  const to = calendarDate(query.get('to'));
  const storeId = query.get('storeId') || null;
  if (storeId && !locations.has(storeId)) throw new HttpError(422, 'Choose a FOLD store.');
  if (from && to && from > to) throw new HttpError(422, 'The start date must be on or before the end date.');
  const options = { from, to, storeId };
  const sale = windowSql(created, options);
  const returned = windowSql('refund.created_at', options);
  const entries = store.all(`
    SELECT substr(${created}, 1, 10) AS date, ${location} AS storeId,
      count(*) AS orderCount, sum(json_extract(receipt, '$.subtotalCents')) AS grossCents,
      sum(coalesce(json_extract(receipt, '$.discountCents'), 0)) AS discountCents,
      sum(json_extract(receipt, '$.taxCents')) AS taxCents,
      sum(coalesce(json_extract(receipt, '$.tipCents'), 0)) AS tipCents,
      sum(json_extract(receipt, '$.totalCents')) AS chargedCents, 0 AS refundCount, 0 AS refundCents
    FROM orders ${sale.sql} GROUP BY date, storeId
    UNION ALL
    SELECT substr(refund.created_at, 1, 10) AS date, ${location} AS storeId,
      0, 0, 0, 0, 0, 0, count(*), sum(refund.amount_cents)
    FROM refund JOIN orders ON orders.id = refund.order_id ${returned.sql} GROUP BY date, storeId
    ORDER BY date, storeId
  `, ...sale.args, ...returned.args);
  const totals = empty();
  const byStore = new Map([...locations].filter(([id]) => !storeId || storeId === id).map(([id, name]) => [
    id, { storeId: id, storeName: name, ...empty() },
  ]));
  const byDate = new Map();
  for (const entry of entries) {
    const { date, storeId: id } = entry;
    entry.netCents = entry.chargedCents - entry.refundCents;
    if (!byDate.has(date)) byDate.set(date, { date, ...empty() });
    add(totals, entry);
    add(byDate.get(date), entry);
    if (byStore.has(id)) add(byStore.get(id), entry);
  }
  return { ...options, totals, stores: [...byStore.values()], days: [...byDate.values()] };
}

export function salesCsv(report) {
  const rows = [['scope', 'date', 'store_id', 'store_name', ...Object.values(measures)]];
  const row = (scope, values) => [scope, values.date ?? '', values.storeId ?? '', values.storeName ?? '', ...keys.map(key => values[key])];
  rows.push(row('total', { ...report.totals, storeId: report.storeId }));
  for (const store of report.stores) rows.push(row('store', store));
  for (const day of report.days) rows.push(row('day', day));
  return rows.map(fields => fields.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\r\n') + '\r\n';
}
