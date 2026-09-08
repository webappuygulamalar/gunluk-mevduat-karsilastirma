// Bu ekran ayrı, yerel/test amaçlı bir yönetim panelidir.
// Mevcut kullanıcı uygulamasından (app.js) tamamen bağımsızdır.
//
// Burada YALNIZCA proje URL'si ve anon/publishable key kullanılır — bunlar
// tarayıcıda çalışması için tasarlanmış, gizli olmayan değerlerdir. Gerçek
// erişim kontrolü Supabase RLS politikaları tarafından sağlanır. service_role
// anahtarı veya veritabanı şifresi bu dosyada YOKTUR ve olmamalıdır.
const SUPABASE_URL = "https://zlvezpwheycdvzsszrqu.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_u3slgRop1E6jLLJVSprLnA_RZPkgy-g";

const client = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const EDGE_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/check-bank-rates`;

const loginView = document.getElementById("login-view");
const deniedView = document.getElementById("denied-view");
const adminView = document.getElementById("admin-view");

const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");
const deniedMessage = document.getElementById("denied-message");
const whoami = document.getElementById("whoami");
const toast = document.getElementById("toast");

const ratesTbody = document.getElementById("rates-tbody");
const requestsTbody = document.getElementById("requests-tbody");
const auditTbody = document.getElementById("audit-tbody");

const proposalCard = document.getElementById("proposal-card");
const proposalTitle = document.getElementById("proposal-title");
const proposalForm = document.getElementById("proposal-form");
const proposalError = document.getElementById("proposal-error");

const runCheckBtn = document.getElementById("run-check-btn");
const dailyCheckTbody = document.getElementById("daily-check-tbody");
const statLastRun = document.getElementById("stat-last-run");
const statChecked = document.getElementById("stat-checked");
const statNoChange = document.getElementById("stat-nochange");
const statChanged = document.getElementById("stat-changed");
const statWarnings = document.getElementById("stat-warnings");
const statUnreachable = document.getElementById("stat-unreachable");
const statManual = document.getElementById("stat-manual");

const manualEditDialog = document.getElementById("manual-edit-dialog");
const manualEditTitle = document.getElementById("manual-edit-title");
const manualEditForm = document.getElementById("manual-edit-form");
const manualEditError = document.getElementById("manual-edit-error");

let currentUser = null;
let activeRatesById = new Map();
let proposalContext = null; // { rate, mode: 'update' | 'disable' }
let manualEditContext = null; // { rate }

const percentFmt = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const numberFmt = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 2 });

function showView(view) {
  loginView.hidden = view !== "login";
  deniedView.hidden = view !== "denied";
  adminView.hidden = view !== "admin";
}

function showToast(message, isError) {
  toast.textContent = message;
  toast.hidden = false;
  toast.className = "toast" + (isError ? " toast-error" : " toast-ok");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { toast.hidden = true; }, 4000);
}

function fmtMoney(n) {
  return n === null || n === undefined ? "—" : numberFmt.format(n) + " TL";
}

function fmtPercent(n) {
  return n === null || n === undefined ? "—" : percentFmt.format(n * 100) + " %";
}

// ---------------------------------------------------------------------------
// Oturum / yetki kontrolü
// ---------------------------------------------------------------------------

async function handleSession(session) {
  if (!session || !session.user) {
    currentUser = null;
    showView("login");
    return;
  }

  currentUser = session.user;

  const { data: profile, error } = await client
    .from("profiles")
    .select("role")
    .eq("id", currentUser.id)
    .maybeSingle();

  if (error) {
    deniedMessage.textContent = "Profil bilgisi okunamadı: " + error.message;
    showView("denied");
    return;
  }

  if (!profile || profile.role !== "admin") {
    const role = profile ? profile.role : "tanımsız";
    deniedMessage.textContent = `Bu hesabın rolü "${role}". Yönetim ekranına yalnızca admin rolündeki kullanıcılar erişebilir.`;
    showView("denied");
    return;
  }

  whoami.textContent = `Giriş yapan: ${currentUser.email} (rol: admin)`;
  showView("admin");
  await loadAll();
}

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.hidden = true;
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;

  const submitBtn = document.getElementById("login-submit");
  submitBtn.disabled = true;
  submitBtn.textContent = "Giriş yapılıyor…";

  const { error } = await client.auth.signInWithPassword({ email, password });

  submitBtn.disabled = false;
  submitBtn.textContent = "Giriş Yap";

  if (error) {
    loginError.textContent = error.message;
    loginError.hidden = false;
  }
});

async function logout() {
  await client.auth.signOut();
}

document.getElementById("logout-btn").addEventListener("click", logout);
document.getElementById("denied-logout").addEventListener("click", logout);

// ---------------------------------------------------------------------------
// Listeleme
// ---------------------------------------------------------------------------

async function loadAll() {
  await Promise.all([loadActiveRates(), loadRequests(), loadAuditLog(), loadDailyCheck(), loadAcceptedDiffs()]);
}

async function loadActiveRates() {
  ratesTbody.innerHTML = `<tr><td colspan="8" class="muted">Yükleniyor…</td></tr>`;

  const { data, error } = await client
    .from("bank_rates")
    .select(
      "id, bank_id, alt_limit, ust_limit, vadesizde_kalacak, yillik_brut_oran, note, gerekli_fon_bakiyesi, vadesiz_hesaplama_tipi, vadesiz_oran, banks(name)"
    )
    .eq("is_active", true)
    .order("name", { referencedTable: "banks" })
    .order("alt_limit");

  if (error) {
    ratesTbody.innerHTML = `<tr><td colspan="8" class="error-text">Hata: ${error.message}</td></tr>`;
    return;
  }

  activeRatesById = new Map(data.map((r) => [r.id, r]));

  if (data.length === 0) {
    ratesTbody.innerHTML = `<tr><td colspan="8" class="muted">Aktif oran aralığı bulunamadı.</td></tr>`;
    return;
  }

  ratesTbody.innerHTML = "";
  for (const r of data) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(r.banks ? r.banks.name : r.bank_id)}</td>
      <td>${fmtMoney(r.alt_limit)}</td>
      <td>${fmtMoney(r.ust_limit)}</td>
      <td>${fmtMoney(r.vadesizde_kalacak)}</td>
      <td>${fmtPercent(r.yillik_brut_oran)}</td>
      <td>${r.gerekli_fon_bakiyesi ? fmtMoney(r.gerekli_fon_bakiyesi) : "—"}</td>
      <td>${r.note ? `<button type="button" class="link-btn" data-action="show-note" data-id="${r.id}">Notu Gör</button>` : `<span class="muted">—</span>`}</td>
      <td class="actions-cell">
        <button type="button" class="link-btn" data-action="update" data-id="${r.id}">Güncelle Öner</button>
        <button type="button" class="link-btn danger" data-action="disable" data-id="${r.id}">Pasifleştir Öner</button>
        <button type="button" class="link-btn" data-action="manual-edit" data-id="${r.id}">Kaydet ve Yayınla</button>
      </td>
    `;
    ratesTbody.appendChild(tr);
  }
}

