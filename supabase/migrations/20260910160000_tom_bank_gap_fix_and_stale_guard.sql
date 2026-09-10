-- ============================================================================
-- 1) TOM Bank ilk bandı düzeltmesi
-- ============================================================================
--
-- Denetimde doğrulandı: 2026-09-08 15:51 UTC'de onaylanan talep
-- (bf4bb743-4f01-4d71-8111-cdc2bf13f987), otomasyonun kendisinin "gerçek bir
-- değişiklik değil, otomatik yayımlanmasın" diye daha önce REDDETTİĞİ bayat
-- (10:26 UTC'de üretilmiş, sonradan elle düzeltilen alt_limit'i hesaba
-- katmayan) proposed_data'yı uyguladı. Bu, ust_limit'i 49999.99'dan 49999'a,
-- vadesizde_kalacak'ı 7500'den 7499'a düşürerek 49.999,01–49.999,99 TL
-- aralığını hiçbir bantta kapsanmaz hale getirdi.
--
-- Bu blok idempotenttir: değerler zaten doğruysa hiçbir şey yapmaz, tekrar
-- tekrar çalıştırılabilir. Eski onaylı talebin kendisi (rate_change_requests
-- satırı, audit_log geçmişi) SİLİNMEZ/DEĞİŞTİRİLMEZ — yalnızca canlı
-- bank_rates satırı düzeltilir ve YENİ bir audit_log kaydı eklenir.
do $$
declare
  v_bank_rate_id uuid := '2d49511d-e08b-47fc-8fdf-e167d9181650';
  v_before       jsonb;
  v_after        jsonb;
  v_actor_id     uuid;
begin
  select to_jsonb(br) into v_before from public.bank_rates br where br.id = v_bank_rate_id;

  if v_before is null then
    raise notice 'TOM Bank ilk bandı bulunamadı (id=%), düzeltme atlandı.', v_bank_rate_id;
    return;
  end if;

  if round((v_before->>'alt_limit')::numeric, 2) = 7500.00
     and round((v_before->>'ust_limit')::numeric, 2) = 49999.99
     and round((v_before->>'vadesizde_kalacak')::numeric, 2) = 7500.00
     and round((v_before->>'yillik_brut_oran')::numeric, 4) = 0.4300
  then
    raise notice 'TOM Bank ilk bandı zaten doğru normalleştirilmiş değerlerde — düzeltme gerekmedi (idempotent no-op).';
    return;
  end if;

  update public.bank_rates
    set alt_limit         = 7500,
        ust_limit         = 49999.99,
        vadesizde_kalacak = 7500,
        yillik_brut_oran  = 0.43,
        updated_at        = now()
    where id = v_bank_rate_id
    returning to_jsonb(bank_rates.*) into v_after;

  select id into v_actor_id from public.profiles where role = 'admin' order by id limit 1;
  if v_actor_id is null then
    raise exception 'Denetim kaydı için admin profili bulunamadı — düzeltme geri alınıyor.';
  end if;

  insert into public.audit_log (actor_id, action, entity_table, entity_id, diff)
  values (
    v_actor_id,
    'corrective_migration',
    'bank_rates',
    v_bank_rate_id,
    jsonb_build_object(
      'migration', '20260910160000_tom_bank_gap_fix_and_stale_guard',
      'reason', 'Eski/bayat TOM Bank talebinin yanlışlıkla onaylanması sonucunda oluşan 49.999,01–49.999,99 TL bant boşluğu düzeltildi; ilk bant doğru normalleştirilmiş değerlere geri getirildi.',
      'stale_request_id', 'bf4bb743-4f01-4d71-8111-cdc2bf13f987',
      'before', v_before,
      'after', v_after
    )
  );

  raise notice 'TOM Bank ilk bandı düzeltildi: ust_limit %->49999.99, vadesizde_kalacak %->7500.', v_before->>'ust_limit', v_before->>'vadesizde_kalacak';
end $$;

