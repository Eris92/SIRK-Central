"use strict";

(function () {
  const path = window.location.pathname.toLowerCase();
  const targets = {
    "/admin": "accessButton",
    "/security": "securityButton",
    "/settings": "settingsButton",
    "/break-glass": "breakGlassButton"
  };
  const targetId = targets[path];
  if (!targetId) return;

  let attempts = 0;
  const maximumAttempts = 100;

  function activate() {
    attempts += 1;
    const dashboard = document.getElementById("dashboardView");
    const button = document.getElementById(targetId);
    if (dashboard && !dashboard.hidden && button && !button.hidden) {
      button.click();
      return;
    }
    if (attempts < maximumAttempts) window.setTimeout(activate, 100);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", activate, { once: true });
  } else {
    activate();
  }
})();