ratesTbody.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const rate = activeRatesById.get(btn.dataset.id);
  if (!rate) return;
  if (btn.dataset.action === "update") {
    openProposalForm(rate, "update");
  } else if (btn.dataset.action === "disable") {
    submitDisableProposal(rate);
  } else if (btn.dataset.action === "show-note") {
    openNoteDialog(rate.note);
  } else if (btn.dataset.action === "manual-edit") {
    openManualEditDialog(rate);
  }
});

// ---------------------------------------------------------------------------
// Manuel düzeltme ("Kaydet ve Yayınla") — öneri kuyruğunu atlayıp
// admin_update_bank_rate RPC'siyle DOĞRUDAN yayınlar. Tarayıcıdan bank_rates
// tablosuna hiçbir zaman doğrudan insert/update/delete yapılmaz.
// ---------------------------------------------------------------------------

function openManualEditDialog(rate) {
  manualEditContext = { rate };
  manualEditTitle.textContent = `Manuel Düzeltme — ${rate.banks ? rate.banks.name : rate.bank_id}`;
  document.getElementById("m-alt-limit").value = rate.alt_limit;
  document.getElementById("m-ust-limit").value = rate.ust_limit;
  document.getElementById("m-vadesiz").value = rate.vadesizde_kalacak;
  document.getElementById("m-vadesiz-tipi").value = rate.vadesiz_hesaplama_tipi || "sabit";
  document.getElementById("m-vadesiz-oran").value = rate.vadesiz_oran ?? "";
  document.getElementById("m-oran").value = rate.yillik_brut_oran;
  document.getElementById("m-fon").value = rate.gerekli_fon_bakiyesi ?? "";
  document.getElementById("m-not").value = rate.note ?? "";
  manualEditError.hidden = true;
  manualEditDialog.showModal();
}

document.getElementById("manual-edit-cancel").addEventListener("click", () => {
  manualEditDialog.close();
  manualEditContext = null;
});

manualEditForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!manualEditContext) return;

  const vadesizTipi = document.getElementById("m-vadesiz-tipi").value;
  const vadesizOranRaw = document.getElementById("m-vadesiz-oran").value;
  const fonRaw = document.getElementById("m-fon").value;

  const params = {
    p_rate_id: manualEditContext.rate.id,
    p_alt_limit: Number(document.getElementById("m-alt-limit").value),
    p_ust_limit: Number(document.getElementById("m-ust-limit").value),
    p_vadesizde_kalacak: Number(document.getElementById("m-vadesiz").value),
    p_yillik_brut_oran: Number(document.getElementById("m-oran").value),
    p_note: document.getElementById("m-not").value,
    p_gerekli_fon_bakiyesi: fonRaw === "" ? null : Number(fonRaw),
    p_vadesiz_hesaplama_tipi: vadesizTipi,
    p_vadesiz_oran: vadesizOranRaw === "" ? null : Number(vadesizOranRaw),
  };

  if (
    !confirm(
      "Bu değerler öneri/onay adımı olmadan DOĞRUDAN yayınlanacak. Resmi kaynağı kendiniz kontrol ettiğinizden emin misiniz?"
    )
  ) {
    return;
  }

  const submitBtn = document.getElementById("manual-edit-submit");
  submitBtn.disabled = true;

  const { error } = await client.rpc("admin_update_bank_rate", params);

  submitBtn.disabled = false;

  if (error) {
    manualEditError.textContent = "Hata: " + error.message;
    manualEditError.hidden = false;
    return;
  }

  manualEditDialog.close();
  manualEditContext = null;
  showToast("Değer doğrudan güncellendi ve yayınlandı.", false);
  await loadAll();
});

// ---------------------------------------------------------------------------
// Ürün notu detay penceresi
// ---------------------------------------------------------------------------

const noteDialog = document.getElementById("note-dialog");
const noteDialogText = document.getElementById("note-dialog-text");

function openNoteDialog(noteText) {
  noteDialogText.textContent = noteText || "";
  noteDialog.showModal();
}

document.getElementById("note-dialog-close").addEventListener("click", () => {
  noteDialog.close();
});

// Dışına (backdrop'a) tıklayınca kapat. Escape tuşu <dialog>'un kendi
// davranışıyla zaten çalışır, ekstra kod gerekmez.
noteDialog.addEventListener("click", (e) => {
  const rect = noteDialog.getBoundingClientRect();
  const clickedInside =
    e.clientX >= rect.left && e.clientX <= rect.right &&
    e.clientY >= rect.top && e.clientY <= rect.bottom;
  if (!clickedInside) {
    noteDialog.close();
  }
});

function openProposalForm(rate, mode) {
  proposalContext = { rate, mode };
  proposalTitle.textContent = `Değişiklik Öner — ${rate.banks ? rate.banks.name : rate.bank_id}`;
  document.getElementById("p-alt-limit").value = rate.alt_limit;
  document.getElementById("p-ust-limit").value = rate.ust_limit;
  document.getElementById("p-vadesiz").value = rate.vadesizde_kalacak;
  document.getElementById("p-vadesiz-tipi").value = rate.vadesiz_hesaplama_tipi || "sabit";
  document.getElementById("p-vadesiz-oran").value = rate.vadesiz_oran ?? "";
  document.getElementById("p-oran").value = rate.yillik_brut_oran;
  document.getElementById("p-fon").value = rate.gerekli_fon_bakiyesi ?? "";
  document.getElementById("p-not").value = rate.note ?? "";
  proposalError.hidden = true;
  proposalCard.hidden = false;
  proposalCard.scrollIntoView({ behavior: "smooth", block: "start" });
}

document.getElementById("proposal-cancel").addEventListener("click", () => {
  proposalCard.hidden = true;
  proposalContext = null;
});

proposalForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!proposalContext) return;
  const { rate } = proposalContext;

  const fonRaw = document.getElementById("p-fon").value;
  const vadesizOranRaw = document.getElementById("p-vadesiz-oran").value;
  const proposedData = {
    alt_limit: Number(document.getElementById("p-alt-limit").value),
    ust_limit: Number(document.getElementById("p-ust-limit").value),
    vadesizde_kalacak: Number(document.getElementById("p-vadesiz").value),
    vadesiz_hesaplama_tipi: document.getElementById("p-vadesiz-tipi").value,
    vadesiz_oran: vadesizOranRaw === "" ? null : Number(vadesizOranRaw),
    yillik_brut_oran: Number(document.getElementById("p-oran").value),
    gerekli_fon_bakiyesi: fonRaw === "" ? null : Number(fonRaw),
    note: document.getElementById("p-not").value,
  };

  const previousData = {
    alt_limit: rate.alt_limit,
    ust_limit: rate.ust_limit,
    vadesizde_kalacak: rate.vadesizde_kalacak,
    yillik_brut_oran: rate.yillik_brut_oran,
    gerekli_fon_bakiyesi: rate.gerekli_fon_bakiyesi,
    note: rate.note,
  };

  const submitBtn = document.getElementById("proposal-submit");
  submitBtn.disabled = true;

  const { error } = await client.from("rate_change_requests").insert({
    bank_rate_id: rate.id,
    bank_id: rate.bank_id,
    change_type: "update",
    proposed_data: proposedData,
    previous_data: previousData,
    requested_by: currentUser.id,
    status: "pending",
  });

  submitBtn.disabled = false;

  if (error) {
    proposalError.textContent = "Hata: " + error.message;
    proposalError.hidden = false;
    return;
  }

  proposalCard.hidden = true;
  proposalContext = null;
  showToast("Değişiklik önerisi onaya gönderildi.", false);
  await loadRequests();
});

