-- ============================================================================
-- 1) Yapı Kredi — bant sınırı normalizasyonu (kuruş boşluğu)
-- ============================================================================
--
-- Salt okunur denetimde doğrulandı: Yapı Kredi'nin TÜM 9 aktif bandı arasında
-- (10.000/49.999, 50.000/99.999, ... 3.000.000/4.999.999, 5.000.000/10.000.000)
-- ardışık sınırlar arasında TAM 1,00 TL'lik bir kapsama boşluğu vardı (ör.
-- 49.999,01–49.999,99 TL hiçbir banda girmiyordu) — TOM Bank (20260910160000)
-- ve Alternatifbank'ta (20260910170000) düzeltilen sorunla birebir aynı kök
-- neden: eski bant verisi hiç kuruş bazında normalize edilmemişti. Admin
-- panelinden gönderilen "%41,50 -> %41,00" talepleri bu yüzden
-- assert_band_integrity() tarafından haklı olarak reddediliyordu — güvenlik
-- kontrolünde bir hata YOK, sorun veri kalitesindeydi.
--
-- Bu blok YALNIZCA ust_limit'i düzeltir: her bandın üst limiti, SONRAKİ
-- bandın (değiştirilmeyen) alt limitinden 0,01 TL eksiğe çekilir. Son bandın
-- (5.000.000–10.000.000) üst limiti, sonraki bant olmadığı için dokunulmaz.
-- alt_limit, yillik_brut_oran, vadesizde_kalacak hiçbir bantta değiştirilmez.
--
-- İdempotenttir: bantlar zaten normalize edilmişse (ikinci çalıştırma) hiçbir
-- satır güncellenmez, audit_log'a yeni bir kayıt eklenmez.
do $$
declare
  v_bank_id   uuid := '5e3b1c07-19d3-4448-92c5-ffabf4d86db7';
  v_actor_id  uuid;
  v_changes   jsonb := '[]'::jsonb;
  v_row       record;
  v_target    numeric;
  v_count     int := 0;
begin
  select id into v_actor_id from public.profiles where role = 'admin' order by id limit 1;
  if v_actor_id is null then
    raise exception 'Denetim kaydı için admin profili bulunamadı.';
  end if;

  for v_row in
    select id, alt_limit, ust_limit,
           lead(alt_limit) over (order by alt_limit) as next_alt
    from public.bank_rates
    where bank_id = v_bank_id and is_active = true
    order by alt_limit
  loop
    if v_row.next_alt is not null then
      v_target := round(v_row.next_alt - 0.01, 2);

      if round(v_row.ust_limit, 2) <> v_target then
        update public.bank_rates set ust_limit = v_target where id = v_row.id;

        v_changes := v_changes || jsonb_build_object(
          'bank_rate_id', v_row.id,
          'alt_limit', v_row.alt_limit,
          'old_ust_limit', v_row.ust_limit,
          'new_ust_limit', v_target
        );
        v_count := v_count + 1;
      end if;
    end if;
  end loop;

  if v_count = 0 then
    raise notice 'Yapı Kredi bant sınırları zaten normalize edilmiş — değişiklik yapılmadı (idempotent no-op).';
  else
    insert into public.audit_log (actor_id, action, entity_table, entity_id, diff)
    values (
      v_actor_id,
      'corrective_migration',
      'bank_rates',
      v_bank_id,
      jsonb_build_object(
        'bank_id', v_bank_id,
        'reason', 'TL kuruşlarında kapsama boşluğu oluşmaması için ardışık bant sınırları kuruş bazında bitiştirildi (her bandın üst limiti, sonraki bandın alt limitinden 0,01 TL eksiğe çekildi). Alt limitler, yıllık brüt oranlar ve vadesizde kalacak tutarlar değiştirilmedi. Son bandın üst limiti (sonraki bant olmadığı için) dokunulmadan bırakıldı.',
        'changed_band_count', v_count,
        'changes', v_changes,
        'migration', '20260915120000_yapikredi_band_normalization_and_fresh_requests'
      )
    );
    raise notice 'Yapı Kredi: % bant sınırı normalize edildi.', v_count;
  end if;
end $$;

