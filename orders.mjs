import { randomUUID } from 'node:crypto';
import { devices } from './catalog.mjs';
import { createInventory } from './inventory.mjs';
import { now } from './store.mjs';
import { cleanText, HttpError, isObject, isRetryKey, isUuid } from './validation.mjs';

const taxBasisPoints = 825;
const states = ['received', 'preparing', 'ready', 'completed'];
export const locations = new Map(devices.map(device => [device.storeId, device.storeName]));
const discounts = [
  { id: 'none', label: 'No discount', basisPoints: 0 },
  { id: 'staff-10', label: 'Staff 10%', basisPoints: 1000 },
  { id: 'service-15', label: 'Service recovery 15%', basisPoints: 1500 },
];
const noteLimit = 240;
const tipLimitCents = 5000;
const cashLimitCents = 1_000_000;
export const posPolicy = { discounts, taxBasisPoints, tipLimitCents, noteLimit, cashLimitCents };
const roundBasisPoints = (amount, basisPoints) => Math.floor((amount * basisPoints + 5000) / 10000);
const selectOrder = `
  SELECT orders.*, refund.id AS refund_id, refund.amount_cents AS refund_amount,
    refund.reason AS refund_reason, refund.created_at AS refund_created
  FROM orders LEFT JOIN refund ON orders.id = refund.order_id
`;

function resolveTender(input, totalCents) {
  if (input === undefined) return null; // Self-service checkout uses the existing demo path.
  if (!isObject(input)) throw new HttpError(422, 'Choose cash or demo card.');
  if (input.method === 'card-demo' && Object.keys(input).length === 1) return { method: 'card-demo' };
  if (input.method !== 'cash' || Object.keys(input).some(key => !['method', 'receivedCents'].includes(key))) {
    throw new HttpError(422, 'Choose cash or demo card.');
  }
  const { receivedCents } = input;
  if (!Number.isSafeInteger(receivedCents) || receivedCents < totalCents) throw new HttpError(422, 'Cash received must cover the total.');
  if (receivedCents > cashLimitCents) throw new HttpError(422, 'Cash received exceeds the demo register limit.');
  return { method: 'cash', receivedCents, changeCents: receivedCents - totalCents };
}

function adjustments({ discount = 'none', tipCents = 0, note }, subtotalCents) {
  const preset = discounts.find(entry => entry.id === discount);
  if (!preset) throw new HttpError(422, 'Choose a supported discount preset.');
  if (!Number.isInteger(tipCents) || tipCents < 0 || tipCents > tipLimitCents) {
    throw new HttpError(422, 'Tip must be an amount between $0 and $50 in whole cents.');
  }
  const discountCents = roundBasisPoints(subtotalCents, preset.basisPoints);
  const taxableSubtotalCents = subtotalCents - discountCents;
  const taxCents = roundBasisPoints(taxableSubtotalCents, taxBasisPoints);
  return {
    discount, discountCents, taxableSubtotalCents, taxCents, tipCents, note: cleanText(note, noteLimit, 'Staff note'),
    totalCents: taxableSubtotalCents + taxCents + tipCents,
  };
}

