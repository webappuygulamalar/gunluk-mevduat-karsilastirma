-- ============================================================================
-- TOM Bank asgari uygunluk sınırı düzeltmesi + "kabul edilmiş fark" mekanizması
--
-- 1) TOM Bank Günlük Kazandıran Hesap'ın resmi SSS bölümü şunu açıkça
--    belirtiyor: "Günlük Kazandıran Hesapta, hesap açma alt limit tutarı
--    5000 TL'dir. Banka tarafından belirlenen alt limit tutarının altında
--    hesap açılışı yapılamaz." Ayrıca oran tablosunun kendi "Alt Limit"
--    kolonu en düşük kademe için 7.500 TL diyor — yani yayınlanan kademeli
--    oran yapısı 7.500 TL'nin altını hiç kapsamıyor. Uygulamada bu bandın
--    alt_limit'i yanlışlıkla 0 idi; bu, 7.500 TL altındaki tutarlar için
--    TOM Bank'ı gerçekte sunulmayan bir oranla "uygun" gösteriyordu.
--    (Kaynak: https://tombank.com.tr/gunluk-kazandiran-hesap.html,
--    doğrulama: 2026-09-09.)
--
-- 2) Otomasyonun her gün AYNI, zaten incelenmiş, gerçek bir oran değişikliği
--    olmayan farkı (ör. bant sınırlarındaki 1 TL'lik yuvarlama) yeniden
--    "onay bekliyor" olarak açmaması için accepted_rate_differences tablosu
--    ve accept_rate_difference RPC'si eklendi. Bir admin bir farkı "kabul"
--    ettiğinde, aynı bant + aynı gözlemlenen değer (parmak izi) bir daha
--    yeni talep açmaz; yalnızca occurrence_count/last_checked_at güncellenir.
--    Kaynaktaki değer GERÇEKTEN değişirse parmak izi de değişir ve otomasyon
--    yeniden (haklı olarak) uyarır.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) TOM Bank alt limit düzeltmesi
-- ----------------------------------------------------------------------------

update public.bank_rates br
set alt_limit = 7500, updated_at = now()
from public.banks b
where br.bank_id = b.id
  and b.name = 'TOM Bank'
  and br.alt_limit = 0
  and br.ust_limit = 49999.99;

do $$
declare
  v_bank_id uuid;
  v_alt numeric;
begin
  select id into v_bank_id from public.banks where name = 'TOM Bank';
  select alt_limit into v_alt from public.bank_rates
    where bank_id = v_bank_id and ust_limit = 49999.99;

  if v_alt <> 7500 then
    raise exception 'Öz-doğrulama başarısız: TOM Bank ilk bandının alt limiti 7500 değil: %', v_alt;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 2) rate_check_findings: parmak izi + ham kaynak kanıtı kolonları
-- ----------------------------------------------------------------------------

alter table public.rate_check_findings
  add column if not exists fingerprint text,
  add column if not exists raw_evidence jsonb;

comment on column public.rate_check_findings.fingerprint is
  'bank_rate_id + gözlemlenen (kaynaktan ayrıştırılan) bant değerlerinin deterministik SHA-256 özeti. accepted_rate_differences ile eşleştirmede kullanılır.';
comment on column public.rate_check_findings.raw_evidence is
  'Kaynak sayfadan ayrıştırılan HAM metin değerleri (ör. "7.500", "49.999", "7.499 TL") — normalize edilmiş sayısal observed_value''den ayrı, admin panelinde "ham kaynak değeri" olarak gösterilir.';

alter table public.rate_check_findings drop constraint if exists rate_check_findings_finding_type_check;
alter table public.rate_check_findings add constraint rate_check_findings_finding_type_check
  check (finding_type in ('no_change', 'rate_changed', 'unreachable', 'parse_error', 'manual_required', 'accepted_difference'));

-- ----------------------------------------------------------------------------
-- 3) accepted_rate_differences — admin tarafından "kabul edilmiş" farklar
-- ----------------------------------------------------------------------------

create table if not exists public.accepted_rate_differences (
  id                   uuid primary key default gen_random_uuid(),
  bank_id              uuid not null references public.banks (id) on delete cascade,
  bank_rate_id         uuid not null references public.bank_rates (id) on delete cascade,
  fingerprint          text not null,
  raw_evidence         jsonb,
  normalized_value     jsonb not null,
  normalization_reason text not null,
  accepted_by          uuid references public.profiles (id) on delete set null,
  accepted_at          timestamptz not null default now(),
  occurrence_count     int not null default 1,
  last_checked_at      timestamptz not null default now(),
  last_run_id          uuid references public.rate_check_runs (id) on delete set null,
  unique (bank_rate_id, fingerprint)
);

