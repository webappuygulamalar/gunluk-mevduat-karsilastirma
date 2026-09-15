-- ============================================================================
-- propose_rate_changes_bulk — admin panelindeki "Ürünler ve Aktif Oran
-- Aralıkları" bölümünde banka başına toplu "Yeni Oran" girişinin TEK yazma
-- yolu.
-- ============================================================================
--
-- Amaç: bir bankanın birden çok bandı için tek seferde, yalnızca oranı
-- değişen bantlar için pending rate_change_requests satırı açmak — ama
-- approve_rate_change/approve_rate_changes_bulk'un aksine buradaki her satır
-- CANLI bank_rates verisinden türetilir (istemci previous_data GÖNDERMEZ,
-- yalnızca "değişikliği tetikleyen anda ekranda gördüğü oranı" ve "yeni
-- oranı" gönderir) — böylece previous_data her zaman gerçekten güncel olur.
--
-- Güvenlik/atomiklik tasarımı:
--   - SECURITY DEFINER + is_admin() kontrolü: yalnızca admin çağırabilir.
--   - Tüm bank_rate_id'ler İŞLEM BAŞINDA, artan id sırasıyla (deadlock
--     riskini azaltmak için) FOR UPDATE ile kilitlenir.
--   - Herhangi bir bant zaten "pending" bir talebe sahipse (bu partide veya
--     daha önceden), TÜM İŞLEM insert'e geçmeden reddedilir — kısmi/yarım
--     sonuç yoktur.
--   - Her bant için: aktif mi, yeni oran 0-1 aralığında mı (0%-100%), ve en
--     önemlisi CANLI oran, istemcinin "expected_yillik_brut_oran" ile
--     eşleşiyor mu (bayat veri koruması — sayfa açıldıktan sonra oran
--     başka biri tarafından değiştirilmişse talep reddedilir) doğrulanır.
--   - PL/pgSQL fonksiyon çağrısı Postgres'te doğası gereği tek bir
--     alt-işlemdir: herhangi bir bantta RAISE EXCEPTION olursa, o ana kadar
--     bu çağrı içinde eklenen TÜM satırlar (varsa) geri alınır.
--   - alt_limit, ust_limit, vadesizde_kalacak, note, gerekli_fon_bakiyesi,
--     vadesiz_hesaplama_tipi, vadesiz_oran CANLI satırdan AYNEN kopyalanır;
--     yalnızca yillik_brut_oran değişir.
--   - Tek bir audit_log özet kaydı (bulk_propose_rate_changes) oluşturulur.
--   - service_role veya başka bir gizli anahtar burada YOKTUR; istemci
--     yalnızca anon/publishable key ile bu RPC'yi authenticated olarak
--     çağırır, gerçek yetki kontrolü is_admin() ile veritabanı tarafında
--     yapılır.
create or replace function public.propose_rate_changes_bulk(p_items jsonb)
returns setof public.rate_change_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_admin_id      uuid;
  v_ids           uuid[];
  v_created_ids   uuid[] := array[]::uuid[];
  v_new_request_id uuid;
  v_bulk_marker   uuid := gen_random_uuid();
  v_item          jsonb;
  v_bank_rate_id  uuid;
  v_expected_oran numeric;
  v_new_oran      numeric;
  v_live          public.bank_rates;
  v_bank_name     text;
