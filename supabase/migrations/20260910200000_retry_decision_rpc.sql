-- ============================================================================
-- Retry mantığındaki 3 açığın düzeltilmesi:
--   1) İlk bank_sources sorgusuna kısa/artan bekemeli retry (Edge Function'da)
--   2) 09:10 kararının SADECE aynı İstanbul iş gününün triggered_by='cron'
--      ana çalışmasına bakması (manuel/dry-run/önceki retry'ler saymaz)
--   3) Eşzamanlı çağrılara karşı DB seviyesinde atomik kilit + skipped kaydı
-- ============================================================================

alter table public.rate_check_runs drop constraint if exists rate_check_runs_status_check;
alter table public.rate_check_runs add constraint rate_check_runs_status_check
  check (status = any (array['running', 'success', 'partial_failure', 'failure', 'skipped']));

alter table public.rate_check_runs add column if not exists retry_reason text;
comment on column public.rate_check_runs.retry_reason is 'decide_retry_run() tarafından atanan makine-okunabilir karar gerekçesi (ör. primary_run_already_completed, primary_run_failed, concurrent_call_in_progress).';

-- ----------------------------------------------------------------------------
-- decide_retry_run — 09:10 retry çağrısının TEK giriş noktası. Şunları
-- ATOMİK olarak (tek transaction, pg_try_advisory_xact_lock ile) yapar:
--   1) Eşzamanlı ikinci bir çağrı varsa hemen 'skip' döner (kilit alınamadı).
--   2) Bugün (Europe/Istanbul takvim günü) zaten GERÇEK (skip olmayan) bir
--      retry çalıştıysa 'skip' döner — aynı gün iki gerçek retry OLAMAZ.
--   3) triggered_by='cron' + dry_run=false + bugünkü (İstanbul) ana çalışmayı
--      bulur; YALNIZCA bunu değerlendirir (manuel/dry-run/eski retry'ler
--      ana çalışmanın YERİNE GEÇMEZ).
--   4) Karara göre ya 'skipped' bir kayıt (status='skipped') ya da 'running'
--      bir kayıt (Edge Function'ın devam edeceği) INSERT eder ve döner.
--
-- pg_try_advisory_xact_lock KULLANILDI (session değil, transaction ömürlü):
-- PostgREST/RPC her çağrıda ayrı bir bağlantı kullanabildiğinden, session
-- kilitleri güvenilir değildir; xact kilidi bu fonksiyonun kendi
-- transaction'ı (=tek RPC çağrısı) bitince otomatik ve güvenle serbest kalır.
create or replace function public.decide_retry_run(p_now timestamptz default now())
returns table(action text, run_id uuid, reason text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_got_lock       boolean;
  v_istanbul_today date;
  v_primary        public.rate_check_runs;
  v_should_run     boolean;
  v_reason         text;
  v_run_id         uuid;
begin
  v_got_lock := pg_try_advisory_xact_lock(hashtext('check-bank-rates-retry-decision'));
  if not v_got_lock then
    v_run_id := gen_random_uuid();
    insert into public.rate_check_runs
      (id, status, triggered_by, dry_run, sources_checked, retry_reason, notes, started_at, finished_at, duration_ms)
    values
      (v_run_id, 'skipped', 'retry', false, 0, 'concurrent_call_in_progress',
       'Eşzamanlı başka bir retry çağrısı işleniyordu; bu çağrı atlandı.', p_now, p_now, 0);
    return query select 'skip'::text, v_run_id, 'concurrent_call_in_progress'::text;
    return;
  end if;

  v_istanbul_today := (p_now at time zone 'Europe/Istanbul')::date;

  -- İkinci katman koruma: kilit anlık çakışmayı önler, ama biri kilidi alıp
  -- işini bitirdikten SONRA (dakikalar sonra bile) gelen ayrı bir çağrıyı
  -- önlemek için "bugün zaten gerçek bir retry oldu mu" ayrıca kontrol edilir.
  if exists (
    select 1 from public.rate_check_runs
    where triggered_by = 'retry'
      and dry_run = false
      and status <> 'skipped'
      and (started_at at time zone 'Europe/Istanbul')::date = v_istanbul_today
  ) then
    v_run_id := gen_random_uuid();
    insert into public.rate_check_runs
      (id, status, triggered_by, dry_run, sources_checked, retry_reason, notes, started_at, finished_at, duration_ms)
    values
      (v_run_id, 'skipped', 'retry', false, 0, 'retry_already_ran_today',
       'Bugün (Europe/Istanbul) zaten gerçek bir retry çalışması yapıldı; ikinci kez çalışmadı.', p_now, p_now, 0);
    return query select 'skip'::text, v_run_id, 'retry_already_ran_today'::text;
    return;
  end if;

  -- YALNIZCA bugünkü (İstanbul takvimi) triggered_by='cron' ana çalışması
  -- değerlendirilir. Manuel/dry-run/retry çalışmalar ana cron'un yerine
  -- GEÇMEZ — bunlar bu sorguya hiç girmez.
  select * into v_primary
  from public.rate_check_runs
  where triggered_by = 'cron'
    and dry_run = false
    and (started_at at time zone 'Europe/Istanbul')::date = v_istanbul_today
  order by started_at desc
  limit 1;

  if v_primary.id is null then
    v_should_run := true;
    v_reason := 'primary_run_missing';
  elsif v_primary.status = 'success' then
    v_should_run := false;
    v_reason := 'primary_run_already_completed';
  elsif v_primary.status = 'partial_failure' and coalesce(v_primary.sources_checked, 0) > 0 then
    v_should_run := false;
    v_reason := 'primary_run_already_completed';
  elsif v_primary.status = 'failure' then
    v_should_run := true;
    v_reason := 'primary_run_failed';
  elsif coalesce(v_primary.sources_checked, 0) = 0 then
    v_should_run := true;
    v_reason := 'primary_run_checked_zero_products';
  else
    -- beklenmeyen durum (ör. hâlâ 'running' — çok uzun sürüyor olabilir):
    -- güvenli taraf seçilir, retry çalıştırılır.
    v_should_run := true;
    v_reason := 'primary_run_unexpected_state';
  end if;

  if v_should_run then
    v_run_id := gen_random_uuid();
    insert into public.rate_check_runs (id, status, triggered_by, dry_run, retry_reason, notes, started_at)
    values (
      v_run_id, 'running', 'retry', false, v_reason,
      format('Ana kontrol (%s) nedeniyle retry tetiklendi — gerekçe: %s', coalesce(v_primary.id::text, 'kayıt yok'), v_reason),
      p_now
    );
    return query select 'run'::text, v_run_id, v_reason;
  else
    v_run_id := gen_random_uuid();
    insert into public.rate_check_runs
      (id, status, triggered_by, dry_run, sources_checked, retry_reason, notes, started_at, finished_at, duration_ms)
    values (
      v_run_id, 'skipped', 'retry', false, 0, v_reason,
      format('Ana kontrol (%s) zaten yeterliydi — gerekçe: %s — 09:10 retry''ye ihtiyaç duyulmadı.', v_primary.id::text, v_reason),
      p_now, p_now, 0
    );
    return query select 'skip'::text, v_run_id, v_reason;
  end if;
end;
$$;

revoke all on function public.decide_retry_run(timestamptz) from public;
grant execute on function public.decide_retry_run(timestamptz) to service_role;
