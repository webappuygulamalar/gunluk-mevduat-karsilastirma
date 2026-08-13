const PINNED_BANK = "TOM Bank";
const STOPAJ_ORANI = 0.175;
const NET_KATSAYI = 1 - STOPAJ_ORANI; // 0.825
const YIL_GUN = 365;
const MAX_GUN_SAYISI = 3650;

const principalInput = document.getElementById("principal");
const inputError = document.getElementById("input-error");
const gunSayisiInput = document.getElementById("gun-sayisi");
const gunSayisiError = document.getElementById("gun-sayisi-error");
const calculateBtn = document.getElementById("calculate-btn");
const resultsSection = document.getElementById("results-section");
const resultsList = document.getElementById("results-list");
const cardTemplate = document.getElementById("bank-card-template");
const ineligibleCardTemplate = document.getElementById("ineligible-card-template");

const tlFormatter = new Intl.NumberFormat("tr-TR", {
  style: "currency",
  currency: "TRY",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const tlWholeFormatter = new Intl.NumberFormat("tr-TR", {
  style: "currency",
  currency: "TRY",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const percentFormatter = new Intl.NumberFormat("tr-TR", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatTL(value) {
  return tlFormatter.format(value);
}

function formatTLWhole(value) {
  return tlWholeFormatter.format(value);
}

function formatPercent(decimalRatio) {
  return `%${percentFormatter.format(decimalRatio * 100)}`;
}

function digitsOnly(raw) {
  return raw.replace(/\D/g, "");
}

function parsePrincipalInput(raw) {
  const digits = digitsOnly(raw);
  if (!digits) return NaN;
  return Number(digits);
}

function formatPrincipalDisplay(raw) {
  const digits = digitsOnly(raw);
  if (!digits) return "";
  return Number(digits).toLocaleString("tr-TR");
}

function countDigitsBeforeIndex(value, index) {
  let count = 0;
  for (let i = 0; i < index && i < value.length; i++) {
    if (/\d/.test(value[i])) count++;
  }
  return count;
}

function indexAfterNthDigit(value, n) {
  if (n <= 0) return 0;
  let count = 0;
  for (let i = 0; i < value.length; i++) {
    if (/\d/.test(value[i])) {
      count++;
      if (count === n) return i + 1;
    }
  }
  return value.length;
}

function formatWholeTL(value) {
  return `${value.toLocaleString("tr-TR", { maximumFractionDigits: 0 })} TL`;
}

async function loadBankData() {
  const response = await fetch("data/banks.json", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Banka verisi yüklenemedi (${response.status})`);
  }
  return response.json();
}

function findBandForBank(entries, principal) {
  return entries.find(
    (entry) => principal >= entry.altLimit && principal <= entry.ustLimit
  );
}

function getMinAltLimit(entries) {
  return entries.reduce((min, entry) => Math.min(min, entry.altLimit), Infinity);
}

function getMaxUstLimit(entries) {
  return entries.reduce((max, entry) => Math.max(max, entry.ustLimit), -Infinity);
}

function buildIneligibleMessage(entries, principal) {
  const minAltLimit = getMinAltLimit(entries);
  const maxUstLimit = getMaxUstLimit(entries);
  if (principal < minAltLimit) {
    return `Bu ürün en az ${formatWholeTL(minAltLimit)} için kullanılabilir.`;
  }
  return `Bu ürün en fazla ${formatWholeTL(maxUstLimit)} için kullanılabilir.`;
}

function simulateCompoundNetReturn(entry, principal, days) {
  let balance = principal;
  for (let day = 0; day < days; day++) {
    const degerlenecekTutar = Math.max(0, balance - entry.vadesizdeKalacak);
    const gunlukBrutGetiri = (degerlenecekTutar * entry.yillikBrutOran) / YIL_GUN;
    const gunlukNetGetiri = gunlukBrutGetiri * NET_KATSAYI;
    balance += gunlukNetGetiri;
  }
  return balance - principal;
}

function calculateResult(entry, principal, gunSayisi) {
  const vadesizdeKalan = entry.vadesizdeKalacak;
  const degerlenecekTutar = Math.max(0, principal - vadesizdeKalan);
  const gunlukBrutGetiri = (degerlenecekTutar * entry.yillikBrutOran) / YIL_GUN;
  const gunlukNetGetiri = gunlukBrutGetiri * NET_KATSAYI;
  const donemNetGetiri = simulateCompoundNetReturn(entry, principal, gunSayisi);
  const vadeliMevduatEsdegeri =
    principal > 0 && gunSayisi > 0
      ? ((donemNetGetiri / principal) * (YIL_GUN / gunSayisi)) / NET_KATSAYI
      : 0;

  return {
    banka: entry.banka,
    not: entry.not || "",
    yillikBrutOran: entry.yillikBrutOran,
    vadesizdeKalan,
    degerlenecekTutar,
    gunlukNetGetiri,
    donemNetGetiri,
    gunSayisi,
    vadeliMevduatEsdegeri,
    gerekliFonBakiyesi: entry.gerekliFonBakiyesi ?? null,
  };
}

function groupByBank(entries) {
  const groups = new Map();
  for (const entry of entries) {
    if (!groups.has(entry.banka)) {
      groups.set(entry.banka, []);
    }
    groups.get(entry.banka).push(entry);
  }
  return groups;
}

function renderEligibleCard(result, rank) {
  const node = cardTemplate.content.cloneNode(true);

  node.querySelector(".rank-badge").textContent = String(rank);
  node.querySelector(".bank-name").textContent = result.banka;
  node.querySelector(".rate-value").textContent = formatPercent(
    result.yillikBrutOran
  );
  node.querySelector(".rate-effective").textContent = `Vadeli Mevduat Eşdeğeri: ${formatPercent(
    result.vadeliMevduatEsdegeri
  )}`;

  node.querySelector(".main-result-value").textContent = formatTL(
    result.gunlukNetGetiri
  );

  node.querySelector(".stat-vadesiz").textContent = formatTLWhole(
    result.vadesizdeKalan
  );
  node.querySelector(".stat-degerlenecek").textContent = formatTLWhole(
    result.degerlenecekTutar
  );
  node.querySelector(".stat-label-donem").textContent = `${result.gunSayisi} Günde Yaklaşık Getiri`;
  node.querySelector(".stat-otuzgun").textContent = formatTL(
    result.donemNetGetiri
  );

  const noteEl = node.querySelector(".bank-note");
  if (result.not) {
    noteEl.textContent = result.not;
    noteEl.hidden = false;
  }

  const fundNoteEl = node.querySelector(".fund-note");
  if (result.gerekliFonBakiyesi) {
    fundNoteEl.textContent = `Bu orandan yararlanmak için en az ${formatWholeTL(
      result.gerekliFonBakiyesi
    )} Fiba Portföy TL yatırım fonu bulundurulması gerekir.`;
    fundNoteEl.hidden = false;
  }

  return node;
}

function renderIneligibleCard(item, rank) {
  const node = ineligibleCardTemplate.content.cloneNode(true);

  node.querySelector(".rank-badge").textContent = String(rank);
  node.querySelector(".bank-name").textContent = item.banka;
  node.querySelector(".ineligible-message").textContent = item.message;

  return node;
}

function renderResults(items) {
  resultsList.innerHTML = "";

  items.forEach((item, index) => {
    const rank = index + 1;
    const node =
      item.type === "eligible"
        ? renderEligibleCard(item.data, rank)
        : renderIneligibleCard(item.data, rank);
    resultsList.appendChild(node);
  });

  resultsSection.hidden = items.length === 0;
}

function showInputError(message) {
  inputError.textContent = message;
  inputError.hidden = false;
}

function clearInputError() {
  inputError.hidden = true;
  inputError.textContent = "";
}

function showGunSayisiError(message) {
  gunSayisiError.textContent = message;
  gunSayisiError.hidden = false;
}

function clearGunSayisiError() {
  gunSayisiError.hidden = true;
  gunSayisiError.textContent = "";
}

async function handleCalculate() {
  clearInputError();
  clearGunSayisiError();
  resultsSection.hidden = true;

  const principal = parsePrincipalInput(principalInput.value);
  const gunSayisi = parsePrincipalInput(gunSayisiInput.value);

  if (!digitsOnly(principalInput.value)) {
    showInputError("Lütfen bir tutar girin.");
    return;
  }
  if (!Number.isFinite(principal) || principal <= 0) {
    showInputError("Lütfen geçerli bir tutar girin.");
    return;
  }

  if (!digitsOnly(gunSayisiInput.value)) {
    showGunSayisiError("Lütfen değerlendirme süresini gün olarak girin.");
    return;
  }
  if (!Number.isFinite(gunSayisi) || gunSayisi <= 0) {
    showGunSayisiError("Lütfen geçerli bir gün sayısı girin.");
    return;
  }
  if (gunSayisi > MAX_GUN_SAYISI) {
    showGunSayisiError(`Değerlendirme süresi en fazla ${MAX_GUN_SAYISI} gün olabilir.`);
    return;
  }

  calculateBtn.disabled = true;
  calculateBtn.textContent = "Hesaplanıyor...";

  try {
    const bankData = await loadBankData();
    const groups = groupByBank(bankData);

    const evaluateBank = (banka, entries) => {
      const band = findBandForBank(entries, principal);
      if (band) {
        return {
          type: "eligible",
          data: calculateResult(band, principal, gunSayisi),
        };
      }
      return {
        type: "ineligible",
        data: { banka, message: buildIneligibleMessage(entries, principal) },
      };
    };

    const pinnedEntries = groups.get(PINNED_BANK);
    groups.delete(PINNED_BANK);
    const pinned = pinnedEntries
      ? [evaluateBank(PINNED_BANK, pinnedEntries)]
      : [];

    const others = [];
    for (const [banka, entries] of groups) {
      others.push(evaluateBank(banka, entries));
    }

    const eligibleOthers = others
      .filter((item) => item.type === "eligible")
      .sort((a, b) => b.data.gunlukNetGetiri - a.data.gunlukNetGetiri);

    const ineligibleOthers = others
      .filter((item) => item.type === "ineligible")
      .sort((a, b) => a.data.banka.localeCompare(b.data.banka, "tr"));

    renderResults([...pinned, ...eligibleOthers, ...ineligibleOthers]);
  } catch (err) {
    console.error(err);
    showInputError("Banka verileri yüklenirken bir hata oluştu.");
  } finally {
    calculateBtn.disabled = false;
    calculateBtn.textContent = "Hesapla";
  }
}

calculateBtn.addEventListener("click", handleCalculate);
principalInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    handleCalculate();
  }
});
gunSayisiInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    handleCalculate();
  }
});

principalInput.addEventListener("input", () => {
  const cursorPos = principalInput.selectionStart ?? principalInput.value.length;
  const digitsBeforeCursor = countDigitsBeforeIndex(principalInput.value, cursorPos);

  const formatted = formatPrincipalDisplay(principalInput.value);
  principalInput.value = formatted;

  const newCursorPos = indexAfterNthDigit(formatted, digitsBeforeCursor);
  principalInput.setSelectionRange(newCursorPos, newCursorPos);
});

gunSayisiInput.addEventListener("input", () => {
  const cursorPos = gunSayisiInput.selectionStart ?? gunSayisiInput.value.length;
  const digitsBeforeCursor = countDigitsBeforeIndex(gunSayisiInput.value, cursorPos);

  const cleaned = digitsOnly(gunSayisiInput.value);
  gunSayisiInput.value = cleaned;

  const newCursorPos = Math.min(digitsBeforeCursor, cleaned.length);
  gunSayisiInput.setSelectionRange(newCursorPos, newCursorPos);
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((err) => {
      console.error("Service worker kaydı başarısız:", err);
    });
  });
}
