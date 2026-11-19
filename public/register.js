"use strict";

(() => {
  const { api, escape, icon, money, showNotice } = Fold;
  const node = (name) => document.getElementById("reg-" + name);
  const dialog = node("dialog");
  const hotKeys = ["flat-white", "iced-matcha", "almond-croissant", "pain-au-chocolat"];
  const maxQuantity = 20;
  const maxLines = 20;
  const pageSize = 24;
  const zero = { subtotalCents: 0, taxCents: 0, totalCents: 0 };
  const normalize = (value) => value.normalize("NFKD").toLowerCase().replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const label = (device) => device?.name.replace(/^Kiosk\b/i, "Register") || "Register";
  const activeDevice = () => devices.find((device) => device.id === deviceId);
  let devices = [];
  let deviceId = new URLSearchParams(location.search).get("device") || read("last") || "market-01";
  let session = null;
  let menu = null;
  let receipt = null;
  let sale = [];
  let service = "here";
  let quote = null;
  let attempt = null;
  let paying = false;
  let loading = false;
  let category = "all";
  let maximum = pageSize;
  let results = [];
  let stage = "";
  let editor = null;
  let payment = null;
  let focusOrigin = null;
  let ticketOnScreen = false;
  let loadId = 0;
  let fleetId = 0;
  let quoteId = 0;
  let quoteTimer;

  function read(key) {
    try { return JSON.parse(sessionStorage.getItem("fold-register:" + key)); }
    catch { return null; }
  }

  function write(key, value) {
    try {
      if (value === null) sessionStorage.removeItem("fold-register:" + key);
      else sessionStorage.setItem("fold-register:" + key, JSON.stringify(value));
    } catch { /* The cashier can continue without browser storage. */ }
  }

  function save() {
    if (session) write(deviceId, { sessionId: session.id, sale, service, attempt, receipt });
  }

  function announce(text) { node("announcement").textContent = text; }

  function versionStatus() {
    const installed = activeDevice()?.installedVersion;
    node("version").hidden = !menu;
    node("version").textContent = menu ? "Menu v" + menu.version : "";
    showNotice(node("notice"), menu && installed && Number(installed) !== Number(menu.version)
      ? `This sale stays on Menu v${menu.version}. The next sale will use Menu v${installed}.` : "");
  }

  async function fleet() {
    const id = ++fleetId;
    const connection = node("connection");
    try {
      const response = await api("/api/devices");
      if (id !== fleetId) return;
      devices = response.devices;
      if (!activeDevice() && devices.length && !session && !loading) deviceId = devices[0].id;
      const select = node("device");
      const options = devices.map((device) =>
        `<option value="${escape(device.id)}">${escape(device.storeName)} · ${escape(label(device))}</option>`).join("");
      if (select.dataset.options !== options) {
        select.innerHTML = options;
        select.dataset.options = options;
      }
      select.value = deviceId;
      select.disabled = loading || !devices.length;
      connection.textContent = "Connected";
      connection.classList.add("online");
      connection.classList.remove("offline");
      versionStatus();
      const installed = activeDevice()?.installedVersion;
      if (session && installed && Number(installed) !== Number(menu.version) &&
          !sale.length && !receipt && !attempt && !dialog.open && !loading) {
        await load({ fresh: true, keepFilters: true });
      }
    } catch {
      if (id !== fleetId) return;
      connection.textContent = "Offline";
      connection.classList.add("offline");
      connection.classList.remove("online");
    }
  }

  async function recover(pin) {
    if (!pin?.orderId) return null;
    const { order } = await api("/api/orders/" + encodeURIComponent(pin.orderId) + "?sessionId=" + encodeURIComponent(pin.id));
    return order;
  }

  async function load({ fresh = false, keepFilters = false } = {}) {
    const id = ++loadId;
    const target = deviceId;
    const draft = fresh ? null : read(target);
    if (fresh) write(target, null);
    loading = true;
    session = menu = receipt = quote = attempt = null;
    sale = [];
    service = "here";
    if (!keepFilters) {
      category = "all";
      maximum = pageSize;
      node("search").value = "";
    }
    node("device").disabled = true;
    node("search").disabled = true;
    node("categories").innerHTML = "";
    node("quick").innerHTML = "";
    node("result-count").textContent = "";
    node("products").setAttribute("aria-busy", "true");
    node("products").innerHTML = '<div class="reg-loading">Loading the register menu…</div>';
    renderTicket();
    scheduleQuote();
    versionStatus();
    try {
      let data;
      let restored = false;
      if (draft?.sessionId) {
        try {
          data = await api("/api/sessions/" + encodeURIComponent(draft.sessionId));
          restored = data.session.deviceId === target;
        } catch (error) {
          if (error.status !== 404) throw error;
          if (draft.receipt && id === loadId) {
            receipt = draft.receipt;
            node("products").innerHTML = "";
            showReceipt();
            return;
          }
        }
      }
      if (!restored) data = await api("/api/sessions", { deviceId: target });
      const savedOrder = restored ? draft.receipt || await recover(data.session) : null;
      if (id !== loadId) return;
      session = data.session;
      menu = data.menu;
      if (restored) {
        service = draft.service === "to-go" ? "to-go" : "here";
        receipt = savedOrder;
        if (!receipt) {
          sale = (draft.sale || []).filter((line) => item(line.itemId));
          attempt = draft.attempt || null;
        }
      }
      if (!menu.categories.some((entry) => entry.id === category)) category = "all";
      write("last", target);
      save();
      node("search").disabled = false;
      renderMenuControls();
      renderProducts();
      renderTicket();
      scheduleQuote();
      versionStatus();
      if (receipt) showReceipt();
      else if (attempt) showPending();
    } catch (error) {
      if (id !== loadId) return;
      node("products").innerHTML = `<div class="empty-state"><strong>Register menu unavailable</strong><p>${escape(error.message)}</p><button class="button" type="button" data-retry-register>Try again</button></div>`;
    } finally {
      if (id === loadId) {
        loading = false;
        node("device").disabled = !devices.length;
        node("products").setAttribute("aria-busy", "false");
      }
    }
  }

  function item(id) { return menu?.items.find((entry) => entry.id === id); }

  function renderMenuControls() {
    node("categories").innerHTML = [{ id: "all", name: "All items" }, ...menu.categories].map((entry) =>
      `<button class="reg-category" type="button" data-reg-category="${escape(entry.id)}" aria-pressed="${category === entry.id}">${escape(entry.name)}</button>`).join("");
    node("quick").innerHTML = hotKeys.map((id, index) => {
      const product = item(id);
      if (!product) return "";
      return `<button class="reg-quick-key" type="button" data-product="${id}" aria-label="Quick add ${escape(product.name)}" aria-keyshortcuts="Alt+${index + 1}"><span>${escape(product.name)}</span><kbd>Alt+${index + 1}</kbd></button>`;
    }).join("");
  }

  function renderProducts(focusIndex) {
    const query = normalize(node("search").value).split(" ").filter(Boolean);
    results = menu.items.filter((product) => {
      const cat = menu.categories.find((entry) => entry.id === product.categoryId);
      const searchable = normalize([product.name, product.description, cat?.name].join(" "));
      return (category === "all" || category === product.categoryId) && query.every((term) => searchable.includes(term));
    });
    node("result-count").textContent = results.length + (results.length === 1 ? " item" : " items");
    if (!results.length) {
      node("products").innerHTML = '<div class="empty-state"><strong>No matching products</strong><p>Change the search or choose another category.</p></div>';
      return;
    }
    const cards = results.slice(0, maximum).map((product) => `
      <button class="reg-key" type="button" data-product="${escape(product.id)}" data-category="${escape(product.categoryId)}" aria-label="Add ${escape(product.name)}, ${money(product.priceCents)}">
        <span class="reg-key-name">${escape(product.name)}</span>
        <span class="reg-key-bottom"><strong>${money(product.priceCents)}</strong>${icon("plus")}</span>
      </button>`).join("");
    node("products").innerHTML = cards + (maximum < results.length
      ? `<button class="button reg-full-row" type="button" data-reg-more>Show ${Math.min(pageSize, results.length - maximum)} more</button>` : "");
    if (focusIndex !== undefined) node("products").querySelectorAll("[data-product]")[focusIndex]?.focus();
  }

function selected(product, modifiers) {
    return product.modifiers.map((group) => group.options.find((option) => option.id === modifiers[group.id])).filter(Boolean);
  }

  function price(product, modifiers) {
    return product.priceCents + selected(product, modifiers).reduce((sum, option) => sum + option.priceCents, 0);
  }

  function defaults(product) {
    return Object.fromEntries(product.modifiers.filter((group) => group.required && group.options.length).map((group) =>
      [group.id, (group.options.find((option) => option.id === group.defaultOptionId) || group.options[0]).id]));
  }

  function stepper(count, name, index = "") {
    return `<div class="stepper">
      <button type="button" data-step="-1" data-row="${index}" aria-label="Decrease ${escape(name)} quantity" ${count <= 1 ? "disabled" : ""}>${icon("minus")}</button>
      <span>${count}</span>
      <button type="button" data-step="1" data-row="${index}" aria-label="Increase ${escape(name)} quantity" ${count >= maxQuantity ? "disabled" : ""}>${icon("plus")}</button>
    </div>`;
  }

  function renderTicket(focus) {
    const panel = node("lines");
    panel.classList.toggle("is-empty", !sale.length);
    panel.innerHTML = sale.length ? sale.map((line, index) => {
      const product = item(line.itemId);
      const names = selected(product, line.modifiers).map((option) => option.name);
      return `<div class="reg-line">
        <div class="reg-line-main"><strong>${escape(product.name)}</strong>${names.length ? `<small>${escape(names.join(" · "))}</small>` : ""}</div>
        <span class="reg-line-price">${money(price(product, line.modifiers) * line.quantity)}</span>
        <div class="reg-line-controls">${stepper(line.quantity, product.name, index)}
          <div class="reg-line-actions">
            ${product.modifiers.length ? `<button class="reg-text-button" type="button" data-edit="${index}" aria-label="Edit options for ${escape(product.name)}">Edit options</button>` : ""}
            <button class="reg-text-button reg-action-void" type="button" data-void-line="${index}" aria-label="Void ${escape(product.name)} line">Void</button>
          </div>
        </div>
      </div>`;
    }).join("") : `<div class="reg-empty-ticket">${icon("bag")}<strong>Ticket is empty</strong><p>Use a product key to add an item.</p></div>`;
    node("void").disabled = !sale.length || Boolean(attempt);
    node("service").querySelectorAll("button").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.service === service));
      button.disabled = !session || Boolean(attempt || receipt);
    });
    const device = activeDevice();
    node("register-label").textContent = [device?.storeName, device && label(device), menu && "Menu v" + menu.version].filter(Boolean).join(" · ");
    mobileTicket();
    if (focus) {
      const button = panel.querySelector(focus);
      (button && !button.disabled ? button : node("ticket")).focus({ preventScroll: true });
    }
  }

  function mobileTicket() {
    const qty = sale.reduce((total, line) => total + line.quantity, 0);
    node("mobile-ticket").hidden = !qty || ticketOnScreen;
    node("mobile-ticket").textContent = "View ticket · " + qty + (qty === 1 ? " item" : " items");
  }

  function paintTotal(waiting = false) {
    const total = sale.length ? quote : zero;
    node("totals").setAttribute("aria-busy", String(waiting));
    node("subtotal").textContent = total ? money(total.subtotalCents) : "—";
    node("tax").textContent = total ? money(total.taxCents) : "—";
    node("total").textContent = total ? money(total.totalCents) : "—";
    node("tender").disabled = !(sale.length && quote && session) || Boolean(attempt || receipt);
  }

  function payload() { return { sessionId: session.id, fulfillment: service, items: sale }; }

  function scheduleQuote(now = false) {
    const id = ++quoteId;
    clearTimeout(quoteTimer);
    quote = null;
    showNotice(node("quote-error"), "");
    const needsQuote = Boolean(session && sale.length && !receipt && !attempt);
    paintTotal(needsQuote);
    if (!needsQuote) return;
    function update() {
      api("/api/quote", payload()).then((data) => {
        if (id !== quoteId) return;
        quote = data.quote;
        paintTotal();
      }).catch((error) => {
        if (id !== quoteId) return;
        paintTotal();
        const note = node("quote-error");
        showNotice(note, error.message, "error");
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "reg-text-button";
        retry.textContent = "Retry total";
        retry.onclick = () => scheduleQuote(true);
        note.append(" ", retry);
      });
    }
    if (now) update();
    else quoteTimer = setTimeout(update, 85);
  }

  function changed(focus) {
    save();
    renderTicket(focus);
    scheduleQuote();
  }

  function commit(product, modifiers, quantity, index = null) {
    const matching = sale.findIndex((row, at) => at !== index && row.itemId === product.id &&
      product.modifiers.every((group) => row.modifiers[group.id] === modifiers[group.id]));
    if (matching >= 0 && sale[matching].quantity + quantity > maxQuantity) return "The ticket already holds the maximum quantity for these options.";
    if (matching < 0 && index === null && sale.length >= maxLines) return "This ticket has reached 20 lines.";
    const line = { itemId: product.id, modifiers, quantity };
    if (matching >= 0) {
      sale[matching].quantity += quantity;
      if (index !== null) sale.splice(index, 1);
    } else if (index === null) sale.push(line);
    else sale[index] = line;
    changed();
    announce(product.name + (index === null ? " added." : " updated."));
    return "";
  }

  function add(id, trigger, customize = false) {
    const product = item(id);
    if (!session || !product || receipt || attempt || loading) return;
    if (customize && product.modifiers.length) {
      openEditor(product, null, trigger);
      return;
    }
    const error = commit(product, defaults(product), 1);
    if (error) {
      showNotice(node("notice"), error, "error");
      announce(error);
    }
  }

  function openDialog(kind, title, content, trigger, closable = true, focus) {
    stage = kind;
    if (trigger && !dialog.open) focusOrigin = trigger;
    const close = closable ? `<button class="icon-button dialog-close" type="button" data-close aria-label="Close">${icon("close")}</button>` : "";
    dialog.innerHTML = `${close}<div class="dialog-body${kind === "receipt" ? " reg-receipt" : ""}"><h2 id="reg-dialog-title">${escape(title)}</h2>${content}</div>`;
    if (!dialog.open) dialog.showModal();
    if (focus) dialog.querySelector(focus)?.focus();
  }

  function openEditor(product, index, trigger) {
    const line = index === null ? null : sale[index];
    const modifiers = line ? { ...line.modifiers } : defaults(product);
    editor = { product, index, modifiers, quantity: line?.quantity || 1 };
    const fields = product.modifiers.map((group) => {
      const options = group.required ? group.options : [{ id: "", name: "None", priceCents: 0 }, ...group.options];
      return `<fieldset class="reg-option"><legend>${escape(group.name)}${group.required ? " <span>Required</span>" : ""}</legend>
        ${options.map((option) => `<label class="option"><input type="radio" name="${escape(group.id)}" value="${escape(option.id)}" ${(modifiers[group.id] || "") === option.id ? "checked" : ""} ${group.required ? "required" : ""}>
          <span>${escape(option.name)}</span><span>${option.priceCents ? "+" + money(option.priceCents) : ""}</span></label>`).join("")}</fieldset>`;
    }).join("");
    openDialog("editor", product.name, `<form id="reg-edit-form"><div class="modifiers">${fields}</div>
      <p id="reg-editor-error" class="notice error" role="alert" hidden></p>
      <div class="dialog-actions"><div id="reg-editor-quantity">${stepper(editor.quantity, product.name)}</div>
      <button type="submit" class="button primary"><span>${line ? "Save options" : "Add item"}</span><strong id="reg-editor-price"></strong></button></div></form>`,
    trigger, true, "input:checked");
    editorTotal();
  }

  function editorTotal() {
    node("editor-price").textContent = money(price(editor.product, editor.modifiers) * editor.quantity);
  }

