// Turnaround service worker: makes the app open instantly and work offline.
const VERSION = "13e9510038-9c125281";
const CACHE = "ta-" + VERSION;
const SHELL = ["./", "./index.html", "./styles.css", "./platform.js", "./config.js", "./manifest.webmanifest",
  "./vendor/supabase.js", "./vendor/jspdf.umd.min.js", "./icons/icon-192.png", "./icons/apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("ta-") && k !== CACHE && k !== "ta-fonts").map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Fonts: cache first, forever.
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    e.respondWith(caches.open("ta-fonts").then(c => c.match(req).then(hit => hit || fetch(req).then(res => { c.put(req, res.clone()); return res; }))));
    return;
  }
  if (url.origin !== self.location.origin) return; // Supabase and AI calls go straight to the network
  // Pages: network first so updates show up, cached copy when offline.
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put("./index.html", copy)); return res; })
      .catch(() => caches.match("./index.html")));
    return;
  }
  // App files: serve from cache, refresh in the background.
  e.respondWith(caches.open(CACHE).then(c => c.match(req, { ignoreSearch: true }).then(hit => {
    const net = fetch(req).then(res => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => hit);
    return hit || net;
  })));
});

// Reminders: show the notification, keep the Home Screen badge in step, open the app on tap.
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { title: "Turnaround", body: e.data ? e.data.text() : "" }; }
  e.waitUntil((async () => {
    const opts = { body: d.body || "", icon: "icons/icon-192.png", badge: "icons/icon-192.png", data: { hash: d.hash || "#today" } };
    if (d.tag) { opts.tag = d.tag; opts.renotify = true; }
    await self.registration.showNotification(d.title || "Turnaround", opts);
    try { if (self.navigator && self.navigator.setAppBadge) { const n = (await self.registration.getNotifications()).length; await self.navigator.setAppBadge(d.badge || n || 1); } } catch (x) {}
  })());
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const hash = (e.notification.data && e.notification.data.hash) || "#today";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const c of list) { c.postMessage({ type: "open", hash }); if ("focus" in c) return c.focus(); }
    return self.clients.openWindow(new URL("./" + hash, self.registration.scope).href);
  }));
});
