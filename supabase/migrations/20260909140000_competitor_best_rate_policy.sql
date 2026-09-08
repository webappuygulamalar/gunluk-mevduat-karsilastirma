-- ============================================================================
-- "En yüksek resmi aday oranı" karşılaştırma politikası — şema genişletmesi
--
-- 1) rate_check_findings'e, her otomatik seçimin admin panelinde ayrıca
--    görülebilmesi için 4 yeni sütun eklenir: hangi kaynak tablodan
--    okunduğu, hangi sütunun kazandığı, o sütunun koşulu, ve o satırdaki
--    TÜM aday oranlar (yalnızca kazanan değil). Mevcut current_value/
--    observed_value (normalize edilmiş banda) ve raw_evidence (ham metin)
--    kolonlarına dokunulmadı — bunlar zaten "ham" ve "normalize" değeri
--    ayrı tutuyordu, yeni kolonlar SEÇİM SÜRECİNİ ayrıca belgeliyor.
-- 2) 6 ürünün bank_sources kaydı, resmi kaynak URL'leri ve otomatik
--    ayrıştırma durumlarıyla güncellenir (Fibabanka Kiraz Hoş Geldin,
--    Odeabank'ın iki ürünü, Alternatifbank, ING'nin iki ürünü artık
--    requires_manual_check=false). QNB, dönemsel (gün aralığı) oran modeli
--    şu anki şemada güvenle temsil edilemediği için MANUEL kalır; notes
--    alanına gerekçe ve gereken şema değişikliği yazıldı.
-- 3) bank_rates, rate_change_requests, accepted_rate_differences, RLS,
--    RPC'ler, audit_log — HİÇBİRİNE dokunulmadı.
-- ============================================================================

alter table public.rate_check_findings
  add column if not exists source_table_name text,
  add column if not exists selected_rate_column text,
  add column if not exists selected_rate_condition text,
  add column if not exists observed_rate_candidates jsonb;

comment on column public.rate_check_findings.source_table_name is
  'Kaynak sayfada hangi tablo/bölüm kullanıldı (ör. "Kiraz Hesap Hoş Geldin Faiz Oranları (2026) — TL", "Oksijen Hesap* - TL").';
comment on column public.rate_check_findings.selected_rate_column is
  'O satırdaki birden çok aday oran sütunundan HANGİSİ seçildi (ör. "Görüntülü Bankacılığa ve Dijital Kanallara Özel Hoş Geldin Faiz Oranı").';
comment on column public.rate_check_findings.selected_rate_condition is
  'Seçilen sütunun koşulu (ör. "Yalnızca dijital kanallardan/görüntülü bankacılıktan açılan hesaplar", "Yalnızca ING Mobil''den yeni müşteri olanlar", "Kazananlar Kulübü üyeleri için +1 puan").';
comment on column public.rate_check_findings.observed_rate_candidates is
  'O satırdaki TÜM aday oranlar (yalnızca kazanan değil), sütun adı + değer olarak, ör. [{"column":"Standart Hoş Geldin Faiz Oranı","rate":0.41},{"column":"Dijital Kanallara Özel Hoş Geldin Faiz Oranı","rate":0.42}].';

-- ----------------------------------------------------------------------------
-- bank_sources güncellemeleri — 6 ürün otomatik, QNB manuel (gerekçeli)
-- ----------------------------------------------------------------------------

update public.bank_sources bs
set requires_manual_check = false,
    source_type = 'static_table',
    page_marker_text = 'Kiraz Hesap Hoş Geldin Faiz Oranları',
    expected_tier_count = 12,
    notes = 'Standart Hoş Geldin Faiz Oranı ile Görüntülü Bankacılığa ve Dijital Kanallara Özel Hoş Geldin Faiz Oranı sütunlarından yüksek olanı seçilir (aynı tabloyu Fibabanka Fonlu Kiraz da kullanır, farklı formülle). "Faiz İşletilmeyecek Min. Tutar" aynı satırdan alınır. Fonlu Kiraz''ın gerekli fon bakiyesi mantığına dokunulmadı.',
    updated_at = now()
from public.banks b
where bs.bank_id = b.id and b.name = 'Fibabanka Kiraz Hoş Geldin';