-- ============================================================================
-- 2) Bant bütünlüğü kontrolü — tekli ve toplu onaydan ÖNCE çağrılır
-- ============================================================================
--
-- Bir bankanın/ürünün, verilen değişiklik uygulandıktan SONRA ortaya çıkacak
-- TÜM aktif bantlarını simüle edip doğrular:
--   - alt limit üst limitten büyük olamaz
--   - negatif limit / negatif vadesiz tutar olamaz
--   - vadesizde kalacak tutar (sabit tipte) bandın üst sınırını aşamaz
--   - ardışık bantlar çakışamaz
--   - ardışık bantlar arasında 0,01 TL'den fazla boşluk olamaz
-- İlk bandın altındaki ve son bandın üstündeki alan kasıtlı kapsam dışı
-- sayılır (döngü yalnızca ardışık bantlar ARASINDAKİ geçişi kontrol eder).
--
-- Herhangi bir ihlalde RAISE EXCEPTION ile durur — çağıran fonksiyon
-- (approve_rate_change) bu durumda hiçbir bank_rates satırını yazmadan
-- tamamen iptal olur (PL/pgSQL fonksiyon çağrısı = atomik alt-işlem).
create or replace function public.assert_band_integrity(
  p_bank_id uuid,
  p_bank_rate_id uuid,          -- 'update'/'disable' hedefi olan satır (taban kümesinden çıkarılır); 'create' için null
  p_change_type text,            -- 'create' | 'update' | 'disable'
  p_new_alt numeric,
  p_new_ust numeric,
  p_new_vadesiz_kalacak numeric,
  p_new_vadesiz_tipi text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_band      record;
  v_prev_ust  numeric;
  v_has_prev  boolean := false;
  v_bank_name text;
  v_gap       numeric;
begin
  select name into v_bank_name from public.banks where id = p_bank_id;
  if v_bank_name is null then
    v_bank_name := 'Bilinmeyen banka';
  end if;

  for v_band in
    select alt_limit, ust_limit, vadesizde_kalacak, vadesiz_hesaplama_tipi
    from public.bank_rates
    where bank_id = p_bank_id
      and is_active = true
      and (p_bank_rate_id is null or id <> p_bank_rate_id)
    union all
    select p_new_alt, p_new_ust, p_new_vadesiz_kalacak, p_new_vadesiz_tipi
    where p_change_type in ('create', 'update')
    order by alt_limit
  loop
    if v_band.alt_limit is null or v_band.ust_limit is null then
      raise exception '% için bant geçersiz: alt/üst limit boş olamaz.', v_bank_name;
    end if;

    if v_band.alt_limit < 0 or v_band.ust_limit < 0 then
      raise exception '% için bant geçersiz: limitler negatif olamaz (alt: %, üst: %).', v_bank_name, v_band.alt_limit, v_band.ust_limit;
    end if;

    if v_band.alt_limit > v_band.ust_limit then
      raise exception '% için bant geçersiz: alt limit (%) üst limitten (%) büyük olamaz.', v_bank_name, v_band.alt_limit, v_band.ust_limit;
    end if;

    if v_band.vadesiz_hesaplama_tipi = 'sabit' then
      if v_band.vadesizde_kalacak < 0 then
        raise exception '% için bant geçersiz: vadesizde kalacak tutar negatif olamaz (%).', v_bank_name, v_band.vadesizde_kalacak;
      end if;
      if v_band.vadesizde_kalacak > v_band.ust_limit then
        raise exception '% için bant geçersiz: vadesizde kalacak tutar (%) bandın üst sınırını (%) aşamaz.', v_bank_name, v_band.vadesizde_kalacak, v_band.ust_limit;
      end if;
    end if;

    if v_has_prev then
      if v_band.alt_limit <= v_prev_ust then
        raise exception '% için bantlar çakışıyor: bir bandın alt limiti (%) bir önceki bandın üst limitinden (%) küçük veya ona eşit olamaz.', v_bank_name, v_band.alt_limit, v_prev_ust;
      end if;

      v_gap := round(v_band.alt_limit - v_prev_ust, 2);
      if v_gap > 0.01 then
        raise exception '% için bant boşluğu oluşur: % TL ile % TL arasındaki tutarlar hiçbir banda girmez.', v_bank_name, v_prev_ust, v_band.alt_limit;
      end if;
    end if;

    v_prev_ust := v_band.ust_limit;
    v_has_prev := true;
  end loop;
end;
$$;

revoke all on function public.assert_band_integrity(uuid, uuid, text, numeric, numeric, numeric, text) from public;

-- ============================================================================
-- 3) approve_rate_change — bayat talep koruması + bant bütünlüğü kontrolü
-- ============================================================================
--
-- "expected_current_data" için AYRI bir kolon eklenmedi: rate_change_requests
-- .previous_data zaten talep oluşturulduğu andaki bank_rates satırının anlık
-- görüntüsünü tutuyor (hem admin panelindeki öneri formu hem otomasyon Edge
-- Function'ı bunu dolduruyor) — yani bu alan zaten "beklenen mevcut değer"
-- görevini görüyor. Burada eklenen şey, onay anında bu beklenen değeri CANLI
-- satırla karşılaştıran kontroldür.
--
-- approve_rate_changes_bulk bu fonksiyonu döngü içinde TEK TEK çağırdığı için
-- (bkz. 20260910150000_bulk_approve_reject_rpcs.sql), her iki yeni koruma da
-- (bayat talep + bant bütünlüğü) toplu onaya OTOMATİK olarak miras kalır —
-- bulk fonksiyonunun kendisinde ayrıca değişiklik gerekmedi. Herhangi bir id
-- için exception fırlarsa PL/pgSQL fonksiyon çağrısı atomik olduğundan o ana
-- kadar işlenen TÜM talepler (döngünün önceki adımları dahil) geri alınır.
comment on column public.rate_change_requests.previous_data is
  'Talep oluşturulduğu anda ilgili bank_rates satırının anlık görüntüsü. approve_rate_change tarafından "beklenen mevcut değer" (expected_current_data) olarak kullanılır: onay anında canlı satır burada saklanan değerden sapmışsa talep bayat sayılır ve reddedilir.';

create or replace function public.approve_rate_change(p_request_id uuid, p_review_note text default null)
returns public.rate_change_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request   public.rate_change_requests;
  v_live      public.bank_rates;
  v_rate_id   uuid;
  v_old_data  jsonb;
  v_new_alt   numeric;
  v_new_ust   numeric;
  v_new_vk    numeric;
  v_new_vtipi text;
begin
  if not public.is_admin() then
    raise exception 'Bu işlemi yalnızca admin rolündeki kullanıcılar yapabilir.';
  end if;

  select * into v_request
  from public.rate_change_requests
  where id = p_request_id
  for update;

  if v_request.id is null then
    raise exception 'Talep bulunamadı: %', p_request_id;
  end if;

  if v_request.status <> 'pending' then
    raise exception 'Bu talep zaten "%" durumunda, tekrar onaylanamaz.', v_request.status;
  end if;

  -- Bayat talep koruması: create dışındaki tüm değişiklikler canlı bir
  -- bank_rates satırını hedefler; onay anında o satır kilitlenip beklenen
  -- (previous_data) değerle karşılaştırılır.
  if v_request.change_type in ('update', 'disable') then
    if v_request.previous_data is null or v_request.previous_data = '{}'::jsonb then
      raise exception 'Bu talep için beklenen mevcut değer kaydı yok; güvenli şekilde onaylanamaz. Lütfen talebi reddedip yeni bir kontrol çalıştırın.';
    end if;

    select * into v_live from public.bank_rates where id = v_request.bank_rate_id for update;
    if v_live.id is null then
      raise exception 'Talebe konu oran satırı artık mevcut değil.';
    end if;

    if (v_request.previous_data ? 'alt_limit' and round((v_request.previous_data->>'alt_limit')::numeric, 2) <> round(v_live.alt_limit, 2))
       or (v_request.previous_data ? 'ust_limit' and round((v_request.previous_data->>'ust_limit')::numeric, 2) <> round(v_live.ust_limit, 2))
       or (v_request.previous_data ? 'vadesizde_kalacak' and round((v_request.previous_data->>'vadesizde_kalacak')::numeric, 2) <> round(v_live.vadesizde_kalacak, 2))
       or (v_request.previous_data ? 'yillik_brut_oran' and round((v_request.previous_data->>'yillik_brut_oran')::numeric, 4) <> round(v_live.yillik_brut_oran, 4))
       or (v_request.previous_data ? 'vadesiz_hesaplama_tipi' and (v_request.previous_data->>'vadesiz_hesaplama_tipi') is distinct from v_live.vadesiz_hesaplama_tipi)
       or (v_request.previous_data ? 'vadesiz_oran' and round(coalesce((v_request.previous_data->>'vadesiz_oran')::numeric, -1), 2) <> round(coalesce(v_live.vadesiz_oran, -1), 2))
    then
      raise exception 'Bu talep güncelliğini kaybetmiş. Oranları yeniden kontrol edin.';
    end if;
  end if;

  if v_request.change_type = 'create' then
    v_new_alt   := (v_request.proposed_data->>'alt_limit')::numeric;
    v_new_ust   := (v_request.proposed_data->>'ust_limit')::numeric;
    v_new_vk    := coalesce((v_request.proposed_data->>'vadesizde_kalacak')::numeric, 0);
    v_new_vtipi := coalesce(v_request.proposed_data->>'vadesiz_hesaplama_tipi', 'sabit');

    perform public.assert_band_integrity(v_request.bank_id, null, 'create', v_new_alt, v_new_ust, v_new_vk, v_new_vtipi);

    insert into public.bank_rates (
      bank_id, alt_limit, ust_limit, vadesizde_kalacak, yillik_brut_oran,
      note, gerekli_fon_bakiyesi, vadesiz_hesaplama_tipi, vadesiz_oran,
      is_active, updated_by
    )
    values (
      v_request.bank_id, v_new_alt, v_new_ust, v_new_vk,
      (v_request.proposed_data->>'yillik_brut_oran')::numeric,
      coalesce(v_request.proposed_data->>'note', ''),
      nullif(v_request.proposed_data->>'gerekli_fon_bakiyesi', '')::numeric,
      v_new_vtipi,
      nullif(v_request.proposed_data->>'vadesiz_oran', '')::numeric,
      true,
      auth.uid()
    )
    returning id into v_rate_id;

  elsif v_request.change_type = 'update' then
    if v_request.bank_rate_id is null then
      raise exception '"update" talebi için bank_rate_id zorunludur.';
    end if;

    v_old_data := to_jsonb(v_live);

    v_new_alt   := coalesce((v_request.proposed_data->>'alt_limit')::numeric, v_live.alt_limit);
    v_new_ust   := coalesce((v_request.proposed_data->>'ust_limit')::numeric, v_live.ust_limit);
    v_new_vk    := coalesce((v_request.proposed_data->>'vadesizde_kalacak')::numeric, v_live.vadesizde_kalacak);
    v_new_vtipi := coalesce(v_request.proposed_data->>'vadesiz_hesaplama_tipi', v_live.vadesiz_hesaplama_tipi);

    perform public.assert_band_integrity(v_request.bank_id, v_request.bank_rate_id, 'update', v_new_alt, v_new_ust, v_new_vk, v_new_vtipi);

    update public.bank_rates set
      alt_limit              = v_new_alt,
      ust_limit               = v_new_ust,
      vadesizde_kalacak       = v_new_vk,
      yillik_brut_oran        = coalesce((v_request.proposed_data->>'yillik_brut_oran')::numeric, yillik_brut_oran),
      note                    = coalesce(v_request.proposed_data->>'note', note),
      gerekli_fon_bakiyesi    = case
                                  when v_request.proposed_data ? 'gerekli_fon_bakiyesi'
                                    then nullif(v_request.proposed_data->>'gerekli_fon_bakiyesi', '')::numeric
                                  else gerekli_fon_bakiyesi
                                end,
      vadesiz_hesaplama_tipi  = v_new_vtipi,
      vadesiz_oran            = case
                                  when v_request.proposed_data ? 'vadesiz_oran'
                                    then nullif(v_request.proposed_data->>'vadesiz_oran', '')::numeric
                                  else vadesiz_oran
                                end,
      is_active               = coalesce((v_request.proposed_data->>'is_active')::boolean, is_active),
      updated_by              = auth.uid()
    where id = v_request.bank_rate_id;

    v_rate_id := v_request.bank_rate_id;

  elsif v_request.change_type = 'disable' then
    if v_request.bank_rate_id is null then
      raise exception '"disable" talebi için bank_rate_id zorunludur.';
    end if;

    v_old_data := to_jsonb(v_live);

    perform public.assert_band_integrity(v_request.bank_id, v_request.bank_rate_id, 'disable', null, null, null, null);

    update public.bank_rates
      set is_active = false, updated_by = auth.uid()
      where id = v_request.bank_rate_id;

    v_rate_id := v_request.bank_rate_id;
  else
    raise exception 'Bilinmeyen change_type: %', v_request.change_type;
  end if;

  update public.rate_change_requests
    set status      = 'approved',
        reviewed_by = auth.uid(),
        reviewed_at = now(),
        review_note = p_review_note
    where id = p_request_id
    returning * into v_request;

  insert into public.audit_log (actor_id, action, entity_table, entity_id, diff)
  values (
    auth.uid(),
    'rate_change_approved',
    'bank_rates',
    v_rate_id,
    jsonb_build_object(
      'request_id', p_request_id,
      'change_type', v_request.change_type,
      'before', v_old_data,
      'after', v_request.proposed_data
    )
  );

  return v_request;
end;
$$;

revoke all on function public.approve_rate_change(uuid, text) from public;
grant execute on function public.approve_rate_change(uuid, text) to authenticated;
