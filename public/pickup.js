"use strict";

(() => {
  const { api, escape, showNotice } = Fold;
  const select = document.getElementById("pickup-store");
  const locationHeading = document.getElementById("pickup-location");
  const notice = document.getElementById("pickup-notice");
  const status = document.getElementById("pickup-status");
  const preparing = document.getElementById("pickup-preparing");
  const ready = document.getElementById("pickup-ready");
  const fullScreen = document.getElementById("pickup-fullscreen");
  const awake = document.getElementById("pickup-awake");
  const displayStatus = document.getElementById("pickup-display-status");
  const stores = new Map(Array.from(select.options, (option) => [option.value, option.textContent]));
  const requestedStore = new URLSearchParams(location.search).get("store");
  let store = stores.has(requestedStore) ? requestedStore : "market";
  let requestId = 0;
  let rendered = null;
  let previousReady = null;
  const newlyReady = new Map();
  let stayAwake = false;
  let wakeLock = null;
  let locking = false;

  function renderColumn(element, numbers, empty) {
    element.setAttribute("aria-busy", "false");
    const content = numbers.length
      ? "<ul class=\"pickup-numbers\">" + numbers.map((number) => {
        const highlight = element === ready && newlyReady.has(number) ? " data-just-ready" : "";
        return "<li" + highlight + ">" + escape(number) + "</li>";
      }).join("") + "</ul>"
      : "<p class=\"pickup-empty\">" + empty + "</p>";
    if (element.innerHTML !== content) element.innerHTML = content;
  }

  async function refresh() {
    const current = ++requestId;
    try {
      const result = await api("/api/pickup?store=" + encodeURIComponent(store));
      if (current !== requestId) return;
      if (result.storeId !== store || !Array.isArray(result.orders)) {
        throw new Error("Pickup data is unavailable.");
      }
      const currentOrders = [];
      const readyOrders = [];
      result.orders.forEach(({ number, status: state }) => {
        if (state === "received" || state === "preparing") currentOrders.push(number);
        if (state === "ready") readyOrders.push(number);
      });
      const signature = JSON.stringify([store, currentOrders, readyOrders]);
      showNotice(notice, "");
      if (signature === rendered) return;
      const additions = previousReady === null ? [] : readyOrders.filter((number) => !previousReady.has(number));
      for (const number of additions) newlyReady.set(number, Date.now() + 60_000);
      previousReady = new Set(readyOrders);
      renderColumn(preparing, currentOrders, "No orders being prepared.");
      renderColumn(ready, readyOrders, "No orders ready for pickup.");
      status.textContent = additions.length
        ? "Ready for pickup: " + additions.join(", ") + "."
        : stores.get(store) + ". " + currentOrders.length + " preparing. " + readyOrders.length + " ready for pickup.";
      rendered = signature;
    } catch {
      if (current !== requestId) return;
      if (!rendered) {
        renderColumn(preparing, [], "Pickup numbers unavailable.");
        renderColumn(ready, [], "Pickup numbers unavailable.");
      }
      const description = rendered
        ? "Reconnecting to pickup. The numbers shown may have changed."
        : "Reconnecting to pickup. Order numbers will appear when the display is back online.";
      showNotice(notice, description, "error");
    }
  }

  function selectStore() {
    select.value = store;
    locationHeading.textContent = stores.get(store).toUpperCase();
    rendered = null;
    previousReady = null;
    newlyReady.clear();
    [preparing, ready].forEach((element) => {
      element.setAttribute("aria-busy", "true");
      element.innerHTML = '<p class="pickup-empty">Loading pickup numbers…</p>';
    });
    showNotice(notice, "");
    refresh();
  }

  select.addEventListener("change", () => {
    if (!stores.has(select.value) || select.value === store) return;
    store = select.value;
    const url = new URL(location.href);
    url.searchParams.set("store", store);
    history.replaceState(null, "", url);
    selectStore();
  });

  function setDisplayStatus(message) {
    displayStatus.hidden = !message;
    displayStatus.textContent = message;
  }

  if (document.fullscreenEnabled) {
    fullScreen.hidden = false;
    fullScreen.addEventListener("click", async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await document.body.requestFullscreen();
        setDisplayStatus("");
      } catch {
        setDisplayStatus("Full screen is unavailable in this window.");
      }
    });
    document.addEventListener("fullscreenchange", () => {
      const enabled = Boolean(document.fullscreenElement);
      fullScreen.setAttribute("aria-pressed", String(enabled));
      fullScreen.textContent = enabled ? "Exit full screen" : "Full screen";
    });
  }

  async function acquireWakeLock() {
    if (!stayAwake || document.hidden || locking || wakeLock) return;
    locking = true;
    try {
      const lock = await navigator.wakeLock.request("screen");
      if (!stayAwake) { await lock.release(); return; }
      wakeLock = lock;
      setDisplayStatus("Screen will stay awake while this display is visible.");
      lock.addEventListener("release", () => {
        if (wakeLock === lock) wakeLock = null;
        if (stayAwake) setDisplayStatus("Screen wake lock paused.");
      });
    } catch {
      stayAwake = false;
      awake.setAttribute("aria-pressed", "false");
      setDisplayStatus("This device cannot keep the screen awake.");
    } finally {
      locking = false;
    }
  }

  if ("wakeLock" in navigator) {
    awake.hidden = false;
    awake.addEventListener("click", async () => {
      stayAwake = !stayAwake;
      awake.setAttribute("aria-pressed", String(stayAwake));
      if (stayAwake) await acquireWakeLock();
      else {
        await wakeLock?.release();
        wakeLock = null;
        setDisplayStatus("");
      }
    });
  }

  selectStore();
  if ("EventSource" in window) {
    const events = new EventSource("/api/events");
    events.addEventListener("open", refresh);
    events.addEventListener("message", (event) => {
      try {
        if (JSON.parse(event.data).type === "orders") refresh();
      } catch { /* Ignore events from other protocol versions. */ }
    });
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      refresh();
      acquireWakeLock();
    }
  });
  setInterval(refresh, 10000);
  setInterval(() => {
    const now = Date.now();
    for (const [number, deadline] of newlyReady) if (deadline <= now) newlyReady.delete(number);
    ready.querySelectorAll("[data-just-ready]").forEach((entry) => {
      if (!newlyReady.has(entry.textContent)) entry.removeAttribute("data-just-ready");
    });
  }, 1000);
})();