update public.bank_sources bs
set requires_manual_check = false,
    source_type = 'static_table',
    source_url = 'https://www.odeabank.com.tr/bireysel/mevduat/oksijen-hesap/oksijen-hesap-faiz-oranlari',
    page_marker_text = 'Oksijen Hesap',
    expected_tier_count = 16,
    notes = 'Yalnızca "Oksijen Hesap* - TL" tablosu kullanılır (USD/EUR satırları alınmaz). "Hoş Geldin Faiz Oranı" ile "Yeni Müşteriye Özel Hoş Geldin Faiz Oranı" sütunlarından yüksek olanı seçilir; Vadesiz Alt Limit ve tutar aralığı aynı satırdan alınır. Bu politika, iki mevcut Odeabank ürününü de AYNI (en yüksek) aday değere karşı karşılaştırır — bu yüzden ikisi de aynı öneriyi üretebilir; bu durumda ürünleri silmeyin/birleştirmeyin, admin''e raporlayın.',
    updated_at = now()
from public.banks b
where bs.bank_id = b.id and b.name in ('Odeabank Oksijen Hoş Geldin', 'Odeabank Yeni Müşteriye Özel Oksijen');

update public.bank_sources bs
set requires_manual_check = false,
    source_type = 'static_table',
    page_marker_text = 'VOV Hesap Faiz Tablosu',
    expected_tier_count = 12,
    notes = 'Yalnızca "VOV Hesap Faiz Tablosu" içindeki TL satırları (Döviz Cinsi=TL) kullanılır; USD/EUR/XAU satırları ve sayfa üstündeki tek oranlı reklam kutusu kullanılmaz. Oran = "Avantajlı Tanışma Faizi" sütunu (Standart Faiz Oranı kullanılmaz). Vadesiz tutar = "Vadesiz Hesapta Kalan Tutar" aynı satırdan.',
    updated_at = now()
from public.banks b
where bs.bank_id = b.id and b.name = 'Alternatifbank';

update public.bank_sources bs
set requires_manual_check = false,
    source_type = 'static_table',
    source_url = 'https://www.ing.com.tr/tr/sizin-icin/mevduat/ing-turuncu-hesap',
    page_marker_text = 'Turuncu Hesap faiz oranları',
    expected_tier_count = 14,
    notes = 'Sık Sorulan Sorular bölümündeki "Turuncu Hesap faiz oranları nedir?" TL tablosu kullanılır. "ING ilk defa müşteri kampanyası" -> yalnızca "ING Mobil''den Yeni Müşterilere Özel" sütunu (yalnızca ING Mobil''den ilk kez müşteri olanlar için geçerli, notta belirtilmeli). Bu ürüne "Hoş Geldin Faizi" sütunu ASLA kopyalanmaz; iki ürün ayrı sütunlardan besleniyor, admin detayında ayrı gösterilir.',
    updated_at = now()
from public.banks b
where bs.bank_id = b.id and b.name = 'ING ilk defa müşteri kampanyası';

update public.bank_sources bs
set requires_manual_check = false,
    source_type = 'static_table',
    source_url = 'https://www.ing.com.tr/tr/sizin-icin/mevduat/ing-turuncu-hesap',
    page_marker_text = 'Turuncu Hesap faiz oranları',
    expected_tier_count = 14,
    notes = 'Sık Sorulan Sorular bölümündeki "Turuncu Hesap faiz oranları nedir?" TL tablosu kullanılır. "ING Hoş geldin" -> yalnızca "Hoş Geldin Faizi" sütunu. "ING Mobil''den Yeni Müşterilere Özel" sütunu ASLA bu ürüne kopyalanmaz; iki ürün ayrı sütunlardan besleniyor, admin detayında ayrı gösterilir.',
    updated_at = now()
from public.banks b
where bs.bank_id = b.id and b.name = 'ING Hoş geldin';

update public.bank_sources bs
set notes = 'MANUEL KALDI — dönemsel oran modeli gerekiyor: resmi tablo oranları GÜN ARALIĞINA (1-45 gün / 46-91 gün) göre değişiyor ve ayrıca "Kazananlar Kulübü" üyeliğine göre +1 puan ek oran sunuyor. Mevcut bank_rates şeması yalnızca tutar bandı + tek bir sabit yıllık oran temsil edebiliyor (gün aralığı veya üyelik boyutu yok); app.js''in hesaplama mantığı da değerlendirme süresi boyunca TEK bir sabit oran varsayıyor. Bu ürünü güvenle otomatikleştirmek için: (a) bank_rates''e (veya ayrı bir rate_periods tablosuna) gün aralığı başlangıç/bitiş kolonları eklenmesi, (b) app.js''in simulateCompoundNetReturn fonksiyonunun hesap yaşına göre hangi dönem bandına düştüğünü hesaba katacak şekilde genişletilmesi gerekir — bu, hesaplama mantığını değiştireceği için bu görev kapsamında YAPILMADI, yalnızca raporlandı.',
    updated_at = now()
from public.banks b
where bs.bank_id = b.id and b.name = 'QNB';
