"use strict";

(function () {
    let initialized = false;

    function lang() { return document.documentElement.lang === "en" ? "en" : "pl"; }
    function text(pl, en) { return lang() === "en" ? en : pl; }
    function csrfToken() {
        const match = document.cookie.match(/(?:^|;\s*)sirk_central_csrf=([^;]+)/);
        return match ? decodeURIComponent(match[1]) : "";
    }
    async function api(path, options) {
        const headers = { "Content-Type": "application/json" };
        const csrf = csrfToken();
        if (csrf) headers["X-SIRK-CSRF"] = csrf;
        const response = await fetch(path, Object.assign({ credentials: "same-origin", cache: "no-store", headers }, options || {}));
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || text("Błąd żądania.", "Request failed."));
        return body;
    }
    function formatDate(value) {
        const date = new Date(value || "");
        return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString(lang());
    }
    function browserName(userAgent) {
        const value = String(userAgent || "");
        if (/Edg\//.test(value)) return "Microsoft Edge";
        if (/Chrome\//.test(value)) return "Google Chrome";
        if (/Firefox\//.test(value)) return "Mozilla Firefox";
        if (/Safari\//.test(value) && !/Chrome\//.test(value)) return "Safari";
        return value.slice(0, 90) || text("nieznana", "unknown");
    }

    function ensureUi() {
        const settings = document.getElementById("settingsView");
        if (!settings || document.getElementById("activeSessionsCard")) return;
        const card = document.createElement("article");
        card.id = "activeSessionsCard";
        card.className = "settings-card";
        card.innerHTML = `
          <div class="toolbar">
            <div><h2 id="activeSessionsTitle"></h2><p id="activeSessionsHelp" class="muted"></p></div>
            <div class="form-actions"><button id="refreshSessionsButton" class="secondary" type="button"></button><button id="revokeOtherSessionsButton" class="danger" type="button"></button></div>
          </div>
          <div id="activeSessionsList" class="users-list"></div>
          <p id="activeSessionsMessage" class="muted" role="status"></p>`;
        settings.append(card);
        document.getElementById("refreshSessionsButton").addEventListener("click", loadSessions);
        document.getElementById("revokeOtherSessionsButton").addEventListener("click", revokeOthers);
        applyLanguage();
    }

    async function loadSessions() {
        const list = document.getElementById("activeSessionsList");
        const message = document.getElementById("activeSessionsMessage");
        if (!list || !message) return;
        try {
            message.textContent = text("Wczytywanie aktywnych sesji…", "Loading active sessions…");
            message.className = "muted";
            const result = await api("/api/security/sessions");
            const sessions = Array.isArray(result.sessions) ? result.sessions : [];
            if (!sessions.length) {
                list.textContent = text("Brak aktywnych sesji.", "No active sessions.");
                message.textContent = "";
                return;
            }
            list.replaceChildren(...sessions.map(session => {
                const row = document.createElement("div");
                row.className = "user-row";
                const info = document.createElement("div");
                const title = document.createElement("strong");
                title.textContent = (session.displayName || session.username || text("Nieznany użytkownik", "Unknown user")) + (session.current ? text(" · bieżąca sesja", " · current session") : "");
                const meta = document.createElement("small");
                meta.textContent = [session.role, session.source, session.ip, browserName(session.userAgent)].filter(Boolean).join(" · ");
                const dates = document.createElement("small");
                dates.textContent = text("Ostatnia aktywność: ", "Last activity: ") + formatDate(session.lastSeenAtUtc) + " · " + text("wygasa: ", "expires: ") + formatDate(session.absoluteExpiresAtUtc);
                info.append(title, meta, dates);
                row.append(info);
                if (!session.current) {
                    const button = document.createElement("button");
                    button.type = "button";
                    button.className = "danger";
                    button.textContent = text("Unieważnij", "Revoke");
                    button.addEventListener("click", () => revokeSession(session.id, button));
                    row.append(button);
                }
                return row;
            }));
            message.textContent = text("Aktywne sesje: ", "Active sessions: ") + sessions.length;
            message.className = "success";
        } catch (error) {
            list.replaceChildren();
            message.textContent = error.message;
            message.className = "error";
        }
    }

    async function revokeSession(id, button) {
        if (!confirm(text("Unieważnić wybraną sesję? Użytkownik zostanie wylogowany.", "Revoke this session? The user will be signed out."))) return;
        button.disabled = true;
        try {
            await api("/api/security/sessions/" + encodeURIComponent(id), { method: "DELETE", body: "{}" });
            await loadSessions();
        } catch (error) {
            const message = document.getElementById("activeSessionsMessage");
            message.textContent = error.message;
            message.className = "error";
            button.disabled = false;
        }
    }

    async function revokeOthers() {
        const button = document.getElementById("revokeOtherSessionsButton");
        const message = document.getElementById("activeSessionsMessage");
        if (!confirm(text("Wylogować wszystkie pozostałe sesje administratorów? Bieżąca sesja pozostanie aktywna.", "Sign out all other administrator sessions? The current session will remain active."))) return;
        button.disabled = true;
        try {
            const result = await api("/api/security/sessions/revoke-others", { method: "POST", body: "{}" });
            message.textContent = text("Unieważnione sesje: ", "Revoked sessions: ") + String(result.revokedCount || 0);
            message.className = "success";
            await loadSessions();
        } catch (error) {
            message.textContent = error.message;
            message.className = "error";
        } finally { button.disabled = false; }
    }

    function applyLanguage() {
        const values = {
            activeSessionsTitle: ["Aktywne sesje", "Active sessions"],
            activeSessionsHelp: ["Kontroluj zalogowane sesje administratorów i konta Break-Glass.", "Control signed-in administrator and Break-Glass sessions."],
            refreshSessionsButton: ["Odśwież", "Refresh"],
            revokeOtherSessionsButton: ["Wyloguj pozostałe", "Sign out others"]
        };
        for (const [id, pair] of Object.entries(values)) {
            const element = document.getElementById(id);
            if (element) element.textContent = text(pair[0], pair[1]);
        }
    }

    function initialize() {
        if (initialized) return;
        initialized = true;
        ensureUi();
        loadSessions();
        document.getElementById("settingsButton")?.addEventListener("click", () => setTimeout(loadSessions, 180));
        new MutationObserver(applyLanguage).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => setTimeout(initialize, 600), { once: true });
    else setTimeout(initialize, 600);
}());
