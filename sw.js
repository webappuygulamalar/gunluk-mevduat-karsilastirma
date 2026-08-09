const CACHE_NAME = "gunluk-mevduat-v10";
const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./data/banks.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

async function networkFirst(request, fetchInit) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = fetchInit
      ? await fetch(request, fetchInit)
      : await fetch(request);
    if (response && response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);
  const isBankData = url.pathname.endsWith("/data/banks.json");

  // Her açılışta önce ağdan güncel veri denenir; internet yoksa önbellekteki
  // son sürüme düşülür. banks.json için tarayıcı HTTP önbelleği de devre
  // dışı bırakılır, aksi halde eski oranlar bir süre daha görünmeye devam edebilir.
  event.respondWith(
    networkFirst(event.request, isBankData ? { cache: "no-store" } : undefined)
  );
});
