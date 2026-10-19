// check-bank-rates parser test suite — fixture-based, offline (Akbank/Yapı
// Kredi'nin AJAX/ikincil kaynak fetch()'leri globalThis.fetch stub'ıyla
// taklit edilir; gerçek Supabase'e HİÇBİR yazma yapılmaz).
//
// `import.meta.main` koruması sayesinde index.ts import edildiğinde
// Deno.serve HİÇ çalışmaz — bu dosya yalnızca export edilen parser/yardımcı
// fonksiyonları izole şekilde test eder.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  parseAkbankSerbestPlus,
  parseFibabankaFonluKiraz,
  parseFibabankaKirazHosgeldin,
  parseTomBank,
  matchStoredBands,
  parseYapiKrediSinirsizHesap,
  parseQNBKazandiranGunluk,
  parseOdeabankYeniMusteriOksijen,
  parseTRPercent,
  parseTRMoney,
  markerSearchText,
  type BankRateRow,
} from "./index.ts";

const FIX = new URL("./fixtures/", import.meta.url);
async function readFixture(name: string): Promise<string> {
  return await Deno.readTextFile(new URL(name, FIX));
}

function stubRate(overrides: Partial<BankRateRow> & { alt_limit: number; ust_limit: number; vadesizde_kalacak: number }): BankRateRow {
  return {
    id: `stub-${overrides.alt_limit}`,
    note: "",
    gerekli_fon_bakiyesi: null,
    vadesiz_hesaplama_tipi: "sabit",
    vadesiz_oran: null,
    yillik_brut_oran: 0.41,
    ...overrides,
  } as BankRateRow;
}

// Gerçek normalize edilmiş 9 Yapı Kredi bandı (20260915120000 migration).
const YK_STORED: BankRateRow[] = [
  stubRate({ alt_limit: 10000, ust_limit: 49999.99, vadesizde_kalacak: 5000 }),
  stubRate({ alt_limit: 50000, ust_limit: 99999.99, vadesizde_kalacak: 10000 }),
  stubRate({ alt_limit: 100000, ust_limit: 249999.99, vadesizde_kalacak: 20000 }),
  stubRate({ alt_limit: 250000, ust_limit: 499999.99, vadesizde_kalacak: 40000 }),
  stubRate({ alt_limit: 500000, ust_limit: 999999.99, vadesizde_kalacak: 75000 }),
  stubRate({ alt_limit: 1000000, ust_limit: 1999999.99, vadesizde_kalacak: 150000 }),
  stubRate({ alt_limit: 2000000, ust_limit: 2999999.99, vadesizde_kalacak: 250000 }),
  stubRate({ alt_limit: 3000000, ust_limit: 4999999.99, vadesizde_kalacak: 400000 }),
  stubRate({ alt_limit: 5000000, ust_limit: 10000000, vadesizde_kalacak: 700000 }),
];

// Gerçek normalize edilmiş 17 QNB bandı (20260916090000 migration).
const QNB_STORED: BankRateRow[] = [
  stubRate({ alt_limit: 0, ust_limit: 49999.99, vadesizde_kalacak: 7500 }),
  stubRate({ alt_limit: 50000, ust_limit: 74999.99, vadesizde_kalacak: 10000 }),
  stubRate({ alt_limit: 75000, ust_limit: 99999.99, vadesizde_kalacak: 12500 }),
  stubRate({ alt_limit: 100000, ust_limit: 249999.99, vadesizde_kalacak: 15000 }),
  stubRate({ alt_limit: 250000, ust_limit: 349999.99, vadesizde_kalacak: 30000 }),
  stubRate({ alt_limit: 350000, ust_limit: 499999.99, vadesizde_kalacak: 40000 }),
  stubRate({ alt_limit: 500000, ust_limit: 749999.99, vadesizde_kalacak: 60000 }),
  stubRate({ alt_limit: 750000, ust_limit: 999999.99, vadesizde_kalacak: 75000 }),
  stubRate({ alt_limit: 1000000, ust_limit: 1999999.99, vadesizde_kalacak: 150000 }),
  stubRate({ alt_limit: 2000000, ust_limit: 2499999.99, vadesizde_kalacak: 200000 }),
  stubRate({ alt_limit: 2500000, ust_limit: 3499999.99, vadesizde_kalacak: 300000 }),
  stubRate({ alt_limit: 3500000, ust_limit: 4999999.99, vadesizde_kalacak: 400000 }),
  stubRate({ alt_limit: 5000000, ust_limit: 7499999.99, vadesizde_kalacak: 600000 }),
  stubRate({ alt_limit: 7500000, ust_limit: 9999999.99, vadesizde_kalacak: 850000 }),
  stubRate({ alt_limit: 10000000, ust_limit: 19999999.99, vadesizde_kalacak: 1250000 }),
  stubRate({ alt_limit: 20000000, ust_limit: 29999999.99, vadesizde_kalacak: 2000000 }),
  stubRate({ alt_limit: 30000000, ust_limit: 9999999999, vadesizde_kalacak: 2000000 }),
];