async function submitDisableProposal(rate) {
  if (!confirm(`${rate.banks ? rate.banks.name : rate.bank_id} bankasının bu bandını pasifleştirme önerisi gönderilsin mi?`)) {
    return;
  }

  const previousData = {
    alt_limit: rate.alt_limit,
    ust_limit: rate.ust_limit,
    vadesizde_kalacak: rate.vadesizde_kalacak,
    yillik_brut_oran: rate.yillik_brut_oran,
    gerekli_fon_bakiyesi: rate.gerekli_fon_bakiyesi,
    note: rate.note,
  };

  const { error } = await client.from("rate_change_requests").insert({
    bank_rate_id: rate.id,
    bank_id: rate.bank_id,
    change_type: "disable",
    proposed_data: {},
    previous_data: previousData,
    requested_by: currentUser.id,
    status: "pending",
  });

  if (error) {
    showToast("Hata: " + error.message, true);
    return;
  }

  showToast("Pasifleştirme önerisi onaya gönderildi.", false);
  await loadRequests();
}

// ---------------------------------------------------------------------------
// Değişiklik talepleri
// ---------------------------------------------------------------------------

const PROPOSED_FIELD_LABELS = [
  ["alt_limit", "Alt Limit", fmtMoney],
  ["ust_limit", "Üst Limit", fmtMoney],
  ["vadesizde_kalacak", "Vadesizde Kalacak", fmtMoney],
  ["yillik_brut_oran", "Yıllık Brüt Oran", fmtPercent],
];

// Önerilen değerleri ham JSON olarak değil, Türkçe/okunabilir alanlar
// halinde ve tabloyu bozmayacak şekilde katlanır bir blokta gösterir.
function renderProposalCell(request) {
  if (request.change_type === "disable") {
    return `<span class="muted">Bandı pasifleştir</span>`;
  }

  const data = request.proposed_data || {};
  const rows = [];

  for (const [key, label, formatter] of PROPOSED_FIELD_LABELS) {
    if (data[key] !== undefined && data[key] !== null) {
      rows.push([label, formatter(data[key])]);
    }
  }
  if (data.vadesiz_hesaplama_tipi === "yuzde" && data.vadesiz_oran !== undefined && data.vadesiz_oran !== null) {
    rows.push(["Vadesiz Oranı", `Bakiyenin %${numberFmt.format(data.vadesiz_oran)}'i`]);
  }
  if (data.gerekli_fon_bakiyesi) {
    rows.push(["Gerekli Fon", fmtMoney(data.gerekli_fon_bakiyesi)]);
  }
  if (data.note) {
    rows.push(["Not", escapeHtml(data.note)]);
  }

  if (rows.length === 0) {
    return `<span class="muted">—</span>`;
  }

  const dl = rows.map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`).join("");
  return `
    <details class="proposal-details">
      <summary>Detayları Göster</summary>
      <dl class="proposal-fields">${dl}</dl>
    </details>
  `;
}

async function loadRequests() {
  requestsTbody.innerHTML = `<tr><td colspan="7" class="muted">Yükleniyor…</td></tr>`;

  const { data, error } = await client
    .from("rate_change_requests")
    .select("id, change_type, status, proposed_data, requested_at, review_note, banks(name)")
    .order("requested_at", { ascending: false })
    .limit(50);

  if (error) {
    requestsTbody.innerHTML = `<tr><td colspan="7" class="error-text">Hata: ${error.message}</td></tr>`;
    return;
  }

  if (data.length === 0) {
    requestsTbody.innerHTML = `<tr><td colspan="7" class="muted">Henüz bir değişiklik talebi yok.</td></tr>`;
    return;
  }

  requestsTbody.innerHTML = "";
  for (const r of data) {
    const tr = document.createElement("tr");
    const statusBadge = `<span class="badge badge-${r.status}">${r.status}</span>`;
    const proposedSummary = renderProposalCell(r);

    const actionsHtml = r.status === "pending"
      ? `
        <button type="button" class="link-btn" data-req-action="approve" data-req-id="${r.id}">Onayla</button>
        <button type="button" class="link-btn danger" data-req-action="reject" data-req-id="${r.id}">Reddet</button>
      `
      : "—";

    tr.innerHTML = `
      <td>${escapeHtml(r.banks ? r.banks.name : "")}</td>
      <td>${escapeHtml(r.change_type)}</td>
      <td>${statusBadge}</td>
      <td class="note-cell">${proposedSummary}</td>
      <td>${new Date(r.requested_at).toLocaleString("tr-TR")}</td>
      <td class="note-cell">${escapeHtml(r.review_note || "")}</td>
      <td class="actions-cell">${actionsHtml}</td>
    `;
    requestsTbody.appendChild(tr);
  }
}

requestsTbody.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-req-action]");
  if (!btn) return;
  const requestId = btn.dataset.reqId;
  const action = btn.dataset.reqAction;

  const note = prompt(action === "approve" ? "Onay notu (opsiyonel):" : "Red gerekçesi (opsiyonel):") || null;

  btn.disabled = true;
  const rpcName = action === "approve" ? "approve_rate_change" : "reject_rate_change";
  const { error } = await client.rpc(rpcName, { p_request_id: requestId, p_review_note: note });
  btn.disabled = false;

  if (error) {
    showToast("Hata: " + error.message, true);
    return;
  }

  showToast(action === "approve" ? "Talep onaylandı." : "Talep reddedildi.", false);
  await loadAll();
});

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

async function loadAuditLog() {
  auditTbody.innerHTML = `<tr><td colspan="4" class="muted">Yükleniyor…</td></tr>`;

  const { data, error } = await client
    .from("audit_log")
    .select("id, action, entity_table, created_at, diff")
    .order("created_at", { ascending: false })
    .limit(15);

  if (error) {
    auditTbody.innerHTML = `<tr><td colspan="4" class="error-text">Hata: ${error.message}</td></tr>`;
    return;
  }

  if (data.length === 0) {
    auditTbody.innerHTML = `<tr><td colspan="4" class="muted">Henüz bir kayıt yok.</td></tr>`;
    return;
  }

  auditTbody.innerHTML = "";
  for (const a of data) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${new Date(a.created_at).toLocaleString("tr-TR")}</td>
      <td>${escapeHtml(a.action)}</td>
      <td>${escapeHtml(a.entity_table)}</td>
      <td class="note-cell">${escapeHtml(JSON.stringify(a.diff))}</td>
    `;
    auditTbody.appendChild(tr);
  }
}

