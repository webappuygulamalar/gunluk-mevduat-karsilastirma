-- ============================================================================
-- Sentetik retry-test kayıtlarının dashboard'dan ayrılması
-- ============================================================================
--
-- Kök neden (salt okunur denetimde doğrulandı): retry mekanizmasının eşzamanlılık
-- ve karar-mantığı testleri sırasında, decide_retry_run() RPC'si doğrudan
-- (gerçek Edge Function akışı üzerinden değil) çağrılarak üretilen bir kayıt
-- (id 7a33ab50-…, started_at '2026-09-29 06:10:00+00', status='running',
-- 0 bulgu) kalıcı olarak veritabanında kaldı. Admin panelinin "Son kontrol"
-- sorgusu started_at'e göre en son satırı aldığından, bu GELECEK tarihli ve
-- BOŞ kayıt "son çalışma" olarak seçildi — bu da sırasıyla yanlış tarih
-- ("29.09.2026"), sıfır pending sayısı (bu kayda bağlı hiç bulgu yok) ve
-- yanlış banka durumları (QNB/Yapı Kredi dahil hepsi "bulgu yok" için
-- varsayılan "Değişiklik yok"a düştü) sonucunu doğurdu.
--
-- Bu migration:
--   1) rate_check_runs'a is_test (ve test_name) ekler.
--   2) Kesin olarak sentetik/retry-test amaçlı olduğu doğrulanan 4 kaydı
--      is_test=true işaretler (geçmiş SİLİNMEZ, yalnızca işaretlenir).
--   3) Tek bir audit_log kaydıyla işlemi belgeler.
--
-- İşaretlenen kayıtlar ve gerekçeleri:
--   7a33ab50-4047-43df-a956-27fc06086991 — GELECEK tarihli (2026-09-29),
--     decide_retry_run() doğrudan SQL ile çağrılarak üretildi, hiç bulgusu
--     yok, hiçbir zaman gerçek bir Edge Function çalışması tarafından
--     tamamlanmadı (status='running' takılı kaldı).
--   1d9aa2f4-3534-4e18-bd42-cdf0a441d163 — retry-skip yolunun (decide_retry_run
--     öncesi eski satır içi mantıkla) manuel testi.
--   bc04d644-1ef9-4b46-8634-4f12a9f997a1 ve
--   7f6f30d1-bb7f-449a-9f46-825fb9439caf — eşzamanlı iki retry çağrısının
--     kilit/ikinci-katman korumasını kanıtlamak için kasıtlı olarak aynı anda
--     tetiklenen test çiftidir.
--
-- İdempotenttir: yalnızca is_test halen false olan satırlar güncellenir ve
-- audit_log'a yalnızca gerçekten bir şey değiştiyse yazılır.
alter table public.rate_check_runs add column if not exists is_test boolean not null default false;
alter table public.rate_check_runs add column if not exists test_name text;

comment on column public.rate_check_runs.is_test is 'true ise bu kayıt sentetik/test amaçlı üretildi — admin panelinin "son kontrol", "son başarılı kontrol" ve durum özetlerinde ASLA dikkate alınmaz.';
comment on column public.rate_check_runs.test_name is 'is_test=true olan kayıtlar için insan-okunabilir test açıklaması.';

do $$
declare
  v_actor_id uuid;
  v_ids uuid[] := array[
    '7a33ab50-4047-43df-a956-27fc06086991',
    '1d9aa2f4-3534-4e18-bd42-cdf0a441d163',
    'bc04d644-1ef9-4b46-8634-4f12a9f997a1',
    '7f6f30d1-bb7f-449a-9f46-825fb9439caf'
  ];
  v_marked_ids uuid[];
begin
  select id into v_actor_id from public.profiles where role = 'admin' order by id limit 1;
  if v_actor_id is null then
    raise exception 'Denetim kaydı için admin profili bulunamadı.';
  end if;

  with updated as (
    update public.rate_check_runs
      set is_test = true,
          test_name = case id
            when '7a33ab50-4047-43df-a956-27fc06086991' then 'retry-decision: gelecek tarihli eşzamanlılık testi (started_at 2026-09-29) — hiç tamamlanmadı, 0 bulgu'
            when '1d9aa2f4-3534-4e18-bd42-cdf0a441d163' then 'retry-decision: skip-yolu manuel testi (RPC öncesi)'
            when 'bc04d644-1ef9-4b46-8634-4f12a9f997a1' then 'retry-decision: eşzamanlı çağrı çifti testi (kilit çakışması tarafı)'
            when '7f6f30d1-bb7f-449a-9f46-825fb9439caf' then 'retry-decision: eşzamanlı çağrı çifti testi (ikinci katman koruma tarafı)'
          end
      where id = any(v_ids) and is_test = false
      returning id
  )
  select array_agg(id) into v_marked_ids from updated;

  if v_marked_ids is null or array_length(v_marked_ids, 1) is null then
    raise notice 'İşaretlenecek yeni sentetik kayıt bulunamadı (idempotent no-op).';
  else
    insert into public.audit_log (actor_id, action, entity_table, entity_id, diff)
    values (
      v_actor_id, 'mark_synthetic_test_runs', 'rate_check_runs', v_marked_ids[1],
      jsonb_build_object(
        'reason', 'Retry senaryo testleri sırasında üretilen sentetik kayıtlar dashboard sorgularından ayrılmak için is_test=true işaretlendi.',
        'marked_run_ids', to_jsonb(v_marked_ids),
        'marked_count', array_length(v_marked_ids, 1),
        'migration', '20260910220000_mark_synthetic_test_runs'
      )
    );
    raise notice '% sentetik kayıt is_test=true olarak işaretlendi.', array_length(v_marked_ids, 1);
  end if;
end $$;
