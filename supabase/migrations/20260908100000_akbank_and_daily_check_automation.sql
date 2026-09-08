-- ============================================================================
-- Akbank Serbest Plus Hesap + Günlük Otomatik Oran Kontrolü — şema genişletmesi
--
-- Bu migration:
--   1) bank_rates'e yüzde bazlı vadesiz hesaplama desteği ekler (Akbank için;
--      mevcut 131 satır geriye dönük uyumlu şekilde "sabit" tipte kalır).
--   2) approve_rate_change RPC'sini yeni alanları destekleyecek şekilde
--      günceller (create-or-replace, imza değişmedi).
--   3) admin_update_bank_rate RPC'sini ekler — admin panelindeki "Kaydet ve
--      Yayınla" (doğrudan manuel düzeltme) akışının TEK yazma yolu.
--   4) rate_change_requests.requested_by'ı nullable yapar ve source kolonu
--      ekler (otomasyonun oluşturduğu talepler gerçek bir Auth kullanıcısına
--      ait değildir).
--   5) Akbank Serbest Plus Hesap ürününü ve 2 oran bandını ekler.
--   6) Günlük otomatik kontrol şemasını kurar: bank_sources, rate_check_runs,
--      rate_check_findings — SUPABASE_OTOMASYON_PLANI.md'deki tasarımın
--      birebir uygulanması. Bulunan HER değişiklik yine mevcut
--      rate_change_requests / approve_rate_change / reject_rate_change
--      akışına 'pending' olarak eklenir; bank_rates'e hiçbir yeni yazma
--      yolu AÇILMAZ.
--   7) pg_cron + pg_net ile günlük 06:00 UTC (09:00 Europe/Istanbul, TR
--      2016'dan beri sabit UTC+3) zamanlamasını kurar. Cron secret'ı bu
--      dosyada YOKTUR — yalnızca Supabase Vault'taki 'cron_secret' adına
--      referans verilir; gerçek değer ayrı, repo dışı bir adımda
--      `vault.create_secret` ile elle oluşturulur.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) bank_rates: yüzde bazlı vadesiz hesaplama desteği
-- ----------------------------------------------------------------------------

alter table public.bank_rates
  add column if not exists vadesiz_hesaplama_tipi text not null default 'sabit'
    check (vadesiz_hesaplama_tipi in ('sabit', 'yuzde')),
  add column if not exists vadesiz_oran numeric;

alter table public.bank_rates drop constraint if exists bank_rates_vadesiz_oran_consistency;
alter table public.bank_rates add constraint bank_rates_vadesiz_oran_consistency
  check (
    (vadesiz_hesaplama_tipi = 'sabit' and vadesiz_oran is null)
    or
    (vadesiz_hesaplama_tipi = 'yuzde' and vadesiz_oran is not null and vadesiz_oran >= 0 and vadesiz_oran < 100)
  );

comment on column public.bank_rates.vadesiz_hesaplama_tipi is
  '"sabit": vadesizde_kalacak TL cinsinden sabit tutardır (mevcut/varsayılan davranış). "yuzde": vadesizde kalan tutar güncel bakiyenin vadesiz_oran yüzdesidir (ör. Akbank Serbest Plus %10); bu durumda vadesizde_kalacak kullanılmaz (0 saklanır).';
comment on column public.bank_rates.vadesiz_oran is
  'Yalnızca vadesiz_hesaplama_tipi=''yuzde'' iken dolu; 0-100 arası yüzde değeri (ör. 10 = %10).';

