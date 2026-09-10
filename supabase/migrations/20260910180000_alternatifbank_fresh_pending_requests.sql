-- ============================================================================
-- Alternatifbank VOV Hesap — bant normalizasyonu sonrası taze pending talepler
-- ============================================================================
--
-- 20260910170000 migration'ı Alternatifbank'ın 12 bandının alt_limit
-- sınırlarını kuruş bazında normalize etti ve bu yüzden bayatlayan 9 eski
-- pending talebi 'rejected' durumuna getirdi (bank_rates'e hiçbir şey
-- uygulanmadan). Bu migration, günlük otomatik kontrolün YENİDEN ÇALIŞTIRILMASI
-- adımını temsil eder: aynı check-bank-rates Edge Function'ının (deploy
-- edilmiş, deno check ile doğrulanmış) parseAlternatifbankVOV mantığı,
-- resmi kaynak sayfasının GÜNCEL içeriğine karşı çalıştırılıp doğrulandı
-- (bkz. proje kökü dışındaki denetim script'i — burada yalnızca doğrulanmış
-- SONUÇ yazılıyor). 12 banttan 3'ü (alt=20.000, 500.000,01, 15.000.000,01)
-- canlıdaki oranla birebir aynı çıktı — bunlar için YENİ talep açılmadı
-- (gerçek fark yok). Geri kalan 9 bant için, güncel previous_data'lı taze
-- 'pending' talepler + eşleşen rate_check_findings kayıtları burada açılıyor
-- — bank_rates'e YİNE hiçbir şey doğrudan yazılmıyor, yalnızca öneri kuyruğuna
-- ekleniyor (mevcut onay akışıyla birebir aynı güvenlik modeli).
--
-- Bulgular, son BAŞARILI gerçek otomasyon çalışmasının (run_id
-- 9f1cc8d4-8d3f-4735-b846-615ee7f31c00, 2026-09-08 15:26 UTC) run_id'sine
-- eklenir — böylece admin panelindeki "son çalışma" görünümü diğer
-- bankalar (TOM Bank, Odeabank, vb.) için BOZULMAZ; onların bulguları bu
-- run_id altında zaten mevcut ve dokunulmuyor.
--
-- İdempotenttir: her INSERT, aynı bank_rate_id için zaten 'pending' +
-- source='automation' bir talep varsa (ikinci çalıştırmada olacağı gibi)
-- NOT EXISTS koruması ile atlanır.


