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

    const roleOrder = Object.freeze([
        "Auditor",
        "OperatorL1",
        "SupportL2",
        "EngineerL3",
        "Admin",
        "SecAdmin"
    ]);

    const bootstrap = window.__SIRK_WORKSPACE_BOOTSTRAP || { workspaces: ["portals"] };
    let allowed = new Set(Array.isArray(bootstrap.workspaces) ? bootstrap.workspaces : ["portals"]);
    const currentPath = window.location.pathname.toLowerCase();
    const currentWorkspace = Object.keys(routes).find(key => routes[key] === currentPath) || "portals";
    let identityRefresh = null;
    let roleRefresh = null;
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

    function rolesOf(identity) {
        const result = new Set();
        if (Array.isArray(identity && identity.roles)) {
            for (const role of identity.roles) if (role) result.add(String(role));
        }
        if (identity && identity.role) result.add(String(identity.role));
        return result;
    }

    function assignableRolesFromIdentity(identity) {
        const roles = rolesOf(identity);
        if (roles.has("BreakGlass")) return [...roleOrder];
        if (roles.has("SecAdmin")) return ["SecAdmin"];
        if (roles.has("Admin")) return roleOrder.filter(role => role !== "SecAdmin");
        return [];
    }

    function workspacesFromIdentity(identity) {
        if (!isAuthenticatedIdentity(identity)) return ["portals"];

        const permissions = permissionsOf(identity);
        const unrestricted = permissions.includes("*");
        const role = String(identity.role || "");
        const isBreakGlass =
            (identity.builtIn === true || identity.authenticationMethod === "local-break-glass") &&
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

    function populateRoleSelect(roles) {
        const select = document.getElementById("newRole");
        if (!select) return;

        const validRoles = roleOrder.filter(role => roles.includes(role));
        const previous = String(select.value || "");
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = document.documentElement.lang === "en"
            ? "Choose role"
            : "Wybierz rolę";
        placeholder.disabled = true;
        placeholder.selected = !validRoles.includes(previous);

        const options = validRoles.map(role => {
            const option = document.createElement("option");
            option.value = role;
            option.textContent = role;
            option.selected = role === previous;
            return option;
        });

        select.replaceChildren(placeholder, ...options);
        select.disabled = validRoles.length === 0;
        select.dataset.roleCatalogLoaded = validRoles.length ? "true" : "false";

        const error = document.getElementById("userError");
        if (error && validRoles.length > 0 && error.dataset.roleCatalogError === "true") {
            error.textContent = "";
            delete error.dataset.roleCatalogError;
        }
    }

    async function refreshRoleCatalog(identity) {
        const select = document.getElementById("newRole");
        if (!select) return;
        if (roleRefresh) return roleRefresh;

        roleRefresh = (async function () {
            let roles = [];
            try {
                const response = await fetch("/api/settings/roles", {
                    credentials: "same-origin",
                    cache: "no-store",
                    headers: { Accept: "application/json" }
                });
                const payload = await response.json().catch(() => ({}));
                if (response.ok && Array.isArray(payload.roles)) {
                    roles = payload.roles.filter(role => roleOrder.includes(role));
                }
            } catch (_) {
                // Fallback below uses the authenticated session role.
            }

            let resolvedIdentity = identity;
            if (!roles.length && !resolvedIdentity) {
                try {
                    const response = await fetch("/api/session", {
                        credentials: "same-origin",
                        cache: "no-store",
                        headers: { Accept: "application/json" }
                    });
                    if (response.ok) resolvedIdentity = await response.json();
                } catch (_) {
                    // A missing session is handled by the base login UI.
                }
            }

            if (!roles.length) roles = assignableRolesFromIdentity(resolvedIdentity);
            populateRoleSelect(roles);

            if (!roles.length) {
                const error = document.getElementById("userError");
                if (error) {
                    error.textContent = document.documentElement.lang === "en"
                        ? "No roles can be assigned by the current account."
                        : "Brak ról możliwych do przypisania przez bieżące konto.";
                    error.dataset.roleCatalogError = "true";
                }
            }
        }()).finally(function () {
            roleRefresh = null;
        });

        return roleRefresh;
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
                await refreshRoleCatalog(identity);
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

        if (
            button.dataset.permissionsTab === "add" ||
            button.dataset.settingsTab === "add-user" ||
            button.id === "addUserTabButton"
        ) {
            window.setTimeout(function () {
                const identity = window.__SIRK_WORKSPACE_BOOTSTRAP?.identity;
                refreshRoleCatalog(identity);
            }, 0);
        }

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

        const permissionsView = document.getElementById("accessView");
        if (permissionsView) {
            new MutationObserver(function () {
                if (!permissionsView.hidden) {
                    const identity = window.__SIRK_WORKSPACE_BOOTSTRAP?.identity;
                    refreshRoleCatalog(identity);
                }
            }).observe(permissionsView, {
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
                const identity = window.__SIRK_WORKSPACE_BOOTSTRAP?.identity;
                refreshRoleCatalog(identity);
            }, delay);
        }
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
    else initialize();
}());
