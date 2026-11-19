import { HttpError } from './validation.mjs';

const states = ['idle', 'ticket', 'payment', 'complete'];
const counterTtlMs = 18_000;

function visibleLines(items) {
  return items.map(({ name, quantity, lineTotalCents, modifiers }) => ({
    name, quantity, lineTotalCents, modifiers: modifiers.map(option => option.name),
  }));
}

function receiptSnapshot(order) {
  return {
    type: 'snapshot', state: 'complete', version: order.version, fulfillment: order.fulfillment,
    items: visibleLines(order.items),
    subtotalCents: order.subtotalCents, discountCents: order.discountCents, taxCents: order.taxCents,
    tipCents: order.tipCents, totalCents: order.totalCents, orderNumber: order.number,
    pickup: { title: order.pickup.title, description: order.pickup.description },
  };
}

function ticketSnapshot({ state, items, fulfillment, discount, tipCents, quoted }, pinned, orders) {
  if (typeof quoted !== 'boolean') throw new HttpError(422, 'Mark whether the customer display is quoted.');
  // The counter shares checkout's pricing and option validation. Stock stays checked by quote/checkout.
  const quote = orders.counterQuote({ items, fulfillment, discount, tipCents }, pinned);
  return {
    type: 'snapshot', state, version: pinned.session.version, fulfillment,
    items: visibleLines(quote.items), subtotalCents: quote.subtotalCents,
    discountCents: quote.discountCents, tipCents: quote.tipCents,
    taxCents: quoted ? quote.taxCents : null, totalCents: quoted ? quote.totalCents : null,
    orderNumber: null, pickup: null,
  };
}

export function createCounter({ store, live, orders, notify, clock = Date.now }) {
  const displays = new Map();

  function displayFor(deviceId) {
    if (!live.device(deviceId)) throw new HttpError(422, 'Choose a registered kiosk.');
    const display = displays.get(deviceId) ?? { closedThrough: 0, sequence: null, snapshot: null };
    if (display.snapshot && display.expiresAt <= clock()) {
      display.snapshot = null;
      display.orderId = null;
    }
    return display;
  }

  function read(deviceId) {
    return { snapshot: displayFor(deviceId).snapshot };
  }

  function publish(input) {
    const { deviceId, sessionId, state } = input;
    const display = displayFor(deviceId);
    if (!states.includes(state)) throw new HttpError(422, 'Choose a customer display state.');
    const pinned = orders.session(sessionId);
    const { session } = pinned;
    if (session.deviceId !== deviceId) throw new HttpError(403, 'This sale belongs to another register.');
    const { sequence } = store.get('SELECT rowid AS sequence FROM session WHERE id = ?', sessionId);
    const previous = display.snapshot;
    if (previous && display.sequence > sequence) return { snapshot: previous };
    let snapshot = null;
    if (state === 'idle') {
      if (display.sequence > sequence) return { snapshot: previous };
      display.closedThrough = Math.max(display.closedThrough, sequence);
    } else if (session.orderId) {
      // A saved receipt cannot reclaim a cleared display. An unpaid parked draft can resume
      // and then publish its new receipt normally while it owns the screen.
      if (sequence <= display.closedThrough && sequence !== display.sequence) return { snapshot: previous };
      const order = orders.get(session.orderId, sessionId);
      if (!order.refund) snapshot = receiptSnapshot(order);
    } else if (state === 'complete') {
      throw new HttpError(409, 'A completed display requires a recorded order.');
    } else {
      snapshot = ticketSnapshot(input, pinned, orders);
    }
    if (snapshot) display.closedThrough = Math.max(display.closedThrough, sequence - 1);
    display.sequence = snapshot ? sequence : null;
    display.orderId = snapshot ? session.orderId : null;
    display.snapshot = snapshot;
    display.expiresAt = clock() + counterTtlMs;
    displays.set(deviceId, display);
    if (JSON.stringify(previous) !== JSON.stringify(snapshot)) notify('counter');
    return { snapshot };
  }

  function revoke(order) {
    const display = displays.get(order.deviceId);
    if (display?.orderId !== order.id) return;
    display.closedThrough = Math.max(display.closedThrough, display.sequence);
    display.sequence = display.orderId = display.snapshot = null;
    notify('counter');
  }

  return { read, publish, revoke };
}