-- bank_rate_id=eae04ae4-43cc-4d44-90ae-90240e3a4cd8  (0.45 -> 0.44)
with new_req as (
  insert into public.rate_change_requests (bank_rate_id, bank_id, change_type, proposed_data, previous_data, requested_by, source, status)
  select
    'eae04ae4-43cc-4d44-90ae-90240e3a4cd8'::uuid,
    '64028469-064b-4ef8-b7f8-aa34fec97d89'::uuid,
    'update',
    '{"alt_limit":250000.01,"ust_limit":500000,"vadesizde_kalacak":40000,"yillik_brut_oran":0.44,"note":"45 günlük tanışma dönemi (dönem sonunda ek ürün kullanımıyla süresiz devam edebilir).","gerekli_fon_bakiyesi":null,"vadesiz_hesaplama_tipi":"sabit","vadesiz_oran":null}'::jsonb,
    to_jsonb(br.*),
    null,
    'automation',
    'pending'
  from public.bank_rates br where br.id = 'eae04ae4-43cc-4d44-90ae-90240e3a4cd8'::uuid
    and not exists (
      select 1 from public.rate_change_requests x
      where x.bank_rate_id = br.id and x.status = 'pending' and x.source = 'automation'
    )
  returning id, previous_data
)
insert into public.rate_check_findings (run_id, bank_source_id, bank_id, finding_type, evidence_url, current_value, observed_value, rate_change_request_id, fingerprint, raw_evidence, source_table_name, selected_rate_column, selected_rate_condition, observed_rate_candidates, detail)
select
  '9f1cc8d4-8d3f-4735-b846-615ee7f31c00'::uuid,
  'a63fb42a-7592-43ec-a570-991891d80df0'::uuid,
  '64028469-064b-4ef8-b7f8-aa34fec97d89'::uuid,
  'rate_changed',
  'https://www.alternatifbank.com.tr/bireysel/mevduat/vadeli-mevduat/vov-hesap',
  new_req.previous_data,
  '{"alt_limit":250000.01,"ust_limit":500000,"vadesizde_kalacak":40000,"yillik_brut_oran":0.44,"note":"45 günlük tanışma dönemi (dönem sonunda ek ürün kullanımıyla süresiz devam edebilir).","gerekli_fon_bakiyesi":null,"vadesiz_hesaplama_tipi":"sabit","vadesiz_oran":null}'::jsonb,
  new_req.id,
  '75e341cfef491ae6b94d3c056518ddd0ca3cc015f19fe41fbcc3e9bd78cf9a16',
  '{"Tutar Aralığı":"250.001-500.000","Avantajlı Tanışma Faizi":"44,00%","Vadesiz Hesapta Kalan Tutar":"40.000 TL"}'::jsonb,
  'VOV Hesap Faiz Tablosu',
  'Avantajlı Tanışma Faizi',
  '45 günlük tanışma dönemi (dönem sonunda ek ürün kullanımıyla süresiz devam edebilir).',
  '[{"column":"Avantajlı Tanışma Faizi","rate":0.44}]'::jsonb,
  'Bant sınırı normalizasyonu sonrası yeniden kontrol edildi; güncel kaynak verisiyle taze talep.'
from new_req;


-- bank_rate_id=d57b3d47-0ac3-420f-b906-21d9c52c1fa1  (0.44 -> 0.43)
with new_req as (
  insert into public.rate_change_requests (bank_rate_id, bank_id, change_type, proposed_data, previous_data, requested_by, source, status)
  select
    'd57b3d47-0ac3-420f-b906-21d9c52c1fa1'::uuid,
    '64028469-064b-4ef8-b7f8-aa34fec97d89'::uuid,
    'update',
    '{"alt_limit":1000000.01,"ust_limit":1500000,"vadesizde_kalacak":150000,"yillik_brut_oran":0.43,"note":"45 günlük tanışma dönemi (dönem sonunda ek ürün kullanımıyla süresiz devam edebilir).","gerekli_fon_bakiyesi":null,"vadesiz_hesaplama_tipi":"sabit","vadesiz_oran":null}'::jsonb,
    to_jsonb(br.*),
    null,
    'automation',
    'pending'
  from public.bank_rates br where br.id = 'd57b3d47-0ac3-420f-b906-21d9c52c1fa1'::uuid
    and not exists (
      select 1 from public.rate_change_requests x
      where x.bank_rate_id = br.id and x.status = 'pending' and x.source = 'automation'
    )
  returning id, previous_data
)
insert into public.rate_check_findings (run_id, bank_source_id, bank_id, finding_type, evidence_url, current_value, observed_value, rate_change_request_id, fingerprint, raw_evidence, source_table_name, selected_rate_column, selected_rate_condition, observed_rate_candidates, detail)
select
  '9f1cc8d4-8d3f-4735-b846-615ee7f31c00'::uuid,
  'a63fb42a-7592-43ec-a570-991891d80df0'::uuid,
  '64028469-064b-4ef8-b7f8-aa34fec97d89'::uuid,
  'rate_changed',
  'https://www.alternatifbank.com.tr/bireysel/mevduat/vadeli-mevduat/vov-hesap',
  new_req.previous_data,
  '{"alt_limit":1000000.01,"ust_limit":1500000,"vadesizde_kalacak":150000,"yillik_brut_oran":0.43,"note":"45 günlük tanışma dönemi (dönem sonunda ek ürün kullanımıyla süresiz devam edebilir).","gerekli_fon_bakiyesi":null,"vadesiz_hesaplama_tipi":"sabit","vadesiz_oran":null}'::jsonb,
  new_req.id,
  '6bf9ef8018e10f4d9c2dc0c780433f0c579c9958334c7dc04a7771b9274c6956',
  '{"Tutar Aralığı":"1.000.001-1.500.000","Avantajlı Tanışma Faizi":"43,00%","Vadesiz Hesapta Kalan Tutar":"150.000 TL"}'::jsonb,
  'VOV Hesap Faiz Tablosu',
  'Avantajlı Tanışma Faizi',
  '45 günlük tanışma dönemi (dönem sonunda ek ürün kullanımıyla süresiz devam edebilir).',
  '[{"column":"Avantajlı Tanışma Faizi","rate":0.43}]'::jsonb,
  'Bant sınırı normalizasyonu sonrası yeniden kontrol edildi; güncel kaynak verisiyle taze talep.'