function openTender(trigger) {
    if (!quote || dialog.open || node("tender").disabled) return;
    payment = { method: "card-demo", received: "" };
    openDialog("tender", "Take payment", `
      <div class="reg-tender-total"><span>Amount due</span><strong>${money(quote.totalCents)}</strong></div>
      <div class="reg-tender-methods" aria-label="Tender method">
        <button class="button" type="button" data-method="card-demo" aria-pressed="true">Card (demo)</button>
        <button class="button" type="button" data-method="cash" aria-pressed="false">Cash</button>
      </div>
      <form id="reg-payment-form"><div id="reg-payment-fields"></div>
        <div class="dialog-actions"><button class="button" type="button" data-close>Back</button>
          <button class="button primary" type="submit" id="reg-confirm-payment"></button></div>
      </form>`, trigger, true, '[data-method="card-demo"]');
    renderPayment();
  }

  function cents(input) {
    const data = input.trim().replace(/^\$/, "").replace(",", ".");
    if (!/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(data)) return null;
    const [dollars, remainder = ""] = data.split(".");
    const amount = Number(dollars) * 100 + Number(remainder.padEnd(2, "0"));
    return Number.isSafeInteger(amount) && amount <= 100_000_000 ? amount : null;
  }

  function updateCash() {
    const amount = cents(payment.received);
    const change = amount === null ? null : amount - quote.totalCents;
    node("change-label").textContent = change !== null && change < 0 ? "Cash short" : "Change due";
    node("change-amount").textContent = change === null ? "—" : money(Math.abs(change));
    node("confirm-payment").disabled = change === null || change < 0;
  }

  function renderPayment() {
    const fields = node("payment-fields");
    const confirm = node("confirm-payment");
    const cash = payment.method === "cash";
    dialog.querySelectorAll("[data-method]").forEach((button) =>
      button.setAttribute("aria-pressed", String(button.dataset.method === payment.method)));
    confirm.textContent = cash ? "Record cash payment" : "Complete demo card sale";
    if (!cash) {
      fields.innerHTML = '<p class="dialog-description">Simulated card tender. No payment credentials are collected.</p>';
      confirm.disabled = false;
      return;
    }
    const total = quote.totalCents;
    const amounts = [...new Set([5, 10, 20].map((step) => Math.ceil(total / (step * 100)) * step * 100))].filter((amount) => amount > total);
    fields.innerHTML = `<div class="reg-cash-fields">
      <label class="field">Cash received<input id="reg-cash-amount" inputmode="decimal" type="text" autocomplete="off" placeholder="0.00" value="${escape(payment.received)}" aria-describedby="reg-cash-change"></label>
      <div class="reg-cash-keys"><button class="button" type="button" data-cash="${total}">Exact</button>
        ${amounts.map((amount) => `<button class="button" type="button" data-cash="${amount}">${money(amount)}</button>`).join("")}</div>
      <div class="reg-change" id="reg-cash-change"><span id="reg-change-label">Change due</span><strong id="reg-change-amount">—</strong></div></div>`;
    updateCash();
  }

  function showPending() {
    openDialog("pending", "Check previous payment",
      '<p class="dialog-description">The register could not confirm the sale. Check again using the original payment details.</p><div class="dialog-actions"><button class="button primary" type="button" data-retry-payment>Check or retry payment</button></div>',
      null, false, "[data-retry-payment]");
  }

  async function sendPayment(button) {
    if (paying || !attempt) return;
    paying = true;
    dialog.querySelectorAll("button, input").forEach((control) => { control.disabled = true; });
    button.textContent = "Saving sale…";
    try {
      const { order } = await api("/api/orders", attempt);
      finish(order);
    } catch (error) {
      if (!error.status || error.status >= 500 || [408, 409, 429].includes(error.status)) {
        const pin = await api("/api/sessions/" + encodeURIComponent(session.id)).then((data) => data.session).catch(() => null);
        const order = await recover(pin).catch(() => null);
        if (order) finish(order);
        else showPending();
      } else {
        attempt = null;
        save();
        scheduleQuote();
        openDialog("payment-error", "Payment could not be recorded", `
          <p class="notice error" role="alert">${escape(error.message)}</p>
          <div class="dialog-actions"><button class="button" type="button" data-close>Back to ticket</button></div>`,
        null, true, ".dialog-actions button");
      }
    } finally {
      paying = false;
    }
  }

  function finish(order) {
    receipt = order;
    attempt = null;
    sale = [];
    changed();
    showReceipt();
  }

  function showReceipt() {
    const order = receipt;
    const tender = order.tender;
    const fulfillment = order.fulfillment === "to-go" ? "To go" : "For here";
    const method = tender?.method === "cash" ? "Cash" : tender?.method === "card-demo" ? "Card (demo)" : "";
    const paid = tender?.method === "cash"
      ? `<div class="total"><span>Cash received</span><strong>${money(tender.receivedCents)}</strong></div><div class="total"><span>Change due</span><strong>${money(tender.changeCents)}</strong></div>`
      : "";
    const pickup = order.pickup ? `<div class="receipt-pickup"><strong>${escape(order.pickup.title)}</strong><p>${escape(order.pickup.description)}</p></div>` : "";
    openDialog("receipt", "Sale complete", `
      <p class="reg-receipt-number">${escape(order.number)}</p>
      <p class="reg-receipt-meta">${escape(order.storeName)} · ${fulfillment} · Menu v${escape(order.version)}${method ? " · " + method : ""}</p>
      <ul class="checkout-lines">${order.items.map((line) =>
        `<li><div><strong>${line.quantity} × ${escape(line.name)}</strong>${line.modifiers?.length ? `<small>${escape(line.modifiers.map((option) => option.name).join(" · "))}</small>` : ""}</div><strong>${money(line.lineTotalCents)}</strong></li>`
      ).join("")}</ul>
      <div class="quote-breakdown"><div class="total"><span>Subtotal</span><span>${money(order.subtotalCents)}</span></div>
      <div class="total"><span>Tax</span><span>${money(order.taxCents)}</span></div>
      <div class="total"><span>Total</span><strong>${money(order.totalCents)}</strong></div></div>${paid}${pickup}
      <div class="dialog-actions"><button class="button" type="button" data-print>Print receipt</button>
      <button class="button primary" type="button" data-next>Next sale</button></div>`,
    null, false, "[data-next]");
  }

  async function nextSale() {
    focusOrigin = null;
    dialog.close();
    await load({ fresh: true });
    node("search").focus({ preventScroll: true });
  }

  function confirmVoid() {
    openDialog("void", "Void the ticket?", `
      <p class="dialog-description">The current sale will be cleared.</p>
      <div class="dialog-actions"><button class="button" type="button" data-close>Keep ticket</button>
      <button class="button primary" type="button" data-next>Void ticket</button></div>`,
    node("void"), true, ".dialog-actions [data-close]");
  }