const TOM_STORED: BankRateRow[] = [
  stubRate({ alt_limit: 7500, ust_limit: 49999.99, vadesizde_kalacak: 7500, yillik_brut_oran: 0.43 }),
  stubRate({ alt_limit: 50000, ust_limit: 249999.99, vadesizde_kalacak: 35000, yillik_brut_oran: 0.43 }),
  stubRate({ alt_limit: 250000, ust_limit: 499999.99, vadesizde_kalacak: 50000, yillik_brut_oran: 0.43 }),
  stubRate({ alt_limit: 500000, ust_limit: 1249999.99, vadesizde_kalacak: 200000, yillik_brut_oran: 0.475 }),
  stubRate({ alt_limit: 1250000, ust_limit: 2499999.99, vadesizde_kalacak: 450000, yillik_brut_oran: 0.48 }),
  stubRate({ alt_limit: 2500000, ust_limit: 7499999.99, vadesizde_kalacak: 775000, yillik_brut_oran: 0.44 }),
  stubRate({ alt_limit: 7500000, ust_limit: 17499999.99, vadesizde_kalacak: 1750000, yillik_brut_oran: 0.44 }),
  stubRate({ alt_limit: 17500000, ust_limit: 34999999.99, vadesizde_kalacak: 3000000, yillik_brut_oran: 0.425 }),
  stubRate({ alt_limit: 35000000, ust_limit: 75000000, vadesizde_kalacak: 5000000, yillik_brut_oran: 0.41 }),
];

function withFetchStub<T>(impl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).fetch = impl;
  return fn().finally(() => {
    // deno-lint-ignore no-explicit-any
    (globalThis as any).fetch = original;
  });
}

// ---------------------------------------------------------------------------
// parseTRPercent / parseTRMoney — temel biçim testleri
// ---------------------------------------------------------------------------
Deno.test("parseTRPercent: TR ondalık ve yüzde işareti biçimleri", () => {
  assertEquals(parseTRPercent("41,75%"), 0.4175);
  assertEquals(parseTRPercent("%41,75"), 0.4175);
  assertEquals(parseTRPercent("38,50"), 0.385); // AJAX'ın işaretsiz TR-ondalık biçimi de kapsanır
  assertEquals(parseTRPercent(""), null);
  // NOT: "41.75" TR biçiminde "." binlik ayırıcı sayılır ("4175" -> 41.75,
  // yüzde işareti YOK burada) — bu fonksiyon İngilizce ondalık nokta biçimini
  // DESTEKLEMEZ. QNB sayfası tam olarak bu biçimi kullandığı için (ör.
  // "41.75%") ayrı bir parseQNBPercent() yazıldı; bkz. Akbank/QNB testleri.
});

Deno.test("parseTRMoney: TR binlik/ondalık ayırıcı", () => {
  assertEquals(parseTRMoney("49.999,99 TL"), 49999.99);
  assertEquals(parseTRMoney("10.000"), 10000);
  assertEquals(parseTRMoney(""), null);
});

// ---------------------------------------------------------------------------
// TOM Bank — resmî tabloda tek sınırın 17,5M -> 20M taşınması
// ---------------------------------------------------------------------------
Deno.test("TOM Bank: güncel 9 bant kuruş boşluğu bırakmadan ayrıştırılır", async () => {
  const html = await readFixture("tombank_current_structure.html");
  const result = parseTomBank(html);
  assert(result.ok, `TOM parse hatası: ${result.error ?? ""}`);
  assertEquals(result.bands.length, 9);
  for (let i = 0; i < result.bands.length - 1; i++) {
    assertEquals(Math.round((result.bands[i + 1].alt_limit - result.bands[i].ust_limit) * 100) / 100, 0.01);
  }
  assertEquals(result.bands[6].alt_limit, 7500000);
  assertEquals(result.bands[6].ust_limit, 19999999.99);
  assertEquals(result.bands[6].yillik_brut_oran, 0.44);
  assertEquals(result.bands[7].alt_limit, 20000000);
  assertEquals(result.bands[7].yillik_brut_oran, 0.39);
  assertEquals(result.bands[8].yillik_brut_oran, 0.39);
});

