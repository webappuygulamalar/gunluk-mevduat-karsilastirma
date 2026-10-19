// check-bank-rates — günlük banka oranı kontrol otomasyonu.
//
// Her banka/ürün için resmi kaynak sayfasını (bank_sources.requires_manual_check
// = false olanlar) çeker, kendi kendine doğrular, mevcut aktif bank_rates ile
// karşılaştırır. HİÇBİR ZAMAN bank_rates'e doğrudan yazmaz: bir farklılık
// bulunduğunda yalnızca rate_change_requests'e 'pending' bir talep + evidence
// ile birlikte rate_check_findings'e bir kayıt ekler — aynen bir editörün admin
// panelinden yapacağı gibi. Ayrıştırma güvenle doğrulanamazsa (sayfa yapısı
// değişmiş, sayı makul aralıkta değil, beklenen kademe sayısı tutmuyor vb.)
// asla tahmini veri üretmez; 'parse_error' olarak işaretler ve mevcut orana
// dokunmaz. requires_manual_check=true olan kaynaklar hiç fetch edilmez,
// doğrudan 'manuel kontrol gerekli' bulgusu üretir — ama yine de HER ÜRÜN her
// çalışmada bir sonuç kaydı alır.
//
// Yetkilendirme: `x-cron-secret` header'ı CRON_SECRET ortam değişkeniyle
// eşleşmeli, YA DA geçerli bir admin JWT'si (Authorization: Bearer ...)
// gönderilmeli (admin panelindeki "Şimdi Kontrol Et" düğmesi). İkisi de
// sağlanmazsa 401 döner. CRON_SECRET/SERVICE_ROLE_KEY hiçbir yanıt gövdesine
// veya log satırına yazılmaz.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { DOMParser, type Element } from "jsr:@b-fuze/deno-dom@0.1.48";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET");

const FETCH_TIMEOUT_MS = 15000;
// Yapı Kredi'nin ikinci resmi kaynağı: mobilden yeni müşteri hoş geldin
// kampanya sayfası — yalnızca EK bir aday oranı okumak için kullanılır,
// ana ürün sayfası (bank_sources.source_url) zaten zorunlu/birincil kaynaktır.
const YK_CAMPAIGN_URL = "https://www.yapikredi.com.tr/kampanyalar/detay/253761";
const MIN_PLAUSIBLE_RATE = 0.03; // %3
const MAX_PLAUSIBLE_RATE = 1.2; // %120
const EPS_MONEY = 1; // TL toleransı (yuvarlama)
const EPS_RATE = 0.0005; // oran toleransı (yüzde puanı olarak %0.05)

// ---------------------------------------------------------------------------
// CORS — tarayıcıdan gelen istekler (admin panelindeki "Şimdi Kontrol Et")
// ---------------------------------------------------------------------------
//
// Kök neden: bu fonksiyon önceden OPTIONS preflight'a hiç yanıt vermiyor ve
// hiçbir yanıtına Access-Control-Allow-Origin eklemiyordu. Tarayıcı,
// Authorization/apikey/Content-Type başlıkları taşıyan bir POST'tan önce
// otomatik olarak bir OPTIONS preflight gönderir; sunucu bunu karşılamayınca
// tarayıcı isteği hiç göndermeden "Failed to fetch" ile engeller. Cron/retry
// çağrıları pg_net üzerinden (tarayıcı DEĞİL) geldiği için Origin header'ı
// taşımaz ve bu mekanizmadan hiç etkilenmez.
//
// CORS yalnızca "hangi tarayıcı origin'i bu yanıtı okuyabilir" sorusuna
// cevap verir — YETKİLENDİRME DEĞİLDİR. Origin izinli olsa bile admin
// JWT / x-cron-secret kontrolü ayrıca ve değişmeden uygulanır.
const ALLOWED_ORIGINS = new Set([
  "https://webappuygulamalar.github.io",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
]);

// Origin tam eşleşmeli — listede yoksa (veya Origin header'ı hiç yoksa,
// örn. cron/retry çağrılarında) null döner ve Access-Control-Allow-Origin
// HİÇ eklenmez. Rastgele origin'e asla "*" verilmez.
function getAllowedOrigin(req: Request): string | null {
  const origin = req.headers.get("origin");
  if (origin && ALLOWED_ORIGINS.has(origin)) return origin;
  return null;
}

// Vary: Origin HER ZAMAN eklenir (origin'e göre farklı yanıt üretildiği
// için önbellekleme doğruluğu adına) — Access-Control-Allow-* başlıkları
// yalnızca origin izinliyse eklenir.
function corsHeaders(req: Request): HeadersInit {
  const allowedOrigin = getAllowedOrigin(req);
  const headers: Record<string, string> = { Vary: "Origin" };
  if (allowedOrigin) {
    headers["Access-Control-Allow-Origin"] = allowedOrigin;
    headers["Access-Control-Allow-Headers"] = "authorization, x-client-info, apikey, content-type";
    headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
  }
  return headers;
}

// Fonksiyondaki HER Response bunun üzerinden döner — tekil bir yerde CORS
// başlıkları eklenir, unutulma riski olmaz. service_role/CRON_SECRET asla
// gövdeye veya başlığa yazılmaz (yalnızca sunucu-içi env değişkeni olarak
// kalır).
function jsonResponse(req: Request, body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(req) },
  });
}

// ---------------------------------------------------------------------------
// Türkçe sayı/yüzde biçimlendirme yardımcıları
// ---------------------------------------------------------------------------

/** "43,00%" veya "%43,00" -> 0.43 */
export function parseTRPercent(raw: string): number | null {
  const cleaned = raw.replace(/%/g, "").replace(/\s/g, "").trim();
  if (!cleaned) return null;
  const normalized = cleaned.replace(/\./g, "").replace(",", ".");
  const n = Number(normalized);
  if (!Number.isFinite(n)) return null;
  return n / 100;
}

/** "7.500" veya "7.500 TL" veya "25.000,01" -> 7500 / 25000.01 (TR formatı: "." binlik ayırıcı, "," ondalık ayırıcı). */
export function parseTRMoney(raw: string): number | null {
  const cleaned = raw.replace(/TL/gi, "").replace(/\s/g, "").trim();
  if (!cleaned) return null;
  // TR sayı biçimi: binlik ayırıcı HER ZAMAN "." — kaldırılır. Ondalık
  // ayırıcı "," — ondalık noktasına çevrilir (ör. Odeabank'ın bant
  // sınırlarında görülen "25.000,01" gibi gerçek kuruş değerleri için).
  const normalized = cleaned.replace(/\./g, "").replace(",", ".");
  const n = Number(normalized);
  if (!Number.isFinite(n)) return null;
  return n;
}

function textOf(el: Element | null | undefined): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

// Ham HTML üzerinde DOĞRUDAN substring araması YAPILMAZ: bazı sayfalar Türkçe
// karakterleri (ör. "ı") sayısal HTML varlığı olarak encode eder (ör.
// "Oranı" -> "Oran&#305;") — bu durumda ham metin araması yanlışlıkla "sayfa
// yapısı değişmiş" sonucuna varır (Akbank'ta 2026-09-15'te tam olarak bu
// yaşandı). Bunun yerine sayfa DOM'a ayrıştırılıp textContent (entity'leri
// otomatik decode eden) üzerinden aranır. DOM ayrıştırma başarısız olursa
// (gerçekten bozuk HTML), yine de ham metne düşülür — güvenlik kaybı yok,
// yalnızca yanlış-pozitif riski azalıyor.
export function markerSearchText(html: string): string {
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const text = doc ? textOf(doc.body ?? doc.documentElement) : null;
    return text && text.length > 0 ? text : html;
  } catch {
    return html;
  }
}

// ---------------------------------------------------------------------------
// Ortak tipler
// ---------------------------------------------------------------------------

export interface RateCandidate {
  column: string;
  rate: number;
}

export interface ParsedBand {
  alt_limit: number;
  ust_limit: number;
  yillik_brut_oran: number;
  vadesizde_kalacak: number;
  vadesiz_hesaplama_tipi: "sabit" | "yuzde";
  vadesiz_oran: number | null;
  // Kaynak sayfadan ayrıştırılan HAM metin değerleri (normalize edilmeden
  // önce) — admin panelinde "ham kaynak değeri" olarak ayrıca gösterilir.
  // Her parser doldurmak zorunda değil (opsiyonel); doldurmayanlar için
  // admin panelinde yalnızca normalize edilmiş değer gösterilir.
  raw?: Record<string, string>;
  // "En yüksek resmi aday oranı" politikası için denetim izi: aynı satırdaki
  // TÜM aday oranlar, hangi sütunun/koşulun seçildiği ve hangi kaynak
  // tablodan okunduğu. Tek adaylı (yalnızca bir sütunlu) ürünlerde
  // (ör. TOM Bank, Akbank) doldurulmaz.
  selected_rate_column?: string;
  selected_rate_condition?: string;
  observed_rate_candidates?: RateCandidate[];
  source_table_name?: string;
}

export interface ParseResult {
  ok: boolean;
  bands: ParsedBand[];
  rawTierCount: number;
  error?: string;
}

export function fail(error: string): ParseResult {
  return { ok: false, bands: [], rawTierCount: 0, error };
}

// ---------------------------------------------------------------------------
// Banka-özel ayrıştırıcılar — her biri sadece kendi doğrulanmış sayfa
// yapısına güvenir; yapı beklenmedikse tahmin üretmez, hata döner.
// ---------------------------------------------------------------------------

export function parseTomBank(html: string): ParseResult {
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (!doc) return fail("HTML ayrıştırılamadı");

  const table = doc.querySelector("table.limit-table");
  if (!table) return fail('table.limit-table bulunamadı — sayfa yapısı değişmiş olabilir');

  const rows = Array.from(table.querySelectorAll("tbody tr"));
  if (rows.length === 0) return fail("tbody satırı bulunamadı");

  const bands: ParsedBand[] = [];
  for (const row of rows) {
    const cells = Array.from(row.querySelectorAll("td"));
    if (cells.length < 4) return fail(`Beklenmeyen hücre sayısı: ${cells.length}`);

    const rateRaw = textOf(cells[0]);
    const altRaw = textOf(cells[1]);
    const ustRaw = textOf(cells[2]);
    const vadesizRaw = textOf(cells[3]);

    const rate = parseTRPercent(rateRaw);
    const alt = parseTRMoney(altRaw);
    const ust = parseTRMoney(ustRaw);
    const vadesiz = parseTRMoney(vadesizRaw);

    if (rate === null || alt === null || ust === null || vadesiz === null) {
      return fail(`Sayısal alan ayrıştırılamadı (satır: ${textOf(row)})`);
    }

    bands.push({
      alt_limit: alt,
      ust_limit: ust,
      yillik_brut_oran: rate,
      vadesizde_kalacak: vadesiz,
      vadesiz_hesaplama_tipi: "sabit",
      vadesiz_oran: null,
      raw: {
        "Oran (kaynak sütunu)": rateRaw,
        "Alt Limit (kaynak sütunu)": altRaw,
        "Üst Limit (kaynak sütunu)": ustRaw,
        "Vadesiz Alt Limit (kaynak sütunu)": vadesizRaw,
      },
    });
  }

  // Kaynak sayfa ardışık bantları tam sayı "x-1 TL üst / x TL alt" kalıbıyla
  // yazıyor (ör. üst=7.499.999, sonraki bandın alt=7.500.000). TOM Bank'ın
  // yerleşik kuruş-hassasiyetli kuralı (2026-09-08 olayında elle düzeltilen
  // ilk bant ile aynı desen): ÜST sınır kuruş bazında düşürülür
  // (next_alt_limit - 0,01); SONRAKİ bandın temiz/yuvarlak alt limiti
  // DEĞİŞTİRİLMEZ. Bu, Alternatifbank'ın (orada ALT limit yükseltilir)
  // TERSİ yönde bir normalizasyon — her ikisi de aynı amaca hizmet eder: TL
  // kuruşlarında bant boşluğu kalmasın. Ham kaynak üst limit metni
  // ("Üst Limit (kaynak sütunu)") DEĞİŞTİRİLMEDEN raw'da kalır; normalize
  // gerekçesi ayrıca eklenir. Normalizasyon SADECE ardışık bantlar
  // arasındaki fark TAM 1 TL olduğunda uygulanır — başka bir boşluk
  // deseninde dokunulmaz (validateBands bunu ayrıca yakalar, tahmin
  // üretilmez). Oranlar HER ZAMAN sayfadan ayrıştırılır, sabit kodlanmaz.
  bands.sort((a, b) => a.alt_limit - b.alt_limit);
  for (let i = 0; i < bands.length - 1; i++) {
    const cur = bands[i];
    const next = bands[i + 1];
    const gap = next.alt_limit - cur.ust_limit;
    if (Math.abs(gap - 1) < 1e-9) {
      const rawUst = cur.ust_limit;
      const normalizedUst = Math.round((next.alt_limit - 0.01) * 100) / 100;
      cur.ust_limit = normalizedUst;
      cur.raw = {
        ...cur.raw,
        raw_source_values: String(rawUst),
        Normalizasyon: "TL kuruşlarında bant boşluğu oluşmaması için üst sınır +0,99 TL normalize edildi",
      };
    }
  }

  return { ok: true, bands, rawTierCount: bands.length };
}

interface FibaKirazRawRow {
  alt: number;
  ust: number;
  rangeRaw: string;
  normalizedUpperBound: boolean;
  vadesiz: number;
  vadesizRaw: string;
  standartOran: number;
  standartRaw: string;
  dijitalOran: number;
  dijitalRaw: string;
  fonluEk: number;
  fonluEkRaw: string;
}

const FIBA_KIRAZ_TABLE_NAME = "Kiraz Hesap Hoş Geldin Faiz Oranları (2026) — TL";
const FIBA_KIRAZ_STANDART_COL = "Standart Hoş Geldin Faiz Oranı";
const FIBA_KIRAZ_DIJITAL_COL = "Görüntülü Bankacılığa ve Dijital Kanallara Özel Hoş Geldin Faiz Oranı";

