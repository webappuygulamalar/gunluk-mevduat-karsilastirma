// Bağımsız şifre sıfırlama sayfası. admin.js ile aynı bağlantı bilgilerini
// kullanır: yalnızca proje URL'si ve anon/publishable key (gizli değildir).
// Gerçek erişim kontrolü Supabase Auth + RLS tarafından sağlanır. Bu dosyada
// service_role anahtarı veya veritabanı şifresi YOKTUR ve olmamalıdır.
const SUPABASE_URL = "https://zlvezpwheycdvzsszrqu.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_u3slgRop1E6jLLJVSprLnA_RZPkgy-g";

const client = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const requestView = document.getElementById("request-view");
const updateView = document.getElementById("update-view");
const invalidView = document.getElementById("invalid-view");

const requestForm = document.getElementById("request-form");
const requestError = document.getElementById("request-error");
const requestSuccess = document.getElementById("request-success");

const updateForm = document.getElementById("update-form");
const updateError = document.getElementById("update-error");
const updateSuccess = document.getElementById("update-success");

function showView(view) {
  requestView.hidden = view !== "request";
  updateView.hidden = view !== "update";
  invalidView.hidden = view !== "invalid";
}

function translateError(error) {
  if (!error) return "Beklenmeyen bir hata oluştu.";
  const msg = error.message || "";

  if (error.status === 429 || /security purposes|only request this after/i.test(msg)) {
    return "Çok sık istek gönderildi. Lütfen birkaç saniye sonra tekrar deneyin.";
  }
  if (/at least 6 characters/i.test(msg)) {
    return "Şifre en az 6 karakter olmalıdır.";
  }
  if (/should be different from the old password/i.test(msg)) {
    return "Yeni şifre, eskisiyle aynı olamaz.";
  }
  if (/auth session missing|session.*missing/i.test(msg)) {
    return "Oturum bulunamadı. Bağlantının süresi dolmuş olabilir, lütfen yeni bir sıfırlama e-postası isteyin.";
  }
  if (/unable to validate email address|invalid email/i.test(msg)) {
    return "Geçerli bir e-posta adresi girin.";
  }
  return "Hata: " + msg;
}

// ---------------------------------------------------------------------------
// 1. adım: sıfırlama bağlantısı isteği
// ---------------------------------------------------------------------------

requestForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  requestError.hidden = true;
  requestSuccess.hidden = true;

  const email = document.getElementById("request-email").value.trim();
  const submitBtn = document.getElementById("request-submit");
  submitBtn.disabled = true;
  submitBtn.textContent = "Gönderiliyor…";

  const { error } = await client.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + window.location.pathname,
  });

  submitBtn.disabled = false;
  submitBtn.textContent = "Sıfırlama Bağlantısı Gönder";

  if (error) {
    requestError.textContent = translateError(error);
    requestError.hidden = false;
    return;
  }

  // Güvenlik amacıyla e-postanın sistemde olup olmadığını belirtmeyen,
  // her durumda aynı genel mesaj gösterilir.
  requestSuccess.textContent = "Bu e-posta adresi sistemde kayıtlıysa, bir şifre sıfırlama bağlantısı gönderildi. Gelen kutunuzu kontrol edin.";
  requestSuccess.hidden = false;
  requestForm.reset();
});

// ---------------------------------------------------------------------------
// 2. adım: yeni şifre belirleme
// ---------------------------------------------------------------------------

updateForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  updateError.hidden = true;
  updateSuccess.hidden = true;

  const newPassword = document.getElementById("new-password").value;
  const confirmPassword = document.getElementById("new-password-confirm").value;

  if (newPassword.length < 6) {
    updateError.textContent = "Şifre en az 6 karakter olmalıdır.";
    updateError.hidden = false;
    return;
  }
  if (newPassword !== confirmPassword) {
    updateError.textContent = "Girdiğiniz şifreler birbiriyle eşleşmiyor.";
    updateError.hidden = false;
    return;
  }

  const submitBtn = document.getElementById("update-submit");
  submitBtn.disabled = true;
  submitBtn.textContent = "Güncelleniyor…";

  const { error } = await client.auth.updateUser({ password: newPassword });

  submitBtn.disabled = false;
  submitBtn.textContent = "Şifreyi Güncelle";

  if (error) {
    updateError.textContent = translateError(error);
    updateError.hidden = false;
    return;
  }

  updateForm.reset();
  updateSuccess.textContent = "Şifreniz güncellendi. Yeni şifrenizle giriş yapabilirsiniz, yönlendiriliyorsunuz…";
  updateSuccess.hidden = false;

  // Kurtarma (recovery) oturumu kalıcı bırakılmaz; kullanıcı yeni şifresiyle
  // normal giriş akışından tekrar oturum açar.
  await client.auth.signOut();
  setTimeout(() => {
    window.location.href = "admin.html";
  }, 2000);
});

// ---------------------------------------------------------------------------
// Sayfa açılışı: e-postadaki bağlantının türünü tespit et
// ---------------------------------------------------------------------------

function urlHasAuthError() {
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const queryParams = new URLSearchParams(window.location.search);
  return hashParams.get("error") || queryParams.get("error");
}

if (urlHasAuthError()) {
  showView("invalid");
} else {
  showView("request");
}

client.auth.onAuthStateChange((event) => {
  if (event === "PASSWORD_RECOVERY") {
    showView("update");
  }
});
