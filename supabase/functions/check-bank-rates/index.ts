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

/** "7.500" veya "7.500 TL" veya "7,500" -> 7500 (binlik nokta VEYA virgül olabilir, ondalık yok varsayımı) */
function parseTRMoney(raw: string): number | null {
  const cleaned = raw.replace(/TL/gi, "").replace(/\s/g, "").trim();
  if (!cleaned) return null;
  // Hem "7.500" (TR binlik nokta) hem "7,500" (bazı sayfalarda EN tarzı binlik virgül)
  // formatlarını destekle: son 3'lü grup ayırıcılarını kaldır, ondalık nokta/virgül yok say
  // (bu sayfalardaki tutarlar zaten tam sayı TL).
  const digitsOnly = cleaned.replace(/[.,](?=\d{3}(\D|$))/g, "").replace(/[.,]/g, "");
  const n = Number(digitsOnly);
  if (!Number.isFinite(n)) return null;
  return n;
}

function textOf(el: Element | null | undefined): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Ortak tipler
// ---------------------------------------------------------------------------

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

  return { ok: true, bands, rawTierCount: bands.length };
}

function parseFibabankaFonluKiraz(html: string): ParseResult {
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (!doc) return fail("HTML ayrıştırılamadı");

  // "Fonlu Kiraz Ek Faiz Oranı" başlığını içeren ilk tabloyu bul (sayfada
  // farklı tab/varyantlar için birden çok benzer tablo var; yalnızca bu
  // başlığı taşıyan tablo Fonlu Kiraz'a ait).
  const tables = Array.from(doc.querySelectorAll("table"));
  const table = tables.find((t) => textOf(t.querySelector("thead")).includes("Fonlu Kiraz Ek Faiz Oranı"));
  if (!table) return fail('"Fonlu Kiraz Ek Faiz Oranı" başlıklı tablo bulunamadı — sayfa yapısı değişmiş olabilir');

  const rows = Array.from(table.querySelectorAll("tbody tr"));
  if (rows.length === 0) return fail("tbody satırı bulunamadı");

  const bands: ParsedBand[] = [];
  for (const row of rows) {
    const rangeText = textOf(row.querySelector("th"));
    const tds = Array.from(row.querySelectorAll("td"));
    if (tds.length < 5) return fail(`Beklenmeyen hücre sayısı: ${tds.length}`);

    const rangeMatch = rangeText.match(/^([\d.,]+)\s*-\s*([\d.,]+)/);
    if (!rangeMatch) return fail(`Tutar aralığı ayrıştırılamadı: "${rangeText}"`);
    const alt = parseTRMoney(rangeMatch[1]);
    const ust = parseTRMoney(rangeMatch[2]);

    const vadesiz = parseTRMoney(textOf(tds[0]));
    const dijitalOran = parseTRPercent(textOf(tds[2]));
    const fonluEk = parseTRPercent(textOf(tds[4]));

    if (alt === null || ust === null || vadesiz === null || dijitalOran === null || fonluEk === null) {
      return fail(`Sayısal alan ayrıştırılamadı (satır: "${rangeText}")`);
    }

    bands.push({
      alt_limit: alt,
      ust_limit: ust,
      yillik_brut_oran: Math.round((dijitalOran + fonluEk) * 100000) / 100000,
      vadesizde_kalacak: vadesiz,
      vadesiz_hesaplama_tipi: "sabit",
      vadesiz_oran: null,
    });
  }

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

const PARSERS: Record<string, (html: string) => ParseResult> = {
  "TOM Bank": parseTomBank,
  "Fibabanka Fonlu Kiraz": parseFibabankaFonluKiraz,
  "Akbank Serbest Plus Hesap": parseAkbankSerbestPlus,
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
    if (b.vadesiz_hesaplama_tipi === "sabit") {
      if (b.vadesizde_kalacak > b.alt_limit) {
        return `Vadesizde kalan tutar (${b.vadesizde_kalacak}) alt limitten (${b.alt_limit}) büyük`;
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
    note,
    gerekli_fon_bakiyesi: gerekliFonBakiyesi,
    vadesiz_hesaplama_tipi: b.vadesiz_hesaplama_tipi,
    vadesiz_oran: b.vadesiz_oran,
  };
}

async function processSource(
  supabase: SupabaseClient,
  runId: string,
  source: BankSourceRow,
  dryRun: boolean
): Promise<{ status: "ok" | "unreachable" | "parse_error" | "manual_required"; findingsCreated: number }> {
  const bankName = source.banks?.name ?? source.bank_id;

  if (source.requires_manual_check) {
    await supabase.from("rate_check_findings").insert({
      run_id: runId,
      bank_source_id: source.id,
      bank_id: source.bank_id,
      finding_type: "manual_required",
      evidence_url: source.source_url,
      detail: `${bankName} için güvenilir, otomatik ayrıştırılabilir bir kaynak yok. Lütfen resmi sayfayı elle kontrol edin.`,
    });
    await supabase
      .from("bank_sources")
      .update({ last_checked_at: new Date().toISOString(), last_check_status: "manual_required" })
      .eq("id", source.id);
    return { status: "manual_required", findingsCreated: 1 };
  }

  const fetched = await fetchSourcePage(source.source_url);
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
        detail: "(dry run — talep oluşturulmadı)",
      });
      findingsCreated++;
      continue;
    }

    anyNewChange = true;

    const { data: existingPending } = await supabase
      .from("rate_change_requests")
      .select("id, proposed_data")
      .eq("bank_rate_id", storedBand.id)
      .eq("status", "pending")
      .eq("source", "automation");

    const proposedCanonical = canonicalJson(proposedData);
    const duplicate = (existingPending ?? []).find(
      (r: { proposed_data: unknown }) => canonicalJson(r.proposed_data) === proposedCanonical
    );

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