// Fibabanka Kiraz Hesap'ın hem "Fonlu Kiraz" hem düz "Kiraz Hoş Geldin"
// ürünleri AYNI tabloyu kullanır (sayfada "Fonlu Kiraz Ek Faiz Oranı"
// başlığını içeren tablo — bu, "Kiraz Hesap Hoş Geldin Faiz Oranları (2026)"
// başlığı altındaki TL tablosuyla aynı tablodur). Ham satırları tek yerden
// çıkarır; iki ürün de kendi formülünü bu ham verilerin üzerine uygular.
function parseFibaKirazRawRows(html: string): { ok: true; rows: FibaKirazRawRow[] } | { ok: false; error: string } {
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (!doc) return { ok: false, error: "HTML ayrıştırılamadı" };

  const tables = Array.from(doc.querySelectorAll("table"));
  const table = tables.find((t) => textOf(t.querySelector("thead")).includes("Fonlu Kiraz Ek Faiz Oranı"));
  if (!table) return { ok: false, error: '"Fonlu Kiraz Ek Faiz Oranı" başlıklı tablo bulunamadı — sayfa yapısı değişmiş olabilir' };

  const trs = Array.from(table.querySelectorAll("tbody tr"));
  if (trs.length === 0) return { ok: false, error: "tbody satırı bulunamadı" };

  const rows: FibaKirazRawRow[] = [];
  for (const row of trs) {
    const rangeText = textOf(row.querySelector("th"));
    const tds = Array.from(row.querySelectorAll("td"));
    if (tds.length < 5) return { ok: false, error: `Beklenmeyen hücre sayısı: ${tds.length}` };

    const rangeMatch = rangeText.match(/^([\d.,]+)\s*-\s*([\d.,]+)/);
    if (!rangeMatch) return { ok: false, error: `Tutar aralığı ayrıştırılamadı: "${rangeText}"` };
    const alt = parseTRMoney(rangeMatch[1]);
    const ust = parseTRMoney(rangeMatch[2]);

    const vadesizRaw = textOf(tds[0]);
    const standartRaw = textOf(tds[1]);
    const dijitalRaw = textOf(tds[2]);
    const fonluEkRaw = textOf(tds[4]);
    const vadesiz = parseTRMoney(vadesizRaw);
    const standartOran = parseTRPercent(standartRaw);
    const dijitalOran = parseTRPercent(dijitalRaw);
    const fonluEk = parseTRPercent(fonluEkRaw);

    if (alt === null || ust === null || vadesiz === null || standartOran === null || dijitalOran === null || fonluEk === null) {
      return { ok: false, error: `Sayısal alan ayrıştırılamadı (satır: "${rangeText}")` };
    }

    rows.push({
      alt,
      ust,
      rangeRaw: rangeText,
      normalizedUpperBound: false,
      vadesiz,
      vadesizRaw,
      standartOran,
      standartRaw,
      dijitalOran,
      dijitalRaw,
      fonluEk,
      fonluEkRaw,
    });
  }

  rows.sort((a, b) => a.alt - b.alt);

  // Fibabanka resmi tabloda kuruşları göstermeyip ardışık kademeleri
  // "10.000-24.999 / 25.000-49.999" biçiminde yayımlıyor. Uygulama TL'yi
  // kuruş hassasiyetinde hesapladığı için bu ham sınırlar 24.999,01-24.999,99
  // arasında gerçek bir kapsama boşluğu yaratır. Kaynakta TAM 1 TL geçiş
  // varsa üst sınırı bir sonraki alt sınırdan 0,01 TL eksiğe tamamlarız.
  // Fark başka bir değerse sessizce tahmin yürütmeyip tüm parse'ı durdururuz.
  for (let i = 0; i < rows.length - 1; i++) {
    const current = rows[i];
    const next = rows[i + 1];
    const gap = Math.round((next.alt - current.ust) * 100) / 100;

    if (Math.abs(gap - 1) < 1e-9) {
      current.ust = Math.round((next.alt - 0.01) * 100) / 100;
      current.normalizedUpperBound = true;
      continue;
    }

    if (Math.abs(gap - 0.01) > 1e-9) {
      return {
        ok: false,
        error: `Fibabanka bantları bitişik değil: ${current.rangeRaw} sonrasında ${next.rangeRaw} geliyor (geçiş ${gap} TL).`,
      };
    }
  }

  return { ok: true, rows };
}

export function parseFibabankaFonluKiraz(html: string): ParseResult {
  const raw = parseFibaKirazRawRows(html);
  if (!raw.ok) return fail(raw.error);

  const bands: ParsedBand[] = raw.rows.map((r) => ({
    alt_limit: r.alt,
    ust_limit: r.ust,
    yillik_brut_oran: Math.round((r.dijitalOran + r.fonluEk) * 100000) / 100000,
    vadesizde_kalacak: r.vadesiz,
    vadesiz_hesaplama_tipi: "sabit",
    vadesiz_oran: null,
    raw: {
      "Kaynak tutar aralığı": r.rangeRaw,
      "Faiz İşletilmeyecek Min. Tutar": r.vadesizRaw,
      [FIBA_KIRAZ_DIJITAL_COL]: r.dijitalRaw,
      "Fonlu Kiraz Ek Faiz Oranı": r.fonluEkRaw,
      ...(r.normalizedUpperBound
        ? { Normalizasyon: "TL kuruşlarında bant boşluğu oluşmaması için üst sınır +0,99 TL tamamlandı" }
        : {}),
    },
    selected_rate_column: `${FIBA_KIRAZ_DIJITAL_COL} + Fonlu Kiraz Ek Faiz Oranı`,
    selected_rate_condition: "Fonlu Kiraz: dijital/görüntülü bankacılık hoş geldin oranı + yeterli Fiba Portföy TL fon bakiyesiyle kazanılan ek faiz.",
    observed_rate_candidates: [
      { column: FIBA_KIRAZ_STANDART_COL, rate: r.standartOran },
      { column: FIBA_KIRAZ_DIJITAL_COL, rate: r.dijitalOran },
      { column: `${FIBA_KIRAZ_DIJITAL_COL} + Fonlu Kiraz Ek Faiz Oranı`, rate: Math.round((r.dijitalOran + r.fonluEk) * 100000) / 100000 },
    ],
    source_table_name: FIBA_KIRAZ_TABLE_NAME,
  }));

  return { ok: true, bands, rawTierCount: bands.length };
}

export function parseFibabankaKirazHosgeldin(html: string): ParseResult {
  const raw = parseFibaKirazRawRows(html);
  if (!raw.ok) return fail(raw.error);

  const bands: ParsedBand[] = raw.rows.map((r) => {
    const dijitalWins = r.dijitalOran >= r.standartOran;
    const winningColumn = dijitalWins ? FIBA_KIRAZ_DIJITAL_COL : FIBA_KIRAZ_STANDART_COL;
    const winningRaw = dijitalWins ? r.dijitalRaw : r.standartRaw;
    const winningRate = dijitalWins ? r.dijitalOran : r.standartOran;
    return {
      alt_limit: r.alt,
      ust_limit: r.ust,
      yillik_brut_oran: winningRate,
      vadesizde_kalacak: r.vadesiz,
      vadesiz_hesaplama_tipi: "sabit",
      vadesiz_oran: null,
      raw: {
        "Kaynak tutar aralığı": r.rangeRaw,
        "Faiz İşletilmeyecek Min. Tutar": r.vadesizRaw,
        [winningColumn]: winningRaw,
        ...(r.normalizedUpperBound
          ? { Normalizasyon: "TL kuruşlarında bant boşluğu oluşmaması için üst sınır +0,99 TL tamamlandı" }
          : {}),
      },
      selected_rate_column: winningColumn,
      selected_rate_condition: dijitalWins
        ? "Yalnızca görüntülü bankacılık/dijital kanallardan açılan Kiraz Hesap için geçerli."
        : "Standart (kanal koşulu olmayan) Kiraz Hesap Hoş Geldin oranı.",
      observed_rate_candidates: [
        { column: FIBA_KIRAZ_STANDART_COL, rate: r.standartOran },
        { column: FIBA_KIRAZ_DIJITAL_COL, rate: r.dijitalOran },
      ],
      source_table_name: FIBA_KIRAZ_TABLE_NAME,
    };
  });

  return { ok: true, bands, rawTierCount: bands.length };
}

// Akbank'ın kendi sayfası ".free-plus-table" başlığını/iskeletini sunucu
// tarafında render eder ama HÜCRELERİ BOŞ bırakır — gerçek değerler sayfanın
// KENDİ "/SiteAssets/js/free-plus-table.min.js" script'i tarafından, sayfa
// yüklendikten SONRA bu AYNI ALAN ADINDAKİ (www.akbank.com, üçüncü taraf
// DEĞİL) resmi AJAX uç noktasından çekilip DOM'a enjekte edilir. Bu yüzden
// düz bir HTTP GET ile hücreler her zaman boş gelir — marker/DOM seçici
// düzeltmesi bunu çözemez (2026-09-16'da kullanıcıyla doğrulandı). Çözüm:
// sayfanın kendi script'inin yaptığı AYNI çağrıyı burada tekrarlamak —
// arama motoru/üçüncü taraf kaynak DEĞİL, bankanın resmi endpoint'i.
// Doğrulama/birleştirme/vadesiz-yüzdesi mantığının TAMAMI değişmeden kalır;
// yalnızca HAM kademe verisinin kaynağı (boş HTML tablosu -> JSON API) değişti.
const AKBANK_AJAX_URL =
  "https://www.akbank.com/_layouts/15/Akbank/CalcTools/Ajax.aspx/GetYeniSerbestHesapFaizOranlari";

// AJAX yanıtındaki "amountArray" TR biçiminde DEĞİL — "," burada binlik
// ayırıcı (İngilizce/API biçimi: "10,000 - 499,999"), parseTRMoney'nin
// varsaydığı "," ondalık ayırıcısıyla KARIŞTIRILMAMALI. Bu yüzden ayrı bir
// ayrıştırıcı kullanılır. "periodRateArray" ise "38,50" gibi TR ondalık
// biçiminde geldiği için mevcut parseTRPercent doğrudan kullanılabilir.
function parseAkbankAjaxAmount(raw: string): number | null {
  const cleaned = raw.replace(/,/g, "").trim();
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export async function parseAkbankSerbestPlus(html: string): Promise<ParseResult> {
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (!doc) return fail("HTML ayrıştırılamadı");

  // Vadesiz oranı hâlâ ana sayfanın sabit metninden doğrulanır (bu kısım
  // JS-render'a bağımlı değil, sunucu tarafında zaten mevcut).
  const bodyText = textOf(doc.querySelector("body") ?? doc.documentElement);
  const vadesizMatch = bodyText.match(
    /bakiyesinin\s*%\s*([\d.,]+)['’]?[a-zçğıöşü]*\s+karşılık gelen tutar vadesiz hesapta tutulur/i
  );
  if (!vadesizMatch) {
    return fail('Vadesiz yüzdesi cümlesi ("bakiyesinin %X\'una karşılık gelen tutar vadesiz hesapta tutulur") bulunamadı');
  }
  const vadesizOran = parseTRPercent(vadesizMatch[1] + "%");
  if (vadesizOran === null) return fail(`Vadesiz yüzdesi ayrıştırılamadı: "${vadesizMatch[1]}"`);
  const vadesizYuzde = Math.round(vadesizOran * 100 * 100) / 100; // 0-100 arası

  let ajaxJson: unknown;
  try {
    const res = await fetch(AKBANK_AJAX_URL, {
      method: "POST",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent":
          "Mozilla/5.0 (compatible; GunlukMevduatRateCheck/1.0; +https://webappuygulamalar.github.io/gunluk-mevduat-karsilastirma/)",
      },
      body: JSON.stringify({ currencyCode: "888" }),
    });
    if (!res.ok) return fail(`Akbank faiz oranı servisi HTTP ${res.status} döndürdü`);
    ajaxJson = await res.json();
  } catch (err) {
    return fail(`Akbank faiz oranı servisine erişilemedi: ${err instanceof Error ? err.message : String(err)}`);
  }

  const serviceData = (ajaxJson as { d?: { Data?: { ServiceData?: unknown } } })?.d?.Data?.ServiceData as
    | {
        amountArray?: unknown;
        periodData?: { periodArray?: unknown };
      }
    | undefined;
  const amountArray = serviceData?.amountArray;
  const periodArray = serviceData?.periodData?.periodArray;
  if (!Array.isArray(amountArray) || amountArray.length === 0 || !Array.isArray(periodArray) || periodArray.length === 0) {
    return fail("Akbank faiz oranı servisi beklenen yapıda veri döndürmedi (amountArray/periodArray eksik)");
  }
  // Servis, ürün başına tek bir dönem (gün aralığı) döndürür (periodArrayCount
  // her zaman 1 olarak gözlemlendi) — birden fazla dönem dönerse bu YENİ bir
  // ürün boyutu demektir (QNB'deki vade-bağımlı yapıya benzer); güvenle
  // otomatikleştirilemez, açıkça reddedilir.
  if (periodArray.length > 1) {
    return fail(`Akbank faiz oranı servisi birden fazla vade dönemi döndürdü (${periodArray.length}) — mevcut model tek dönem varsayıyor, manuel inceleme gerekli`);
  }
  const periodRateArray = (periodArray[0] as { periodRateArray?: unknown })?.periodRateArray;
  if (!Array.isArray(periodRateArray) || periodRateArray.length !== amountArray.length) {
    return fail(
      `Akbank faiz oranı servisinde tutar/oran sayısı uyuşmuyor (tutar: ${amountArray.length}, oran: ${Array.isArray(periodRateArray) ? periodRateArray.length : "yok"})`
    );
  }

  type RawTier = { alt: number; ust: number; rate: number };
  const rawTiers: RawTier[] = [];
  for (let i = 0; i < amountArray.length; i++) {
    const label = String(amountArray[i]);
    const rateRaw = String(periodRateArray[i]);
    const rate = parseTRPercent(rateRaw);
    if (rate === null) return fail(`Oran ayrıştırılamadı: "${rateRaw}"`);

    const rangeMatch = label.match(/^([\d,]+)\s*-\s*([\d,]+)$/);
    if (!rangeMatch) return fail(`Tutar aralığı ayrıştırılamadı: "${label}"`);
    const alt = parseAkbankAjaxAmount(rangeMatch[1]);
    const ust = parseAkbankAjaxAmount(rangeMatch[2]);
    if (alt === null || ust === null) return fail(`Tutar aralığı ayrıştırılamadı: "${label}"`);
    rawTiers.push({ alt, ust, rate });
  }

  rawTiers.sort((a, b) => a.alt - b.alt);
  const rawTierCount = rawTiers.length;

  // Ardışık, aynı orana sahip bantları tek bantta birleştir (Akbank'ın
  // veri modelde tutulan bant sayısı, servisteki ham kademe sayısından
  // azdır çünkü vadesiz tutar artık banda özgü sabit bir TL değil, bakiyenin
  // yüzdesi — bant ayrımı yalnızca oran farklıysa anlamlıdır).
  const merged: RawTier[] = [];
  for (const tier of rawTiers) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(last.rate - tier.rate) < EPS_RATE) {
      last.ust = tier.ust;
    } else {
      merged.push({ ...tier });
    }
  }

  // Servis, ardışık kademe sınırlarını TAM ÇAKIŞAN uçlarla verir (ör. "...-
  // 25.000.000" ve hemen ardından "25.000.000-..." — aynı 25.000.000 iki
  // kademede birden görünür). Birleştirmeden SONRA kalan bantlar arasında
  // hâlâ böyle bir tam-çakışma varsa (sonraki.alt === önceki.üst), sonraki
  // bandın alt sınırı +0,01 TL kaydırılır — TOM Bank/Alternatifbank'taki
  // kuruş-boşluğu normalizasyonuyla aynı ilke, burada TERS yönde (boşluk
  // değil çakışma gideriliyor).
  for (let i = 0; i < merged.length - 1; i++) {
    if (merged[i + 1].alt === merged[i].ust) {
      merged[i + 1].alt = Math.round((merged[i + 1].alt + 0.01) * 100) / 100;
    }
  }

  const bands: ParsedBand[] = merged.map((t) => ({
    alt_limit: t.alt,
    ust_limit: t.ust,
    yillik_brut_oran: t.rate,
    vadesizde_kalacak: 0,
    vadesiz_hesaplama_tipi: "yuzde",
    vadesiz_oran: vadesizYuzde,
    raw: { "amountArray (kaynak servis)": JSON.stringify(amountArray), "periodRateArray (kaynak servis)": JSON.stringify(periodRateArray) },
    source_table_name: "GetYeniSerbestHesapFaizOranlari (resmi Akbank servisi)",
  }));

  return { ok: true, bands, rawTierCount };
}

// ---------------------------------------------------------------------------
// Odeabank Oksijen Hesap — yalnızca "Oksijen Hesap* - TL" tablosu (USD/EUR
// tabloları alınmaz). İki ürün de AYNI tabloyu kullanır; "en yüksek resmi
// aday oranı" politikası gereği ikisi de "Hoş Geldin Faiz Oranı" ile "Yeni
// Müşteriye Özel Hoş Geldin Faiz Oranı"ndan yüksek olana karşı karşılaştırılır
// — bu, aynı öneriyi üretmelerine yol açabilir (kasıtlı, admin'e raporlanır).
// ---------------------------------------------------------------------------

interface OdeabankRawRow {
  alt: number;
  ust: number;
  vadesiz: number;
  vadesizRaw: string;
  hosGeldinOran: number;
  hosGeldinRaw: string;
  yeniMusteriOran: number;
  yeniMusteriRaw: string;
}

