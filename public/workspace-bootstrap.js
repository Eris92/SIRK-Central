"use strict";

(function () {
    const fragment = new URLSearchParams(String(window.location.hash || "").replace(/^#/, ""));
    const hasAccess = Boolean(fragment.get("access"));

    window.__SIRK_WORKSPACE_BOOTSTRAP = window.__SIRK_WORKSPACE_BOOTSTRAP || {
        authenticated: false,
        workspaces: ["portals"]
    };

    function synchronizeLocalLogin() {
        const loginView = document.getElementById("loginView");
        const dashboardView = document.getElementById("dashboardView");
        const panel = document.getElementById("breakGlassPanel");
        if (!panel || !hasAccess) return;

        const dashboardVisible = Boolean(dashboardView && !dashboardView.hidden);
        if (!dashboardVisible) panel.hidden = false;
        if (loginView && !dashboardVisible) loginView.hidden = false;
    }

    function initialize() {
        synchronizeLocalLogin();

        const panel = document.getElementById("breakGlassPanel");
        const loginView = document.getElementById("loginView");
        const dashboardView = document.getElementById("dashboardView");
        if (!hasAccess || !panel) return;

        const observer = new MutationObserver(synchronizeLocalLogin);
        observer.observe(panel, { attributes: true, attributeFilter: ["hidden"] });
        if (loginView) observer.observe(loginView, { attributes: true, attributeFilter: ["hidden"] });
        if (dashboardView) observer.observe(dashboardView, { attributes: true, attributeFilter: ["hidden"] });

        for (const delay of [0, 25, 100, 350, 1000]) {
            window.setTimeout(synchronizeLocalLogin, delay);
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initialize, { once: true });
    } else {
        initialize();
    }
}());
