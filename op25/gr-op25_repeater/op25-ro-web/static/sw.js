const CACHE_VERSION = "almr-shell-v1";
const SHELL_ASSETS = [
  "/",
  "/config.js",
  "/static/style.css",
  "/static/app.js?v=4",
  "/static/chart.umd.min.js",
  "/static/version.json",
  "/static/favicon.ico",
  "/static/manifest.webmanifest"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (event.request.method !== "GET") return;

  // Never cache live audio/data endpoints.
  if (url.pathname.startsWith("/stream") || url.pathname.startsWith("/api/") || url.pathname.startsWith("/ingest/")) {
    return;
  }

  // Navigation: network first, fallback to cached app shell.
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((resp) => {
          const copy = resp.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put("/", copy));
          return resp;
        })
        .catch(() => caches.match("/").then((r) => r || caches.match("/index.html")))
    );
    return;
  }

  // Static assets: stale-while-revalidate.
  if (url.pathname.startsWith("/static/") || url.pathname === "/config.js") {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        const network = fetch(event.request)
          .then((resp) => {
            const copy = resp.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, copy));
            return resp;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
  }
});