Deno.test("TOM Bank: tek yapısal sınır değişikliği güvenli satır sırasıyla eşleştirilir", async () => {
  const html = await readFixture("tombank_current_structure.html");
  const result = parseTomBank(html);
  assert(result.ok);
  const matched = matchStoredBands("TOM Bank", TOM_STORED, result.bands);
  assert(matched.ok, matched.error);
  assertEquals(matched.structuralChange, true);
  assertEquals(matched.pairs.length, 9);
  assertEquals(matched.pairs[7].storedBand.alt_limit, 17500000);
  assertEquals(matched.pairs[7].parsedBand.alt_limit, 20000000);

  const otherBank = matchStoredBands("Başka Banka", TOM_STORED, result.bands);
  assertEquals(otherBank.ok, false, "satır-sırası istisnası yalnızca doğrulanmış TOM Bank akışına ait olmalı");

  const shiftedInsertion = result.bands.map((band) => ({ ...band }));
  shiftedInsertion[5].alt_limit = 2600000;
  shiftedInsertion.splice(7, 1);
  shiftedInsertion.push({ ...result.bands[7], alt_limit: 76000000, ust_limit: 80000000 });
  const unsafeOrdinalShift = matchStoredBands("TOM Bank", TOM_STORED, shiftedInsertion);
  assertEquals(unsafeOrdinalShift.ok, false, "farklı sıra konumunda silme/ekleme, tek değişen sınır gibi kabul edilmemeli");
});

// ---------------------------------------------------------------------------
// Fibabanka — iki ürün, ortak tablo ve kuruş bazlı bant normalizasyonu
// ---------------------------------------------------------------------------
Deno.test("Fibabanka: iki ürünün 12 bandı kuruş boşluğu bırakmadan normalize edilir", async () => {
  const html = await readFixture("fibabanka_kiraz_ok.html");
  const hosgeldin = parseFibabankaKirazHosgeldin(html);
  const fonlu = parseFibabankaFonluKiraz(html);

  assert(hosgeldin.ok, `Hoş Geldin parse hatası: ${!hosgeldin.ok ? hosgeldin.error : ""}`);
  assert(fonlu.ok, `Fonlu parse hatası: ${!fonlu.ok ? fonlu.error : ""}`);
  if (!hosgeldin.ok || !fonlu.ok) return;

  assertEquals(hosgeldin.bands.length, 12);
  assertEquals(fonlu.bands.length, 12);

  for (const result of [hosgeldin, fonlu]) {
    const bands = [...result.bands].sort((a, b) => a.alt_limit - b.alt_limit);
    for (let i = 0; i < bands.length - 1; i++) {
      assertEquals(
        Math.round((bands[i + 1].alt_limit - bands[i].ust_limit) * 100) / 100,
        0.01,
        `${i + 1}. ve ${i + 2}. bant arasında 0,01 TL geçiş olmalı`,
      );
    }
    assertEquals(bands[0].ust_limit, 24999.99);
    assertEquals(bands[10].ust_limit, 7499999.99);
    assertEquals(bands[11].ust_limit, 10000000, "son bandın üst sınırı değiştirilmemeli");
  }

  assertEquals(hosgeldin.bands[0].yillik_brut_oran, 0.41);
  assertEquals(fonlu.bands[0].yillik_brut_oran, 0.43);
  assertStringIncludes(String(hosgeldin.bands[0].raw?.Normalizasyon), "+0,99 TL");
  assertStringIncludes(String(fonlu.bands[0].raw?.Normalizasyon), "+0,99 TL");
});

Deno.test("Fibabanka: 1 TL/0,01 TL dışında yapısal boşluk varsa oran önerilmez", async () => {
  const html = await readFixture("fibabanka_kiraz_internal_gap.html");
  const hosgeldin = parseFibabankaKirazHosgeldin(html);
  const fonlu = parseFibabankaFonluKiraz(html);

  assertEquals(hosgeldin.ok, false);
  assertEquals(fonlu.ok, false);
  if (!hosgeldin.ok) assertStringIncludes(hosgeldin.error ?? "", "bitişik değil");
  if (!fonlu.ok) assertStringIncludes(fonlu.error ?? "", "bitişik değil");
});

// ---------------------------------------------------------------------------
// markerSearchText — HTML entity decode testi (Akbank regresyonu)
// ---------------------------------------------------------------------------
Deno.test("markerSearchText: HTML entity ile encode edilmiş Türkçe karakteri decode eder", () => {
  const html = "<html><body><h2>Serbest Plus Hesap Faiz Oran&#305;</h2></body></html>";
  const text = markerSearchText(html);
  assertStringIncludes(text, "Serbest Plus Hesap Faiz Oranı");
});

