-- ============================================================================
-- Günlük kontrolün dayanıklılığı — rate_check_runs zenginleştirmesi + retry cron
-- ============================================================================
--
-- 2026-09-09 06:00 UTC olayının kök nedeni: check-bank-rates Edge Function'ının
-- İLK sorgusu (bank_sources select) Supabase API katmanından bir kerelik
-- "Gateway Timeout" aldı (~12 saniye sonra, status_code 500) — pg_cron/pg_net
-- katmanı sorunsuzdu (cron.job_run_details: "succeeded", <100ms; net'in
-- kendisi async dispatch, gerçek yanıtı beklemez). Fonksiyonun kendi hata
-- yakalama kodu bu durumu DOĞRU şekilde rate_check_runs'a yazdı (status=
-- 'failure', error_summary='Gateway Timeout') — ama bu TEK sorgu tüm 10
-- kaynağın kontrolünü engelledi (döngü hiç başlamadı). Bu migration, bu tür
-- tek-nokta-arızalarına karşı DAHA ZENGİN çalışma kaydı (teşhis için) ve
-- güvenli bir 06:10 UTC retry ekliyor. Kod tarafındaki asıl dayanıklılık
-- (paralel/izole kaynak çekme, her ürünün ayrı try/catch'i, TÜM hata
-- yollarında rate_check_runs'ın mutlaka güncellenmesi) check-bank-rates/
-- index.ts'de.
--
-- İdempotenttir: ADD COLUMN IF NOT EXISTS + DROP/ADD CONSTRAINT (aynı
-- tanımla) + cron.schedule (aynı isimle upsert) — güvenle tekrar çalıştırılabilir.

alter table public.rate_check_runs
  add column if not exists verified_products int,
  add column if not exists pending_products int,
  add column if not exists manual_products int,
  add column if not exists duration_ms int,
  add column if not exists notes text;

comment on column public.rate_check_runs.verified_products is 'Bu çalışmada "Değişiklik yok" (otomatik doğrulandı) olarak işaretlenen ürün sayısı.';
comment on column public.rate_check_runs.pending_products is 'Bu çalışmada "Onay bekliyor" (gerçek oran farkı bulundu) olarak işaretlenen ürün sayısı.';
comment on column public.rate_check_runs.manual_products is '"Manuel kontrol gerekli" (kalıcı manuel + ayrıştırma hatası) olarak işaretlenen ürün sayısı.';
comment on column public.rate_check_runs.duration_ms is 'Çalışmanın toplam süresi (milisaniye), Edge Function içinde ölçülür.';
comment on column public.rate_check_runs.notes is 'İnsan tarafından okunabilir ek not (ör. retry neden tetiklendi/atlandı).';

alter table public.rate_check_runs drop constraint if exists rate_check_runs_triggered_by_check;
alter table public.rate_check_runs add constraint rate_check_runs_triggered_by_check
  check (triggered_by = any (array['cron', 'manual', 'retry']));

-- Güvenli otomatik tekrar: 06:00 UTC (09:00 TRT) ana kontrolü failure olur ya
-- da checked_products=0 kalırsa, 06:10 UTC'de (09:10 TRT) BİR KEZ tekrar
-- dener. Edge Function'ın kendisi (retry_check:true gövdesiyle çağrıldığında)
-- önce "bugün zaten başarılı bir çalışma var mı" diye bakar — varsa hiçbir
-- kaynağa dokunmadan no-op olarak döner, YOKSA tam bir çalışma yapar. Bu
-- sayede aynı gün ikinci bir gereksiz retry ASLA oluşmaz, ve retry mevcut
-- mükerrer-talep engelleme (previous_data eşleşmesi) sayesinde asla mükerrer
-- pending talep üretmez. Secret, mevcut 'cron_secret' Vault girdisinden aynı
-- şekilde okunur — tarayıcı koduna veya migration dosyasına HİÇBİR gizli
-- değer yazılmaz.
select cron.schedule(
  'check-bank-rates-daily-retry',
  '10 6 * * *',
  $$
  select net.http_post(
    url := 'https://zlvezpwheycdvzsszrqu.supabase.co/functions/v1/check-bank-rates',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{"retry_check": true}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
