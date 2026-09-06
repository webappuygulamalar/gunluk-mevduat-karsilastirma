-- ============================================================================
-- Günlük Mevduat Karşılaştırma — Supabase başlangıç şeması
-- Kapsam: SUPABASE_GECIS_PLANI.md içindeki mimarinin ilk kurulumu.
--
-- Bu migration:
--   1) profiles / banks / bank_rates / rate_change_requests / audit_log
--      tablolarını, ilgili indeksleri ve check kısıtlarını oluşturur.
--   2) Ziyaretçilerin (anon) yalnızca is_active=true olan oranları
--      okuyabilmesini sağlayan RLS politikalarını kurar.
--   3) bank_rates tablosuna DOĞRUDAN yazmayı (insert/update/delete) hem
--      RLS hem de tablo yetkisi (GRANT) seviyesinde tamamen kapatır;
--      tek yazma yolu approve_rate_change / reject_rate_change RPC'leridir.
--   4) İlk admin kullanıcısının nasıl tanımlanacağını NOT bloklarıyla
--      açıklar (kod içinde e-posta/şifre YOKTUR).
--
-- Bu dosya data/banks.json içeriğini AKTARMAZ — sadece şemayı kurar.
-- Bu dosya web uygulamasını (app.js/index.html/sw.js) Supabase'e BAĞLAMAZ.
--
-- Not: Planda "not" olarak adlandırılan sütun burada "note" olarak
-- oluşturuldu, çünkü NOT, PostgreSQL'de ayrılmış (reserved) bir anahtar
-- kelimedir ve sütun adı olarak kullanılması her sorguda tırnaklama
-- gerektirip hataya açık hale getirir. Anlamı ve içeriği planla aynıdır.
-- ============================================================================

create extension if not exists pgcrypto;

grant usage on schema public to anon, authenticated;

-- ----------------------------------------------------------------------------
-- 1) TABLOLAR
-- ----------------------------------------------------------------------------

-- profiles: auth.users ile bire bir eşleşen yetki/rol bilgisi.
create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text not null,
  role       text not null default 'viewer' check (role in ('admin', 'editor', 'viewer')),
  created_at timestamptz not null default now()
);

comment on table public.profiles is 'auth.users genişletmesi: rol bilgisi (admin/editor/viewer).';

-- banks: banka/ürün tanımı (banka adı tekrar etmesin diye normalize edilmiş).
create table if not exists public.banks (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  is_pinned  boolean not null default false,
  sort_order int not null default 0,
  is_enabled boolean not null default true,
  created_at timestamptz not null default now()
);

comment on table public.banks is 'Banka/ürün tanımları. data/banks.json içindeki "banka" alanının normalize hali.';

-- bank_rates: yayında olan (onaylı) oran bantları — data/banks.json satırlarının karşılığı.
create table if not exists public.bank_rates (
  id                    uuid primary key default gen_random_uuid(),
  bank_id               uuid not null references public.banks (id) on delete restrict,
  alt_limit             numeric not null check (alt_limit >= 0),
  ust_limit             numeric not null,
  vadesizde_kalacak     numeric not null check (vadesizde_kalacak >= 0),
  yillik_brut_oran      numeric not null check (yillik_brut_oran >= 0),
  note                  text not null default '',
  gerekli_fon_bakiyesi  numeric,
  is_active             boolean not null default true,
  effective_from        timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  updated_by            uuid references public.profiles (id) on delete set null,
  constraint bank_rates_limit_order check (ust_limit >= alt_limit)
);

comment on table public.bank_rates is 'Aktif/onaylı oran bantları. Doğrudan insert/update/delete kapalıdır; tek yazma yolu approve_rate_change RPC''sidir.';

