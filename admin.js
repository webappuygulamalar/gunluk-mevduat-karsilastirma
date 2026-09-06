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

let currentUser = null;
let activeRatesById = new Map();
let proposalContext = null; // { rate, mode: 'update' | 'disable' }

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
  await Promise.all([loadActiveRates(), loadRequests(), loadAuditLog()]);
}

async function loadActiveRates() {
  ratesTbody.innerHTML = `<tr><td colspan="8" class="muted">Yükleniyor…</td></tr>`;

  const { data, error } = await client
    .from("bank_rates")
    .select("id, bank_id, alt_limit, ust_limit, vadesizde_kalacak, yillik_brut_oran, note, gerekli_fon_bakiyesi, banks(name)")
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
  }
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
  const proposedData = {
    alt_limit: Number(document.getElementById("p-alt-limit").value),
    ust_limit: Number(document.getElementById("p-ust-limit").value),
    vadesizde_kalacak: Number(document.getElementById("p-vadesiz").value),
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