// ---------------------------------------------------------------------------
// Günlük Kontrol ve Uyarılar
// ---------------------------------------------------------------------------

// Dört net kategori (görev talimatı gereği "11/11 kontrol edildi" tek başına
// bir başarı ifadesi değildir — her kategori ayrı sayılır):
//   1) Otomatik doğrulandı — değişiklik yok  (no_change, accepted_difference)
//   2) Değişiklik bulundu — onay bekliyor    (rate_changed)
//   3) Manuel kontrol gerekli                (manual_required, parse_error)
//   4) Kaynağa ulaşılamadı                   (unreachable)
const FINDING_STATUS_LABEL = {
  no_change: "Otomatik doğrulandı — değişiklik yok",
  accepted_difference: "Otomatik doğrulandı — değişiklik yok",
  rate_changed: "Değişiklik bulundu — onay bekliyor",
  unreachable: "Kaynağa ulaşılamadı",
  parse_error: "Manuel kontrol gerekli",
  manual_required: "Manuel kontrol gerekli",
  not_attempted: "Henüz kontrol edilmedi",
};

const CATEGORY_OF_FINDING = {
  no_change: "ok",
  accepted_difference: "ok",
  rate_changed: "pending",
  parse_error: "manual",
  manual_required: "manual",
  unreachable: "unreachable",
};

function fmtDateTime(iso) {
  return iso ? new Date(iso).toLocaleString("tr-TR") : "—";
}

// Bir kaynağın birden fazla bulgusu olabilir (ör. birden çok bant değişmiş);
// gösterilecek TEK durum, önem sırasına göre belirlenir (Edge Function'daki
// aynı öncelik sırasıyla tutarlı): rate_changed > parse_error/unreachable >
// manual_required > accepted_difference/no_change.
function dailyCheckStatusOf(findingsForSource) {
  if (!findingsForSource || findingsForSource.length === 0) return "not_attempted";
  const types = findingsForSource.map((f) => f.finding_type);
  if (types.includes("rate_changed")) return "rate_changed";
  if (types.includes("parse_error")) return "parse_error";
  if (types.includes("unreachable")) return "unreachable";
  if (types.includes("manual_required")) return "manual_required";
  if (types.includes("accepted_difference")) return "accepted_difference";
  return "no_change";
}

function fmtBandShort(v) {
  if (!v) return "—";
  const oran = v.yillik_brut_oran !== undefined ? fmtPercent(v.yillik_brut_oran) : "—";
  const vadesiz =
    v.vadesiz_hesaplama_tipi === "yuzde"
      ? `bakiyenin %${numberFmt.format(v.vadesiz_oran ?? 0)}'i`
      : fmtMoney(v.vadesizde_kalacak);
  return `${fmtMoney(v.alt_limit)}–${fmtMoney(v.ust_limit)} · ${oran} · vadesiz: ${vadesiz}`;
}