const ODEA_TABLE_NAME = "Oksijen Hesap* - TL";
const ODEA_HOSGELDIN_COL = "Hoş Geldin Faiz Oranı";
const ODEA_YENI_MUSTERI_COL = "Yeni Müşteriye Özel Hoş Geldin Faiz Oranı";
const ODEA_EXPECTED_ROW_COUNT = 16;
// Sütun adları, sayfanın kendi başlık metinleriyle (ör. "TL-Tutar<br>Aralığı*")
// birebir örtüşecek şekilde, footnote yıldızları/satır sonları temizlendikten
// SONRAKİ hallerine göre yazıldı — bkz. normalizeOdeaHeader().
const ODEA_REQUIRED_HEADERS = [
  "TL-Tutar Aralığı",
  "Vadesiz Alt Limit",
  ODEA_HOSGELDIN_COL,
  ODEA_YENI_MUSTERI_COL,
  "1. Dönem Avantajlı Devam Faiz Oranı",
  "2. Dönem Devam Faiz Oranı",
];

// Başlık karşılaştırması hücre NUMARASINA değil normalize edilmiş ADINA göre
// yapılır: HTML entity'leri (DOMParser zaten decode eder), NBSP (\s zaten
// kapsar), görünmez Unicode karakterler (zero-width space/joiner, BOM),
// satır sonu/çoklu boşluk ve footnote yıldızları (*, **) temizlenir. Türkçe
// karakterler DOKUNULMADAN kalır.
function normalizeOdeaHeader(raw: string): string {
  return raw
    .replace(/[​-‍﻿]/g, "")
    .replace(/\*+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseOdeabankRawRows(html: string): { ok: true; rows: OdeabankRawRow[] } | { ok: false; error: string } {
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (!doc) return { ok: false, error: "HTML ayrıştırılamadı" };

  // .content-box CSS sınıfına veya sabit hücre numaralarına GÜVENİLMEZ:
  // sayfadaki TÜM tablolar taranır, her birinin başlık satırı (thead th,
  // yoksa ilk satırın th'leri) normalize edilip ADIYLA karşılaştırılır.
  // USD/EUR tabloları farklı ilk sütun adı kullandığı için ("USD-Tutar
  // Aralığı" / "EUR-Tutar Aralığı", "TL-Tutar Aralığı" DEĞİL) bu isim
  // eşleşmesiyle zaten elenir; ayrıca gövde metninde "USD"/"EUR" birim
  // ibaresi geçen tablolar ikinci bir güvenlik katmanı olarak da reddedilir.
  const allTables = Array.from(doc.querySelectorAll("table"));
  interface Candidate { table: Element; headerIndex: Map<string, number>; rowCount: number; }
  const headerMatches: Candidate[] = [];
  const rejectedForCurrency: Element[] = [];
  const rejectedForRowCount: { table: Element; rowCount: number }[] = [];

  for (const table of allTables) {
    let headerCells = Array.from(table.querySelectorAll("thead th"));
    if (headerCells.length === 0) headerCells = Array.from(table.querySelectorAll("tr:first-child th"));
    if (headerCells.length === 0) continue;

    const headerIndex = new Map<string, number>();
    headerCells.forEach((th, i) => headerIndex.set(normalizeOdeaHeader(textOf(th)), i));

    const hasAllRequired = ODEA_REQUIRED_HEADERS.every((h) => headerIndex.has(h));
    if (!hasAllRequired) continue;

    if (/\bUSD\b|\bEUR\b/.test(textOf(table))) {
      rejectedForCurrency.push(table);
      continue;
    }

    const rowCount = table.querySelectorAll("tbody tr").length;
    if (rowCount !== ODEA_EXPECTED_ROW_COUNT) {
      rejectedForRowCount.push({ table, rowCount });
      continue;
    }

    headerMatches.push({ table, headerIndex, rowCount });
  }

  if (headerMatches.length === 0) {
    if (rejectedForRowCount.length > 0) {
      return {
        ok: false,
        error: `Gerekli 6 başlığa sahip TL tablosu bulundu ama satır sayısı ${ODEA_EXPECTED_ROW_COUNT} değil (bulunan: ${rejectedForRowCount.map((r) => r.rowCount).join(", ")}) — sayfa yapısı değişmiş olabilir`,
      };
    }
    return {
      ok: false,
      error: `"${ODEA_TABLE_NAME}" tablosu bulunamadı — gerekli 6 başlığın tamamına (${ODEA_REQUIRED_HEADERS.join(", ")}) sahip bir TL tablosu yok. Sayfa yapısı değişmiş olabilir.`,
    };
  }
  if (headerMatches.length > 1) {
    return {
      ok: false,
      error: `Birden fazla tablo TL tablosu kriterlerini (gerekli başlıklar + ${ODEA_EXPECTED_ROW_COUNT} satır) sağlıyor (${headerMatches.length} aday) — güvenle seçilemiyor, tahmin yürütülmedi.`,
    };
  }

  const { table, headerIndex } = headerMatches[0];
  const idxTutar = headerIndex.get("TL-Tutar Aralığı")!;
  const idxVadesiz = headerIndex.get("Vadesiz Alt Limit")!;
  const idxHosGeldin = headerIndex.get(ODEA_HOSGELDIN_COL)!;
  const idxYeniMusteri = headerIndex.get(ODEA_YENI_MUSTERI_COL)!;
  const maxIdx = Math.max(idxTutar, idxVadesiz, idxHosGeldin, idxYeniMusteri);

  const trs = Array.from(table.querySelectorAll("tbody tr"));
  const rows: OdeabankRawRow[] = [];
  for (const row of trs) {
    const tds = Array.from(row.querySelectorAll("td"));
    if (tds.length <= maxIdx) return { ok: false, error: `Beklenmeyen hücre sayısı: ${tds.length}` };

    const rangeText = textOf(tds[idxTutar]);
    const rangeMatch = rangeText.match(/^([\d.,]+)\s*-\s*([\d.,]+)$/);
    if (!rangeMatch) return { ok: false, error: `Tutar aralığı ayrıştırılamadı: "${rangeText}"` };
    const alt = parseTRMoney(rangeMatch[1]);
    const ust = parseTRMoney(rangeMatch[2]);

    const vadesizRaw = textOf(tds[idxVadesiz]);
    const hosGeldinRaw = textOf(tds[idxHosGeldin]);
    const yeniMusteriRaw = textOf(tds[idxYeniMusteri]);
    const vadesiz = parseTRMoney(vadesizRaw);
    const hosGeldinOran = parseTRPercent(hosGeldinRaw);
    const yeniMusteriOran = parseTRPercent(yeniMusteriRaw);

    if (alt === null || ust === null || vadesiz === null || hosGeldinOran === null || yeniMusteriOran === null) {
      return { ok: false, error: `Sayısal alan ayrıştırılamadı (satır: "${rangeText}")` };
    }

    rows.push({ alt, ust, vadesiz, vadesizRaw, hosGeldinOran, hosGeldinRaw, yeniMusteriOran, yeniMusteriRaw });
  }

  if (rows.length !== ODEA_EXPECTED_ROW_COUNT) {
    return { ok: false, error: `Beklenen bant sayısı (${ODEA_EXPECTED_ROW_COUNT}) yerine ${rows.length} satır ayrıştırıldı` };
  }

  // Yapısal güvenlik: alt/üst sınırlar sayısal olarak KESİN ARTAN sırada
  // olmalı, ardışık bantlar arasında boşluk/çakışma OLMAMALI (tam 0,01 TL
  // — Odeabank'ın kendi kuruş-hassasiyetli yayın biçimiyle tutarlı) ve son
  // bant ile önceki 15 bant yanlışlıkla birleşmemeli (her satır kendi
  // aralığını korur, burada birleştirme YOK).
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].ust <= rows[i].alt) {
      return { ok: false, error: `Bant ${i + 1}: üst sınır (${rows[i].ust}) alt sınırdan (${rows[i].alt}) büyük değil` };
    }
    if (i > 0 && rows[i].alt <= rows[i - 1].alt) {
      return { ok: false, error: `Bantlar artan sırada değil: bant ${i} alt=${rows[i - 1].alt}, bant ${i + 1} alt=${rows[i].alt}` };
    }
    if (i > 0) {
      const gap = Math.round((rows[i].alt - rows[i - 1].ust) * 100) / 100;
      if (Math.abs(gap - 0.01) > 1e-9) {
        return {
          ok: false,
          error: `Bant ${i}-${i + 1} arasında beklenmeyen geçiş: ${rows[i - 1].ust} TL -> ${rows[i].alt} TL (fark ${gap} TL, beklenen 0,01 TL) — boşluk/çakışma olabilir`,
        };
      }
    }
  }

  return { ok: true, rows };
}

// "Odeabank Oksijen Hoş Geldin" kullanıcı kararıyla pasifleştirildi (bkz.
// 20260910100000 migration) — is_enabled=false olduğu için bank_sources
// sorgusu bu kaynağı zaten atlıyor, ama PARSERS eşlemesi kasıtlı olarak
// duruyor (ileride yeniden etkinleştirilirse anında çalışsın diye).
//
// Kalan tek ürün "Odeabank Yeni Müşteriye Özel Oksijen" — tanımı gereği
// yalnızca İLK KEZ Odeabank müşterisi olanlar için geçerli bir üründür; bu
// koşul, o satırda sayısal olarak hangi sütun (Hoş Geldin mi Yeni Müşteriye
// Özel mi) daha yüksek çıkarsa çıksın SABİTTİR — ürünün eligibility'si,
// "en yüksek aday oranı seç" karşılaştırma politikasından bağımsızdır.
export function parseOdeabankYeniMusteriOksijen(html: string): ParseResult {
  const raw = parseOdeabankRawRows(html);
  if (!raw.ok) return fail(raw.error);

  const bands: ParsedBand[] = raw.rows.map((r) => {
    const yeniMusteriWins = r.yeniMusteriOran >= r.hosGeldinOran;
    const winningColumn = yeniMusteriWins ? ODEA_YENI_MUSTERI_COL : ODEA_HOSGELDIN_COL;
    const winningRaw = yeniMusteriWins ? r.yeniMusteriRaw : r.hosGeldinRaw;
    const winningRate = yeniMusteriWins ? r.yeniMusteriOran : r.hosGeldinOran;
    return {
      alt_limit: r.alt,
      ust_limit: r.ust,
      yillik_brut_oran: winningRate,
      vadesizde_kalacak: r.vadesiz,
      vadesiz_hesaplama_tipi: "sabit",
      vadesiz_oran: null,
      raw: { "Vadesiz Alt Limit": r.vadesizRaw, [winningColumn]: winningRaw },
      selected_rate_column: winningColumn,
      selected_rate_condition: "Yalnızca ilk kez Odeabank müşterisi olanlar için geçerli.",
      observed_rate_candidates: [
        { column: ODEA_HOSGELDIN_COL, rate: r.hosGeldinOran },
        { column: ODEA_YENI_MUSTERI_COL, rate: r.yeniMusteriOran },
      ],
      source_table_name: ODEA_TABLE_NAME,
    };
  });

  return { ok: true, bands, rawTierCount: bands.length };
}

// ---------------------------------------------------------------------------
// Alternatifbank VOV Hesap — yalnızca "VOV Hesap Faiz Tablosu" içindeki TL
// satırları (Döviz Cinsi=TL). Sayfa üstündeki tek oranlı reklam kutusu ve
// USD/EUR/XAU satırları kullanılmaz. Tek aday sütun: "Avantajlı Tanışma
// Faizi" (max seçimi gerekmiyor, "Standart Faiz Oranı" kullanılmıyor).
// ---------------------------------------------------------------------------

const ALTBANK_TABLE_NAME = "VOV Hesap Faiz Tablosu";
const ALTBANK_RATE_COL = "Avantajlı Tanışma Faizi";

function parseAlternatifbankVOV(html: string): ParseResult {
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (!doc) return fail("HTML ayrıştırılamadı");

  const tables = Array.from(doc.querySelectorAll("table"));
  const table = tables.find((t) => {
    const text = textOf(t);
    return text.includes("Döviz Cinsi") && text.includes("Avantajlı Tanışma Faizi") && text.includes("Vadesiz Hesapta Kalan Tutar");
  });
  if (!table) return fail('"VOV Hesap Faiz Tablosu" bulunamadı — sayfa yapısı değişmiş olabilir');

  const trs = Array.from(table.querySelectorAll("tbody tr"));
  if (trs.length === 0) return fail("tbody satırı bulunamadı");

  const bands: ParsedBand[] = [];
  for (const row of trs) {
    const tds = Array.from(row.querySelectorAll("td"));
    if (tds.length < 5) continue; // başlık satırı veya beklenmeyen satır, atla

    const currency = textOf(tds[0]);
    if (currency !== "TL") continue; // yalnızca TL satırları (USD/EUR/XAU alınmaz)

    const rangeText = textOf(tds[1]);
    const rangeMatch = rangeText.match(/^([\d.,]+)\s*-\s*(üzeri|[\d.,]+)$/i);
    if (!rangeMatch) return fail(`Tutar aralığı ayrıştırılamadı: "${rangeText}"`);
    const alt = parseTRMoney(rangeMatch[1]);
    const ust = /^üzeri$/i.test(rangeMatch[2]) ? 9999999999 : parseTRMoney(rangeMatch[2]);

    const rateRaw = textOf(tds[2]);
    const vadesizRaw = textOf(tds[4]);
    const rate = parseTRPercent(rateRaw);
    const vadesiz = parseTRMoney(vadesizRaw);

    if (alt === null || ust === null || rate === null || vadesiz === null) {
      return fail(`Sayısal alan ayrıştırılamadı (satır: "TL ${rangeText}")`);
    }

    bands.push({
      alt_limit: alt,
      ust_limit: ust,
      yillik_brut_oran: rate,
      vadesizde_kalacak: vadesiz,
      vadesiz_hesaplama_tipi: "sabit",
      vadesiz_oran: null,
      raw: { "Tutar Aralığı": rangeText, [ALTBANK_RATE_COL]: rateRaw, "Vadesiz Hesapta Kalan Tutar": vadesizRaw },
      selected_rate_column: ALTBANK_RATE_COL,
      selected_rate_condition: "45 günlük tanışma dönemi (dönem sonunda ek ürün kullanımıyla süresiz devam edebilir).",
      observed_rate_candidates: [{ column: ALTBANK_RATE_COL, rate }],
      source_table_name: ALTBANK_TABLE_NAME,
    });
  }

  if (bands.length === 0) return fail("TL satırı bulunamadı");

  // Kaynak sayfa ardışık bantları tam sayı "x - x+1" kalıbıyla yazıyor (ör.
  // "20.000 - 250.000" / "250.001 - 500.000"). Bu, uygulamanın kuruş
  // hassasiyetli bant modelinde 250.000,01–250.000,99 TL aralığının hiçbir
  // banda girmemesine (kapsama boşluğuna) yol açar. Ham metin (raw."Tutar
  // Aralığı") OLDUĞU GİBİ korunur — yalnızca normalize edilmiş alt_limit,
  // önceki bandın üst sınırına kuruş hassasiyetinde bitiştirilir. Bu
  // normalizasyon SADECE ardışık bantlar arasındaki fark TAM 1 TL olduğunda
  // uygulanır; başka bir boşluk deseni varsa dokunulmaz (validateBands bunu
  // ayrıca boşluk/çakışma olarak yakalar, tahmin üretilmez).
  bands.sort((a, b) => a.alt_limit - b.alt_limit);
  for (let i = 1; i < bands.length; i++) {
    const prev = bands[i - 1];
    const cur = bands[i];
    const gap = cur.alt_limit - prev.ust_limit;
    if (Math.abs(gap - 1) < 1e-9) {
      const rawAlt = cur.alt_limit;
      const normalizedAlt = Math.round((prev.ust_limit + 0.01) * 100) / 100;
      cur.alt_limit = normalizedAlt;
      cur.raw = {
        ...cur.raw,
        "Normalizasyon": `TL kuruşlarında kapsama boşluğu oluşmaması için alt limit ${rawAlt.toLocaleString("tr-TR")} TL yerine ${normalizedAlt.toLocaleString("tr-TR", { minimumFractionDigits: 2 })} TL olarak kaydedildi (ham kaynak aralığı: "${cur.raw?.["Tutar Aralığı"] ?? rawAlt}").`,
      };
    }
  }

  return { ok: true, bands, rawTierCount: bands.length };
}