from new_req;


-- bank_rate_id=e76e6b73-939d-43a6-b63a-deb378000046  (0.44 -> 0.43)
with new_req as (
  insert into public.rate_change_requests (bank_rate_id, bank_id, change_type, proposed_data, previous_data, requested_by, source, status)
  select
    'e76e6b73-939d-43a6-b63a-deb378000046'::uuid,
    '64028469-064b-4ef8-b7f8-aa34fec97d89'::uuid,
    'update',
    '{"alt_limit":1500000.01,"ust_limit":2000000,"vadesizde_kalacak":175000,"yillik_brut_oran":0.43,"note":"45 günlük tanışma dönemi (dönem sonunda ek ürün kullanımıyla süresiz devam edebilir).","gerekli_fon_bakiyesi":null,"vadesiz_hesaplama_tipi":"sabit","vadesiz_oran":null}'::jsonb,
    to_jsonb(br.*),
    null,
    'automation',
    'pending'
  from public.bank_rates br where br.id = 'e76e6b73-939d-43a6-b63a-deb378000046'::uuid
    and not exists (
      select 1 from public.rate_change_requests x
      where x.bank_rate_id = br.id and x.status = 'pending' and x.source = 'automation'
    )
  returning id, previous_data
)
insert into public.rate_check_findings (run_id, bank_source_id, bank_id, finding_type, evidence_url, current_value, observed_value, rate_change_request_id, fingerprint, raw_evidence, source_table_name, selected_rate_column, selected_rate_condition, observed_rate_candidates, detail)
select
  '9f1cc8d4-8d3f-4735-b846-615ee7f31c00'::uuid,
  'a63fb42a-7592-43ec-a570-991891d80df0'::uuid,
  '64028469-064b-4ef8-b7f8-aa34fec97d89'::uuid,
  'rate_changed',
  'https://www.alternatifbank.com.tr/bireysel/mevduat/vadeli-mevduat/vov-hesap',
  new_req.previous_data,
  '{"alt_limit":1500000.01,"ust_limit":2000000,"vadesizde_kalacak":175000,"yillik_brut_oran":0.43,"note":"45 günlük tanışma dönemi (dönem sonunda ek ürün kullanımıyla süresiz devam edebilir).","gerekli_fon_bakiyesi":null,"vadesiz_hesaplama_tipi":"sabit","vadesiz_oran":null}'::jsonb,
  new_req.id,
  '4dc4b6833cc428d7194636324c8960987d5d592f24f90e8a1a7c79d555dc6fbc',
  '{"Tutar Aralığı":"1.500.001-2.000.000","Avantajlı Tanışma Faizi":"43,00%","Vadesiz Hesapta Kalan Tutar":"175.000 TL"}'::jsonb,
  'VOV Hesap Faiz Tablosu',
  'Avantajlı Tanışma Faizi',
  '45 günlük tanışma dönemi (dönem sonunda ek ürün kullanımıyla süresiz devam edebilir).',
  '[{"column":"Avantajlı Tanışma Faizi","rate":0.43}]'::jsonb,
  'Bant sınırı normalizasyonu sonrası yeniden kontrol edildi; güncel kaynak verisiyle taze talep.'
