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

    const settingsPanels = Object.freeze({
        entra: "settingsTabEntra",
        updates: "settingsTabUpdates",
        backup: "settingsTabBackup"
    });

    const bootstrap = window.__SIRK_WORKSPACE_BOOTSTRAP || { workspaces: ["portals"] };
    let allowed = new Set(Array.isArray(bootstrap.workspaces) ? bootstrap.workspaces : ["portals"]);
    const currentPath = window.location.pathname.toLowerCase();
    const currentWorkspace = Object.keys(routes).find(key => routes[key] === currentPath) || "portals";
    let identityRefresh = null;
    let openTimer = null;

    function isAuthenticatedIdentity(identity) {
        if (!identity || typeof identity !== "object") return false;
        if (identity.authenticated === true || identity.ok === true) return true;
        return Boolean(
            (identity.id || identity.userId) &&
            (identity.username || identity.userName || identity.displayName)
        );
    }

    function permissionsOf(identity) {
        return Array.isArray(identity && identity.permissions) ? identity.permissions : [];
    }

    function workspacesFromIdentity(identity) {
        if (!isAuthenticatedIdentity(identity)) return ["portals"];

        const permissions = permissionsOf(identity);
        const unrestricted = permissions.includes("*");
        const role = String(identity.role || "");
        const isBreakGlass = identity.builtIn === true &&
            identity.source === "local" &&
            role === "BreakGlass";

        if (isBreakGlass || unrestricted) {
            return ["portals", "permissions", "security", "settings", "break-glass"];
        }

        const result = ["portals"];
        if (role === "Admin") result.push("permissions", "settings");
        if (role === "SecAdmin") result.push("permissions", "security", "settings");
        if (permissions.includes("access.manage")) result.push("permissions");
        if (permissions.includes("security.manage")) result.push("security");
        return Array.from(new Set(result));
    }

    function isWorkspaceOpen(workspace) {
        if (workspace === "portals") {
            const portals = document.getElementById("portalsView");
            return Boolean(portals && !portals.hidden);
        }
        const view = document.getElementById(viewIds[workspace]);
        return Boolean(view && !view.hidden);
    }

    function synchronizeMenu() {
        for (const [id, workspace] of Object.entries(buttonWorkspaces)) {
            const button = document.getElementById(id);
            if (!button) continue;
            const hidden = !allowed.has(workspace);
            if (button.hidden !== hidden) button.hidden = hidden;
        }

        const backButton = document.getElementById("backButton");
        if (backButton) backButton.hidden = isWorkspaceOpen("portals");
    }

    function synchronizeSettingsNavigation() {
        const settingsView = document.getElementById("settingsView");
        if (!settingsView) return;

        const navigation = settingsView.querySelector(".settings-tabs");
        if (!navigation) return;

        for (const button of navigation.querySelectorAll("[data-settings-tab]")) {
            const name = button.dataset.settingsTab;
            button.hidden = !Object.hasOwn(settingsPanels, name);
        }

        const visibleActive = navigation.querySelector(
            '[data-settings-tab]:not([hidden]).active'
        );
        if (!visibleActive) openSettingsTab("entra");
    }

    function openSettingsTab(name) {
        const selected = Object.hasOwn(settingsPanels, name) ? name : "entra";
        const settingsView = document.getElementById("settingsView");
        if (!settingsView) return;

        for (const [tab, panelId] of Object.entries(settingsPanels)) {
            const panel = document.getElementById(panelId);
            if (panel) panel.hidden = tab !== selected;
        }

        const navigation = settingsView.querySelector(".settings-tabs");
        if (navigation) {
            for (const button of navigation.querySelectorAll("[data-settings-tab]")) {
                const tab = button.dataset.settingsTab;
                button.hidden = !Object.hasOwn(settingsPanels, tab);
                button.classList.toggle("active", tab === selected);
            }
        }

        if (selected === "updates") {
            document.getElementById("refreshUpdateButton")?.click();
        } else if (selected === "backup") {
            document.getElementById("refreshBackupButton")?.click();
        }
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
            synchronizeSettingsNavigation();
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
                if (!response.ok) {
                    allowed = new Set(["portals"]);
                    synchronizeMenu();
                    return;
                }

                const identity = await response.json();
                allowed = new Set(workspacesFromIdentity(identity));
                window.__SIRK_WORKSPACE_BOOTSTRAP = {
                    authenticated: isAuthenticatedIdentity(identity),
                    identity,
                    workspaces: Array.from(allowed)
                };
                synchronizeMenu();
                synchronizeSettingsNavigation();
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
        synchronizeMenu();
        synchronizeSettingsNavigation();
        enforceCurrentWorkspace();
    }

    document.addEventListener("click", function (event) {
        const button = event.target && event.target.closest ? event.target.closest("button") : null;
        if (!button) return;

        const settingsTab = button.dataset.settingsTab;
        if (settingsTab && Object.hasOwn(settingsPanels, settingsTab)) {
            event.preventDefault();
            event.stopImmediatePropagation();
            openSettingsTab(settingsTab);
            return;
        }

        if (button.id === "backButton") {
            if (button.dataset.workspaceInternalOpen === "1") return;
            const route = routes.portals;
            if (window.location.pathname !== route) {
                event.preventDefault();
                event.stopImmediatePropagation();
                window.location.assign(route);
            }
            return;
        }

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
        synchronizeSettingsNavigation();
        enforceCurrentWorkspace();

        const dashboard = document.getElementById("dashboardView");
        if (dashboard) {
            const observer = new MutationObserver(dashboardBecameVisible);
            observer.observe(dashboard, { attributes: true, attributeFilter: ["hidden"] });
        }

        const settingsView = document.getElementById("settingsView");
        if (settingsView) {
            new MutationObserver(function () {
                synchronizeSettingsNavigation();
                if (!settingsView.hidden) {
                    const current = settingsView.querySelector(
                        '[data-settings-tab]:not([hidden]).active'
                    );
                    openSettingsTab(current?.dataset.settingsTab || "entra");
                }
            }).observe(settingsView, {
                attributes: true,
                attributeFilter: ["hidden"]
            });
        }

        for (const id of ["portalsView", ...Object.values(viewIds)]) {
            const view = document.getElementById(id);
            if (!view) continue;
            new MutationObserver(synchronizeMenu).observe(view, {
                attributes: true,
                attributeFilter: ["hidden"]
            });
        }

        dashboardBecameVisible();
        for (const delay of [0, 100, 350, 800, 1600]) {
            window.setTimeout(function () {
                synchronizeMenu();
                synchronizeSettingsNavigation();
                dashboardBecameVisible();
            }, delay);
        }
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
    else initialize();
}());