-- ============================================================================
-- 2) Bant normalizasyonu nedeniyle bayatlayan 10 pending talebin kapatılması
-- ============================================================================
--
-- Denetimde doğrulandı: ekranda "10 pending" görünmesinin nedeni bir eksik
-- talep değil, bir MÜKERRER talepti. Yapı Kredi'nin 9 aktif bandının her
-- biri için ayrı ayrı manuel talep gönderilmişti (hepsi 2026-09-14 10:53–
-- 10:54 UTC arası, aynı admin: 18d4ff94-8c97-45a3-a470-5d2a8131663b, hepsi
-- yillik_brut_oran 0,415 -> 0,41 dışında hiçbir alanı değiştirmiyor), ANCAK
-- 2.000.000–2.999.999 TL bandı (bank_rate_id=caec5a50-9da0-47a0-9153-
-- 81be454e8e83) için art arda (10:54:21 ve 10:54:28 — 7 saniye arayla) iki
-- kez gönderim yapılmış: 9 benzersiz bant için 10 talep. Bu blok her iki
-- kopyayı da kapatır; ikincisi ayrıca "mükerrer manuel talep" olarak
-- etiketlenir.
--
-- Bağımsız olarak: normalizasyon adımı 1'de ust_limit değiştiği için TÜM 10
-- talebin previous_data'sı artık canlı bank_rates satırıyla eşleşmiyor —
-- approve_rate_change zaten bunları "güncelliğini kaybetmiş" diye reddederdi.
-- Bu durum burada AÇIKÇA ve KALICI olarak kayda geçiriliyor: talepler
-- 'rejected' durumuna getiriliyor (bank_rates'e HİÇBİR ŞEY uygulanmadan).
-- Talebin kendisi silinmiyor; yalnızca durumu ve inceleme notu güncelleniyor,
-- previous_data/proposed_data içeriği DOKUNULMADAN kalıyor.
--
-- İdempotenttir: bu blok yalnızca GERÇEKTEN geçersiz (previous_data canlı
-- bank_rates satırıyla artık eşleşmiyor — approve_rate_change'in kendi bayat
-- talep kontrolüyle BİREBİR aynı karşılaştırma) veya mükerrer olan pending
-- talepleri kapatır. İkinci çalıştırmada, bu migration'ın adım 3'te ürettiği
-- taze talepler previous_data'sı zaten normalize edilmiş canlı satırla
-- eşleştiğinden ve tekil olduklarından "stale"/"duplicate" sayılmaz —
-- dokunulmadan pending kalırlar.
do $$
declare
  v_bank_id            uuid := '5e3b1c07-19d3-4448-92c5-ffabf4d86db7';
  v_actor_id           uuid;
  v_reason_stale       text := 'Bant sınırları kuruş bazında normalize edildiği için bu talebin previous_data''sı artık canlı bank_rates satırıyla eşleşmiyor ve güvenli şekilde onaylanamaz. Doğrulanmış %41,00 oran değişikliği, normalize edilmiş bant sınırlarıyla taze bir talep olarak yeniden oluşturuldu.';
  v_reason_dup_only    text := 'Bu talep, aynı banda ait daha erken gönderilmiş bir talebin mükerrer (duplicate) kopyasıdır.';
  v_reason_dup_suffix  text := ' Ayrıca bu talep, aynı banda (bank_rate_id=caec5a50-9da0-47a0-9153-81be454e8e83, 2.000.000–2.999.999 TL) ait 2026-09-14 10:54:21 UTC''deki talebin 7 saniye sonra (10:54:28 UTC) gönderilmiş MÜKERRER (duplicate) bir kopyasıdır.';
  v_req                record;
  v_count              int := 0;
  v_dup_count          int := 0;
  v_is_dup             boolean;
  v_is_stale           boolean;
  v_reason             text;
  v_dup_ids            uuid[];
begin
  select id into v_actor_id from public.profiles where role = 'admin' order by id limit 1;
  if v_actor_id is null then
    raise exception 'Denetim kaydı için admin profili bulunamadı.';
  end if;

  -- Mükerrer talepleri ÖNCE, ayrı bir salt-okunur sorguyla tespit et
  -- (FOR UPDATE ile pencere fonksiyonu aynı sorguda birlikte kullanılamaz).
  select array_agg(s.id) into v_dup_ids
  from (
    select rcr.id, row_number() over (partition by rcr.bank_rate_id order by rcr.requested_at asc) as rn
    from public.rate_change_requests rcr
    where rcr.bank_id = v_bank_id and rcr.status = 'pending'
  ) s
  where s.rn > 1;

  for v_req in
    select rcr.id, rcr.bank_rate_id, rcr.proposed_data, rcr.previous_data,
           br.alt_limit as live_alt, br.ust_limit as live_ust, br.vadesizde_kalacak as live_vk,
           br.yillik_brut_oran as live_oran, br.vadesiz_hesaplama_tipi as live_vtipi, br.vadesiz_oran as live_voran
    from public.rate_change_requests rcr
    join public.bank_rates br on br.id = rcr.bank_rate_id
    where rcr.bank_id = v_bank_id and rcr.status = 'pending'
    order by rcr.requested_at
    for update of rcr
  loop
    v_is_dup := v_req.id = any(coalesce(v_dup_ids, array[]::uuid[]));

    -- approve_rate_change'in bayat talep kontrolüyle birebir aynı karşılaştırma.
    v_is_stale := (
      (v_req.previous_data ? 'alt_limit' and round((v_req.previous_data->>'alt_limit')::numeric, 2) <> round(v_req.live_alt, 2))
      or (v_req.previous_data ? 'ust_limit' and round((v_req.previous_data->>'ust_limit')::numeric, 2) <> round(v_req.live_ust, 2))
      or (v_req.previous_data ? 'vadesizde_kalacak' and round((v_req.previous_data->>'vadesizde_kalacak')::numeric, 2) <> round(v_req.live_vk, 2))
      or (v_req.previous_data ? 'yillik_brut_oran' and round((v_req.previous_data->>'yillik_brut_oran')::numeric, 4) <> round(v_req.live_oran, 4))
      or (v_req.previous_data ? 'vadesiz_hesaplama_tipi' and (v_req.previous_data->>'vadesiz_hesaplama_tipi') is distinct from v_req.live_vtipi)
      or (v_req.previous_data ? 'vadesiz_oran' and round(coalesce((v_req.previous_data->>'vadesiz_oran')::numeric, -1), 2) <> round(coalesce(v_req.live_voran, -1), 2))
    );

    if not (v_is_dup or v_is_stale) then
      -- Hâlâ geçerli (canlı satırla eşleşen, tekil) bir talep — dokunma.
      continue;
    end if;

    if v_is_stale and v_is_dup then
      v_reason := v_reason_stale || v_reason_dup_suffix;
    elsif v_is_stale then
      v_reason := v_reason_stale;
    else
      v_reason := v_reason_dup_only;
    end if;

    update public.rate_change_requests
      set status      = 'rejected',
          reviewed_by = v_actor_id,
          reviewed_at = now(),
          review_note = v_reason
      where id = v_req.id;

    insert into public.audit_log (actor_id, action, entity_table, entity_id, diff)
    values (
      v_actor_id,
      case when v_is_dup then 'rate_change_rejected_duplicate' else 'rate_change_rejected_stale' end,
      'rate_change_requests',
      v_req.id,
      jsonb_build_object(
        'reason', v_reason,
        'bank_rate_id', v_req.bank_rate_id,
        'proposed_data', v_req.proposed_data,
        'previous_data', v_req.previous_data,
        'is_duplicate', v_is_dup,
        'is_stale', v_is_stale,
        'migration', '20260915120000_yapikredi_band_normalization_and_fresh_requests'
      )
    );

    v_count := v_count + 1;
    if v_is_dup then
      v_dup_count := v_dup_count + 1;
    end if;
  end loop;

  if v_count = 0 then
    raise notice 'Yapı Kredi için kapatılacak pending talep bulunamadı (idempotent no-op).';
  else
    raise notice 'Yapı Kredi: % pending talep bayat/rejected olarak kapatıldı (bunlardan % tanesi mükerrer talep).', v_count, v_dup_count;
  end if;
end $$;

-- ============================================================================
-- 3) Doğrulanmış oran değişikliğiyle, normalize edilmiş bant sınırlarını
--    taşıyan 9 taze pending talep (bir aktif bant = bir talep)
-- ============================================================================
--
-- Kullanıcının doğrulanmış niyeti: Yapı Kredi'nin TÜM bantlarında yıllık brüt
-- oranı %41,50'den (0.415) %41,00'e (0.41) indirmek — alt_limit, ust_limit
-- (normalize edilmiş hali), vadesizde_kalacak, note, gerekli_fon_bakiyesi,
-- vadesiz_hesaplama_tipi, vadesiz_oran hiçbir bantta DEĞİŞTİRİLMİYOR.
--
-- previous_data = adım 1'de normalize edilmiş canlı bank_rates satırının
-- GÜNCEL anlık görüntüsü (to_jsonb(br.*)) — approve_rate_change'in bayat
-- talep koruması bunu canlı satırla karşılaştırır. requested_by, adım 2'de
-- kapatılan orijinal manuel talepten (aynı bank_rate_id, en son gönderilen)
-- güvenli biçimde korunur — hardcode edilmez.
--
-- İdempotenttir: her aktif bant için zaten 'pending' bir talep varsa (ikinci
-- çalıştırmada, bu migration'ın kendi ürettiği talepler dahil) NOT EXISTS
-- koruması ile atlanır — bir bank_rate_id için asla birden fazla pending
-- talep oluşmaz.
do $$
declare
  v_bank_id      uuid := '5e3b1c07-19d3-4448-92c5-ffabf4d86db7';
  v_actor_id     uuid;
  v_inserted_ids uuid[];
begin
  with inserted as (
    insert into public.rate_change_requests (
      bank_rate_id, bank_id, change_type, proposed_data, previous_data, requested_by, source, status
    )
    select
      br.id,
      br.bank_id,
      'update',
      jsonb_build_object(
        'alt_limit', br.alt_limit,
        'ust_limit', br.ust_limit,
        'vadesizde_kalacak', br.vadesizde_kalacak,
        'yillik_brut_oran', 0.41,
        'note', br.note,
        'gerekli_fon_bakiyesi', br.gerekli_fon_bakiyesi,
        'vadesiz_hesaplama_tipi', br.vadesiz_hesaplama_tipi,
        'vadesiz_oran', br.vadesiz_oran
      ),
      to_jsonb(br.*),
      (
        select rcr2.requested_by
        from public.rate_change_requests rcr2
        where rcr2.bank_rate_id = br.id
        order by rcr2.requested_at desc
        limit 1
      ),
      'manual',
      'pending'
    from public.bank_rates br
    where br.bank_id = v_bank_id
      and br.is_active = true
      and not exists (
        select 1 from public.rate_change_requests x
        where x.bank_rate_id = br.id and x.status = 'pending'
      )
    returning id
  )
  select array_agg(id) into v_inserted_ids from inserted;

  if v_inserted_ids is null or array_length(v_inserted_ids, 1) is null then
    raise notice 'Yapı Kredi için oluşturulacak taze pending talep yok (idempotent no-op).';
  else
    select id into v_actor_id from public.profiles where role = 'admin' order by id limit 1;

    insert into public.audit_log (actor_id, action, entity_table, entity_id, diff)
    values (
      v_actor_id,
      'rate_change_fresh_requests_created',
      'rate_change_requests',
      v_bank_id,
      jsonb_build_object(
        'bank_id', v_bank_id,
        'reason', 'Bant normalizasyonu sonrası bayatlayan talepler kapatıldıktan sonra, doğrulanmış %41,50 -> %41,00 oran değişikliği normalize edilmiş bant sınırlarıyla taze pending talepler olarak yeniden oluşturuldu. Hiçbiri otomatik onaylanmadı.',
        'created_request_ids', to_jsonb(v_inserted_ids),
        'created_count', array_length(v_inserted_ids, 1),
        'migration', '20260915120000_yapikredi_band_normalization_and_fresh_requests'
      )
    );
    raise notice 'Yapı Kredi: % taze pending talep oluşturuldu.', array_length(v_inserted_ids, 1);
  end if;
end $$;