node("device").addEventListener("change", () => {
    deviceId = node("device").value;
    const url = new URL(location.href);
    url.searchParams.set("device", deviceId);
    history.replaceState(null, "", url);
    load();
  });

  node("search").addEventListener("input", () => {
    if (!menu) return;
    maximum = pageSize;
    renderProducts();
  });

  node("search").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing || !results.length) return;
    event.preventDefault();
    add(results[0].id, node("search"), event.shiftKey);
    if (!dialog.open) {
      node("search").value = "";
      renderProducts();
    }
  });

  node("categories").addEventListener("click", (event) => {
    const button = event.target.closest("[data-reg-category]");
    if (!button) return;
    category = button.dataset.regCategory;
    maximum = pageSize;
    node("categories").querySelectorAll("button").forEach((entry) => entry.setAttribute("aria-pressed", String(entry === button)));
    renderProducts();
  });

  function handleProductClick(event) {
    const entry = event.target.closest("[data-product]");
    if (entry) add(entry.dataset.product, entry, event.shiftKey);
    if (event.target.closest("[data-reg-more]")) {
      const next = maximum;
      maximum += pageSize;
      renderProducts(next);
    }
    if (event.target.closest("[data-retry-register]")) fleet().finally(() => load());
  }

  node("quick").addEventListener("click", handleProductClick);
  node("products").addEventListener("click", handleProductClick);

  node("service").addEventListener("click", (event) => {
    const button = event.target.closest("[data-service]");
    if (!button || attempt || service === button.dataset.service) return;
    service = button.dataset.service;
    changed();
  });

  node("lines").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || attempt || receipt) return;
    if (button.dataset.edit !== undefined) {
      const index = Number(button.dataset.edit);
      openEditor(item(sale[index].itemId), index, button);
    }
    if (button.dataset.voidLine !== undefined) {
      const index = Number(button.dataset.voidLine);
      const [line] = sale.splice(index, 1);
      changed('[data-void-line="' + Math.min(index, sale.length - 1) + '"]');
      announce(item(line.itemId).name + " voided.");
    }
    if (button.dataset.step && button.dataset.row !== "") {
      const index = Number(button.dataset.row);
      const line = sale[index];
      line.quantity = Math.min(maxQuantity, Math.max(1, line.quantity + Number(button.dataset.step)));
      changed('[data-row="' + index + '"][data-step="' + button.dataset.step + '"]');
    }
  });

  node("void").addEventListener("click", confirmVoid);
  node("tender").addEventListener("click", (event) => openTender(event.currentTarget));
  node("mobile-ticket").addEventListener("click", () => {
    node("ticket").scrollIntoView({ block: "start" });
    node("ticket").focus({ preventScroll: true });
  });

  dialog.addEventListener("change", (event) => {
    if (stage !== "editor" || !event.target.matches("input[type=radio]")) return;
    const { name, value } = event.target;
    if (value) editor.modifiers[name] = value;
    else delete editor.modifiers[name];
    editorTotal();
  });

  dialog.addEventListener("input", (event) => {
    if (attempt || event.target !== node("cash-amount")) return;
    payment.received = event.target.value;
    updateCash();
  });

  dialog.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.hasAttribute("data-close") && !paying && !attempt) dialog.close();
    if (button.hasAttribute("data-next")) nextSale();
    if (button.hasAttribute("data-print")) window.print();
    if (button.hasAttribute("data-retry-payment")) sendPayment(button);
    if (button.dataset.method && stage === "tender" && !attempt && payment.method !== button.dataset.method) {
      payment.method = button.dataset.method;
      renderPayment();
      if (payment.method === "cash") node("cash-amount").focus();
    }
    if (button.dataset.cash && stage === "tender" && !attempt) {
      payment.received = (Number(button.dataset.cash) / 100).toFixed(2);
      node("cash-amount").value = payment.received;
      updateCash();
      node("confirm-payment").focus();
    }
    if (button.dataset.step && stage === "editor") {
      editor.quantity = Math.max(1, Math.min(maxQuantity, editor.quantity + Number(button.dataset.step)));
      node("editor-quantity").innerHTML = stepper(editor.quantity, editor.product.name);
      const direction = node("editor-quantity").querySelector('[data-step="' + button.dataset.step + '"]');
      (direction.disabled ? node("editor-quantity").querySelector("button:not(:disabled)") : direction)?.focus();
      editorTotal();
    }
  });

  dialog.addEventListener("submit", (event) => {
    event.preventDefault();
    if (event.target === node("edit-form")) {
      const { product, modifiers, quantity, index } = editor;
      const error = commit(product, modifiers, quantity, index);
      if (error) showNotice(node("editor-error"), error, "error");
      else dialog.close();
    }
    if (event.target !== node("payment-form") || paying || attempt) return;
    const tender = { method: payment.method };
    if (payment.method === "cash") {
      const receivedCents = cents(payment.received);
      if (receivedCents === null || receivedCents < quote.totalCents) return;
      tender.receivedCents = receivedCents;
    }
    const key = globalThis.crypto?.randomUUID?.() || "fold-register-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    attempt = { ...payload(), idempotencyKey: key, tender };
    save();
    sendPayment(node("confirm-payment"));
  });

  dialog.addEventListener("cancel", (event) => {
    if (paying || attempt || receipt) event.preventDefault();
  });
  dialog.addEventListener("close", () => {
    stage = "";
    editor = payment = null;
    if (focusOrigin?.isConnected && !focusOrigin.disabled) focusOrigin.focus({ preventScroll: true });
    else if (focusOrigin && !node("search").disabled) node("search").focus({ preventScroll: true });
    focusOrigin = null;
  });

  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || dialog.open || event.isComposing || event.repeat) return;
    if (event.key === "F2" && !node("search").disabled) {
      event.preventDefault();
      node("search").focus();
      node("search").select();
    }
    if (event.key === "F4" && !node("tender").disabled) {
      event.preventDefault();
      openTender(node("tender"));
    }
    if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && /^[1-4]$/.test(event.key) && session) {
      event.preventDefault();
      add(hotKeys[Number(event.key) - 1], document.activeElement);
    }
  });

  async function initialize() {
    if ("IntersectionObserver" in window) {
      const observer = new IntersectionObserver(([entry]) => {
        ticketOnScreen = entry.isIntersecting;
        mobileTicket();
      }, { threshold: 0.15 });
      observer.observe(node("ticket"));
    }
    await fleet();
    await load();
    if ("EventSource" in window) {
      const events = new EventSource("/api/events");
      events.addEventListener("open", fleet);
      events.addEventListener("message", (event) => {
        try { if (JSON.parse(event.data).type === "fleet") fleet(); }
        catch { /* Ignore events from other protocol versions. */ }
      });
    }
    setInterval(fleet, 12000);
  }

  initialize();
})();