-- ----------------------------------------------------------------------------
-- 2) approve_rate_change: yeni alanları destekle (create/update dalları)
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
      note, gerekli_fon_bakiyesi, vadesiz_hesaplama_tipi, vadesiz_oran,
      is_active, updated_by
    )
    values (
      v_request.bank_id,
      (v_request.proposed_data ->> 'alt_limit')::numeric,
      (v_request.proposed_data ->> 'ust_limit')::numeric,
      coalesce((v_request.proposed_data ->> 'vadesizde_kalacak')::numeric, 0),
      (v_request.proposed_data ->> 'yillik_brut_oran')::numeric,
      coalesce(v_request.proposed_data ->> 'note', ''),
      nullif(v_request.proposed_data ->> 'gerekli_fon_bakiyesi', '')::numeric,
      coalesce(v_request.proposed_data ->> 'vadesiz_hesaplama_tipi', 'sabit'),
      nullif(v_request.proposed_data ->> 'vadesiz_oran', '')::numeric,
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
      alt_limit             = coalesce((v_request.proposed_data ->> 'alt_limit')::numeric, alt_limit),
      ust_limit              = coalesce((v_request.proposed_data ->> 'ust_limit')::numeric, ust_limit),
      vadesizde_kalacak      = coalesce((v_request.proposed_data ->> 'vadesizde_kalacak')::numeric, vadesizde_kalacak),
      yillik_brut_oran       = coalesce((v_request.proposed_data ->> 'yillik_brut_oran')::numeric, yillik_brut_oran),
      note                   = coalesce(v_request.proposed_data ->> 'note', note),
      gerekli_fon_bakiyesi   = case
                                 when v_request.proposed_data ? 'gerekli_fon_bakiyesi'
                                   then nullif(v_request.proposed_data ->> 'gerekli_fon_bakiyesi', '')::numeric
                                 else gerekli_fon_bakiyesi
                               end,
      vadesiz_hesaplama_tipi = coalesce(v_request.proposed_data ->> 'vadesiz_hesaplama_tipi', vadesiz_hesaplama_tipi),
      vadesiz_oran           = case
                                 when v_request.proposed_data ? 'vadesiz_oran'
                                   then nullif(v_request.proposed_data ->> 'vadesiz_oran', '')::numeric
                                 else vadesiz_oran
                               end,
      is_active              = coalesce((v_request.proposed_data ->> 'is_active')::boolean, is_active),
      updated_by             = auth.uid()
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

-- ----------------------------------------------------------------------------
-- 3) admin_update_bank_rate: admin panelindeki doğrudan manuel düzeltme
--    ("Kaydet ve Yayınla") akışının TEK yazma yolu. Öneri kuyruğunu atlar
--    (admin zaten kendi onayını kendisi veriyor) ama audit_log'a yazar.
-- ----------------------------------------------------------------------------

create or replace function public.admin_update_bank_rate(
  p_rate_id uuid,
  p_alt_limit numeric,
  p_ust_limit numeric,
  p_vadesizde_kalacak numeric,
  p_yillik_brut_oran numeric,
  p_note text default '',
  p_gerekli_fon_bakiyesi numeric default null,
  p_vadesiz_hesaplama_tipi text default 'sabit',
  p_vadesiz_oran numeric default null
)
returns public.bank_rates
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old_data jsonb;
  v_new      public.bank_rates;
begin
  if not public.is_admin() then
    raise exception 'Bu işlemi yalnızca admin rolündeki kullanıcılar yapabilir.';
  end if;

  select to_jsonb(br) into v_old_data
  from public.bank_rates br
  where br.id = p_rate_id;

  if v_old_data is null then
    raise exception 'Güncellenecek oran bulunamadı: %', p_rate_id;
  end if;

  update public.bank_rates set
    alt_limit              = p_alt_limit,
    ust_limit               = p_ust_limit,
    vadesizde_kalacak       = p_vadesizde_kalacak,
    yillik_brut_oran        = p_yillik_brut_oran,
    note                    = coalesce(p_note, ''),
    gerekli_fon_bakiyesi    = p_gerekli_fon_bakiyesi,
    vadesiz_hesaplama_tipi  = coalesce(p_vadesiz_hesaplama_tipi, 'sabit'),
    vadesiz_oran            = p_vadesiz_oran,
    updated_by              = auth.uid()
  where id = p_rate_id
  returning * into v_new;

  insert into public.audit_log (actor_id, action, entity_table, entity_id, diff)
  values (
    auth.uid(),
    'manual_rate_update',
    'bank_rates',
    p_rate_id,
    jsonb_build_object('before', v_old_data, 'after', to_jsonb(v_new))
  );

  return v_new;