function renderRawEvidence(raw) {
  if (!raw || Object.keys(raw).length === 0) return "";
  const dl = Object.entries(raw)
    .map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`)
    .join("");
  return `<details class="raw-evidence-box"><summary>Ham kaynak değerini göster</summary><dl>${dl}</dl></details>`;
}

async function loadDailyCheck() {
  dailyCheckTbody.innerHTML = `<tr><td colspan="6" class="muted">Yükleniyor…</td></tr>`;

  const { data: lastRun } = await client
    .from("rate_check_runs")
    .select("id, started_at, finished_at, status, sources_checked, sources_unreachable, findings_created, dry_run")
    .eq("dry_run", false)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: sources, error: sourcesErr } = await client
    .from("bank_sources")
    .select(
      "id, bank_id, source_url, requires_manual_check, last_checked_at, last_check_status, banks(name)"
    )
    .order("created_at", { ascending: true });

  if (sourcesErr || !sources) {
    dailyCheckTbody.innerHTML = `<tr><td colspan="6" class="error-text">Hata: ${sourcesErr ? sourcesErr.message : "bank_sources okunamadı"}</td></tr>`;
    return;
  }

  const { data: currentRateRows } = await client
    .from("bank_rates")
    .select("bank_id, yillik_brut_oran")
    .eq("is_active", true);

  const ratesByBank = new Map();
  for (const r of currentRateRows || []) {
    if (!ratesByBank.has(r.bank_id)) ratesByBank.set(r.bank_id, []);
    ratesByBank.get(r.bank_id).push(Number(r.yillik_brut_oran));
  }

  function summarizeCurrentRate(bankId) {
    const rates = ratesByBank.get(bankId);
    if (!rates || rates.length === 0) return "—";
    const min = Math.min(...rates);
    const max = Math.max(...rates);
    const range = min === max ? fmtPercent(min) : `${fmtPercent(min)} – ${fmtPercent(max)}`;
    return rates.length > 1 ? `${range} (${rates.length} bant)` : range;
  }

  let findings = [];
  if (lastRun) {
    const { data: findingsData } = await client
      .from("rate_check_findings")
      .select(
        "id, bank_source_id, bank_id, finding_type, current_value, observed_value, evidence_url, detail, fingerprint, raw_evidence, rate_change_request_id, rate_change_requests(id, status)"
      )
      .eq("run_id", lastRun.id);
    findings = findingsData || [];
  }

  const findingsBySource = new Map();
  for (const f of findings) {
    if (!findingsBySource.has(f.bank_source_id)) findingsBySource.set(f.bank_source_id, []);
    findingsBySource.get(f.bank_source_id).push(f);
  }

  // Üst özet — dört net kategori (bir kaynak birden fazla bulgu üretmiş
  // olsa bile, o kaynak yalnızca dailyCheckStatusOf'un belirlediği TEK
  // (en yüksek öncelikli) kategoriye sayılır; toplam = kaynak sayısı).
  statLastRun.textContent = lastRun ? fmtDateTime(lastRun.started_at) : "Henüz çalışmadı";
  statChecked.textContent = sources.length ? String(sources.length) : "—";

  const categoryCounts = { ok: 0, pending: 0, manual: 0, unreachable: 0, none: 0 };
  for (const source of sources) {
    const status = dailyCheckStatusOf(findingsBySource.get(source.id));
    const category = status === "not_attempted" ? "none" : CATEGORY_OF_FINDING[status] ?? "none";
    categoryCounts[category]++;
  }
  statNoChange.textContent = String(categoryCounts.ok);
  statChanged.textContent = String(categoryCounts.pending);
  statManual.textContent = String(categoryCounts.manual);
  statUnreachable.textContent = String(categoryCounts.unreachable);

  const summarySentenceEl = document.getElementById("check-summary-sentence");
  if (summarySentenceEl) {
    const parts = [`${sources.length} ürün kontrol edildi`];
    parts.push(`${categoryCounts.ok} otomatik doğrulandı`);
    parts.push(`${categoryCounts.pending} onay bekliyor`);
    parts.push(`${categoryCounts.manual} manuel kontrol gerekli`);
    parts.push(`${categoryCounts.unreachable} kaynağa ulaşılamadı`);
    if (categoryCounts.none > 0) parts.push(`${categoryCounts.none} henüz kontrol edilmedi`);
    summarySentenceEl.textContent = parts.join(", ") + ".";
  }

  if (sources.length === 0) {
    dailyCheckTbody.innerHTML = `<tr><td colspan="6" class="muted">Henüz kaynak tanımlı değil.</td></tr>`;
    return;
  }

  dailyCheckTbody.innerHTML = "";
  for (const source of sources) {
    const sourceFindings = findingsBySource.get(source.id) || [];
    const status = dailyCheckStatusOf(sourceFindings);
    const bankName = source.banks ? source.banks.name : source.bank_id;

    const tr = document.createElement("tr");
    const statusCell = `<span class="status-badge status-${status}">${FINDING_STATUS_LABEL[status]}</span>`;

    let currentCell = escapeHtml(summarizeCurrentRate(source.bank_id));
    let foundCell = "—";

    if (status === "rate_changed") {
      const changedFindings = sourceFindings.filter((f) => f.finding_type === "rate_changed");
      const parts = [];
      for (const f of changedFindings) {
        const reqStatus = f.rate_change_requests ? f.rate_change_requests.status : null;
        const oldNew = `
          <div class="diff-box">
            <div><span class="muted">Kayıtlı (normalize edilmiş):</span> <span class="diff-old">${escapeHtml(fmtBandShort(f.current_value))}</span></div>
            <div><span class="muted">Kaynakta bulunan (normalize edilmiş):</span> <span class="diff-new">${escapeHtml(fmtBandShort(f.observed_value))}</span></div>
          </div>
          ${renderRawEvidence(f.raw_evidence)}`;
        let actions = "—";
        if (reqStatus === "pending" && f.rate_change_request_id) {
          actions = `
            <button type="button" class="link-btn" data-req-action="approve" data-req-id="${f.rate_change_request_id}">Onayla ve Yayınla</button>
            <button type="button" class="link-btn danger" data-req-action="reject" data-req-id="${f.rate_change_request_id}">Reddet</button>
            <button type="button" class="link-btn" data-accept-diff-btn data-req-id="${f.rate_change_request_id}"
              data-current="${escapeHtml(fmtBandShort(f.current_value))}" data-observed="${escapeHtml(fmtBandShort(f.observed_value))}">Bu farkı kabul et</button>
          `;
        } else if (reqStatus) {
          actions = `<span class="muted">${escapeHtml(reqStatus)}</span>`;
        }
        parts.push(`<div class="daily-check-finding">${oldNew}<div class="actions-cell">${actions}</div></div>`);
      }
      foundCell = parts.join("");
    } else if (status === "parse_error" || status === "unreachable" || status === "manual_required") {
      const detail = sourceFindings.map((f) => f.detail).filter(Boolean).join(" ");
      foundCell = `<div class="warning-box">${escapeHtml(detail || FINDING_STATUS_LABEL[status])}</div>`;
    } else if (status === "no_change" || status === "accepted_difference") {
      const acceptedFindings = sourceFindings.filter((f) => f.finding_type === "accepted_difference");
      if (acceptedFindings.length > 0) {
        foundCell = acceptedFindings
          .map(
            (f) => `
              <div class="daily-check-finding">
                <div class="diff-box">
                  <div><span class="muted">Kayıtlı (normalize edilmiş):</span> ${escapeHtml(fmtBandShort(f.current_value))}</div>
                  <div><span class="muted">Kaynakta bulunan (kabul edilmiş fark):</span> ${escapeHtml(fmtBandShort(f.observed_value))}</div>
                </div>
                ${renderRawEvidence(f.raw_evidence)}
              </div>`
          )
          .join("");
      } else {
        foundCell = `<span class="muted">—</span>`;
      }
    }

    tr.innerHTML = `
      <td>${escapeHtml(bankName)}</td>
      <td>${statusCell}</td>
      <td>${fmtDateTime(source.last_checked_at)}</td>
      <td><a href="${escapeHtml(source.source_url)}" target="_blank" rel="noopener">Kaynağı Aç</a></td>
      <td>${currentCell}</td>
      <td class="note-cell">${foundCell}</td>
    `;
    dailyCheckTbody.appendChild(tr);
  }
}

dailyCheckTbody.addEventListener("click", async (e) => {
  const acceptBtn = e.target.closest("button[data-accept-diff-btn]");
  if (acceptBtn) {
    openAcceptDiffDialog(acceptBtn.dataset.reqId, acceptBtn.dataset.current, acceptBtn.dataset.observed);
    return;
  }

  const btn = e.target.closest("button[data-req-action]");
  if (!btn) return;
  const requestId = btn.dataset.reqId;
  const action = btn.dataset.reqAction;

  const note = prompt(action === "approve" ? "Onay notu (opsiyonel):" : "Red gerekçesi (opsiyonel):") || null;

  btn.disabled = true;
  const rpcName = action === "approve" ? "approve_rate_change" : "reject_rate_change";
  const { error } = await client.rpc(rpcName, { p_request_id: requestId, p_review_note: note });
  btn.disabled = false;

  if (error) {
    showToast("Hata: " + error.message, true);
    return;
  }

  showToast(action === "approve" ? "Değişiklik onaylandı ve yayınlandı." : "Değişiklik reddedildi.", false);
  await loadAll();
});

// ---------------------------------------------------------------------------
// "Bu farkı kabul et" — accept_rate_difference RPC'sinin tek çağırıcısı.
// Kayıtlı veriyi DEĞİŞTİRMEZ; yalnızca bu bant + bu gözlemlenen değeri
// "gerçek bir oran değişikliği değil" olarak işaretler ve talebi kapatır.
// ---------------------------------------------------------------------------

const acceptDiffDialog = document.getElementById("accept-diff-dialog");
const acceptDiffForm = document.getElementById("accept-diff-form");
const acceptDiffError = document.getElementById("accept-diff-error");
const acceptDiffValues = document.getElementById("accept-diff-values");
let acceptDiffContext = null; // { requestId }

function openAcceptDiffDialog(requestId, currentText, observedText) {
  acceptDiffContext = { requestId };
  acceptDiffValues.innerHTML = `
    <dt>Kayıtlı (normalize edilmiş)</dt><dd>${escapeHtml(currentText || "—")}</dd>
    <dt>Kaynakta bulunan (normalize edilmiş)</dt><dd>${escapeHtml(observedText || "—")}</dd>
  `;
  document.getElementById("accept-diff-reason").value = "";
  acceptDiffError.hidden = true;
  acceptDiffDialog.showModal();
}

document.getElementById("accept-diff-cancel").addEventListener("click", () => {
  acceptDiffDialog.close();
  acceptDiffContext = null;
});

acceptDiffForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!acceptDiffContext) return;

  const reason = document.getElementById("accept-diff-reason").value.trim();
  if (!reason) {
    acceptDiffError.textContent = "Gerekçe zorunludur.";
    acceptDiffError.hidden = false;
    return;
  }

  const submitBtn = document.getElementById("accept-diff-submit");
  submitBtn.disabled = true;

  const { error } = await client.rpc("accept_rate_difference", {
    p_request_id: acceptDiffContext.requestId,
    p_reason: reason,
  });

  submitBtn.disabled = false;

  if (error) {
    acceptDiffError.textContent = "Hata: " + error.message;
    acceptDiffError.hidden = false;
    return;
  }

  acceptDiffDialog.close();
  acceptDiffContext = null;
  showToast("Fark kabul edildi — bir daha aynı fark için yeni talep açılmayacak.", false);
  await loadAll();
});

// ---------------------------------------------------------------------------
// Kabul Edilmiş Farklar tablosu
// ---------------------------------------------------------------------------

async function loadAcceptedDiffs() {
  const tbody = document.getElementById("accepted-diffs-tbody");
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="7" class="muted">Yükleniyor…</td></tr>`;

  const { data, error } = await client
    .from("accepted_rate_differences")
    .select(
      "id, raw_evidence, normalized_value, normalization_reason, accepted_at, occurrence_count, last_checked_at, banks(name), profiles(email)"
    )
    .order("last_checked_at", { ascending: false });

  if (error) {
    tbody.innerHTML = `<tr><td colspan="7" class="error-text">Hata: ${error.message}</td></tr>`;
    return;
  }

  if (!data || data.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted">Henüz kabul edilmiş bir fark yok.</td></tr>`;
    return;
  }

  tbody.innerHTML = "";
  for (const d of data) {
    const tr = document.createElement("tr");
    const rawHtml = d.raw_evidence
      ? Object.entries(d.raw_evidence)
          .map(([k, v]) => `${escapeHtml(k)}: <strong>${escapeHtml(v)}</strong>`)
          .join("<br>")
      : "—";
    tr.innerHTML = `
      <td>${escapeHtml(d.banks ? d.banks.name : "")}</td>
      <td class="note-cell">${rawHtml}</td>
      <td class="note-cell">${escapeHtml(fmtBandShort(d.normalized_value))}</td>
      <td class="note-cell">${escapeHtml(d.normalization_reason)}</td>
      <td>${escapeHtml(d.profiles ? d.profiles.email : "—")}<br><span class="muted">${fmtDateTime(d.accepted_at)}</span></td>
      <td>${d.occurrence_count}</td>
      <td>${fmtDateTime(d.last_checked_at)}</td>
    `;
    tbody.appendChild(tr);
  }
}

