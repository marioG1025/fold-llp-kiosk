"use strict";

(() => {
  const { api, escape, icon, image, money, showNotice } = Fold;
  const node = (id) => document.getElementById(id);
  const dom = {
    device: node("device"), search: node("search"), categories: node("categories"),
    products: node("products"), edition: node("edition"), notice: node("menu-notice"),
    footer: node("footer-session"), cart: node("cart"), cartItems: node("cart-items"),
    count: node("count"), mode: node("service-mode"), subtotal: node("subtotal"),
    checkout: node("checkout"), itemDialog: node("item-dialog"),
    checkoutDialog: node("checkout-dialog"), mobileCart: node("mobile-cart"),
    mobileCartText: node("mobile-cart-text"), status: node("status")
  };
  const defaultDevice = "market-01";
  const maxQuantity = 20;
  const maxLines = 20;
  const pageSize = 12;
  const atlas = {
    "flat-white": [0, 0], "iced-matcha": [50, 0], "iced-vanilla": [100, 0],
    "almond-croissant": [0, 50], "raspberry-croissant": [50, 50], "pain-au-chocolat": [100, 50],
    "egg-focaccia": [0, 100], "granola-bowl": [50, 100], "chocolate-cookie": [100, 100],
    "maple-cloud-latte": [0, 0, true], "pear-frangipane": [100, 0, true]
  };
  let devices = [];
  let deviceId = new URLSearchParams(location.search).get("device") || readStorage("last-device") || defaultDevice;
  let session = null;
  let menu = null;
  let cart = [];
  let fulfillment = "here";
  let receipt = null;
  let clientKey = "";
  let category = "all";
  let visibleLimit = pageSize;
  let requestNumber = 0;
  let opening = false;
  let submitting = false;
  let itemEditor = null;
  let awaitingQuote = false;
  let checkoutTrigger = null;
  let itemTrigger = null;

  function readStorage(key) {
    try { return JSON.parse(sessionStorage.getItem("fold-kiosk:" + key)); }
    catch { return null; }
  }

  function writeStorage(key, value) {
    try {
      if (value === null) sessionStorage.removeItem("fold-kiosk:" + key);
      else sessionStorage.setItem("fold-kiosk:" + key, JSON.stringify(value));
    } catch { /* A kiosk can operate without tab storage. */ }
  }

  function persist() {
    if (!session) return;
    writeStorage(deviceId, { sessionId: session.id, cart, fulfillment, clientKey, receipt });
  }

  function announce(message) {
    dom.status.textContent = message;
  }

  function photo(item) {
    const { atlas: collection, column, row } = item.photo || {};
    if (["bar", "bakes", "kitchen"].includes(collection) &&
        Number.isInteger(column) && column >= 0 && column < 4 &&
        Number.isInteger(row) && row >= 0 && row < 4) {
      return `<span class="product-photo"><span class="photo-tile ${collection}-photo" style="--tile-x:${column * 100 / 3}%;--tile-y:${row * 100 / 3}%"></span></span>`;
    }
    const tile = atlas[item.id];
    if (!tile) return `<span class="product-photo"><img src="${escape(image(item))}" alt="" data-fallback loading="lazy"></span>`;
    const [x, y, seasonal] = tile;
    return `<span class="product-photo"><span class="photo-tile${seasonal ? " seasonal-photo" : ""}" style="--tile-x:${x}%;--tile-y:${y}%"></span></span>`;
  }

  function activeDevice() {
    return devices.find((device) => device.id === deviceId);
  }

  function isBusy() {
    return cart.length > 0 || Boolean(receipt) || Boolean(clientKey) || dom.itemDialog.open || dom.checkoutDialog.open;
  }

  async function refreshDevices() {
    const payload = await api("/api/devices");
    devices = payload.devices || [];
    if (!devices.length) throw new Error("No kiosks are available.");
    const match = activeDevice();
    if (!match) deviceId = devices[0].id;
    const options = devices.map((device) =>
      `<option value="${escape(device.id)}">${escape(device.storeName)} · ${escape(device.name)}</option>`
    ).join("");
    if (dom.device.dataset.options !== options) {
      dom.device.innerHTML = options;
      dom.device.dataset.options = options;
    }
    dom.device.value = deviceId;
    if (!opening) dom.device.disabled = false;
    renderEdition();
    if (session && match && Number(match.installedVersion) !== Number(menu?.version) && match.installedVersion && !isBusy() && !opening) {
      await loadShop({ fresh: true, preserveFilters: true });
    }
  }

  async function loadShop({ fresh = false, preserveFilters = false } = {}) {
    const loadId = ++requestNumber;
    const target = deviceId;
    opening = true;
    session = menu = receipt = null;
    cart = [];
    clientKey = "";
    fulfillment = "here";
    if (!preserveFilters) {
      category = "all";
      visibleLimit = pageSize;
      dom.search.value = "";
    }
    dom.device.disabled = true;
    renderCart();
    renderEdition();
    dom.products.setAttribute("aria-busy", "true");
    dom.products.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
    dom.categories.innerHTML = "";
    const saved = fresh ? null : readStorage(target);
    if (fresh) writeStorage(target, null);
    try {
      let data;
      let resumed = false;
      if (saved?.sessionId) {
        try {
          data = await api("/api/sessions/" + encodeURIComponent(saved.sessionId));
          resumed = data.session?.deviceId === target;
        } catch (error) {
          if (saved.receipt && error.status === 404) {
            if (loadId !== requestNumber) return;
            receipt = saved.receipt;
            dom.products.innerHTML = "";
            renderReceipt(receipt);
            return;
          }
          if (error.status !== 404) throw error;
        }
      }
      if (!resumed || !data) data = await api("/api/sessions", { deviceId: target });
      const restoredReceipt = resumed ? saved.receipt || await recoverReceipt(data.session) : null;
      if (loadId !== requestNumber) return;
      session = data.session;
      menu = data.menu;
      if (resumed && saved) {
        cart = (saved.cart || []).filter((line) => menu.items.some((item) => item.id === line.itemId));
        fulfillment = saved.fulfillment === "to-go" ? "to-go" : "here";
        clientKey = saved.clientKey || "";
        receipt = restoredReceipt;
        if (receipt) cart = [];
      }
      if (!menu.categories.some((entry) => entry.id === category)) category = "all";
      writeStorage("last-device", target);
      persist();
      dom.search.disabled = false;
      renderCategories();
      renderMenu();
      renderEdition();
      renderCart();
      if (receipt) renderReceipt(receipt);
      else if (clientKey && cart.length) renderPending();
    } catch (error) {
      if (loadId !== requestNumber) return;
      dom.products.innerHTML = `<div class="empty-state"><strong>Menu unavailable</strong><p>${escape(error.message)}</p><button type="button" class="button" data-retry-menu>Try again</button></div>`;
    } finally {
      if (loadId === requestNumber) {
        opening = false;
        dom.device.disabled = !devices.length;
        dom.products.setAttribute("aria-busy", "false");
      }
    }
  }

  async function recoverReceipt(pinned) {
    if (!pinned.orderId) return null;
    const path = "/api/orders/" + encodeURIComponent(pinned.orderId) + "?sessionId=" + encodeURIComponent(pinned.id);
    return (await api(path)).order;
  }

  function renderEdition() {
    const device = activeDevice();
    dom.edition.textContent = menu ? "Menu v" + menu.version : "";
    dom.footer.textContent = menu && device
      ? `${device.storeName.toUpperCase()} · ${device.name.toUpperCase()} · MENU V${menu.version}`
      : "SELF CHECKOUT";
    const newVersion = menu && device?.installedVersion && Number(menu.version) !== Number(device.installedVersion);
    if (newVersion) {
      showNotice(dom.notice, `This order is using Menu v${menu.version}. Your next order will use Menu v${device.installedVersion}.`);
    } else {
      showNotice(dom.notice, "");
    }
  }

  function renderCategories() {
    const categories = [{ id: "all", name: "All items" }, ...(menu?.categories || [])];
    dom.categories.innerHTML = categories.map((entry) =>
      `<button type="button" class="category" aria-pressed="${entry.id === category}" data-category="${escape(entry.id)}">${escape(entry.name)}</button>`
    ).join("");
  }

  function renderMenu(focusIndex) {
    const normalize = (text) => text.normalize("NFKD").toLowerCase().replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const terms = normalize(dom.search.value).split(" ").filter(Boolean);
    const results = menu.items.filter((item) => {
      const itemCategory = menu.categories.find((entry) => entry.id === item.categoryId);
      const searchable = normalize([item.name, item.description, itemCategory?.name].join(" "));
      return (category === "all" || item.categoryId === category) && terms.every((term) => searchable.includes(term));
    });
    if (!results.length) {
      dom.products.innerHTML = '<div class="empty-state"><strong>No menu items found</strong><p>Try a different search or category.</p></div>';
      return;
    }
    dom.products.innerHTML = results.slice(0, visibleLimit).map((item) => `
      <button type="button" class="product" data-product="${escape(item.id)}" aria-label="Customize ${escape(item.name)}, ${money(item.priceCents)}">
        ${photo(item)}
        <span class="product-copy"><span><span class="product-name">${escape(item.name)}</span><span class="product-description">${escape(item.description)}</span></span></span>
        <span class="product-bottom"><span class="product-price">${money(item.priceCents)}</span><span class="product-plus">${icon("plus")}</span></span>
      </button>`).join("") + (results.length > visibleLimit
        ? `<button type="button" class="button menu-more" data-menu-more>Show ${Math.min(pageSize, results.length - visibleLimit)} more items · ${results.length} results</button>`
        : "");
    if (focusIndex !== undefined) dom.products.querySelectorAll("[data-product]")[focusIndex]?.focus();
  }

  function modifierOptions(item, selection) {
    return (item.modifiers || []).map((group) =>
      group.options.find((option) => option.id === selection[group.id])
    ).filter(Boolean);
  }

  function unitPrice(item, selection) {
    return item.priceCents + modifierOptions(item, selection).reduce((sum, option) => sum + option.priceCents, 0);
  }

  function stepper(quantity, label, lineIndex = "") {
    const removing = lineIndex !== "" && quantity === 1;
    return `<div class="stepper">
      <button type="button" data-step="-1" data-line="${lineIndex}" ${quantity === 1 && !removing ? "disabled" : ""} aria-label="${removing ? "Remove" : "Decrease quantity of"} ${escape(label)}">${icon("minus")}</button>
      <span aria-label="Quantity">${quantity}</span>
      <button type="button" data-step="1" data-line="${lineIndex}" ${quantity >= maxQuantity ? "disabled" : ""} aria-label="Increase quantity of ${escape(label)}">${icon("plus")}</button>
    </div>`;
  }

  function renderCart(focusTarget) {
    const count = cart.reduce((sum, line) => sum + line.quantity, 0);
    let subtotal = 0;
    dom.cartItems.classList.toggle("has-items", count > 0);
    if (!count) {
      dom.cartItems.innerHTML = `<div class="empty-cart"><span class="empty-icon">${icon("bag")}</span><strong>Your bag is empty</strong><p>Pick something delicious to get started.</p></div>`;
    } else {
      dom.cartItems.innerHTML = cart.map((line, index) => {
        const item = menu.items.find((entry) => entry.id === line.itemId);
        const options = modifierOptions(item, line.modifiers);
        const price = line.quantity * unitPrice(item, line.modifiers);
        subtotal += price;
        return `<div class="cart-line">
          <div><strong>${escape(item.name)}</strong>${options.length ? `<p class="line-modifiers">${escape(options.map((option) => option.name).join(" · "))}</p>` : ""}</div>
          <strong>${money(price)}</strong>
          <div class="line-actions">${stepper(line.quantity, item.name, index)}<button type="button" class="text-button" data-edit="${index}" aria-label="Edit ${escape(item.name)}">Edit</button></div>
        </div>`;
      }).join("");
    }
    dom.mode.querySelectorAll("button").forEach((button) =>
      button.setAttribute("aria-pressed", String((button.dataset.mode === "dine-in" ? "here" : "to-go") === fulfillment))
    );
    dom.count.textContent = count;
    dom.subtotal.textContent = money(subtotal);
    dom.checkout.disabled = count === 0 || Boolean(receipt) || !session;
    dom.mobileCart.hidden = !count;
    dom.mobileCartText.textContent = `Your order · ${count} ${count === 1 ? "item" : "items"} · ${money(subtotal)}`;
    if (focusTarget) {
      const destination = dom.cartItems.querySelector(focusTarget);
      if (destination && !destination.disabled) destination.focus({ preventScroll: true });
      else dom.cart.focus({ preventScroll: true });
    }
  }

  function changeCart(focusTarget) {
    clientKey = "";
    persist();
    renderCart(focusTarget);
  }

  function closeButton() {
    return `<button type="button" class="icon-button dialog-close" data-dialog-close aria-label="Close">${icon("close")}</button>`;
  }

  function editItem(item, lineIndex = null, trigger = null) {
    const line = lineIndex === null ? null : cart[lineIndex];
    const modifiers = line ? { ...line.modifiers } : {};
    (item.modifiers || []).forEach((group) => {
      if (!line && group.required && group.options.length) {
        modifiers[group.id] = (group.options.find((option) => option.id === group.defaultOptionId) || group.options[0]).id;
      }
    });
    itemEditor = { item, lineIndex, modifiers, quantity: line?.quantity || 1 };
    itemTrigger = trigger;
    const fields = (item.modifiers || []).map((group) => {
      const options = group.required ? group.options : [{ id: "", name: "No thanks", priceCents: 0 }, ...group.options];
      return `<fieldset>
        <legend>${escape(group.name)} <span>${group.required ? "Required" : "Optional"}</span></legend>
        ${options.map((option) => `<label class="option"><input type="radio" name="${escape(group.id)}" value="${escape(option.id)}" ${(modifiers[group.id] || "") === option.id ? "checked" : ""} ${group.required ? "required" : ""}><span>${escape(option.name)}</span><span>${option.priceCents ? "+" + money(option.priceCents) : ""}</span></label>`).join("")}
      </fieldset>`;
    }).join("");
    dom.itemDialog.innerHTML = `${closeButton()}${photo(item)}
      <div class="dialog-body"><h2 id="item-dialog-title">${escape(item.name)}</h2>
      <p class="dialog-description">${escape(item.description)}</p>
      <form id="item-form"><div class="modifiers">${fields}</div>
        <p class="notice error" id="item-notice" role="alert" hidden></p>
        <div class="dialog-actions"><div id="editor-stepper">${stepper(itemEditor.quantity, item.name)}</div>
          <button type="submit" class="button primary"><span>${line ? "Save changes" : "Add to order"}</span><strong id="editor-price"></strong></button>
        </div>
      </form></div>`;
    updateEditorPrice();
    dom.itemDialog.showModal();
  }

  function updateEditorPrice() {
    const { item, modifiers, quantity } = itemEditor;
    node("editor-price").textContent = money(unitPrice(item, modifiers) * quantity);
  }

  function saveItem(event) {
    event.preventDefault();
    const { item, lineIndex, modifiers, quantity } = itemEditor;
    let combined = cart.findIndex((line, index) =>
      index !== lineIndex && line.itemId === item.id &&
      item.modifiers.every((group) => line.modifiers[group.id] === modifiers[group.id]));
    if (combined >= 0 && cart[combined].quantity + quantity > maxQuantity) {
      showNotice(node("item-notice"), "This item is limited to " + maxQuantity + " per customization.", "error");
      return;
    }
    if (lineIndex === null && combined < 0 && cart.length >= maxLines) {
      showNotice(node("item-notice"), "Your order has reached its limit of " + maxLines + " different items.", "error");
      return;
    }
    const next = { itemId: item.id, modifiers, quantity };
    if (combined >= 0) {
      cart[combined].quantity += quantity;
      if (lineIndex !== null) {
        cart.splice(lineIndex, 1);
        if (combined > lineIndex) combined -= 1;
      }
    } else if (lineIndex === null) cart.push(next);
    else cart.splice(lineIndex, 1, next);
    dom.itemDialog.close();
    changeCart(lineIndex === null ? null : '[data-edit="' + (combined < 0 ? lineIndex : combined) + '"]');
    announce(item.name + (lineIndex === null ? " added to your order." : " updated."));
  }

  function orderRequest() {
    return { sessionId: session.id, fulfillment, items: cart };
  }

  async function openCheckout(event) {
    if (!session || !cart.length || awaitingQuote || dom.checkoutDialog.open) return;
    checkoutTrigger = event.currentTarget;
    dom.checkoutDialog.innerHTML = `${closeButton()}<div class="dialog-body"><h2 id="checkout-dialog-title">Review your order</h2><p class="dialog-description" role="status">Calculating your total…</p></div>`;
    dom.checkoutDialog.showModal();
    await quoteOrder();
  }

  async function quoteOrder() {
    awaitingQuote = true;
    let quote;
    try {
      ({ quote } = await api("/api/quote", orderRequest()));
    } catch (error) {
      if (dom.checkoutDialog.open) {
        dom.checkoutDialog.innerHTML = `${closeButton()}<div class="dialog-body"><h2 id="checkout-dialog-title">Review your order</h2><p class="notice error" role="alert">${escape(error.message)}</p><button type="button" class="button" data-retry-quote>Try again</button></div>`;
        dom.checkoutDialog.querySelector("[data-retry-quote]").focus();
      }
    } finally {
      awaitingQuote = false;
    }
    if (quote && dom.checkoutDialog.open) renderQuote(quote);
  }

  function renderQuote(quote) {
    const { items, subtotalCents, taxCents, totalCents } = quote;
    dom.checkoutDialog.innerHTML = `${closeButton()}<div class="dialog-body">
      <p class="eyebrow muted">${fulfillment === "to-go" ? "TO GO" : "FOR HERE"}</p><h2 id="checkout-dialog-title">Review your order</h2>
      <ul class="checkout-lines">${items.map((line) => `<li><div><strong>${line.quantity} × ${escape(line.name)}</strong>${line.modifiers?.length ? `<small>${escape(line.modifiers.map((option) => option.name).join(" · "))}</small>` : ""}</div><strong>${money(line.lineTotalCents)}</strong></li>`).join("")}</ul>
      <div class="quote-breakdown">
        <div class="total"><span>Subtotal</span><span>${money(subtotalCents)}</span></div>
        <div class="total"><span>Tax</span><span>${money(taxCents)}</span></div>
        <div class="total"><span>Total</span><strong>${money(totalCents)}</strong></div>
      </div>
      <p class="notice error" id="checkout-notice" role="alert" hidden></p>
      <div class="dialog-actions"><button type="button" class="button" data-dialog-close>Back</button><button type="button" class="button primary" data-place-order>Place demo order</button></div>
      <p class="dialog-meta">No payment details are collected.</p>
    </div>`;
    dom.checkoutDialog.querySelector("[data-place-order]").focus();
  }

  function renderPending(message = "We’re checking whether your order went through. Retrying uses the same order.") {
    dom.checkoutDialog.innerHTML = `<div class="dialog-body">
      <h2 id="checkout-dialog-title">Confirm your order status</h2>
      <p class="dialog-description" role="status">${escape(message)}</p>
      <div class="dialog-actions"><button type="button" class="button primary" data-place-order>Check or retry order</button></div>
    </div>`;
    if (!dom.checkoutDialog.open) dom.checkoutDialog.showModal();
    dom.checkoutDialog.querySelector("[data-place-order]").focus();
  }

  function finishOrder(order) {
    receipt = order;
    cart = [];
    persist();
    renderCart();
    renderReceipt(order);
  }

  async function placeOrder(event) {
    if (submitting || !session || receipt) return;
    const button = event.target.closest("[data-place-order]");
    submitting = true;
    button.disabled = true;
    button.textContent = "Placing order…";
    if (node("checkout-notice")) showNotice(node("checkout-notice"), "");
    try {
      if (!clientKey) clientKey = globalThis.crypto?.randomUUID?.() || "fold-" + Date.now() + "-" + Math.random().toString(36).slice(2);
      persist();
      const { order } = await api("/api/orders", { ...orderRequest(), idempotencyKey: clientKey });
      finishOrder(order);
    } catch (error) {
      if (!error.status || error.status >= 500 || [408, 409, 429].includes(error.status)) {
        const order = await api("/api/sessions/" + encodeURIComponent(session.id))
          .then(({ session: pinned }) => recoverReceipt(pinned))
          .catch(() => null);
        if (order) finishOrder(order);
        else renderPending();
      } else {
        clientKey = "";
        persist();
        dom.checkoutDialog.innerHTML = `${closeButton()}<div class="dialog-body"><h2 id="checkout-dialog-title">Review your order</h2><p class="notice error" role="alert">${escape(error.message)}</p><button type="button" class="button" data-dialog-close>Back to your order</button></div>`;
        dom.checkoutDialog.querySelector(".dialog-body [data-dialog-close]").focus();
      }
    } finally {
      submitting = false;
    }
  }

  function renderReceipt(order) {
    const pickup = order.pickup || menu?.pickup || { title: "Collect at the bar", description: "Listen for your order number." };
    dom.checkoutDialog.innerHTML = `<div class="dialog-body receipt">
      <span class="empty-icon receipt-mark">${icon("check")}</span>
      <h2 id="checkout-dialog-title">Thanks for ordering!</h2>
      <p class="dialog-description">We’re getting your order ready.</p>
      <p class="eyebrow muted">PICKUP NUMBER</p><p class="receipt-number">${escape(order.number)}</p>
      <div class="receipt-pickup"><strong>${escape(pickup.title)}</strong><p>${escape(pickup.description)}</p></div>
      <p class="dialog-meta">${escape(order.storeName)} · Menu v${escape(order.version)} · ${money(order.totalCents)}</p>
      <div class="dialog-actions"><button type="button" class="button primary" data-new-order>Start a new order</button></div>
    </div>`;
    if (!dom.checkoutDialog.open) dom.checkoutDialog.showModal();
    dom.checkoutDialog.querySelector("[data-new-order]").focus();
  }

  async function restartAfterReceipt() {
    if (!receipt) return;
    checkoutTrigger = null;
    dom.checkoutDialog.close();
    await loadShop({ fresh: true });
    dom.search.focus({ preventScroll: true });
    announce("A new order is ready to start.");
  }

  dom.products.addEventListener("click", (event) => {
    const button = event.target.closest("[data-product]");
    if (event.target.closest("[data-retry-menu]")) {
      refreshDevices().catch(() => {}).finally(() => loadShop());
    }
    if (event.target.closest("[data-menu-more]")) {
      const next = visibleLimit;
      visibleLimit += pageSize;
      renderMenu(next);
    }
    if (!button || !menu || receipt) return;
    editItem(menu.items.find((item) => item.id === button.dataset.product), null, button);
  });
  dom.categories.addEventListener("click", (event) => {
    const button = event.target.closest("[data-category]");
    if (!button || !menu) return;
    category = button.dataset.category;
    visibleLimit = pageSize;
    dom.categories.querySelectorAll("button").forEach((entry) =>
      entry.setAttribute("aria-pressed", String(entry === button))
    );
    renderMenu();
  });
  dom.search.addEventListener("input", () => {
    if (!menu) return;
    visibleLimit = pageSize;
    renderMenu();
  });
  dom.device.addEventListener("change", () => {
    deviceId = dom.device.value;
    const url = new URL(location.href);
    url.searchParams.set("device", deviceId);
    history.replaceState(null, "", url);
    loadShop();
  });
  dom.mode.addEventListener("click", (event) => {
    const button = event.target.closest("[data-mode]");
    if (!button || !session) return;
    const next = button.dataset.mode === "dine-in" ? "here" : "to-go";
    if (next === fulfillment) return;
    fulfillment = next;
    changeCart();
  });
  dom.cartItems.addEventListener("click", (event) => {
    const editor = event.target.closest("[data-edit]");
    const action = event.target.closest("[data-step]");
    if (editor) {
      const index = Number(editor.dataset.edit);
      editItem(menu.items.find((item) => item.id === cart[index].itemId), index, editor);
    }
    if (!action) return;
    const index = Number(action.dataset.line);
    const line = cart[index];
    const quantity = line.quantity + Number(action.dataset.step);
    if (quantity < 1) {
      announce("Item removed from your order.");
      cart.splice(index, 1);
    } else {
      line.quantity = Math.min(quantity, maxQuantity);
    }
    changeCart('[data-line="' + Math.min(index, cart.length - 1) + '"][data-step="' + action.dataset.step + '"]');
  });
  dom.itemDialog.addEventListener("close", () => {
    itemEditor = null;
    if (itemTrigger?.isConnected) itemTrigger.focus({ preventScroll: true });
    itemTrigger = null;
    refreshDevices().catch(() => {});
  });
  dom.itemDialog.addEventListener("change", (event) => {
    if (!event.target.matches("input[type=radio]")) return;
    const { name, value } = event.target;
    if (value) itemEditor.modifiers[name] = value;
    else delete itemEditor.modifiers[name];
    updateEditorPrice();
  });
  dom.itemDialog.addEventListener("click", (event) => {
    if (event.target.closest("[data-dialog-close]")) dom.itemDialog.close();
    const button = event.target.closest("[data-step]");
    if (!button) return;
    const { item } = itemEditor;
    itemEditor.quantity = Math.max(1, Math.min(maxQuantity, itemEditor.quantity + Number(button.dataset.step)));
    node("editor-stepper").innerHTML = stepper(itemEditor.quantity, item.name);
    const same = node("editor-stepper").querySelector('[data-step="' + button.dataset.step + '"]');
    const focus = !same.disabled ? same : node("editor-stepper").querySelector("button:not(:disabled)");
    focus?.focus();
    updateEditorPrice();
  });
  dom.itemDialog.addEventListener("submit", saveItem);
  dom.checkout.addEventListener("click", openCheckout);
  dom.mobileCart.addEventListener("click", () => {
    dom.cart.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
    dom.cart.focus({ preventScroll: true });
  });
  dom.checkoutDialog.addEventListener("cancel", (event) => {
    if (submitting || receipt || clientKey) event.preventDefault();
  });
  dom.checkoutDialog.addEventListener("close", () => {
    checkoutTrigger?.focus({ preventScroll: true });
    checkoutTrigger = null;
  });
  dom.checkoutDialog.addEventListener("click", (event) => {
    if (event.target.closest("[data-dialog-close]") && !submitting && !clientKey) dom.checkoutDialog.close();
    if (event.target.closest("[data-place-order]")) placeOrder(event);
    if (event.target.closest("[data-new-order]")) restartAfterReceipt();
    if (event.target.closest("[data-retry-quote]") && !awaitingQuote) quoteOrder();
  });

  async function initialize() {
    await refreshDevices().catch(() => {});
    await loadShop();
    if ("EventSource" in window) {
      const events = new EventSource("/api/events");
      events.addEventListener("message", (event) => {
        try {
          if (JSON.parse(event.data).type === "fleet") refreshDevices().catch(() => {});
        } catch { /* Ignore events from other protocol versions. */ }
      });
    }
    setInterval(() => refreshDevices().catch(() => {}), 12000);
  }
  initialize();
})();