-- rate_change_requests: onay bekleyen (veya sonuçlanmış) oran değişiklik talepleri.
create table if not exists public.rate_change_requests (
  id             uuid primary key default gen_random_uuid(),
  bank_rate_id   uuid references public.bank_rates (id) on delete restrict,
  bank_id        uuid not null references public.banks (id) on delete restrict,
  change_type    text not null check (change_type in ('create', 'update', 'disable')),
  proposed_data  jsonb not null,
  previous_data  jsonb,
  status         text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  requested_by   uuid not null references public.profiles (id) on delete restrict,
  reviewed_by    uuid references public.profiles (id) on delete set null,
  requested_at   timestamptz not null default now(),
  reviewed_at    timestamptz,
  review_note    text,
  constraint rate_change_requests_bank_rate_required
    check (change_type = 'create' or bank_rate_id is not null)
);

comment on table public.rate_change_requests is 'Editörlerin önerdiği, adminin approve/reject RPC''leriyle karara bağladığı değişiklik kuyruğu.';

-- audit_log: kalıcı, sadece eklenebilir (append-only) denetim izi.
create table if not exists public.audit_log (
  id           uuid primary key default gen_random_uuid(),
  actor_id     uuid not null references public.profiles (id) on delete restrict,
  action       text not null,
  entity_table text not null,
  entity_id    uuid not null,
  diff         jsonb,
  created_at   timestamptz not null default now()
);

comment on table public.audit_log is 'Sadece RPC/trigger tarafından yazılan, silinemeyen denetim kaydı.';

-- ----------------------------------------------------------------------------
-- 2) İNDEKSLER
-- ----------------------------------------------------------------------------

create index if not exists idx_banks_is_enabled on public.banks (is_enabled);

create index if not exists idx_bank_rates_bank_id on public.bank_rates (bank_id);
create index if not exists idx_bank_rates_active_by_bank
  on public.bank_rates (bank_id, alt_limit, ust_limit)
  where is_active = true;

create index if not exists idx_rate_change_requests_status on public.rate_change_requests (status);
create index if not exists idx_rate_change_requests_bank_id on public.rate_change_requests (bank_id);
create index if not exists idx_rate_change_requests_requested_by on public.rate_change_requests (requested_by);

create index if not exists idx_audit_log_entity on public.audit_log (entity_table, entity_id);
create index if not exists idx_audit_log_actor on public.audit_log (actor_id);
create index if not exists idx_audit_log_created_at on public.audit_log (created_at desc);

create index if not exists idx_profiles_role on public.profiles (role);

-- ----------------------------------------------------------------------------
-- 3) YARDIMCI FONKSİYONLAR (RLS politikalarında kullanılacak)
--
-- SECURITY DEFINER + sabit search_path: fonksiyonlar tablo sahibi (postgres)
-- yetkisiyle çalışır ve arama yolu (search_path) kilitlenerek olası şema
-- enjeksiyonu engellenir. profiles tablosunu okurken kendi RLS'ine takılmazlar
-- (sahip olarak RLS'i atlarlar), bu yüzden politika içinde döngüye girmezler.
-- ----------------------------------------------------------------------------

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and role = 'admin'
  );
$$;

create or replace function public.has_role(p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and role = any(p_roles)
  );
$$;

revoke all on function public.is_admin() from public;
revoke all on function public.has_role(text[]) from public;

-- Not: anon rolüne de EXECUTE veriliyor çünkü "banks"/"bank_rates" SELECT
-- politikaları "... or public.is_admin()" şeklinde; Postgres OR ifadesinde
-- değerlendirme sırasını garanti etmediğinden, pasif (is_enabled/is_active
-- = false) bir satırla karşılaşan ziyaretçi (anon) oturumunda is_admin()
-- çağrılabilir. auth.uid() anon için NULL döneceğinden fonksiyon güvenle
-- false sonucu üretir; sadece bu satırı çalıştırılabilir kılmak yeterlidir.
grant execute on function public.is_admin() to anon, authenticated;
grant execute on function public.has_role(text[]) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- 4) YENİ KULLANICI İÇİN OTOMATİK PROFİL OLUŞTURMA
--
-- Yeni bir auth.users kaydı oluştuğunda (ör. Supabase Dashboard'dan davet
-- edildiğinde) otomatik olarak role='viewer' ile bir profiles satırı açılır.
-- İlk admin bu satırın rolünü sonradan yükseltir (bkz. SUPABASE_KURULUM_REHBERI.md).
-- ----------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, email, role)
  values (new.id, new.email, 'viewer')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- bank_rates.updated_at otomatik güncellensin (RPC dışında elle bir UPDATE
-- çalıştırılırsa bile tutarlılık korunsun diye ek güvence).
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_bank_rates_updated_at on public.bank_rates;
create trigger trg_bank_rates_updated_at
  before update on public.bank_rates
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 5) RLS'İ ETKİNLEŞTİR
-- ----------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.banks enable row level security;
alter table public.bank_rates enable row level security;
alter table public.rate_change_requests enable row level security;
alter table public.audit_log enable row level security;

