-- ============================================================================
-- Akbank Serbest Plus Hesap — 25.000.000 TL sınır düzeltmesi
--
-- Önceki migration (20260908100000) sınırı yanlış yerleştirmişti: tam
-- 25.000.000 TL'yi %4,00 bandına dahil ediyordu. Resmi Akbank tablosuna göre
-- doğrusu: "10.000 TL - 25.000.000 TL" (25M DAHİL) %38,50, "25.000.000 TL
-- üzeri" (25M'in KENDİSİ HARİÇ, yalnızca üzeri) %4,00. Bu yüzden ilk bandın
-- üst limiti 25.000.000 TL (dahil), ikinci bandın alt limiti 25.000.000,01
-- TL olmalı — tam 25.000.000 TL yatıran biri hep %38,50 almalı.
-- ============================================================================

update public.bank_rates br
set ust_limit = 25000000, updated_at = now()
from public.banks b
where br.bank_id = b.id
  and b.name = 'Akbank Serbest Plus Hesap'
  and br.alt_limit = 10000
  and br.ust_limit = 24999999.99;

update public.bank_rates br
set alt_limit = 25000000.01, updated_at = now()
from public.banks b
where br.bank_id = b.id
  and b.name = 'Akbank Serbest Plus Hesap'
  and br.alt_limit = 25000000
  and br.yillik_brut_oran = 0.04;

-- Öz-doğrulama: tam 25.000.000 TL'nin %38,50 bandına düştüğünü, çakışma/
-- boşluk olmadığını doğrula.
do $$
declare
  v_bank_id uuid;
  v_tier1_ust numeric;
  v_tier2_alt numeric;
begin
  select id into v_bank_id from public.banks where name = 'Akbank Serbest Plus Hesap';

  select ust_limit into v_tier1_ust from public.bank_rates
    where bank_id = v_bank_id and yillik_brut_oran = 0.385;
  select alt_limit into v_tier2_alt from public.bank_rates
    where bank_id = v_bank_id and yillik_brut_oran = 0.04;

  if v_tier1_ust <> 25000000 then
    raise exception 'Öz-doğrulama başarısız: %%38,50 bandının üst limiti 25.000.000 değil: %', v_tier1_ust;
  end if;
  if v_tier2_alt <> 25000000.01 then
    raise exception 'Öz-doğrulama başarısız: %%4,00 bandının alt limiti 25.000.000,01 değil: %', v_tier2_alt;
  end if;
end $$;
