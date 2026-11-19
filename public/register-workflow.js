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

  function customerDisplay(readSnapshot) {
    let channel = null;
    let terminal = "";
    let previous = "";
    const laboratory = new URLSearchParams(location.search).get("lab") === "1";
    function publish(force = false) {
      if (!channel) return;
      const snapshot = { type: "snapshot", ...readSnapshot() };
      const serialized = JSON.stringify(snapshot);
      if (!force && previous === serialized) return;
      previous = serialized;
      channel.postMessage(snapshot);
    }
    function start(deviceId) {
      if (laboratory || typeof BroadcastChannel !== "function" || terminal === deviceId) return;
      if (channel) {
        channel.postMessage({ type: "snapshot", state: "idle", version: null, fulfillment: "here", items: [],
          subtotalCents: 0, discountCents: 0, taxCents: 0, tipCents: 0, totalCents: 0, orderNumber: null, pickup: null });
        channel.close();
      }
      terminal = deviceId;
      channel = new BroadcastChannel("fold-counter-" + terminal);
      channel.addEventListener("message", ({ data }) => {
        if (data?.type === "request") publish(true);
      });
      publish(true);
    }
    return { start, publish };
  }

  return { adjustments, presets, parked, replaceParked, keys, replaceKeys, lockParked, customerDisplay };
})();
