"use strict";

(() => {
  const separator = document.getElementById("breakGlassSeparator");
  const form = document.getElementById("localLogin");
  const status = document.getElementById("loginStatus");

  function hideLocal() {
    if (separator) separator.hidden = true;
    if (form) form.hidden = true;
  }

  function showLocal() {
    if (separator) separator.hidden = false;
    if (form) form.hidden = false;
  }

  async function validate() {
    hideLocal();
    const fragment = new URLSearchParams(String(location.hash || "").replace(/^#/, ""));
    const accessCode = fragment.get("access") || "";
    if (!accessCode) return;

    try {
      const response = await fetch("/api/access", {
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessCode}`
        }
      });
      if (!response.ok) return;
      const result = await response.json();
      if (result && result.localLoginEnabled === true) {
        showLocal();
        return;
      }
    } catch (_) {
      // Fail closed: local login remains hidden.
    }

    if (status) {
      status.textContent = "Nieprawidlowy Access URL Break-Glass.";
      status.className = "status error";
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", validate, { once: true });
  } else {
    validate();
  }
})();
