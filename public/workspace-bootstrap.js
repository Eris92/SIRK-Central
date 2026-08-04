"use strict";

(function () {
    const fragment = new URLSearchParams(String(window.location.hash || "").replace(/^#/, ""));
    const accessCode = fragment.get("access") || "";
    const originalFetch = window.fetch.bind(window);

    window.__SIRK_WORKSPACE_BOOTSTRAP = window.__SIRK_WORKSPACE_BOOTSTRAP || {
        authenticated: false,
        workspaces: ["portals"]
    };

    function normalizeIdentity(payload) {
        if (!payload || payload.authenticated !== true) return payload;

        const roles = Array.isArray(payload.roles)
            ? payload.roles
            : Array.isArray(payload.user && payload.user.roles)
                ? payload.user.roles
                : payload.role
                    ? [payload.role]
                    : [];
        const role = payload.role || roles[0] || "";
        const name = payload.displayName || payload.username || payload.userName || payload.name ||
            (payload.user && (payload.user.displayName || payload.user.username || payload.user.name)) || "";
        const authenticationMethod = payload.authenticationMethod || payload.source || "local-break-glass";
        const builtIn = role === "BreakGlass";

        return Object.assign({}, payload, {
            authenticated: true,
            id: payload.id || payload.userId || (payload.user && payload.user.id) || "",
            name,
            username: payload.username || payload.userName || name,
            displayName: payload.displayName || name,
            role,
            roles,
            source: String(authenticationMethod).includes("entra") ? "entra" : "local",
            authenticationMethod,
            builtIn,
            permissions: Array.isArray(payload.permissions)
                ? payload.permissions
                : builtIn
                    ? ["*"]
                    : []
        });
    }

    async function rewriteJsonResponse(response, transform) {
        const contentType = response.headers.get("content-type") || "";
        if (!contentType.includes("application/json")) return response;

        const payload = await response.clone().json();
        const transformed = transform(payload, response);
        if (transformed === payload) return response;

        const headers = new Headers(response.headers);
        headers.delete("content-length");
        return new Response(JSON.stringify(transformed), {
            status: response.status,
            statusText: response.statusText,
            headers
        });
    }

    window.fetch = async function sirkCompatibilityFetch(input, init) {
        const response = await originalFetch(input, init);
        let url;
        try {
            url = new URL(typeof input === "string" ? input : input.url, window.location.href);
        } catch (_) {
            return response;
        }

        if (url.origin !== window.location.origin) return response;

        if (url.pathname === "/api/access" && response.ok) {
            return rewriteJsonResponse(response, payload => {
                if (payload && payload.localLoginEnabled === true) return payload;
                return Object.assign({}, payload, {
                    error: "Invalid Break-Glass access code."
                });
            }).then(async rewritten => {
                const payload = await rewritten.clone().json();
                if (payload.localLoginEnabled === true) return rewritten;
                const headers = new Headers(rewritten.headers);
                headers.delete("content-length");
                return new Response(JSON.stringify(payload), {
                    status: 404,
                    headers
                });
            });
        }

        if ((url.pathname === "/api/session" || url.pathname === "/api/v1/auth/session") && response.ok) {
            return rewriteJsonResponse(response, normalizeIdentity);
        }

        if (url.pathname === "/api/login" && response.ok) {
            return rewriteJsonResponse(response, normalizeIdentity);
        }

        return response;
    };

    function hideLocalLogin() {
        const panel = document.getElementById("breakGlassPanel");
        if (panel) panel.hidden = true;
    }

    async function validateAccessCode() {
        hideLocalLogin();
        if (!accessCode) return false;

        try {
            const response = await originalFetch("/api/access", {
                credentials: "same-origin",
                headers: {
                    Authorization: "Bearer " + accessCode,
                    Accept: "application/json"
                },
                cache: "no-store"
            });
            if (!response.ok) return false;
            const result = await response.json();
            return result.localLoginEnabled === true;
        } catch (_) {
            return false;
        }
    }

    function mountAdvancedWorkspaceButton() {
        if (document.getElementById("advancedWorkspaceButton")) return;
        const settingsButton = document.getElementById("settingsButton");
        if (!settingsButton || !settingsButton.parentElement) return;

        const button = document.createElement("button");
        button.id = "advancedWorkspaceButton";
        button.type = "button";
        button.className = "secondary";
        button.textContent = document.documentElement.lang === "en" ? "Advanced" : "Zaawansowane";
        button.addEventListener("click", () => window.location.assign("/workspace.html"));
        settingsButton.insertAdjacentElement("afterend", button);
    }

    async function initialize() {
        const valid = await validateAccessCode();
        const panel = document.getElementById("breakGlassPanel");
        const loginView = document.getElementById("loginView");
        const dashboardView = document.getElementById("dashboardView");
        const dashboardVisible = Boolean(dashboardView && !dashboardView.hidden);

        if (panel) panel.hidden = !valid;
        if (loginView && !dashboardVisible) loginView.hidden = false;
        mountAdvancedWorkspaceButton();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initialize, { once: true });
    } else {
        initialize();
    }
}());
