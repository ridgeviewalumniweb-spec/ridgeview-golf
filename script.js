// ---- Configuration: fill these in after deployment (see SETUP.md) ----
const CONFIG = {
  // Apps Script Web App /exec URL, from Deploy > New deployment > Web app
  APPS_SCRIPT_URL: "https://script.google.com/macros/s/AKfycbyOXYHFvI3cNZkgEmSkQZ2Hr-FszZ0h1J6YgWf-FgnymqUR6SHnPhz-2u4ZRi4PW-qKrA/exec",
  // PayPal REST app Client ID (public — safe to expose in site JS). From
  // developer.paypal.com/dashboard > Apps & Credentials > your app > Client ID.
  // Use the LIVE app's Client ID, not Sandbox. See SETUP.md.
  PAYPAL_CLIENT_ID: "BAArkJGh33VS3VJ3J8VLO728XB-QDiIm5Zl0XL1TIwMtu1FIyjf5KyHpMgHZLxa8ICUmu4EikLzHLn2lyw",
};

const PLAY_PRICES = { "1": 150, "2": 300, "3": 450, "4": 600 };
const TIER_LABELS = {
  GOLDEN_ACE: "Golden Ace Sponsorship",
  SILVER_EAGLE: "Silver Eagle Sponsorship",
  BRONZE_BIRDIE: "Bronze Birdie Sponsorship",
  EXCLUSIVE: "Exclusive Sponsorship (Practice Green)",
  HOLE_TEE: "Individual Hole Sponsorship (Tee Box Only)",
  HOLE_TEE_GREEN: "Individual Hole Sponsorship (Tee Box & Green Side)",
};
const PLAY_LABEL = "Play a Round";

const state = { activeTab: "play" };

// Minted once per registration on the client and reused across retries (see the
// submit handler + saveRegistration). Keeping it stable means a resubmission maps to
// the SAME row on the backend instead of creating a duplicate.
let currentRegistrationId = null;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const PLAY_REQUIRED_IDS = ["#play-name", "#play-email", "#play-phone"];
const SPONSOR_REQUIRED_IDS = ["#sponsor-company", "#sponsor-contact", "#sponsor-email", "#sponsor-phone"];

// Fields in the hidden panel keep `required` unless we clear it here — hidden
// required fields still block native form validation even though invisible.
function syncRequiredFields(activePanel) {
  PLAY_REQUIRED_IDS.forEach((sel) => $(sel).required = activePanel === "play");
  SPONSOR_REQUIRED_IDS.forEach((sel) => $(sel).required = activePanel === "sponsor-form");
}

// ---- Tab switching ----
function setTab(target) {
  const isDonate = target === "donate";
  state.activeTab = isDonate ? "donate" : (target === "sponsor-form" ? "sponsor" : "play");
  $("#tab-play").classList.toggle("active", target === "play");
  $("#tab-sponsor").classList.toggle("active", target === "sponsor-form");
  $("#tab-donate").classList.toggle("active", isDonate);
  $("#panel-play").classList.toggle("active", target === "play");
  $("#panel-sponsor-form").classList.toggle("active", target === "sponsor-form");
  $("#panel-donate").classList.toggle("active", isDonate);
  syncRequiredFields(target);

  // Donations pay inline within their own panel (their own amount + PayPal button),
  // so hide the shared "Amount Due" strip, the "Continue to Payment" submit button,
  // and any leftover confirm/message panels while the Donate tab is active.
  const outerSummary = $("#amount-value").closest(".amount-summary");
  outerSummary.style.display = isDonate ? "none" : "";
  $("#submit-btn").style.display = isDonate ? "none" : "";
  if (isDonate) {
    $("#confirm-panel").classList.remove("show");
    $("#form-msg").classList.remove("show");
    initDonatePaypal();
  }
  updateAmount();
}

$("#tab-play").addEventListener("click", () => setTab("play"));
$("#tab-sponsor").addEventListener("click", () => setTab("sponsor-form"));
$("#tab-donate").addEventListener("click", () => setTab("donate"));

// ---- Player slots (optional extra players) ----
function renderPlayerSlots() {
  const count = parseInt($("#play-count").value, 10);
  const container = $("#player-slots");
  container.innerHTML = "";
  for (let i = 2; i <= count; i++) {
    const field = document.createElement("div");
    field.className = "field";
    field.style.margin = "0";
    field.innerHTML = `
      <label for="player-${i}">Player ${i} Name <span class="hint">(optional)</span></label>
      <input type="text" id="player-${i}" name="player${i}Name" placeholder="Fill in now, or we'll follow up">
    `;
    container.appendChild(field);
  }
}

