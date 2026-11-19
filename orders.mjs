import { randomUUID } from 'node:crypto';
import { now } from './store.mjs';

const taxBasisPoints = 825;
const states = ['received', 'preparing', 'ready', 'completed'];
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isUuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createOrders({ store, live, notify }) {
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
    const taxCents = Math.floor((subtotalCents * taxBasisPoints + 5000) / 10000);
    const quote = { items, subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
    const payload = JSON.stringify({ sessionId: pinned.session.id, fulfillment: input.fulfillment, items: normalized.sort() });
    return { ...pinned, quote, payload };
  }

  function receipt(row) {
    return {
      ...JSON.parse(row.receipt), number: `F-${100 + row.sequence}`, status: row.status, updatedAt: row.updated_at,
    };
  }

  function order(input) {
    const key = input.idempotencyKey;
    if (typeof key !== 'string' || !/^[a-z0-9:_-]{8,128}$/i.test(key)) throw new HttpError(422, 'A valid checkout retry key is required.');
    const priced = price(input);
    const { session: pinned, menu, quote, payload } = priced;
    const device = live.device(pinned.deviceId);
    const result = store.transaction(() => {
      const previous = store.get('SELECT * FROM orders WHERE idempotency_key = ?', key);
      if (previous) {
        if (previous.payload !== payload) throw new HttpError(409, 'This checkout retry key was already used for a different order.');
        return { order: receipt(previous), duplicate: true };
      }
      if (pinned.orderId) throw new HttpError(409, 'This kiosk session already checked out.');
      const createdAt = now();
      const id = randomUUID();
      const record = {
        id, sessionId: pinned.id, deviceId: device.id, storeId: device.storeId, storeName: device.storeName,
        version: pinned.version, wireVersion: pinned.wireVersion, fulfillment: input.fulfillment,
        pickup: menu.pickup, ...quote, createdAt,
      };
      store.run('INSERT INTO orders(id, session_id, idempotency_key, payload, status, receipt, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id, pinned.id, key, payload, 'received', JSON.stringify(record), createdAt);
      const saved = receipt(store.get('SELECT * FROM orders WHERE id = ?', id));
      store.audit('orders', 'Order received', `${saved.number} · ${device.storeName} · Menu v${menu.version}.`);
      return { order: saved, duplicate: false };
    });
    if (!result.duplicate) notify('orders');
    return result;
  }

  function update(id, status) {
    if (!isUuid(id)) throw new HttpError(404, 'Order was not found.');
    if (!states.includes(status)) throw new HttpError(422, 'Choose a valid kitchen status.');
    let changed = false;
    const saved = store.transaction(() => {
      const row = store.get('SELECT * FROM orders WHERE id = ?', id);
      if (!row) throw new HttpError(404, 'Order was not found.');
      if (row.status === status) return receipt(row);
      if (states.indexOf(status) !== states.indexOf(row.status) + 1) {
        throw new HttpError(409, `An order marked ${row.status} cannot move to ${status}.`);
      }
      store.run('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?', status, now(), id);
      const updated = receipt(store.get('SELECT * FROM orders WHERE id = ?', id));
      store.audit('orders', 'Kitchen status updated', `${updated.number} · ${updated.storeName} · ${row.status} → ${status}.`);
      changed = true;
      return updated;
    });
    if (changed) notify('orders');
    return saved;
  }

  function get(id, sessionId) {
    if (!isUuid(id) || !isUuid(sessionId)) throw new HttpError(404, 'Receipt was not found.');
    const row = store.get('SELECT * FROM orders WHERE id = ? AND session_id = ?', id, sessionId);
    if (!row) throw new HttpError(404, 'Receipt was not found.');
    return receipt(row);
  }

  function list() {
    const active = store.all("SELECT * FROM orders WHERE status <> 'completed' ORDER BY sequence DESC");
    const recent = store.all("SELECT * FROM orders WHERE status = 'completed' ORDER BY sequence DESC LIMIT 100");
    const counts = Object.fromEntries(states.map(state => [state, 0]));
    for (const row of store.all('SELECT status, count(*) AS count FROM orders GROUP BY status')) counts[row.status] = row.count;
    return { orders: [...active, ...recent].map(receipt), counts };
  }

  return { openSession, session, quote: input => price(input).quote, order, update, get, list };
}
