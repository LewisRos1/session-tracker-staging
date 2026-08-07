// ============================================================
// SW.JS — Service Worker (PWA offline shell caching)
// Firebase SDK handles Firestore data offline independently.
// ============================================================

const CACHE_NAME = "therapy-tracker-v1503";

// App shell files to pre-cache
const SHELL_URLS = [
  "/",
  "/index.html",
  "/styles.css",
  "/config.js",
  "/app.js",
  "/firebase-service.js",
  "/export.js",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
  "/Daisy Word Doc Stamp.png",
  "/ZORA Logo for AI Report.png"
];

// Client sends "skipWaiting" when it detects a new SW is installed and ready.
self.addEventListener("message", event => {
  if (event.data === "skipWaiting") self.skipWaiting();
});

// Install: cache app shell and skip waiting immediately so new SW always activates.
self.addEventListener("install", event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => Promise.allSettled(
        SHELL_URLS.map(url => cache.add(new Request(url, { cache: "reload" })))
      ))
      .catch(() => {})
  );
});

// Activate: remove old caches, then broadcast version so clients reload even if
// controllerchange didn't fire (common on iOS WebKit in standalone PWA mode).
self.addEventListener("activate", event => {
  const version = CACHE_NAME.replace("therapy-tracker-v", "");
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    // claim() first so matchAll only returns clients in this SW's own scope,
    // not uncontrolled clients from other paths on the same github.io origin.
    ).then(() => self.clients.claim())
    .then(() =>
      self.clients.matchAll({ type: "window" })
        .then(clients => clients.forEach(c => c.postMessage({ type: "swActivated", version })))
    )
  );
});

// Fetch: network-first for local shell (always get latest); offline falls back to cache
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);

  // External requests (Firebase, CDN) — always network, don't intercept
  if (url.origin !== self.location.origin) return;

  // Local — try network first, cache the response, fall back to cache if offline
  // Use cache:"no-cache" so the browser's HTTP cache never serves stale files.
  const freshReq = new Request(event.request, { cache: "no-cache" });
  event.respondWith(
    fetch(freshReq).then(resp => {
      if (resp && resp.status === 200) {
        const clone = resp.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
      }
      return resp;
    }).catch(() => caches.match(event.request))
  );
});
