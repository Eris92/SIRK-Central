"use strict";

function cookieLanguage() {
  const match = document.cookie.match(/(?:^|;\s*)sirk_lang=(pl|en)(?:;|$)/);
  return match ? match[1] : "";
}

function preferredLanguage() {
  return cookieLanguage() || (navigator.language || "pl").toLowerCase().startsWith("pl") ? (cookieLanguage() || "pl") : "en";
}

function applyLanguage(language) {
  const lang = language === "en" ? "en" : "pl";
  document.documentElement.lang = lang;
  document.cookie = `sirk_lang=${lang}; Path=/; Domain=.sirkportal.com; Max-Age=31536000; SameSite=Lax; Secure`;
  for (const element of document.querySelectorAll("[data-pl][data-en]")) {
    element.textContent = element.dataset[lang];
  }
  for (const button of document.querySelectorAll("[data-lang]")) {
    const active = button.dataset.lang === lang;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  document.title = lang === "pl" ? "SIRK — Central, Portal i Agent" : "SIRK — Central, Portal and Agent";
  const description = document.querySelector('meta[name="description"]');
  if (description) description.content = lang === "pl"
    ? "SIRK to bezpieczna platforma złożona z SIRK Central, SIRK Portal i SIRK Agent do zarządzania rozproszonymi środowiskami IT."
    : "SIRK is a secure platform combining SIRK Central, SIRK Portal and SIRK Agent for managing distributed IT environments.";
}

for (const button of document.querySelectorAll("[data-lang]")) {
  button.addEventListener("click", () => applyLanguage(button.dataset.lang));
}

applyLanguage(preferredLanguage());
