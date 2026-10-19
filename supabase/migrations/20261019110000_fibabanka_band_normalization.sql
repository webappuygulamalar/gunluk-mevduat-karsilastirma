-- ============================================================================
-- Fibabanka Kiraz ürünleri — kuruş bazlı bant normalizasyonu
-- ============================================================================
--
-- Resmî Fibabanka tablosu sınırları kuruş göstermeden yayımlar:
--   10.000-24.999 / 25.000-49.999 / ...
-- Uygulama TL'yi kuruş hassasiyetinde hesapladığı için bu gösterim doğrudan
-- kaydedildiğinde her geçişte 0,99 TL'lik boşluk bırakır. assert_band_integrity
-- bu nedenle doğru olarak oran onayını durdurur.
--
-- Bu migration iki aktif üründe de:
--   1) ilk 11 bandın ust_limit'ini sonraki alt_limit - 0,01 yapar,
--   2) eski sınırları taşıyan 12'şer automation talebini audit iziyle kapatır,
--   3) resmî sayfada doğrulanmış oran hedeflerini (%43 Fonlu / %41 Hoş Geldin)
--      normalize edilmiş canlı bantlarla 12'şer TAZE pending talep olarak kurar.
--
-- Hiçbir oran otomatik yayımlanmaz. Taze talepler yine admin onayı bekler.
-- İdempotenttir: sınırlar/talepler zaten tazeyse ikinci çalıştırma no-op olur.

do $$
declare
  v_actor_id       uuid;
  v_bank           record;
  v_rate           record;
  v_req            record;
  v_new_request_id uuid;
  v_target_ust     numeric;
  v_target_rate    numeric;
  v_active_count   int;
  v_pending_count  int;
  v_stale_count    int;
  v_changed_count  int;
  v_rejected_count int;
  v_created_count  int;
  v_changes        jsonb;
  v_old_ids        uuid[];
  v_new_ids        uuid[];
