-- ============================================================================
-- 1) Alternatifbank VOV Hesap — bant sınırı normalizasyonu (kuruş boşluğu)
-- ============================================================================
--
-- Denetimde doğrulandı: Alternatifbank'ın TÜM 12 aktif bandı, resmi kaynak
-- sayfasının "x - x+1" tam sayı kalıbını (ör. "20.000 - 250.000" /
-- "250.001 - 500.000") olduğu gibi saklıyordu. Uygulamanın kuruş hassasiyetli
-- bant modelinde bu, her ardışık sınırda 1 TL'lik bir kapsama boşluğu
-- (ör. 250.000,01–250.000,99 TL) yaratıyordu — TOM Bank'ta düzeltilen sorunun
-- aynısı, ama tek bantta değil ürünün TAMAMINDA.
--
-- Bu blok YALNIZCA alt_limit'i düzeltir. ust_limit, yillik_brut_oran ve
-- vadesizde_kalacak DEĞİŞTİRİLMEZ — bunlar resmi tablodaki karşılıklarıyla
-- birebir aynı kalır. İlk bandın alt limiti (20.000) ve son bandın açık uçlu
-- üst sınırı (9999999999) zaten resmi tabloyla uyumlu olduğundan dokunulmaz.
--
-- İdempotenttir: bantlar zaten normalize edilmişse (ikinci çalıştırma) hiçbir
-- satır güncellenmez, audit_log'a yeni bir kayıt eklenmez.
do $$
declare
  v_bank_id   uuid := '64028469-064b-4ef8-b7f8-aa34fec97d89';
  v_actor_id  uuid;
  v_changes   jsonb := '[]'::jsonb;
  v_row       record;
  v_before    numeric;
  v_after     numeric;
  v_count     int := 0;
begin
  select id into v_actor_id from public.profiles where role = 'admin' order by id limit 1;
  if v_actor_id is null then
    raise exception 'Denetim kaydı için admin profili bulunamadı.';
  end if;

  for v_row in
    select id, alt_limit, ust_limit,
           lag(ust_limit) over (order by alt_limit) as prev_ust
    from public.bank_rates
    where bank_id = v_bank_id and is_active = true
    order by alt_limit
  loop
    if v_row.prev_ust is not null and round(v_row.alt_limit - v_row.prev_ust, 2) = 1.00 then
      v_before := v_row.alt_limit;
      v_after  := round(v_row.prev_ust + 0.01, 2);

      update public.bank_rates set alt_limit = v_after where id = v_row.id;

      v_changes := v_changes || jsonb_build_object(
        'bank_rate_id', v_row.id,
        'old_alt_limit', v_before,
        'new_alt_limit', v_after,
        'ust_limit', v_row.ust_limit
      );
      v_count := v_count + 1;
    end if;
  end loop;

  if v_count = 0 then
    raise notice 'Alternatifbank bant sınırları zaten normalize edilmiş — değişiklik yapılmadı (idempotent no-op).';
  else
    insert into public.audit_log (actor_id, action, entity_table, entity_id, diff)
    values (
      v_actor_id,
      'band_boundary_normalization',
      'bank_rates',
      v_bank_id,
      jsonb_build_object(
        'bank_id', v_bank_id,
        'reason', 'TL kuruşlarında kapsama boşluğu oluşmaması için ardışık bant sınırları kuruş bazında bitiştirildi (resmi kaynağın "x TL / x+1 TL" kalıbı yerine "x TL / x,01 TL" olarak normalize edildi). Üst sınırlar, oranlar ve vadesizde kalacak tutarlar değiştirilmedi.',
        'changed_band_count', v_count,
        'changes', v_changes,
        'migration', '20260910170000_alternatifbank_band_normalization'
      )
    );
    raise notice 'Alternatifbank: % bant sınırı normalize edildi.', v_count;
  end if;
end $$;

-- ============================================================================
-- 2) Eski 9 pending talebin bayat/rejected olarak kapatılması
-- ============================================================================
--
-- Bant sınırları değiştiği için bu taleplerin previous_data'sı (eski
-- alt_limit'e dayanıyordu) artık canlı satırla eşleşmiyor — approve_rate_change
-- zaten bunları "güncelliğini kaybetmiş" diye reddederdi (bkz.
-- 20260910160000_tom_bank_gap_fix_and_stale_guard.sql). Burada bu durum
-- AÇIKÇA ve KALICI olarak kayda geçiriliyor: talepler 'rejected' durumuna
-- getiriliyor (bank_rates'e HİÇBİR ŞEY uygulanmadan — oranlar canlıya
-- yansıtılmıyor), her biri için ayrı bir audit_log kaydı açılıyor. Talebin
-- kendisi silinmiyor; yalnızca durumu ve inceleme notu güncelleniyor.
--
-- İdempotenttir: ikinci çalıştırmada bu taleplerin hepsi zaten 'pending'
-- olmadığından döngü hiçbir satıra dokunmaz.
do $$
declare
  v_bank_id  uuid := '64028469-064b-4ef8-b7f8-aa34fec97d89';
  v_actor_id uuid;
  v_reason   text := 'Bant sınırları kuruş bazında normalize edildiği için eski talep geçersiz kaldı; güncel kaynak verisiyle yeni talep oluşturulacak.';
  v_req      record;
  v_count    int := 0;
begin
  select id into v_actor_id from public.profiles where role = 'admin' order by id limit 1;
  if v_actor_id is null then
    raise exception 'Denetim kaydı için admin profili bulunamadı.';
  end if;

  for v_req in
    select rcr.id, rcr.bank_rate_id, rcr.proposed_data, rcr.previous_data
    from public.rate_change_requests rcr
    join public.bank_rates br on br.id = rcr.bank_rate_id
    where rcr.status = 'pending' and br.bank_id = v_bank_id
    for update of rcr
  loop
    update public.rate_change_requests
      set status      = 'rejected',
          reviewed_by = v_actor_id,
          reviewed_at = now(),
          review_note = v_reason
      where id = v_req.id;

    insert into public.audit_log (actor_id, action, entity_table, entity_id, diff)
    values (
      v_actor_id,
      'rate_change_rejected_stale',
      'rate_change_requests',
      v_req.id,
      jsonb_build_object(
        'reason', v_reason,
        'bank_rate_id', v_req.bank_rate_id,
        'proposed_data', v_req.proposed_data,
        'previous_data', v_req.previous_data,
        'migration', '20260910170000_alternatifbank_band_normalization'
      )
    );
    v_count := v_count + 1;
  end loop;

  if v_count = 0 then
    raise notice 'Alternatifbank için bayatlatılacak pending talep bulunamadı (idempotent no-op).';
  else
    raise notice 'Alternatifbank: % eski pending talep bayat/rejected olarak kapatıldı.', v_count;
  end if;
end $$;
