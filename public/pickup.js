"use strict";

(() => {
  const { api, escape, showNotice } = Fold;
  const select = document.getElementById("pickup-store");
  const locationHeading = document.getElementById("pickup-location");
  const notice = document.getElementById("pickup-notice");
  const status = document.getElementById("pickup-status");
  const preparing = document.getElementById("pickup-preparing");
  const ready = document.getElementById("pickup-ready");
  const stores = new Map(Array.from(select.options, (option) => [option.value, option.textContent]));
  const requestedStore = new URLSearchParams(location.search).get("store");
  let store = stores.has(requestedStore) ? requestedStore : "market";
  let requestId = 0;
  let rendered = null;

  function renderColumn(element, numbers, empty) {
    element.setAttribute("aria-busy", "false");
    const content = numbers.length
      ? "<ul class=\"pickup-numbers\">" + numbers.map((number) => "<li>" + escape(number) + "</li>").join("") + "</ul>"
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
      renderColumn(preparing, currentOrders, "No orders being prepared.");
      renderColumn(ready, readyOrders, "No orders ready for pickup.");
      status.textContent = stores.get(store) + ". " + currentOrders.length + " preparing. " + readyOrders.length + " ready for pickup.";
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
    if (!document.hidden) refresh();
  });
  setInterval(refresh, 10000);
})();
