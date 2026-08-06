const PINNED_BANK = "TOM Bank";
const STOPAJ_ORANI = 0.175;
const NET_KATSAYI = 1 - STOPAJ_ORANI; // 0.825
const YIL_GUN = 365;

const principalInput = document.getElementById("principal");
const inputError = document.getElementById("input-error");
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

const percentFormatter = new Intl.NumberFormat("tr-TR", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatTL(value) {
  return tlFormatter.format(value);
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
  const response = await fetch("data/banks.json");
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

function calculateResult(entry, principal) {
  const vadesizdeKalan = entry.vadesizdeKalacak;
  const degerlenecekTutar = Math.max(0, principal - vadesizdeKalan);
  const gunlukBrutGetiri = (degerlenecekTutar * entry.yillikBrutOran) / YIL_GUN;
  const gunlukNetGetiri = gunlukBrutGetiri * NET_KATSAYI;
  const otuzGunNetGetiri = gunlukNetGetiri * 30;
  const etkinBrutOran =
    principal > 0 ? (degerlenecekTutar * entry.yillikBrutOran) / principal : 0;

  return {
    banka: entry.banka,
    not: entry.not || "",
    yillikBrutOran: entry.yillikBrutOran,
    vadesizdeKalan,
    degerlenecekTutar,
    gunlukNetGetiri,
    otuzGunNetGetiri,
    etkinBrutOran,
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
  node.querySelector(".rate-effective").textContent = `Etkin: ${formatPercent(
    result.etkinBrutOran
  )}`;

  node.querySelector(".main-result-value").textContent = formatTL(
    result.gunlukNetGetiri
  );

  node.querySelector(".stat-vadesiz").textContent = formatTL(
    result.vadesizdeKalan
  );
  node.querySelector(".stat-degerlenecek").textContent = formatTL(
    result.degerlenecekTutar
  );
  node.querySelector(".stat-otuzgun").textContent = formatTL(
    result.otuzGunNetGetiri
  );

  const noteEl = node.querySelector(".bank-note");
  if (result.not) {
    noteEl.textContent = result.not;
    noteEl.hidden = false;
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

async function handleCalculate() {
  clearInputError();
  resultsSection.hidden = true;

  const principal = parsePrincipalInput(principalInput.value);

  if (!digitsOnly(principalInput.value)) {
    showInputError("Lütfen bir tutar girin.");
    return;
  }
  if (!Number.isFinite(principal) || principal <= 0) {
    showInputError("Lütfen geçerli bir tutar girin.");
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
        return { type: "eligible", data: calculateResult(band, principal) };
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

principalInput.addEventListener("input", () => {
  const cursorPos = principalInput.selectionStart ?? principalInput.value.length;
  const digitsBeforeCursor = countDigitsBeforeIndex(principalInput.value, cursorPos);

  const formatted = formatPrincipalDisplay(principalInput.value);
  principalInput.value = formatted;

  const newCursorPos = indexAfterNthDigit(formatted, digitsBeforeCursor);
  principalInput.setSelectionRange(newCursorPos, newCursorPos);
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((err) => {
      console.error("Service worker kaydı başarısız:", err);
    });
  });
}