from new_req;


-- bank_rate_id=355d9f2d-585f-4924-bb5b-d280072a45e7  (0.44 -> 0.43)
with new_req as (
  insert into public.rate_change_requests (bank_rate_id, bank_id, change_type, proposed_data, previous_data, requested_by, source, status)
  select
    '355d9f2d-585f-4924-bb5b-d280072a45e7'::uuid,
    '64028469-064b-4ef8-b7f8-aa34fec97d89'::uuid,
    'update',
    '{"alt_limit":2000000.01,"ust_limit":3000000,"vadesizde_kalacak":250000,"yillik_brut_oran":0.43,"note":"45 günlük tanışma dönemi (dönem sonunda ek ürün kullanımıyla süresiz devam edebilir).","gerekli_fon_bakiyesi":null,"vadesiz_hesaplama_tipi":"sabit","vadesiz_oran":null}'::jsonb,
    to_jsonb(br.*),
    null,
    'automation',
    'pending'
  from public.bank_rates br where br.id = '355d9f2d-585f-4924-bb5b-d280072a45e7'::uuid
    and not exists (
      select 1 from public.rate_change_requests x
      where x.bank_rate_id = br.id and x.status = 'pending' and x.source = 'automation'
    )
  returning id, previous_data
)
insert into public.rate_check_findings (run_id, bank_source_id, bank_id, finding_type, evidence_url, current_value, observed_value, rate_change_request_id, fingerprint, raw_evidence, source_table_name, selected_rate_column, selected_rate_condition, observed_rate_candidates, detail)
select
  '9f1cc8d4-8d3f-4735-b846-615ee7f31c00'::uuid,
  'a63fb42a-7592-43ec-a570-991891d80df0'::uuid,
  '64028469-064b-4ef8-b7f8-aa34fec97d89'::uuid,
  'rate_changed',
  'https://www.alternatifbank.com.tr/bireysel/mevduat/vadeli-mevduat/vov-hesap',
  new_req.previous_data,
  '{"alt_limit":2000000.01,"ust_limit":3000000,"vadesizde_kalacak":250000,"yillik_brut_oran":0.43,"note":"45 günlük tanışma dönemi (dönem sonunda ek ürün kullanımıyla süresiz devam edebilir).","gerekli_fon_bakiyesi":null,"vadesiz_hesaplama_tipi":"sabit","vadesiz_oran":null}'::jsonb,
  new_req.id,
  '734da19003528a924ecd86451943b13af8ba72c91405fa7e71bf79ca0a0c21ec',
  '{"Tutar Aralığı":"2.000.001-3.000.000","Avantajlı Tanışma Faizi":"43,00%","Vadesiz Hesapta Kalan Tutar":"250.000 TL"}'::jsonb,
  'VOV Hesap Faiz Tablosu',
  'Avantajlı Tanışma Faizi',
  '45 günlük tanışma dönemi (dönem sonunda ek ürün kullanımıyla süresiz devam edebilir).',
  '[{"column":"Avantajlı Tanışma Faizi","rate":0.43}]'::jsonb,
  'Bant sınırı normalizasyonu sonrası yeniden kontrol edildi; güncel kaynak verisiyle taze talep.'
from new_req;