// ---------------------------------------------------------------------------
// Akbank — AJAX servisinden okuma
// ---------------------------------------------------------------------------
Deno.test("Akbank: AJAX servisinden 2 birleştirilmiş bant doğru okunuyor", async () => {
  const html = await readFixture("akbank_ok.html");
  const ajaxJson = await readFixture("akbank_ajax_ok.json");
  const result = await withFetchStub(
    () => Promise.resolve(new Response(ajaxJson, { status: 200, headers: { "content-type": "application/json" } })),
    () => parseAkbankSerbestPlus(html)
  );
  assert(result.ok, `beklenmeyen hata: ${!result.ok ? result.error : ""}`);
  if (!result.ok) return;
  assertEquals(result.bands.length, 2, "3 aynı-oranlı ham kademe 1 banda birleşmeli, 4. kademe ayrı kalmalı");
  const [b1, b2] = [...result.bands].sort((a, b) => a.alt_limit - b.alt_limit);
  assertEquals(b1.alt_limit, 10000);
  assertEquals(b1.ust_limit, 25000000);
  assertEquals(b1.yillik_brut_oran, 0.385);
  assertEquals(b1.vadesiz_hesaplama_tipi, "yuzde");
  assertEquals(b1.vadesiz_oran, 10);
  // Tam çakışan sınır (25.000.000) +0,01 ile ayrıştırılmalı — çakışma değil.
  assertEquals(b2.alt_limit, 25000000.01);
  assertEquals(b2.yillik_brut_oran, 0.04);
});

Deno.test("Akbank: vadesiz yüzdesi cümlesi bulunamazsa parse başarısız olur (tahmin üretmez)", async () => {
  const html = await readFixture("akbank_vadesiz_missing.html");
  const ajaxJson = await readFixture("akbank_ajax_ok.json");
  const result = await withFetchStub(
    () => Promise.resolve(new Response(ajaxJson, { status: 200 })),
    () => parseAkbankSerbestPlus(html)
  );
  assertEquals(result.ok, false);
});

Deno.test("Akbank: servis birden fazla vade dönemi döndürürse (yeni ürün boyutu) parse başarısız olur", async () => {
  const html = await readFixture("akbank_ok.html");
  const ajaxJson = await readFixture("akbank_ajax_multi_period.json");
  const result = await withFetchStub(
    () => Promise.resolve(new Response(ajaxJson, { status: 200 })),
    () => parseAkbankSerbestPlus(html)
  );
  assertEquals(result.ok, false, "birden fazla dönem sessizce ilk döneme düşmemeli — açıkça reddedilmeli");
});

Deno.test("Akbank: servis beklenmeyen/eksik yapıda JSON döndürürse parse başarısız olur", async () => {
  const html = await readFixture("akbank_ok.html");
  const ajaxJson = await readFixture("akbank_ajax_malformed.json");
  const result = await withFetchStub(
    () => Promise.resolve(new Response(ajaxJson, { status: 200 })),
    () => parseAkbankSerbestPlus(html)
  );
  assertEquals(result.ok, false);
});

// ---------------------------------------------------------------------------
// Yapı Kredi — rate-only, alt_limit eşleştirmeli
// ---------------------------------------------------------------------------
Deno.test("Yapı Kredi: 9 bant kayıtlı alt_limit'e göre doğru eşleşiyor, alt/ust/vadesiz DEĞİŞMİYOR", async () => {
  const html = await readFixture("yapikredi_ok.html");
  const campaignHtml = await readFixture("yapikredi_campaign_ok.html");
  const result = await withFetchStub(
    () => Promise.resolve(new Response(campaignHtml, { status: 200 })),
    () => parseYapiKrediSinirsizHesap(html, YK_STORED)
  );
  assert(result.ok, `beklenmeyen hata: ${!result.ok ? result.error : ""}`);
  if (!result.ok) return;
  assertEquals(result.bands.length, 9);
  for (const b of result.bands) {
    const stored = YK_STORED.find((s) => s.alt_limit === b.alt_limit);
    assert(stored, `${b.alt_limit} için kayıtlı bant bulunamadı`);
    assertEquals(b.ust_limit, stored!.ust_limit, "ust_limit stored'dan aynen kopyalanmalı");
    assertEquals(b.vadesizde_kalacak, stored!.vadesizde_kalacak, "vadesizde_kalacak stored'dan aynen kopyalanmalı");
  }
});

Deno.test("Yapı Kredi: 3 (+kampanya sayfası) adaydan en yükseği seçiliyor, koşul metni kayboLmuyor", async () => {
  const html = await readFixture("yapikredi_ok.html");
  const campaignHtml = await readFixture("yapikredi_campaign_ok.html");
  const result = await withFetchStub(
    () => Promise.resolve(new Response(campaignHtml, { status: 200 })),
    () => parseYapiKrediSinirsizHesap(html, YK_STORED)
  );
  assert(result.ok);
  if (!result.ok) return;
  const b = result.bands[0];
  // Sabit fixture: Kampanyalı %40,50 > Kampanya Sonrası %35,00 > Baz %4,00; kampanya sayfası da %40,50.
  assertEquals(Math.round(b.yillik_brut_oran * 10000) / 10000, 0.405);
  assert(b.selected_rate_condition && b.selected_rate_condition.length > 0, "koşul metni boş olmamalı");
  assert(b.observed_rate_candidates && b.observed_rate_candidates.length >= 3, "tüm adaylar korunmalı");
});

