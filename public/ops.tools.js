"use strict";

(() => {
  const { api, escape, money, showNotice } = Fold;
  const node = (id) => document.getElementById(id);
  const stockStore = node("stock-store");
  const stockResults = node("stock-results");
  const stockNotice = node("stock-notice");
  const reportForm = node("report-filters");
  const reportNotice = node("report-notice");
  const reportLink = node("report-download");
  let active = "";
  let catalog = [];
  let fleetPromise;
  let catalogPromise;
  let stockRequest = 0;
  let reportRequest = 0;
  let reportSearch = "";
  let stockSnapshot = null;
  const drafts = new Map();
  const writing = new Set();

  function getFleet() {
    fleetPromise ||= api("/api/devices").then((fleet) => {
      const stores = new Map(fleet.devices.map((device) => [device.storeId, device.storeName]));
      for (const [id, name] of stores) stockStore.add(new Option(name, id));
      const reportStore = node("report-store");
      reportStore.add(new Option("All stores", ""));
      for (const [id, name] of stores) reportStore.add(new Option(name, id));
      return fleet;
    }).catch((error) => { fleetPromise = null; throw error; });
    return fleetPromise;
  }

  function getCatalog() {
    catalogPromise ||= getFleet().then(async ({ releases }) => {
      const catalogItems = new Map();
      const menus = await Promise.all(releases.map((release) => api("/api/releases/" + release.version)));
      for (const { menu } of menus) {
        const categories = new Map(menu.categories.map((category) => [category.id, category.name]));
        for (const item of menu.items) catalogItems.set(item.id, { ...item, category: categories.get(item.categoryId) });
      }
      catalog = [...catalogItems.values()].sort((a, b) => a.name.localeCompare(b.name));
    }).catch((error) => { catalogPromise = null; throw error; });
    return catalogPromise;
  }

  const stockKey = (store, item) => store + "/" + item;
  const normalize = (value) => value.normalize("NFKD").toLowerCase().replace(/\p{M}/gu, "").trim();

  function renderStock() {
    if (!stockSnapshot || stockSnapshot.storeId !== stockStore.value) return;
    const term = normalize(node("stock-search").value);
    const filter = node("stock-filter").value;
    const availability = new Map(stockSnapshot.items.map((entry) => [entry.itemId, entry]));
    const entries = catalog.filter((item) => {
      const state = availability.get(item.id);
      return (!term || normalize(item.name + " " + item.category).includes(term)) &&
        (filter === "all" || (filter === "unavailable" ? state?.available === false : state?.quantity != null));
    });
    const focus = document.activeElement;
    const restoreInput = focus?.dataset?.stockInput;
    const restoreAction = focus?.dataset?.stockItem;
    const restoreKind = focus?.dataset?.stockAction;
    const markup = `<p class="stock-caption">${entries.length} of ${catalog.length} items · Leave quantity blank for unlimited stock.</p>
      ${entries.length ? `<div class="table-scroll"><table class="ops-table stock-table">
        <thead><tr><th scope="col">Item</th><th scope="col">Availability</th><th scope="col">Remaining</th><th scope="col">Actions</th></tr></thead>
        <tbody>${entries.map((item) => {
          const state = availability.get(item.id);
          const available = state?.available !== false;
          const count = state?.quantity;
          const key = stockKey(stockSnapshot.storeId, item.id);
          const draft = drafts.get(key) ?? count ?? "";
          const disabled = writing.has(key) ? "disabled" : "";
          return `<tr>
            <td><strong>${escape(item.name)}</strong><small>${escape(item.category)}</small></td>
            <td><span class="badge ${available ? "good" : "warn"}">${available ? "Available" : state?.manualBlock ? "Unavailable" : "Sold out"}</span></td>
            <td><div class="stock-limit"><input type="number" min="0" max="999" inputmode="numeric" step="1" value="${escape(draft)}" data-stock-input="${escape(item.id)}" aria-label="Quantity for ${escape(item.name)}" placeholder="Unlimited" ${disabled}>
              <small>${count == null ? "Unlimited" : count + " left"}</small></div></td>
            <td><div class="table-actions">
              <button class="button" type="button" data-stock-action="quantity" data-stock-item="${escape(item.id)}" ${disabled}>Save quantity</button>
              <button class="button" type="button" data-stock-action="toggle" data-stock-item="${escape(item.id)}" ${disabled}>${available ? "Mark unavailable" : count === 0 ? "Restore unlimited" : "Mark available"}</button>
            </div></td></tr>`;
        }).join("")}</tbody></table></div>` : '<p class="empty-state">No items match these filters.</p>'}`;
    if (stockResults.dataset.markup === markup) return;
    const scrollLeft = stockResults.querySelector(".table-scroll")?.scrollLeft || 0;
    stockResults.innerHTML = markup;
    stockResults.dataset.markup = markup;
    const table = stockResults.querySelector(".table-scroll");
    if (table) table.scrollLeft = scrollLeft;
    if (restoreInput) {
      [...stockResults.querySelectorAll("[data-stock-input]")].find((input) => input.dataset.stockInput === restoreInput)?.focus({ preventScroll: true });
    } else if (restoreAction) {
      [...stockResults.querySelectorAll("[data-stock-item]")].find((button) =>
        button.dataset.stockItem === restoreAction && button.dataset.stockAction === restoreKind)?.focus({ preventScroll: true });
    }
  }

  async function readStock() {
    const request = ++stockRequest;
    try {
      await getCatalog();
      const result = await api("/api/availability?storeId=" + encodeURIComponent(stockStore.value));
      if (request !== stockRequest) return;
      stockSnapshot = result;
      if (stockNotice.dataset.failed === "true") showNotice(stockNotice, "");
      stockNotice.dataset.failed = "false";
      renderStock();
    } catch (error) {
      if (request !== stockRequest) return;
      stockNotice.dataset.failed = "true";
      showNotice(stockNotice, error.message, "error");
      if (!stockSnapshot) {
        stockResults.innerHTML = '<button class="button" type="button" id="stock-retry">Retry availability</button>';
      }
    }
  }

  async function writeStock(itemId, action) {
    const targetStore = stockStore.value;
    const key = stockKey(targetStore, itemId);
    if (writing.has(key) || stockSnapshot?.storeId !== targetStore) return;
    const state = stockSnapshot.items.find((entry) => entry.itemId === itemId);
    const input = [...stockResults.querySelectorAll("[data-stock-input]")].find((entry) => entry.dataset.stockInput === itemId);
    let quantity = state?.quantity ?? null;
    let available = state?.available !== false;
    if (action === "quantity") {
      if (!input.reportValidity()) return;
      quantity = input.value === "" ? null : Number(input.value);
      available = !state?.manualBlock;
    } else {
      available = !available;
      if (available && quantity === 0) quantity = null;
    }
    writing.add(key);
    showNotice(stockNotice, "");
    renderStock();
    try {
      await api("/api/availability", { storeId: targetStore, itemId, available, quantity });
      drafts.delete(key);
      if (targetStore === stockStore.value) {
        showNotice(stockNotice, "Availability updated.", "success");
        await readStock();
      }
    } catch (error) {
      if (targetStore === stockStore.value) showNotice(stockNotice, error.message, "error");
    } finally {
      writing.delete(key);
      renderStock();
    }
  }

  const summaries = [
    ["Orders", "orderCount", String],
    ["Gross sales", "grossCents", money],
    ["Discounts", "discountCents", money],
    ["Tax", "taxCents", money],
    ["Tips", "tipCents", money],
    ["Charged", "chargedCents", money],
    ["Refunds", "refundCents", money],
    ["Net collected", "netCents", money],
  ];

  function breakdown(title, unit, rows, name) {
    return `<section class="report-group"><h3>${title}</h3>${rows.length ? `<div class="table-scroll">
      <table class="ops-table"><thead><tr><th scope="col">${unit}</th><th scope="col">Orders</th><th scope="col">Charged</th>
      <th scope="col">Refunds</th><th scope="col">Net collected</th></tr></thead><tbody>
      ${rows.map((row) => `<tr><th scope="row">${escape(row[name])}</th><td>${row.orderCount}</td><td>${money(row.chargedCents)}</td>
        <td>${money(row.refundCents)} <small>(${row.refundCount})</small></td><td>${money(row.netCents)}</td></tr>`).join("")}</tbody></table>
      </div>` : '<p class="empty-state">No sales or refunds in this period.</p>'}</section>`;
  }

  async function readReport() {
    const request = ++reportRequest;
    try {
      await getFleet();
      const report = await api("/api/reports/sales" + reportSearch);
      if (request !== reportRequest) return;
      showNotice(reportNotice, "");
      node("report-results").innerHTML = `
        <div class="report-summary" aria-label="Sales totals">
          ${summaries.map(([name, key, format]) => `<div><small>${name}</small><strong>${format(report.totals[key])}</strong></div>`).join("")}
        </div>
        ${breakdown("By store", "Store", report.stores, "storeName")}
        ${breakdown("By day (UTC)", "Date", report.days, "date")}`;
      reportLink.href = "/api/reports/sales.csv" + reportSearch;
      reportLink.hidden = false;
    } catch (error) {
      if (request !== reportRequest) return;
      showNotice(reportNotice, error.message, "error");
      reportLink.hidden = true;
    }
  }

  document.addEventListener("fold-ops-tab", ({ detail }) => {
    active = detail;
    if (active === "stock") readStock();
    if (active === "reports") readReport();
  });
  stockStore.addEventListener("change", () => {
    stockResults.innerHTML = '<p class="loading">Loading availability…</p>';
    stockResults.dataset.markup = "";
    showNotice(stockNotice, "");
    readStock();
  });
  node("stock-search").addEventListener("input", renderStock);
  node("stock-filter").addEventListener("change", renderStock);
  stockResults.addEventListener("input", (event) => {
    const input = event.target;
    if (input.dataset.stockInput) drafts.set(stockKey(stockStore.value, input.dataset.stockInput), input.value);
  });
  stockResults.addEventListener("keydown", (event) => {
    const item = event.target.dataset.stockInput;
    if (event.key === "Enter" && item) writeStock(item, "quantity");
  });
  stockResults.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.id === "stock-retry") readStock();
    if (button.dataset.stockItem) writeStock(button.dataset.stockItem, button.dataset.stockAction);
  });
  reportForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const search = new URLSearchParams();
    const store = node("report-store").value;
    if (store) search.set("storeId", store);
    for (const name of ["from", "to"]) {
      const value = reportForm.elements[name].value;
      if (value) search.set(name, value);
    }
    if (search.has("from") && search.has("to") && search.get("from") > search.get("to")) {
      showNotice(reportNotice, "From date must come before or match the through date.", "error");
      return;
    }
    reportSearch = search.size ? "?" + search : "";
    reportLink.hidden = true;
    readReport();
  });
  document.addEventListener("fold-ops-update", ({ detail }) => {
    if (active === "stock" && detail === "inventory") readStock();
    if (active === "reports" && detail === "orders") readReport();
  });
  setInterval(() => {
    if (active === "stock") readStock();
    if (active === "reports") readReport();
  }, 20000);
})();
