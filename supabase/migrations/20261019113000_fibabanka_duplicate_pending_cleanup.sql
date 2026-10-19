-- ============================================================================
-- Fibabanka Kiraz ürünleri — migration/parser talep biçimi uyumsuzluğu temizliği
-- ============================================================================
--
-- 20261019110000 migration'ı bantları doğru biçimde normalize edip eski
-- talepleri kapattı; ancak taze taleplerde `note` alanını canlı bank_rate
-- kaydından korudu. Edge Function ise resmî tablodan seçilen oran koşulunu
-- `note` alanına yazar. Bu yüzden ilk gerçek kontrol, oran/bantları aynı olsa
-- bile bu talepleri kanonik JSON karşılaştırmasında farklı görüp 24 mükerrer
-- talep oluşturdu.
--
-- Bu migration yalnızca 20261019110000 audit kaydında açıkça listelenen
-- migration-kökenli talep ID'lerini kapatır. Edge Function'ın oluşturduğu,
-- resmî oran koşulunu taşıyan 12+12 talep pending kalır. Hiçbir oran
-- yayımlanmaz. Yeniden çalıştırılması güvenlidir.

do $$
declare
  v_actor_id uuid;
  v_request_id uuid;
  v_summary_entity_id uuid;
  v_rejected_count int := 0;
  v_bad_count int;
begin
  select id into v_actor_id
  from public.profiles
  where role = 'admin'
  order by id
  limit 1;

  if v_actor_id is null then
    raise exception 'Denetim kaydı için admin profili bulunamadı.';
  end if;

  -- Yalnızca önceki migration'ın kendi audit kaydında oluşturduğunu beyan
  -- ettiği talep ID'leri hedeflenir; sonradan Edge Function'ın açtığı taze
  -- taleplere veya başka bankalara dokunulmaz.
  for v_request_id in
    select distinct (jsonb_array_elements_text(al.diff->'created_request_ids'))::uuid
    from public.audit_log al
    where al.action = 'rate_change_fresh_requests_created'
      and al.diff->>'migration' = '20261019110000_fibabanka_band_normalization'
  loop
    update public.rate_change_requests
    set status = 'rejected',
        reviewed_by = v_actor_id,
        reviewed_at = now(),
        review_note = 'Bant ve oran doğruydu; ancak ilk normalizasyon migration''ı resmî oran koşulu notunu kanonik biçimde taşımadığı için Edge Function aynı değişikliği yeniden oluşturdu. Mükerrer migration talebi oran yayımlanmadan kapatıldı; parser-kökenli temiz talep pending bırakıldı.'
    where id = v_request_id
      and status = 'pending';

    if found then
      v_rejected_count := v_rejected_count + 1;
      v_summary_entity_id := coalesce(v_summary_entity_id, v_request_id);

      insert into public.audit_log (actor_id, action, entity_table, entity_id, diff)
      values (
        v_actor_id,
        'rate_change_rejected_duplicate',
        'rate_change_requests',
        v_request_id,
        jsonb_build_object(
          'reason', 'Migration ve Edge Function teklifleri arasındaki note alanı kanonikleştirme farkından doğan mükerrer talep kapatıldı; oran yayımlanmadı.',
          'source_migration', '20261019110000_fibabanka_band_normalization',
          'cleanup_migration', '20261019113000_fibabanka_duplicate_pending_cleanup'
        )
      );
    end if;
  end loop;

  -- Temizlik sonrasında her iki üründe de her aktif bant için tam bir adet
  -- pending automation talebi kalmalı: toplam 12'şer, mükerrer yok.
  select count(*) into v_bad_count
  from (
    select br.id
    from public.bank_rates br
    join public.banks b on b.id = br.bank_id
    left join public.rate_change_requests rcr
      on rcr.bank_rate_id = br.id
     and rcr.status = 'pending'
     and rcr.source = 'automation'
    where b.name in ('Fibabanka Fonlu Kiraz', 'Fibabanka Kiraz Hoş Geldin')
      and br.is_active = true
    group by br.id
    having count(rcr.id) <> 1
  ) bad;

  if v_bad_count <> 0 then
    raise exception 'Fibabanka mükerrer temizliği sonrasında % bantta pending talep sayısı 1 değil.', v_bad_count;
  end if;

  if (
    select count(*)
    from public.rate_change_requests rcr
    join public.banks b on b.id = rcr.bank_id
    where b.name in ('Fibabanka Fonlu Kiraz', 'Fibabanka Kiraz Hoş Geldin')
      and rcr.status = 'pending'
      and rcr.source = 'automation'
  ) <> 24 then
    raise exception 'Fibabanka için temizlik sonrası toplam 24 pending automation talebi bekleniyordu.';
  end if;

  if v_rejected_count > 0 then
    insert into public.audit_log (actor_id, action, entity_table, entity_id, diff)
    values (
      v_actor_id,
      'duplicate_rate_change_requests_cleaned',
      'rate_change_requests',
      v_summary_entity_id,
      jsonb_build_object(
        'rejected_duplicate_count', v_rejected_count,
        'remaining_pending_count', 24,
        'reason', 'Migration-kökenli ve parser-kökenli aynı oran değişiklikleri arasındaki note alanı biçim farkı temizlendi.',
        'migration', '20261019113000_fibabanka_duplicate_pending_cleanup'
      )
    );
  end if;
end $$;