Deno.test("Yapı Kredi: beklenen sütun başlığı bulunamazsa (yapısı değişmiş) parse başarısız olur", async () => {
  const html = await readFixture("yapikredi_missing_column.html");
  const result = await withFetchStub(
    () => Promise.resolve(new Response("", { status: 500 })), // kampanya sayfası erişilemez olsa bile ana hata önce yakalanmalı
    () => parseYapiKrediSinirsizHesap(html, YK_STORED)
  );
  assertEquals(result.ok, false);
});

Deno.test("Yapı Kredi: yapısal fark (sayfadaki vadesiz alt limit kayıtlıdan farklı) oran önerisi üretmez", async () => {
  const html = await readFixture("yapikredi_structural_mismatch.html");
  const result = await withFetchStub(
    () => Promise.resolve(new Response("", { status: 500 })),
    () => parseYapiKrediSinirsizHesap(html, YK_STORED)
  );
  assertEquals(result.ok, false);
  if (!result.ok) assertStringIncludes(result.error ?? "", "Yapısal fark");
});

Deno.test("Yapı Kredi: kampanya sayfası erişilemezse (opsiyonel kaynak) parse yine de başarılı olur", async () => {
  const html = await readFixture("yapikredi_ok.html");
  const result = await withFetchStub(
    () => Promise.reject(new Error("network down")),
    () => parseYapiKrediSinirsizHesap(html, YK_STORED)
  );
  assert(result.ok, "opsiyonel ikincil kaynak başarısız olsa bile ana tablo yeterli olmalı");
});

// ---------------------------------------------------------------------------
// QNB — rate-only, YALNIZCA genel/koşulsuz 1-45 gün oranı (Kazananlar
// Kulübü/QNB Plus KESİNLİKLE hariç — kullanıcı politikası 2026-09-16).
// Asıl kaynak "Tanışma Ve Tanışma Sonrası Devam Faizi" matrisi; başlık
// tablosu yalnızca kanıt amaçlı.
// ---------------------------------------------------------------------------
Deno.test("QNB: 17 bant güvenle eşleşiyor; seçilen sütun DAİMA standart 'Faiz Oranı', asla Kazananlar Kulübü", () => {
  const html = Deno.readTextFileSync(new URL("qnb_ok.html", FIX));
  const result = parseQNBKazandiranGunluk(html, QNB_STORED);
  assert(result.ok, `beklenmeyen hata: ${!result.ok ? result.error : ""}`);
  if (!result.ok) return;
  assertEquals(result.bands.length, 17);
  for (const b of result.bands) {
    const stored = QNB_STORED.find((s) => s.alt_limit === b.alt_limit);
    assert(stored, `${b.alt_limit} için kayıtlı bant bulunamadı`);
    assertEquals(b.ust_limit, stored!.ust_limit);
    assertEquals(b.vadesizde_kalacak, stored!.vadesizde_kalacak);
    assertEquals(b.selected_rate_column, "Faiz Oranı (1-45 Gün, genel/koşulsuz)");
    assert(!b.selected_rate_column?.includes("Kazananlar Kulübü"), "seçilen sütun asla Kazananlar Kulübü olmamalı");
    // observed_rate_candidates yalnızca genel/koşulsuz oranı içermeli — özel
    // müşteri segmenti oranı ADAY OLARAK BİLE listelenmemeli.
    assertEquals(b.observed_rate_candidates?.length, 1);
    assertEquals(b.observed_rate_candidates?.[0]?.column, "Faiz Oranı (1-45 Gün, genel/koşulsuz)");
  }
});

Deno.test("QNB: %42,75 (Kazananlar Kulübü/QNB Plus) HİÇBİR bantta seçilmiyor", () => {
  const html = Deno.readTextFileSync(new URL("qnb_ok.html", FIX));
  const result = parseQNBKazandiranGunluk(html, QNB_STORED);
  assert(result.ok);
  if (!result.ok) return;
  for (const b of result.bands) {
    assert(b.yillik_brut_oran !== 0.4275, `${b.alt_limit} bandında yasak %42,75 seçilmiş`);
    // Kanıt olarak raw içinde saklanabilir ama net şekilde "hariç tutuldu" ile etiketlenmeli.
    const excludedKey = Object.keys(b.raw ?? {}).find((k) => k.includes("Kazananlar Kulübü"));
    if (excludedKey) assertStringIncludes(excludedKey, "hariç tutuldu");
  }
});

Deno.test("QNB: 10.000.000 TL altındaki 14 bant %41,75 alıyor", () => {
  const html = Deno.readTextFileSync(new URL("qnb_ok.html", FIX));
  const result = parseQNBKazandiranGunluk(html, QNB_STORED);
  assert(result.ok);
  if (!result.ok) return;
  const lowBands = result.bands.filter((b) => b.alt_limit < 10000000);
  assertEquals(lowBands.length, 14);
  for (const b of lowBands) assertEquals(b.yillik_brut_oran, 0.4175);
});

