const CACHE_NAME = "wealth-tracker-pwa-v24";
const APP_SHELL = [
  "./",
  "./index.html",
  "./demo-ledger.json",
  "./README.md?v=20260802-v23",
  "./PROJECT_CONTEXT.md?v=20260802-v23",
  "./wealth_tracker.svg",
  "./wealth_tracker-180.png?v=20260802-v23",
  "./wealth_tracker-192.png?v=20260802-v23",
  "./wealth_tracker-512.png?v=20260802-v23",
  "./manifest.webmanifest?v=20260802-v23"
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(()=>self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key.startsWith("wealth-tracker-pwa-") && key !== CACHE_NAME)
        .map(key => caches.delete(key))
    )).then(()=>self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  if(event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if(url.origin !== self.location.origin) return;

  if(event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).then(response => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put("./index.html", copy));
        return response;
      }).catch(() => caches.match("./index.html"))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
      if(response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
      }
      return response;
    }))
  );
});
