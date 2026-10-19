-- ==========================================================================
-- Yapısal bant değişiklikleri için atomik toplu onay
-- ==========================================================================
-- Tek bir sınır taşındığında iki komşu bant birlikte değişir. Talepleri tek
-- tek doğrulamak, ilk geçici adımda kaçınılmaz bir boşluk/çakışma gördüğü
-- için güvenli bir nihai kümeyi dahi reddeder. Bu sürüm seçili taleplerin
-- tamamını tek transaction içinde uygular, SONRA her etkilenen ürünün nihai
-- bant kümesini assert_band_integrity ile doğrular. Herhangi bir hata bütün
-- batch'i geri alır. Tekli approve_rate_change davranışı değişmez.

create or replace function public.approve_rate_changes_bulk(
  p_request_ids uuid[],
  p_review_note text default null
)
returns setof public.rate_change_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_admin_id uuid;
  v_pending_count int;
  v_id uuid;
  v_request public.rate_change_requests;
  v_live public.bank_rates;
  v_rate_id uuid;
  v_old_data jsonb;
  v_new_alt numeric;
  v_new_ust numeric;
  v_new_vk numeric;
  v_new_vtipi text;
  v_bank_id uuid;
  v_bulk_marker uuid := gen_random_uuid();
begin
  if not public.is_admin() then
    raise exception 'Bu işlemi yalnızca admin rolündeki kullanıcılar yapabilir.';
  end if;

  v_admin_id := auth.uid();
  if p_request_ids is null or array_length(p_request_ids, 1) is null then
    raise exception 'İşlem için en az bir talep seçilmelidir.';
  end if;

  perform 1
  from public.rate_change_requests
  where id = any(p_request_ids)
  order by id
  for update;

  select count(*) into v_pending_count
  from public.rate_change_requests
  where id = any(p_request_ids) and status = 'pending';

  if v_pending_count <> array_length(p_request_ids, 1) then
    raise exception 'Seçilen taleplerden biri veya birden fazlası artık "pending" durumunda değil — hiçbir talep işlenmedi.';
  end if;

  -- İlgili canlı satırların tümünü aynı sırada kilitle; iki eşzamanlı toplu
  -- onayın birbirinin ara durumunu görmesi engellenir.
  perform 1
  from public.bank_rates br
  join public.rate_change_requests r on r.bank_rate_id = br.id
  where r.id = any(p_request_ids)
  order by br.id
  for update of br;

  foreach v_id in array p_request_ids loop
    select * into strict v_request
    from public.rate_change_requests
    where id = v_id;

    v_old_data := null;
    v_rate_id := null;

    if v_request.change_type in ('update', 'disable') then
      if v_request.previous_data is null or v_request.previous_data = '{}'::jsonb then
        raise exception 'Bu talep için beklenen mevcut değer kaydı yok; güvenli şekilde onaylanamaz.';
      end if;

      select * into v_live from public.bank_rates where id = v_request.bank_rate_id;
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
      v_new_alt := (v_request.proposed_data->>'alt_limit')::numeric;
      v_new_ust := (v_request.proposed_data->>'ust_limit')::numeric;
      v_new_vk := coalesce((v_request.proposed_data->>'vadesizde_kalacak')::numeric, 0);
      v_new_vtipi := coalesce(v_request.proposed_data->>'vadesiz_hesaplama_tipi', 'sabit');

      insert into public.bank_rates (
        bank_id, alt_limit, ust_limit, vadesizde_kalacak, yillik_brut_oran,
        note, gerekli_fon_bakiyesi, vadesiz_hesaplama_tipi, vadesiz_oran,
        is_active, updated_by
      ) values (
        v_request.bank_id, v_new_alt, v_new_ust, v_new_vk,
        (v_request.proposed_data->>'yillik_brut_oran')::numeric,
        coalesce(v_request.proposed_data->>'note', ''),
        nullif(v_request.proposed_data->>'gerekli_fon_bakiyesi', '')::numeric,
        v_new_vtipi,
        nullif(v_request.proposed_data->>'vadesiz_oran', '')::numeric,
        true, auth.uid()
      ) returning id into v_rate_id;

    elsif v_request.change_type = 'update' then
      v_old_data := to_jsonb(v_live);
      v_new_alt := coalesce((v_request.proposed_data->>'alt_limit')::numeric, v_live.alt_limit);
      v_new_ust := coalesce((v_request.proposed_data->>'ust_limit')::numeric, v_live.ust_limit);
      v_new_vk := coalesce((v_request.proposed_data->>'vadesizde_kalacak')::numeric, v_live.vadesizde_kalacak);
      v_new_vtipi := coalesce(v_request.proposed_data->>'vadesiz_hesaplama_tipi', v_live.vadesiz_hesaplama_tipi);

      update public.bank_rates set
        alt_limit = v_new_alt,
        ust_limit = v_new_ust,
        vadesizde_kalacak = v_new_vk,
        yillik_brut_oran = coalesce((v_request.proposed_data->>'yillik_brut_oran')::numeric, yillik_brut_oran),
        note = coalesce(v_request.proposed_data->>'note', note),
        gerekli_fon_bakiyesi = case
          when v_request.proposed_data ? 'gerekli_fon_bakiyesi'
            then nullif(v_request.proposed_data->>'gerekli_fon_bakiyesi', '')::numeric
          else gerekli_fon_bakiyesi end,
        vadesiz_hesaplama_tipi = v_new_vtipi,
        vadesiz_oran = case
          when v_request.proposed_data ? 'vadesiz_oran'
            then nullif(v_request.proposed_data->>'vadesiz_oran', '')::numeric
          else vadesiz_oran end,
        is_active = coalesce((v_request.proposed_data->>'is_active')::boolean, is_active),
        updated_by = auth.uid()
      where id = v_request.bank_rate_id;
      v_rate_id := v_request.bank_rate_id;

    elsif v_request.change_type = 'disable' then
      v_old_data := to_jsonb(v_live);
      update public.bank_rates set is_active = false, updated_by = auth.uid()
      where id = v_request.bank_rate_id;
      v_rate_id := v_request.bank_rate_id;
    else
      raise exception 'Bilinmeyen change_type: %', v_request.change_type;
    end if;

    update public.rate_change_requests
    set status = 'approved', reviewed_by = auth.uid(), reviewed_at = now(), review_note = p_review_note
    where id = v_id;

    insert into public.audit_log(actor_id, action, entity_table, entity_id, diff)
    values (
      auth.uid(), 'rate_change_approved', 'bank_rates', v_rate_id,
      jsonb_build_object(
        'request_id', v_id,
        'change_type', v_request.change_type,
        'before', v_old_data,
        'after', v_request.proposed_data,
        'approval_mode', 'atomic_bulk'
      )
    );
  end loop;

  -- Ara adımlar değil, seçili taleplerin tamamından sonraki NİHAİ küme
  -- doğrulanır. Hata bütün transaction'ı ve audit satırlarını geri alır.
  for v_bank_id in
    select distinct bank_id
    from public.rate_change_requests
    where id = any(p_request_ids)
  loop
    perform public.assert_band_integrity(v_bank_id, null, 'validate', null, null, null, null);
  end loop;

  insert into public.audit_log(actor_id, action, entity_table, entity_id, diff)
  values (
    v_admin_id, 'bulk_approve_rate_changes', 'rate_change_requests', v_bulk_marker,
    jsonb_build_object(
      'request_ids', to_jsonb(p_request_ids),
      'count', array_length(p_request_ids, 1),
      'actor', v_admin_id,
      'review_note', p_review_note,
      'integrity_validation', 'final_state_atomic'
    )
  );

  return query select * from public.rate_change_requests where id = any(p_request_ids);
end;
$$;

revoke all on function public.approve_rate_changes_bulk(uuid[], text) from public;
grant execute on function public.approve_rate_changes_bulk(uuid[], text) to authenticated;