begin
  select id into v_actor_id
  from public.profiles
  where role = 'admin'
  order by id
  limit 1;

  if v_actor_id is null then
    raise exception 'Denetim kaydı için admin profili bulunamadı.';
  end if;

  if (select count(*) from public.banks where name in ('Fibabanka Fonlu Kiraz', 'Fibabanka Kiraz Hoş Geldin')) <> 2 then
    raise exception 'İki aktif Fibabanka ürünü birlikte bulunamadı; migration durduruldu.';
  end if;

  for v_bank in
    select id, name
    from public.banks
    where name in ('Fibabanka Fonlu Kiraz', 'Fibabanka Kiraz Hoş Geldin')
    order by name
  loop
    v_target_rate := case
      when v_bank.name = 'Fibabanka Fonlu Kiraz' then 0.43
      else 0.41
    end;

    select count(*) into v_active_count
    from public.bank_rates
    where bank_id = v_bank.id and is_active = true;

    if v_active_count <> 12 then
      raise exception '% için 12 aktif bant bekleniyordu, % bulundu.', v_bank.name, v_active_count;
    end if;

    v_changed_count := 0;
    v_changes := '[]'::jsonb;

    for v_rate in
      select id, alt_limit, ust_limit,
             lead(alt_limit) over (order by alt_limit) as next_alt
      from public.bank_rates
      where bank_id = v_bank.id and is_active = true
      order by alt_limit
    loop
      if v_rate.next_alt is null then
        continue;
      end if;

      v_target_ust := round(v_rate.next_alt - 0.01, 2);

      if round(v_rate.ust_limit, 2) = v_target_ust then
        continue;
      end if;

      -- Yalnızca resmî tablonun tam-TL gösteriminden gelen 1 TL'lik geçişi
      -- dönüştür. Başka bir boşluk/çakışma varsa tahmin yürütme.
      if round(v_rate.next_alt - v_rate.ust_limit, 2) <> 1.00 then
        raise exception '% bandında beklenmeyen sınır yapısı: alt=%, üst=%, sonraki alt=%.',
          v_bank.name, v_rate.alt_limit, v_rate.ust_limit, v_rate.next_alt;
      end if;

      update public.bank_rates
      set ust_limit = v_target_ust
      where id = v_rate.id;

      v_changes := v_changes || jsonb_build_object(
        'bank_rate_id', v_rate.id,
        'alt_limit', v_rate.alt_limit,
        'old_ust_limit', v_rate.ust_limit,
        'new_ust_limit', v_target_ust
      );
      v_changed_count := v_changed_count + 1;
    end loop;

    if exists (
      select 1
      from (
        select alt_limit, ust_limit,
               lead(alt_limit) over (order by alt_limit) as next_alt
        from public.bank_rates
        where bank_id = v_bank.id and is_active = true
      ) x
      where x.next_alt is not null
        and round(x.next_alt - x.ust_limit, 2) <> 0.01
    ) then
      raise exception '% bant bütünlüğü normalizasyon sonrasında da sağlanamadı.', v_bank.name;
    end if;

    if v_changed_count > 0 then
      insert into public.audit_log (actor_id, action, entity_table, entity_id, diff)
      values (
        v_actor_id,
        'corrective_migration',
        'bank_rates',
        v_bank.id,
        jsonb_build_object(
          'bank_id', v_bank.id,
          'bank_name', v_bank.name,
          'reason', 'Resmî Fibabanka tablosundaki tam-TL üst sınırları, kuruş hassasiyetinde kapsama boşluğu bırakmaması için sonraki alt limitten 0,01 TL eksiğe tamamlandı. Alt limit, oran, vadesiz tutar ve son bant değiştirilmedi.',
          'changed_band_count', v_changed_count,
          'changes', v_changes,
          'migration', '20261019110000_fibabanka_band_normalization'
        )
      );
    end if;

    select count(*) into v_pending_count
    from public.rate_change_requests
    where bank_id = v_bank.id and status = 'pending';

    if v_pending_count = 0 then
      raise notice '% için pending talep yok; bant normalizasyonu dışında işlem yapılmadı.', v_bank.name;
      continue;
    end if;

    select count(*) into v_stale_count
    from public.rate_change_requests rcr
    join public.bank_rates br on br.id = rcr.bank_rate_id
    where rcr.bank_id = v_bank.id
      and rcr.status = 'pending'
      and round((rcr.previous_data->>'ust_limit')::numeric, 2) <> round(br.ust_limit, 2);

    -- Migration'ın daha önce ürettiği taze talepler canlı bantlarla eşleşir;
    -- onlara dokunma. Böylece yeniden çalıştırma güvenli bir no-op'tur.
    if v_stale_count = 0 then
      raise notice '% için pending talepler zaten güncel; yeniden oluşturulmadı.', v_bank.name;
      continue;
    end if;

    if v_pending_count <> 12 then
      raise exception '% için 12 pending talep bekleniyordu, % bulundu.', v_bank.name, v_pending_count;
    end if;

    if (
      select count(distinct bank_rate_id)
      from public.rate_change_requests
      where bank_id = v_bank.id and status = 'pending'
    ) <> 12 then
      raise exception '% pending taleplerinde mükerrer veya eksik bant var; migration durduruldu.', v_bank.name;
    end if;

    v_rejected_count := 0;
    v_created_count := 0;
    v_old_ids := array[]::uuid[];
    v_new_ids := array[]::uuid[];

    for v_rate in
      select *
      from public.bank_rates
      where bank_id = v_bank.id and is_active = true
      order by alt_limit
      for update
    loop
      select * into strict v_req
      from public.rate_change_requests
      where bank_rate_id = v_rate.id and status = 'pending'
      for update;

      if v_req.change_type <> 'update' or v_req.source <> 'automation' then
        raise exception '% için beklenmeyen talep türü/kaynağı: id=%, type=%, source=%.',
          v_bank.name, v_req.id, v_req.change_type, v_req.source;
      end if;

      if round((v_req.proposed_data->>'yillik_brut_oran')::numeric, 4) <> v_target_rate then
        raise exception '% için doğrulanmış hedef oran dışında talep bulundu: id=%, oran=%.',
          v_bank.name, v_req.id, v_req.proposed_data->>'yillik_brut_oran';
      end if;

      if round(v_rate.yillik_brut_oran, 4) = v_target_rate then
        raise exception '% bandı zaten hedef oranda; no-op talep üretilemez: bank_rate_id=%.', v_bank.name, v_rate.id;
      end if;

      update public.rate_change_requests
      set status = 'rejected',
          reviewed_by = v_actor_id,
          reviewed_at = now(),
          review_note = 'Fibabanka bant sınırları kuruş bazında normalize edildiği için bu otomatik talep eski tam-TL sınırlarını taşıyor ve güvenli şekilde onaylanamaz. Aynı doğrulanmış oran değişikliği normalize edilmiş bantla taze bir talep olarak yeniden oluşturuldu.'
      where id = v_req.id;

      insert into public.audit_log (actor_id, action, entity_table, entity_id, diff)
      values (
        v_actor_id,
        'rate_change_rejected_stale',
        'rate_change_requests',
        v_req.id,
        jsonb_build_object(
          'bank_name', v_bank.name,
          'bank_rate_id', v_rate.id,
          'reason', 'Bant sınırı normalizasyonu nedeniyle eski otomatik talep bayatladı; oran yayımlanmadan kapatıldı.',
          'previous_data', v_req.previous_data,
          'proposed_data', v_req.proposed_data,
          'migration', '20261019110000_fibabanka_band_normalization'
        )
      );

      insert into public.rate_change_requests (
        bank_rate_id, bank_id, change_type, proposed_data, previous_data,
        requested_by, source, status
      )
      values (
        v_rate.id,
        v_bank.id,
        'update',
        jsonb_build_object(
          'alt_limit', v_rate.alt_limit,
          'ust_limit', v_rate.ust_limit,
          'vadesizde_kalacak', v_rate.vadesizde_kalacak,
          'yillik_brut_oran', v_target_rate,
          'note', v_rate.note,
          'gerekli_fon_bakiyesi', v_rate.gerekli_fon_bakiyesi,
          'vadesiz_hesaplama_tipi', v_rate.vadesiz_hesaplama_tipi,
          'vadesiz_oran', v_rate.vadesiz_oran
        ),
        to_jsonb(v_rate),
        v_req.requested_by,
        v_req.source,
        'pending'
      )
      returning id into v_new_request_id;

      v_old_ids := array_append(v_old_ids, v_req.id);
      v_new_ids := array_append(v_new_ids, v_new_request_id);
      v_rejected_count := v_rejected_count + 1;
      v_created_count := v_created_count + 1;
    end loop;

    if v_rejected_count <> 12 or v_created_count <> 12 then
      raise exception '% talep yenileme sayısı hatalı: rejected=%, created=%.',
        v_bank.name, v_rejected_count, v_created_count;
    end if;

    insert into public.audit_log (actor_id, action, entity_table, entity_id, diff)
    values (
      v_actor_id,
      'rate_change_fresh_requests_created',
      'rate_change_requests',
      v_bank.id,
      jsonb_build_object(
        'bank_id', v_bank.id,
        'bank_name', v_bank.name,
        'target_rate', v_target_rate,
        'rejected_stale_request_ids', to_jsonb(v_old_ids),
        'created_request_ids', to_jsonb(v_new_ids),
        'created_count', v_created_count,
        'reason', 'Eski tam-TL bant sınırlarını taşıyan otomatik talepler kapatıldı; aynı resmî oran değişiklikleri kuruş bazında bitişik bantlarla yeniden onaya sunuldu. Hiçbir oran otomatik yayımlanmadı.',
        'migration', '20261019110000_fibabanka_band_normalization'
      )
    );
  end loop;
end $$;