Deno.test("QNB: son üç bant (10M/20M/30M) sırasıyla %27,75 / %27,75 / %25,50 alıyor — 0-10M özet oranı yayılmıyor", () => {
  const html = Deno.readTextFileSync(new URL("qnb_ok.html", FIX));
  const result = parseQNBKazandiranGunluk(html, QNB_STORED);
  assert(result.ok);
  if (!result.ok) return;
  const byAlt = new Map(result.bands.map((b) => [b.alt_limit, b.yillik_brut_oran]));
  assertEquals(byAlt.get(10000000), 0.2775);
  assertEquals(byAlt.get(20000000), 0.2775);
  assertEquals(byAlt.get(30000000), 0.255);
  // Bu üç bantta ne 0-10M'nin %41,75'i ne de yasak %42,75 görünmeli.
  for (const alt of [10000000, 20000000, 30000000]) {
    const rate = byAlt.get(alt);
    assert(rate !== 0.4175 && rate !== 0.4275, `${alt} bandına yanlış oran sızmış: ${rate}`);
  }
});

Deno.test("QNB: gerçek sayfadaki bilinen etiket yazım hatası (ör. '5,000,00-...') güvenli şekilde tolere ediliyor", () => {
  // qnb_ok.html fixture'ı GERÇEK sayfadan alındı ve bu yazım hatasını olduğu
  // gibi içeriyor — test her ihtimale karşı doğrudan da doğrular.
  const html = Deno.readTextFileSync(new URL("qnb_ok.html", FIX));
  assertStringIncludes(html, "5,000,00-7,499,999.99"); // fixture gerçekten bu yazım hatasını içeriyor mu?
  const result = parseQNBKazandiranGunluk(html, QNB_STORED);
  assert(result.ok, "bilinen tekil etiket yazım hatası tüm parse'ı bozmamalı");
  if (!result.ok) return;
  const b5m = result.bands.find((b) => b.alt_limit === 5000000);
  assert(b5m, "5.000.000 TL bandı bulunamadı");
  assertEquals(b5m!.yillik_brut_oran, 0.4175);
});

Deno.test("QNB: 10M altı bantlar arasında 1-45 gün oranı TUTARSIZSA (gerçek yapısal değişiklik) hiçbir öneri üretilmez", () => {
  const html = Deno.readTextFileSync(new URL("qnb_inconsistent_low_group.html", FIX));
  const result = parseQNBKazandiranGunluk(html, QNB_STORED);
  assertEquals(result.ok, false);
  if (!result.ok) assertStringIncludes(result.error ?? "", "tutarsız");
});

Deno.test("QNB: alt limit tablosuyla kayıtlı bant çelişirse (yapısal fark) oran önerisi üretmez", () => {
  const html = Deno.readTextFileSync(new URL("qnb_altlimit_mismatch.html", FIX));
  const result = parseQNBKazandiranGunluk(html, QNB_STORED);
  assertEquals(result.ok, false);
  if (!result.ok) assertStringIncludes(result.error ?? "", "Yapısal fark");
});

Deno.test("QNB: matris tablosu bulunamazsa (asıl kaynak) oran önerisi üretmez", () => {
  const html = Deno.readTextFileSync(new URL("qnb_matrix_missing.html", FIX));
  const result = parseQNBKazandiranGunluk(html, QNB_STORED);
  assertEquals(result.ok, false);
});

Deno.test("QNB: başlık (özet) tablosu bulunamasa BİLE matris varsa parse başarılı olur (başlık yalnızca kanıt amaçlı)", () => {
  const html = Deno.readTextFileSync(new URL("qnb_headline_missing.html", FIX));
  const result = parseQNBKazandiranGunluk(html, QNB_STORED);
  assert(result.ok, `beklenmeyen hata: ${!result.ok ? result.error : ""}`);
});

// ---------------------------------------------------------------------------
// Üç banka birbirinden bağımsız — biri bozulsa diğerleri etkilenmez
// (Deno.serve içindeki per-source try/catch'in varsaydığı bağımsızlığın
// parser seviyesinde de doğru olduğunu, aynı çalışma içinde art arda
// çağrılarak doğrular; paylaşılan bir mutable state yok.)
// ---------------------------------------------------------------------------
Deno.test("Üç parser bağımsız: Akbank bozuk veri döndürse bile Yapı Kredi ve QNB aynı çalışmada başarılı kalır", async () => {
  const brokenAjax = await readFixture("akbank_ajax_malformed.json");
  const akbankHtml = await readFixture("akbank_ok.html");
  const akbankResult = await withFetchStub(
    () => Promise.resolve(new Response(brokenAjax, { status: 200 })),
    () => parseAkbankSerbestPlus(akbankHtml)
  );
  assertEquals(akbankResult.ok, false);

  const ykHtml = await readFixture("yapikredi_ok.html");
  const ykResult = await withFetchStub(
    () => Promise.reject(new Error("offline")),
    () => parseYapiKrediSinirsizHesap(ykHtml, YK_STORED)
  );
  assert(ykResult.ok, "Akbank'ın başarısızlığı Yapı Kredi'yi etkilememeli");

  const qnbHtml = await Deno.readTextFile(new URL("qnb_ok.html", FIX));
  const qnbResult = parseQNBKazandiranGunluk(qnbHtml, QNB_STORED);
  assert(qnbResult.ok, "Akbank'ın başarısızlığı QNB'yi etkilememeli");
});

