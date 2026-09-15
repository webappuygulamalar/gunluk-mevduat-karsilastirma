-- ============================================================================
-- Odeabank Yeni Müşteriye Özel Oksijen — son bandın kuruş-normalizasyonu
-- ============================================================================
--
-- KÖK NEDEN (salt okunur denetimde 2026-09-16'da kesin olarak doğrulandı):
-- Bu, bir HTML/parser/CSS sınıfı sorunu DEĞİLDİ. Canlı sayfa hâlâ
-- ".content-box" + h2/table yapısını kullanıyor ve zaten kuruş-hassasiyetli
-- sınırlar yayımlıyor ("20.000.000,01-25.000.000"), parser bunu doğru
-- okuyordu. Asıl sorun: bu ürünün 16 bandından İLK 15'i doğru şekilde
-- kuruş-normalize edilmişken (alt_limit = önceki bandın ust_limit'i + 0,01),
-- 16. (son) bant HİÇ normalize edilmemiş — "20000001" (tam sayı, +1 TL
-- deseni) olarak kaydedilmiş, olması gereken "20000000.01" (kuruş deseni)
-- yerine. Bu, aynı oturumda Yapı Kredi/QNB/TOM Bank/Alternatifbank'ta
-- düzeltilen kök nedenle BİREBİR AYNI sınıf sorun.
--
-- Bu 1 TL'lik boşluk önceden (2026-09-15120000 migration'ından ÖNCE)
-- processSource'un bant eşleştirmesi SAF POZİSYONEL (dizi sırası + sayı
-- eşitliği) olduğu ve bandsEqual() 1 TL toleranslı olduğu için sessizce
-- fark edilmiyordu. QNB'nin "dizi sırasına güvenme" ihtiyacı için o
-- migration'da eklenen DAHA SIKI, alt_limit-anahtarlı eşleştirme bu
-- ÖNCEDEN VAR OLAN veri hatasını doğru şekilde yakalayıp "Bant yapısı
-- güvenle eşleştirilemedi" parse_error'ı üretmeye başladı — bu, sistemin
-- TASARLANDIĞI GİBİ çalışması, yeni bir hata değil. Admin panelinde bu
-- parse_error, bankFallbackCategory() içinde manual_required ile AYNI
-- "Manuel kontrol" etiketine düştüğü için kullanıcıya yanıltıcı göründü.
--
-- Bu migration YALNIZCA son bandın alt_limit'ini düzeltir. ust_limit,
-- yillik_brut_oran, vadesizde_kalacak, note HİÇBİRİ değişmez.
--
-- İdempotenttir: alt_limit zaten 20000000.01 ise hiçbir şey yapılmaz,
-- audit_log'a yeni kayıt eklenmez.
do $$
declare
  v_bank_id   uuid := 'b7b8297f-3f16-4c59-b962-cf28e37b7d25';
  v_band_id   uuid := 'a2716389-acda-4e71-bda0-84259f7e5bd7';
  v_actor_id  uuid;
  v_before    numeric;
  v_after     numeric := 20000000.01;
begin
  select alt_limit into v_before from public.bank_rates where id = v_band_id and bank_id = v_bank_id and is_active = true;
  if v_before is null then
    raise exception 'Odeabank son bandı bulunamadı (id=%) — migration iptal edildi.', v_band_id;
  end if;

  if round(v_before, 2) = v_after then
    raise notice 'Odeabank son bandı zaten kuruş-normalize edilmiş (alt_limit=%) — değişiklik yapılmadı (idempotent no-op).', v_after;
    return;
  end if;

  select id into v_actor_id from public.profiles where role = 'admin' order by id limit 1;
  if v_actor_id is null then
    raise exception 'Denetim kaydı için admin profili bulunamadı.';
  end if;

  update public.bank_rates set alt_limit = v_after where id = v_band_id;

  insert into public.audit_log (actor_id, action, entity_table, entity_id, diff)
  values (
    v_actor_id,
    'corrective_migration',
    'bank_rates',
    v_band_id,
    jsonb_build_object(
      'bank_id', v_bank_id,
      'reason', 'Son bant (20.000.000+ TL) hiç kuruş-normalize edilmemişti (alt_limit=20000001, olması gereken 20000000.01) — önceki 15 bantla tutarsız tek TL boşluğu vardı. Canlı sayfa zaten kuruş-hassasiyetli sınır yayımlıyor; yalnızca kayıtlı veri düzeltildi. yillik_brut_oran, ust_limit, vadesizde_kalacak değiştirilmedi.',
      'old_alt_limit', v_before,
      'new_alt_limit', v_after,
      'migration', '20260916120000_odeabank_band_normalization'
    )
  );

  raise notice 'Odeabank son bandı normalize edildi: alt_limit % -> %.', v_before, v_after;
end $$;