-- ----------------------------------------------------------------------------
-- 6) TABLO YETKİLERİ (GRANT/REVOKE) — RLS'e ek savunma katmanı.
--
-- Supabase, public şemasında yeni oluşturulan tablolara varsayılan olarak
-- anon/authenticated rollerine geniş yetkiler (select/insert/update/delete)
-- otomatik verir. Önce beş tablonun tamamında bu varsayılan yetkiler geri
-- alınıp temiz bir sayfa açılıyor, ardından her tabloya SADECE gerekli
-- yetki tek tek veriliyor. Böylece bank_rates, rate_change_requests
-- (update/delete) ve audit_log için hiçbir rol doğrudan yazamaz; RLS
-- politikası yanlışlıkla gevşetilse bile veritabanı yetki katmanı da
-- doğrudan yazmayı engeller. Gerçek yazma işlemleri yalnızca SECURITY
-- DEFINER RPC fonksiyonları (postgres sahipliğinde, RLS'i tablo sahibi
-- olarak atlayan) üzerinden yapılır.
-- ----------------------------------------------------------------------------

revoke all on public.profiles, public.banks, public.bank_rates,
  public.rate_change_requests, public.audit_log
  from anon, authenticated;

-- profiles: satırlar yalnızca trigger ile (owner olarak) oluşturulur; kimse doğrudan insert/delete yapamaz.
grant select, update on public.profiles to authenticated;

-- banks: herkes okuyabilir (RLS ile filtrelenir); yazma sadece admin'e (RLS ile) açık.
grant select on public.banks to anon, authenticated;
grant insert, update, delete on public.banks to authenticated;

-- bank_rates: herkes okuyabilir (RLS ile filtrelenir); insert/update/delete yetkisi hiçbir role verilmez.
grant select on public.bank_rates to anon, authenticated;

-- rate_change_requests: editor/admin talep açabilir (insert); durum değişimi sadece RPC ile (update/delete yetkisi yok).
grant select, insert on public.rate_change_requests to authenticated;

-- audit_log: sadece admin okur (RLS ile); insert/update/delete yetkisi hiçbir role verilmez.
grant select on public.audit_log to authenticated;

-- ----------------------------------------------------------------------------
-- 7) RLS POLİTİKALARI
-- ----------------------------------------------------------------------------

-- profiles -----------------------------------------------------------------
drop policy if exists "profiles_select_self_or_admin" on public.profiles;
create policy "profiles_select_self_or_admin"
  on public.profiles for select
  to authenticated
  using (id = auth.uid() or public.is_admin());

drop policy if exists "profiles_update_admin_only" on public.profiles;
create policy "profiles_update_admin_only"
  on public.profiles for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- banks ----------------------------------------------------------------------
drop policy if exists "banks_select_public_enabled" on public.banks;
create policy "banks_select_public_enabled"
  on public.banks for select
  to anon, authenticated
  using (is_enabled = true or public.is_admin());

drop policy if exists "banks_write_admin_only" on public.banks;
create policy "banks_write_admin_only"
  on public.banks for insert
  to authenticated
  with check (public.is_admin());

drop policy if exists "banks_update_admin_only" on public.banks;
create policy "banks_update_admin_only"
  on public.banks for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "banks_delete_admin_only" on public.banks;