// ---------------------------------------------------------------------------
// ING Turuncu Hesap — SSS bölümündeki "Turuncu Hesap faiz oranları nedir?"
// TL tablosu. İki ürün AYRI, sabit sütunlardan beslenir (max seçimi YOK,
// birbirine kopyalanmaz): "ilk defa müşteri kampanyası" -> yalnızca "ING
// Mobil'den Yeni Müşterilere Özel"; "Hoş geldin" -> yalnızca "Hoş Geldin
// Faizi".
// ---------------------------------------------------------------------------

interface IngRawRow {
  alt: number;
  ust: number;
  vadesiz: number;
  vadesizRaw: string;
  yeniMusteriOran: number;
  yeniMusteriRaw: string;
  hosGeldinOran: number;
  hosGeldinRaw: string;
}

const ING_TABLE_NAME = "Turuncu Hesap faiz oranları nedir? — TL";
const ING_YENI_MUSTERI_COL = "ING Mobil'den Yeni Müşterilere Özel";
const ING_HOSGELDIN_COL = "Hoş Geldin Faizi";

function parseIngRawRows(html: string): { ok: true; rows: IngRawRow[] } | { ok: false; error: string } {
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (!doc) return { ok: false, error: "HTML ayrıştırılamadı" };

  const table = doc.querySelector("table.rate-table");
  if (!table) return { ok: false, error: "table.rate-table bulunamadı — sayfa yapısı değişmiş olabilir" };

  const headerText = textOf(table.querySelector("thead"));
  if (!headerText.includes("Yeni Müşterilere") || !headerText.includes("Hoş Geldin Faizi")) {
    return { ok: false, error: `Tablo başlıkları beklenenden farklı: "${headerText}"` };
  }

  const trs = Array.from(table.querySelectorAll("tbody tr"));
  if (trs.length === 0) return { ok: false, error: "tbody satırı bulunamadı" };

  const rows: IngRawRow[] = [];
  for (const row of trs) {
    const tds = Array.from(row.querySelectorAll("td"));
    if (tds.length < 4) return { ok: false, error: `Beklenmeyen hücre sayısı: ${tds.length}` };

    const rangeText = textOf(tds[0]);
    let alt: number | null = null;
    let ust: number | null = null;
    const rangeMatch = rangeText.match(/^([\d.,]+)\s*(?:TL)?\s*-\s*([\d.,]+)\s*TL/i);
    const uzeriMatch = rangeText.match(/^([\d.,]+)\s*TL\s*ve\s*üzeri/i);
    if (rangeMatch) {
      alt = parseTRMoney(rangeMatch[1]);
      ust = parseTRMoney(rangeMatch[2]);
    } else if (uzeriMatch) {
      alt = parseTRMoney(uzeriMatch[1]);
      ust = 9999999999;
    } else {
      return { ok: false, error: `Tutar aralığı ayrıştırılamadı: "${rangeText}"` };
    }

    const vadesizRaw = textOf(tds[1]);
    const yeniMusteriRaw = textOf(tds[2]);
    const hosGeldinRaw = textOf(tds[3]);
    const vadesiz = parseTRMoney(vadesizRaw);
    const yeniMusteriOran = parseTRPercent(yeniMusteriRaw);
    const hosGeldinOran = parseTRPercent(hosGeldinRaw);

    if (alt === null || ust === null || vadesiz === null || yeniMusteriOran === null || hosGeldinOran === null) {
      return { ok: false, error: `Sayısal alan ayrıştırılamadı (satır: "${rangeText}")` };
    }

    rows.push({ alt, ust, vadesiz, vadesizRaw, yeniMusteriOran, yeniMusteriRaw, hosGeldinOran, hosGeldinRaw });
  }

  return { ok: true, rows };
}

function parseIngIlkDefaMusteri(html: string): ParseResult {
  const raw = parseIngRawRows(html);
  if (!raw.ok) return fail(raw.error);

  const bands: ParsedBand[] = raw.rows.map((r) => ({
    alt_limit: r.alt,
    ust_limit: r.ust,
    yillik_brut_oran: r.yeniMusteriOran,
    vadesizde_kalacak: r.vadesiz,
    vadesiz_hesaplama_tipi: "sabit",
    vadesiz_oran: null,
    raw: { "Faiz İşletilmeyecek Tutar": r.vadesizRaw, [ING_YENI_MUSTERI_COL]: r.yeniMusteriRaw },
    selected_rate_column: ING_YENI_MUSTERI_COL,
    selected_rate_condition: "Yalnızca ING Mobil üzerinden ilk kez ING müşterisi olanlar için geçerli.",
    observed_rate_candidates: [
      { column: ING_YENI_MUSTERI_COL, rate: r.yeniMusteriOran },
      { column: ING_HOSGELDIN_COL, rate: r.hosGeldinOran },
    ],
    source_table_name: ING_TABLE_NAME,
  }));

  return { ok: true, bands, rawTierCount: bands.length };
}

function parseIngHosGeldin(html: string): ParseResult {
  const raw = parseIngRawRows(html);
  if (!raw.ok) return fail(raw.error);

  const bands: ParsedBand[] = raw.rows.map((r) => ({
    alt_limit: r.alt,
    ust_limit: r.ust,
    yillik_brut_oran: r.hosGeldinOran,
    vadesizde_kalacak: r.vadesiz,
    vadesiz_hesaplama_tipi: "sabit",
    vadesiz_oran: null,
    raw: { "Faiz İşletilmeyecek Tutar": r.vadesizRaw, [ING_HOSGELDIN_COL]: r.hosGeldinRaw },
    selected_rate_column: ING_HOSGELDIN_COL,
    selected_rate_condition: "Genel hoş geldin oranı (ING Mobil'den ilk kez müşteri olma koşulu yok).",
    observed_rate_candidates: [
      { column: ING_YENI_MUSTERI_COL, rate: r.yeniMusteriOran },
      { column: ING_HOSGELDIN_COL, rate: r.hosGeldinOran },
    ],
    source_table_name: ING_TABLE_NAME,
  }));

  return { ok: true, bands, rawTierCount: bands.length };
}

// ---------------------------------------------------------------------------
// Yapı Kredi Sınırsız Hesap — "RATE-ONLY" otomasyon.
//
// alt_limit / ust_limit / vadesizde_kalacak bu parser tarafından ASLA
// üretilmez/değiştirilmez: kuruş-hassasiyetli 9 bant sınırı (20260915120000
// migration'ında normalize edildi) SADECE `stored`'dan aynen kopyalanır.
// Sayfadan yalnızca hangi tutar bandının hangi ORANA sahip olduğu okunur —
// eşleştirme kayıtlı alt_limit'e göre yapılır (dizi sırasına güvenilmez).
// Sayfanın kendi "Hesaptaki Tutar" / "Vadesiz Alt Limit" sütunları AYRICA
// yapısal doğrulama için kullanılır: sayfadaki vadesiz alt limit kayıtlı
// değerden farklıysa (yapısal fark), o bant için hiçbir oran önerilmez —
// tüm parse başarısız sayılır (hepsi ya da hiçbiri).
// ---------------------------------------------------------------------------

const YK_TABLE_NAME = "Sınırsız Hesap Faiz İşleyişi";
const YK_KAMPANYALI_COL = "Kampanyalı Faiz Oranı";
const YK_KAMPANYA_SONRASI_COL = "Kampanya Sonrası Faiz Oranı";
const YK_BAZ_COL = "Baz Faiz Oranı";
const YK_MOBIL_HOSGELDIN_COL = "Mobilden Yeni Müşteri Hoş Geldin Faizi";

export async function parseYapiKrediSinirsizHesap(html: string, stored: BankRateRow[]): Promise<ParseResult> {
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (!doc) return fail("HTML ayrıştırılamadı");

  const tables = Array.from(doc.querySelectorAll("table"));
  const table = tables.find((t) => textOf(t.querySelector("thead")).includes(YK_KAMPANYALI_COL));
  if (!table) return fail(`"${YK_KAMPANYALI_COL}" başlıklı Sınırsız Hesap tablosu bulunamadı — sayfa yapısı değişmiş olabilir`);

  const headers = Array.from(table.querySelectorAll("thead th")).map((th) => textOf(th));
  const idxTutar = headers.findIndex((h) => h.includes("Hesaptaki Tutar"));
  const idxVadesiz = headers.findIndex((h) => h.includes("Vadesiz Alt Limit"));
  const idxKampanyali = headers.findIndex((h) => h.includes(YK_KAMPANYALI_COL));
  const idxSonrasi = headers.findIndex((h) => h.includes(YK_KAMPANYA_SONRASI_COL));
  const idxBaz = headers.findIndex((h) => h.includes(YK_BAZ_COL));
  if ([idxTutar, idxVadesiz, idxKampanyali, idxSonrasi, idxBaz].some((i) => i < 0)) {
    return fail(`Beklenen sütun başlıkları bulunamadı (Hesaptaki Tutar / Vadesiz Alt Limit / ${YK_KAMPANYALI_COL} / ${YK_KAMPANYA_SONRASI_COL} / ${YK_BAZ_COL}): "${headers.join(" | ")}"`);
  }

  const rows = Array.from(table.querySelectorAll("tbody tr"));
  if (rows.length === 0) return fail("Sınırsız Hesap tablosunda tbody satırı bulunamadı");

  interface YkPageRow {
    alt: number;
    vadesiz: number;
    vadesizRaw: string;
    kampanyali: number;
    kampanyaliRaw: string;
    sonrasi: number;
    sonrasiRaw: string;
    baz: number;
    bazRaw: string;
    rangeText: string;
  }
  const pageRows: YkPageRow[] = [];
  const maxIdx = Math.max(idxTutar, idxVadesiz, idxKampanyali, idxSonrasi, idxBaz);
  for (const row of rows) {
    const cells = Array.from(row.querySelectorAll("td"));
    if (cells.length <= maxIdx) return fail(`Beklenmeyen hücre sayısı (${cells.length}) satırda: "${textOf(row)}"`);

    const rangeText = textOf(cells[idxTutar]);
    const rangeMatch = rangeText.match(/^([\d.,]+)\s*-\s*([\d.,]+)\s*TL/i);
    if (!rangeMatch) return fail(`Tutar aralığı ayrıştırılamadı: "${rangeText}"`);
    const alt = parseTRMoney(rangeMatch[1]);
    if (alt === null) return fail(`Tutar aralığı ayrıştırılamadı: "${rangeText}"`);

    const vadesizRaw = textOf(cells[idxVadesiz]);
    const kampanyaliRaw = textOf(cells[idxKampanyali]);
    const sonrasiRaw = textOf(cells[idxSonrasi]);
    const bazRaw = textOf(cells[idxBaz]);
    const vadesiz = parseTRMoney(vadesizRaw);
    const kampanyali = parseTRPercent(kampanyaliRaw);
    const sonrasi = parseTRPercent(sonrasiRaw);
    const baz = parseTRPercent(bazRaw);
    if (vadesiz === null || kampanyali === null || sonrasi === null || baz === null) {
      return fail(`Sayısal alan ayrıştırılamadı (satır: "${rangeText}")`);
    }
    pageRows.push({ alt, vadesiz, vadesizRaw, kampanyali, kampanyaliRaw, sonrasi, sonrasiRaw, baz, bazRaw, rangeText });
  }

  // İkinci resmi kaynak (mobilden yeni müşteri hoş geldin kampanyası) —
  // OPSİYONELDİR: çekilemezse/okunamazsa parser BAŞARISIZ OLMAZ, yalnızca bu
  // ek aday adaylar listesine eklenmez (ana tablo zaten zorunlu/yeterli).
  let mobilHosgeldin: number | null = null;
  try {
    const campRes = await fetch(YK_CAMPAIGN_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; GunlukMevduatRateCheck/1.0; +https://webappuygulamalar.github.io/gunluk-mevduat-karsilastirma/)",
      },
    });
    if (campRes.ok) {
      const campHtml = await campRes.text();
      const campDoc = new DOMParser().parseFromString(campHtml, "text/html");
      const campText = campDoc ? textOf(campDoc.body ?? campDoc.documentElement) : "";
      const m = campText.match(/%\s*([\d.,]+)\s*(?:oranında\s+)?hoş geldin faizi/i);
      if (m) {
        const r = parseTRPercent(m[1] + "%");
        if (r !== null) mobilHosgeldin = r;
      }
    }
  } catch {
    // opsiyonel ikincil kaynak — erişilemezse sessizce yok sayılır
  }

  const pageByAlt = new Map<string, YkPageRow>();
  for (const r of pageRows) pageByAlt.set(r.alt.toFixed(2), r);

  const bands: ParsedBand[] = [];
  for (const s of stored) {
    const key = Number(s.alt_limit).toFixed(2);
    const p = pageByAlt.get(key);
    if (!p) {
      return fail(`Yapısal fark — manuel inceleme gerekli: kayıtlı ${s.alt_limit} TL alt limitine sayfada karşılık gelen bir satır bulunamadı.`);
    }
    if (Math.abs(p.vadesiz - Number(s.vadesizde_kalacak)) > EPS_MONEY) {
      return fail(
        `Yapısal fark — manuel inceleme gerekli: "${p.rangeText}" bandında sayfadaki vadesiz alt limit (${p.vadesiz} TL) kayıtlı değerden (${s.vadesizde_kalacak} TL) farklı.`
      );
    }

    const candidates: RateCandidate[] = [
      { column: YK_BAZ_COL, rate: p.baz },
      { column: YK_KAMPANYA_SONRASI_COL, rate: p.sonrasi },
      { column: YK_KAMPANYALI_COL, rate: p.kampanyali },
    ];
    if (mobilHosgeldin !== null) candidates.push({ column: YK_MOBIL_HOSGELDIN_COL, rate: mobilHosgeldin });

    let winner = candidates[0];
    for (const c of candidates) if (c.rate > winner.rate) winner = c;

    const condition =
      winner.column === YK_KAMPANYALI_COL || winner.column === YK_MOBIL_HOSGELDIN_COL
        ? "30 gün geçerli kampanyalı/yeni müşteri hoş geldin faiz oranı; kampanya süresi sonunda kampanya sonrası veya baz faiz oranına dönülür."
        : winner.column === YK_KAMPANYA_SONRASI_COL
          ? "Kampanya sonrası devam faiz oranı."
          : "Baz (kampanyasız) faiz oranı.";

    bands.push({
      alt_limit: Number(s.alt_limit),
      ust_limit: Number(s.ust_limit),
      yillik_brut_oran: winner.rate,
      vadesizde_kalacak: Number(s.vadesizde_kalacak),
      vadesiz_hesaplama_tipi: s.vadesiz_hesaplama_tipi,
      vadesiz_oran: s.vadesiz_oran,
      raw: {
        "Vadesiz Alt Limit (kaynak sütunu)": p.vadesizRaw,
        [YK_KAMPANYALI_COL]: p.kampanyaliRaw,
        [YK_KAMPANYA_SONRASI_COL]: p.sonrasiRaw,
        [YK_BAZ_COL]: p.bazRaw,
        ...(mobilHosgeldin !== null ? { [YK_MOBIL_HOSGELDIN_COL]: `%${mobilHosgeldin * 100}` } : {}),
      },
      selected_rate_column: winner.column,
      selected_rate_condition: condition,
      observed_rate_candidates: candidates,
      source_table_name: YK_TABLE_NAME,
    });
  }

  return { ok: true, bands, rawTierCount: pageRows.length };
}

