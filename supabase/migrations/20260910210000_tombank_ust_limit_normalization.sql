-- ============================================================================
-- 1) TOM Bank'ın 3 "kirli" talebinin bayat/rejected olarak kapatılması
-- ============================================================================
--
-- Denetimde doğrulandı: check-bank-rates'in eski parseTomBank'i (Alternatifbank
-- parser'ına eklenen "+0,99 normalizasyonu"nu hiç almamıştı) 3 bant için
-- proposed_data.ust_limit'i kuruşsuz (ör. 7.499.999 yerine 7.499.999,99
-- olması gerekirken) üretmişti. Bu üç talep OLDUĞU GİBİ onaylansa, tam da bu
-- oturumun başında (20260910160000) düzeltilen türden yeni bant boşlukları
-- açardı — assert_band_integrity bunu zaten reddederdi, ama talebin kendisi
-- yanlış veri taşıdığı için düzeltilip yeniden açılmalı. 35.000.000 bandına
-- ait 4. talep (eae906b1) TEMİZDİ (ust_limit zaten tam sayı, kuruş sorunu
-- yok) — buna DOKUNULMUYOR, pending kalıyor.
--
-- bank_rates'e HİÇBİR ŞEY uygulanmıyor — yalnızca talep durumu ve inceleme
-- notu güncelleniyor. Talebin kendisi silinmiyor. İdempotenttir: ikinci
-- çalıştırmada bu 3 talep zaten 'pending' olmadığından döngü hiçbir satıra
-- dokunmaz.
do $$
declare
  v_bank_id  uuid := '9042c587-55d4-41c6-8933-51339462f94a';
  v_actor_id uuid;
  v_reason   text := 'Talep, TOM Bank üst sınırının kuruş bazında eksik normalize edilmesi nedeniyle geçersiz kaldı; doğrulanmış oran değişikliği doğru bant sınırlarıyla yeniden oluşturulacak.';
  v_dirty_ids uuid[] := array[
    '76aa574f-acad-411b-9d6f-746677b7be2a',
    'fb30a1e6-7ca9-4249-a55c-7f64810abbc8',
    'd17344de-e525-4d90-9960-e9c1c467a8b1'
  ];
  v_req record;
  v_count int := 0;
begin
  select id into v_actor_id from public.profiles where role = 'admin' order by id limit 1;
  if v_actor_id is null then
    raise exception 'Denetim kaydı için admin profili bulunamadı.';
  end if;

  for v_req in
    select rcr.id, rcr.bank_rate_id, rcr.proposed_data, rcr.previous_data
    from public.rate_change_requests rcr
    where rcr.id = any(v_dirty_ids) and rcr.status = 'pending'
    for update of rcr
  loop
    update public.rate_change_requests
      set status = 'rejected', reviewed_by = v_actor_id, reviewed_at = now(), review_note = v_reason
      where id = v_req.id;

    insert into public.audit_log (actor_id, action, entity_table, entity_id, diff)
    values (
      v_actor_id, 'rate_change_rejected_stale', 'rate_change_requests', v_req.id,
      jsonb_build_object(
        'reason', v_reason, 'bank_rate_id', v_req.bank_rate_id,
        'proposed_data', v_req.proposed_data, 'previous_data', v_req.previous_data,
        'migration', '20260910210000_tombank_ust_limit_normalization'
      )
    );
    v_count := v_count + 1;
  end loop;

  if v_count = 0 then
    raise notice 'TOM Bank: kapatilacak kirli pending talep bulunamadi (idempotent no-op).';
  else
    raise notice 'TOM Bank: % kirli talep bayat/rejected olarak kapatildi.', v_count;
  end if;
end $$;