comment on table public.accepted_rate_differences is
  'Bir admin tarafından "gerçek bir oran değişikliği değil" diye kabul edilmiş, kaynak-vs-kayıtlı bant farkları. Otomasyon aynı bant + aynı gözlemlenen değeri (fingerprint) tekrar bulursa yeni bir rate_change_requests açmaz, yalnızca occurrence_count/last_checked_at günceller. Gözlemlenen değer gerçekten değişirse fingerprint de değişir ve otomasyon yeniden uyarır.';

create index if not exists idx_accepted_rate_differences_bank_rate on public.accepted_rate_differences (bank_rate_id, fingerprint);

alter table public.accepted_rate_differences enable row level security;

revoke all on public.accepted_rate_differences from anon, authenticated;
grant select on public.accepted_rate_differences to authenticated;
grant select, insert, update on public.accepted_rate_differences to service_role;

drop policy if exists "accepted_rate_differences_select_admin_only" on public.accepted_rate_differences;
create policy "accepted_rate_differences_select_admin_only"
  on public.accepted_rate_differences for select
  to authenticated
  using (public.is_admin());

-- Kasıtlı olarak: insert/update/delete politikası YOK. Yazma yalnızca
-- accept_rate_difference RPC'si (admin onayı sonrası) veya Edge Function'ın
-- service_role bağlantısı (occurrence_count/last_checked_at güncellemesi)
-- üzerinden olur.

-- ----------------------------------------------------------------------------
-- 4) accept_rate_difference RPC — "Bu farkı kabul et" düğmesinin tek yazma yolu
-- ----------------------------------------------------------------------------

create or replace function public.accept_rate_difference(
  p_request_id uuid,
  p_reason text
)
returns public.accepted_rate_differences
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request  public.rate_change_requests;
  v_finding  public.rate_check_findings;
  v_result   public.accepted_rate_differences;
begin
  if not public.is_admin() then
    raise exception 'Bu işlemi yalnızca admin rolündeki kullanıcılar yapabilir.';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'Kabul gerekçesi zorunludur.';
  end if;

  select * into v_request
  from public.rate_change_requests
  where id = p_request_id
  for update;

  if v_request.id is null then
    raise exception 'Talep bulunamadı: %', p_request_id;
  end if;

  if v_request.status <> 'pending' then
    raise exception 'Bu talep zaten "%" durumunda.', v_request.status;
  end if;

  if v_request.bank_rate_id is null then
    raise exception 'Bu talep türü için "kabul et" uygulanamaz (bank_rate_id yok).';
  end if;

  select * into v_finding
  from public.rate_check_findings
  where rate_change_request_id = p_request_id
  order by created_at desc
  limit 1;

  if v_finding.id is null or v_finding.fingerprint is null then
    raise exception 'Bu talebe bağlı bir bulgu/parmak izi bulunamadı, "kabul et" uygulanamaz.';
  end if;

  insert into public.accepted_rate_differences (
    bank_id, bank_rate_id, fingerprint, raw_evidence, normalized_value,
    normalization_reason, accepted_by
  )
  values (
    v_request.bank_id, v_request.bank_rate_id, v_finding.fingerprint,
    v_finding.raw_evidence, v_request.previous_data, trim(p_reason), auth.uid()
  )
  on conflict (bank_rate_id, fingerprint) do update
    set normalization_reason = excluded.normalization_reason,
        accepted_by = excluded.accepted_by,
        accepted_at = now()
  returning * into v_result;

  update public.rate_change_requests
    set status      = 'rejected',
        reviewed_by = auth.uid(),
        reviewed_at = now(),
        review_note = 'Fark kabul edildi (gerçek oran değişikliği değil): ' || trim(p_reason)
    where id = p_request_id;

  insert into public.audit_log (actor_id, action, entity_table, entity_id, diff)
  values (
    auth.uid(),
    'rate_difference_accepted',
    'accepted_rate_differences',
    v_result.id,
    jsonb_build_object(
      'request_id', p_request_id,
      'bank_rate_id', v_request.bank_rate_id,
      'fingerprint', v_finding.fingerprint,
      'reason', p_reason
    )
  );

  return v_result;
end;
$$;

revoke all on function public.accept_rate_difference(uuid, text) from public;
grant execute on function public.accept_rate_difference(uuid, text) to authenticated;