Deno.serve(async (req: Request) => {
  if (!(await isAuthorized(req))) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let dryRun = false;
  let triggeredBy: "cron" | "manual" = req.headers.get("x-cron-secret") ? "cron" : "manual";
  try {
    if (req.headers.get("content-type")?.includes("application/json")) {
      const body = await req.json().catch(() => ({}));
      if (body?.dryRun === true || body?.dry_run === true) dryRun = true;
    }
  } catch {
    // gövde yoksa/parse edilemezse varsayılanlarla devam
  }
  const url = new URL(req.url);
  if (url.searchParams.get("dry_run") === "true") dryRun = true;

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: run, error: runErr } = await supabase
    .from("rate_check_runs")
    .insert({ status: "running", triggered_by: triggeredBy, dry_run: dryRun })
    .select("id")
    .single();

  if (runErr || !run) {
    return new Response(JSON.stringify({ error: "rate_check_runs oluşturulamadı" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { data: sources, error: sourcesErr } = await supabase
    .from("bank_sources")
    .select("id, bank_id, source_url, page_marker_text, expected_tier_count, requires_manual_check, banks(name)")
    .order("created_at", { ascending: true });

  if (sourcesErr || !sources) {
    await supabase
      .from("rate_check_runs")
      .update({
        status: "failure",
        finished_at: new Date().toISOString(),
        error_summary: sourcesErr?.message ?? "bank_sources okunamadı",
      })
      .eq("id", run.id);
    return new Response(JSON.stringify({ error: "bank_sources okunamadı" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  let sourcesChecked = 0;
  let sourcesUnreachable = 0;
  let findingsCreated = 0;
  const summary: Record<string, string> = {};

  // Her banka izole: biri hata verse de döngü diğerlerini kontrol etmeye devam eder.
  for (const source of sources as unknown as BankSourceRow[]) {
    sourcesChecked++;
    try {
      const result = await processSource(supabase, run.id, source, dryRun);
      findingsCreated += result.findingsCreated;
      if (result.status === "unreachable") sourcesUnreachable++;
      summary[source.banks?.name ?? source.bank_id] = result.status;
    } catch (err) {
      sourcesUnreachable++;
      const message = err instanceof Error ? err.message : String(err);
      summary[source.banks?.name ?? source.bank_id] = "error";
      await supabase.from("rate_check_findings").insert({
        run_id: run.id,
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
    .eq("run_id", run.id);

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

  await supabase
    .from("rate_check_runs")
    .update({
      status: finalStatus,
      finished_at: new Date().toISOString(),
      sources_checked: sourcesChecked,
      sources_unreachable: sourcesUnreachable,
      findings_created: findingsCreated,
    })
    .eq("id", run.id);

  return new Response(
    JSON.stringify({
      run_id: run.id,
      status: finalStatus,
      dry_run: dryRun,
      sources_checked: sourcesChecked,
      sources_unreachable: sourcesUnreachable,
      findings_created: findingsCreated,
      categories: categoryCounts,
      summary,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
});