// ---------------------------------------------------------------------------
// QNB Kazandıran Günlük Hesap — "RATE-ONLY" otomasyon.
//
// KULLANICI POLİTİKASI (2026-09-16, kesinleştirildi): "Kazananlar Kulübü /
// QNB Plus" ek %1 oranı ÖZEL MÜŞTERİ SEGMENTİNE has bir faydadır ve rakip
// oran karşılaştırmasına KESİNLİKLE DAHİL EDİLMEZ. Genel politika: "Aynı
// ürün için genel kullanıma açık standart, yeni müşteri veya dijital kanal
// oranları arasından en yüksek uygulanabilir oran seçilir. Özel bankacılık,
// sadakat kulübü, kişiye özel fiyatlama veya yalnızca seçilmiş müşteri
// segmentlerine verilen ek oranlar karşılaştırmaya dahil edilmez." Bu yüzden
// asıl kaynak, "Kazanan Günlük Hesap - Günlük Faiz Oranları" başlık
// tablosu (Kazananlar Kulübü sütunu içerir) DEĞİL, "Tanışma Ve Tanışma
// Sonrası Devam Faizi" MATRİSİDİR — bu matriste hiç Kazananlar Kulübü sütunu
// YOKTUR, yalnızca koşulsuz/genel "1-45 Gün" oranı vardır. Başlık tablosu
// yalnızca KANIT amaçlı okunur (standart + kulüp oranı ikisi de raw'a
// yazılır, kulüp oranı AÇIKÇA "hariç tutuldu" notuyla) — asla seçilen orana
// dönüşmez.
//
// QNB'nin gerçek ürünü ayrıca VADEYE (gün aralığına) göre değişen, tutar
// bandından bağımsız bir boyuta sahip (41,75% [1-45 gün] .. ~29% [721+ gün])
// — mevcut bank_rates şeması ve app.js hesap motoru TEK sabit yıllık oran
// varsayıyor, vade boyutu YOK. Bu yüzden yalnızca 1-45 gün sütunu kullanılır
// (diğer bankalardaki "kampanya/giriş oranı" deseniyle tutarlı).
//
// TUTARA GÖRE EŞLEŞTİRME (dizi sırasına GÜVENİLMEZ): matrisin "1-45 Gün"
// sütunu tutardan TAMAMEN bağımsız DEĞİLDİR — 10.000.000 TL ALTINDAKİ 14
// bandın hepsi aynı %41,75'i gösterirken, 10.000.000 TL VE ÜZERİNDEKİ 3 bant
// (10M/20M/30M) belirgin şekilde DÜŞÜK oranlar gösterir (elle doğrulandı:
// %27,75 / %27,75 / %25,50). Özet (başlık) tablosundaki "0-10.000.000" tek
// satırı bu yüzden 10M ÜZERİNDEKİ bantlara ASLA yayılmaz.
//
// Matrisin satır ETİKETLERİNDE (ör. "5,000,00-7,499,999.99" — eksik bir sıfır)
// QNB'nin kendi sayfasında bilinen küçük yazım hataları var; bu yüzden 17
// bandın HER BİRİNİN etiketini tek tek ayrıştırmaya güvenilmez. Bunun yerine:
//   a) 10.000.000 TL ALTI bantlar İÇERİK tutarlılığıyla doğrulanır — bu
//      grubun TÜM güvenle ayrıştırılabilen satırları AYNI 1-45 gün oranını
//      göstermeli (tek bir yazım hatalı satır etiketi sonucu etkilemez, çünkü
//      karar tek satır kimliğine değil TÜM grubun iç tutarlılığına dayanır).
//   b) 10.000.000 TL VE ÜZERİ 3 bant, START değerleri sayfada yazım hatasız
//      olduğu doğrulanmış NUMERİK eşleştirmeyle (10.000.000/20.000.000/
//      30.000.000) AYRI AYRI okunur.
//   c) Matris satır SAYISI (17) yapısal bütünlük için ayrıca doğrulanır —
//      bu, hücre METNİNDEKİ yazım hatalarından ETKİLENMEYEN, güvenilir bir
//      kontroldür (bir bandın eklenip/çıkarılıp çıkarılmadığını yakalar).
// Düşük grup İÇİNDE tutarsızlık bulunursa, YA DA 3 üst bandın herhangi biri
// eşleştirilemezse, YA DA satır sayısı 17 değilse: TÜM parse reddedilir
// (hepsi ya da hiçbiri) — hiçbir QNB oranı önerilmez.
//
// alt_limit / ust_limit / vadesizde_kalacak ASLA üretilmez/değiştirilmez —
// kuruş-hassasiyetli 17 bant sınırı (20260916090000 migration'ında normalize
// edildi) SADECE `stored`'dan aynen kopyalanır. Ek yapısal doğrulama,
// sayfanın "Alt Limit Tutarı (TL)" tablosuyla (0–999.999 TL arası 8 bandı
// kapsar) yapılır: bu 8 bandın alt_limit VE vadesiz alt limiti kayıtlı
// değerle uyuşmuyorsa parse tamamen başarısız sayılır.
// ---------------------------------------------------------------------------

// QNB'nin sayfası (Akbank'ın AJAX servisi gibi) TR biçimi DEĞİL, İNGİLİZCE/
// uluslararası sayı biçimi kullanıyor: tutarlarda "," binlik ayırıcı
// ("0-49,999", "7,500"), oranlarda "." ondalık ayırıcı ("41.75%") — sitenin
// geri kalanının Türkçe metnine rağmen. parseTRMoney/parseTRPercent burada
// KULLANILAMAZ (ör. "41.75%" TR ayrıştırıcıyla yanlışlıkla 4175 olur, çünkü
// "." orada binlik ayırıcı sayılıp silinir). Elle doğrulandı (2026-09-16).
function parseQNBMoney(raw: string): number | null {
  const cleaned = raw.replace(/,/g, "").replace(/\s/g, "").trim();
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}
function parseQNBPercent(raw: string): number | null {
  const cleaned = raw.replace(/%/g, "").replace(/\s/g, "").trim();
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return n / 100;
}

const QNB_HEADLINE_TABLE_NAME = "Kazandıran Günlük Hesap - Günlük Faiz Oranları";
const QNB_MATRIX_TABLE_NAME = "Tanışma Ve Tanışma Sonrası Devam Faizi";
const QNB_ALTLIMIT_TABLE_HEADER = "Alt Limit Tutarı (TL)";
const QNB_STANDARD_COL = "Faiz Oranı (1-45 Gün, genel/koşulsuz)";
const QNB_EXCLUDED_CLUB_NOTE = "Kazananlar Kulübü / QNB Plus (özel müşteri segmenti oranı — kullanıcı politikası gereği rakip karşılaştırmasından hariç tutuldu, seçilemez)";
const QNB_HIGH_TIER_THRESHOLD = 10000000; // TL — bu ve üzeri bantlarda 1-45 gün oranı DÜŞÜK grupla aynı DEĞİLDİR
const QNB_EXPECTED_MATRIX_ROW_COUNT = 17;

export function parseQNBKazandiranGunluk(html: string, stored: BankRateRow[]): ParseResult {
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (!doc) return fail("HTML ayrıştırılamadı");

  const tables = Array.from(doc.querySelectorAll("table"));

  // 0) Başlık (özet) tablosu — YALNIZCA KANIT AMAÇLI. Standart ve Kazananlar
  //    Kulübü/QNB Plus oranları ayrı ayrı okunup `raw`'a yazılır ama HİÇBİR
  //    ZAMAN seçilen orana dönüşmez (kullanıcı politikası). Bu tablo
  //    bulunamazsa parse BAŞARISIZ OLMAZ — asıl kaynak aşağıdaki matristir.
  const headlineTable = tables.find((t) => {
    const h = textOf(t.querySelector("thead"));
    return h.includes("Faiz Oranı") && h.includes("Kazananlar Kulübü");
  });
  let headlineStandartRaw = "";
  let headlineKulupRaw = "";
  if (headlineTable) {
    const hRows = Array.from(headlineTable.querySelectorAll("tbody tr"));
    for (const row of hRows) {
      const cells = Array.from(row.querySelectorAll("td"));
      if (cells.length < 4) continue;
      const label = textOf(cells[0]);
      const gun = textOf(cells[1]);
      if (!/tanışma faizi/i.test(label) || !/^1\s*-\s*45/.test(gun)) continue;
      headlineStandartRaw = textOf(cells[3]);
      if (cells[4]) headlineKulupRaw = textOf(cells[4]);
      break;
    }
  }

  // 1) Asıl kaynak: "Tanışma Ve Tanışma Sonrası Devam Faizi" matrisi —
  //    kendi thead'inde "Tutar", "1-45" ve "46-91" geçen tablo (isimle
  //    bulunur). Bu tabloda Kazananlar Kulübü sütunu YOKTUR.
  const matrixTable = tables.find((t) => {
    const h = textOf(t.querySelector("thead"));
    return h.includes("Tutar") && h.includes("1-45") && h.includes("46-91");
  });
  if (!matrixTable) {
    return fail(`"${QNB_MATRIX_TABLE_NAME}" tablosu bulunamadı — sayfa yapısı değişmiş olabilir`);
  }
  const matrixRowEls = Array.from(matrixTable.querySelectorAll("tbody tr"));
  if (matrixRowEls.length !== QNB_EXPECTED_MATRIX_ROW_COUNT) {
    return fail(
      `"${QNB_MATRIX_TABLE_NAME}" tablosunda beklenen bant sayısı (${QNB_EXPECTED_MATRIX_ROW_COUNT}) yerine ${matrixRowEls.length} satır bulundu — sayfa yapısı değişmiş olabilir`
    );
  }

  interface MatrixRow { altRaw: string; alt: number | null; rateRaw: string; rate: number | null; }
  const matrixRows: MatrixRow[] = matrixRowEls.map((row) => {
    const cells = Array.from(row.querySelectorAll("td"));
    const altRaw = cells[0] ? textOf(cells[0]) : "";
    const rateRaw = cells[1] ? textOf(cells[1]) : "";
    // Yalnızca aralığın BAŞLANGIÇ değeri kullanılır — sayfada bilinen bazı
    // satırların BİTİŞ değerinde yazım hatası var (ör. "499,99.99"), ama
    // eşleştirme için başlangıç değeri yeterli ve bu belirli hatalardan
    // etkilenmiyor.
    const altMatch = altRaw.match(/^([\d,]+)/);
    const alt = altMatch ? parseQNBMoney(altMatch[1]) : null;
    const rate = parseQNBPercent(rateRaw);
    return { altRaw, alt, rateRaw, rate };
  });
  if (matrixRows.some((r) => r.rate === null)) {
    const bad = matrixRows.find((r) => r.rate === null)!;
    return fail(`"${QNB_MATRIX_TABLE_NAME}" tablosunda 1-45 Gün oranı ayrıştırılamadı (satır: "${bad.altRaw}" -> "${bad.rateRaw}")`);
  }

  // 10.000.000 TL ALTI bantlar: TEK TEK kimliklerine değil, İÇERİK
  // TUTARLILIĞINA göre doğrulanır — bu grubun güvenle ayrıştırılabilen TÜM
  // satırları AYNI 1-45 gün oranını göstermeli. Böylece sayfadaki bilinen
  // etiket yazım hataları (ör. "5,000,00-7,499,999.99") sonucu ETKİLEMEZ:
  // karar tek satırın kimliğine değil grubun bütününe dayanıyor.
  const lowRows = matrixRows.filter((r) => r.alt !== null && r.alt < QNB_HIGH_TIER_THRESHOLD);
  if (lowRows.length === 0) {
    return fail(`"${QNB_MATRIX_TABLE_NAME}" tablosunda ${QNB_HIGH_TIER_THRESHOLD} TL altı hiçbir bant güvenle ayrıştırılamadı`);
  }
  const lowRate = lowRows[0].rate!;
  for (const r of lowRows) {
    if (Math.abs(r.rate! - lowRate) > EPS_RATE) {
      return fail(
        `"${QNB_MATRIX_TABLE_NAME}" tablosunda ${QNB_HIGH_TIER_THRESHOLD} TL altı bantlar arasında 1-45 gün oranı tutarsız ("${r.altRaw}": ${r.rateRaw} vs "${lowRows[0].altRaw}": ${lowRows[0].rateRaw}) — sayfa yapısı değişmiş olabilir, manuel inceleme gerekli`
      );
    }
  }

  // 10.000.000 TL VE ÜZERİ bantlar: START değerleri sayfada yazım hatasız
  // olduğu doğrulandı — NUMERİK eşleştirmeyle tek tek okunur.
  const highRateByAlt = new Map<number, number>();
  for (const r of matrixRows) {
    if (r.alt !== null && r.alt >= QNB_HIGH_TIER_THRESHOLD) {
      highRateByAlt.set(r.alt, r.rate!);
    }
  }

  // 2) Ek yapısal doğrulama: "Alt Limit Tutarı (TL)" tablosu (0–999.999 TL
  //    arası, yazım hatasız 8 bandı kapsar) — kayıtlı bantlarla alt_limit VE
  //    vadesiz alt limit uyuşmalı, yoksa parse tamamen başarısız sayılır.
  const altLimitTable = tables.find((t) => textOf(t.querySelector("thead")).includes(QNB_ALTLIMIT_TABLE_HEADER));
  if (!altLimitTable) {
    return fail(`"${QNB_ALTLIMIT_TABLE_HEADER}" tablosu bulunamadı — yapısal doğrulama yapılamadı, sayfa yapısı değişmiş olabilir`);
  }
  const altRows = Array.from(altLimitTable.querySelectorAll("tbody tr"));
  interface AltRow { alt: number; vadesiz: number; rangeText: string; }
  const altPageRows: AltRow[] = [];
  for (const row of altRows) {
    const cells = Array.from(row.querySelectorAll("td"));
    if (cells.length < 2) continue;
    const rangeText = textOf(cells[0]);
    const rangeMatch = rangeText.match(/^([\d.,]+)\s*-\s*([\d.,]+)/);
    if (!rangeMatch) continue;
    const alt = parseQNBMoney(rangeMatch[1]);
    const vadesiz = parseQNBMoney(textOf(cells[1]));
    if (alt === null || vadesiz === null) continue;
    altPageRows.push({ alt, vadesiz, rangeText });
  }
  if (altPageRows.length === 0) return fail(`"${QNB_ALTLIMIT_TABLE_HEADER}" tablosunda geçerli satır bulunamadı`);

  for (const r of altPageRows) {
    const s = stored.find((x) => Number(x.alt_limit).toFixed(2) === r.alt.toFixed(2));
    if (!s) {
      return fail(`Yapısal fark — manuel inceleme gerekli: sayfadaki "${r.rangeText}" tutar bandına kayıtlı bantlarda karşılık bulunamadı.`);
    }
    if (Math.abs(r.vadesiz - Number(s.vadesizde_kalacak)) > EPS_MONEY) {
      return fail(
        `Yapısal fark — manuel inceleme gerekli: "${r.rangeText}" bandında sayfadaki vadesiz alt limit (${r.vadesiz} TL) kayıtlı değerden (${s.vadesizde_kalacak} TL) farklı.`
      );
    }
  }

  // 3) Her kayıtlı banda, tutarına göre (10M eşiği) doğru oranı ata. 10M ve
  //    üzeri her bant için matriste NUMERİK olarak eşleşen bir satır
  //    bulunamazsa (yapısal fark), TÜM parse reddedilir.
  const bands: ParsedBand[] = [];
  for (const s of stored) {
    const altNum = Number(s.alt_limit);
    let rate: number;
    if (altNum < QNB_HIGH_TIER_THRESHOLD) {
      rate = lowRate;
    } else {
      const matched = highRateByAlt.get(altNum);
      if (matched === undefined) {
        return fail(
          `Yapısal fark — manuel inceleme gerekli: kayıtlı ${altNum} TL bandına "${QNB_MATRIX_TABLE_NAME}" tablosunda numerik olarak eşleşen bir satır bulunamadı.`
        );
      }
      rate = matched;
    }

    const candidates: RateCandidate[] = [{ column: QNB_STANDARD_COL, rate }];
    bands.push({
      alt_limit: altNum,
      ust_limit: Number(s.ust_limit),
      yillik_brut_oran: rate,
      vadesizde_kalacak: Number(s.vadesizde_kalacak),
      vadesiz_hesaplama_tipi: s.vadesiz_hesaplama_tipi,
      vadesiz_oran: s.vadesiz_oran,
      raw: {
        [QNB_STANDARD_COL]: altNum < QNB_HIGH_TIER_THRESHOLD ? `${(lowRate * 100).toFixed(2)}%` : `${(rate * 100).toFixed(2)}%`,
        [QNB_EXCLUDED_CLUB_NOTE]: headlineKulupRaw || "(başlık tablosu bulunamadı)",
        "Başlık tablosu standart oranı (kanıt)": headlineStandartRaw || "(başlık tablosu bulunamadı)",
      },
      selected_rate_column: QNB_STANDARD_COL,
      selected_rate_condition: "Genel başvuruya açık, koşulsuz 1-45 gün tanışma faizi (üyelik/segment koşulu yok).",
      observed_rate_candidates: candidates,
      source_table_name: QNB_MATRIX_TABLE_NAME,
    });
  }

  return { ok: true, bands, rawTierCount: matrixRowEls.length };
}

