-- ============================================================================
-- Toplu onay/red RPC'leri — admin panelindeki "Seçilenleri Onayla ve Yayınla"
-- / "Seçilenleri Reddet" düğmelerinin tek yazma yolu.
--
-- Tasarım: mevcut, zaten güvenliği doğrulanmış approve_rate_change /
-- reject_rate_change fonksiyonlarını TEK TEK, bir döngü içinde çağırır —
-- yeni bir yazma mantığı İCAT EDİLMEDİ. Bu sayede:
--   - Satır kilitleme (FOR UPDATE) approve_rate_change/reject_rate_change
--     içinde zaten var, tekrar yazılmadı.
--   - Her talep için audit_log kaydı, mevcut fonksiyonların kendi
--     mantığıyla, değişmeden oluşur.
--   - Atomiklik: PL/pgSQL fonksiyon çağrısı Postgres'te doğası gereği tek
--     bir alt-işlemdir — herhangi bir id için exception fırlatılırsa
--     (ör. artık "pending" değilse), o ana kadar bu fonksiyon çağrısı
--     içinde yapılan TÜM değişiklikler (önceki döngü adımları dahil) geri
--     alınır. Kısmi yayımlama YOKTUR.
--
-- Ek güvenlik: döngüden ÖNCE, seçilen id'lerin TAMAMI kilitlenip "pending"
-- olduğu doğrulanıyor — böylece geçersiz/artık pending olmayan bir id varsa
-- hiçbir satıra dokunulmadan, en baştan reddediliyor (daha öngörülebilir
-- hata mesajı; asıl atomiklik garantisi yine de yukarıdaki istisna
-- mekanizmasından geliyor).
-- ============================================================================

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
  v_admin_id     uuid;
  v_pending_count int;
  v_id           uuid;
  v_bulk_marker  uuid := gen_random_uuid();
begin
  if not public.is_admin() then
    raise exception 'Bu işlemi yalnızca admin rolündeki kullanıcılar yapabilir.';
  end if;

  v_admin_id := auth.uid();

  if p_request_ids is null or array_length(p_request_ids, 1) is null then
    raise exception 'İşlem için en az bir talep seçilmelidir.';
  end if;

  -- Seçilen satırları kilitle (FOR UPDATE aggregate ile birlikte
  -- kullanılamadığı için önce salt kilitleme, sonra ayrı sayım yapılır).
  perform 1 from public.rate_change_requests where id = any(p_request_ids) for update;

  select count(*) into v_pending_count
  from public.rate_change_requests
  where id = any(p_request_ids) and status = 'pending';

  if v_pending_count <> array_length(p_request_ids, 1) then
    raise exception 'Seçilen taleplerden biri veya birden fazlası artık "pending" durumunda değil (silinmiş, ya da başka bir işlemle zaten karara bağlanmış olabilir) — hiçbir talep işlenmedi.';
  end if;

  foreach v_id in array p_request_ids loop
    perform public.approve_rate_change(v_id, p_review_note);
  end loop;

  insert into public.audit_log (actor_id, action, entity_table, entity_id, diff)
  values (
    v_admin_id,
    'bulk_approve_rate_changes',
    'rate_change_requests',
    v_bulk_marker,
    jsonb_build_object(
      'request_ids', to_jsonb(p_request_ids),
      'count', array_length(p_request_ids, 1),
      'actor', v_admin_id,
      'review_note', p_review_note
    )
  );

  return query select * from public.rate_change_requests where id = any(p_request_ids);
end;
$$;

create or replace function public.reject_rate_changes_bulk(
  p_request_ids uuid[],
  p_review_note text default null
)
returns setof public.rate_change_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_admin_id     uuid;
  v_pending_count int;
  v_id           uuid;
  v_bulk_marker  uuid := gen_random_uuid();
begin
  if not public.is_admin() then
    raise exception 'Bu işlemi yalnızca admin rolündeki kullanıcılar yapabilir.';
  end if;

  v_admin_id := auth.uid();

  if p_request_ids is null or array_length(p_request_ids, 1) is null then
    raise exception 'İşlem için en az bir talep seçilmelidir.';
  end if;

  perform 1 from public.rate_change_requests where id = any(p_request_ids) for update;

  select count(*) into v_pending_count
  from public.rate_change_requests
  where id = any(p_request_ids) and status = 'pending';

  if v_pending_count <> array_length(p_request_ids, 1) then
    raise exception 'Seçilen taleplerden biri veya birden fazlası artık "pending" durumunda değil (silinmiş, ya da başka bir işlemle zaten karara bağlanmış olabilir) — hiçbir talep işlenmedi.';
  end if;

  foreach v_id in array p_request_ids loop
    perform public.reject_rate_change(v_id, p_review_note);
  end loop;

  insert into public.audit_log (actor_id, action, entity_table, entity_id, diff)
  values (
    v_admin_id,
    'bulk_reject_rate_changes',
    'rate_change_requests',
    v_bulk_marker,
    jsonb_build_object(
      'request_ids', to_jsonb(p_request_ids),
      'count', array_length(p_request_ids, 1),
      'actor', v_admin_id,
      'review_note', p_review_note
    )
  );

  return query select * from public.rate_change_requests where id = any(p_request_ids);
end;
$$;

revoke all on function public.approve_rate_changes_bulk(uuid[], text) from public;
revoke all on function public.reject_rate_changes_bulk(uuid[], text) from public;
grant execute on function public.approve_rate_changes_bulk(uuid[], text) to authenticated;
grant execute on function public.reject_rate_changes_bulk(uuid[], text) to authenticated;
