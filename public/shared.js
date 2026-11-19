"use strict";

const Fold = (() => {
  const icons = {
    pin: '<path d="M20 10c0 5-8 10-8 10s-8-5-8-10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
    sliders: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2" fill="currentColor"/><circle cx="15" cy="17" r="2" fill="currentColor"/>',
    search: '<circle cx="10.7" cy="10.7" r="5.7"/><path d="m15 15 4 4"/>',
    cup: '<path d="M3.5 6.5h13v5a5 5 0 0 1-5 5h-3a5 5 0 0 1-5-5v-5Zm13 1h1.8a2.7 2.7 0 0 1 0 5.4h-2M2.5 20h17"/>',
    bag: '<path d="M5 7.5h14l1.3 13H3.7L5 7.5Z"/><path d="M9 9V6a3 3 0 1 1 6 0v3"/>',
    arrow: '<path d="M4 12h15m-6-6 6 6-6 6"/>',
    info: '<circle cx="12" cy="12" r="8"/><path d="M12 11v5m0-8h.01"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    check: '<path d="m5 12 4.5 4.5L19 7"/>',
    layers: '<path d="m3 8 9-4 9 4-9 4-9-4Zm0 4 9 4 9-4M3 16l9 4 9-4"/>',
    store: '<path d="M4 11v9h16v-9M2.5 10 5 4h14l2.5 6c-.8 2-3 2.5-4.5.8-1.4 1.7-3.5 1.7-5 0-1.5 1.7-3.6 1.7-5 0-1.5 1.7-3.7 1.2-4.5-.8ZM10 20v-5h4v5"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5l3 2"/>',
    screen: '<rect x="3" y="4.5" width="18" height="12" rx="1.5"/><path d="M8 20h8m-4-3.5V20"/>',
    shield: '<path d="M12 21s7-3.3 7-9.5v-6L12 3 5 5.5v6C5 17.7 12 21 12 21Z"/><path d="m9 12 2 2 4-4"/>',
    refresh: '<path d="M20 8a8 8 0 1 0 .3 7M20 4v5h-5"/>',
  };
  const replacements = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => replacements[character]);
  const icon = (name) => '<svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + (icons[name] || "") + '</svg>';
  const money = (cents) => currency.format((Number(cents) || 0) / 100);

  async function api(path, body) {
    const options = body === undefined ? { cache: "no-store" } : {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    };
    let response;
    try {
      response = await fetch(path, options);
    } catch {
      throw new Error("The kiosk service is unavailable. Check the connection and try again.");
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || "Something went wrong. Please try again.");
      error.status = response.status;
      error.code = data.code;
      throw error;
    }
    return data;
  }

  function image(item) {
    const key = String(item.image || item.id || "");
    if (/^\/images\/[a-z0-9_-]+\.(webp|png|jpg|jpeg)$/i.test(key)) return key;
    return "/images/" + (/^[a-z0-9_-]+$/i.test(key) ? key : "hero") + ".webp";
  }

  function showNotice(node, message, tone = "") {
    node.hidden = !message;
    node.textContent = message;
    node.classList.toggle("error", tone === "error");
    node.classList.toggle("success", tone === "success");
  }

  document.querySelectorAll("[data-icon]").forEach((element) => {
    element.innerHTML = icon(element.dataset.icon);
  });

  document.addEventListener("error", (event) => {
    const failed = event.target;
    if (failed instanceof HTMLImageElement && failed.dataset.fallback !== undefined) {
      if (!failed.src.endsWith("/images/hero.webp")) {
        failed.src = "/images/hero.webp";
      } else {
        failed.hidden = true;
      }
    }
  }, true);

  return { api, escape, icon, image, money, showNotice };
})();
