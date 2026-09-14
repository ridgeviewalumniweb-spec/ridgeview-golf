// Visual-only enhancements for the concept design. Does not touch form logic (script.js owns that).

// Scroll-reveal
const revealEls = document.querySelectorAll(".reveal");
if (revealEls.length) {
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("in");
          io.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.15 }
  );
  revealEls.forEach((el) => io.observe(el));
}

// Mobile hamburger nav — toggles the dropdown, closes when a link is tapped
const navToggle = document.getElementById("nav-toggle");
const siteNav = document.querySelector(".site-nav");
const navLinksEl = document.getElementById("nav-links");
if (navToggle && siteNav && navLinksEl) {
  navToggle.addEventListener("click", () => {
    const open = siteNav.classList.toggle("nav-open");
    navToggle.setAttribute("aria-expanded", open ? "true" : "false");
    navToggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  });
  navLinksEl.querySelectorAll("a").forEach((link) =>
    link.addEventListener("click", () => {
      siteNav.classList.remove("nav-open");
      navToggle.setAttribute("aria-expanded", "false");
      navToggle.setAttribute("aria-label", "Open menu");
    })
  );
}

// Sticky "Register" CTA — appears once the hero has scrolled out of view,
// hides again once the register form itself (or anything after it) is on
// screen so it doesn't float on top of the form/contact section.
const stickyCta = document.getElementById("sticky-cta");
const heroEl = document.querySelector(".hero");
const registerEl = document.getElementById("register");
if (stickyCta && heroEl && registerEl) {
  let heroVisible = true;
  let registerVisible = false;
  const updateStickyCta = () => stickyCta.classList.toggle("show", !heroVisible && !registerVisible);

  new IntersectionObserver(([entry]) => { heroVisible = entry.isIntersecting; updateStickyCta(); }, { threshold: 0 }).observe(heroEl);
  new IntersectionObserver(([entry]) => { registerVisible = entry.isIntersecting; updateStickyCta(); }, { threshold: 0 }).observe(registerEl);
}

// Golfers-registered thermometer. Reads the live count from the Apps Script backend
// (base golfers set in the Sheet + everyone who has paid online) and animates the bar.
// Uses JSONP so the browser can read it cross-origin without CORS headaches. If the
// backend isn't configured yet, or the request fails, it simply stays at 0.
const goalFill = document.getElementById("goal-fill");
const goalFillPending = document.getElementById("goal-fill-pending");
const goalCurrentLabel = document.getElementById("goal-current");
const goalConfirmedLabel = document.getElementById("goal-confirmed");
const goalPendingLabel = document.getElementById("goal-pending");

// registered = confirmed/paid golfers (plus the manual base number); pending =
// golfers who've signed up but haven't paid yet. The bar shows confirmed as a
// solid gold segment and pending as a striped segment right after it. `pending`
// may be undefined when talking to an older backend — treated as 0.
function setGolferCount(registered, pending, max) {
  const total = max || 72;
  const confirmed = Math.max(0, Math.min(Number(registered) || 0, total));
  const pend = Math.max(0, Number(pending) || 0);
  // The striped pending segment only fills whatever room is left after confirmed,
  // so the two together never overflow the 72-spot bar (the legend still shows the
  // true pending count even if the bar is visually capped).
  const pendShown = Math.min(pend, total - confirmed);
  if (goalCurrentLabel) goalCurrentLabel.textContent = String(confirmed);
  if (goalConfirmedLabel) goalConfirmedLabel.textContent = String(confirmed);
  if (goalPendingLabel) goalPendingLabel.textContent = String(pend);
  // Set the widths directly rather than inside requestAnimationFrame: rAF callbacks
  // are paused while a tab is in the background, so a page that finishes loading in a
  // background tab (opened via "open in new tab", etc.) would otherwise be left with
  // an empty bar. The 0% starting width is already painted from CSS, so assigning the
  // target width here still animates smoothly via the CSS width transition.
  if (goalFill) goalFill.style.width = Math.round((confirmed / total) * 100) + "%";
  if (goalFillPending) goalFillPending.style.width = Math.round((pendShown / total) * 100) + "%";
}

function fetchGolferCount(execUrl) {
  return new Promise((resolve, reject) => {
    const cbName = "__golfCount" + Date.now();
    const script = document.createElement("script");
    const timer = setTimeout(() => { cleanup(); reject(new Error("timeout")); }, 8000);
    function cleanup() {
      clearTimeout(timer);
      delete window[cbName];
      if (script.parentNode) script.parentNode.removeChild(script);
    }
    window[cbName] = (data) => { cleanup(); resolve(data); };
    script.onerror = () => { cleanup(); reject(new Error("load error")); };
    script.src = execUrl + (execUrl.indexOf("?") === -1 ? "?" : "&") + "callback=" + cbName;
    document.head.appendChild(script);
  });
}

if (goalFill) {
  const backendUrl = (typeof CONFIG !== "undefined" && CONFIG.APPS_SCRIPT_URL) || "";
  if (backendUrl && backendUrl.indexOf("PASTE_") === -1) {
    fetchGolferCount(backendUrl)
      .then((data) => setGolferCount(data.registered, data.pending, data.max))
      .catch(() => setGolferCount(0, 0, 72));
  } else {
    setGolferCount(0, 0, 72);
  }
}
