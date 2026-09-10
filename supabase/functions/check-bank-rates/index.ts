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
const MIN_PLAUSIBLE_RATE = 0.03; // %3
const MAX_PLAUSIBLE_RATE = 1.2; // %120
const EPS_MONEY = 1; // TL toleransı (yuvarlama)
const EPS_RATE = 0.0005; // oran toleransı (yüzde puanı olarak %0.05)

// ---------------------------------------------------------------------------
// Türkçe sayı/yüzde biçimlendirme yardımcıları
// ---------------------------------------------------------------------------

/** "43,00%" veya "%43,00" -> 0.43 */
function parseTRPercent(raw: string): number | null {
  const cleaned = raw.replace(/%/g, "").replace(/\s/g, "").trim();
  if (!cleaned) return null;
  const normalized = cleaned.replace(/\./g, "").replace(",", ".");
  const n = Number(normalized);
  if (!Number.isFinite(n)) return null;
  return n / 100;
}

/** "7.500" veya "7.500 TL" veya "25.000,01" -> 7500 / 25000.01 (TR formatı: "." binlik ayırıcı, "," ondalık ayırıcı). */
function parseTRMoney(raw: string): number | null {
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

// ---------------------------------------------------------------------------
// Ortak tipler
// ---------------------------------------------------------------------------

interface RateCandidate {
  column: string;
  rate: number;
}

interface ParsedBand {
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

interface ParseResult {
  ok: boolean;
  bands: ParsedBand[];
  rawTierCount: number;
  error?: string;
}

function fail(error: string): ParseResult {
  return { ok: false, bands: [], rawTierCount: 0, error };
}

// ---------------------------------------------------------------------------
// Banka-özel ayrıştırıcılar — her biri sadece kendi doğrulanmış sayfa
// yapısına güvenir; yapı beklenmedikse tahmin üretmez, hata döner.
// ---------------------------------------------------------------------------

function parseTomBank(html: string): ParseResult {
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

    rows.push({ alt, ust, vadesiz, vadesizRaw, standartOran, standartRaw, dijitalOran, dijitalRaw, fonluEk, fonluEkRaw });
  }

  return { ok: true, rows };
}

function parseFibabankaFonluKiraz(html: string): ParseResult {
  const raw = parseFibaKirazRawRows(html);
  if (!raw.ok) return fail(raw.error);

  const bands: ParsedBand[] = raw.rows.map((r) => ({
    alt_limit: r.alt,
    ust_limit: r.ust,
    yillik_brut_oran: Math.round((r.dijitalOran + r.fonluEk) * 100000) / 100000,
    vadesizde_kalacak: r.vadesiz,
    vadesiz_hesaplama_tipi: "sabit",
    vadesiz_oran: null,
    raw: { "Faiz İşletilmeyecek Min. Tutar": r.vadesizRaw, [FIBA_KIRAZ_DIJITAL_COL]: r.dijitalRaw, "Fonlu Kiraz Ek Faiz Oranı": r.fonluEkRaw },
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

function parseFibabankaKirazHosgeldin(html: string): ParseResult {
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
      raw: { "Faiz İşletilmeyecek Min. Tutar": r.vadesizRaw, [winningColumn]: winningRaw },
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

function parseAkbankSerbestPlus(html: string): ParseResult {
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (!doc) return fail("HTML ayrıştırılamadı");

  const container = doc.querySelector(".free-plus-table");
  const table = container?.querySelector("table") ?? doc.querySelector(".free-plus-table table");
  if (!table) return fail('.free-plus-table table bulunamadı — sayfa yapısı değişmiş olabilir');

  const headers = Array.from(table.querySelectorAll("thead th")).map((th) => textOf(th));
  const rateRow = table.querySelector("tbody tr");
  const rateCells = rateRow ? Array.from(rateRow.querySelectorAll("td")).map((td) => textOf(td)) : [];

  if (headers.length === 0 || headers.length !== rateCells.length) {
    return fail(`Başlık/oran sayısı uyuşmuyor (başlık: ${headers.length}, oran: ${rateCells.length})`);
  }

  // Vadesiz oranı, sabit metinden ayrıca doğrulanır (tablo dışında).
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

  type RawTier = { alt: number; ust: number; rate: number };
  const rawTiers: RawTier[] = [];
  for (let i = 0; i < headers.length; i++) {
    const label = headers[i];
    const rate = parseTRPercent(rateCells[i]);
    if (rate === null) return fail(`Oran ayrıştırılamadı: "${rateCells[i]}"`);

    const uzeriMatch = label.match(/^([\d.,]+)\s*TL\s*üzeri/i);
    const rangeMatch = label.match(/^([\d.,]+)\s*TL\s*-\s*([\d.,]+)\s*TL/i);

    if (uzeriMatch) {
      // "X TL üzeri" = X'in KENDİSİ DEĞİL, yalnızca üzeri (kesin olarak X'ten
      // büyük). X'in kendisi bir önceki ("...-X TL") bandına dahildir. Bu
      // yüzden alt sınır X değil, X+0.01 olmalı — aksi halde X'in kendisi
      // yanlışlıkla bu (daha düşük) orana düşer.
      const threshold = parseTRMoney(uzeriMatch[1]);
      if (threshold === null) return fail(`Tutar aralığı ayrıştırılamadı: "${label}"`);
      rawTiers.push({ alt: threshold + 0.01, ust: 9999999999, rate });
    } else if (rangeMatch) {
      const alt = parseTRMoney(rangeMatch[1]);
      const ust = parseTRMoney(rangeMatch[2]);
      if (alt === null || ust === null) return fail(`Tutar aralığı ayrıştırılamadı: "${label}"`);
      rawTiers.push({ alt, ust, rate });
    } else {
      return fail(`Tanınmayan tutar aralığı biçimi: "${label}"`);
    }
  }

  rawTiers.sort((a, b) => a.alt - b.alt);
  const rawTierCount = rawTiers.length;

  // Ardışık, aynı orana sahip bantları tek bantta birleştir (Akbank'ın
  // veri modelde tutulan bant sayısı, sayfadaki ham kademe sayısından
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

  const bands: ParsedBand[] = merged.map((t) => ({
    alt_limit: t.alt,
    ust_limit: t.ust,
    yillik_brut_oran: t.rate,
    vadesizde_kalacak: 0,
    vadesiz_hesaplama_tipi: "yuzde",
    vadesiz_oran: vadesizYuzde,
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

function parseOdeabankRawRows(html: string): { ok: true; rows: OdeabankRawRow[] } | { ok: false; error: string } {
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (!doc) return { ok: false, error: "HTML ayrıştırılamadı" };

  const boxes = Array.from(doc.querySelectorAll(".content-box"));
  const box = boxes.find((b) => {
    const heading = textOf(b.querySelector("h2"));
    return heading.includes("Oksijen Hesap") && heading.includes("TL") && !heading.includes("USD") && !heading.includes("EUR");
  });
  if (!box) return { ok: false, error: '"Oksijen Hesap* - TL" başlıklı bölüm bulunamadı — sayfa yapısı değişmiş olabilir' };

  const table = box.querySelector("table");
  if (!table) return { ok: false, error: '"Oksijen Hesap* - TL" bölümünde tablo bulunamadı' };

  const trs = Array.from(table.querySelectorAll("tbody tr"));
  if (trs.length === 0) return { ok: false, error: "tbody satırı bulunamadı" };

  const rows: OdeabankRawRow[] = [];
  for (const row of trs) {
    const tds = Array.from(row.querySelectorAll("td"));
    if (tds.length < 4) return { ok: false, error: `Beklenmeyen hücre sayısı: ${tds.length}` };

    const rangeText = textOf(tds[0]);
    const rangeMatch = rangeText.match(/^([\d.,]+)\s*-\s*([\d.,]+)$/);
    if (!rangeMatch) return { ok: false, error: `Tutar aralığı ayrıştırılamadı: "${rangeText}"` };
    const alt = parseTRMoney(rangeMatch[1]);
    const ust = parseTRMoney(rangeMatch[2]);

    const vadesizRaw = textOf(tds[1]);
    const hosGeldinRaw = textOf(tds[2]);
    const yeniMusteriRaw = textOf(tds[3]);
    const vadesiz = parseTRMoney(vadesizRaw);
    const hosGeldinOran = parseTRPercent(hosGeldinRaw);
    const yeniMusteriOran = parseTRPercent(yeniMusteriRaw);

    if (alt === null || ust === null || vadesiz === null || hosGeldinOran === null || yeniMusteriOran === null) {
      return { ok: false, error: `Sayısal alan ayrıştırılamadı (satır: "${rangeText}")` };
    }

    rows.push({ alt, ust, vadesiz, vadesizRaw, hosGeldinOran, hosGeldinRaw, yeniMusteriOran, yeniMusteriRaw });
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
function parseOdeabankYeniMusteriOksijen(html: string): ParseResult {
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

const PARSERS: Record<string, (html: string) => ParseResult> = {
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

interface BankRateRow {
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

  if (source.page_marker_text && !fetched.html.includes(source.page_marker_text)) {
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

  const parsed = parser(fetched.html);
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
  const parsedSorted = [...parsed.bands].sort((a, b) => a.alt_limit - b.alt_limit);

  if (stored.length !== parsedSorted.length) {
    await supabase.from("rate_check_findings").insert({
      run_id: runId,
      bank_source_id: source.id,
      bank_id: source.bank_id,
      finding_type: "parse_error",
      evidence_url: source.source_url,
      current_value: stored,
      observed_value: parsedSorted,
      detail: `Bant sayısı değişmiş görünüyor (kayıtlı: ${stored.length}, sayfada bulunan: ${parsedSorted.length}) — otomatik eşleştirme güvenli değil, lütfen elle kontrol edin.`,
    });
    await supabase
      .from("bank_sources")
      .update({ last_checked_at: new Date().toISOString(), last_check_status: "parse_error" })
      .eq("id", source.id);
    return { status: "parse_error", findingsCreated: 1 };
  }

  let anyNewChange = false; // gerçekten yeni, kabul edilmemiş bir fark var mı
  let anyAcceptedDiff = false; // fark var ama daha önce admin tarafından kabul edilmiş
  let findingsCreated = 0;

  for (let i = 0; i < stored.length; i++) {
    const storedBand = stored[i];
    const parsedBand = parsedSorted[i];
    const storedAsParsed: ParsedBand = {
      alt_limit: Number(storedBand.alt_limit),
      ust_limit: Number(storedBand.ust_limit),
      yillik_brut_oran: Number(storedBand.yillik_brut_oran),
      vadesizde_kalacak: Number(storedBand.vadesizde_kalacak),
      vadesiz_hesaplama_tipi: storedBand.vadesiz_hesaplama_tipi,
      vadesiz_oran: storedBand.vadesiz_oran !== null ? Number(storedBand.vadesiz_oran) : null,
    };

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

    anyNewChange = true;

    const { data: existingPending } = await supabase
      .from("rate_change_requests")
      .select("id, proposed_data, previous_data")
      .eq("bank_rate_id", storedBand.id)
      .eq("status", "pending")
      .eq("source", "automation");

    const proposedCanonical = canonicalJson(proposedData);
    const duplicate = (existingPending ?? []).find((r: { proposed_data: unknown; previous_data: unknown }) => {
      if (canonicalJson(r.proposed_data) !== proposedCanonical) return false;
      // Mevcut pending talebin previous_data'sı (o talep açıldığında beklenen
      // taban değer) hâlâ canlı bant ile eşleşiyor mu? Eşleşmiyorsa o talep
      // ARTIK BAYAT demektir (approve_rate_change de bunu ayrıca reddeder) —
      // mükerrer sayılmaz, aşağıda taze previous_data'lı YENİ bir talep
      // açılır. Eski bayat talep pending kalmaya devam eder; admin onu
      // reddedip taze talebi onaylayabilir.
      const prevParsed = parsedBandFromSnapshot(r.previous_data);
      if (!prevParsed) return false;
      return bandsEqual(prevParsed, storedAsParsed);
    });

    if (duplicate) {
      await supabase.from("rate_check_findings").insert({
        run_id: runId,
        bank_source_id: source.id,
        bank_id: source.bank_id,
        finding_type: "rate_changed",
        evidence_url: source.source_url,
        current_value: storedBand,
        observed_value: proposedData,
        rate_change_request_id: duplicate.id,
        fingerprint,
        raw_evidence: parsedBand.raw ?? null,
        source_table_name: parsedBand.source_table_name ?? null,
        selected_rate_column: parsedBand.selected_rate_column ?? null,
        selected_rate_condition: parsedBand.selected_rate_condition ?? null,
        observed_rate_candidates: parsedBand.observed_rate_candidates ?? null,
        detail: "Bu değişiklik için zaten onay bekleyen bir talep var (mükerrer oluşturulmadı).",
      });
      findingsCreated++;
      continue;
    }

    const { data: newRequest, error: insertErr } = await supabase
      .from("rate_change_requests")
      .insert({
        bank_rate_id: storedBand.id,
        bank_id: source.bank_id,
        change_type: "update",
        proposed_data: proposedData,
        previous_data: storedBand,
        requested_by: null,
        source: "automation",
        status: "pending",
      })
      .select("id")
      .single();

    await supabase.from("rate_check_findings").insert({
      run_id: runId,
      bank_source_id: source.id,
      bank_id: source.bank_id,
      finding_type: "rate_changed",
      evidence_url: source.source_url,
      current_value: storedBand,
      observed_value: proposedData,
      rate_change_request_id: newRequest?.id ?? null,
      fingerprint,
      raw_evidence: parsedBand.raw ?? null,
      source_table_name: parsedBand.source_table_name ?? null,
      selected_rate_column: parsedBand.selected_rate_column ?? null,
      selected_rate_condition: parsedBand.selected_rate_condition ?? null,
      observed_rate_candidates: parsedBand.observed_rate_candidates ?? null,
      detail: insertErr ? `Talep oluşturulamadı: ${insertErr.message}` : undefined,
    });
    findingsCreated++;
  }

  if (!anyNewChange && !anyAcceptedDiff) {
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

Deno.serve(async (req: Request) => {
  if (!(await isAuthorized(req))) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
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
        return new Response(
          JSON.stringify({ error: "Retry kararı alınamadı", detail: decisionErr?.message }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }

      if (decision.action === "skip") {
        return new Response(
          JSON.stringify({ skipped: true, reason: decision.reason, run_id: decision.run_id }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
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
        return new Response(JSON.stringify({ error: "rate_check_runs oluşturulamadı", detail: runErr?.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
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
      return new Response(JSON.stringify({ error: "bank_sources okunamadı", run_id: runId }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
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

    return new Response(
      JSON.stringify({
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
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
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
    return new Response(JSON.stringify({ error: "Beklenmeyen hata", detail: message, run_id: runId }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
