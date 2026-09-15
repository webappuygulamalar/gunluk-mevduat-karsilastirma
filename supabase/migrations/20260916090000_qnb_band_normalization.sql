-- ============================================================================
-- QNB — bant sınırı normalizasyonu (kuruş boşluğu)
-- ============================================================================
--
-- Salt okunur denetimde doğrulandı: QNB'nin TÜM 17 aktif bandı arasında
-- (0/49.999, 50.000/74.999, ... 20.000.000/29.999.999, 30.000.000/açık uçlu)
-- ardışık sınırlar arasında TAM 1,00 TL'lik bir kapsama boşluğu vardı (ör.
-- 49.999,01–49.999,99 TL hiçbir banda girmiyordu) — Yapı Kredi (20260915120000),
-- TOM Bank (20260910160000) ve Alternatifbank'ta (20260910170000) düzeltilen
-- sorunla birebir aynı kök neden: eski bant verisi hiç kuruş bazında normalize
-- edilmemişti. assert_band_integrity() doğru çalışıyor; sorun veri
-- kalitesinde.
--
-- Bu blok YALNIZCA ust_limit'i düzeltir: her bandın üst limiti, SONRAKİ
-- bandın (değiştirilmeyen) alt limitinden 0,01 TL eksiğe çekilir. Son bandın
-- (30.000.000–9.999.999.999, açık uçlu) üst limiti, sonraki bant olmadığı
-- için dokunulmaz. alt_limit, yillik_brut_oran ve vadesizde_kalacak hiçbir
-- bantta değiştirilmez — bu migration hiçbir oranı değiştirmez.
--
-- Denetimde ayrıca doğrulandı: bu migration uygulandığı anda QNB için
-- pending hiçbir rate_change_requests talebi yoktu — bu yüzden bayat talep
-- kapatma/taze talep oluşturma adımına (Yapı Kredi migration'ındaki 2. ve 3.
-- bölümler) burada gerek yok.
--
-- İdempotenttir: bantlar zaten normalize edilmişse (ikinci çalıştırma) hiçbir
-- satır güncellenmez, audit_log'a yeni bir kayıt eklenmez.
do $$
declare
  v_bank_id   uuid := '7a568622-1ad3-4083-972b-8f254b5b3900';
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
    raise notice 'QNB bant sınırları zaten normalize edilmiş — değişiklik yapılmadı (idempotent no-op).';
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
        'migration', '20260916090000_qnb_band_normalization'
      )
    );
    raise notice 'QNB: % bant sınırı normalize edildi.', v_count;
  end if;
end $$;
