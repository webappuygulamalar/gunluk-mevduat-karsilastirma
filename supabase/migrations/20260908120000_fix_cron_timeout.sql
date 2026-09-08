-- ============================================================================
-- Cron zamanlamasını, pg_net'in varsayılan 5 saniyelik zaman aşımı yerine
-- daha uzun bir zaman aşımıyla yeniden kur.
--
-- check-bank-rates fonksiyonu 3 canlı dış sayfayı (TOM Bank, Fibabanka Fonlu
-- Kiraz, Akbank) sırayla çekip birden çok veritabanı yazması yapıyor; bu,
-- net.http_post'un varsayılan 5000ms zaman aşımını rahatça aşabiliyor
-- (canlıda test edilirken doğrulandı: "Timeout of 5000 ms reached"). pg_net
-- zaman aşımına uğradığında yalnızca YANITI beklemeyi bırakır — asıl amaç
-- (fonksiyonun tetiklenmesi) zaten gerçekleşmiş oluyor, ama sonucu
-- rate_check_runs'a doğru şekilde yazabilmesi için fonksiyonun kendi başına
-- tamamlanacak kadar süresi olmalı; pg_net tarafında da yeterli bekleme
-- payı bırakmak (120 saniye) daha güvenli.
-- ============================================================================

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
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $cron$
);
