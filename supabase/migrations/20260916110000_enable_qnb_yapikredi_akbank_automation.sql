-- ============================================================================
-- QNB, Yapı Kredi ve Akbank'ın kalıcı "Manuel kontrol" durumunun kaldırılması
-- ============================================================================
--
-- Bu migration YALNIZCA bank_sources yapılandırmasını günceller — hiçbir
-- bank_rates satırına dokunmaz, hiçbir oran değiştirmez, hiçbir
-- rate_change_requests talebi oluşturmaz/onaylamaz. Gerçek otomatik kontrol
-- (Edge Function check-bank-rates deploy edildikten SONRA) ayrı bir adımda,
-- yalnızca bir sonraki manuel/cron çalışmasında pending talepler üretir.
--
-- Akbank: requires_manual_check zaten false'du; page_marker_text değişmedi
-- (Edge Function'daki markerSearchText() düzeltmesi tüm bankalar için
-- geneldir — entity-encode edilmiş Türkçe karakterler artık DOM textContent
-- üzerinden, decode edilmiş olarak aranır). Asıl kök neden marker değil,
-- ".free-plus-table" HTML tablosunun sunucu tarafında HER ZAMAN boş
-- gelmesiydi (gerçek veriler sayfanın kendi client-side script'iyle, aynı
-- alan adındaki bir AJAX servisinden enjekte ediliyor) — parseAkbankSerbestPlus
-- artık o resmi servisi (GetYeniSerbestHesapFaizOranlari) doğrudan çağırıyor.
-- Bu satır için burada YALNIZCA notes güncelleniyor, requires_manual_check
-- zaten false.
update public.bank_sources
set notes = 'Otomatikleştirildi (2026-09-16): tablo hücreleri sunucu tarafında boş geliyor (client-side AJAX ile dolduruluyor) — parser artık aynı alan adındaki resmi GetYeniSerbestHesapFaizOranlari servisini doğrudan çağırıyor. Doğrulama/birleştirme/vadesiz-yüzdesi mantığı değişmedi.'
where id = '74fe2c6e-64d6-4aef-adb2-a40a59c194d2' -- Akbank Serbest Plus Hesap
  and requires_manual_check = false;

-- Yapı Kredi Sınırsız Hesap: "RATE-ONLY" otomasyon. alt_limit/ust_limit/
-- vadesizde_kalacak parser tarafından ASLA üretilmez — yalnızca kayıtlı
-- (kuruş-normalize edilmiş, 20260915120000) 9 bandın yillik_brut_oran'ı,
-- sayfadaki Kampanyalı/Kampanya Sonrası/Baz + mobil hoş geldin adaylarının
-- en yükseğiyle karşılaştırılır. expected_tier_count=9: sayfadan HAM olarak
-- okunan satır sayısı bununla uyuşmazsa (validateBands) parse reddedilir.
update public.bank_sources
set requires_manual_check = false,
    expected_tier_count = 9,
    notes = 'Otomatikleştirildi (2026-09-16), RATE-ONLY: alt_limit/ust_limit/vadesizde_kalacak parser tarafından hiçbir zaman değiştirilmez, yalnızca kayıtlı 9 banda (20260915120000 ile kuruş-normalize edildi) eşlenen yillik_brut_oran önerilir. Aday oranlar: Kampanyalı Faiz Oranı, Kampanya Sonrası Faiz Oranı, Baz Faiz Oranı (ana ürün sayfası) + mobilden yeni müşteri hoş geldin oranı (kampanyalar/detay/253761, opsiyonel ikincil kaynak) — en yükseği seçilir, koşulu proposed_data.note''a yazılır. Sayfanın kendi "Hesaptaki Tutar"/"Vadesiz Alt Limit" sütunları alt_limit''e göre (dizi sırasına değil) eşleştirilip yapısal doğrulama için kullanılır; uyuşmazsa (yapısal fark) hiçbir oran önerilmez.'
where id = '66739463-38f8-4bf4-922c-0b3a20ff8617'; -- Yapı Kredi

-- QNB Kazandıran Günlük Hesap: "RATE-ONLY" otomasyon, yalnızca 1-45 gün
-- "Tanışma Faizi" (standart + Kazananlar Kulübü/QNB Plus) kullanılır.
-- expected_tier_count BİLEREK NULL bırakıldı: bu ürünün parser'ı kayıtlı 17
-- banda AYNI (tutardan bağımsız) tek oranı uyguluyor — sayfadan "ham kademe"
-- sayısı diye ayrı bir tutar-bazlı kademe sayımı yapılmıyor (rawTierCount =
-- kayıtlı bant sayısı = 17, expected_tier_count ile karşılaştırmak anlamsız
-- olurdu). Gerçek yapısal güvence, parser içindeki "Alt Limit Tutarı (TL)"
-- tablosu + alt_limit eşleştirmesinden gelir (validateBands'ten BAĞIMSIZ,
-- parser'ın kendi iç kontrolü).
--
-- ÖNEMLİ (kullanıcıyla 2026-09-16'da netleştirildi): QNB'nin gerçek ürünü
-- VADEYE (gün aralığına) göre değişen bir oran eğrisine sahip (41,75% [1-45
-- gün] .. ~29% [721+ gün]) — mevcut bank_rates şeması ve app.js hesap motoru
-- tek sabit yıllık oran varsayıyor, vade boyutu YOK. Bu otomasyon BİLEREK
-- yalnızca en kısa vadeli (1-45 gün) "Tanışma Faizi"ni kullanıyor — diğer
-- bankalardaki "kampanya/giriş oranı" deseniyle (Alternatifbank, Yapı Kredi)
-- tutarlı. Uzun vadeli tutmada gerçekte daha düşük oran uygulanacağı ("46-91
-- .. 721+ gün" matrisi) bu otomasyona KARIŞMAZ — hesaplama motoru veya şema
-- değiştirilmeden bu boyut güvenle temsil edilemez.
update public.bank_sources
set requires_manual_check = false,
    expected_tier_count = null,
    notes = 'Otomatikleştirildi (2026-09-16), RATE-ONLY, YALNIZCA 1-45 GÜN: alt_limit/ust_limit/vadesizde_kalacak parser tarafından hiçbir zaman değiştirilmez, kayıtlı 17 banda (20260916090000 ile kuruş-normalize edildi) AYNI (tutardan bağımsız) 1-45 gün "Tanışma Faizi" oranı (standart + Kazananlar Kulübü/QNB Plus''tan yükseği) önerilir. BİLİNEN KISITLAMA: QNB''nin gerçek oranı vadeye (gün aralığına) göre düşen bir eğri (41,75%→~29%) — bank_rates şeması ve hesap motoru tek sabit oran varsayıyor, bu yüzden yalnızca en kısa/en yüksek (1-45 gün) oran kullanılıyor; "Tanışma Ve Tanışma Sonrası Devam Faizi" (46-91..721+ gün) matrisi oran seçimine karışmaz. Yapısal doğrulama "Alt Limit Tutarı (TL)" tablosuyla (0-999.999 TL, 8 bant) yapılır; uyuşmazsa hiçbir oran önerilmez.'
where id = '0d3e9f4e-5c93-4839-8b8d-ad945dddbcba'; -- QNB
