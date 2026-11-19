"use strict";

const FoldRegisterWorkflow = (() => {
  const presets = [
    { id: "none", label: "No discount" },
    { id: "staff-10", label: "Staff · 10% off" },
    { id: "service-15", label: "Service recovery · 15% off" }
  ];
  const initialKeys = ["flat-white", "iced-matcha", "almond-croissant", "pain-au-chocolat"];
  const adjustments = (draft) => ({
    note: typeof draft?.note === "string" ? draft.note.slice(0, 240) : "",
    discount: presets.some((preset) => preset.id === draft?.discount) ? draft.discount : "none",
    tipCents: Number.isInteger(draft?.tipCents) && draft.tipCents >= 0 && draft.tipCents <= 5000 ? draft.tipCents : 0
  });

  function read(key) {
    try { return JSON.parse(localStorage.getItem(key)); }
    catch { return null; }
  }

  function write(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  const parkKey = (deviceId) => "fold-register:parked:" + deviceId;
  const favoriteKey = (deviceId) => "fold-register:quick-keys:" + deviceId;
  function parked(deviceId) {
    const tickets = read(parkKey(deviceId));
    return Array.isArray(tickets) ? tickets.filter((ticket) => ticket && typeof ticket.sessionId === "string" &&
      Array.isArray(ticket.sale) && Number.isFinite(ticket.time)) : [];
  }
  const replaceParked = (deviceId, tickets) => write(parkKey(deviceId), tickets);
  function keys(deviceId) {
    const saved = read(favoriteKey(deviceId));
    return Array.isArray(saved) && saved.length === 4 ? saved.map((id) => typeof id === "string" ? id : "") : initialKeys.slice();
  }
  const replaceKeys = (deviceId, favorites) => write(favoriteKey(deviceId), favorites);
  const lockParked = (deviceId, action) => navigator.locks
    ? navigator.locks.request(parkKey(deviceId), action)
    : action();

  function customerDisplay(readSnapshot, readSession) {
    let terminal = "";
    let session = "";
    let previous = "";
    const waiting = new Map();
    const sending = new Set();
    const laboratory = new URLSearchParams(location.search).get("lab") === "1";

    async function flush(id) {
      if (sending.has(id) || !navigator.onLine) return;
      sending.add(id);
      try {
        while (navigator.onLine && waiting.has(id)) {
          const queue = waiting.get(id);
          const snapshot = queue.shift();
          if (!queue.length) waiting.delete(id);
          try { await Fold.api("/api/counter", snapshot, { signal: AbortSignal.timeout(4200) }); }
          catch { /* The next heartbeat carries the current state. */ }
        }
      } finally {
        sending.delete(id);
      }
    }

    function relay(id, pin, snapshot) {
      if (!id || !pin || !navigator.onLine) return;
      const packet = { ...snapshot, deviceId: id, sessionId: pin };
      const queue = waiting.get(id) || [];
      const prior = queue.at(-1);
      const isClaim = prior?.state === "idle" && prior.sessionId !== pin;
      const needsClaim = snapshot.state === "complete" && prior?.sessionId === pin &&
        (prior.state === "ticket" || prior.state === "payment");
      if (snapshot.state === "idle") waiting.set(id, [packet]);
      else if (!prior || isClaim || needsClaim) {
        queue.push(packet);
        waiting.set(id, queue);
      } else {
        queue[queue.length - 1] = packet;
      }
      void flush(id);
    }

    function publish(force = false) {
      if (laboratory || !terminal) return;
      const snapshot = { type: "snapshot", ...readSnapshot() };
      const verified = readSession();
      if (verified) session = verified;
      const serialized = JSON.stringify([verified, snapshot]);
      if (!force && previous === serialized) return;
      previous = serialized;
      relay(terminal, verified || (snapshot.state === "idle" ? session : ""), snapshot);
    }
    function start(deviceId) {
      if (laboratory || terminal === deviceId) return;
      const cleared = { type: "snapshot", state: "idle" };
      relay(terminal, session, cleared);
      terminal = deviceId;
      session = previous = "";
      publish(true);
    }
    return { start, publish };
  }

  return { adjustments, presets, parked, replaceParked, keys, replaceKeys, lockParked, customerDisplay };
})();
