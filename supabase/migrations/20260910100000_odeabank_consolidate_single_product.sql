-- ============================================================================
-- Odeabank ürün konsolidasyonu — kullanıcı kararı: tek Odeabank kartı
--
-- Kullanıcı, "en yüksek resmi aday oranı" politikası altında iki Odeabank
-- ürününün (Oksijen Hoş Geldin / Yeni Müşteriye Özel Oksijen) aynı sonuçlara
-- yakınsayacağını gösteren rapor sonrası, TEK üründe devam etme kararı verdi:
--   - Görünür kalan: "Odeabank Yeni Müşteriye Özel Oksijen"
--   - Pasifleştirilen: "Odeabank Oksijen Hoş Geldin" (SİLİNMEDİ — is_enabled=false
--     ile geçmişi korunuyor, ana uygulamada ve günlük otomasyonda görünmüyor).
--
-- Bu migration idempotent'tir (tekrar çalıştırılırsa hata vermez / mükerrer
-- kayıt oluşturmaz — WHERE koşulları zaten hedef durumdaysa hiçbir şey
-- değiştirmez).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) Odeabank Oksijen Hoş Geldin'i pasifleştir (SİLME — geçmiş korunur).
--    banks.is_enabled=false olunca:
--      - RLS (banks_select_public_enabled, bank_rates_select_active_only)
--        zaten anon/authenticated'e bu bankayı ve oranlarını gizliyor —
--        ana uygulama app.js sorgusu (banks!inner + is_enabled=true filtresi)
--        otomatik olarak dışlıyor, app.js'e HİÇBİR değişiklik gerekmedi.
--      - check-bank-rates Edge Function'ı artık bu kaynağı atlıyor (bkz.
--        index.ts'teki bank_sources sorgusuna eklenen banks.is_enabled
--        filtresi).
-- ----------------------------------------------------------------------------

update public.banks
set is_enabled = false
where name = 'Odeabank Oksijen Hoş Geldin' and is_enabled = true;

-- ----------------------------------------------------------------------------
-- 2) Pasifleştirilen ürüne ait bekleyen (pending) talebi ONAYLAMADAN reddet.
--    reject_rate_change RPC'sinin normalde yapacağı işlemin (rejected durumu +
--    audit_log kaydı) aynısı, migration bağlamında (owner yetkisiyle, admin
--    profiliyle ilişkilendirilerek) uygulanıyor. bank_rates'e HİÇBİR yazma
--    yapılmıyor. TOM Bank'ın ve diğer tüm ürünlerin bekleyen talepleri
--    dokunulmadan kalıyor (WHERE koşulu yalnızca bu bankaya özel).
-- ----------------------------------------------------------------------------

do $$
declare
  v_bank_id   uuid;
  v_admin_id  uuid;
  v_review_note text := 'Kullanıcı kararıyla mükerrer Odeabank ürünü pasifleştirildi; en yüksek hoş geldin oranı Yeni Müşteriye Özel Oksijen ürünü üzerinden izlenecek.';
  v_request   record;
begin
  select id into v_bank_id from public.banks where name = 'Odeabank Oksijen Hoş Geldin';
  select id into v_admin_id from public.profiles where role = 'admin' order by created_at asc limit 1;

  if v_admin_id is null then
    raise exception 'Öz-doğrulama başarısız: audit_log.actor_id için bir admin profili bulunamadı.';
  end if;

  for v_request in
    select id from public.rate_change_requests
    where bank_id = v_bank_id and status = 'pending'
  loop
    update public.rate_change_requests
      set status      = 'rejected',
          reviewed_by = v_admin_id,
          reviewed_at = now(),
          review_note = v_review_note
      where id = v_request.id;

    insert into public.audit_log (actor_id, action, entity_table, entity_id, diff)
    values (
      v_admin_id,
      'rate_change_rejected',
      'rate_change_requests',
      v_request.id,
      jsonb_build_object('review_note', v_review_note, 'reason', 'odeabank_product_deactivated')
    );
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 3) Günlük kontrol kapsamından çıkar: bank_sources satırını SİLMİYORUZ
--    (geçmiş last_checked_at/last_check_status bilgisi kalsın) ama Edge
--    Function artık banks.is_enabled=false olan kaynakları sorgu seviyesinde
--    atlıyor (bkz. index.ts). Yine de notlara netlik için işaret bırakıyoruz.
-- ----------------------------------------------------------------------------

update public.bank_sources bs
set notes = 'PASİF (is_enabled=false) — kullanıcı kararıyla Odeabank Yeni Müşteriye Özel Oksijen ile birleştirildi (bkz. 20260910100000 migration). Günlük otomasyon bu kaynağı artık kontrol etmiyor.',
    updated_at = now()
from public.banks b
where bs.bank_id = b.id and b.name = 'Odeabank Oksijen Hoş Geldin';

-- ----------------------------------------------------------------------------
-- 4) Kalan tek Odeabank ürününün notu: "yeni müşteriye özel" koşulunu ve tek
--    ürünlü yeni durumu netleştir (Edge Function parser'ı da bu ürün için
--    koşul metnini artık HER ZAMAN "yalnızca ilk kez müşteri" olarak sabitler
--    — bkz. index.ts, parseOdeabankYeniMusteriOksijen).
-- ----------------------------------------------------------------------------

update public.bank_sources bs
set notes = 'Yalnızca "Oksijen Hesap* - TL" tablosu kullanılır (USD/EUR satırları alınmaz). "Hoş Geldin Faiz Oranı" ile "Yeni Müşteriye Özel Hoş Geldin Faiz Oranı" sütunlarından yüksek olanı seçilir; Vadesiz Alt Limit ve tutar aralığı aynı satırdan alınır. Bu ürün yalnızca İLK KEZ Odeabank müşterisi olanlar için geçerlidir — kart notunda ve admin detayında her zaman belirtilir. (Not: "Odeabank Oksijen Hoş Geldin" ürünü kullanıcı kararıyla pasifleştirildi, bkz. 20260910100000 migration.)',
    updated_at = now()
from public.banks b
where bs.bank_id = b.id and b.name = 'Odeabank Yeni Müşteriye Özel Oksijen';

-- ----------------------------------------------------------------------------
-- 5) Öz-doğrulama
-- ----------------------------------------------------------------------------

do $$
declare
  v_enabled boolean;
  v_pending_count int;
begin
  select is_enabled into v_enabled from public.banks where name = 'Odeabank Oksijen Hoş Geldin';
  if v_enabled is distinct from false then
    raise exception 'Öz-doğrulama başarısız: Odeabank Oksijen Hoş Geldin hâlâ is_enabled=true';
  end if;

  select count(*) into v_pending_count
  from public.rate_change_requests rcr
  join public.banks b on b.id = rcr.bank_id
  where b.name = 'Odeabank Oksijen Hoş Geldin' and rcr.status = 'pending';
  if v_pending_count <> 0 then
    raise exception 'Öz-doğrulama başarısız: Odeabank Oksijen Hoş Geldin için hâlâ % bekleyen talep var', v_pending_count;
  end if;
end $$;