const PARSERS: Record<string, (html: string, stored: BankRateRow[]) => ParseResult | Promise<ParseResult>> = {
  "TOM Bank": parseTomBank,
  "Fibabanka Fonlu Kiraz": parseFibabankaFonluKiraz,
  "Fibabanka Kiraz Hoş Geldin": parseFibabankaKirazHosgeldin,
  "Akbank Serbest Plus Hesap": parseAkbankSerbestPlus,
  // "Odeabank Oksijen Hoş Geldin" pasif (is_enabled=false) — bank_sources
  // sorgusu zaten atlıyor, ama eşleme ileride yeniden etkinleştirilirse
  // hazır olsun diye duruyor.
  "Odeabank Oksijen Hoş Geldin": parseOdeabankYeniMusteriOksijen,
  "Odeabank Yeni Müşteriye Özel Oksijen": parseOdeabankYeniMusteriOksijen,
  "Alternatifbank": parseAlternatifbankVOV,
  "ING ilk defa müşteri kampanyası": parseIngIlkDefaMusteri,
  "ING Hoş geldin": parseIngHosGeldin,
  "Yapı Kredi": parseYapiKrediSinirsizHesap,
  "QNB": parseQNBKazandiranGunluk,
};

// ---------------------------------------------------------------------------
// Öz-doğrulama: ayrıştırılan bantların "makul" olup olmadığını kontrol eder.
// Herhangi biri başarısız olursa parser'ın sonucu güvenilmez sayılır.
// ---------------------------------------------------------------------------

function validateBands(bands: ParsedBand[], expectedTierCount: number | null, rawTierCount: number): string | null {
  if (bands.length === 0) return "Hiç bant ayrıştırılamadı";

  for (const b of bands) {
    if (!Number.isFinite(b.alt_limit) || !Number.isFinite(b.ust_limit) || !Number.isFinite(b.yillik_brut_oran)) {
      return "Sayısal olmayan alan bulundu";
    }
    if (b.ust_limit < b.alt_limit) return `Üst limit alt limitten küçük (${b.alt_limit} - ${b.ust_limit})`;
    if (b.yillik_brut_oran < MIN_PLAUSIBLE_RATE || b.yillik_brut_oran > MAX_PLAUSIBLE_RATE) {
      return `Oran makul aralık dışında: ${b.yillik_brut_oran}`;
    }
    // Birden fazla aday sütunu varsa (ör. Standart/Dijital, Hoş Geldin/Yeni
    // Müşteri), yalnızca KAZANAN değil TÜM adaylar makul aralıkta olmalı —
    // aksi halde ayrıştırma sessizce yanlış bir hücreyi okumuş olabilir.
    if (b.observed_rate_candidates) {
      for (const c of b.observed_rate_candidates) {
        if (!Number.isFinite(c.rate) || c.rate < MIN_PLAUSIBLE_RATE || c.rate > MAX_PLAUSIBLE_RATE) {
          return `Aday oran makul aralık dışında ("${c.column}": ${c.rate})`;
        }
      }
    }
    if (b.vadesiz_hesaplama_tipi === "sabit") {
      // alt_limit karşılaştırması YANLIŞTI: bir bant meşru olarak 0'dan
      // başlayabilir (ör. Odeabank'ın ilk bandı [0, 25.000], vadesizde
      // kalacak 7.500 TL — bankanın kendi resmi, hâlâ yayında olan verisiyle
      // birebir aynı). Asıl anlamlı sınır: vadesizde kalan tutar, bandın ÜST
      // sınırını (o bantta olabilecek en yüksek bakiyeyi) aşmamalı.
      if (b.vadesizde_kalacak > b.ust_limit) {
        return `Vadesizde kalan tutar (${b.vadesizde_kalacak}) üst limitten (${b.ust_limit}) büyük`;
      }
    } else {
      if (b.vadesiz_oran === null || b.vadesiz_oran < 0 || b.vadesiz_oran >= 100) {
        return `Vadesiz yüzdesi geçersiz: ${b.vadesiz_oran}`;
      }
    }
  }

  const sorted = [...bands].sort((a, b) => a.alt_limit - b.alt_limit);
  for (let i = 0; i < sorted.length - 1; i++) {
    const gapOrOverlap = sorted[i + 1].alt_limit - sorted[i].ust_limit;
    if (Math.abs(gapOrOverlap) > 1 && gapOrOverlap < 0) {
      return `Bantlar arasında çakışma: ${sorted[i].ust_limit} / ${sorted[i + 1].alt_limit}`;
    }
    if (gapOrOverlap > 2) {
      return `Bantlar arasında boşluk: ${sorted[i].ust_limit} - ${sorted[i + 1].alt_limit}`;
    }
  }

  if (expectedTierCount !== null && rawTierCount !== expectedTierCount) {
    return `Beklenen kademe sayısı (${expectedTierCount}) ile bulunan (${rawTierCount}) uyuşmuyor`;
  }

  return null;
}

// rate_change_requests.previous_data içinde saklanan bir bank_rates satırı
// anlık görüntüsünü (ya da elle öneri formunun kısmi previous_data'sını)
// bandsEqual ile karşılaştırılabilir bir ParsedBand'e çevirir.
function parsedBandFromSnapshot(snapshot: unknown): ParsedBand | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const s = snapshot as Record<string, unknown>;
  const alt = Number(s.alt_limit);
  const ust = Number(s.ust_limit);
  const oran = Number(s.yillik_brut_oran);
  if (!Number.isFinite(alt) || !Number.isFinite(ust) || !Number.isFinite(oran)) return null;
  return {
    alt_limit: alt,
    ust_limit: ust,
    yillik_brut_oran: oran,
    vadesizde_kalacak: Number(s.vadesizde_kalacak ?? 0),
    vadesiz_hesaplama_tipi: (s.vadesiz_hesaplama_tipi as "sabit" | "yuzde") ?? "sabit",
    vadesiz_oran: s.vadesiz_oran !== undefined && s.vadesiz_oran !== null ? Number(s.vadesiz_oran) : null,
  };
}