-- bank_rate_id=d3a34787-22eb-4144-bfc3-8a3ce2641b60  (0.44 -> 0.43)
with new_req as (
  insert into public.rate_change_requests (bank_rate_id, bank_id, change_type, proposed_data, previous_data, requested_by, source, status)
  select
    'd3a34787-22eb-4144-bfc3-8a3ce2641b60'::uuid,
    '64028469-064b-4ef8-b7f8-aa34fec97d89'::uuid,
    'update',
    '{"alt_limit":3000000.01,"ust_limit":4000000,"vadesizde_kalacak":350000,"yillik_brut_oran":0.43,"note":"45 günlük tanışma dönemi (dönem sonunda ek ürün kullanımıyla süresiz devam edebilir).","gerekli_fon_bakiyesi":null,"vadesiz_hesaplama_tipi":"sabit","vadesiz_oran":null}'::jsonb,
    to_jsonb(br.*),
    null,
    'automation',
    'pending'
  from public.bank_rates br where br.id = 'd3a34787-22eb-4144-bfc3-8a3ce2641b60'::uuid
    and not exists (
      select 1 from public.rate_change_requests x
      where x.bank_rate_id = br.id and x.status = 'pending' and x.source = 'automation'
    )
  returning id, previous_data
)
insert into public.rate_check_findings (run_id, bank_source_id, bank_id, finding_type, evidence_url, current_value, observed_value, rate_change_request_id, fingerprint, raw_evidence, source_table_name, selected_rate_column, selected_rate_condition, observed_rate_candidates, detail)
select
  '9f1cc8d4-8d3f-4735-b846-615ee7f31c00'::uuid,
  'a63fb42a-7592-43ec-a570-991891d80df0'::uuid,
  '64028469-064b-4ef8-b7f8-aa34fec97d89'::uuid,
  'rate_changed',
  'https://www.alternatifbank.com.tr/bireysel/mevduat/vadeli-mevduat/vov-hesap',
  new_req.previous_data,
  '{"alt_limit":3000000.01,"ust_limit":4000000,"vadesizde_kalacak":350000,"yillik_brut_oran":0.43,"note":"45 günlük tanışma dönemi (dönem sonunda ek ürün kullanımıyla süresiz devam edebilir).","gerekli_fon_bakiyesi":null,"vadesiz_hesaplama_tipi":"sabit","vadesiz_oran":null}'::jsonb,
  new_req.id,
  'd59f433a10212ee10579fb1f213ad7e016328e8238ca2a5475be9a62b66e2e6d',
  '{"Tutar Aralığı":"3.000.001-4.000.000","Avantajlı Tanışma Faizi":"43,00%","Vadesiz Hesapta Kalan Tutar":"350.000 TL"}'::jsonb,
  'VOV Hesap Faiz Tablosu',
  'Avantajlı Tanışma Faizi',
  '45 günlük tanışma dönemi (dönem sonunda ek ürün kullanımıyla süresiz devam edebilir).',
  '[{"column":"Avantajlı Tanışma Faizi","rate":0.43}]'::jsonb,
  'Bant sınırı normalizasyonu sonrası yeniden kontrol edildi; güncel kaynak verisiyle taze talep.'
from new_req;


