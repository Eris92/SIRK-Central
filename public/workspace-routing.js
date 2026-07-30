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
    let reconcileQueued = false;

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

    function desiredHidden(workspace) {
        if (!allowed.has(workspace)) return true;
        return workspace === "portals" && window.location.pathname === "/";
    }

    function bind(id, workspace) {
        const button = document.getElementById(id);
        if (!button) return false;

        const hidden = desiredHidden(workspace);
        if (button.hidden !== hidden) button.hidden = hidden;

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

    function queueReconcile() {
        if (reconcileQueued) return;
        reconcileQueued = true;
        window.requestAnimationFrame(function () {
            reconcileQueued = false;
            bindAll();
        });
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

    async function loadIdentityWithRetry() {
        for (const delay of [0, 50, 150, 400]) {
            if (delay) await new Promise(resolve => window.setTimeout(resolve, delay));
            try {
                const response = await fetch("/api/session", { credentials: "same-origin", cache: "no-store" });
                if (response.ok) return await response.json();
            } catch (_) {}
        }
        return null;
    }

    async function initialize() {
        const identity = await loadIdentityWithRetry();
        if (identity) allowed = new Set(workspaceFromIdentity(identity));

        bindAll();
        openCurrentWorkspace();

        const observer = new MutationObserver(queueReconcile);
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["hidden"]
        });

        for (const delay of [0, 100, 300, 800, 1500]) {
            window.setTimeout(bindAll, delay);
        }
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
    else initialize();
})();