$("#play-count").addEventListener("change", () => {
  renderPlayerSlots();
  updateAmount();
});

// ---- Sponsor tier selection ----
$$('input[name="tier"]').forEach((el) => {
  el.addEventListener("change", updateAmount);
});

// ---- Amount calculation ----
function currentAmount() {
  if (state.activeTab === "play") {
    return PLAY_PRICES[$("#play-count").value] || 0;
  }
  const checked = document.querySelector('input[name="tier"]:checked');
  return checked ? parseInt(checked.dataset.amount, 10) : 0;
}

function currentCategory() {
  if (state.activeTab === "play") return "PLAY";
  const checked = document.querySelector('input[name="tier"]:checked');
  return checked ? checked.value : null;
}

function currentCategoryLabel() {
  const category = currentCategory();
  if (category === "PLAY") return PLAY_LABEL;
  return TIER_LABELS[category] || category || "Registration";
}

function updateAmount() {
  const amount = currentAmount();
  $("#amount-value").textContent = amount ? `$${amount.toLocaleString()}` : "$0";
}

// ---- Helpers ----
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function showMsg(text, type) {
  const el = $("#form-msg");
  el.textContent = text;
  el.className = `form-msg show ${type}`;
}

// Validates + normalizes a phone number to a single consistent format, so every new
// row in the sheet looks the same — "(770) 555-1234". Accepts a 10-digit US number,
// or 11 digits starting with 1 (country code). Returns null if it isn't a usable
// number (too few/many digits, letters, junk) so the caller can reject it before
// taking payment. Mirrors normalizePhone() in Code.gs (the server re-normalizes as a
// backstop, since client-side checks can be bypassed).
function normalizePhone(raw) {
  let digits = String(raw || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.charAt(0) === "1") digits = digits.slice(1);
  if (digits.length !== 10) return null;
  return "(" + digits.slice(0, 3) + ") " + digits.slice(3, 6) + "-" + digits.slice(6);
}

// ---- Reliable save (works behind VPNs / proxies / script blockers) ----
// A POST to an Apps Script /exec URL doesn't return its JSON directly — it 302-
// redirects to a googleusercontent.com address that carries the reply. Plenty of
// VPNs, corporate proxies, and privacy/script blockers mangle or block that second
// hop, so the browser can't READ the reply even though the POST reached the backend
// and the row saved. That produced false "something went wrong" errors and duplicate
// rows from people resubmitting. Fix: the client mints the RegistrationID itself (so
// it never needs to read the reply to learn it), the backend treats a repeat of that
// ID as the same registration (no duplicate row/email), and we confirm the save over
// the SAME JSONP <script>-tag GET channel the golfer counter uses — which gets through
// the CORS/proxy/blocker setups that break the POST reply.
function makeRegistrationId() {
  return "RGS-" + Date.now().toString(36).toUpperCase() +
    "-" + Math.random().toString(36).slice(2, 7).toUpperCase();
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// Rejects if `promise` hasn't settled within `ms`. Deliberately does NOT abort the
// underlying request — we want the POST to keep going and save server-side even once
// we stop waiting to read its (often unreadable) reply.
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

// JSONP GET — loads the URL as a <script> tag (same technique as the counter in
// enhance.js). Cross-origin script loads aren't subject to CORS and are rarely
// blocked, which is exactly why we confirm the save this way.
function jsonpGet(baseUrl, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const cb = "__regChk" + Date.now() + Math.floor(Math.random() * 1000);
    const script = document.createElement("script");
    const timer = setTimeout(() => { cleanup(); reject(new Error("timeout")); }, timeoutMs || 8000);
    function cleanup() {
      clearTimeout(timer);
      delete window[cb];
      if (script.parentNode) script.parentNode.removeChild(script);
    }
    window[cb] = (data) => { cleanup(); resolve(data); };
    script.onerror = () => { cleanup(); reject(new Error("load error")); };
    const q = Object.keys(params).map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(params[k]));
    q.push("callback=" + cb);
    script.src = baseUrl + (baseUrl.indexOf("?") === -1 ? "?" : "&") + q.join("&");
    document.head.appendChild(script);
  });
}

// Polls the backend (via JSONP) until it confirms the registration row exists.
// Retries a few times to allow for the row-write to propagate right after the POST.
async function confirmRegistrationSaved(registrationId) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const data = await jsonpGet(CONFIG.APPS_SCRIPT_URL, { regId: registrationId }, 8000);
      if (data && data.found) return true;
    } catch (err) {
      // Ignore and retry — a restrictive network may drop an individual attempt.
    }
    await sleep(1500);
  }
  return false;
}