function bandsEqual(a: ParsedBand, b: ParsedBand): boolean {
  if (Math.abs(a.alt_limit - b.alt_limit) > EPS_MONEY) return false;
  if (Math.abs(a.ust_limit - b.ust_limit) > EPS_MONEY) return false;
  if (Math.abs(a.yillik_brut_oran - b.yillik_brut_oran) > EPS_RATE) return false;
  if (a.vadesiz_hesaplama_tipi !== b.vadesiz_hesaplama_tipi) return false;
  if (a.vadesiz_hesaplama_tipi === "sabit") {
    if (Math.abs(a.vadesizde_kalacak - b.vadesizde_kalacak) > EPS_MONEY) return false;
  } else {
    if (Math.abs((a.vadesiz_oran ?? 0) - (b.vadesiz_oran ?? 0)) > 0.01) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Ana akış
// ---------------------------------------------------------------------------

interface BankSourceRow {
  id: string;
  bank_id: string;
  source_url: string;
  page_marker_text: string | null;
  expected_tier_count: number | null;
  requires_manual_check: boolean;
  notes: string | null;
  banks: { name: string } | null;
}

export interface BankRateRow {
  id: string;
  alt_limit: number;
  ust_limit: number;
  vadesizde_kalacak: number;
  yillik_brut_oran: number;
  note: string;
  gerekli_fon_bakiyesi: number | null;
  vadesiz_hesaplama_tipi: "sabit" | "yuzde";
  vadesiz_oran: number | null;
}

export interface BandMatchResult {
  ok: boolean;
  pairs: { storedBand: BankRateRow; parsedBand: ParsedBand }[];
  structuralChange: boolean;
  error?: string;
}

function bankRateAsParsed(band: BankRateRow): ParsedBand {
  return {
    alt_limit: Number(band.alt_limit),
    ust_limit: Number(band.ust_limit),
    yillik_brut_oran: Number(band.yillik_brut_oran),
    vadesizde_kalacak: Number(band.vadesizde_kalacak),
    vadesiz_hesaplama_tipi: band.vadesiz_hesaplama_tipi,
    vadesiz_oran: band.vadesiz_oran !== null ? Number(band.vadesiz_oran) : null,
  };
}

// Normal akışta bantlar alt_limit ile birebir eşleştirilir. TOM Bank'ın
// resmî tablosu 2026-10-19'da 17,5M sınırını 20M'ye taşıdı; bant sayısı ve
// sırası aynı kaldığı için yalnızca bu ürün için, sıkı korumalar altında,
// satır sırası yapısal kimlik olarak kullanılabilir. Koşullar:
//   - iki tarafta da aynı sayıda bant,
//   - yalnızca tek alt sınır değişmiş,
//   - ilk alt ve son üst sınır aynı,
//   - parsed küme kendi içinde validateBands ile zaten doğrulanmış.
// Bunlardan biri bozulursa tahmin yürütülmez ve parse_error üretilir.
export function matchStoredBands(bankName: string, stored: BankRateRow[], parsed: ParsedBand[]): BandMatchResult {
  const storedSorted = [...stored].sort((a, b) => Number(a.alt_limit) - Number(b.alt_limit));
  const parsedSorted = [...parsed].sort((a, b) => a.alt_limit - b.alt_limit);
  const parsedByAlt = new Map<string, ParsedBand>();
  for (const b of parsedSorted) parsedByAlt.set((Math.round(b.alt_limit * 100) / 100).toFixed(2), b);

  const unmatchedStored: BankRateRow[] = [];
  const pairs: { storedBand: BankRateRow; parsedBand: ParsedBand }[] = [];
  const consumedAltKeys = new Set<string>();
  for (const storedBand of storedSorted) {
    const key = (Math.round(Number(storedBand.alt_limit) * 100) / 100).toFixed(2);
    const parsedBand = parsedByAlt.get(key);
    if (!parsedBand) unmatchedStored.push(storedBand);
    else {
      pairs.push({ storedBand, parsedBand });
      consumedAltKeys.add(key);
    }
  }
  const extraParsed = parsedSorted.filter((b) => !consumedAltKeys.has((Math.round(b.alt_limit * 100) / 100).toFixed(2)));
  const ordinalAltMismatches = storedSorted.reduce<number[]>((indices, storedBand, index) => {
    const parsedBand = parsedSorted[index];
    if (!parsedBand || Math.abs(Number(storedBand.alt_limit) - parsedBand.alt_limit) > EPS_MONEY) indices.push(index);
    return indices;
  }, []);

  if (unmatchedStored.length === 0 && extraParsed.length === 0 && storedSorted.length === parsedSorted.length) {
    return { ok: true, pairs, structuralChange: false };
  }

  const tomSafeOrdinalChange =
    bankName === "TOM Bank" &&
    storedSorted.length === parsedSorted.length &&
    storedSorted.length >= 2 &&
    unmatchedStored.length === 1 &&
    extraParsed.length === 1 &&
    ordinalAltMismatches.length === 1 &&
    Math.abs(Number(storedSorted[0].alt_limit) - parsedSorted[0].alt_limit) <= EPS_MONEY &&
    Math.abs(Number(storedSorted.at(-1)?.ust_limit) - Number(parsedSorted.at(-1)?.ust_limit)) <= EPS_MONEY;

  if (tomSafeOrdinalChange) {
    return {
      ok: true,
      structuralChange: true,
      pairs: storedSorted.map((storedBand, index) => ({
        storedBand,
        parsedBand: {
          ...parsedSorted[index],
          raw: {
            ...(parsedSorted[index].raw ?? {}),
            "Yapısal eşleştirme": "TOM Bank resmî tablosundaki tek sınır değişikliği, doğrulanmış satır sırasına göre eşleştirildi",
          },
        },
      })),
    };
  }

  return {
    ok: false,
    pairs: [],
    structuralChange: false,
    error:
      `Bant yapısı güvenle eşleştirilemedi — otomatik öneri üretilmedi (hepsi ya da hiçbiri). ` +
      `Kayıtlı bant sayısı: ${storedSorted.length}, sayfada bulunan: ${parsedSorted.length}. ` +
      (unmatchedStored.length > 0
        ? `Sayfada karşılığı bulunamayan kayıtlı alt limitler: ${unmatchedStored.map((b) => b.alt_limit).join(", ")}. `
        : "") +
      (extraParsed.length > 0
        ? `Kayıtlı bantlarla eşleşmeyen, sayfada bulunan fazladan alt limitler: ${extraParsed.map((b) => b.alt_limit).join(", ")}.`
        : ""),
  };
}

async function fetchSourcePage(url: string): Promise<{ ok: true; html: string } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; GunlukMevduatRateCheck/1.0; +https://webappuygulamalar.github.io/gunluk-mevduat-karsilastirma/)",
      },
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, html: await res.text() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// JSONB, Postgres'te anahtar sırasını KORUMAZ (round-trip'te farklı sırada
// dönebilir). Bu yüzden mükerrer-talep kontrolünde JSON.stringify ile ham
// metin karşılaştırması güvenilir değildir — anahtarları sıralayıp kanonik
// bir biçimde karşılaştırıyoruz.
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

// bank_rate_id + gözlemlenen (kaynaktan ayrıştırılan) bant değerlerinin
// deterministik SHA-256 özeti. "Kabul edilmiş fark" eşleştirmesinde
// kullanılır: aynı bant için kaynaktan AYNI değerler tekrar okunursa aynı
// parmak izi üretilir (yeniden talep açılmaz); kaynaktaki değer GERÇEKTEN
// değişirse parmak izi de değişir (yeniden uyarı üretilir).
async function computeFingerprint(bankRateId: string, band: ParsedBand): Promise<string> {
  const payload = canonicalJson({
    bank_rate_id: bankRateId,
    alt_limit: band.alt_limit,
    ust_limit: band.ust_limit,
    yillik_brut_oran: band.yillik_brut_oran,
    vadesizde_kalacak: band.vadesizde_kalacak,
    vadesiz_hesaplama_tipi: band.vadesiz_hesaplama_tipi,
    vadesiz_oran: band.vadesiz_oran,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function toProposedData(b: ParsedBand, note: string, gerekliFonBakiyesi: number | null) {
  return {
    alt_limit: b.alt_limit,
    ust_limit: b.ust_limit,
    vadesizde_kalacak: b.vadesizde_kalacak,
    yillik_brut_oran: b.yillik_brut_oran,
    // Birden fazla aday sütunu olan ürünlerde (Fibabanka Kiraz Hoş Geldin,
    // Odeabank, ING) seçilen oranın koşulu HER ZAMAN nota yazılır — hangi
    // sütun kazandığı değişirse (ör. Standart<->Dijital) not da otomatik
    // güncellenir. Tek adaylı ürünlerde (TOM Bank, Akbank, Fonlu Kiraz)
    // selected_rate_condition boş olduğundan mevcut davranış (kayıtlı not)
    // hiç değişmez.
    note: b.selected_rate_condition ?? note,
    gerekli_fon_bakiyesi: gerekliFonBakiyesi,
    vadesiz_hesaplama_tipi: b.vadesiz_hesaplama_tipi,
    vadesiz_oran: b.vadesiz_oran,
  };
}

async function processSource(
  supabase: SupabaseClient,
  runId: string,
  source: BankSourceRow,
  dryRun: boolean,
  // Sayfa artık burada DEĞİL, çağıran tarafta (Deno.serve içinde) tek bir
  // yerde, aynı URL'yi paylaşan ürünler için TEK SEFER ve paralel çekiliyor
  // — bkz. Deno.serve içindeki htmlByUrl haritası. manual_required olan
  // kaynaklar için bu parametre hiç kullanılmaz (aşağıdaki ilk dal zaten
  // erken döner).
  fetched: { ok: true; html: string } | { ok: false; error: string }
): Promise<{ status: "ok" | "unreachable" | "parse_error" | "manual_required"; findingsCreated: number }> {
  const bankName = source.banks?.name ?? source.bank_id;

  if (source.requires_manual_check) {
    await supabase.from("rate_check_findings").insert({
      run_id: runId,
      bank_source_id: source.id,
      bank_id: source.bank_id,
      finding_type: "manual_required",
      evidence_url: source.source_url,
      detail: source.notes || `${bankName} için güvenilir, otomatik ayrıştırılabilir bir kaynak yok. Lütfen resmi sayfayı elle kontrol edin.`,
    });
    await supabase
      .from("bank_sources")
      .update({ last_checked_at: new Date().toISOString(), last_check_status: "manual_required" })
      .eq("id", source.id);
    return { status: "manual_required", findingsCreated: 1 };
  }

  if (!fetched.ok) {
    await supabase.from("rate_check_findings").insert({
      run_id: runId,
      bank_source_id: source.id,
      bank_id: source.bank_id,
      finding_type: "unreachable",
      evidence_url: source.source_url,
      detail: `Kaynağa erişilemedi: ${fetched.error}`,
    });
    await supabase
      .from("bank_sources")
      .update({ last_checked_at: new Date().toISOString(), last_check_status: "unreachable" })
      .eq("id", source.id);
    return { status: "unreachable", findingsCreated: 1 };
  }

  const markerHaystack = markerSearchText(fetched.html);

  if (source.page_marker_text && !markerHaystack.includes(source.page_marker_text)) {
    await supabase.from("rate_check_findings").insert({
      run_id: runId,
      bank_source_id: source.id,
      bank_id: source.bank_id,
      finding_type: "parse_error",
      evidence_url: source.source_url,
      detail: `Sayfada beklenen işaret metni ("${source.page_marker_text}") bulunamadı — sayfa yapısı değişmiş olabilir.`,
    });
    await supabase
      .from("bank_sources")
      .update({ last_checked_at: new Date().toISOString(), last_check_status: "parse_error" })
      .eq("id", source.id);
    return { status: "parse_error", findingsCreated: 1 };
  }

  const parser = PARSERS[bankName];
  if (!parser) {
    await supabase.from("rate_check_findings").insert({
      run_id: runId,
      bank_source_id: source.id,
      bank_id: source.bank_id,
      finding_type: "parse_error",
      evidence_url: source.source_url,
      detail: `"${bankName}" için tanımlı bir ayrıştırıcı yok.`,
    });
    return { status: "parse_error", findingsCreated: 1 };
  }

  // Mevcut aktif bantlar parser'dan ÖNCE okunur: "rate-only" ürünlerde
  // (Yapı Kredi, QNB) parser kendi bant sınırı üretmez — yalnızca canlı
  // bandın kuruş-hassasiyetli alt_limit/ust_limit/vadesizde_kalacak
  // değerlerini AYNEN kopyalayıp yalnızca yillik_brut_oran'ı kaynak
  // sayfadan doldurur. Diğer parser'lar (TOM Bank, Akbank, vb.) bu
  // parametreyi hiç kullanmaz — geriye dönük uyumluluk bozulmaz.
  const { data: storedRates, error: storedErr } = await supabase
    .from("bank_rates")
    .select(
      "id, alt_limit, ust_limit, vadesizde_kalacak, yillik_brut_oran, note, gerekli_fon_bakiyesi, vadesiz_hesaplama_tipi, vadesiz_oran"
    )
    .eq("bank_id", source.bank_id)
    .eq("is_active", true)
    .order("alt_limit", { ascending: true });

  if (storedErr) {
    await supabase.from("rate_check_findings").insert({
      run_id: runId,
      bank_source_id: source.id,
      bank_id: source.bank_id,
      finding_type: "parse_error",
      evidence_url: source.source_url,
      detail: `Mevcut oranlar okunamadı: ${storedErr.message}`,
    });
    return { status: "parse_error", findingsCreated: 1 };
  }

  const stored = (storedRates ?? []) as BankRateRow[];

  const parsed = await parser(fetched.html, stored);
  if (!parsed.ok) {
    await supabase.from("rate_check_findings").insert({
      run_id: runId,
      bank_source_id: source.id,
      bank_id: source.bank_id,
      finding_type: "parse_error",
      evidence_url: source.source_url,
      detail: parsed.error ?? "Bilinmeyen ayrıştırma hatası",
    });
    await supabase
      .from("bank_sources")
      .update({ last_checked_at: new Date().toISOString(), last_check_status: "parse_error" })
      .eq("id", source.id);
    return { status: "parse_error", findingsCreated: 1 };
  }

  const validationError = validateBands(parsed.bands, source.expected_tier_count, parsed.rawTierCount);
  if (validationError) {
    await supabase.from("rate_check_findings").insert({
      run_id: runId,
      bank_source_id: source.id,
      bank_id: source.bank_id,
      finding_type: "parse_error",
      evidence_url: source.source_url,
      observed_value: parsed.bands,
      detail: `Öz-doğrulama başarısız: ${validationError}`,
    });
    await supabase
      .from("bank_sources")
      .update({ last_checked_at: new Date().toISOString(), last_check_status: "parse_error" })
      .eq("id", source.id);
    return { status: "parse_error", findingsCreated: 1 };
  }

  const parsedSorted = [...parsed.bands].sort((a, b) => a.alt_limit - b.alt_limit);
  const matching = matchStoredBands(bankName, stored, parsedSorted);

  if (!matching.ok) {
    await supabase.from("rate_check_findings").insert({
      run_id: runId,
      bank_source_id: source.id,
      bank_id: source.bank_id,
      finding_type: "parse_error",
      evidence_url: source.source_url,
      current_value: stored,
      observed_value: parsedSorted,
      detail: matching.error,
    });
    await supabase
      .from("bank_sources")
      .update({ last_checked_at: new Date().toISOString(), last_check_status: "parse_error" })
      .eq("id", source.id);
    return { status: "parse_error", findingsCreated: 1 };
  }

  const matchedPairs = matching.pairs;

  let anyNewChange = false; // gerçekten yeni, kabul edilmemiş bir fark var mı
  let anyAcceptedDiff = false; // fark var ama daha önce admin tarafından kabul edilmiş
  let anyConcurrencyResolved = false; // kontrol sürerken zaten uygulanmış değişiklik
  let findingsCreated = 0;

  for (const { storedBand, parsedBand } of matchedPairs) {
    const storedAsParsed = bankRateAsParsed(storedBand);

    if (bandsEqual(storedAsParsed, parsedBand)) continue;

    const proposedData = toProposedData(parsedBand, storedBand.note ?? "", storedBand.gerekli_fon_bakiyesi);
    const fingerprint = await computeFingerprint(storedBand.id, parsedBand);

    // Bu tam bant + tam gözlemlenen değer daha önce bir admin tarafından
    // "kabul edilmiş" mi? Bu kontrol dry run'da da (salt okunur, hiçbir şey
    // yazmadan) yapılır ki dry run gerçek çalışmanın ne yapacağını doğru
    // önizlesin.
    const { data: accepted } = await supabase
      .from("accepted_rate_differences")
      .select("id, occurrence_count")
      .eq("bank_rate_id", storedBand.id)
      .eq("fingerprint", fingerprint)
      .maybeSingle();

    if (accepted) {
      anyAcceptedDiff = true;
      if (!dryRun) {
        await supabase
          .from("accepted_rate_differences")
          .update({
            occurrence_count: (accepted.occurrence_count ?? 1) + 1,
            last_checked_at: new Date().toISOString(),
            last_run_id: runId,
          })
          .eq("id", accepted.id);
      }
      // Bu bant için YENİ bir rate_change_requests AÇILMAZ — yalnızca bilgi
      // amaçlı bir 'accepted_difference' bulgusu kaydedilir (izlenebilirlik
      // için; admin panelinde "Otomatik doğrulandı" olarak sayılır).
      await supabase.from("rate_check_findings").insert({
        run_id: runId,
        bank_source_id: source.id,
        bank_id: source.bank_id,
        finding_type: "accepted_difference",
        evidence_url: source.source_url,
        current_value: storedBand,
        observed_value: proposedData,
        fingerprint,
        raw_evidence: parsedBand.raw ?? null,
        source_table_name: parsedBand.source_table_name ?? null,
        selected_rate_column: parsedBand.selected_rate_column ?? null,
        selected_rate_condition: parsedBand.selected_rate_condition ?? null,
        observed_rate_candidates: parsedBand.observed_rate_candidates ?? null,
        detail: dryRun ? "(dry run) Önceden kabul edilmiş, bilinen bir fark." : "Önceden kabul edilmiş, bilinen bir fark — yeni talep açılmadı.",
      });
      findingsCreated++;
      continue;
    }

    if (dryRun) {
      anyNewChange = true;
      await supabase.from("rate_check_findings").insert({
        run_id: runId,
        bank_source_id: source.id,
        bank_id: source.bank_id,
        finding_type: "rate_changed",
        evidence_url: source.source_url,
        current_value: storedBand,
        observed_value: proposedData,
        fingerprint,
        raw_evidence: parsedBand.raw ?? null,
        source_table_name: parsedBand.source_table_name ?? null,
        selected_rate_column: parsedBand.selected_rate_column ?? null,
        selected_rate_condition: parsedBand.selected_rate_condition ?? null,
        observed_rate_candidates: parsedBand.observed_rate_candidates ?? null,
        detail: "(dry run — talep oluşturulmadı)",
      });
      findingsCreated++;
      continue;
    }

    // Talep oluşturma artık veritabanında SATIR KİLİDİ altında atomik yapılır.
    // Böylece admin bir oranı, uzun süren bir kontrol tam aynı anda
    // yayımladığında kontrolün eski anlık görüntüyle yeni/bayat talep açması
    // engellenir. Aynı RPC eşzamanlı iki kontrolün mükerrer talep açmasını da
    // önler.
    const { data: ensureRows, error: ensureErr } = await supabase.rpc(
      "ensure_automation_rate_change_request",
      {
        p_bank_rate_id: storedBand.id,
        p_bank_id: source.bank_id,
        p_expected_previous: storedBand,
        p_proposed_data: proposedData,
      },
    );
    const ensured = Array.isArray(ensureRows) ? ensureRows[0] : ensureRows;

    if (ensureErr || !ensured) {
      await supabase.from("rate_check_findings").insert({
        run_id: runId,
        bank_source_id: source.id,
        bank_id: source.bank_id,
        finding_type: "parse_error",
        evidence_url: source.source_url,
        current_value: storedBand,
        observed_value: proposedData,
        fingerprint,
        raw_evidence: parsedBand.raw ?? null,
        source_table_name: parsedBand.source_table_name ?? null,
        selected_rate_column: parsedBand.selected_rate_column ?? null,
        selected_rate_condition: parsedBand.selected_rate_condition ?? null,
        observed_rate_candidates: parsedBand.observed_rate_candidates ?? null,
        detail: `Talep güvenli biçimde oluşturulamadı: ${ensureErr?.message ?? "bilinmeyen RPC yanıtı"}`,
      });
      findingsCreated++;
      await supabase
        .from("bank_sources")
        .update({ last_checked_at: new Date().toISOString(), last_check_status: "parse_error" })
        .eq("id", source.id);
      return { status: "parse_error", findingsCreated };
    }

    if (ensured.outcome === "already_applied") {
      anyConcurrencyResolved = true;
      await supabase.from("rate_check_findings").insert({
        run_id: runId,
        bank_source_id: source.id,
        bank_id: source.bank_id,
        finding_type: "no_change",
        evidence_url: source.source_url,
        current_value: ensured.live_data,
        observed_value: proposedData,
        fingerprint,
        raw_evidence: parsedBand.raw ?? null,
        detail: "Kontrol sürerken aynı değişiklik admin tarafından yayımlandı; bayat/mükerrer talep açılmadı.",
      });
      findingsCreated++;
      continue;
    }

    if (ensured.outcome === "stale") {
      await supabase.from("rate_check_findings").insert({
        run_id: runId,
        bank_source_id: source.id,
        bank_id: source.bank_id,
        finding_type: "parse_error",
        evidence_url: source.source_url,
        current_value: ensured.live_data,
        observed_value: proposedData,
        fingerprint,
        raw_evidence: parsedBand.raw ?? null,
        detail: "Canlı oran kontrol sırasında değişti; eski görüntüyle talep açılmadı. Bir sonraki kontrolde güncel veriler yeniden değerlendirilecek.",
      });
      findingsCreated++;
      await supabase
        .from("bank_sources")
        .update({ last_checked_at: new Date().toISOString(), last_check_status: "parse_error" })
        .eq("id", source.id);
      return { status: "parse_error", findingsCreated };
    }

    anyNewChange = true;

    await supabase.from("rate_check_findings").insert({
      run_id: runId,
      bank_source_id: source.id,
      bank_id: source.bank_id,
      finding_type: "rate_changed",
      evidence_url: source.source_url,
      current_value: storedBand,
      observed_value: proposedData,
      rate_change_request_id: ensured.request_id ?? null,
      fingerprint,
      raw_evidence: parsedBand.raw ?? null,
      source_table_name: parsedBand.source_table_name ?? null,
      selected_rate_column: parsedBand.selected_rate_column ?? null,
      selected_rate_condition: parsedBand.selected_rate_condition ?? null,
      observed_rate_candidates: parsedBand.observed_rate_candidates ?? null,
      detail: ensured.outcome === "duplicate"
        ? "Bu değişiklik için zaten güncel bir talep var (mükerrer oluşturulmadı)."
        : undefined,
    });
    findingsCreated++;
  }

  if (!anyNewChange && !anyAcceptedDiff && !anyConcurrencyResolved) {
    await supabase.from("rate_check_findings").insert({
      run_id: runId,
      bank_source_id: source.id,
      bank_id: source.bank_id,
      finding_type: "no_change",
      evidence_url: source.source_url,
      current_value: stored,
    });
    findingsCreated++;
  }

  await supabase
    .from("bank_sources")
    .update({ last_checked_at: new Date().toISOString(), last_check_status: anyNewChange ? "changed" : "ok" })
    .eq("id", source.id);

  return { status: "ok", findingsCreated };
}

async function isAuthorized(req: Request): Promise<boolean> {
  const cronSecretHeader = req.headers.get("x-cron-secret");
  if (CRON_SECRET && cronSecretHeader && cronSecretHeader === CRON_SECRET) {
    return true;
  }

  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return false;
  const jwt = authHeader.slice("Bearer ".length);

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) return false;

  const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: profile } = await serviceClient
    .from("profiles")
    .select("role")
    .eq("id", userData.user.id)
    .maybeSingle();

  return profile?.role === "admin";
}

// ---------------------------------------------------------------------------
// bank_sources sorgusuna kısa/artan bekemeli retry
// ---------------------------------------------------------------------------
//
// 2026-09-09 06:00 UTC olayı: Edge Function'ın İLK sorgusu (bank_sources +
// banks join) Supabase API katmanından tek seferlik bir "Gateway Timeout"
// aldı ve bu TEK nokta 10 kaynağın hiçbirinin kontrol edilmemesine yol açtı.
// Bu fonksiyon, YALNIZCA GEÇİCİ (zaman aşımı/bağlantı/5xx) hatalarda kısa ve
// artan bir bekleme ile en fazla 3 kez dener; 4xx/yetki/RLS gibi KALICI
// hatalarda gereksiz yere tekrar ETMEZ (ilk denemede durur). Her denemenin
// süresi ve hatası (varsa) döndürülür — çağıran taraf bunu rate_check_runs
// .notes alanına yazar.
const BANK_SOURCES_RETRY_DELAYS_MS = [500, 1500, 3000];
const BANK_SOURCES_MAX_ATTEMPTS = 3;

interface BankSourcesAttempt {
  attempt: number;
  ms: number;
  error: string | null;
}

function isTransientDbError(message: string): boolean {
  const m = message.toLowerCase();
  return /timeout|timed out|gateway|network|fetch failed|econnreset|econnrefused|socket hang up|too many requests|429|5\d\d\b|temporarily|unavailable|bağlantı/.test(
    m
  );
}

async function fetchBankSourcesWithRetry(
  supabase: SupabaseClient
): Promise<{ ok: true; sources: unknown[]; attempts: BankSourcesAttempt[] } | { ok: false; error: string; attempts: BankSourcesAttempt[] }> {
  const attempts: BankSourcesAttempt[] = [];
  let lastError = "bilinmeyen hata";

  for (let attempt = 1; attempt <= BANK_SOURCES_MAX_ATTEMPTS; attempt++) {
    const t0 = performance.now();
    const { data, error } = await supabase
      .from("bank_sources")
      .select("id, bank_id, source_url, page_marker_text, expected_tier_count, requires_manual_check, notes, banks!inner(name, is_enabled)")
      .eq("banks.is_enabled", true)
      .order("created_at", { ascending: true });
    const ms = Math.round(performance.now() - t0);

    if (!error && data) {
      attempts.push({ attempt, ms, error: null });
      return { ok: true, sources: data, attempts };
    }

    const message = error?.message ?? "bank_sources okunamadı (veri boş döndü)";
    attempts.push({ attempt, ms, error: message });
    lastError = message;

    if (!isTransientDbError(message)) {
      // Kalıcı hata (ör. yetki/RLS/404) — tekrar denemek sonucu DEĞİŞTİRMEZ,
      // gereksiz yere beklemeden hemen çıkılır.
      break;
    }
    if (attempt < BANK_SOURCES_MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, BANK_SOURCES_RETRY_DELAYS_MS[attempt - 1]));
    }
  }

  return { ok: false, error: lastError, attempts };
}

