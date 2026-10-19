-- ==========================================================================
-- Otomatik talep oluşturma eşzamanlılık koruması + Fibabanka no-op temizliği
-- ==========================================================================
--
-- 2026-10-19 olayında admin 12 Fonlu Kiraz talebini topluca onaylarken aynı
-- anda devam eden Edge Function, onaydan ÖNCE okuduğu bank_rates görüntüsüyle
-- 6 yeni talep açtı. Bu taleplerin hedefi canlıda zaten uygulanmıştı; bu
-- nedenle approve_rate_change bunları haklı olarak "güncelliğini kaybetmiş"
-- diye reddetti.
--
-- ensure_automation_rate_change_request():
--   * hedef bank_rates satırını FOR UPDATE ile kilitler,
--   * Edge Function'ın beklediği görüntünün hâlâ canlı olduğunu doğrular,
--   * aynı değişiklik zaten uygulandıysa yeni talep açmaz,
--   * eşzamanlı kontrollerde mükerrer talebi engeller,
--   * yalnızca service_role tarafından çağrılabilir.
--
-- Alttaki DO bloğu yalnızca hedefi canlıda zaten uygulanmış, previous_data'sı
-- artık eski kalmış pending automation taleplerini audit iziyle kapatır.
-- Hiçbir oranı değiştirmez veya onaylamaz. Yeniden çalıştırılması güvenlidir.

create or replace function public.ensure_automation_rate_change_request(
  p_bank_rate_id uuid,
  p_bank_id uuid,
  p_expected_previous jsonb,
  p_proposed_data jsonb
)
returns table(outcome text, request_id uuid, live_data jsonb)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_live public.bank_rates;
  v_existing_id uuid;
  v_new_id uuid;
  v_expected_matches boolean;
  v_proposal_is_live boolean;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Bu fonksiyon yalnızca otomasyon servisi tarafından çağrılabilir.';
  end if;

  select * into v_live
  from public.bank_rates
  where id = p_bank_rate_id and bank_id = p_bank_id and is_active = true
  for update;

  if v_live.id is null then
    raise exception 'Aktif oran satırı bulunamadı: %', p_bank_rate_id;
  end if;

  v_expected_matches :=
    p_expected_previous is not null
    and p_expected_previous <> '{}'::jsonb
    and (not (p_expected_previous ? 'alt_limit') or round((p_expected_previous->>'alt_limit')::numeric, 2) = round(v_live.alt_limit, 2))
    and (not (p_expected_previous ? 'ust_limit') or round((p_expected_previous->>'ust_limit')::numeric, 2) = round(v_live.ust_limit, 2))
    and (not (p_expected_previous ? 'vadesizde_kalacak') or round((p_expected_previous->>'vadesizde_kalacak')::numeric, 2) = round(v_live.vadesizde_kalacak, 2))
    and (not (p_expected_previous ? 'yillik_brut_oran') or round((p_expected_previous->>'yillik_brut_oran')::numeric, 4) = round(v_live.yillik_brut_oran, 4))
    and (not (p_expected_previous ? 'vadesiz_hesaplama_tipi') or (p_expected_previous->>'vadesiz_hesaplama_tipi') is not distinct from v_live.vadesiz_hesaplama_tipi)
    and (not (p_expected_previous ? 'vadesiz_oran') or round(coalesce((p_expected_previous->>'vadesiz_oran')::numeric, -1), 2) = round(coalesce(v_live.vadesiz_oran, -1), 2));

  v_proposal_is_live :=
    (not (p_proposed_data ? 'alt_limit') or round((p_proposed_data->>'alt_limit')::numeric, 2) = round(v_live.alt_limit, 2))
    and (not (p_proposed_data ? 'ust_limit') or round((p_proposed_data->>'ust_limit')::numeric, 2) = round(v_live.ust_limit, 2))
    and (not (p_proposed_data ? 'vadesizde_kalacak') or round((p_proposed_data->>'vadesizde_kalacak')::numeric, 2) = round(v_live.vadesizde_kalacak, 2))
    and (not (p_proposed_data ? 'yillik_brut_oran') or round((p_proposed_data->>'yillik_brut_oran')::numeric, 4) = round(v_live.yillik_brut_oran, 4))
    and (not (p_proposed_data ? 'vadesiz_hesaplama_tipi') or (p_proposed_data->>'vadesiz_hesaplama_tipi') is not distinct from v_live.vadesiz_hesaplama_tipi)
    and (not (p_proposed_data ? 'vadesiz_oran') or round(coalesce((p_proposed_data->>'vadesiz_oran')::numeric, -1), 2) = round(coalesce(v_live.vadesiz_oran, -1), 2))
    and (not (p_proposed_data ? 'gerekli_fon_bakiyesi') or coalesce((p_proposed_data->>'gerekli_fon_bakiyesi')::numeric, -1) = coalesce(v_live.gerekli_fon_bakiyesi, -1))
    and (not (p_proposed_data ? 'note') or coalesce(p_proposed_data->>'note', '') = coalesce(v_live.note, ''));

  if not v_expected_matches then
    if v_proposal_is_live then
      return query select 'already_applied'::text, null::uuid, to_jsonb(v_live);
    else
      return query select 'stale'::text, null::uuid, to_jsonb(v_live);
    end if;
    return;
  end if;

  select r.id into v_existing_id
  from public.rate_change_requests r
  where r.bank_rate_id = p_bank_rate_id
    and r.bank_id = p_bank_id
    and r.status = 'pending'
    and r.source = 'automation'
    and r.proposed_data = p_proposed_data
    and round((r.previous_data->>'alt_limit')::numeric, 2) = round(v_live.alt_limit, 2)
    and round((r.previous_data->>'ust_limit')::numeric, 2) = round(v_live.ust_limit, 2)
    and round((r.previous_data->>'vadesizde_kalacak')::numeric, 2) = round(v_live.vadesizde_kalacak, 2)
    and round((r.previous_data->>'yillik_brut_oran')::numeric, 4) = round(v_live.yillik_brut_oran, 4)
  order by r.requested_at
  limit 1;

  if v_existing_id is not null then
    return query select 'duplicate'::text, v_existing_id, to_jsonb(v_live);
    return;
  end if;

  insert into public.rate_change_requests (
    bank_rate_id, bank_id, change_type, proposed_data, previous_data,
    requested_by, source, status
  ) values (
    p_bank_rate_id, p_bank_id, 'update', p_proposed_data, to_jsonb(v_live),
    null, 'automation', 'pending'
  ) returning id into v_new_id;

  return query select 'created'::text, v_new_id, to_jsonb(v_live);
