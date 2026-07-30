"use strict";

(function () {
  const ROUTES = Object.freeze({
    portals: "/",
    admin: "/admin",
    security: "/security",
    settings: "/settings",
    "break-glass": "/break-glass"
  });

  let allowed = new Set(["portals"]);

  function navigate(workspace) {
    const route = ROUTES[workspace];
    if (!route || !allowed.has(workspace)) return;
    if (window.location.pathname !== route) window.location.assign(route);
  }

  function bindButton(id, workspace) {
    const button = document.getElementById(id);
    if (!button) return false;
    button.hidden = !allowed.has(workspace);
    if (button.dataset.workspaceRouteBound === "1") return true;
    button.dataset.workspaceRouteBound = "1";
    button.addEventListener("click", function (event) {
      if (!allowed.has(workspace)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      navigate(workspace);
    }, { capture: true });
    return true;
  }

  function bindNavigation() {
    bindButton("backButton", "portals");
    bindButton("accessButton", "admin");
    bindButton("securityButton", "security");
    bindButton("settingsButton", "settings");
    bindButton("breakGlassButton", "break-glass");
  }

  function activateCurrentWorkspace() {
    const pathname = window.location.pathname.toLowerCase();
    if (pathname === "/admin") {
      document.getElementById("accessButton")?.click();
      return;
    }
    if (pathname === "/settings") {
      document.getElementById("settingsButton")?.click();
      return;
    }
    if (pathname === "/break-glass") {
      document.getElementById("breakGlassButton")?.click();
      return;
    }
    if (pathname === "/security") {
      const openSecurity = function () {
        const button = document.getElementById("securityButton");
        if (!button) return false;
        button.hidden = false;
        button.click();
        return true;
      };
      if (!openSecurity()) {
        const observer = new MutationObserver(function () {
          if (openSecurity()) observer.disconnect();
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
        window.setTimeout(function () { observer.disconnect(); }, 10000);
      }
    }
  }

  async function initialize() {
    try {
      const response = await fetch("/api/session", { credentials: "same-origin", cache: "no-store" });
      if (response.ok) {
        const identity = await response.json();
        allowed = new Set(Array.isArray(identity.workspaces) ? identity.workspaces : ["portals"]);
      }
    } catch (_) {}

    bindNavigation();
    activateCurrentWorkspace();

    const observer = new MutationObserver(function () { bindNavigation(); });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
  else initialize();
})();
