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

const ratesGroupsContainer = document.getElementById("rates-groups");
const requestsTbody = document.getElementById("requests-tbody");
const auditTbody = document.getElementById("audit-tbody");

const proposalCard = document.getElementById("proposal-card");
const proposalTitle = document.getElementById("proposal-title");
const proposalForm = document.getElementById("proposal-form");
const proposalError = document.getElementById("proposal-error");

const runCheckBtn = document.getElementById("run-check-btn");
const dailyCheckTbody = document.getElementById("daily-check-tbody");
const statNoChange = document.getElementById("stat-nochange");
const statChanged = document.getElementById("stat-changed");
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

// Sayfalar arası yenilemede (loadAll()) hangi banka gruplarının açık
// olduğu korunur — kullanıcı bir işlem yaptığında liste yenilenir ama
// baktığı grup aniden kapanmaz.
const openRateBankGroups = new Set();

async function loadActiveRates() {
  ratesGroupsContainer.innerHTML = `<p class="muted">Yükleniyor…</p>`;

  // banks!inner + is_enabled=true: pasifleştirilmiş ürünler (ör. mükerrer
  // olduğu için kapatılan "Odeabank Oksijen Hoş Geldin") bu "aktif oranlar"
  // tablosunda görünmemeli — başlık yalnızca aktif ürünleri ifade ediyor.
  // Geçmiş/denetim tabloları (Değişiklik Talepleri, Audit Log) bu filtreden
  // ETKİLENMEZ, ayrı sorgulardır.
  const { data, error } = await client
    .from("bank_rates")
    .select(
      "id, bank_id, alt_limit, ust_limit, vadesizde_kalacak, yillik_brut_oran, note, gerekli_fon_bakiyesi, vadesiz_hesaplama_tipi, vadesiz_oran, banks!inner(name, is_enabled)"
    )
    .eq("is_active", true)
    .eq("banks.is_enabled", true)
    .order("name", { referencedTable: "banks" })
    .order("alt_limit");

  if (error) {
    ratesGroupsContainer.innerHTML = `<p class="error-text">Hata: ${escapeHtml(error.message)}</p>`;
    return;
  }

  activeRatesById = new Map(data.map((r) => [r.id, r]));

  if (data.length === 0) {
    ratesGroupsContainer.innerHTML = `<p class="muted">Aktif oran aralığı bulunamadı.</p>`;
    return;
  }

  // Sıra korunur (sorgu zaten banka adına, sonra alt limite göre sıralı
  // geliyor) — banka adına göre grupla, bant sayısını grup başlığında göster.
  const bandsByBank = new Map();
  for (const r of data) {
    const bankName = r.banks ? r.banks.name : r.bank_id;
    if (!bandsByBank.has(bankName)) bandsByBank.set(bankName, []);
    bandsByBank.get(bankName).push(r);
  }

  ratesGroupsContainer.innerHTML = "";
  for (const [bankName, bands] of bandsByBank) {
    const details = document.createElement("details");
    details.className = "rate-bank-group";
    if (openRateBankGroups.has(bankName)) details.open = true;

    const summary = document.createElement("summary");
    summary.innerHTML = `<span class="rate-bank-group-name">${escapeHtml(bankName)}</span><span class="rate-bank-group-count">${bands.length} oran aralığı</span>`;
    details.appendChild(summary);

    details.addEventListener("toggle", () => {
      if (details.open) openRateBankGroups.add(bankName);
      else openRateBankGroups.delete(bankName);
    });

    const wrap = document.createElement("div");
    wrap.className = "table-wrap";
    const table = document.createElement("table");
    table.innerHTML = `
      <thead>
        <tr>
          <th>Tutar Aralığı</th>
          <th>Vadesizde Kalacak</th>
          <th>Yıllık Brüt Oran</th>
          <th>Gerekli Fon</th>
          <th>Not</th>
          <th>İşlem</th>
        </tr>
      </thead>
      <tbody></tbody>
    `;
    const tbody = table.querySelector("tbody");
    for (const r of bands) {
      const vadesizCell =
        r.vadesiz_hesaplama_tipi === "yuzde"
          ? `Bakiyenin %${numberFmt.format(r.vadesiz_oran ?? 0)}'i`
          : fmtMoney(r.vadesizde_kalacak);
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(fmtRangeTR(r.alt_limit, r.ust_limit))}</td>
        <td>${escapeHtml(vadesizCell)}</td>
        <td>${fmtPercent(r.yillik_brut_oran)}</td>
        <td>${r.gerekli_fon_bakiyesi ? fmtMoney(r.gerekli_fon_bakiyesi) : "—"}</td>
        <td>${r.note ? `<button type="button" class="link-btn" data-action="show-note" data-id="${r.id}">Notu Gör</button>` : `<span class="muted">—</span>`}</td>
        <td><button type="button" class="link-btn" data-action="edit" data-id="${r.id}">Düzenle</button></td>
      `;
      tbody.appendChild(tr);
    }
    wrap.appendChild(table);
    details.appendChild(wrap);
    ratesGroupsContainer.appendChild(details);
  }
}

ratesGroupsContainer.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const rate = activeRatesById.get(btn.dataset.id);
  if (!rate) return;
  if (btn.dataset.action === "show-note") {
    openNoteDialog(rate.note);
  } else if (btn.dataset.action === "edit") {
    openEditRateDialog(rate);
  }
});

// ---------------------------------------------------------------------------
// "Düzenle" penceresi — kendi yazma mantığı YOK. Yalnızca özet gösterir ve
// mevcut, zaten güvenliği doğrulanmış üç akıştan birine (Güncelle Öner /
// Pasifleştir Öner / Kaydet ve Yayınla) DAĞITIM yapar. Pencereyi açmak
// hiçbir kayıt oluşturmaz/değiştirmez.
// ---------------------------------------------------------------------------

const editRateDialog = document.getElementById("edit-rate-dialog");
let editRateContext = null;

function openEditRateDialog(rate) {
  editRateContext = rate;
  const bankName = rate.banks ? rate.banks.name : rate.bank_id;
  document.getElementById("edit-rate-title").textContent = `Düzenle — ${bankName}`;
  const vadesizText =
    rate.vadesiz_hesaplama_tipi === "yuzde"
      ? `Bakiyenin %${numberFmt.format(rate.vadesiz_oran ?? 0)}'i`
      : fmtMoney(rate.vadesizde_kalacak);
  document.getElementById("edit-rate-summary").innerHTML = `
    <dt>Banka / Ürün</dt><dd>${escapeHtml(bankName)}</dd>
    <dt>Tutar Aralığı</dt><dd>${escapeHtml(fmtRangeTR(rate.alt_limit, rate.ust_limit))}</dd>
    <dt>Mevcut Oran</dt><dd>${fmtPercent(rate.yillik_brut_oran)}</dd>
    <dt>Vadesizde Kalacak</dt><dd>${escapeHtml(vadesizText)}</dd>
    <dt>Gerekli Fon</dt><dd>${rate.gerekli_fon_bakiyesi ? fmtMoney(rate.gerekli_fon_bakiyesi) : "—"}</dd>
    <dt>Not</dt><dd>${rate.note ? escapeHtml(rate.note) : "—"}</dd>
  `;
  editRateDialog.showModal();
}

document.getElementById("edit-rate-close").addEventListener("click", () => {
  editRateDialog.close();
});

editRateDialog.addEventListener("click", (e) => {
  const rect = editRateDialog.getBoundingClientRect();
  const clickedInside =
    e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
  if (!clickedInside) {
    editRateDialog.close();
  }
});

document.getElementById("edit-rate-propose-update").addEventListener("click", () => {
  if (!editRateContext) return;
  const rate = editRateContext;
  editRateDialog.close();
  openProposalForm(rate, "update");
});

document.getElementById("edit-rate-propose-disable").addEventListener("click", () => {
  if (!editRateContext) return;
  const rate = editRateContext;
  editRateDialog.close();
  submitDisableProposal(rate);
});

document.getElementById("edit-rate-manual").addEventListener("click", () => {
  if (!editRateContext) return;
  const rate = editRateContext;
  editRateDialog.close();
  openManualEditDialog(rate);
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
// Oran Kontrolü
// ---------------------------------------------------------------------------
//
// Bu bölüm bilerek TEKNİK olmayan bir dille yazıldı: ekranda "database",
// "RPC", "JSON", "normalize", "fingerprint" gibi ifadeler YOKTUR. Yalnızca
// 5 kullanıcı-dostu durum kullanılır; ham/teknik içerik (kaynak tablo, aday
// oranlar, ham metin) yalnızca "Detay" düğmesiyle açılan modalda gösterilir.

const RK_LABEL = {
  nochange: "Değişiklik yok",
  pending: "Onay bekliyor",
  approved: "Güncellendi",
  manual: "Manuel kontrol",
  unreachable: "Kaynağa ulaşılamadı",
};
const RK_BADGE_CLASS = {
  nochange: "rk-badge-nochange",
  pending: "rk-badge-pending",
  approved: "rk-badge-approved",
  manual: "rk-badge-manual",
  unreachable: "rk-badge-unreachable",
};

function fmtDateTime(iso) {
  return iso ? new Date(iso).toLocaleString("tr-TR") : "—";
}

// Türkçe biçim: "%44,00" (yüzde işareti önce, boşluksuz).
function fmtPercentSimple(n) {
  return n === null || n === undefined ? "—" : "%" + percentFmt.format(n * 100);
}

// Türkçe biçim: "250.001–500.000 TL". Açık uçlu (sentinel) üst sınırlar
// "X TL ve üzeri" olarak gösterilir.
function fmtRangeTR(alt, ust) {
  if (alt === null || alt === undefined || ust === null || ust === undefined) return "—";
  const altS = numberFmt.format(alt);
  if (Number(ust) >= 9999999999) return `${altS} TL ve üzeri`;
  return `${altS}–${numberFmt.format(ust)} TL`;
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

// "En yüksek resmi aday oranı" politikası denetim izi: kaynak tablo, o
// satırdaki TÜM aday oranlar ve hangisinin/hangi koşulla seçildiği. Bu
// bilgi yalnızca Detay modalında gösterilir, ana tabloda ASLA.
function renderRateSelection(f) {
  if (!f.selected_rate_column && !f.observed_rate_candidates && !f.source_table_name) return "";
  const parts = [];
  if (f.source_table_name) parts.push(`<dt>Kaynak tablo</dt><dd>${escapeHtml(f.source_table_name)}</dd>`);
  if (f.observed_rate_candidates && f.observed_rate_candidates.length > 0) {
    const candidatesHtml = f.observed_rate_candidates
      .map((c) => {
        const isWinner = c.column === f.selected_rate_column;
        return `<div${isWinner ? ' class="diff-new"' : ""}>${escapeHtml(c.column)}: ${fmtPercent(c.rate)}${isWinner ? " ← seçildi" : ""}</div>`;
      })
      .join("");
    parts.push(`<dt>Tüm aday oranlar</dt><dd>${candidatesHtml}</dd>`);
  }
  if (f.selected_rate_condition) parts.push(`<dt>Seçilen oranın koşulu</dt><dd>${escapeHtml(f.selected_rate_condition)}</dd>`);
  if (parts.length === 0) return "";
  return `<dl class="proposal-fields" style="margin-top:8px;">${parts.join("")}</dl>`;
}

// Aksiyon alınabilecek bir bant yoksa (tüm rate_changed bulguları ya yok, ya
// da zaten reddedilmiş), bankanın DÜŞTÜĞÜ geri dönüş kategorisi — öncelik
// sırası: parse_error/manual_required > unreachable > (varsayılan) nochange.
function bankFallbackCategory(findingsForSource) {
  if (!findingsForSource || findingsForSource.length === 0) return "nochange";
  const types = findingsForSource.map((f) => f.finding_type);
  if (types.includes("parse_error") || types.includes("manual_required")) return "manual";
  if (types.includes("unreachable")) return "unreachable";
  return "nochange";
}

let dailyDetailContent = new Map(); // finding.id -> { title, html }
let dailyCheckRows = []; // ekranda gösterilecek satırlar (bkz. renderDailyCheckTable)
let lastRunInfo = null; // "Gelişmiş Ayrıntılar > Teknik Çalışma Detayları" için

async function loadDailyCheck() {
  dailyCheckTbody.innerHTML = `<tr><td colspan="7" class="muted">Yükleniyor…</td></tr>`;

  const nowIso = new Date().toISOString();

  // is_test=false + status<>'skipped' + started_at<=now(): sentetik test
  // kayıtları (bkz. 20260910220000 migration) ve gelecek tarihli/atlanan
  // kayıtlar "Son kontrol" / "Son başarılı kontrol" / teknik ayrıntı
  // panelinin yerine ASLA geçmez.
  const { data: lastRun } = await client
    .from("rate_check_runs")
    .select(
      "id, started_at, finished_at, status, sources_checked, sources_unreachable, findings_created, dry_run, triggered_by, verified_products, pending_products, manual_products, duration_ms, error_summary, notes"
    )
    .eq("dry_run", false)
    .eq("is_test", false)
    .neq("status", "skipped")
    .lte("started_at", nowIso)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: lastSuccess } = await client
    .from("rate_check_runs")
    .select("id, started_at")
    .eq("dry_run", false)
    .eq("is_test", false)
    .gt("sources_checked", 0)
    .in("status", ["success", "partial_failure"])
    .lte("started_at", nowIso)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  lastRunInfo = lastRun || null;
  const lastRunTextEl = document.getElementById("check-last-run-text");
  if (lastRunTextEl) {
    lastRunTextEl.textContent = "Son kontrol: " + (lastRun ? fmtDateTime(lastRun.started_at) : "henüz çalışmadı");
  }
  const lastSuccessTextEl = document.getElementById("check-last-success-text");
  if (lastSuccessTextEl) {
    lastSuccessTextEl.textContent = "Son başarılı kontrol: " + (lastSuccess ? fmtDateTime(lastSuccess.started_at) : "henüz yok");
  }
  const healthBanner = document.getElementById("check-health-banner");
  if (healthBanner) {
    // "Sessiz başarısızlık" bir daha görünmesin: son çalışma failure ise
    // üstte açık bir kırmızı uyarı gösterilir. (Bir retry "gereksiz, ana
    // kontrol zaten başarılıydı" diye atlandığında status='success' olarak
    // kaydedilir — bu YANLIŞLIKLA başarısızlık sayılmaz.) Teknik ayrıntı
    // (error_summary) yalnızca Gelişmiş Ayrıntılar'da kalır.
    const lastRunFailed = !!lastRun && lastRun.status === "failure";
    if (lastRunFailed) {
      healthBanner.hidden = false;
      const saatText = fmtDateTime(lastRun.started_at);
      healthBanner.textContent = `${saatText} otomatik kontrolü tamamlanamadı.`;
    } else {
      healthBanner.hidden = true;
      healthBanner.textContent = "";
    }
  }
  renderRunDetailTechnical();

  // banks!inner + is_enabled=true: pasifleştirilmiş ürünler (ör. kullanıcı
  // kararıyla kapatılan mükerrer Odeabank ürünü) bu ekranda hiç görünmesin.
  const { data: sources, error: sourcesErr } = await client
    .from("bank_sources")
    .select("id, bank_id, source_url, banks!inner(name, is_enabled)")
    .eq("banks.is_enabled", true)
    .order("created_at", { ascending: true });

  if (sourcesErr || !sources) {
    dailyCheckTbody.innerHTML = `<tr><td colspan="7" class="error-text">Hata: ${sourcesErr ? sourcesErr.message : "bank_sources okunamadı"}</td></tr>`;
    return;
  }

  // Onay bekleyen satırlar DOĞRUDAN güncel gerçek kuyruktan (rate_change_
  // requests.status='pending') okunur — HANGİ çalışmanın onu ürettiğine
  // bakılmaz. Böylece bir talep, onu üreten çalışma artık "son çalışma"
  // olmasa bile, çözülene kadar tabloda görünmeye devam eder.
  const { data: pendingRequests, error: pendingErr } = await client
    .from("rate_change_requests")
    .select("id, bank_id, bank_rate_id, proposed_data, previous_data, banks!inner(name, is_enabled)")
    .eq("status", "pending")
    .eq("banks.is_enabled", true);

  if (pendingErr) {
    dailyCheckTbody.innerHTML = `<tr><td colspan="7" class="error-text">Hata: ${pendingErr.message}</td></tr>`;
    return;
  }

  // Detay modalında zengin ham kanıt (raw_evidence, aday oranlar vb.)
  // gösterebilmek için ilgili bulgular AYRICA çekilir — ama bir talebin
  // PENDING SAYILIP SAYILMAYACAĞI asla buna bağlı değildir (talep zaten
  // yukarıdaki sorgudan geliyor).
  const pendingIds = (pendingRequests ?? []).map((r) => r.id);
  let findingByRequestId = new Map();
  if (pendingIds.length > 0) {
    const { data: relatedFindings } = await client
      .from("rate_check_findings")
      .select(
        "id, rate_change_request_id, current_value, observed_value, raw_evidence, source_table_name, selected_rate_column, selected_rate_condition, observed_rate_candidates"
      )
      .in("rate_change_request_id", pendingIds);
    for (const f of relatedFindings ?? []) {
      findingByRequestId.set(f.rate_change_request_id, f);
    }
  }

  const sourceByBankId = new Map(sources.map((s) => [s.bank_id, s]));
  const bankIdsWithPending = new Set((pendingRequests ?? []).map((r) => r.bank_id));

  let findings = [];
  if (lastRun) {
    const { data: findingsData } = await client
      .from("rate_check_findings")
      .select("id, bank_source_id, bank_id, finding_type")
      .eq("run_id", lastRun.id);
    findings = findingsData || [];
  }
  const findingsBySource = new Map();
  for (const f of findings) {
    if (!findingsBySource.has(f.bank_source_id)) findingsBySource.set(f.bank_source_id, []);
    findingsBySource.get(f.bank_source_id).push(f);
  }

  dailyDetailContent = new Map();
  const pendingRows = [];
  const summaryRows = [];

  let countNoChange = 0;
  let countPendingBands = 0; // "Onay bekleyen" ARALIK (bant) sayısıdır, banka sayısı DEĞİL
  let countManual = 0;
  let countUnreachable = 0;

  // 1) Onay bekleyen satırlar — her PENDING talep için bir satır.
  for (const req of pendingRequests ?? []) {
    const bankName = req.banks ? req.banks.name : req.bank_id;
    const source = sourceByBankId.get(req.bank_id);
    const sourceUrl = source ? source.source_url : "#";
    const finding = findingByRequestId.get(req.id) ?? null;
    countPendingBands++;

    pendingRows.push({
      rkStatus: "pending",
      bankName,
      sourceUrl,
      requestId: req.id,
      findingId: req.id, // dailyDetailContent bu değerle anahtarlanır (finding olmasa da çalışır)
      alt: req.proposed_data ? req.proposed_data.alt_limit : null,
      ust: req.proposed_data ? req.proposed_data.ust_limit : null,
      oldRate: req.previous_data ? req.previous_data.yillik_brut_oran : null,
      newRate: req.proposed_data ? req.proposed_data.yillik_brut_oran : null,
    });

    const currentVal = finding ? finding.current_value : req.previous_data;
    const observedVal = finding ? finding.observed_value : req.proposed_data;
    const oldNew = `
      <div class="diff-box">
        <div><span class="muted">Kayıtlı:</span> <span class="diff-old">${escapeHtml(fmtBandShort(currentVal))}</span></div>
        <div><span class="muted">Kaynakta bulunan:</span> <span class="diff-new">${escapeHtml(fmtBandShort(observedVal))}</span></div>
      </div>
      ${finding ? renderRateSelection(finding) : ""}
      ${finding ? renderRawEvidence(finding.raw_evidence) : ""}`;
    const actionsHtml = `
      <button type="button" class="link-btn" data-req-action="approve" data-req-id="${req.id}">Onayla ve Yayınla</button>
      <button type="button" class="link-btn danger" data-req-action="reject" data-req-id="${req.id}">Reddet</button>
      <button type="button" class="link-btn" data-accept-diff-btn data-req-id="${req.id}"
        data-current="${escapeHtml(fmtBandShort(currentVal))}" data-observed="${escapeHtml(fmtBandShort(observedVal))}">Bu farkı kabul et</button>
    `;
    dailyDetailContent.set(req.id, {
      title: `${bankName} — ${RK_LABEL.pending}`,
      html: `<div class="daily-check-finding">${oldNew}<div class="actions-cell">${actionsHtml}</div></div>`,
    });
  }

  // 2) Pending talebi OLMAYAN bankalar için tek özet satır — durumu en son
  // GERÇEK (is_test=false, dry_run=false, status<>'skipped') çalışmanın
  // bulgularından belirlenir. Bir bankanın pending talebi varsa bu banka
  // için ayrıca "Değişiklik yok" özeti GÖSTERİLMEZ.
  for (const source of sources) {
    if (bankIdsWithPending.has(source.bank_id)) continue;

    const bankName = source.banks ? source.banks.name : source.bank_id;
    const sourceFindings = findingsBySource.get(source.id) || [];
    const rkStatus = bankFallbackCategory(sourceFindings);
    if (rkStatus === "nochange") countNoChange++;
    else if (rkStatus === "manual") countManual++;
    else if (rkStatus === "unreachable") countUnreachable++;

    summaryRows.push({
      rkStatus,
      bankName,
      sourceUrl: source.source_url,
      requestId: null,
      findingId: null,
      alt: null,
      ust: null,
      oldRate: null,
      newRate: null,
    });
  }

  // rate_change_requests sorgusunun dönüş sırası garanti değildir — aynı
  // bankanın satırları YAN YANA olmazsa tablodaki "banka hücresi tek kez,
  // ilk satırda" ve "Tümünü seç" grup mantığı bozulur. Önce banka adına,
  // sonra alt limite göre sıralanır.
  pendingRows.sort((a, b) => a.bankName.localeCompare(b.bankName, "tr") || (a.alt ?? 0) - (b.alt ?? 0));

  // Onay bekleyen 13 satır ÖNCE gösterilir, ardından özet satırlar.
  dailyCheckRows = [...pendingRows, ...summaryRows];

  statNoChange.textContent = String(countNoChange);
  statChanged.textContent = String(countPendingBands);
  statManual.textContent = String(countManual);
  statUnreachable.textContent = String(countUnreachable);
  const statChangedSubEl = document.getElementById("stat-changed-sub");
  if (statChangedSubEl) {
    const bankCount = bankIdsWithPending.size;
    statChangedSubEl.textContent = bankCount > 0 ? `${bankCount} ürün` : "";
  }

  renderDailyCheckTable();
}

function renderDailyCheckTable() {
  if (dailyCheckRows.length === 0) {
    dailyCheckTbody.innerHTML = `<tr><td colspan="7" class="muted">Henüz kaynak tanımlı değil.</td></tr>`;
    return;
  }

  const pendingCountByBank = new Map();
  for (const row of dailyCheckRows) {
    if (row.rkStatus === "pending") {
      pendingCountByBank.set(row.bankName, (pendingCountByBank.get(row.bankName) || 0) + 1);
    }
  }

  dailyCheckTbody.innerHTML = "";
  const seenBanks = new Set();
  for (const row of dailyCheckRows) {
    const tr = document.createElement("tr");
    const isFirstOfBank = !seenBanks.has(row.bankName);
    seenBanks.add(row.bankName);

    let bankCell = "";
    if (isFirstOfBank) {
      const pendingInBank = pendingCountByBank.get(row.bankName) || 0;
      const selectAllLink =
        pendingInBank > 1
          ? `<button type="button" class="rk-select-bank-link" data-select-bank="${escapeHtml(row.bankName)}">Tümünü seç (${pendingInBank})</button>`
          : "";
      bankCell = `
        <div class="rk-bank-name">${escapeHtml(row.bankName)}</div>
        <a class="rk-source-link muted" href="${escapeHtml(row.sourceUrl)}" target="_blank" rel="noopener">Resmî kaynağı aç</a>
        ${selectAllLink}
      `;
    }

    let selectCell = "—";
    if (row.rkStatus === "pending" && row.requestId) {
      selectCell = `<input type="checkbox" class="rk-row-checkbox" data-request-id="${row.requestId}" data-bank="${escapeHtml(row.bankName)}" />`;
    }

    const rangeCell =
      row.rkStatus === "pending" || row.rkStatus === "approved"
        ? escapeHtml(fmtRangeTR(row.alt, row.ust))
        : row.rkStatus === "nochange"
          ? "Tüm aralıklar"
          : "—";

    const oldRateCell = row.oldRate !== null && row.oldRate !== undefined ? escapeHtml(fmtPercentSimple(row.oldRate)) : "—";
    const newRateCell = row.newRate !== null && row.newRate !== undefined ? escapeHtml(fmtPercentSimple(row.newRate)) : "—";

    let actionCell = "—";
    if (row.findingId && dailyDetailContent.has(row.findingId)) {
      actionCell = `<button type="button" class="link-btn detail-btn" data-daily-detail-btn data-finding-id="${row.findingId}">Detay</button>`;
    } else if (row.rkStatus === "manual" || row.rkStatus === "unreachable") {
      actionCell = `<a href="${escapeHtml(row.sourceUrl)}" target="_blank" rel="noopener">Kaynağı Aç</a>`;
    }

    const badge = `<span class="rk-badge ${RK_BADGE_CLASS[row.rkStatus]}">${RK_LABEL[row.rkStatus]}</span>`;

    tr.innerHTML = `
      <td class="rk-select-col">${selectCell}</td>
      <td class="rk-bank-cell">${bankCell}</td>
      <td>${rangeCell}</td>
      <td>${badge}</td>
      <td>${oldRateCell}</td>
      <td>${newRateCell}</td>
      <td>${actionCell}</td>
    `;
    dailyCheckTbody.appendChild(tr);
  }

  updateBulkSelectionUI();
}

function renderRunDetailTechnical() {
  const tbody = document.getElementById("run-detail-tbody");
  if (!tbody) return;
  if (!lastRunInfo) {
    tbody.innerHTML = `<tr><td class="muted">Henüz bir çalışma yok.</td></tr>`;
    return;
  }
  const rows = [
    ["Çalışma kimliği", lastRunInfo.id],
    ["Tetikleyen", lastRunInfo.triggered_by],
    ["Başlangıç", fmtDateTime(lastRunInfo.started_at)],
    ["Bitiş", fmtDateTime(lastRunInfo.finished_at)],
    ["Süre", lastRunInfo.duration_ms != null ? `${(lastRunInfo.duration_ms / 1000).toFixed(1)} sn` : "—"],
    ["Durum", lastRunInfo.status],
    ["Kontrol edilen kaynak sayısı", lastRunInfo.sources_checked],
    ["Değişiklik yok (doğrulanan)", lastRunInfo.verified_products],
    ["Onay bekleyen", lastRunInfo.pending_products],
    ["Manuel kontrol gerekli", lastRunInfo.manual_products],
    ["Ulaşılamayan kaynak sayısı", lastRunInfo.sources_unreachable],
    ["Oluşan bulgu sayısı", lastRunInfo.findings_created],
    ["Hata özeti", lastRunInfo.error_summary],
    ["Not", lastRunInfo.notes],
  ];
  tbody.innerHTML = rows
    .map(([label, value]) => `<tr><td class="muted">${escapeHtml(label)}</td><td>${escapeHtml(String(value ?? "—"))}</td></tr>`)
    .join("");
}

const dailyDetailDialog = document.getElementById("daily-detail-dialog");
const dailyDetailTitle = document.getElementById("daily-detail-title");
const dailyDetailBody = document.getElementById("daily-detail-body");

function openDailyDetailDialog(findingId) {
  const entry = dailyDetailContent.get(findingId);
  if (!entry) return;
  dailyDetailTitle.textContent = entry.title;
  dailyDetailBody.innerHTML = entry.html;
  dailyDetailDialog.showModal();
}

document.getElementById("daily-detail-close").addEventListener("click", () => {
  dailyDetailDialog.close();
});

// Dışına (backdrop'a) tıklayınca kapat; Escape <dialog>'un kendi davranışı.
dailyDetailDialog.addEventListener("click", (e) => {
  const rect = dailyDetailDialog.getBoundingClientRect();
  const clickedInside =
    e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
  if (!clickedInside) {
    dailyDetailDialog.close();
  }
});

async function handleRateChangeAction(requestId, action) {
  const note = prompt(action === "approve" ? "Onay notu (opsiyonel):" : "Red gerekçesi (opsiyonel):") || null;

  const rpcName = action === "approve" ? "approve_rate_change" : "reject_rate_change";
  const { error } = await client.rpc(rpcName, { p_request_id: requestId, p_review_note: note });

  if (error) {
    showToast("Hata: " + error.message, true);
    return;
  }

  showToast(action === "approve" ? "Değişiklik onaylandı ve yayınlandı." : "Değişiklik reddedildi.", false);
  dailyDetailDialog.close();
  await loadAll();
}

dailyCheckTbody.addEventListener("click", (e) => {
  const detailBtn = e.target.closest("button[data-daily-detail-btn]");
  if (detailBtn) {
    openDailyDetailDialog(detailBtn.dataset.findingId);
    return;
  }

  const selectBankBtn = e.target.closest("button[data-select-bank]");
  if (selectBankBtn) {
    const bank = selectBankBtn.dataset.selectBank;
    const boxes = Array.from(dailyCheckTbody.querySelectorAll(".rk-row-checkbox")).filter((b) => b.dataset.bank === bank);
    const allChecked = boxes.length > 0 && boxes.every((b) => b.checked);
    boxes.forEach((b) => (b.checked = !allChecked));
    updateBulkSelectionUI();
  }
});

dailyCheckTbody.addEventListener("change", (e) => {
  if (e.target.matches(".rk-row-checkbox")) updateBulkSelectionUI();
});

// Modal içindeki Onayla/Reddet/Bu farkı kabul et düğmeleri (dinamik olarak
// içine eklendiği için delegasyon dialog üzerinde yapılır).
dailyDetailBody.addEventListener("click", async (e) => {
  const acceptBtn = e.target.closest("button[data-accept-diff-btn]");
  if (acceptBtn) {
    openAcceptDiffDialog(acceptBtn.dataset.reqId, acceptBtn.dataset.current, acceptBtn.dataset.observed);
    return;
  }

  const btn = e.target.closest("button[data-req-action]");
  if (!btn) return;
  btn.disabled = true;
  await handleRateChangeAction(btn.dataset.reqId, btn.dataset.reqAction);
  btn.disabled = false;
});

// ---------------------------------------------------------------------------
// Toplu seçim ve toplu onay/red — approve_rate_changes_bulk /
// reject_rate_changes_bulk RPC'lerinin TEK çağırıcısı. Tarayıcıdan
// bank_rates'e hiçbir zaman doğrudan yazılmaz.
// ---------------------------------------------------------------------------

let bulkActionInFlight = false;

function getSelectedRequestIds() {
  return Array.from(dailyCheckTbody.querySelectorAll(".rk-row-checkbox:checked")).map((b) => b.dataset.requestId);
}

function updateBulkSelectionUI() {
  const boxes = Array.from(dailyCheckTbody.querySelectorAll(".rk-row-checkbox"));
  const checked = boxes.filter((b) => b.checked);
  const approveBtn = document.getElementById("bulk-approve-btn");
  const rejectBtn = document.getElementById("bulk-reject-btn");
  const summaryEl = document.getElementById("bulk-selection-summary");
  const selectAll = document.getElementById("select-all-pending");

  const hasSelection = checked.length > 0;
  approveBtn.disabled = !hasSelection || bulkActionInFlight;
  rejectBtn.disabled = !hasSelection || bulkActionInFlight;
  summaryEl.textContent = hasSelection ? `${checked.length} seçili` : "";

  if (boxes.length === 0) {
    selectAll.checked = false;
    selectAll.indeterminate = false;
    selectAll.disabled = true;
  } else {
    selectAll.disabled = false;
    selectAll.checked = checked.length === boxes.length;
    selectAll.indeterminate = checked.length > 0 && checked.length < boxes.length;
  }
}

document.getElementById("select-all-pending").addEventListener("change", (e) => {
  const checked = e.target.checked;
  dailyCheckTbody.querySelectorAll(".rk-row-checkbox").forEach((b) => (b.checked = checked));
  updateBulkSelectionUI();
});

// Onay penceresinde göstermek için: seçilen taleplerin bankaya göre kırılımı.
function buildBulkConfirmMessage(selectedIds, verb) {
  const counts = new Map();
  for (const id of selectedIds) {
    const box = dailyCheckTbody.querySelector(`.rk-row-checkbox[data-request-id="${id}"]`);
    const bank = box ? box.dataset.bank : "Bilinmeyen";
    counts.set(bank, (counts.get(bank) || 0) + 1);
  }
  const lines = Array.from(counts.entries()).map(([bank, n]) => `- ${bank}: ${n} aralık`);
  return `${selectedIds.length} oran değişikliğini ${verb} üzeresiniz:\n${lines.join("\n")}\n\nDevam etmek istiyor musunuz?`;
}

async function runBulkAction(action) {
  if (bulkActionInFlight) return; // çift tıklama koruması
  const selectedIds = getSelectedRequestIds();
  if (selectedIds.length === 0) return; // boş seçimde işlem yok

  const verb = action === "approve" ? "onaylamak" : "reddetmek";
  if (!confirm(buildBulkConfirmMessage(selectedIds, verb))) return;

  bulkActionInFlight = true;
  const approveBtn = document.getElementById("bulk-approve-btn");
  const rejectBtn = document.getElementById("bulk-reject-btn");
  const activeBtn = action === "approve" ? approveBtn : rejectBtn;
  const originalText = activeBtn.textContent;
  approveBtn.disabled = true;
  rejectBtn.disabled = true;
  activeBtn.textContent = "İşleniyor…";

  const rpcName = action === "approve" ? "approve_rate_changes_bulk" : "reject_rate_changes_bulk";
  const { error } = await client.rpc(rpcName, { p_request_ids: selectedIds, p_review_note: null });

  activeBtn.textContent = originalText;
  bulkActionInFlight = false;

  if (error) {
    showToast("Hata: " + error.message, true);
    updateBulkSelectionUI();
    return;
  }

  showToast(
    action === "approve"
      ? `${selectedIds.length} değişiklik onaylandı ve yayınlandı.`
      : `${selectedIds.length} değişiklik reddedildi.`,
    false
  );
  await loadAll();
}

document.getElementById("bulk-approve-btn").addEventListener("click", () => runBulkAction("approve"));
document.getElementById("bulk-reject-btn").addEventListener("click", () => runBulkAction("reject"));

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
  if (dailyDetailDialog.open) dailyDetailDialog.close();
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
    // fetch() tarayıcı seviyesinde engellendiğinde (ör. CORS preflight
    // reddi, DNS/ağ hatası) TypeError fırlatır ve mesajı tarayıcıya göre
    // değişen, kullanıcıya anlamsız gelen İngilizce bir metindir ("Failed
    // to fetch", "NetworkError…" vb.) — ham hâliyle GÖSTERİLMEZ. Gerçek
    // HTTP hataları (yukarıdaki !res.ok dalı) zaten kendi status/gövde
    // mesajını koruyarak ayrı ele alınıyor, bu blok yalnızca fetch'in
    // KENDİSİ hiç tamamlanamadığında çalışır.
    const isNetworkLevelFailure = err instanceof TypeError;
    const userMessage = isNetworkLevelFailure
      ? "Kontrol servisine tarayıcıdan ulaşılamadı. Bağlantı veya servis erişimi kontrol edilmeli."
      : "Kontrol çalıştırılamadı: " + err.message;
    showToast(userMessage, true);
    // Teknik ayrıntı yalnızca konsola yazılır (secret/token asla loglanmaz).
    console.error("Şimdi Kontrol Et başarısız:", err);
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