begin
  if not public.is_admin() then
    raise exception 'Bu işlemi yalnızca admin rolündeki kullanıcılar yapabilir.';
  end if;
  v_admin_id := auth.uid();

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'İşlem için en az bir bant gönderilmelidir.';
  end if;

  select array_agg(distinct (elem->>'bank_rate_id')::uuid)
    into v_ids
  from jsonb_array_elements(p_items) elem;

  if v_ids is null or array_length(v_ids, 1) is null or array_length(v_ids, 1) <> jsonb_array_length(p_items) then
    raise exception 'Aynı bant için birden fazla satır gönderildi veya bant kimliği eksik.';
  end if;

  -- Deadlock riskini azaltmak için artan id sırasıyla kilitle.
  perform 1 from public.bank_rates where id = any(v_ids) order by id for update;

  -- Bu partiden ÖNCE zaten pending olan herhangi bir bant varsa (mükerrer
  -- gönderim, iki farklı sekme, vb.) tüm işlem insert'e geçmeden reddedilir.
  if exists (
    select 1 from public.rate_change_requests
    where bank_rate_id = any(v_ids) and status = 'pending'
  ) then
    raise exception 'Seçilen bantlardan biri için zaten onay bekleyen bir talep var. Sayfayı yenileyip tekrar deneyin.';
  end if;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_bank_rate_id  := nullif(v_item->>'bank_rate_id', '')::uuid;
    v_expected_oran := nullif(v_item->>'expected_yillik_brut_oran', '')::numeric;
    v_new_oran      := nullif(v_item->>'new_yillik_brut_oran', '')::numeric;

    if v_bank_rate_id is null then
      raise exception 'Geçersiz bant kimliği.';
    end if;

    select * into v_live from public.bank_rates where id = v_bank_rate_id;
    select name into v_bank_name from public.banks where id = v_live.bank_id;
    v_bank_name := coalesce(v_bank_name, 'Bilinmeyen banka');

    if v_live.id is null or v_live.is_active is not true then
      raise exception '% bandı artık aktif değil veya bulunamadı.', v_bank_name;
    end if;

    if v_expected_oran is null then
      raise exception '% (%–% TL) için beklenen mevcut oran gönderilmedi.', v_bank_name, v_live.alt_limit, v_live.ust_limit;
    end if;

    if round(v_live.yillik_brut_oran, 4) <> round(v_expected_oran, 4) then
      raise exception '% (%–% TL) bandının oranı sayfa yüklendikten sonra değişmiş (güncel: %%%). Sayfayı yenileyip tekrar deneyin.',
        v_bank_name, v_live.alt_limit, v_live.ust_limit, round(v_live.yillik_brut_oran * 100, 2);
    end if;

    if v_new_oran is null or v_new_oran < 0 or v_new_oran > 1 then
      raise exception '% (%–% TL) için geçersiz oran girildi.', v_bank_name, v_live.alt_limit, v_live.ust_limit;
    end if;

    if round(v_new_oran, 4) = round(v_live.yillik_brut_oran, 4) then
      raise exception '% (%–% TL) için girilen oran mevcut oranla aynı.', v_bank_name, v_live.alt_limit, v_live.ust_limit;
    end if;

    insert into public.rate_change_requests (
      bank_rate_id, bank_id, change_type, proposed_data, previous_data, requested_by, source, status
    ) values (
      v_live.id,
      v_live.bank_id,
      'update',
      jsonb_build_object(
        'alt_limit', v_live.alt_limit,
        'ust_limit', v_live.ust_limit,
        'vadesizde_kalacak', v_live.vadesizde_kalacak,
        'yillik_brut_oran', v_new_oran,
        'note', v_live.note,
        'gerekli_fon_bakiyesi', v_live.gerekli_fon_bakiyesi,
        'vadesiz_hesaplama_tipi', v_live.vadesiz_hesaplama_tipi,
        'vadesiz_oran', v_live.vadesiz_oran
      ),
      to_jsonb(v_live),
      v_admin_id,
      'manual',
      'pending'
    )
    returning id into v_new_request_id;

    v_created_ids := v_created_ids || v_new_request_id;
  end loop;

  insert into public.audit_log (actor_id, action, entity_table, entity_id, diff)
  values (
    v_admin_id,
    'bulk_propose_rate_changes',
    'rate_change_requests',
    v_bulk_marker,
    jsonb_build_object(
      'request_ids', to_jsonb(v_created_ids),
      'count', array_length(v_created_ids, 1),
      'actor', v_admin_id
    )
  );

  return query select * from public.rate_change_requests where id = any(v_created_ids);
end;
$$;

revoke all on function public.propose_rate_changes_bulk(jsonb) from public;
grant execute on function public.propose_rate_changes_bulk(jsonb) to authenticated;