runCheckBtn.addEventListener("click", async () => {
  runCheckBtn.disabled = true;
  runCheckBtn.textContent = "Kontrol ediliyor…";

  try {
    const { data: sessionData } = await client.auth.getSession();
    const token = sessionData?.session?.access_token;
    if (!token) {
      showToast("Oturum bulunamadı, lütfen tekrar giriş yapın.", true);
      return;
    }

    const res = await fetch(EDGE_FUNCTION_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: SUPABASE_ANON_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    if (!res.ok) {
      const body = await res.text();
      showToast(`Kontrol başarısız (${res.status}): ${body}`, true);
      return;
    }

    const result = await res.json();
    showToast(
      `Kontrol tamamlandı: ${result.sources_checked} ürün kontrol edildi, ${result.findings_created} bulgu oluştu.`,
      false
    );
    await loadDailyCheck();
  } catch (err) {
    showToast("Kontrol çalıştırılamadı: " + err.message, true);
  } finally {
    runCheckBtn.disabled = false;
    runCheckBtn.textContent = "Şimdi Kontrol Et";
  }
});

// ---------------------------------------------------------------------------
// Yardımcılar
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str === null || str === undefined ? "" : String(str);
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Başlangıç
// ---------------------------------------------------------------------------

client.auth.getSession().then(({ data: { session } }) => handleSession(session));
client.auth.onAuthStateChange((_event, session) => handleSession(session));
