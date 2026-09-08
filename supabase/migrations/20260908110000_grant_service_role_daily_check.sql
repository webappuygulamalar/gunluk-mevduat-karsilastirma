-- ============================================================================
-- service_role için eksik tablo yetkileri (GRANT)
--
-- check-bank-rates Edge Function, service_role anahtarıyla bağlanıyor.
-- service_role Postgres rolü RLS politikalarını bypass eder (bypassrls),
-- ANCAK bu, düz SQL GRANT/REVOKE yetkilerinden BAĞIMSIZ bir mekanizmadır —
-- tablo düzeyinde açık bir GRANT olmadan service_role da "permission denied"
-- alır (canlıda ilk dry-run testinde doğrulandı: 42501 permission denied for
-- table rate_check_runs). Bu migration, Edge Function'ın gerçekten
-- dokunduğu tablolara service_role için gerekli minimum yetkileri açıkça
-- verir. anon/authenticated rolleri için hiçbir şey değişmiyor.
-- ============================================================================

grant select on public.banks, public.bank_rates, public.profiles to service_role;
grant select, insert, update on public.bank_sources to service_role;
grant select, insert, update on public.rate_check_runs to service_role;
grant select, insert on public.rate_check_findings to service_role;
grant select, insert on public.rate_change_requests to service_role;
