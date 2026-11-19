"use strict";

(() => {
  const { api, escape, showNotice } = Fold;
  const byId = (id) => document.getElementById(id);
  const board = byId("kitchen-board");
  const storeControl = byId("kds-store");
  const stationControl = byId("kds-station");
  const overdueControl = byId("kds-overdue");
  const connection = byId("kds-connection");
  const stations = { drinks: "Drinks", bakes: "Patisserie", food: "Kitchen" };
  const laneLabels = { received: "New", preparing: "Preparing", ready: "Ready" };
  const nextState = { received: "preparing", preparing: "ready", ready: "completed" };
  const actions = { received: "Start preparing", preparing: "Mark ready", ready: "Hand off" };
  const lateAfter = 8 * 60_000;
  const categories = new Map();
  const busy = new Set();
  const params = new URLSearchParams(location.search);
  let store = params.get("store") || "all";
  let station = Object.hasOwn(stations, params.get("station")) ? params.get("station") : "all";
  let overdueOnly = params.get("late") === "1";
  let orders = [];
  let selected = "";
  let request = 0;
  let healthy = false;
  let enoughToRender = false;
  let overdueState = "";
  let showingConnectionError = false;
  let metadataReady = false;
  let metadataRequest;

  function stationOf(line) {
    const category = line.categoryId || categories.get(line.itemId);
    if (category === "patisserie" || line.itemId === "pear-frangipane") return "bakes";
    if (category === "kitchen") return "food";
    return category || line.itemId === "maple-cloud-latte" ? "drinks" : "food";
  }

  function elapsed(value, current) {
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(0, current - date) : 0;
  }

  function ageLabel(milliseconds) {
    const seconds = Math.floor(milliseconds / 1000);
    return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
  }

  function isLate(order, current) {
    return order.status !== "ready" && elapsed(order.createdAt, current) >= lateAfter;
  }

  function matches(order) {
    return !order.refund && Object.hasOwn(laneLabels, order.status) &&
      (store === "all" || order.storeId === store) &&
      (station === "all" || order.items.some((line) => stationOf(line) === station));
  }

  function lineMarkup(line) {
    const lineStation = stationOf(line);
    const modifiers = (line.modifiers || []).map((option) => option.name).join(" · ");
    return `<li class="kds-line" data-station-match="${station === lineStation}"><span class="kds-qty">${line.quantity}×</span><div>
      <span class="kds-item">${escape(line.name)}</span>
      ${modifiers ? `<span class="kds-options">${escape(modifiers)}</span>` : ""}
      <small class="kds-item-station">${stations[lineStation]}</small></div></li>`;
  }

  function ticket(order, current) {
    const overdue = isLate(order, current);
    const start = order.status === "ready" ? order.updatedAt : order.createdAt;
    const quantity = order.items.reduce((sum, line) => sum + line.quantity, 0);
    const mixed = new Set(order.items.map(stationOf)).size > 1;
    const action = station !== "all" && mixed ? actions[order.status] + " · whole ticket" : actions[order.status];
    return `<article class="kds-ticket" data-ticket="${escape(order.id)}" data-overdue="${overdue}" data-current="${selected === order.id}" aria-label="Order ${escape(order.number)}">
      <div class="kds-card-head"><div><h3 class="kds-number">${escape(order.number)}</h3><p class="kds-meta">${escape(order.storeName)} · ${order.fulfillment === "to-go" ? "To go" : "For here"}</p></div>
      <div class="kds-age"><span>${overdue ? "Overdue " : order.status === "ready" ? "Ready " : "Age "}</span><time data-start="${escape(start)}">${ageLabel(elapsed(start, current))}</time></div></div>
      ${order.note ? `<p class="kds-note"><strong>Ticket note</strong> ${escape(order.note)}</p>` : ""}
      <ul class="kds-lines">${order.items.map(lineMarkup).join("")}</ul>
      <div class="kds-card-foot"><span>${quantity} ${quantity === 1 ? "item" : "items"}</span><button type="button" class="button primary" data-bump="${escape(order.id)}"
      aria-label="${escape(action)} for ${escape(order.number)}" ${!healthy || busy.has(order.id) ? "disabled" : ""}>${busy.has(order.id) ? "Updating…" : action}</button></div>
      </article>`;
  }

  function render({ focus = false } = {}) {
    if (!enoughToRender) return;
    const current = Date.now();
    const visible = orders.filter(matches).toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const overdue = visible.filter((order) => isLate(order, current));
    const filtered = overdueOnly ? overdue : visible;
    const priorScroll = [...board.querySelectorAll(".kds-scroll")].map((lane) => lane.scrollTop);
    const ownedFocus = board.contains(document.activeElement);
    if (!filtered.some((order) => order.id === selected)) selected = filtered[0]?.id || "";
    overdueState = overdue.map((order) => order.id).sort().join();
    byId("kds-summary").textContent = `${visible.length} active · ${overdue.length} overdue (8+ min)`;
    board.innerHTML = Object.entries(laneLabels).map(([status, label]) => {
      const lane = filtered.filter((order) => order.status === status);
      return `<section class="kds-lane" data-lane="${status}" aria-labelledby="lane-${status}">
        <h2 id="lane-${status}">${label} <span>${lane.length}</span></h2><div class="kds-scroll">
        ${lane.length ? lane.map((order) => ticket(order, current)).join("") : '<p class="kds-empty">No tickets</p>'}</div></section>`;
    }).join("");
    board.setAttribute("aria-busy", "false");
    [...board.querySelectorAll(".kds-scroll")].forEach((lane, index) => { lane.scrollTop = priorScroll[index] || 0; });
    if (focus || ownedFocus) focusSelected();
  }

  function focusSelected() {
    const button = [...board.querySelectorAll("[data-bump]")].find((entry) => entry.dataset.bump === selected);
    if (button && !button.disabled) button.focus();
    else if (!selected) overdueControl.focus();
  }

  function select(id) {
    selected = id;
    board.querySelectorAll("[data-ticket]").forEach((card) => {
      card.dataset.current = String(card.dataset.ticket === id);
    });
  }

  function markConnection(value) {
    healthy = value;
    connection.textContent = value ? (metadataReady ? "Live" : "Loading stations") : "Offline";
    connection.classList.toggle("online", value);
    connection.classList.toggle("offline", !value);
  }

  async function refresh() {
    const id = ++request;
    try {
      const result = await api("/api/orders");
      if (id !== request) return;
      const changed = JSON.stringify(orders) !== JSON.stringify(result.orders) || !healthy || !enoughToRender;
      orders = result.orders;
      enoughToRender = true;
      markConnection(true);
      if (showingConnectionError) showNotice(byId("kds-notice"), "");
      showingConnectionError = false;
      if (changed) render();
    } catch (error) {
      if (id !== request) return;
      markConnection(false);
      enoughToRender = true;
      showingConnectionError = true;
      showNotice(byId("kds-notice"), error.message, "error");
      render();
    }
  }

  async function bump(id) {
    const order = orders.find((entry) => entry.id === id);
    if (!order || order.refund || !healthy || busy.has(id) || !nextState[order.status]) return;
    const destination = nextState[order.status];
    const keepKeyboardFocus = board.contains(document.activeElement);
    select(id);
    busy.add(id);
    showNotice(byId("kds-notice"), "");
    render();
    try {
      const { order: updated } = await api("/api/orders/" + encodeURIComponent(id) + "/status", { status: destination });
      orders = orders.map((entry) => entry.id === id ? updated : entry);
      byId("kds-live").textContent = `Order ${updated.number} ${destination === "completed" ? "handed off" : laneLabels[destination].toLowerCase()}.`;
    } catch (error) {
      showNotice(byId("kds-notice"), error.message, "error");
    } finally {
      busy.delete(id);
      render({ focus: keepKeyboardFocus && document.activeElement === document.body });
      refresh();
    }
  }

  function saveFilters() {
    const url = new URL(location.href);
    for (const [name, value] of [["store", store], ["station", station], ["late", overdueOnly ? "1" : ""]]) {
      if (value && value !== "all") url.searchParams.set(name, value);
      else url.searchParams.delete(name);
    }
    history.replaceState(null, "", url);
    render();
  }

  storeControl.addEventListener("change", () => { store = storeControl.value; saveFilters(); });
  stationControl.addEventListener("change", () => { station = stationControl.value; saveFilters(); });
  overdueControl.addEventListener("click", () => {
    overdueOnly = !overdueOnly;
    overdueControl.setAttribute("aria-pressed", String(overdueOnly));
    saveFilters();
  });
  board.addEventListener("click", (event) => {
    const button = event.target.closest("[data-bump]");
    if (button) bump(button.dataset.bump);
  });
  board.addEventListener("focusin", (event) => {
    if (event.target.dataset.bump) select(event.target.dataset.bump);
  });
  document.addEventListener("keydown", (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.repeat || event.target.closest("input, select, textarea")) return;
    const keys = ["ArrowLeft", "ArrowRight", "b", "B"];
    if (!keys.includes(event.key)) return;
    const buttons = [...board.querySelectorAll("[data-bump]:not(:disabled)")];
    if (!buttons.length) return;
    const index = buttons.findIndex((button) => button.dataset.bump === selected);
    event.preventDefault();
    if (event.key.toLowerCase() === "b") return bump(buttons[Math.max(index, 0)].dataset.bump);
    const step = event.key === "ArrowRight" ? 1 : -1;
    const next = index < 0 ? (step > 0 ? 0 : buttons.length - 1) : (index + step + buttons.length) % buttons.length;
    buttons[next].focus();
  });

  async function fetchMetadata() {
    try {
      const { devices, releases } = await api("/api/devices");
      const stores = new Map(devices.map((device) => [device.storeId, device.storeName]));
      const menus = await Promise.all(releases.map((release) => api("/api/releases/" + release.version)));
      for (const { menu } of menus) {
        for (const item of menu.items) categories.set(item.id, item.categoryId);
      }
      storeControl.replaceChildren(new Option("All stores", "all"), ...[...stores].map(([id, name]) => new Option(name, id)));
      if (store !== "all" && !stores.has(store)) store = "all";
      storeControl.value = store;
      storeControl.disabled = stationControl.disabled = false;
      metadataReady = true;
      markConnection(healthy);
      render();
    } catch { /* The next order refresh also retries metadata. */ }
  }

  function synchronize() {
    if (!metadataReady && !metadataRequest) {
      metadataRequest = fetchMetadata().finally(() => { metadataRequest = null; });
    }
    return refresh();
  }

  function initialize() {
    storeControl.disabled = stationControl.disabled = true;
    stationControl.value = station;
    overdueControl.setAttribute("aria-pressed", String(overdueOnly));
    synchronize();
    if ("EventSource" in window) {
      const stream = new EventSource("/api/events");
      stream.addEventListener("open", synchronize);
      stream.addEventListener("message", (event) => {
        try { if (JSON.parse(event.data).type === "orders") synchronize(); }
        catch { /* Ignore events from other protocol versions. */ }
      });
    }
    setInterval(synchronize, 8000);
    setInterval(() => {
      const current = Date.now();
      const late = orders.filter((order) => matches(order) && isLate(order, current)).map((order) => order.id).sort().join();
      if (late !== overdueState) render();
      else board.querySelectorAll("time[data-start]").forEach((clock) => {
        clock.textContent = ageLabel(elapsed(clock.dataset.start, current));
      });
    }, 1000);
  }

  initialize();
})();
