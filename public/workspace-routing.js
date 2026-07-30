"use strict";

(function () {
    const routes = Object.freeze({
        portals: "/",
        admin: "/admin",
        security: "/security",
        settings: "/settings",
        "break-glass": "/break-glass"
    });

    const buttonWorkspaces = Object.freeze({
        backButton: "portals",
        accessButton: "admin",
        securityButton: "security",
        settingsButton: "settings",
        breakGlassButton: "break-glass"
    });

    const viewIds = Object.freeze({
        admin: "accessView",
        security: "securityView",
        settings: "settingsView",
        "break-glass": "breakGlassView"
    });

    const bootstrap = window.__SIRK_WORKSPACE_BOOTSTRAP || { workspaces: ["portals"] };
    const allowed = new Set(Array.isArray(bootstrap.workspaces) ? bootstrap.workspaces : ["portals"]);
    const currentPath = window.location.pathname.toLowerCase();
    const currentWorkspace = Object.keys(routes).find(key => routes[key] === currentPath) || "portals";
    let reconcileQueued = false;
    let openTimer = null;

    function desiredHidden(workspace) {
        if (!allowed.has(workspace)) return true;
        return workspace === "portals" && currentWorkspace === "portals";
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

        const observer = new MutationObserver(function () {
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
                synchronizeMenu();
                enforceCurrentWorkspace();
            }, delay);
        }
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
    else initialize();
})();