// ---------------------------------------------------------------------------
// Oran makul aralık kontrolü — parser çıktısı validateBands'e girmeden önce
// bile açıkça saçma bir oran üretmemeli (defence in depth, ham veri testi).
// ---------------------------------------------------------------------------
Deno.test("QNB/Yapı Kredi/Akbank: tüm üretilen oranlar %3-%120 makul aralığında", async () => {
  const qnbHtml = await Deno.readTextFile(new URL("qnb_ok.html", FIX));
  const qnbResult = parseQNBKazandiranGunluk(qnbHtml, QNB_STORED);
  assert(qnbResult.ok);
  if (qnbResult.ok) for (const b of qnbResult.bands) assert(b.yillik_brut_oran >= 0.03 && b.yillik_brut_oran <= 1.2);

  const ykHtml = await readFixture("yapikredi_ok.html");
  const ykResult = await withFetchStub(
    () => Promise.reject(new Error("offline")),
    () => parseYapiKrediSinirsizHesap(ykHtml, YK_STORED)
  );
  assert(ykResult.ok);
  if (ykResult.ok) for (const b of ykResult.bands) assert(b.yillik_brut_oran >= 0.03 && b.yillik_brut_oran <= 1.2);
});

// ---------------------------------------------------------------------------
// Odeabank Yeni Müşteriye Özel Oksijen — .content-box CSS sınıfından
// bağımsız, isim-tabanlı tablo tespiti (2026-09-16 kök neden düzeltmesi).
//
// ÖNEMLİ: Kök neden .content-box/HTML yapısı DEĞİLDİ (o hâlâ aynı ve
// çalışıyor) — canlı sayfa zaten kuruş-hassasiyetli sınırlar yayımlıyor
// ("20.000.000,01-25.000.000"), asıl sorun kayıtlı veritabanı satırının
// (son bant) hiç kuruş-normalize edilmemiş olmasıydı (bkz. migration
// 20260916120000). Bu testler yalnızca YENİ isim-tabanlı/CSS-bağımsız
// parser mantığını doğrular.
// ---------------------------------------------------------------------------
Deno.test("Odeabank: güncel canlı HTML yapısında 16 TL bandı bulunuyor, USD/EUR alınmıyor", async () => {
  const html = await readFixture("odeabank_ok.html");
  const result = parseOdeabankYeniMusteriOksijen(html);
  assert(result.ok, `beklenmeyen hata: ${!result.ok ? result.error : ""}`);
  if (!result.ok) return;
  assertEquals(result.bands.length, 16);
  // USD/EUR oranları (%4,00/%5,00/%1,00 ve %2,00/%3,00/%0,25) hiçbir bantta görünmemeli.
  for (const b of result.bands) {
    assert(![0.04, 0.05, 0.01, 0.02, 0.03, 0.0025].includes(Math.round(b.yillik_brut_oran * 10000) / 10000));
  }
});

Deno.test("Odeabank: eski .content-box yapısı hâlâ çalışıyor (geriye dönük uyumluluk)", async () => {
  const html = await readFixture("odeabank_content_box_legacy.html");
  const result = parseOdeabankYeniMusteriOksijen(html);
  assert(result.ok, `beklenmeyen hata: ${!result.ok ? result.error : ""}`);
  if (!result.ok) return;
  assertEquals(result.bands.length, 16);
});

Deno.test("Odeabank: .content-box hiç YOKKEN bile başlıklardan tablo bulunuyor", async () => {
  const html = await readFixture("odeabank_no_content_box.html");
  const result = parseOdeabankYeniMusteriOksijen(html);
  assert(result.ok, `beklenmeyen hata: ${!result.ok ? result.error : ""}`);
  if (!result.ok) return;
  assertEquals(result.bands.length, 16);
});

Deno.test("Odeabank: HTML entity/NBSP/görünmez karakterler eşleşmeyi bozmuyor", async () => {
  const html = await readFixture("odeabank_entity_nbsp_headers.html");
  const result = parseOdeabankYeniMusteriOksijen(html);
  assert(result.ok, `beklenmeyen hata: ${!result.ok ? result.error : ""}`);
  if (!result.ok) return;
  assertEquals(result.bands.length, 16);
});

