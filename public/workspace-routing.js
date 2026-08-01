"use strict";

(function () {
    const routes = Object.freeze({
        portals: "/",
        permissions: "/permissions",
        security: "/security",
        settings: "/settings",
        "break-glass": "/break-glass"
    });

    const buttonWorkspaces = Object.freeze({
        backButton: "portals",
        accessButton: "permissions",
        securityButton: "security",
        settingsButton: "settings",
        breakGlassButton: "break-glass"
    });

    const viewIds = Object.freeze({
        permissions: "accessView",
        security: "securityView",
        settings: "settingsView",
        "break-glass": "breakGlassView"
    });

    const bootstrap = window.__SIRK_WORKSPACE_BOOTSTRAP || { workspaces: ["portals"] };
    let allowed = new Set(Array.isArray(bootstrap.workspaces) ? bootstrap.workspaces : ["portals"]);
    const currentPath = window.location.pathname.toLowerCase();
    const currentWorkspace = Object.keys(routes).find(key => routes[key] === currentPath) || "portals";
    let identityRefresh = null;
    let openTimer = null;

    function workspacesFromIdentity(identity) {
        if (!identity || !identity.ok) return ["portals"];
        if (identity.builtIn === true && identity.source === "local" && identity.role === "BreakGlass") {
            return ["portals", "permissions", "security", "settings", "break-glass"];
        }
        const result = ["portals"];
        if (identity.role === "Admin") result.push("permissions", "settings");
        if (identity.role === "SecAdmin") result.push("permissions", "security", "settings");
        return result;
    }

    function synchronizeMenu() {
        for (const [id, workspace] of Object.entries(buttonWorkspaces)) {
            const button = document.getElementById(id);
            if (!button) continue;
            const hidden = !allowed.has(workspace);
            if (button.hidden !== hidden) button.hidden = hidden;
        }
    }

    function isWorkspaceOpen(workspace) {
        if (workspace === "portals") {
            const portals = document.getElementById("portalsView");
            return Boolean(portals && !portals.hidden);
        }
        const view = document.getElementById(viewIds[workspace]);
        return Boolean(view && !view.hidden);
    }

    function activateCurrentWorkspace() {
        if (currentWorkspace === "portals" || !allowed.has(currentWorkspace)) return true;
        if (isWorkspaceOpen(currentWorkspace)) return true;

        const buttonId = Object.keys(buttonWorkspaces).find(id => buttonWorkspaces[id] === currentWorkspace);
        const button = buttonId ? document.getElementById(buttonId) : null;
        const dashboard = document.getElementById("dashboardView");
        if (!button || button.hidden || !dashboard || dashboard.hidden) return false;

        button.dataset.workspaceInternalOpen = "1";
        try {
            button.click();
        } finally {
            delete button.dataset.workspaceInternalOpen;
        }
        return isWorkspaceOpen(currentWorkspace);
    }

    function stopOpenTimer() {
        if (openTimer) window.clearInterval(openTimer);
        openTimer = null;
    }

    function enforceCurrentWorkspace() {
        if (activateCurrentWorkspace()) return stopOpenTimer();
        if (openTimer) return;
        let attempts = 0;
        openTimer = window.setInterval(function () {
            attempts += 1;
            synchronizeMenu();
            if (activateCurrentWorkspace() || attempts >= 60) stopOpenTimer();
        }, 100);
    }

    async function refreshAllowedFromSession() {
        if (identityRefresh) return identityRefresh;
        identityRefresh = (async function () {
            try {
                const response = await fetch("/api/session", {
                    credentials: "same-origin",
                    cache: "no-store",
                    headers: { Accept: "application/json" }
                });
                if (!response.ok) return;
                const identity = await response.json();
                allowed = new Set(workspacesFromIdentity(identity));
                window.__SIRK_WORKSPACE_BOOTSTRAP = {
                    authenticated: Boolean(identity && identity.ok),
                    workspaces: Array.from(allowed)
                };
                synchronizeMenu();
                enforceCurrentWorkspace();
            } catch (_) {
                // The base UI owns authentication errors and login rendering.
            }
        }()).finally(function () {
            identityRefresh = null;
        });
        return identityRefresh;
    }

    function dashboardVisible() {
        const dashboard = document.getElementById("dashboardView");
        return Boolean(dashboard && !dashboard.hidden);
    }

    function dashboardBecameVisible() {
        if (!dashboardVisible()) return;
        refreshAllowedFromSession();
        enforceCurrentWorkspace();
    }

    document.addEventListener("click", function (event) {
        const button = event.target && event.target.closest ? event.target.closest("button") : null;
        if (!button) return;
        const workspace = buttonWorkspaces[button.id];
        if (!workspace || button.dataset.workspaceInternalOpen === "1") return;
        if (!allowed.has(workspace)) {
            event.preventDefault();
            event.stopImmediatePropagation();
            return;
        }

        const route = routes[workspace];
        if (route && window.location.pathname !== route) {
            event.preventDefault();
            event.stopImmediatePropagation();
            window.location.assign(route);
        }
    }, true);

    function initialize() {
        synchronizeMenu();
        enforceCurrentWorkspace();

        const dashboard = document.getElementById("dashboardView");
        if (dashboard) {
            const observer = new MutationObserver(dashboardBecameVisible);
            observer.observe(dashboard, { attributes: true, attributeFilter: ["hidden"] });
        }

        dashboardBecameVisible();
        for (const delay of [0, 100, 350, 800, 1600]) {
            window.setTimeout(function () {
                synchronizeMenu();
                dashboardBecameVisible();
            }, delay);
        }
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
    else initialize();
}());
