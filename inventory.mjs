import { now } from './store.mjs';
import { HttpError } from './validation.mjs';

export function createInventory({ store, live, locations, notify }) {
  function location(storeId) {
    const name = locations.get(storeId);
    if (!name) throw new HttpError(422, 'Choose a FOLD store.');
    return name;
  }

  function list(storeId) {
    location(storeId);
    const items = store.all('SELECT * FROM inventory WHERE store_id = ? ORDER BY item_id', storeId).map(row => ({
      itemId: row.item_id,
      quantity: row.quantity,
      available: row.enabled === 1 && row.quantity !== 0,
      manualBlock: row.enabled === 0,
      updatedAt: row.updated_at,
    }));
    return { storeId, items };
  }

  function update({ storeId, itemId, available, quantity = null }) {
    const name = location(storeId);
    const product = live.releases().flatMap(({ version }) => live.menu(version).items).find(item => item.id === itemId);
    if (!product) throw new HttpError(422, 'Choose a registered menu item.');
    if (typeof available !== 'boolean') throw new HttpError(422, 'Choose available or sold out.');
    if (quantity !== null && (!Number.isInteger(quantity) || quantity < 0 || quantity > 999)) {
      throw new HttpError(422, 'Stock must be a whole number between 0 and 999.');
    }
    const changed = store.transaction(() => {
      const before = store.get('SELECT enabled, quantity FROM inventory WHERE store_id = ? AND item_id = ?', storeId, itemId);
      const enabled = Number(available);
      if ((before?.enabled ?? 1) === enabled && (before?.quantity ?? null) === quantity) return false;
      if (available && quantity === null) {
        store.run('DELETE FROM inventory WHERE store_id = ? AND item_id = ?', storeId, itemId);
      } else {
        store.run(`
          INSERT INTO inventory VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(store_id, item_id) DO UPDATE SET enabled = excluded.enabled,
          quantity = excluded.quantity, updated_at = excluded.updated_at
        `, storeId, itemId, enabled, quantity, now());
      }
      const label = !available ? 'marked sold out' : quantity === null ? 'unlimited availability' : `${quantity} remaining`;
      store.audit('inventory', 'Stock updated', `${name} · ${product.name} · ${label}.`);
      return true;
    });
    if (changed) notify('inventory');
    return list(storeId);
  }

  // Aggregate customized lines by SKU before checking the shared store count.
  function check(storeId, items) {
    const demand = new Map();
    for (const item of items) {
      const quantity = (demand.get(item.itemId)?.quantity ?? 0) + item.quantity;
      demand.set(item.itemId, { name: item.name, quantity });
    }
    const decrement = [];
    for (const [itemId, item] of demand) {
      const row = store.get('SELECT enabled, quantity FROM inventory WHERE store_id = ? AND item_id = ?', storeId, itemId);
      if (!row) continue;
      const remaining = row.enabled ? row.quantity : 0;
      if (remaining !== null && item.quantity > remaining) {
        const message = remaining === 0 ? `${item.name} is sold out at this store.`
          : `Only ${remaining} of ${item.name} remain at this store.`;
        throw new HttpError(409, message, { code: 'inventory_unavailable', storeId, itemId, remaining });
      }
      if (row.quantity !== null) decrement.push({ itemId, quantity: item.quantity, remaining: row.quantity - item.quantity, name: item.name });
    }
    return decrement;
  }

  function consume(storeId, items) {
    const limited = check(storeId, items);
    for (const { itemId, quantity, name, remaining } of limited) {
      const result = store.run(`
        UPDATE inventory SET quantity = quantity - ?, updated_at = ?
        WHERE store_id = ? AND item_id = ? AND enabled = 1 AND quantity >= ?
      `, quantity, now(), storeId, itemId, quantity);
      if (!result.changes) throw new HttpError(409, `Stock changed for ${name}. Review the cart and try again.`);
      if (remaining === 0) store.audit('inventory', 'Stock exhausted', `${location(storeId)} · ${name} sold out.`);
    }
    return limited.length > 0;
  }

  return { list, update, check, consume };
}
