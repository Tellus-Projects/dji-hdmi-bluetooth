/* DJI-HDMI Bluetooth: keeps the page available without Internet (in the
 * field, the phone often has none). Cache first, refreshed when online. */
"use strict";

const CACHE = "djihdmi-bluetooth-v4";
const FILES = ["./", "index.html", "app.js", "style.css", "icon.svg",
  "manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(caches.open(CACHE).then(async (cache) => {
    const cached = await cache.match(event.request);
    const fresh = fetch(event.request).then((resp) => {
      if (resp.ok) cache.put(event.request, resp.clone());
      return resp;
    }).catch(() => cached);
    return cached || fresh;
  }));
});
