"use strict";

const PUBLIC_CONFIG_URL = "/.well-known/sirk-config.json";
const PUBLIC_CONFIG_CACHE_KEY = "sirk.public-config.last-good.v1";
const PUBLIC_CONFIG_DEFAULTS = Object.freeze({
  schemaVersion: 1,
  revision: 0,
  demo: { enabled: false, available: false, ctaUrl: null },
  features: { agent: true, portal: true, central: true, contact: true, registration: false },
  maintenance: { enabled: false, status: "operational", message: null }
});

function cookieLanguage() {
  const match = document.cookie.match(/(?:^|;\s*)sirk_lang=(pl|en)(?:;|$)/);
  return match ? match[1] : "";
}

function preferredLanguage() {
  const saved = cookieLanguage();
  if (saved) return saved;
  return (navigator.language || "pl").toLowerCase().startsWith("pl") ? "pl" : "en";
}

function applyLanguage(language) {
  const lang = language === "en" ? "en" : "pl";
  document.documentElement.lang = lang;
  document.cookie = `sirk_lang=${lang}; Path=/; Domain=.sirkportal.com; Max-Age=31536000; SameSite=Lax; Secure`;

  const heroTitle = document.querySelector(".hero h1");
  if (heroTitle) {
    heroTitle.dataset.pl = "Centralne zarządzanie infrastrukturą.";
    heroTitle.dataset.en = "Central infrastructure management.";
  }

  for (const element of document.querySelectorAll("[data-pl][data-en]")) {
    const translated = element.getAttribute(`data-${lang}`);
    if (translated !== null) element.textContent = translated;
  }

  for (const button of document.querySelectorAll("[data-lang]")) {
    const active = button.dataset.lang === lang;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }

  document.title = lang === "pl" ? "SIRK — Central, Portal i Agent" : "SIRK — Central, Portal and Agent";
  const description = document.querySelector('meta[name="description"]');
  if (description) {
    description.content = lang === "pl"
      ? "SIRK to bezpieczna platforma złożona z SIRK Central, SIRK Portal i SIRK Agent do zarządzania rozproszonymi środowiskami IT."
      : "SIRK is a secure platform combining SIRK Central, SIRK Portal and SIRK Agent for managing distributed IT environments.";
  }
}

function validPublicConfig(value) {
  if (!value || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0) return false;
  if (!value.demo || typeof value.demo.enabled !== "boolean" || typeof value.demo.available !== "boolean") return false;
  if (value.demo.ctaUrl !== null && value.demo.ctaUrl !== undefined) {
    try {
      const url = new URL(value.demo.ctaUrl, location.origin);
      if (url.protocol !== "https:" || !(url.hostname === "sirkportal.com" || url.hostname.endsWith(".sirkportal.com"))) return false;
    } catch (_) { return false; }
  }
  const features = value.features;
  if (!features || ["agent", "portal", "central", "contact", "registration"].some(key => typeof features[key] !== "boolean")) return false;
  const maintenance = value.maintenance;
  return Boolean(maintenance && typeof maintenance.enabled === "boolean" &&
    ["operational", "degraded", "maintenance"].includes(maintenance.status) &&
    (maintenance.message === null || maintenance.message === undefined || typeof maintenance.message === "string"));
}

function cachedPublicConfig() {
  try {
    const value = JSON.parse(localStorage.getItem(PUBLIC_CONFIG_CACHE_KEY) || "null");
    return validPublicConfig(value) ? value : null;
  } catch (_) { return null; }
}

async function loadPublicConfig() {
  try {
    const response = await fetch(PUBLIC_CONFIG_URL, { cache: "no-cache", credentials: "omit" });
    if (!response.ok) throw new Error("public config unavailable");
    const value = await response.json();
    if (!validPublicConfig(value)) throw new Error("public config invalid");
    localStorage.setItem(PUBLIC_CONFIG_CACHE_KEY, JSON.stringify(value));
    return value;
  } catch (_) {
    return cachedPublicConfig() || PUBLIC_CONFIG_DEFAULTS;
  }
}

function setVisible(selector, visible) {
  for (const element of document.querySelectorAll(selector)) element.hidden = !visible;
}

function applyPublicConfig(config) {
  const cards = document.querySelectorAll(".product-grid > article");
  if (cards[0]) cards[0].hidden = !config.features.central;
  if (cards[1]) cards[1].hidden = !config.features.portal;
  if (cards[2]) cards[2].hidden = !config.features.agent;
  setVisible(".stack-card.central", config.features.central);
  setVisible(".stack-card.portal", config.features.portal);
  setVisible(".stack-card.agent", config.features.agent);
  const contact = document.getElementById("kontakt");
  if (contact) contact.hidden = !config.features.contact;

  const actions = document.querySelector(".hero-actions");
  let demo = document.getElementById("sirkDemoCta");
  if (config.demo.enabled && config.demo.available && config.demo.ctaUrl && actions) {
    if (!demo) {
      demo = document.createElement("a");
      demo.id = "sirkDemoCta";
      demo.className = "secondary-button";
      demo.dataset.pl = "Uruchom Demo";
      demo.dataset.en = "Launch Demo";
      actions.append(demo);
    }
    demo.href = config.demo.ctaUrl;
    demo.hidden = false;
  } else if (demo) {
    demo.hidden = true;
  }

  let banner = document.getElementById("sirkMaintenanceBanner");
  if (config.maintenance.enabled && config.maintenance.message) {
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "sirkMaintenanceBanner";
      banner.setAttribute("role", "status");
      banner.style.cssText = "padding:10px 18px;text-align:center;font-weight:700;background:#fbbf24;color:#111827";
      document.querySelector(".topbar")?.insertAdjacentElement("afterend", banner);
    }
    banner.textContent = config.maintenance.message;
    banner.dataset.status = config.maintenance.status;
    banner.hidden = false;
  } else if (banner) {
    banner.hidden = true;
  }

  applyLanguage(preferredLanguage());
}

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-lang]");
  if (!button) return;
  event.preventDefault();
  applyLanguage(button.dataset.lang);
});

applyLanguage(preferredLanguage());
loadPublicConfig().then(applyPublicConfig);