-- ============================================================================
-- 2) Aynı doğrulanmış oran düşüşleriyle, doğru (kuruş-hassasiyetli) bant
--    sınırlarını taşıyan 3 taze pending talep
-- ============================================================================
--
-- previous_data = canlı bank_rates satırının GÜNCEL anlık görüntüsü (ust_limit
-- zaten doğru, hiç bozulmamıştı — sadece otomasyonun ürettiği ESKİ TEKLİF
-- yanlıştı). proposed_data yalnızca yillik_brut_oran'ı değiştirir; alt_limit,
-- ust_limit, vadesizde_kalacak canlıdaki doğru değerle AYNI kalır. Fingerprint
-- ve karşılaştırma normalize edilmiş (kuruş-doğru) değerler üzerinden
-- hesaplandı (bkz. denetim script'i). İdempotenttir: aynı bank_rate_id için
-- zaten pending bir otomasyon talebi varsa (ikinci çalıştırmada olacağı gibi)
-- NOT EXISTS koruması ile atlanır.

-- bank_rate_id=0c62ffe8-75ca-4b90-9795-03d7d36e2591  (0.445 -> 0.44, ust_limit dogru: 7499999.99)
with new_req as (
  insert into public.rate_change_requests (bank_rate_id, bank_id, change_type, proposed_data, previous_data, requested_by, source, status)
  select
    '0c62ffe8-75ca-4b90-9795-03d7d36e2591'::uuid, '9042c587-55d4-41c6-8933-51339462f94a'::uuid, 'update',
    '{"alt_limit":2500000,"ust_limit":7499999.99,"vadesizde_kalacak":775000,"yillik_brut_oran":0.44,"note":"","gerekli_fon_bakiyesi":null,"vadesiz_hesaplama_tipi":"sabit","vadesiz_oran":null}'::jsonb,
    to_jsonb(br.*), null, 'automation', 'pending'
  from public.bank_rates br where br.id = '0c62ffe8-75ca-4b90-9795-03d7d36e2591'::uuid
    and not exists (
      select 1 from public.rate_change_requests x
      where x.bank_rate_id = br.id and x.status = 'pending' and x.source = 'automation'
    )
  returning id, previous_data
)
insert into public.rate_check_findings (run_id, bank_source_id, bank_id, finding_type, evidence_url, current_value, observed_value, rate_change_request_id, fingerprint, raw_evidence, source_table_name, detail)
select
  'd49e7d56-549e-412a-abce-a0079a3a5d6c'::uuid, 'b35d2557-4aea-4a35-8e94-7eeaf4caa61d'::uuid, '9042c587-55d4-41c6-8933-51339462f94a'::uuid, 'rate_changed',
  'https://tombank.com.tr/gunluk-kazandiran-hesap.html',
  new_req.previous_data,
  '{"alt_limit":2500000,"ust_limit":7499999.99,"vadesizde_kalacak":775000,"yillik_brut_oran":0.44,"note":"","gerekli_fon_bakiyesi":null,"vadesiz_hesaplama_tipi":"sabit","vadesiz_oran":null}'::jsonb,
  new_req.id,
  'cce140aa753e662f74601194a5322538fa1d9a23b6f314898c6c0eb7f42c3520',
  '{"Oran (kaynak sütunu)":"44,00%","Alt Limit (kaynak sütunu)":"2.500.000","Üst Limit (kaynak sütunu)":"7.499.999","Vadesiz Alt Limit (kaynak sütunu)":"775.000 TL","raw_source_values":"7499999","Normalizasyon":"TL kuruşlarında bant boşluğu oluşmaması için üst sınır +0,99 TL normalize edildi"}'::jsonb,
  'TOM Bank Faiz Tablosu',
  'Parser normalizasyonu düzeltildikten sonra yeniden kontrol edildi; güncel kaynak verisiyle taze (kuruş-doğru) talep.'
from new_req;


-- bank_rate_id=0055bbeb-101d-48f1-a60b-0e914390169f  (0.45 -> 0.445, ust_limit dogru: 17499999.99)
with new_req as (
  insert into public.rate_change_requests (bank_rate_id, bank_id, change_type, proposed_data, previous_data, requested_by, source, status)
  select
    '0055bbeb-101d-48f1-a60b-0e914390169f'::uuid, '9042c587-55d4-41c6-8933-51339462f94a'::uuid, 'update',
    '{"alt_limit":7500000,"ust_limit":17499999.99,"vadesizde_kalacak":1750000,"yillik_brut_oran":0.445,"note":"","gerekli_fon_bakiyesi":null,"vadesiz_hesaplama_tipi":"sabit","vadesiz_oran":null}'::jsonb,
    to_jsonb(br.*), null, 'automation', 'pending'
  from public.bank_rates br where br.id = '0055bbeb-101d-48f1-a60b-0e914390169f'::uuid
    and not exists (
      select 1 from public.rate_change_requests x
      where x.bank_rate_id = br.id and x.status = 'pending' and x.source = 'automation'
    )
  returning id, previous_data
)
insert into public.rate_check_findings (run_id, bank_source_id, bank_id, finding_type, evidence_url, current_value, observed_value, rate_change_request_id, fingerprint, raw_evidence, source_table_name, detail)
select
  'd49e7d56-549e-412a-abce-a0079a3a5d6c'::uuid, 'b35d2557-4aea-4a35-8e94-7eeaf4caa61d'::uuid, '9042c587-55d4-41c6-8933-51339462f94a'::uuid, 'rate_changed',
  'https://tombank.com.tr/gunluk-kazandiran-hesap.html',
  new_req.previous_data,
  '{"alt_limit":7500000,"ust_limit":17499999.99,"vadesizde_kalacak":1750000,"yillik_brut_oran":0.445,"note":"","gerekli_fon_bakiyesi":null,"vadesiz_hesaplama_tipi":"sabit","vadesiz_oran":null}'::jsonb,
  new_req.id,
  'ad42f3bb350b8e8e3ebe01699cde462853372a879de223676b1902258bba8d25',
  '{"Oran (kaynak sütunu)":"44,50%","Alt Limit (kaynak sütunu)":"7.500.000","Üst Limit (kaynak sütunu)":"17.499.999","Vadesiz Alt Limit (kaynak sütunu)":"1.750.000 TL","raw_source_values":"17499999","Normalizasyon":"TL kuruşlarında bant boşluğu oluşmaması için üst sınır +0,99 TL normalize edildi"}'::jsonb,
  'TOM Bank Faiz Tablosu',
  'Parser normalizasyonu düzeltildikten sonra yeniden kontrol edildi; güncel kaynak verisiyle taze (kuruş-doğru) talep.'
from new_req;


-- bank_rate_id=c61c9598-ec9a-4add-a96d-3e5accdf0d4e  (0.445 -> 0.44, ust_limit dogru: 34999999.99)
with new_req as (
  insert into public.rate_change_requests (bank_rate_id, bank_id, change_type, proposed_data, previous_data, requested_by, source, status)
  select
    'c61c9598-ec9a-4add-a96d-3e5accdf0d4e'::uuid, '9042c587-55d4-41c6-8933-51339462f94a'::uuid, 'update',
    '{"alt_limit":17500000,"ust_limit":34999999.99,"vadesizde_kalacak":3000000,"yillik_brut_oran":0.44,"note":"","gerekli_fon_bakiyesi":null,"vadesiz_hesaplama_tipi":"sabit","vadesiz_oran":null}'::jsonb,
    to_jsonb(br.*), null, 'automation', 'pending'
  from public.bank_rates br where br.id = 'c61c9598-ec9a-4add-a96d-3e5accdf0d4e'::uuid
    and not exists (
      select 1 from public.rate_change_requests x
      where x.bank_rate_id = br.id and x.status = 'pending' and x.source = 'automation'
    )
  returning id, previous_data
)
insert into public.rate_check_findings (run_id, bank_source_id, bank_id, finding_type, evidence_url, current_value, observed_value, rate_change_request_id, fingerprint, raw_evidence, source_table_name, detail)
select
  'd49e7d56-549e-412a-abce-a0079a3a5d6c'::uuid, 'b35d2557-4aea-4a35-8e94-7eeaf4caa61d'::uuid, '9042c587-55d4-41c6-8933-51339462f94a'::uuid, 'rate_changed',
  'https://tombank.com.tr/gunluk-kazandiran-hesap.html',
  new_req.previous_data,
  '{"alt_limit":17500000,"ust_limit":34999999.99,"vadesizde_kalacak":3000000,"yillik_brut_oran":0.44,"note":"","gerekli_fon_bakiyesi":null,"vadesiz_hesaplama_tipi":"sabit","vadesiz_oran":null}'::jsonb,
  new_req.id,
  '775fae468511c80e38f1c5bdbcdf337e18399271c60264cfe6cbb43fe379428b',
  '{"Oran (kaynak sütunu)":"44,00%","Alt Limit (kaynak sütunu)":"17.500.000","Üst Limit (kaynak sütunu)":"34.999.999","Vadesiz Alt Limit (kaynak sütunu)":"3.000.000 TL","raw_source_values":"34999999","Normalizasyon":"TL kuruşlarında bant boşluğu oluşmaması için üst sınır +0,99 TL normalize edildi"}'::jsonb,
  'TOM Bank Faiz Tablosu',
  'Parser normalizasyonu düzeltildikten sonra yeniden kontrol edildi; güncel kaynak verisiyle taze (kuruş-doğru) talep.'
from new_req;