function formatAttemptsNote(attempts: BankSourcesAttempt[]): string | null {
  if (attempts.length <= 1 && attempts[0]?.error === null) return null; // ilk denemede başarılı — not gerekmez
  return (
    "bank_sources sorgu denemeleri: " +
    attempts
      .map((a) => `deneme ${a.attempt} (${a.ms}ms)${a.error ? `: ${a.error}` : ": başarılı"}`)
      .join(" | ")
  );
}

// import.meta.main: bu dosya Supabase tarafından doğrudan çalıştırıldığında
// (üretimde HER ZAMAN doğru) sunucuyu başlatır; bir test dosyası tarafından
// `import` edildiğinde (deno test) FALSE olur — böylece testler gerçek bir
// HTTP sunucusu/port açmadan yalnızca parser/yardımcı fonksiyonları izole
// şekilde çalıştırabilir. Üretim davranışı hiç değişmez.
if (import.meta.main) {
Deno.serve(async (req: Request) => {
  // Preflight, yetkilendirme kontrolünden ÖNCE karşılanır — tarayıcı OPTIONS
  // isteğine kimlik bilgisi göndermez, bu yüzden isAuthorized burada hiç
  // çağrılmaz. Origin izinli değilse Access-Control-Allow-Origin eklenmez;
  // tarayıcı bu durumda asıl POST'u zaten göndermeyecektir.
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }

  if (req.method !== "POST") {
    return jsonResponse(req, { error: "Method Not Allowed" }, 405);
  }

  if (!(await isAuthorized(req))) {
    return jsonResponse(req, { error: "Unauthorized" }, 401);
  }

  let dryRun = false;
  let retryCheck = false;
  let triggeredBy: "cron" | "manual" | "retry" = req.headers.get("x-cron-secret") ? "cron" : "manual";
  try {
    if (req.headers.get("content-type")?.includes("application/json")) {
      const body = await req.json().catch(() => ({}));
      if (body?.dryRun === true || body?.dry_run === true) dryRun = true;
      if (body?.retry_check === true) retryCheck = true;
    }
  } catch {
    // gövde yoksa/parse edilemezse varsayılanlarla devam
  }
  const reqUrl = new URL(req.url);
  if (reqUrl.searchParams.get("dry_run") === "true") dryRun = true;
  if (retryCheck) triggeredBy = "retry";

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const startedAtMs = Date.now();
  let runId: string | null = null;
  let initialNote: string | null = null;

  // 2026-09-09 06:00 UTC olayı: bank_sources sorgusu Supabase API katmanından
  // "Gateway Timeout" ile 500 döndü — rate_check_runs'a status='failure' +
  // error_summary yazıldı (o kısım zaten çalıştı), AMA bu tek nokta çalışmanın
  // TAMAMINI götürdü ve 10 kaynağın hiçbiri kontrol edilemedi. Bu try/catch,
  // BEKLENMEYEN her türlü hatanın (bank_sources sorgusu dahil, kod hatası
  // dahil) rate_check_runs'a MUTLAKA bir sonuç bırakmasını garanti eder —
  // "0 kaynak, sessiz başarısızlık" bir daha olmaz.
  try {
    if (retryCheck) {
      // Karar TEK atomik RPC'de veriliyor (pg_try_advisory_xact_lock +
      // "bugün zaten gerçek retry oldu mu" ikinci katman kontrolü ile) —
      // eşzamanlı iki çağrıdan yalnızca biri gerçek kontrol yapar. RPC,
      // 'skip' veya 'run' durumuna göre rate_check_runs satırını ZATEN
      // INSERT etmiş olarak döner; bu fonksiyon yalnızca sonucu kullanır.
      const { data: decisionRows, error: decisionErr } = await supabase.rpc("decide_retry_run");
      const decision = decisionRows?.[0];

      if (decisionErr || !decision) {
        return jsonResponse(req, { error: "Retry kararı alınamadı", detail: decisionErr?.message }, 500);
      }

      if (decision.action === "skip") {
        return jsonResponse(req, { skipped: true, reason: decision.reason, run_id: decision.run_id }, 200);
      }

      // action === 'run': RPC zaten 'running' durumunda bir satır açtı,
      // bu id kullanılacak (yeni bir satır INSERT edilmeyecek).
      runId = decision.run_id;
      initialNote = `Ana kontrol nedeniyle retry tetiklendi — gerekçe: ${decision.reason}`;
    } else {
      const { data: run, error: runErr } = await supabase
        .from("rate_check_runs")
        .insert({ status: "running", triggered_by: triggeredBy, dry_run: dryRun })
        .select("id")
        .single();

      if (runErr || !run) {
        return jsonResponse(req, { error: "rate_check_runs oluşturulamadı", detail: runErr?.message }, 500);
      }
      runId = run.id;
    }

    if (!runId) {
      // Buraya asla ulaşılmamalı (yukarıdaki her iki dal da erken döner ya
      // da runId'yi atar) — yalnızca TypeScript'in null daraltması için.
      throw new Error("runId belirlenemedi (beklenmeyen durum)");
    }

    // banks!inner + is_enabled=true filtresi: pasifleştirilmiş bankalar (ör.
    // kullanıcı kararıyla mükerrer olduğu için kapatılan Odeabank Oksijen Hoş
    // Geldin) günlük kontrolde HİÇ görünmez — ne bulgu ne pending talep
    // üretilir. bank_sources satırı silinmez, yalnızca bu sorgudan elenir.
    //
    // Bu sorgu artık kısa/artan bekemeli retry ile sarmalanmış durumda (bkz.
    // fetchBankSourcesWithRetry): yalnızca GEÇİCİ (timeout/5xx/ağ) hatalarda
    // en fazla 3 kez denenir; kalıcı (4xx/yetki) hatalarda hemen durur.
    const sourcesResult = await fetchBankSourcesWithRetry(supabase);
    const attemptsNote = formatAttemptsNote(sourcesResult.attempts);
    const combinedNote = [initialNote, attemptsNote].filter((n): n is string => !!n).join(" | ") || null;

    if (!sourcesResult.ok) {
      await supabase
        .from("rate_check_runs")
        .update({
          status: "failure",
          finished_at: new Date().toISOString(),
          duration_ms: Date.now() - startedAtMs,
          error_summary: sourcesResult.error,
          notes: combinedNote,
        })
        .eq("id", runId);
      return jsonResponse(req, { error: "bank_sources okunamadı", run_id: runId }, 500);
    }

    const allSources = sourcesResult.sources as unknown as BankSourceRow[];
    const manualSources = allSources.filter((s) => s.requires_manual_check);
    const autoSources = allSources.filter((s) => !s.requires_manual_check);

    // Aynı URL'yi paylaşan ürünler için (Fibabanka Fonlu Kiraz / Kiraz Hoş
    // Geldin aynı sayfa; ING'nin iki ürünü aynı sayfa) sayfa YALNIZCA BİR
    // KEZ çekilir. Benzersiz kaynaklar KONTROLLÜ PARALEL (Promise.allSettled)
    // çekilir — biri zaman aşımına uğrarsa/patlarsa DİĞERLERİNİ ASLA
    // etkilemez ve dış try/catch'e sızmaz (iç try/catch zaten sonucu
    // {ok:false} olarak paketler, böylece allSettled hep "fulfilled" döner).
    const uniqueUrls = Array.from(new Set(autoSources.map((s) => s.source_url)));
    const fetchTimingsMs: Record<string, number> = {};
    const fetchSettled = await Promise.allSettled(
      uniqueUrls.map(async (u) => {
        const t0 = performance.now();
        try {
          const result = await fetchSourcePage(u);
          fetchTimingsMs[u] = Math.round(performance.now() - t0);
          return { url: u, result };
        } catch (err) {
          fetchTimingsMs[u] = Math.round(performance.now() - t0);
          return { url: u, result: { ok: false as const, error: err instanceof Error ? err.message : String(err) } };
        }
      })
    );
    const htmlByUrl = new Map<string, { ok: true; html: string } | { ok: false; error: string }>();
    for (const s of fetchSettled) {
      if (s.status === "fulfilled") htmlByUrl.set(s.value.url, s.value.result);
    }

    let sourcesChecked = 0;
    let sourcesUnreachable = 0;
    let findingsCreated = 0;
    const summary: Record<string, string> = {};

    // Her ürün izole: biri hata verse (parse hatası, ağ hatası, beklenmeyen
    // istisna) de döngü diğerlerini kontrol etmeye devam eder — tek bir
    // ürünün ayrıştırma hatası ASLA tüm çalışmayı 500'e düşürmez.
    for (const source of [...manualSources, ...autoSources]) {
      sourcesChecked++;
      try {
        const fetched = source.requires_manual_check
          ? ({ ok: false, error: "manual_required — fetch atlandı" } as const)
          : htmlByUrl.get(source.source_url) ?? ({ ok: false, error: "Fetch sonucu bulunamadı (beklenmeyen durum)" } as const);
        const result = await processSource(supabase, runId, source, dryRun, fetched);
        findingsCreated += result.findingsCreated;
        if (result.status === "unreachable") sourcesUnreachable++;
        summary[source.banks?.name ?? source.bank_id] = result.status;
      } catch (err) {
        sourcesUnreachable++;
        const message = err instanceof Error ? err.message : String(err);
        summary[source.banks?.name ?? source.bank_id] = "error";
        await supabase.from("rate_check_findings").insert({
          run_id: runId,
          bank_source_id: source.id,
          bank_id: source.bank_id,
          finding_type: "unreachable",
          evidence_url: source.source_url,
          detail: `Beklenmeyen hata: ${message}`,
        });
      }
    }

    const finalStatus = sourcesUnreachable === 0 ? "success" : sourcesUnreachable === sourcesChecked ? "failure" : "partial_failure";

    // "11/11 kontrol edildi" TEK BAŞINA bir başarı ifadesi değildir — dört
    // kategoriye ayrılmış sayım, gerçek durumu gösterir. Bir kaynağın birden
    // fazla bandı değiştiyse (rate_changed) o kaynak yalnızca BİR kez
    // "değişiklik bulundu" olarak sayılır (distinct bank_source_id).
    const { data: runFindings } = await supabase
      .from("rate_check_findings")
      .select("bank_source_id, finding_type")
      .eq("run_id", runId);

    const statusBySource = new Map<string, string>();
    for (const f of runFindings ?? []) {
      const prev = statusBySource.get(f.bank_source_id);
      // Öncelik sırası: rate_changed > parse_error > unreachable > manual_required > accepted_difference/no_change
      const rank: Record<string, number> = {
        rate_changed: 4,
        parse_error: 3,
        unreachable: 3,
        manual_required: 2,
        accepted_difference: 1,
        no_change: 1,
      };
      if (!prev || (rank[f.finding_type] ?? 0) > (rank[prev] ?? 0)) {
        statusBySource.set(f.bank_source_id, f.finding_type);
      }
    }

    const categoryCounts = {
      auto_verified_no_change: 0, // Otomatik doğrulandı – değişiklik yok
      change_pending_approval: 0, // Değişiklik bulundu – onay bekliyor
      manual_check_required: 0, // Manuel kontrol gerekli (kalıcı manuel + ayrıştırma hatası)
      source_unreachable: 0, // Kaynağa ulaşılamadı
    };
    for (const type of statusBySource.values()) {
      if (type === "no_change" || type === "accepted_difference") categoryCounts.auto_verified_no_change++;
      else if (type === "rate_changed") categoryCounts.change_pending_approval++;
      else if (type === "manual_required" || type === "parse_error") categoryCounts.manual_check_required++;
      else if (type === "unreachable") categoryCounts.source_unreachable++;
    }

    const durationMs = Date.now() - startedAtMs;

    await supabase
      .from("rate_check_runs")
      .update({
        status: finalStatus,
        finished_at: new Date().toISOString(),
        sources_checked: sourcesChecked,
        sources_unreachable: sourcesUnreachable,
        findings_created: findingsCreated,
        verified_products: categoryCounts.auto_verified_no_change,
        pending_products: categoryCounts.change_pending_approval,
        manual_products: categoryCounts.manual_check_required,
        duration_ms: durationMs,
      })
      .eq("id", runId);

    return jsonResponse(
      req,
      {
        run_id: runId,
        status: finalStatus,
        dry_run: dryRun,
        sources_checked: sourcesChecked,
        sources_unreachable: sourcesUnreachable,
        findings_created: findingsCreated,
        categories: categoryCounts,
        summary,
        duration_ms: durationMs,
        source_timings_ms: fetchTimingsMs,
      },
      200
    );
  } catch (err) {
    // Beklenmeyen bir hata (kod hatası, altyapı sorunu vb.) çalışmayı 500'e
    // düşürse bile en azından rate_check_runs'a KESİN bir sonuç bırakılır —
    // admin panelinde açıklanamayan, sessiz bir "0 kaynak" kaydı bir daha
    // KALMAZ. run zaten oluşturulmuşsa UPDATE edilir; oluşturulamadıysa
    // (ör. ilk INSERT'in kendisi patladıysa) en azından yeni bir satır
    // INSERT edilmeye çalışılır.
    const message = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - startedAtMs;
    try {
      if (runId) {
        await supabase
          .from("rate_check_runs")
          .update({
            status: "failure",
            finished_at: new Date().toISOString(),
            duration_ms: durationMs,
            error_summary: message,
          })
          .eq("id", runId);
      } else {
        await supabase.from("rate_check_runs").insert({
          status: "failure",
          triggered_by: triggeredBy,
          dry_run: dryRun,
          sources_checked: 0,
          sources_unreachable: 0,
          findings_created: 0,
          duration_ms: durationMs,
          finished_at: new Date().toISOString(),
          error_summary: message,
        });
      }
    } catch {
      // Son çare: bookkeeping bile başarısız olursa sessizce geç — asıl
      // hatayı gizlemeden 500 dönmeye devam et.
    }
    return jsonResponse(req, { error: "Beklenmeyen hata", detail: message, run_id: runId }, 500);
  }
});
}