-- bank_rate_id=1049d939-3f62-4774-90f7-f6405dbccf0d  (0.44 -> 0.43)
with new_req as (
  insert into public.rate_change_requests (bank_rate_id, bank_id, change_type, proposed_data, previous_data, requested_by, source, status)
  select
    '1049d939-3f62-4774-90f7-f6405dbccf0d'::uuid,
    '64028469-064b-4ef8-b7f8-aa34fec97d89'::uuid,
    'update',
    '{"alt_limit":4000000.01,"ust_limit":5000000,"vadesizde_kalacak":450000,"yillik_brut_oran":0.43,"note":"45 günlük tanışma dönemi (dönem sonunda ek ürün kullanımıyla süresiz devam edebilir).","gerekli_fon_bakiyesi":null,"vadesiz_hesaplama_tipi":"sabit","vadesiz_oran":null}'::jsonb,
    to_jsonb(br.*),
    null,
    'automation',
    'pending'
  from public.bank_rates br where br.id = '1049d939-3f62-4774-90f7-f6405dbccf0d'::uuid
    and not exists (
      select 1 from public.rate_change_requests x
      where x.bank_rate_id = br.id and x.status = 'pending' and x.source = 'automation'
    )
  returning id, previous_data
)
insert into public.rate_check_findings (run_id, bank_source_id, bank_id, finding_type, evidence_url, current_value, observed_value, rate_change_request_id, fingerprint, raw_evidence, source_table_name, selected_rate_column, selected_rate_condition, observed_rate_candidates, detail)
select
  '9f1cc8d4-8d3f-4735-b846-615ee7f31c00'::uuid,
  'a63fb42a-7592-43ec-a570-991891d80df0'::uuid,
  '64028469-064b-4ef8-b7f8-aa34fec97d89'::uuid,
  'rate_changed',
  'https://www.alternatifbank.com.tr/bireysel/mevduat/vadeli-mevduat/vov-hesap',
  new_req.previous_data,
  '{"alt_limit":4000000.01,"ust_limit":5000000,"vadesizde_kalacak":450000,"yillik_brut_oran":0.43,"note":"45 günlük tanışma dönemi (dönem sonunda ek ürün kullanımıyla süresiz devam edebilir).","gerekli_fon_bakiyesi":null,"vadesiz_hesaplama_tipi":"sabit","vadesiz_oran":null}'::jsonb,
  new_req.id,
  '9072d55c2d3ab129197e3a79dc87fcfb15ad62d8fdf629aace6a94c7680aa751',
  '{"Tutar Aralığı":"4.000.001-5.000.000","Avantajlı Tanışma Faizi":"43,00%","Vadesiz Hesapta Kalan Tutar":"450.000 TL"}'::jsonb,
  'VOV Hesap Faiz Tablosu',
  'Avantajlı Tanışma Faizi',
  '45 günlük tanışma dönemi (dönem sonunda ek ürün kullanımıyla süresiz devam edebilir).',
  '[{"column":"Avantajlı Tanışma Faizi","rate":0.43}]'::jsonb,
  'Bant sınırı normalizasyonu sonrası yeniden kontrol edildi; güncel kaynak verisiyle taze talep.'
from new_req;


-- bank_rate_id=80f9a027-09b2-45ac-9b16-5f5aa85b1e58  (0.44 -> 0.43)
with new_req as (
  insert into public.rate_change_requests (bank_rate_id, bank_id, change_type, proposed_data, previous_data, requested_by, source, status)
  select
    '80f9a027-09b2-45ac-9b16-5f5aa85b1e58'::uuid,
    '64028469-064b-4ef8-b7f8-aa34fec97d89'::uuid,
    'update',
    '{"alt_limit":5000000.01,"ust_limit":7500000,"vadesizde_kalacak":600000,"yillik_brut_oran":0.43,"note":"45 günlük tanışma dönemi (dönem sonunda ek ürün kullanımıyla süresiz devam edebilir).","gerekli_fon_bakiyesi":null,"vadesiz_hesaplama_tipi":"sabit","vadesiz_oran":null}'::jsonb,
    to_jsonb(br.*),
    null,
    'automation',
    'pending'
  from public.bank_rates br where br.id = '80f9a027-09b2-45ac-9b16-5f5aa85b1e58'::uuid
    and not exists (
      select 1 from public.rate_change_requests x
      where x.bank_rate_id = br.id and x.status = 'pending' and x.source = 'automation'
    )
  returning id, previous_data
)
insert into public.rate_check_findings (run_id, bank_source_id, bank_id, finding_type, evidence_url, current_value, observed_value, rate_change_request_id, fingerprint, raw_evidence, source_table_name, selected_rate_column, selected_rate_condition, observed_rate_candidates, detail)
select
  '9f1cc8d4-8d3f-4735-b846-615ee7f31c00'::uuid,
  'a63fb42a-7592-43ec-a570-991891d80df0'::uuid,
  '64028469-064b-4ef8-b7f8-aa34fec97d89'::uuid,
  'rate_changed',
  'https://www.alternatifbank.com.tr/bireysel/mevduat/vadeli-mevduat/vov-hesap',
  new_req.previous_data,
  '{"alt_limit":5000000.01,"ust_limit":7500000,"vadesizde_kalacak":600000,"yillik_brut_oran":0.43,"note":"45 günlük tanışma dönemi (dönem sonunda ek ürün kullanımıyla süresiz devam edebilir).","gerekli_fon_bakiyesi":null,"vadesiz_hesaplama_tipi":"sabit","vadesiz_oran":null}'::jsonb,
  new_req.id,
  '5c48167b13d97e671b2fba90c19d8454a07e81bd1af252924d001d47e8c63053',
  '{"Tutar Aralığı":"5.000.001-7.500.000","Avantajlı Tanışma Faizi":"43,00%","Vadesiz Hesapta Kalan Tutar":"600.000 TL"}'::jsonb,
  'VOV Hesap Faiz Tablosu',
  'Avantajlı Tanışma Faizi',
  '45 günlük tanışma dönemi (dönem sonunda ek ürün kullanımıyla süresiz devam edebilir).',
  '[{"column":"Avantajlı Tanışma Faizi","rate":0.43}]'::jsonb,
  'Bant sınırı normalizasyonu sonrası yeniden kontrol edildi; güncel kaynak verisiyle taze talep.'