// Saves the registration and resolves true once the save is CONFIRMED. Tries to read
// the POST reply for a fast path (works for most people), but never depends on it: if
// that reply is unreadable (VPN/proxy/blocker), it confirms out-of-band via JSONP.
async function saveRegistration(payload) {
  try {
    const res = await withTimeout(fetch(CONFIG.APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
    }), 12000);
    const data = await res.json();
    if (data && (data.registrationId || data.ok)) return true;
  } catch (err) {
    // Expected behind restrictive networks: the POST still reached the backend and
    // saved — we just couldn't read the reply. Confirm it landed via JSONP below.
    console.warn("Couldn't read POST reply; confirming save via JSONP", err);
  }
  return await confirmRegistrationSaved(payload.registrationId);
}

// ---- PayPal Smart Buttons ----
// Loaded on demand (only once someone actually reaches the payment step) so the
// PayPal SDK never blocks the page's initial load. custom_id carries our own
// RegistrationID into the PayPal order, so when the payment webhook reaches the
// Apps Script backend it can match the exact registration instead of guessing
// from the payer's name/email.
let paypalSdkPromise = null;
function loadPaypalSdk() {
  if (paypalSdkPromise) return paypalSdkPromise;
  paypalSdkPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(CONFIG.PAYPAL_CLIENT_ID)}&currency=USD&intent=capture`;
    script.onload = () => resolve(window.paypal);
    script.onerror = () => reject(new Error("PayPal SDK failed to load"));
    document.head.appendChild(script);
  });
  return paypalSdkPromise;
}

async function renderPaypalButtons(registrationId, amount, categoryLabel) {
  const container = $("#paypal-button-container");
  container.innerHTML = "";

  let paypal;
  try {
    paypal = await loadPaypalSdk();
  } catch (err) {
    console.error("PayPal SDK load failed", err);
    container.innerHTML = '<p class="form-msg show error">Payment is temporarily unavailable. Use "I\'ll pay later" below, or contact Stan Dixon directly.</p>';
    return;
  }

  paypal.Buttons({
    style: { layout: "vertical", color: "gold", shape: "rect", label: "pay" },
    createOrder: (data, actions) => actions.order.create({
      purchase_units: [{
        description: `${categoryLabel} — Sam Anders Serenity Scramble (${registrationId})`,
        custom_id: registrationId,
        amount: { currency_code: "USD", value: String(amount) },
      }],
    }),
    onApprove: (data, actions) => actions.order.capture().then(() => {
      container.innerHTML = "";
      $("#pay-nudge").style.display = "none";
      $("#pay-later-btn").style.display = "none";
      $("#pay-later-note").classList.remove("show");
      $("#confirm-intro").style.display = "none";
      $("#confirm-payline").style.display = "none";
      $("#submit-btn").style.display = "none";
      $("#payment-success").classList.add("show");
    }),
    onCancel: () => {
      // No-op: they can just click the button again, or use "I'll pay later".
    },
    onError: (err) => {
      console.error("PayPal checkout error", err);
      showMsg("Something went wrong with PayPal. Please try again, or use \"I'll pay later\" below.", "error");
    },
  }).render("#paypal-button-container");
}

// ---- Donate to the Alumni Association ----
// A deliberately low-friction path: the donor just picks (or types) an amount and
// pays with PayPal — no registration row is saved and no form is submitted. Each
// gift's PayPal order carries a custom_id that starts with "DONATION-", which the
// backend recognizes: it logs the gift to a "Donations" tab and, importantly, does
// NOT treat it as an unmatched registration (which would email the coordinator on
// every donation). Full donor details are always visible in PayPal itself.
let donateSelectedAmount = 0;
let donatePaypalRendered = false;

function donationAmount() { return donateSelectedAmount; }

function makeDonationId() {
  return "DONATION-" + Date.now().toString(36).toUpperCase() +
    "-" + Math.random().toString(36).slice(2, 7).toUpperCase();
}

function updateDonateAmount() {
  const v = donationAmount();
  $("#donate-amount-value").textContent = v ? `$${v.toLocaleString()}` : "$0";
  const ok = v >= 1;
  // Only reveal the PayPal button once a valid amount is chosen.
  $("#donate-paypal-container").style.display = ok && donatePaypalRendered ? "block" : "none";
  const hint = $("#donate-hint");
  if (!ok) {
    hint.textContent = "Choose an amount above to continue to PayPal.";
    hint.style.display = "block";
  } else if (donatePaypalRendered) {
    hint.style.display = "none";
  }
}

$$(".donate-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    const isOther = chip.id === "donate-other-btn";
    $$(".donate-chip").forEach((c) => c.classList.toggle("active", c === chip));
    if (isOther) {
      $("#donate-custom-field").hidden = false;
      const input = $("#donate-custom");
      input.focus();
      donateSelectedAmount = Math.max(0, Math.floor(Number(input.value) || 0));
    } else {
      $("#donate-custom-field").hidden = true;
      donateSelectedAmount = Number(chip.dataset.amount) || 0;
    }
    updateDonateAmount();
  });
});

$("#donate-custom").addEventListener("input", () => {
  donateSelectedAmount = Math.max(0, Math.floor(Number($("#donate-custom").value) || 0));
  updateDonateAmount();
});

// Renders the donation PayPal button once, the first time the Donate tab is opened.
// createOrder reads the amount live at click time, so the single rendered button
// always uses whatever the donor has currently selected.
async function initDonatePaypal() {
  if (donatePaypalRendered) return;

  const paymentConfigured = CONFIG.PAYPAL_CLIENT_ID && !CONFIG.PAYPAL_CLIENT_ID.startsWith("PASTE_");
  if (!paymentConfigured) {
    const hint = $("#donate-hint");
    hint.textContent = "Online donations are being finalized. To give right now, contact Stan Dixon at (404) 210-1740 or stanldixon@gmail.com.";
    hint.style.display = "block";
    return;
  }

  let paypal;
  try {
    paypal = await loadPaypalSdk();
  } catch (err) {
    console.error("PayPal SDK load failed", err);
    const hint = $("#donate-hint");
    hint.textContent = "Payment is temporarily unavailable. Please try again shortly, or contact Stan Dixon at (404) 210-1740.";
    hint.style.display = "block";
    return;
  }

  donatePaypalRendered = true;
  paypal.Buttons({
    style: { layout: "vertical", color: "gold", shape: "rect", label: "pay" },
    onClick: (data, actions) => {
      if (donationAmount() < 1) {
        const hint = $("#donate-hint");
        hint.textContent = "Please choose or enter an amount of $1 or more first.";
        hint.style.display = "block";
        return actions.reject();
      }
      return actions.resolve();
    },
    createOrder: (data, actions) => actions.order.create({
      purchase_units: [{
        description: "Donation — Ridgeview Alumni Charitable Corporation",
        custom_id: makeDonationId(),
        amount: { currency_code: "USD", value: String(donationAmount()) },
      }],
    }),
    onApprove: (data, actions) => actions.order.capture().then(() => {
      $("#donate-amounts").style.display = "none";
      $("#donate-custom-field").hidden = true;
      $("#donate-paypal-container").style.display = "none";
      $("#donate-hint").style.display = "none";
      $("#donate-amount-value").closest(".amount-summary").style.display = "none";
      const intro = document.querySelector("#panel-donate .donate-intro");
      if (intro) intro.style.display = "none";
      $("#donate-success").classList.add("show");
    }),
    onError: (err) => {
      console.error("PayPal donation error", err);
      const hint = $("#donate-hint");
      hint.textContent = "Something went wrong with PayPal. Please try again, or contact Stan Dixon directly.";
      hint.style.display = "block";
    },
  }).render("#donate-paypal-container");

  updateDonateAmount();
}

// ---- Submit ----
$("#reg-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;

  // The Donate tab has no "Continue to Payment" step — it pays inline via its own
  // PayPal button — so this shared submit handler should never act on it.
  if (state.activeTab === "donate") return;

  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }

  const category = currentCategory();
  if (state.activeTab === "sponsor" && !category) {
    showMsg("Please select a sponsorship level.", "error");
    return;
  }

  // Validate + normalize the phone before doing anything else, so a bad number is
  // caught before we save or take payment. Write the clean format back into the
  // field so the person sees exactly what will be recorded.
  const phoneField = state.activeTab === "play" ? $("#play-phone") : $("#sponsor-phone");
  const normalizedPhone = normalizePhone(phoneField.value);
  if (!normalizedPhone) {
    showMsg("Please enter a valid 10-digit U.S. phone number, for example (770) 555-1234.", "error");
    phoneField.focus();
    return;
  }
  phoneField.value = normalizedPhone;

  const amount = currentAmount();
  const submitBtn = $("#submit-btn");
  submitBtn.disabled = true;
  submitBtn.textContent = "Submitting...";
  showMsg("", "");
  $("#form-msg").classList.remove("show");

  const payload = {
    formType: "registration",
    category,
    amount,
    contactName: "",
    contactEmail: "",
    contactPhone: "",
    companyName: "",
    players: [],
    notes: "",
    logo: null,
  };

  if (state.activeTab === "play") {
    payload.contactName = $("#play-name").value.trim();
    payload.contactEmail = $("#play-email").value.trim();
    payload.contactPhone = $("#play-phone").value.trim();
    payload.notes = $("#play-notes").value.trim();
    payload.players = [payload.contactName];
    const count = parseInt($("#play-count").value, 10);
    for (let i = 2; i <= count; i++) {
      const val = $(`#player-${i}`) ? $(`#player-${i}`).value.trim() : "";
      payload.players.push(val || "(TBD)");
    }
  } else {
    payload.contactName = $("#sponsor-contact").value.trim();
    payload.contactEmail = $("#sponsor-email").value.trim();
    payload.contactPhone = $("#sponsor-phone").value.trim();
    payload.companyName = $("#sponsor-company").value.trim();
    payload.notes = $("#sponsor-notes").value.trim();

    const fileInput = $("#sponsor-logo");
    if (fileInput.files && fileInput.files[0]) {
      const file = fileInput.files[0];
      try {
        const base64 = await fileToBase64(file);
        payload.logo = { name: file.name, type: file.type, dataBase64: base64 };
      } catch (err) {
        console.warn("Logo read failed, continuing without it", err);
      }
    }
  }

  const backendConfigured = CONFIG.APPS_SCRIPT_URL && !CONFIG.APPS_SCRIPT_URL.startsWith("PASTE_");
  const paymentConfigured = CONFIG.PAYPAL_CLIENT_ID && !CONFIG.PAYPAL_CLIENT_ID.startsWith("PASTE_");

  // Only go fully live (save + show a real payment button) when BOTH the backend
  // and PayPal are configured — otherwise we'd capture someone's registration and
  // then hand them a payment step that doesn't work. Until then, point people to
  // the coordinator so no one falls into a broken flow.
  if (!backendConfigured || !paymentConfigured) {
    showMsg(
      "Online registration is being finalized. To reserve your spot right now, contact Stan Dixon at (404) 210-1740 or stanldixon@gmail.com.",
      "info"
    );
    submitBtn.disabled = false;
    submitBtn.textContent = "Continue to Payment";
    return;
  }

  // Mint the RegistrationID here (not on the server) and reuse it across retries, so
  // a resubmission maps to the SAME backend row — no duplicate, no duplicate email.
  if (!currentRegistrationId) currentRegistrationId = makeRegistrationId();
  payload.registrationId = currentRegistrationId;

  const saved = await saveRegistration(payload);
  if (!saved) {
    console.error("Registration could not be confirmed");
    showMsg("We couldn't confirm your registration. Please try again, or contact Stan Dixon at (404) 210-1740 or stanldixon@gmail.com.", "error");
    submitBtn.disabled = false;
    submitBtn.textContent = "Continue to Payment";
    return;
  }
  const registrationId = currentRegistrationId;

  const categoryLabel = currentCategoryLabel();
  $("#confirm-reg-id").textContent = registrationId;
  $("#confirm-amount").textContent = `$${amount.toLocaleString()}`;
  $("#confirm-panel").classList.add("show");
  form.querySelectorAll("input, select, textarea, button[type=submit]").forEach((el) => (el.disabled = true));
  submitBtn.style.display = "none";
  showMsg("Registration captured. Check your email for a confirmation.", "success");

  renderPaypalButtons(registrationId, amount, categoryLabel);
});

// "I'll pay later" — the spot is already saved as Pending; just reassure them
// and surface the emailed-payment-link note. No backend call needed.
$("#pay-later-btn").addEventListener("click", () => {
  $("#pay-later-note").classList.add("show");
});

// Tidy the phone into its final format when the person leaves the field (only once
// it's a valid number), so they see the consistent format before submitting.
["#play-phone", "#sponsor-phone"].forEach((sel) => {
  const el = $(sel);
  if (!el) return;
  el.addEventListener("blur", () => {
    const norm = normalizePhone(el.value);
    if (norm) el.value = norm;
  });
});

// ---- Init ----
renderPlayerSlots();
syncRequiredFields("play");
updateAmount();
