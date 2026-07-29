"use strict";

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

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-lang]");
  if (!button) return;
  event.preventDefault();
  applyLanguage(button.dataset.lang);
});

applyLanguage(preferredLanguage());