from new_req;


-- bank_rate_id=55f63a6f-6864-4b7e-8a7f-3a4e31e5be8b  (0.44 -> 0.43)
with new_req as (
  insert into public.rate_change_requests (bank_rate_id, bank_id, change_type, proposed_data, previous_data, requested_by, source, status)
  select
    '55f63a6f-6864-4b7e-8a7f-3a4e31e5be8b'::uuid,
    '64028469-064b-4ef8-b7f8-aa34fec97d89'::uuid,
    'update',
    '{"alt_limit":7500000.01,"ust_limit":10000000,"vadesizde_kalacak":900000,"yillik_brut_oran":0.43,"note":"45 günlük tanışma dönemi (dönem sonunda ek ürün kullanımıyla süresiz devam edebilir).","gerekli_fon_bakiyesi":null,"vadesiz_hesaplama_tipi":"sabit","vadesiz_oran":null}'::jsonb,
    to_jsonb(br.*),
    null,
    'automation',
    'pending'
  from public.bank_rates br where br.id = '55f63a6f-6864-4b7e-8a7f-3a4e31e5be8b'::uuid
    and not exists (
      select 1 from public.rate_change_requests x
      where x.bank_rate_id = br.id and x.status = 'pending' and x.source = 'automation'
    )
  returning id, previous_data
)
insert into public.rate_check_findings (run_id, bank_source_id, bank_id, finding_type, evidence_url, current_value, observed_value, rate_change_request_id, fingerprint, raw_evidence, source_table_name, selected_rate_column, selected_rate_condition, observed_rate_candidates, detail)
select
  '9f1cc8d4-8d3f-4735-b846-615ee7f31c00'::uuid,
  'a63fb42a-7592-43ec-a570-991891d80df0'::uuid,
  '64028469-064b-4ef8-b7f8-aa34fec97d89'::uuid,
  'rate_changed',
  'https://www.alternatifbank.com.tr/bireysel/mevduat/vadeli-mevduat/vov-hesap',
  new_req.previous_data,
  '{"alt_limit":7500000.01,"ust_limit":10000000,"vadesizde_kalacak":900000,"yillik_brut_oran":0.43,"note":"45 günlük tanışma dönemi (dönem sonunda ek ürün kullanımıyla süresiz devam edebilir).","gerekli_fon_bakiyesi":null,"vadesiz_hesaplama_tipi":"sabit","vadesiz_oran":null}'::jsonb,
  new_req.id,
  'ecf63f2107b6422594d4ae5a68172fbeab7aa57a5ae58b240d25dccde033001a',
  '{"Tutar Aralığı":"7.500.001-10.000.000","Avantajlı Tanışma Faizi":"43,00%","Vadesiz Hesapta Kalan Tutar":"900.000 TL"}'::jsonb,
  'VOV Hesap Faiz Tablosu',
  'Avantajlı Tanışma Faizi',
  '45 günlük tanışma dönemi (dönem sonunda ek ürün kullanımıyla süresiz devam edebilir).',
  '[{"column":"Avantajlı Tanışma Faizi","rate":0.43}]'::jsonb,
  'Bant sınırı normalizasyonu sonrası yeniden kontrol edildi; güncel kaynak verisiyle taze talep.'