create policy "banks_delete_admin_only"
  on public.banks for delete
  to authenticated
  using (public.is_admin());

-- bank_rates -------------------------------------------------------------------
-- Ziyaretçiler (anon) DAHİL herkes yalnızca aktif oranı, aktif bankaya bağlıysa görebilir.
drop policy if exists "bank_rates_select_active_only" on public.bank_rates;
create policy "bank_rates_select_active_only"
  on public.bank_rates for select
  to anon, authenticated
  using (
    (
      is_active = true
      and exists (
        select 1 from public.banks b
        where b.id = bank_rates.bank_id and b.is_enabled = true
      )
    )
    or public.is_admin()
  );

-- Kasıtlı olarak: bank_rates için insert/update/delete politikası YOK.
-- Tablo yetkisi zaten yukarıda (bölüm 6) tüm rollerden alınmıştı; bu yüzden
-- approve_rate_change/reject_rate_change RPC'leri dışında hiçbir yol
-- (admin dahil) bu tabloya doğrudan yazamaz.

-- rate_change_requests -----------------------------------------------------------
drop policy if exists "rcr_select_own_or_admin" on public.rate_change_requests;
create policy "rcr_select_own_or_admin"
  on public.rate_change_requests for select
  to authenticated
  using (requested_by = auth.uid() or public.is_admin());

drop policy if exists "rcr_insert_editor_or_admin" on public.rate_change_requests;
create policy "rcr_insert_editor_or_admin"
  on public.rate_change_requests for insert
  to authenticated
  with check (
    public.has_role(array['admin', 'editor'])
    and requested_by = auth.uid()
    and status = 'pending'
  );

-- Kasıtlı olarak: update/delete politikası YOK. status değişimi (onay/red)
-- yalnızca approve_rate_change / reject_rate_change RPC'leri üzerinden olur.

-- audit_log ------------------------------------------------------------------
drop policy if exists "audit_log_select_admin_only" on public.audit_log;
create policy "audit_log_select_admin_only"
  on public.audit_log for select
  to authenticated
  using (public.is_admin());

-- Kasıtlı olarak: insert/update/delete politikası YOK. Yazma yalnızca RPC
-- fonksiyonları (postgres sahipliğinde, RLS'i atlayan) üzerinden olur.

-- ----------------------------------------------------------------------------
-- 8) ONAY AKIŞI RPC'LERİ
--
-- Her ikisi de SECURITY DEFINER'dır: tablo sahibi (postgres) yetkisiyle
-- çalıştıkları için bank_rates/audit_log üzerindeki "yazma politikası yok"
-- kısıtını atlayabilirler — ama fonksiyon gövdesinin İLK satırı her zaman
-- public.is_admin() kontrolüdür. Yani çağıran kullanıcı admin değilse
-- fonksiyon hiçbir şey yazmadan hata fırlatır.
-- ----------------------------------------------------------------------------

