"use strict";

(function () {
    const routes = Object.freeze({
        portals: "/",
        admin: "/admin",
        security: "/security",
        settings: "/settings",
        "break-glass": "/break-glass"
    });

    let allowed = new Set(["portals"]);

    function workspaceFromIdentity(identity) {
        if (!identity || !identity.ok) return ["portals"];
        if (identity.builtIn === true && identity.source === "local" && identity.role === "BreakGlass") {
            return ["portals", "admin", "security", "settings", "break-glass"];
        }
        const result = ["portals"];
        if (identity.role === "Admin") result.push("admin", "settings");
        if (identity.role === "SecAdmin") result.push("security", "settings");
        return result;
    }

    function navigate(workspace) {
        const route = routes[workspace];
        if (!route || !allowed.has(workspace) || window.location.pathname === route) return;
        window.location.assign(route);
    }

    function bind(id, workspace) {
        const button = document.getElementById(id);
        if (!button) return false;
        button.hidden = !allowed.has(workspace);
        if (button.dataset.workspaceRouting === "1") return true;
        button.dataset.workspaceRouting = "1";
        button.addEventListener("click", function (event) {
            if (button.dataset.workspaceOpen === "1") return;
            if (!allowed.has(workspace)) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            navigate(workspace);
        }, { capture: true });
        return true;
    }

    function bindAll() {
        bind("backButton", "portals");
        bind("accessButton", "admin");
        bind("securityButton", "security");
        bind("settingsButton", "settings");
        bind("breakGlassButton", "break-glass");
    }

    function openCurrentWorkspace() {
        const pathname = window.location.pathname.toLowerCase();
        const mapping = {
            "/admin": "accessButton",
            "/security": "securityButton",
            "/settings": "settingsButton",
            "/break-glass": "breakGlassButton"
        };
        const buttonId = mapping[pathname];
        if (!buttonId) return;

        const open = function () {
            const button = document.getElementById(buttonId);
            if (!button || button.hidden) return false;
            button.dataset.workspaceOpen = "1";
            try {
                button.click();
            } finally {
                delete button.dataset.workspaceOpen;
            }
            return true;
        };

        if (open()) return;
        const observer = new MutationObserver(function () {
            bindAll();
            if (open()) observer.disconnect();
        });
        observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
        window.setTimeout(function () { observer.disconnect(); }, 10000);
    }

    async function initialize() {
        try {
            const response = await fetch("/api/session", { credentials: "same-origin", cache: "no-store" });
            if (response.ok) allowed = new Set(workspaceFromIdentity(await response.json()));
        } catch (_) {}

        bindAll();
        openCurrentWorkspace();

        const observer = new MutationObserver(bindAll);
        observer.observe(document.documentElement, { childList: true, subtree: true });
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
    else initialize();
})();
