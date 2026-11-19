"use strict";

(() => {
  const { api, escape, icon, money, showNotice } = Fold;
  const node = (id) => document.getElementById(id);
  const dialog = node("ops-dialog");
  const connection = node("connection");
  const notice = node("ops-notice");
  const timestamp = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });
  const timeShort = new Intl.DateTimeFormat("en-US", { timeStyle: "short" });
  const labels = {
    all: "All devices", stable: "Stable", beta: "Beta",
    live: "Acknowledged", pending: "Awaiting ACK", offline: "Offline", rejected: "Rejected",
    received: "Received", preparing: "Preparing", ready: "Ready", completed: "Completed", refunded: "Refunded"
  };
  const advance = { received: ["preparing", "Start preparing"], preparing: ["ready", "Mark ready"], ready: ["completed", "Complete order"] };
  const tabs = new Set(["rollout", "devices", "orders", "stock", "reports"]);
  let active = tabs.has(location.hash.slice(1)) ? location.hash.slice(1) : "rollout";
  let fleet = null;
  let orders = [];
  let ordersLoaded = false;
  let orderFilter = "active";
  let locationFilter = "all";
  let validating = false;
  let pending = false;
  let previewRequest = 0;
  let fleetRequest = 0;
  let orderRequest = 0;
  let dialogTrigger = null;
  const refundAttempts = new Map();
  const draft = { version: "2", channel: "beta", percentage: 100, deviceId: "" };

  const label = (id) => labels[id] || String(id || "Unknown");
  const versions = (version) => version ? "v" + version : "—";
  const time = (value, format = timestamp) => {
    const date = new Date(value);
    return value && !Number.isNaN(date.getTime()) ? format.format(date) : "—";
  };
  const badge = (text, tone = "") => `<span class="badge ${tone}">${escape(text)}</span>`;
  const closeButton = () => `<button type="button" class="icon-button dialog-close" data-close aria-label="Close">${icon("close")}</button>`;
  const title = (text) => `<h2 id="ops-dialog-title">${escape(text)}</h2>`;
  const option = (value, text, selected) =>
    `<option value="${escape(value)}" ${String(value) === String(selected) ? "selected" : ""}>${escape(text)}</option>`;

  function recordConnection(online) {
    connection.textContent = online ? "API connected" : "API unavailable";
    connection.classList.toggle("online", online);
    connection.classList.toggle("offline", !online);
  }

  function renderActive(force = false) {
    if (active === "rollout" && fleet) {
      if (!force && (dialog.open || node("rollout-form")?.contains(document.activeElement))) {
        renderRolloutMetrics();
        renderAudit();
      } else {
        renderRollout();
      }
    }
    if (active === "devices" && fleet) renderDevices();
    if (active === "orders" && ordersLoaded) renderOrders();
  }

  async function refreshFleet() {
    const request = ++fleetRequest;
    try {
      const data = await api("/api/devices");
      if (request !== fleetRequest) return;
      fleet = data;
      recordConnection(true);
      renderActive();
    } catch (error) {
      if (request !== fleetRequest) return;
      recordConnection(false);
      if (!fleet && active !== "orders") {
        node(active).innerHTML = `<div class="empty-state"><strong>Couldn’t load the fleet</strong><p>${escape(error.message)}</p><button class="button" type="button" data-refresh>Try again</button></div>`;
      }
    }
  }

  async function refreshOrders() {
    const request = ++orderRequest;
    try {
      const data = await api("/api/orders");
      if (request !== orderRequest) return;
      orders = data.orders || [];
      ordersLoaded = true;
      recordConnection(true);
      if (active === "orders") renderOrders();
    } catch (error) {
      if (request !== orderRequest) return;
      recordConnection(false);
      if (active === "orders" && !ordersLoaded) {
        node("orders").innerHTML = `<div class="empty-state"><strong>Couldn’t load orders</strong><p>${escape(error.message)}</p><button class="button" type="button" data-refresh>Try again</button></div>`;
      }
    }
  }

  function setTab(tab, setUrl = true) {
    if (!tabs.has(tab)) return;
    active = tab;
    if (setUrl) history.replaceState(null, "", "#" + tab);
    document.querySelectorAll("[data-tab]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.tab === active));
      button.classList.toggle("is-active", button.dataset.tab === active);
    });
    tabs.forEach((name) => { node(name).hidden = name !== active; });
    renderActive(true);
    document.dispatchEvent(new CustomEvent("fold-ops-tab", { detail: active }));
    if (active === "orders") {
      if (!ordersLoaded) node("orders").innerHTML = '<p class="loading">Loading the order queue…</p>';
      refreshOrders();
    } else if (!fleet && ["rollout", "devices"].includes(active)) {
      node(active).innerHTML = '<p class="loading">Loading the kiosk fleet…</p>';
    }
  }

  function metric(name, value, helper, glyph) {
    return `<article class="panel metric"><p class="eyebrow muted"><span class="summary-icon">${icon(glyph)}</span> ${escape(name)}</p><strong>${escape(value)}</strong><small>${escape(helper)}</small></article>`;
  }

  function renderRolloutMetrics() {
    const nodeMetrics = node("rollout-metrics");
    if (!nodeMetrics) return;
    const ready = fleet.devices.filter((device) => device.status === "live").length;
    const outOfDate = fleet.devices.filter((device) => device.status !== "live").length;
    const versionsByDevice = [...new Set(fleet.devices.map((device) => device.installedVersion).filter(Boolean))].sort();
    nodeMetrics.innerHTML = [
      metric("Installed menus", versionsByDevice.map(versions).join(" / ") || "—", "Versions acknowledged by kiosks", "layers"),
      metric("Kiosks in sync", ready + " / " + fleet.devices.length, outOfDate ? outOfDate + " awaiting or requiring attention" : "Every kiosk is up to date", "screen"),
      metric("Release verification", "Signed", "Live Layer Protocol · WebAssembly", "shield")
    ].join("");
  }

  function renderAudit() {
    const panel = node("audit-log");
    if (!panel) return;
    const audit = (fleet.audit || []).slice(0, 12);
    panel.innerHTML = !audit.length
      ? '<p class="panel-intro">Rollout and device events will appear here.</p>'
      : `<ol class="audit-list">${audit.map((entry) => `<li>
          <time datetime="${escape(entry.time)}" title="${escape(time(entry.time))}">${escape(time(entry.time, timeShort))}</time>
          <div><strong>${escape(entry.event)}</strong><p>${escape(entry.detail)}</p></div>
        </li>`).join("")}</ol>`;
  }

  function eligibleDevices() {
    return fleet.devices.filter((device) => draft.channel === "all" || device.channel === draft.channel);
  }

  function rolloutScope(rollout) {
    if (!rollout) return "No rollout published";
    const target = fleet.devices.find((device) => device.id === rollout.deviceId);
    if (target) return `${versions(rollout.version)} · ${target.storeName} · ${target.name}`;
    return `${versions(rollout.version)} · ${label(rollout.channel)} · ${rollout.percentage ?? 100}%`;
  }

  function renderRollout() {
    const selected = fleet.releases.some((release) => String(release.version) === draft.version)
      ? draft.version : String(fleet.releases[0]?.version ?? "");
    draft.version = selected;
    const current = fleet.rollout;
    const releases = fleet.releases.map((release) => `<article class="release">
      <div><div class="release-head"><h3>${escape(release.name)}</h3>${badge(versions(release.version))}</div><p>${escape(release.description)}</p></div>
      <button class="button" type="button" data-preview="${escape(release.version)}" aria-label="Preview ${escape(release.name)}">Preview</button>
    </article>`).join("");
    node("rollout").innerHTML = `
      <div class="ops-summary" id="rollout-metrics" aria-label="Fleet status"></div>
      <div class="ops-grid">
        <section class="panel">
          <h2>Publish a release</h2>
          <p class="panel-intro">Send a signed menu to a cohort or a single kiosk. Orders in progress keep the version they started with.</p>
          <form id="rollout-form">
            <div class="fields">
              <label class="field">Menu version<select class="select" name="version">${fleet.releases.map((release) => option(release.version, versions(release.version) + " · " + release.name, selected)).join("")}</select></label>
              <label class="field">Cohort<select class="select" name="channel">${["all", "stable", "beta"].map((channel) => option(channel, label(channel), draft.channel)).join("")}</select></label>
              <label class="field">Target kiosk<select class="select" name="deviceId" id="rollout-device"></select></label>
              <label class="field">Cohort coverage <span id="rollout-percent"></span><input type="range" min="0" max="100" step="5" name="percentage" value="${draft.percentage}"><small class="form-helper" id="target-summary"></small></label>
            </div>
            <div class="ops-actions">
              <button class="button primary" type="submit">Review rollout</button>
              <button class="button" type="button" data-rollback>Roll back fleet</button>
            </div>
          </form>
        </section>
        <section class="panel">
          <h2>Release library</h2>
          <p class="panel-intro">Review menu contents and pickup instructions before publishing.</p>
          <div class="release-list">${releases}</div>
          <div class="rollout-current"><h3>Last published</h3><p>${escape(rolloutScope(current))}</p>${current?.selected ? `<p>${current.selected.length} targeted ${current.selected.length === 1 ? "kiosk" : "kiosks"}</p>` : ""}</div>
        </section>
      </div>
      <section class="panel"><h2>Release activity</h2><div id="audit-log"></div></section>`;
    renderRolloutMetrics();
    renderAudit();
    updateTarget();
  }

  function updateTarget() {
    const available = eligibleDevices();
    if (!available.some((device) => device.id === draft.deviceId)) draft.deviceId = "";
    const form = node("rollout-form");
    const deviceOptions = option("", "Use cohort coverage", draft.deviceId) + available.map((device) =>
      option(device.id, device.storeName + " · " + device.name, draft.deviceId)).join("");
    const select = node("rollout-device");
    if (select.dataset.options !== deviceOptions) {
      select.innerHTML = deviceOptions;
      select.dataset.options = deviceOptions;
    }
    select.value = draft.deviceId;
    form.elements.percentage.disabled = Boolean(draft.deviceId);
    node("rollout-percent").textContent = draft.deviceId ? "" : draft.percentage + "%";
    node("target-summary").textContent = draft.deviceId ? "Only the selected kiosk receives this release."
      : available.length + (available.length === 1 ? " eligible kiosk" : " eligible kiosks") + " in this cohort.";
  }

  function renderDevices() {
    const element = node("devices");
    if (element.contains(document.activeElement)) return;
    const stores = Map.groupBy
      ? Map.groupBy(fleet.devices, (device) => device.storeName)
      : fleet.devices.reduce((groups, device) => {
        if (!groups.has(device.storeName)) groups.set(device.storeName, []);
        groups.get(device.storeName).push(device);
        return groups;
      }, new Map());
    if (!stores.size) {
      element.innerHTML = '<div class="empty-state"><strong>No kiosks registered</strong><p>Registered kiosks will appear grouped by location.</p></div>';
      return;
    }
    element.innerHTML = Array.from(stores, ([store, devices]) => `
      <section class="panel store-panel">
        <h2>${escape(store)}</h2><p class="panel-intro">${devices.length} self-checkout ${devices.length === 1 ? "kiosk" : "kiosks"}</p>
        <div class="table-scroll"><table class="ops-table"><thead><tr><th scope="col">Device</th><th scope="col">Cohort</th><th scope="col">Installed</th><th scope="col">Target</th><th scope="col">Protocol state</th><th scope="col"><span class="sr-only">Open kiosk</span></th></tr></thead>
        <tbody>${devices.map((device) => `<tr>
          <td><strong>${escape(device.name)}</strong><small>${escape(device.id)}</small></td>
          <td>${escape(label(device.channel))}</td>
          <td>${escape(versions(device.installedVersion))}<br><small>Seq. ${escape(device.wireVersion ?? "—")}</small></td>
          <td>${escape(versions(device.desiredVersion))}<br><small>Seq. ${escape(device.targetWireVersion ?? "—")}</small></td>
          <td>${badge(label(device.status), device.status === "live" ? "good" : "warn")}<br><small>${escape(device.error || (device.ackMs != null ? "ACK " + device.ackMs + " ms" : time(device.appliedAt, timeShort)))}</small></td>
          <td><a class="button" href="/?device=${encodeURIComponent(device.id)}" target="_blank" rel="noopener" aria-label="Open ${escape(store)} ${escape(device.name)} in a new tab">Open kiosk</a></td>
        </tr>`).join("")}</tbody></table></div>
      </section>`).join("");
  }

  function renderOrders() {
    const element = node("orders");
    const activeControl = document.activeElement;
    const restore = activeControl.closest?.("[data-advance], [data-order-detail]");
    const locations = [...new Set([...(fleet?.devices || []).map((device) => device.storeName), ...orders.map((order) => order.storeName)])].sort();
    const visible = orders.filter((order) => {
      const status = order.refund ? "refunded" : order.status;
      return (orderFilter === "all" || (orderFilter === "active" ? !["completed", "refunded"].includes(status) : status === orderFilter)) &&
        (locationFilter === "all" || order.storeName === locationFilter);
    });
    if (!node("order-results")) {
      element.innerHTML = `<section class="panel">
      <div class="ops-toolbar"><div><h2>Pickup queue</h2><p class="panel-intro" id="order-count"></p></div>
        <div class="fields">
          <label class="field">Status<select class="select" data-order-filter>${[["active", "Active"], ["all", "All statuses"], ["received", "Received"], ["preparing", "Preparing"], ["ready", "Ready"], ["completed", "Completed"], ["refunded", "Refunded"]].map(([id, name]) => option(id, name, orderFilter)).join("")}</select></label>
          <label class="field">Store<select class="select" data-location-filter></select></label>
        </div>
      </div><div id="order-results"></div>
      </section>`;
    }
    const locationSelect = element.querySelector("[data-location-filter]");
    const locationOptions = option("all", "All stores", locationFilter) + locations.map((store) => option(store, store, locationFilter)).join("");
    if (activeControl !== locationSelect && locationSelect.dataset.options !== locationOptions) {
      locationSelect.innerHTML = locationOptions;
      locationSelect.dataset.options = locationOptions;
    }
    node("order-count").textContent = visible.length + (visible.length === 1 ? " order" : " orders") + " in this view";
    const results = node("order-results");
    const markup = visible.length ? `<div class="table-scroll"><table class="ops-table"><thead><tr>
        <th scope="col">Order</th><th scope="col">Store</th><th scope="col">Items</th><th scope="col">Status</th><th scope="col">Total</th><th scope="col"><span class="sr-only">Order actions</span></th>
        </tr></thead><tbody>${visible.map((order) => `<tr>
          <td><strong>${escape(order.number)}</strong><small>${escape(time(order.createdAt, timeShort))}</small></td>
          <td>${escape(order.storeName)}<br><small>Menu ${escape(versions(order.version))} · ${order.fulfillment === "to-go" ? "To go" : "For here"}</small></td>
          <td>${order.items.reduce((sum, line) => sum + line.quantity, 0)}</td>
          <td>${order.refund ? badge("Refunded", "warn") : badge(label(order.status), order.status === "ready" || order.status === "completed" ? "good" : "")}</td>
          <td>${money(order.totalCents)}</td>
          <td><div class="table-actions"><button class="button" type="button" data-order-detail="${escape(order.id)}" aria-label="View order ${escape(order.number)}">Details</button>
          ${!order.refund && advance[order.status] ? `<button class="button primary" type="button" data-advance="${escape(order.id)}" ${pending ? "disabled" : ""}>${advance[order.status][1]}</button>` : ""}</div></td>
        </tr>`).join("")}</tbody></table></div>` :
      '<div class="empty-state"><strong>No orders in this view</strong><p>New kiosk orders will appear here automatically.</p></div>';
    if (results.dataset.markup === markup) return;
    results.innerHTML = markup;
    results.dataset.markup = markup;
    if (restore && element.contains(activeControl) === false) {
      const replacement = restore.hasAttribute("data-order-filter") ? element.querySelector("[data-order-filter]")
        : restore.hasAttribute("data-location-filter") ? element.querySelector("[data-location-filter]")
        : [...element.querySelectorAll("[data-advance], [data-order-detail]")].find((button) =>
          (restore.dataset.advance && button.dataset.advance === restore.dataset.advance) ||
          (restore.dataset.orderDetail && button.dataset.orderDetail === restore.dataset.orderDetail));
      replacement?.focus({ preventScroll: true });
    }
  }

  function openDialog(markup, trigger) {
    dialogTrigger = trigger;
    dialog.innerHTML = markup;
    if (!dialog.open) dialog.showModal();
  }

  async function previewRelease(version, trigger) {
    const request = ++previewRequest;
    openDialog(`${closeButton()}<div class="dialog-body">${title("Menu preview")}<p class="loading">Loading signed release…</p></div>`, trigger);
    try {
      const { menu } = await api("/api/releases/" + encodeURIComponent(version));
      if (request !== previewRequest || !dialog.open) return;
      const categories = menu.categories.map((category) => `<section class="preview-category"><h3>${escape(category.name)}</h3>
        <ul class="release-preview">${menu.items.filter((item) => item.categoryId === category.id).map((item) =>
          `<li><span>${escape(item.name)}</span><strong>${money(item.priceCents)}</strong></li>`).join("")}</ul></section>`).join("");
      dialog.innerHTML = `${closeButton()}<div class="dialog-body"><p class="eyebrow muted">MENU ${escape(versions(menu.version).toUpperCase())}</p>${title(menu.name)}
        <div class="receipt-pickup"><strong>${escape(menu.pickup?.title)}</strong><p>${escape(menu.pickup?.description)}</p></div>
        ${categories}
        <div class="dialog-actions"><button class="button" type="button" data-close>Close preview</button><button class="button primary" type="button" data-use-release="${escape(menu.version)}">Use this version</button></div>
        </div>`;
      dialog.querySelector(".dialog-close").focus();
    } catch (error) {
      if (request !== previewRequest || !dialog.open) return;
      dialog.innerHTML = `${closeButton()}<div class="dialog-body">${title("Menu preview")}<p class="notice error" role="alert">${escape(error.message)}</p></div>`;
    }
  }

  function reviewRollout(trigger, rollback = false) {
    const target = fleet.devices.find((device) => device.id === draft.deviceId);
    const release = fleet.releases.find((entry) => String(entry.version) === draft.version);
    const description = rollback ? "This restores Menu v1 across the fleet. Existing checkout sessions keep their current menus."
      : target ? `Publish Menu v${release.version} to ${target.storeName} · ${target.name}.`
      : `Publish Menu v${release.version} to ${draft.percentage}% of ${draft.channel === "all" ? "all kiosks" : "the " + label(draft.channel).toLowerCase() + " cohort"}.${draft.percentage === 0 ? " No kiosks will receive this release." : ""}`;
    openDialog(`${closeButton()}<div class="dialog-body"><p class="eyebrow muted">SIGNED MENU RELEASE</p>${title(rollback ? "Roll back the fleet?" : "Publish this rollout?")}
      <p class="dialog-description">${escape(description)}</p><div class="notice error" id="rollout-error" role="alert" hidden></div>
      <div class="dialog-actions"><button type="button" class="button" data-close>Cancel</button>
        <button type="button" class="button primary" data-confirm="${rollback ? "rollback" : "publish"}">${rollback ? "Roll back" : "Publish release"}</button></div></div>`,
      trigger);
    dialog.querySelector(".dialog-actions [data-close]").focus();
  }

  async function publish(button) {
    if (validating) return;
    validating = true;
    const rollback = button.dataset.confirm === "rollback";
    button.disabled = true;
    button.textContent = rollback ? "Rolling back…" : "Publishing…";
    showNotice(node("rollout-error"), "");
    try {
      const data = rollback ? await api("/api/rollback", {}) : await api("/api/rollout", {
        version: Number(draft.version), channel: draft.channel,
        ...(draft.deviceId ? { deviceId: draft.deviceId } : { percentage: draft.percentage })
      });
      fleetRequest += 1;
      fleet = data;
      dialog.close();
      renderActive(true);
      showNotice(notice, rollback ? "Rollback sent to the fleet. Follow acknowledgments in Release activity." :
        "Rollout published. Follow device acknowledgments in Release activity.", "success");
      const nextFocus = rollback ? node("rollout-form").querySelector("[data-rollback]") : node("rollout-form").querySelector("[type=submit]");
      nextFocus.focus({ preventScroll: true });
    } catch (error) {
      showNotice(node("rollout-error"), error.message, "error");
      button.disabled = false;
      button.textContent = rollback ? "Try rollback again" : "Try publishing again";
    } finally {
      validating = false;
    }
  }

  function viewOrder(order, trigger) {
    if (!order) return;
    const tender = order.tender?.method === 'cash'
      ? `<div class="total"><span>Cash received</span><span>${money(order.tender.receivedCents)}</span></div><div class="total"><span>Change</span><strong>${money(order.tender.changeCents)}</strong></div>`
      : order.tender?.method === 'card-demo' ? '<div class="total"><span>Tender</span><span>Demo card</span></div>' : '';
    const adjustments = [
      order.discountCents > 0 ? `<div class="total"><span>Discount</span><span>−${money(order.discountCents)}</span></div>` : "",
      order.tipCents > 0 ? `<div class="total"><span>Tip</span><span>${money(order.tipCents)}</span></div>` : ""
    ].join("");
    const refund = order.refund
      ? `<div class="refund-block"><strong>Refunded ${money(order.refund.amountCents)}</strong><p>${escape(order.refund.reason)}</p><p>${escape(time(order.refund.createdAt))}</p></div>`
      : `<button type="button" class="button refund-trigger" data-refund="${escape(order.id)}">Record full refund</button>`;
    openDialog(`${closeButton()}<div class="dialog-body">
      <p class="eyebrow muted">${escape(order.storeName)} · MENU ${escape(versions(order.version).toUpperCase())}</p>${title("Order " + order.number)}
      <p class="dialog-description">${escape(label(order.refund ? "refunded" : order.status))} · ${order.fulfillment === "to-go" ? "To go" : "For here"} · ${escape(time(order.createdAt))}</p>
      ${order.note ? `<p class="notice">Ticket note · ${escape(order.note)}</p>` : ""}
      <ul class="checkout-lines">${order.items.map((item) => `<li><div><strong>${item.quantity} × ${escape(item.name)}</strong>
      ${item.modifiers?.length ? `<small>${escape(item.modifiers.map((modifier) => modifier.name).join(" · "))}</small>` : ""}</div><strong>${money(item.lineTotalCents)}</strong></li>`).join("")}</ul>
      <div class="quote-breakdown"><div class="total"><span>Subtotal</span><span>${money(order.subtotalCents)}</span></div>
      <div class="total"><span>Tax</span><span>${money(order.taxCents)}</span></div>${adjustments}<div class="total"><span>Total</span><strong>${money(order.totalCents)}</strong></div>${tender}</div>
      <div class="receipt-pickup"><strong>${escape(order.pickup?.title)}</strong><p>${escape(order.pickup?.description)}</p></div>
      ${refund}</div>`, trigger);
  }

  function reviewRefund(order) {
    if (!order || order.refund) return;
    const previous = refundAttempts.get(order.id);
    openDialog(`${closeButton()}<div class="dialog-body">${title("Refund order " + order.number)}
      <p class="dialog-description">Record a full demo refund of ${money(order.totalCents)}. This stops fulfillment for the ticket.</p>
      <form id="refund-form" class="refund-form" data-order="${escape(order.id)}">
        <label class="field">Reason<textarea name="reason" maxlength="160" rows="3" required ${previous ? "readonly" : ""}>${escape(previous?.reason || "")}</textarea></label>
        <p class="notice error" id="refund-error" role="alert" hidden></p>
        <div class="dialog-actions"><button type="button" class="button" data-refund-back="${escape(order.id)}">Back</button>
          <button type="submit" class="button primary">${previous ? "Check or retry refund" : "Record demo refund"}</button></div>
      </form></div>`, dialogTrigger);
    (previous ? node("refund-form").querySelector("[type=submit]") : node("refund-form").elements.reason).focus();
  }

  async function recordRefund(form) {
    if (validating) return;
    const order = orders.find((entry) => entry.id === form.dataset.order);
    const reason = form.elements.reason.value.trim();
    if (!order) return;
    if (order.refund) {
      refundAttempts.delete(order.id);
      viewOrder(order, dialogTrigger);
      dialog.querySelector("[data-close]").focus();
      return;
    }
    if (!reason) {
      showNotice(node("refund-error"), "Enter a reason for the refund.", "error");
      form.elements.reason.focus();
      return;
    }
    if (!refundAttempts.has(order.id)) {
      const idempotencyKey = globalThis.crypto?.randomUUID?.() || "fold-refund-" + Date.now() + "-" + Math.random().toString(36).slice(2);
      refundAttempts.set(order.id, { reason, idempotencyKey });
    }
    const button = form.querySelector("[type=submit]");
    validating = true;
    form.elements.reason.readOnly = true;
    button.disabled = true;
    button.textContent = "Recording…";
    showNotice(node("refund-error"), "");
    try {
      const result = await api("/api/orders/" + encodeURIComponent(order.id) + "/refund", refundAttempts.get(order.id));
      orderRequest += 1;
      orders = orders.map((entry) => entry.id === order.id ? result.order : entry);
      refundAttempts.delete(order.id);
      renderOrders();
      viewOrder(result.order, dialogTrigger);
      dialog.querySelector("[data-close]").focus();
      showNotice(notice, `Full demo refund recorded for ${order.number}.`, "success");
    } catch (error) {
      if (error.status >= 400 && error.status < 500 && ![408, 409, 429].includes(error.status)) {
        refundAttempts.delete(order.id);
        form.elements.reason.readOnly = false;
      }
      if (error.status === 409) {
        await refreshOrders();
        const refreshed = orders.find((entry) => entry.id === order.id);
        if (refreshed?.refund) {
          refundAttempts.delete(order.id);
          viewOrder(refreshed, dialogTrigger);
          dialog.querySelector("[data-close]").focus();
          return;
        }
      }
      showNotice(node("refund-error"), error.message, "error");
      button.disabled = false;
      button.textContent = refundAttempts.has(order.id) ? "Check or retry refund" : "Record demo refund";
      button.focus();
    } finally {
      validating = false;
    }
  }

  async function advanceOrder(button) {
    if (pending) return;
    const order = orders.find((entry) => entry.id === button.dataset.advance);
    if (!order || order.refund || !advance[order.status]) return;
    pending = true;
    button.disabled = true;
    try {
      const response = await api("/api/orders/" + encodeURIComponent(order.id) + "/status", { status: advance[order.status][0] });
      orderRequest += 1;
      orders = orders.map((entry) => entry.id === order.id ? response.order : entry);
      showNotice(notice, `Order ${order.number} is now ${label(response.order.status).toLowerCase()}.`, "success");
    } catch (error) {
      showNotice(notice, error.message, "error");
    } finally {
      pending = false;
      renderOrders();
      const next = [...node("orders").querySelectorAll("[data-advance]")].find((item) => item.dataset.advance === order.id) ||
        node("orders").querySelector("[data-order-filter]");
      next?.focus({ preventScroll: true });
    }
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.dataset.tab) setTab(button.dataset.tab);
    if (button.dataset.preview) previewRelease(button.dataset.preview, button);
    if (button.hasAttribute("data-rollback")) reviewRollout(button, true);
    if (button.hasAttribute("data-refresh")) {
      refreshFleet();
      if (active === "orders") refreshOrders();
    }
    if (button.dataset.orderDetail) viewOrder(orders.find((order) => order.id === button.dataset.orderDetail), button);
    if (button.dataset.advance) advanceOrder(button);
  });
  document.addEventListener("change", (event) => {
    const { target } = event;
    if (target.closest("#rollout-form")) {
      draft[target.name] = target.name === "percentage" ? Number(target.value) : target.value;
      updateTarget();
    }
    if (target.matches("[data-order-filter]")) {
      orderFilter = target.value;
      renderOrders();
    }
    if (target.matches("[data-location-filter]")) {
      locationFilter = target.value;
      renderOrders();
    }
  });
  document.addEventListener("input", (event) => {
    if (!event.target.matches('#rollout-form [name="percentage"]')) return;
    draft.percentage = Number(event.target.value);
    updateTarget();
  });
  document.addEventListener("submit", (event) => {
    if (event.target.matches("#refund-form")) {
      event.preventDefault();
      recordRefund(event.target);
      return;
    }
    if (!event.target.matches("#rollout-form")) return;
    event.preventDefault();
    reviewRollout(event.submitter);
  });
  dialog.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.hasAttribute("data-close") && !validating) dialog.close();
    if (button.dataset.refund && !validating) reviewRefund(orders.find((order) => order.id === button.dataset.refund));
    if (button.dataset.refundBack && !validating) viewOrder(orders.find((order) => order.id === button.dataset.refundBack), dialogTrigger);
    if (button.dataset.useRelease) {
      draft.version = button.dataset.useRelease;
      dialogTrigger = null;
      dialog.close();
      renderActive(true);
      node("rollout-form").elements.version.focus();
    }
    if (button.dataset.confirm) publish(button);
  });
  dialog.addEventListener("cancel", (event) => { if (validating) event.preventDefault(); });
  dialog.addEventListener("close", () => {
    previewRequest += 1;
    if (dialogTrigger?.isConnected) dialogTrigger.focus({ preventScroll: true });
    else if (active === "orders") node("orders").querySelector("[data-order-filter]")?.focus({ preventScroll: true });
    dialogTrigger = null;
  });
  addEventListener("hashchange", () => setTab(location.hash.slice(1), false));

  setTab(active, false);
  refreshFleet();
  if ("EventSource" in window) {
    const events = new EventSource("/api/events");
    events.addEventListener("message", (event) => {
      try {
        const { type } = JSON.parse(event.data);
        document.dispatchEvent(new CustomEvent("fold-ops-update", { detail: type }));
        if (type === "fleet") refreshFleet();
        if (type === "orders" && active === "orders") refreshOrders();
      } catch { /* Ignore events from other protocol versions. */ }
    });
  }
  setInterval(() => {
    refreshFleet();
    if (active === "orders") refreshOrders();
  }, 15000);
})();