Deno.test("Odeabank: ilk 15 bant %43,00 (Yeni Müşteriye Özel) seçiyor, son bant %14,50 seçiyor", async () => {
  const html = await readFixture("odeabank_ok.html");
  const result = parseOdeabankYeniMusteriOksijen(html);
  assert(result.ok);
  if (!result.ok) return;
  const sorted = [...result.bands].sort((a, b) => a.alt_limit - b.alt_limit);
  for (const b of sorted.slice(0, 15)) {
    assertEquals(b.yillik_brut_oran, 0.43);
    assertEquals(b.selected_rate_column, "Yeni Müşteriye Özel Hoş Geldin Faiz Oranı");
    assertEquals(b.selected_rate_condition, "Yalnızca ilk kez Odeabank müşterisi olanlar için geçerli.");
  }
  const last = sorted[15];
  assertEquals(last.alt_limit, 20000000.01);
  assertEquals(last.ust_limit, 25000000);
  assertEquals(last.yillik_brut_oran, 0.145);
  assertEquals(last.selected_rate_column, "Yeni Müşteriye Özel Hoş Geldin Faiz Oranı");
});

Deno.test("Odeabank: başlık sırası GERÇEKTEN değişse bile (Tutar/Vadesiz sütunları yer değiştirmiş) isim bazlı eşleşme doğru çalışıyor", async () => {
  const html = await readFixture("odeabank_header_order_swapped.html");
  const result = parseOdeabankYeniMusteriOksijen(html);
  assert(result.ok, `beklenmeyen hata: ${!result.ok ? result.error : ""}`);
  if (!result.ok) return;
  assertEquals(result.bands.length, 16);
  const first = [...result.bands].sort((a, b) => a.alt_limit - b.alt_limit)[0];
  // Sütunlar yer değiştirse de alt_limit hâlâ tutar hücresinden (0-25.000),
  // vadesizde_kalacak hâlâ vadesiz hücresinden (7.500 TL) doğru okunmalı —
  // sabit index kullanılsaydı bu ikisi birbirine karışırdı.
  assertEquals(first.alt_limit, 0);
  assertEquals(first.ust_limit, 25000);
  assertEquals(first.vadesizde_kalacak, 7500);
});

Deno.test("Odeabank: bir başlık eksikse (sayfa yapısı değişmiş) öneri oluşturulmuyor", async () => {
  const html = await readFixture("odeabank_missing_header.html");
  const result = parseOdeabankYeniMusteriOksijen(html);
  assertEquals(result.ok, false);
});

Deno.test("Odeabank: satır sayısı 16 değilse (15 bulundu) öneri oluşturulmuyor", async () => {
  const html = await readFixture("odeabank_wrong_row_count.html");
  const result = parseOdeabankYeniMusteriOksijen(html);
  assertEquals(result.ok, false);
  if (!result.ok) assertStringIncludes(result.error ?? "", "16");
});

Deno.test("Odeabank: birden fazla tablo kriterleri sağlarsa tahmin yürütülmez, öneri oluşturulmaz", async () => {
  const html = await readFixture("odeabank_duplicate_candidates.html");
  const result = parseOdeabankYeniMusteriOksijen(html);
  assertEquals(result.ok, false);
  if (!result.ok) assertStringIncludes(result.error ?? "", "Birden fazla");
});

Deno.test("Odeabank: bantlar arasında boşluk/çakışma varsa (yapısal fark) öneri oluşturulmuyor", async () => {
  const html = await readFixture("odeabank_internal_gap.html");
  const result = parseOdeabankYeniMusteriOksijen(html);
  assertEquals(result.ok, false);
});

Deno.test("Odeabank: makul aralık — tüm oranlar %3-%120 arasında", async () => {
  const html = await readFixture("odeabank_ok.html");
  const result = parseOdeabankYeniMusteriOksijen(html);
  assert(result.ok);
  if (!result.ok) return;
  for (const b of result.bands) assert(b.yillik_brut_oran >= 0.03 && b.yillik_brut_oran <= 1.2);
});

Deno.test("Odeabank parser hatası diğer bankaların (Yapı Kredi, QNB) kontrolünü durdurmuyor", async () => {
  const brokenHtml = await readFixture("odeabank_missing_header.html");
  const odeaResult = parseOdeabankYeniMusteriOksijen(brokenHtml);
  assertEquals(odeaResult.ok, false);

  const ykHtml = await readFixture("yapikredi_ok.html");
  const ykResult = await withFetchStub(
    () => Promise.reject(new Error("offline")),
    () => parseYapiKrediSinirsizHesap(ykHtml, YK_STORED)
  );
  assert(ykResult.ok, "Odeabank'ın başarısızlığı Yapı Kredi'yi etkilememeli");

  const qnbHtml = await readFixture("qnb_ok.html");
  const qnbResult = parseQNBKazandiranGunluk(qnbHtml, QNB_STORED);
  assert(qnbResult.ok, "Odeabank'ın başarısızlığı QNB'yi etkilememeli");
});