create or replace function public.approve_rate_change(
  p_request_id uuid,
  p_review_note text default null
)
returns public.rate_change_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request  public.rate_change_requests;
  v_rate_id  uuid;
  v_old_data jsonb;
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

  if v_request.change_type = 'create' then
    insert into public.bank_rates (
      bank_id, alt_limit, ust_limit, vadesizde_kalacak, yillik_brut_oran,
      note, gerekli_fon_bakiyesi, is_active, updated_by
    )
    values (
      v_request.bank_id,
      (v_request.proposed_data ->> 'alt_limit')::numeric,
      (v_request.proposed_data ->> 'ust_limit')::numeric,
      (v_request.proposed_data ->> 'vadesizde_kalacak')::numeric,
      (v_request.proposed_data ->> 'yillik_brut_oran')::numeric,
      coalesce(v_request.proposed_data ->> 'note', ''),
      nullif(v_request.proposed_data ->> 'gerekli_fon_bakiyesi', '')::numeric,
      true,
      auth.uid()
    )
    returning id into v_rate_id;

  elsif v_request.change_type = 'update' then
    if v_request.bank_rate_id is null then
      raise exception '"update" talebi için bank_rate_id zorunludur.';
    end if;

    select to_jsonb(br) into v_old_data
    from public.bank_rates br
    where br.id = v_request.bank_rate_id;

    if v_old_data is null then
      raise exception 'Güncellenecek oran bulunamadı: %', v_request.bank_rate_id;
    end if;

    update public.bank_rates set
      alt_limit            = coalesce((v_request.proposed_data ->> 'alt_limit')::numeric, alt_limit),
      ust_limit             = coalesce((v_request.proposed_data ->> 'ust_limit')::numeric, ust_limit),
      vadesizde_kalacak     = coalesce((v_request.proposed_data ->> 'vadesizde_kalacak')::numeric, vadesizde_kalacak),
      yillik_brut_oran      = coalesce((v_request.proposed_data ->> 'yillik_brut_oran')::numeric, yillik_brut_oran),
      note                  = coalesce(v_request.proposed_data ->> 'note', note),
      gerekli_fon_bakiyesi  = case
                                when v_request.proposed_data ? 'gerekli_fon_bakiyesi'
                                  then nullif(v_request.proposed_data ->> 'gerekli_fon_bakiyesi', '')::numeric
                                else gerekli_fon_bakiyesi
                              end,
      is_active             = coalesce((v_request.proposed_data ->> 'is_active')::boolean, is_active),
      updated_by            = auth.uid()
    where id = v_request.bank_rate_id;

    v_rate_id := v_request.bank_rate_id;

  elsif v_request.change_type = 'disable' then
    if v_request.bank_rate_id is null then
      raise exception '"disable" talebi için bank_rate_id zorunludur.';
    end if;

    select to_jsonb(br) into v_old_data
    from public.bank_rates br
    where br.id = v_request.bank_rate_id;

    if v_old_data is null then
      raise exception 'Pasifleştirilecek oran bulunamadı: %', v_request.bank_rate_id;
    end if;

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

create or replace function public.reject_rate_change(
  p_request_id uuid,
  p_review_note text default null
)
returns public.rate_change_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.rate_change_requests;
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
    raise exception 'Bu talep zaten "%" durumunda, tekrar reddedilemez.', v_request.status;
  end if;

  update public.rate_change_requests
    set status      = 'rejected',
        reviewed_by = auth.uid(),
        reviewed_at = now(),
        review_note = p_review_note
    where id = p_request_id
    returning * into v_request;

  insert into public.audit_log (actor_id, action, entity_table, entity_id, diff)
  values (
    auth.uid(),
    'rate_change_rejected',
    'rate_change_requests',
    p_request_id,
    jsonb_build_object('review_note', p_review_note)
  );

  return v_request;
end;
$$;

revoke all on function public.approve_rate_change(uuid, text) from public;
revoke all on function public.reject_rate_change(uuid, text) from public;
grant execute on function public.approve_rate_change(uuid, text) to authenticated;
grant execute on function public.reject_rate_change(uuid, text) to authenticated;

-- ============================================================================
-- İLK ADMİN KULLANICISI HAKKINDA NOT (kasıtlı olarak burada e-posta/şifre YOK)
--
-- Bu migration hiçbir kullanıcı oluşturmaz. İlk admin kullanıcısının nasıl
-- güvenle tanımlanacağı SUPABASE_KURULUM_REHBERI.md dosyasında adım adım
-- anlatılmıştır: kullanıcı Supabase Dashboard > Authentication üzerinden
-- oluşturulur (bu migration'a değil, Supabase Auth'a kaydedilir), otomatik
-- olarak role='viewer' ile bir profiles satırı açılır, ardından SQL
-- Editor'de SADECE role sütununu 'admin' yapan tek satırlık bir UPDATE
-- çalıştırılır. Bu UPDATE, e-posta adresini SİZİN elle gireceğiniz bir
-- yer tutucudur; hiçbir yerde koda gömülmez.
-- ============================================================================