export function createOrders({ store, live, notify }) {
  const inventory = createInventory({ store, live, locations, notify });

  function session(id) {
    if (!isUuid(id)) throw new HttpError(404, 'Kiosk session is unavailable.');
    const row = store.get(`
      SELECT session.*, orders.id AS order_id FROM session
      LEFT JOIN orders ON session.id = orders.session_id WHERE session.id = ?
    `, id);
    if (!row) throw new HttpError(404, 'Kiosk session is unavailable.');
    return {
      session: { id, deviceId: row.device_id, version: row.version, wireVersion: row.wire_version, createdAt: row.created_at, orderId: row.order_id },
      menu: live.menu(row.version),
    };
  }

  function openSession(deviceId) {
    if (!live.device(deviceId)) throw new HttpError(404, 'Choose a registered kiosk.');
    const installed = live.installed(deviceId);
    if (!installed) throw new HttpError(503, 'The kiosk is reconnecting. Please try again.');
    const id = randomUUID();
    store.run('INSERT INTO session VALUES (?, ?, ?, ?, ?)', id, deviceId, installed.version, installed.wireVersion, now());
    return session(id);
  }

  function price(input) {
    const pinned = session(input.sessionId);
    if (!['here', 'to-go'].includes(input.fulfillment)) throw new HttpError(422, 'Choose For here or To go.');
    if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 20) {
      throw new HttpError(422, 'Choose between 1 and 20 cart lines.');
    }
    const normalized = [];
    const items = input.items.map(raw => {
      if (!isObject(raw) || !Number.isInteger(raw.quantity) || raw.quantity < 1 || raw.quantity > 20) {
        throw new HttpError(422, 'Each cart line needs a quantity from 1 to 20.');
      }
      const product = pinned.menu.items.find(item => item.id === raw.itemId);
      if (!product) throw new HttpError(422, 'An item is unavailable on this menu.');
      const requested = raw.modifiers ?? {};
      if (!isObject(requested) || Object.keys(requested).some(id => !product.modifiers.some(group => group.id === id))) {
        throw new HttpError(422, `Check the options for ${product.name}.`);
      }
      const modifierIds = {};
      const modifiers = [];
      for (const group of product.modifiers) {
        const optionId = Object.hasOwn(requested, group.id) ? requested[group.id] : undefined;
        if (optionId === undefined && !group.required) continue;
        const option = group.options.find(entry => entry.id === optionId);
        if (!option) throw new HttpError(422, `Choose a valid ${group.name.toLowerCase()} option for ${product.name}.`);
        modifiers.push({ ...option, groupId: group.id });
        modifierIds[group.id] = option.id;
      }
      const unitPriceCents = product.priceCents + modifiers.reduce((sum, option) => sum + option.priceCents, 0);
      normalized.push(JSON.stringify({ itemId: product.id, quantity: raw.quantity, modifiers: modifierIds }));
      return { itemId: product.id, name: product.name, quantity: raw.quantity, modifiers, unitPriceCents, lineTotalCents: unitPriceCents * raw.quantity };
    });
    const subtotalCents = items.reduce((sum, item) => sum + item.lineTotalCents, 0);
    const quote = { items, subtotalCents, ...adjustments(input, subtotalCents) };
    const { discount, tipCents, note } = quote;
    const payload = { sessionId: pinned.session.id, fulfillment: input.fulfillment, items: normalized.sort() };
    // Preserve the fingerprint of checkout requests that predate adjustments.
    if (discount !== 'none') payload.discount = discount;
    if (tipCents) payload.tipCents = tipCents;
    if (note) payload.note = note;
    return { ...pinned, quote, payload, device: live.device(pinned.session.deviceId) };
  }

  function receipt(row) {
    const sale = JSON.parse(row.receipt);
    const refund = row.refund_id ? {
      id: row.refund_id, amountCents: row.refund_amount, reason: row.refund_reason, createdAt: row.refund_created,
    } : null;
    return {
      discount: 'none', discountCents: 0, tipCents: 0, note: '', taxableSubtotalCents: sale.subtotalCents,
      ...sale, number: `F-${100 + row.sequence}`, status: row.status, updatedAt: row.updated_at, refund,
    };
  }

  function order(input) {
    const key = input.idempotencyKey;
    if (!isRetryKey(key)) throw new HttpError(422, 'A valid checkout retry key is required.');
    const { session: pinned, menu, quote, payload: normalized, device } = price(input);
    const tender = resolveTender(input.tender, quote.totalCents);
    const payload = JSON.stringify(tender ? { ...normalized, tender } : normalized);
    let stockChanged = false;
    const result = store.transaction(() => {
      const previous = store.get(`${selectOrder} WHERE orders.idempotency_key = ?`, key);
      if (previous) {
        if (previous.payload !== payload) throw new HttpError(409, 'This checkout retry key was already used for a different order.');
        return { order: receipt(previous), duplicate: true };
      }
      if (pinned.orderId) throw new HttpError(409, 'This kiosk session already checked out.');
      stockChanged = inventory.consume(device.storeId, quote.items);
      const createdAt = now();
      const id = randomUUID();
      const record = {
        id, sessionId: pinned.id, deviceId: device.id, storeId: device.storeId, storeName: device.storeName,
        version: pinned.version, wireVersion: pinned.wireVersion, fulfillment: input.fulfillment,
        pickup: menu.pickup, ...quote, ...(tender ? { tender } : {}), createdAt,
      };
      store.run('INSERT INTO orders(id, session_id, idempotency_key, payload, status, receipt, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id, pinned.id, key, payload, 'received', JSON.stringify(record), createdAt);
      const saved = receipt(store.get(`${selectOrder} WHERE orders.id = ?`, id));
      store.audit('orders', 'Order received', `${saved.number} · ${device.storeName} · Menu v${menu.version}.`);
      return { order: saved, duplicate: false };
    });
    if (!result.duplicate) {
      notify('orders');
      if (stockChanged) notify('inventory');
    }
    return result;
  }

  function refund(id, input) {
    if (!isUuid(id)) throw new HttpError(404, 'Order was not found.');
    const key = input.idempotencyKey;
    if (!isRetryKey(key)) throw new HttpError(422, 'A valid refund retry key is required.');
    const reason = cleanText(input.reason, 160, 'Refund reason', true);
    const result = store.transaction(() => {
      const row = store.get(`${selectOrder} WHERE orders.id = ?`, id);
      if (!row) throw new HttpError(404, 'Order was not found.');
      const existing = store.get('SELECT order_id, reason FROM refund WHERE idempotency_key = ?', key);
      if (existing) {
        if (existing.order_id !== id || existing.reason !== reason) throw new HttpError(409, 'This refund key was already used for a different request.');
        return { order: receipt(row), duplicate: true };
      }
      if (row.refund_id) throw new HttpError(409, 'This order already has a full refund.');
      const saved = receipt(row);
      const timestamp = now();
      store.run('INSERT INTO refund VALUES (?, ?, ?, ?, ?, ?)', id, randomUUID(), key, saved.totalCents, reason, timestamp);
      store.run('UPDATE orders SET updated_at = ? WHERE id = ?', timestamp, id);
      store.audit('orders', 'Demo refund recorded', `${saved.number} · ${saved.storeName} · ${saved.totalCents} cents.`);
      return { order: receipt(store.get(`${selectOrder} WHERE orders.id = ?`, id)), duplicate: false };
    });
    if (!result.duplicate) notify('orders');
    return result;
  }

  function update(id, status) {
    if (!isUuid(id)) throw new HttpError(404, 'Order was not found.');
    if (!states.includes(status)) throw new HttpError(422, 'Choose a valid kitchen status.');
    let changed = false;
    const saved = store.transaction(() => {
      const row = store.get(`${selectOrder} WHERE orders.id = ?`, id);
      if (!row) throw new HttpError(404, 'Order was not found.');
      if (row.status === status) return receipt(row);
      if (row.refund_id) throw new HttpError(409, 'This order has been refunded.');
      if (states.indexOf(status) !== states.indexOf(row.status) + 1) {
        throw new HttpError(409, `An order marked ${row.status} cannot move to ${status}.`);
      }
      store.run('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?', status, now(), id);
      const updated = receipt(store.get(`${selectOrder} WHERE orders.id = ?`, id));
      store.audit('orders', 'Kitchen status updated', `${updated.number} · ${updated.storeName} · ${row.status} → ${status}.`);
      changed = true;
      return updated;
    });
    if (changed) notify('orders');
    return saved;
  }

  function get(id, sessionId) {
    if (!isUuid(id) || !isUuid(sessionId)) throw new HttpError(404, 'Receipt was not found.');
    const row = store.get(`${selectOrder} WHERE orders.id = ? AND session_id = ?`, id, sessionId);
    if (!row) throw new HttpError(404, 'Receipt was not found.');
    return receipt(row);
  }

  function list() {
    const active = store.all(`${selectOrder} WHERE status <> 'completed' AND refund.id IS NULL ORDER BY sequence DESC`);
    const recent = store.all(`${selectOrder} WHERE status = 'completed' OR refund.id IS NOT NULL ORDER BY sequence DESC LIMIT 100`);
    const counts = Object.fromEntries([...states, 'refunded'].map(state => [state, 0]));
    for (const row of store.all(`
      SELECT CASE WHEN refund.id IS NULL THEN orders.status ELSE 'refunded' END AS bucket, count(*) AS count
      FROM orders LEFT JOIN refund ON orders.id = refund.order_id GROUP BY bucket
    `)) counts[row.bucket] = row.count;
    return { orders: [...active, ...recent].map(receipt), counts };
  }

  function recent(deviceId, requestedLimit) {
    if (!live.device(deviceId)) throw new HttpError(422, 'Choose a registered kiosk.');
    const limit = requestedLimit === null ? 12 : Number(requestedLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new HttpError(422, 'Choose between 1 and 50 recent receipts.');
    const rows = store.all(`${selectOrder} JOIN session ON orders.session_id = session.id
      WHERE session.device_id = ? ORDER BY sequence DESC LIMIT ?`, deviceId, limit);
    return { orders: rows.map(receipt) };
  }

  function pickup(storeId) {
    if (!locations.has(storeId)) throw new HttpError(422, 'Choose a FOLD store.');
    const rows = store.all(`
      SELECT sequence, status FROM orders
      WHERE status IN ('received', 'preparing', 'ready')
        AND NOT EXISTS (SELECT 1 FROM refund WHERE refund.order_id = orders.id)
        AND json_extract(receipt, '$.storeId') = ?
        AND json_extract(receipt, '$.version') = 2
      ORDER BY sequence ASC`, storeId);
    return { storeId, orders: rows.map(row => ({ number: `F-${100 + row.sequence}`, status: row.status })) };
  }

  function quote(input) {
    const priced = price(input);
    inventory.check(priced.device.storeId, priced.quote.items);
    return priced.quote;
  }

  return { openSession, session, quote, order, refund, update, get, list, pickup, recent, inventory };
}
