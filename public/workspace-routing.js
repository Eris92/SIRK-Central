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
    let reconcileQueued = false;
    let openTimer = null;
    let identityRefreshInProgress = false;
    let dashboardWasVisible = false;

    function workspacesFromIdentity(identity) {
        if (!identity || !identity.ok) return ["portals"];
        if (identity.builtIn === true && identity.source === "local" && identity.role === "BreakGlass") {
            return ["portals", "permissions", "security", "settings", "break-glass"];
        }
        const result = ["portals"];
        if (identity.role === "Admin" || identity.role === "SysAdmin") result.push("permissions", "settings");
        if (identity.role === "SecAdmin") result.push("security", "settings");
        return result;
    }

    function desiredHidden(workspace) {
        return !allowed.has(workspace);
    }

    function synchronizeMenu() {
        for (const [id, workspace] of Object.entries(buttonWorkspaces)) {
            const button = document.getElementById(id);
            if (!button) continue;
            const hidden = desiredHidden(workspace);
            if (button.hidden !== hidden) button.hidden = hidden;
        }
    }

    function queueSynchronizeMenu() {
        if (reconcileQueued) return;
        reconcileQueued = true;
        window.requestAnimationFrame(function () {
            reconcileQueued = false;
            synchronizeMenu();
        });
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

    function enforceCurrentWorkspace() {
        if (activateCurrentWorkspace()) {
            if (openTimer) window.clearInterval(openTimer);
            openTimer = null;
            return;
        }
        if (!openTimer) {
            let attempts = 0;
            openTimer = window.setInterval(function () {
                attempts += 1;
                synchronizeMenu();
                if (activateCurrentWorkspace() || attempts >= 60) {
                    window.clearInterval(openTimer);
                    openTimer = null;
                }
            }, 100);
        }
    }

    async function refreshAllowedFromSession() {
        if (identityRefreshInProgress) return;
        identityRefreshInProgress = true;
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
        } finally {
            identityRefreshInProgress = false;
        }
    }

    function refreshWhenDashboardBecomesVisible() {
        const dashboard = document.getElementById("dashboardView");
        const visible = Boolean(dashboard && !dashboard.hidden);
        if (visible && !dashboardWasVisible) refreshAllowedFromSession();
        dashboardWasVisible = visible;
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
        refreshWhenDashboardBecomesVisible();
        enforceCurrentWorkspace();

        const observer = new MutationObserver(function () {
            refreshWhenDashboardBecomesVisible();
            queueSynchronizeMenu();
            enforceCurrentWorkspace();
        });
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["hidden"]
        });

        for (const delay of [0, 50, 150, 350, 700, 1200, 2000]) {
            window.setTimeout(function () {
                refreshWhenDashboardBecomesVisible();
                synchronizeMenu();
                enforceCurrentWorkspace();
            }, delay);
        }
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
    else initialize();
})();
