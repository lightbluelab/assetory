const CACHE_NAME = "assetory-pwa-v35";
const APP_SHELL = [
  "./",
  "./index.html",
  "./assetory.html",
  "./guide.html",
  "./assetory-demo-ledger.json",
  "./README.md?v=20260810-v35",
  "./PROJECT_CONTEXT.md?v=20260810-v35",
  "./assets/images/assetory.svg",
  "./assets/images/hero-asset-journal.svg",
  "./assets/images/assetory-180.png?v=20260810-v35",
  "./assets/images/assetory-192.png?v=20260810-v35",
  "./assets/images/assetory-512.png?v=20260810-v35",
  "./manifest.webmanifest?v=20260810-v35"
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(()=>self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => (key.startsWith("assetory-pwa-") || key.startsWith("wealth-tracker-pwa-")) && key !== CACHE_NAME)
        .map(key => caches.delete(key))
    )).then(()=>self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  if(event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if(url.origin !== self.location.origin) return;

  if(event.request.mode === "navigate") {
    const pagePath = url.pathname.endsWith("assetory.html") ? "./assetory.html" : "./index.html";
    event.respondWith(
      fetch(event.request).then(response => {
        if(response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(pagePath, copy));
        }
        return response;
      }).catch(() => caches.match(pagePath))
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
