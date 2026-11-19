"use strict";

const cacheName = "fold-register-shell-v1";
const pages = new Set(["/", "/register", "/register/", "/register.html"]);
const assets = [
  "/register.html", "/style.css", "/register.css", "/shared.js", "/register-workflow.js", "/register.js",
  "/favicon.svg", "/fonts/instrument-serif.woff2", "/fonts/dm-sans.woff2"
];
const staticPaths = new Set(assets);

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(cacheName).then((cache) => cache.addAll(assets)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const existing of await caches.keys()) {
      if (existing.startsWith("fold-register-shell-") && existing !== cacheName) await caches.delete(existing);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  const navigation = request.mode === "navigate";
  const path = url.pathname;
  if (navigation ? !pages.has(path) : !staticPaths.has(path)) return;
  const key = navigation ? "/register.html" : path;
  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok) {
        try { await (await caches.open(cacheName)).put(key, response.clone()); } catch { /* Use the online response. */ }
        return response;
      }
      if (response.status < 500) return response;
      return await (await caches.open(cacheName)).match(key) || response;
    } catch {
      return await (await caches.open(cacheName)).match(key) || Response.error();
    }
  })());
});