end;
$$;

revoke all on function public.ensure_automation_rate_change_request(uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.ensure_automation_rate_change_request(uuid, uuid, jsonb, jsonb) to service_role;

do $$
declare
  v_actor_id uuid;
  v_req record;
  v_count int := 0;
  v_first_id uuid;
begin
  select id into v_actor_id from public.profiles where role = 'admin' order by id limit 1;
  if v_actor_id is null then
    raise exception 'Denetim kaydı için admin profili bulunamadı.';
  end if;

  for v_req in
    select r.id, r.bank_rate_id, r.previous_data, r.proposed_data
    from public.rate_change_requests r
    join public.banks b on b.id = r.bank_id
    join public.bank_rates br on br.id = r.bank_rate_id
    where b.name = 'Fibabanka Fonlu Kiraz'
      and r.status = 'pending'
      and r.source = 'automation'
      and round((r.proposed_data->>'alt_limit')::numeric, 2) = round(br.alt_limit, 2)
      and round((r.proposed_data->>'ust_limit')::numeric, 2) = round(br.ust_limit, 2)
      and round((r.proposed_data->>'vadesizde_kalacak')::numeric, 2) = round(br.vadesizde_kalacak, 2)
      and round((r.proposed_data->>'yillik_brut_oran')::numeric, 4) = round(br.yillik_brut_oran, 4)
      and round((r.previous_data->>'yillik_brut_oran')::numeric, 4) <> round(br.yillik_brut_oran, 4)
    order by r.requested_at
    for update of r
  loop
    update public.rate_change_requests
    set status = 'rejected',
        reviewed_by = v_actor_id,
        reviewed_at = now(),
        review_note = 'Bu talebin hedef oranı, aynı anda tamamlanan gerçek toplu onayla canlıya zaten uygulanmıştı. Kontrolün eski görüntüsünden doğan bayat/no-op talep oran değiştirilmeden kapatıldı.'
    where id = v_req.id;

    insert into public.audit_log(actor_id, action, entity_table, entity_id, diff)
    values (
      v_actor_id,
      'rate_change_rejected_already_applied',
      'rate_change_requests',
      v_req.id,
      jsonb_build_object(
        'bank_rate_id', v_req.bank_rate_id,
        'previous_data', v_req.previous_data,
        'proposed_data', v_req.proposed_data,
        'reason', 'Kontrol ve admin onayı eşzamanlı yürürken eski görüntüden üretilen talebin hedefi canlıda zaten uygulanmıştı; no-op talep kapatıldı.',
        'migration', '20261019120000_rate_change_race_guard_and_cleanup'
      )
    );

    v_count := v_count + 1;
    v_first_id := coalesce(v_first_id, v_req.id);
  end loop;

  if v_count > 0 then
    insert into public.audit_log(actor_id, action, entity_table, entity_id, diff)
    values (
      v_actor_id,
      'stale_applied_requests_cleaned',
      'rate_change_requests',
      v_first_id,
      jsonb_build_object(
        'count', v_count,
        'bank_name', 'Fibabanka Fonlu Kiraz',
        'rates_changed', false,
        'migration', '20261019120000_rate_change_race_guard_and_cleanup'
      )
    );
  end if;
end $$;