from new_req;


-- bank_rate_id=2e3aa5b3-da37-49ac-8206-84d597f8c6a1  (0.44 -> 0.43)
with new_req as (
  insert into public.rate_change_requests (bank_rate_id, bank_id, change_type, proposed_data, previous_data, requested_by, source, status)
  select
    '2e3aa5b3-da37-49ac-8206-84d597f8c6a1'::uuid,
    '64028469-064b-4ef8-b7f8-aa34fec97d89'::uuid,
    'update',
    '{"alt_limit":10000000.01,"ust_limit":15000000,"vadesizde_kalacak":1500000,"yillik_brut_oran":0.43,"note":"45 günlük tanışma dönemi (dönem sonunda ek ürün kullanımıyla süresiz devam edebilir).","gerekli_fon_bakiyesi":null,"vadesiz_hesaplama_tipi":"sabit","vadesiz_oran":null}'::jsonb,
    to_jsonb(br.*),
    null,
    'automation',
    'pending'
  from public.bank_rates br where br.id = '2e3aa5b3-da37-49ac-8206-84d597f8c6a1'::uuid
    and not exists (
      select 1 from public.rate_change_requests x
      where x.bank_rate_id = br.id and x.status = 'pending' and x.source = 'automation'
    )
  returning id, previous_data
)
insert into public.rate_check_findings (run_id, bank_source_id, bank_id, finding_type, evidence_url, current_value, observed_value, rate_change_request_id, fingerprint, raw_evidence, source_table_name, selected_rate_column, selected_rate_condition, observed_rate_candidates, detail)
select
  '9f1cc8d4-8d3f-4735-b846-615ee7f31c00'::uuid,
  'a63fb42a-7592-43ec-a570-991891d80df0'::uuid,
  '64028469-064b-4ef8-b7f8-aa34fec97d89'::uuid,
  'rate_changed',
  'https://www.alternatifbank.com.tr/bireysel/mevduat/vadeli-mevduat/vov-hesap',
  new_req.previous_data,
  '{"alt_limit":10000000.01,"ust_limit":15000000,"vadesizde_kalacak":1500000,"yillik_brut_oran":0.43,"note":"45 günlük tanışma dönemi (dönem sonunda ek ürün kullanımıyla süresiz devam edebilir).","gerekli_fon_bakiyesi":null,"vadesiz_hesaplama_tipi":"sabit","vadesiz_oran":null}'::jsonb,
  new_req.id,
  'b3aeb737cc8493f9578c0e75b983726cd44bd99567682ec350a4dbe05e80a816',
  '{"Tutar Aralığı":"10.000.001-15.000.000","Avantajlı Tanışma Faizi":"43,00%","Vadesiz Hesapta Kalan Tutar":"1.500.000 TL"}'::jsonb,
  'VOV Hesap Faiz Tablosu',
  'Avantajlı Tanışma Faizi',
  '45 günlük tanışma dönemi (dönem sonunda ek ürün kullanımıyla süresiz devam edebilir).',
  '[{"column":"Avantajlı Tanışma Faizi","rate":0.43}]'::jsonb,
  'Bant sınırı normalizasyonu sonrası yeniden kontrol edildi; güncel kaynak verisiyle taze talep.'
from new_req;