end;
$$;

revoke all on function public.admin_update_bank_rate(uuid, numeric, numeric, numeric, numeric, text, numeric, text, numeric) from public;
grant execute on function public.admin_update_bank_rate(uuid, numeric, numeric, numeric, numeric, text, numeric, text, numeric) to authenticated;

-- ----------------------------------------------------------------------------
-- 4) rate_change_requests: otomasyon desteği (gerçek bir Auth kullanıcısı
--    olmadan da 'pending' talep açabilmesi için)
-- ----------------------------------------------------------------------------

alter table public.rate_change_requests alter column requested_by drop not null;

alter table public.rate_change_requests
  add column if not exists source text not null default 'manual'
    check (source in ('manual', 'automation'));

comment on column public.rate_change_requests.source is
  '''manual'': admin panelinden bir editör/admin tarafından önerildi (requested_by dolu). ''automation'': check-bank-rates Edge Function tarafından günlük kontrolde bulundu (requested_by NULL, service_role ile RLS bypass edilerek yazıldı).';

-- ----------------------------------------------------------------------------
-- 5) Akbank Serbest Plus Hesap — resmi kaynaktan doğrulanmış veri
--    (https://www.akbank.com/mevduat-yatirim/mevduat/vadeli-mevduat-hesaplari/serbest-plus-hesap,
--    doğrulama: 2026-09-08). Aynı orana sahip ardışık bantlar tek bantta
--    birleştirildi (10.000-499.999 / 500.000-999.999 / 1.000.000-25.000.000
--    hepsi %38,50 → tek bant); 25.000.000 üzeri ayrı bant (%4,00).
-- ----------------------------------------------------------------------------

insert into public.banks (name, is_pinned, sort_order, is_enabled)
values ('Akbank Serbest Plus Hesap', false, 11, true)
on conflict (name) do nothing;

insert into public.bank_rates (
  bank_id, alt_limit, ust_limit, vadesizde_kalacak, yillik_brut_oran,
  note, gerekli_fon_bakiyesi, vadesiz_hesaplama_tipi, vadesiz_oran, is_active
)
select b.id, v.alt_limit, v.ust_limit, 0, v.yillik_brut_oran, '', null, 'yuzde', 10, true
from public.banks b
cross join (
  values
    (10000::numeric,   24999999.99::numeric, 0.385::numeric),
    (25000000::numeric, 9999999999::numeric, 0.04::numeric)
) as v(alt_limit, ust_limit, yillik_brut_oran)
where b.name = 'Akbank Serbest Plus Hesap'
  and not exists (
    select 1 from public.bank_rates br
    where br.bank_id = b.id and br.alt_limit = v.alt_limit
  );

-- ----------------------------------------------------------------------------
-- 6) Günlük otomatik kontrol şeması
-- ----------------------------------------------------------------------------

create table if not exists public.bank_sources (
  id                    uuid primary key default gen_random_uuid(),
  bank_id               uuid not null references public.banks (id) on delete cascade,
  source_url            text not null,
  page_marker_text      text,
  expected_tier_count   int,
  source_type           text not null default 'unverified'
    check (source_type in ('static_table', 'interactive_tool', 'document', 'unverified')),
  requires_manual_check boolean not null default true,
  last_checked_at       timestamptz,
  last_check_status     text not null default 'not_attempted'
    check (last_check_status in ('ok', 'unreachable', 'changed', 'parse_error', 'manual_required', 'not_attempted')),
  notes                 text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

comment on table public.bank_sources is 'Her banka/ürün için resmi kaynak sayfası + otomasyonun o kaynağa nasıl bakacağı. requires_manual_check=true olan kaynaklar hiç fetch edilmez, doğrudan "manuel kontrol gerekli" bulgusu üretir.';

create table if not exists public.rate_check_runs (
  id                    uuid primary key default gen_random_uuid(),
  started_at            timestamptz not null default now(),
  finished_at           timestamptz,
  status                text not null default 'running'
    check (status in ('running', 'success', 'partial_failure', 'failure')),
  sources_checked       int not null default 0,
  sources_unreachable   int not null default 0,
  findings_created      int not null default 0,
  triggered_by          text not null default 'cron' check (triggered_by in ('cron', 'manual')),
  dry_run               boolean not null default false,
  error_summary         text
);

comment on table public.rate_check_runs is 'Her günlük (veya elle tetiklenen) kontrol çalışmasının özeti.';

create table if not exists public.rate_check_findings (
  id                     uuid primary key default gen_random_uuid(),
  run_id                 uuid not null references public.rate_check_runs (id) on delete cascade,
  bank_source_id         uuid not null references public.bank_sources (id) on delete cascade,
  bank_id                uuid not null references public.banks (id) on delete cascade,
  finding_type           text not null
    check (finding_type in ('no_change', 'rate_changed', 'unreachable', 'parse_error', 'manual_required')),
  current_value          jsonb,
  observed_value         jsonb,
  evidence_url           text not null,
  evidence_snapshot      text,
  detail                 text,
  rate_change_request_id uuid references public.rate_change_requests (id) on delete set null,
  created_at             timestamptz not null default now()
);

comment on table public.rate_check_findings is 'Her kontrol çalışmasında, her kaynak için üretilen sonuç + kanıt. finding_type=''rate_changed'' ise rate_change_request_id dolu ve ayrı bir pending talep zaten oluşturulmuştur.';

create index if not exists idx_bank_sources_bank_id on public.bank_sources (bank_id);
create index if not exists idx_rate_check_findings_run_id on public.rate_check_findings (run_id);
create index if not exists idx_rate_check_findings_bank_id on public.rate_check_findings (bank_id);
create index if not exists idx_rate_check_findings_created_at on public.rate_check_findings (created_at desc);
create index if not exists idx_rate_check_runs_started_at on public.rate_check_runs (started_at desc);

alter table public.bank_sources enable row level security;
alter table public.rate_check_runs enable row level security;
alter table public.rate_check_findings enable row level security;

revoke all on public.bank_sources, public.rate_check_runs, public.rate_check_findings from anon, authenticated;
grant select on public.bank_sources, public.rate_check_runs, public.rate_check_findings to authenticated;

drop policy if exists "bank_sources_select_admin_only" on public.bank_sources;
create policy "bank_sources_select_admin_only"
  on public.bank_sources for select
  to authenticated
  using (public.is_admin());

drop policy if exists "rate_check_runs_select_admin_only" on public.rate_check_runs;
create policy "rate_check_runs_select_admin_only"
  on public.rate_check_runs for select
  to authenticated
  using (public.is_admin());

drop policy if exists "rate_check_findings_select_admin_only" on public.rate_check_findings;
create policy "rate_check_findings_select_admin_only"
  on public.rate_check_findings for select
  to authenticated
  using (public.is_admin());

-- Kasıtlı olarak: üç tabloda da insert/update/delete politikası YOK. Yazma
-- yalnızca check-bank-rates Edge Function'ının service_role bağlantısıyla
-- olur (service_role Postgres rolü RLS'i doğası gereği bypass eder).

-- ----------------------------------------------------------------------------
-- 6b) 11 ürün için kaynak envanteri (BANKA_KAYNAK_ENVANTERI.md'de doğrulanan
--     URL'ler). requires_manual_check=false yalnızca gerçekten statik,
--     mevcut veri modeliyle birebir eşleşen 3 kaynak için: TOM Bank,
--     Fibabanka Fonlu Kiraz, Akbank Serbest Plus. QNB'nin resmi sayfası
--     yalnızca tek bir düz "tanışma faizi" oranı gösteriyor; mevcut
--     bank_rates'teki 10M+ için farklılaşan (%28/%25,75) kademeler bu
--     sayfadan güvenle doğrulanamadığından QNB de manuel kontrole alındı.
-- ----------------------------------------------------------------------------

insert into public.bank_sources (bank_id, source_url, page_marker_text, expected_tier_count, source_type, requires_manual_check, notes)
select b.id, v.source_url, v.page_marker_text, v.expected_tier_count, v.source_type, v.requires_manual_check, v.notes
from public.banks b
join (
  values
    ('TOM Bank', 'https://tombank.com.tr/gunluk-kazandiran-hesap.html', 'Limitler ve Kâra Katılma Oranları', 9, 'static_table', false,
      'table.limit-table; kolonlar sırayla: oran%, alt limit, üst limit, vadesiz alt limit.'),
    ('QNB', 'https://www.qnb.com.tr/kazandiran-gunluk-hesap', 'Günlük Faiz Oranları', null, 'unverified', true,
      'Sayfa yalnızca 0-10.000.000 TL için tek bir "Tanışma Faizi" oranı gösteriyor; mevcut 17 banttaki 10M+ kademelerin (%28/%25,75) kaynağı bu sayfadan doğrulanamadı. Otomatik ayrıştırma yapılmadı, admin elle kontrol etmeli.'),
    ('Yapı Kredi', 'https://www.yapikredi.com.tr/bireysel-bankacilik/mevduat-urunleri/sinirsiz-hesap', 'Kampanyalı Faiz Oranı', null, 'unverified', true,
      'Üç katmanlı oran yapısı (kampanyalı/kampanya sonrası/baz) + 8 ek faiz kategorisi var; hangi katmanın referans alınacağı netleşmedi.'),
    ('Fibabanka Kiraz Hoş Geldin', 'https://www.fibabanka.com.tr/mevduat/kiraz-hesap', 'Standart Hoş Geldin Faiz Oranı', null, 'unverified', true,
      'Hoş geldin süresi (45 mi 60 gün mü) kaynaklar arasında çelişkili; ayrıca sayfada aynı yapıda birden çok tab/tablo var (TL/döviz/vade varyantları), doğru tabın hangisi olduğu netleşmedi.'),
    ('Fibabanka Fonlu Kiraz', 'https://www.fibabanka.com.tr/mevduat/kiraz-hesap?tab=5', 'Fonlu Kiraz Ek Faiz Oranı', 12, 'static_table', false,
      'İlgili tablo (col8="Fonlu Kiraz Ek Faiz Oranı" başlığını içeren ilk tablo) 12 satır; yillik_brut_oran = Dijital Kanallara Özel Hoş Geldin oranı + Fonlu Kiraz Ek Faiz. gerekli_fon_bakiyesi bu tablodan doğrulanamıyor, karşılaştırmaya dahil edilmiyor.'),
    ('Alternatifbank', 'https://www.alternatifbank.com.tr/bireysel/mevduat/vadeli-mevduat/vov-hesap', 'Avantajlı Tanışma Faiz Oranları', null, 'unverified', true,
      'Sayfada yalnızca 1.000.000 TL''ye kadar tek özet oran görüldü; mevcut 12 kademeli tam tablonun sayfadaki konumu doğrulanamadı.'),
    ('ING ilk defa müşteri kampanyası', 'https://www.ing.com.tr/tr/bilgi-destek/mevduat/e-hesap-faiz-oranlari', null, null, 'interactive_tool', true,
      'Oranlar form gönderimi/JS etkileşimiyle gösteriliyor, statik/otomatik okunabilir tablo yok.'),
    ('ING Hoş geldin', 'https://www.ing.com.tr/tr/bilgi-destek/mevduat/e-hesap-faiz-oranlari', null, null, 'interactive_tool', true,
      'Oranlar form gönderimi/JS etkileşimiyle gösteriliyor, statik/otomatik okunabilir tablo yok.'),
    ('Odeabank Oksijen Hoş Geldin', 'https://www.odeabank.com.tr/kampanyalar/oksijen-hesap-paraniza-deger-veren-hesap-23135', null, null, 'unverified', true,
      'Kademeli oran tablosunun kalıcı/kodla okunabilir kaynağı bulunamadı.'),
    ('Odeabank Yeni Müşteriye Özel Oksijen', 'https://www.odeabank.com.tr/kampanyalar/oksijen-hesap-paraniza-deger-veren-hesap-23135', null, null, 'unverified', true,
      'Kademeli oran tablosunun kalıcı/kodla okunabilir kaynağı bulunamadı.'),
    ('Akbank Serbest Plus Hesap', 'https://www.akbank.com/mevduat-yatirim/mevduat/vadeli-mevduat-hesaplari/serbest-plus-hesap', 'Serbest Plus Hesap Faiz Oranı', 4, 'static_table', false,
      'div.free-plus-table > table.mb-0; thead th = tutar aralığı etiketleri, tbody tek tr''deki td''ler karşılık gelen oranlar (transpoze tablo). Vadesiz oranı (%10) sayfada "bakiyesinin %X''una karşılık gelen tutar vadesiz hesapta tutulur" cümlesinden ayrıca doğrulanır.')
) as v(bank_name, source_url, page_marker_text, expected_tier_count, source_type, requires_manual_check, notes)
  on v.bank_name = b.name
where not exists (
  select 1 from public.bank_sources bs where bs.bank_id = b.id
);

-- ----------------------------------------------------------------------------
-- 7) Zamanlama: pg_cron + pg_net, her gün 06:00 UTC (= 09:00 Europe/Istanbul,
--    TR sabit UTC+3). Secret DEĞERİ bu dosyada YOK — yalnızca Vault'taki
--    'cron_secret' ismine referans var. Gerçek değer, bu migration'dan
--    tamamen ayrı, repo'ya hiç yazılmayan bir adımda tek seferlik
--    `select vault.create_secret('<rastgele-değer>', 'cron_secret');` ile
--    kurulur (+ aynı değer `supabase secrets set CRON_SECRET=...` ile Edge
--    Function ortamına verilir).
-- ----------------------------------------------------------------------------

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid) from cron.job where jobname = 'check-bank-rates-daily';

select cron.schedule(
  'check-bank-rates-daily',
  '0 6 * * *',
  $cron$
  select net.http_post(
    url := 'https://zlvezpwheycdvzsszrqu.supabase.co/functions/v1/check-bank-rates',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb
  );
  $cron$
);

-- ----------------------------------------------------------------------------
-- 8) Öz-doğrulama: banka adı eşleşmeleri (yukarıdaki VALUES listelerindeki
--    literal isimler ile banks.name arasında) sessizce kaçırılırsa (ör. bir
--    Türkçe karakter farkı) migration'ın TAMAMI hata verip geri alınsın —
--    eksik/yanlış veri ile sessizce devam edilmesin.
-- ----------------------------------------------------------------------------

do $$
declare
  v_bank_count int;
  v_source_count int;
  v_akbank_id uuid;
  v_akbank_rate_count int;
  v_missing_sources text;
begin
  select count(*) into v_bank_count from public.banks;
  select count(*) into v_source_count from public.bank_sources;

  if v_source_count <> v_bank_count then
    select string_agg(b.name, ', ') into v_missing_sources
    from public.banks b
    where not exists (select 1 from public.bank_sources bs where bs.bank_id = b.id);

    raise exception 'Öz-doğrulama başarısız: % bankadan yalnızca % için bank_sources satırı oluştu. Eksik/eşleşmeyen banka adları: %',
      v_bank_count, v_source_count, coalesce(v_missing_sources, '(none listed — unexpected)');
  end if;

  select id into v_akbank_id from public.banks where name = 'Akbank Serbest Plus Hesap';
  if v_akbank_id is null then
    raise exception 'Öz-doğrulama başarısız: "Akbank Serbest Plus Hesap" banks tablosunda bulunamadı.';
  end if;

  select count(*) into v_akbank_rate_count from public.bank_rates where bank_id = v_akbank_id;
  if v_akbank_rate_count <> 2 then
    raise exception 'Öz-doğrulama başarısız: Akbank Serbest Plus Hesap için 2 yerine % bank_rates satırı bulundu.', v_akbank_rate_count;
  end if;
end $$;
