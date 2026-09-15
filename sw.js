const CACHE_NAME = "gunluk-mevduat-v18";
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

  // Supabase istekleri bu service worker tarafından hiç ele alınmaz: her
  // zaman doğrudan tarayıcı/ağa gider ve önbelleğe alınmaz. Böylece onaylı
  // oranlar her açılışta güncel okunur; bir ağ hatası da normal şekilde
  // reddedilip app.js'in kendi data/banks.json yedeğine düşmesini sağlar
  // (burada eski bir Supabase yanıtıyla sessizce maskelenmez).
  if (url.hostname.endsWith(".supabase.co")) return;

  // Admin paneli (admin.html/js/css) bu service worker'ın APP_SHELL'inin
  // parçası DEĞİLDİR ve asla önbelleğe alınmamalıdır — sw.js kayıtı
  // index.html/app.js üzerinden yapılıp scope kökü kapsadığından, admin.html
  // hiç kendi service worker'ını kaydetmese bile aynı scope altında bu
  // worker'ın fetch handler'ına tabi olur. Daha önce (v16 ve öncesi)
  // networkFirst ile "önce ağ, olmazsa önbellek" uygulanıyordu; ağ isteği
  // her zaman başarılı olsa bile yanıt yine de cache.put ile saklanıyordu —
  // bu da bir sonraki sürüm admin dosyaları DEĞİŞTİĞİNDE, o an aktif olan
  // ESKİ service worker (henüz yeni sw.js'e geçiş yapmamış) hâlâ kendi eski
  // CACHE_NAME'i altında admin.* için networkFirst çalıştırmaya devam eder
  // ve ağ yanıtı gecikir/başarısız olursa eski admin paneli servis
  // edilebilirdi. Artık admin.* ve sw.js'in kendisi bu worker tarafından
  // TAMAMEN görmezden gelinir — tarayıcı bu istekleri doğrudan ağa
  // gönderir, hiçbir Cache Storage kaydı oluşmaz/okunmaz.
  if (url.pathname.endsWith("/admin.html") || url.pathname.endsWith("/admin.js") ||
      url.pathname.endsWith("/admin.css") || url.pathname.endsWith("/sw.js")) {
    return;
  }

  const isBankData = url.pathname.endsWith("/data/banks.json");

  // Her açılışta önce ağdan güncel veri denenir; internet yoksa önbellekteki
  // son sürüme düşülür. banks.json için tarayıcı HTTP önbelleği de devre
  // dışı bırakılır, aksi halde eski oranlar bir süre daha görünmeye devam edebilir.
  event.respondWith(
    networkFirst(event.request, isBankData ? { cache: "no-store" } : undefined)
  );
});
