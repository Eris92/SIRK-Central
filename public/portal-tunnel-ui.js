"use strict";

(function () {
    let session = null;
    let refreshPromise = null;
    let observer = null;
    let connectionPending = false;

    function lang() {
        return document.documentElement.lang === "en" ? "en" : "pl";
    }

    function label(pl, en) {
        return lang() === "en" ? en : pl;
    }

    async function readJson(path, options) {
        const response = await fetch(path, Object.assign({
            credentials: "same-origin",
            cache: "no-store",
            headers: { Accept: "application/json" }
        }, options || {}));
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error(
                payload.error || payload.title || `HTTP ${response.status}`);
            error.status = response.status;
            error.payload = payload;
            throw error;
        }
        return payload;
    }

    async function readSession() {
        if (session && session.authenticated === true) return session;
        session = await readJson("/api/session");
        return session;
    }

    async function csrf() {
        const value = await readJson("/api/v1/auth/csrf");
        if (!value.requestToken) throw new Error("Central did not issue a CSRF token.");
        return value;
    }

    function isBreakGlass(identity) {
        return identity && (
            identity.role === "BreakGlass" ||
            (Array.isArray(identity.roles) && identity.roles.includes("BreakGlass")) ||
            identity.authenticationMethod === "local-break-glass");
    }

    async function effectiveAccess(identity, portalId) {
        if (isBreakGlass(identity)) {
            return {
                allowed: true,
                teams: ["Break-Glass"],
                capabilities: { "portal.connect": "allow" }
            };
        }

        const identityKey = String(identity.id || identity.userId || "").trim();
        if (!identityKey) {
            return { allowed: false, teams: [], capabilities: { "portal.connect": "deny" } };
        }

        try {
            return await readJson(
                `/api/v1/access-control/effective/${encodeURIComponent(identityKey)}/${encodeURIComponent(portalId)}`);
        } catch (_) {
            return { allowed: false, teams: [], capabilities: { "portal.connect": "deny" } };
        }
    }

    function portalIdFromCard(card) {
        return String(card.querySelector("code")?.textContent || "").trim();
    }

    function setButtonState(button, state) {
        button.className = state === "allow" ? "button" : "button disabled";
        button.disabled = state !== "allow";
        button.dataset.sirkTunnelState = state;
        button.textContent = state === "allow"
            ? label("Połącz", "Connect")
            : state === "approval"
                ? label("Wymaga zatwierdzenia", "Approval required")
                : label("Brak dostępu", "No access");
        button.title = state === "allow"
            ? label("Połącz z Portalem przez reverse tunnel", "Connect through the reverse tunnel")
            : state === "approval"
                ? label("Ta rola wymaga zatwierdzenia połączenia", "This role requires connection approval")
                : label("Brak przypisania zespołu lub capability portal.connect", "No team assignment or portal.connect capability");
    }

    async function connect(portalId, button) {
        if (connectionPending) return;
        connectionPending = true;
        const previous = button.textContent;
        button.disabled = true;
        button.textContent = label("Łączenie…", "Connecting…");
        try {
            const token = await csrf();
            const result = await readJson(
                `/api/v1/portals/${encodeURIComponent(portalId)}/connect`,
                {
                    method: "POST",
                    headers: {
                        Accept: "application/json",
                        "Content-Type": "application/json",
                        [token.headerName || "X-SIRK-CSRF"]: token.requestToken
                    },
                    body: "{}"
                });
            if (!result.url) throw new Error("Central did not return a tunnel URL.");
            window.location.replace(result.url);
        } catch (error) {
            connectionPending = false;
            const message = error?.payload?.approvalRequired
                ? label("Połączenie wymaga zatwierdzenia.", "The connection requires approval.")
                : error?.message || label("Nie udało się otworzyć tunelu.", "Unable to open the tunnel.");
            window.alert(message);
            button.disabled = false;
            button.textContent = previous;
        }
    }

    async function bindCard(card, identity) {
        if (!(card instanceof HTMLElement)) return;
        const portalId = portalIdFromCard(card);
        const original = card.querySelector("button");
        if (!portalId || !original) return;

        let button = original;
        if (button.dataset.sirkTunnelBound !== "true") {
            button = original.cloneNode(true);
            button.dataset.sirkTunnelBound = "true";
            original.replaceWith(button);
        }

        const online = card.querySelector(".status")?.classList.contains("online") === true;
        if (!online) {
            setButtonState(button, "deny");
            button.textContent = label("Offline", "Offline");
            return;
        }

        const effective = await effectiveAccess(identity, portalId);
        const capability = effective?.capabilities?.["portal.connect"] || "deny";
        const state = effective?.allowed === true && capability === "allow"
            ? "allow"
            : capability === "approval"
                ? "approval"
                : "deny";
        setButtonState(button, state);

        const teams = card.querySelector("small.muted");
        if (teams && Array.isArray(effective?.teams)) {
            teams.textContent = effective.teams.length
                ? effective.teams.join(", ")
                : label("Brak przypisanego zespołu", "No assigned team");
        }
    }

    async function refreshCards() {
        if (refreshPromise) return refreshPromise;
        refreshPromise = (async function () {
            const list = document.getElementById("portalList");
            if (!list) return;
            let identity;
            try {
                identity = await readSession();
            } catch (_) {
                return;
            }
            await Promise.allSettled(
                Array.from(list.querySelectorAll(".portal-card"))
                    .map(card => bindCard(card, identity)));
        }()).finally(() => { refreshPromise = null; });
        return refreshPromise;
    }

    document.addEventListener("click", async event => {
        const button = event.target instanceof Element
            ? event.target.closest(".portal-card button")
            : null;
        if (!(button instanceof HTMLButtonElement)) return;

        // Capture the click before the legacy app.js listener can run. Cards are
        // rebuilt every five seconds, so relying only on per-button rebinding
        // creates a small race window and can execute both connect contracts.
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        const card = button.closest(".portal-card");
        const portalId = card ? portalIdFromCard(card) : "";
        const online = card?.querySelector(".status")?.classList.contains("online") === true;
        if (!portalId || !online || connectionPending) return;

        try {
            const identity = await readSession();
            const effective = await effectiveAccess(identity, portalId);
            const capability = effective?.capabilities?.["portal.connect"] || "deny";
            if (effective?.allowed !== true || capability !== "allow") {
                setButtonState(button, capability === "approval" ? "approval" : "deny");
                return;
            }
            setButtonState(button, "allow");
            await connect(portalId, button);
        } catch (error) {
            window.alert(error?.message || label("Nie udało się otworzyć tunelu.", "Unable to open the tunnel."));
        }
    }, true);

    function initialize() {
        const list = document.getElementById("portalList");
        if (!list) return;
        observer?.disconnect();
        observer = new MutationObserver(() => {
            window.setTimeout(refreshCards, 0);
        });
        observer.observe(list, { childList: true, subtree: true });
        refreshCards();

        new MutationObserver(refreshCards).observe(
            document.documentElement,
            { attributes: true, attributeFilter: ["lang"] });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initialize, { once: true });
    } else {
        initialize();
    }
}());
