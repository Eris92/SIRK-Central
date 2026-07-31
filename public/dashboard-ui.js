"use strict";

(function () {
    let refreshTimer = 0;
    let initialized = false;

    function lang() { return document.documentElement.lang === "en" ? "en" : "pl"; }
    function text(pl, en) { return lang() === "en" ? en : pl; }
    function localDate(value) {
        if (!value) return text("brak", "none");
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? text("brak", "none") : date.toLocaleString(lang());
    }
    function shortCommit(value) { return String(value || "").slice(0, 8) || "—"; }

    async function api(path) {
        const response = await fetch(path, { credentials: "same-origin", cache: "no-store" });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw Object.assign(new Error(body.error || text("Błąd żądania.", "Request failed.")), { status: response.status });
        return body;
    }

    function ensureStyle() {
        if (document.getElementById("dashboardOverviewStyle")) return;
        const style = document.createElement("style");
        style.id = "dashboardOverviewStyle";
        style.textContent = `
          #overviewView{display:grid;gap:18px}
          #overviewView[hidden]{display:none!important}
          .overview-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}
          .overview-card{min-height:132px;padding:20px;border:1px solid #29446f;border-radius:16px;background:#0d1a33;display:flex;flex-direction:column;gap:8px}
          .overview-card strong{font-size:32px;line-height:1.1}.overview-card small{color:#9eb3d5}.overview-card .status-line{font-weight:800}
          .overview-ok{color:#48e6ba}.overview-warn{color:#ffd166}.overview-error{color:#ff7a83}.overview-info{color:#91b4ff}
          .overview-sections{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(300px,.7fr);gap:18px}
          .overview-event{padding:14px 0;border-bottom:1px solid #29446f}.overview-event:last-child{border-bottom:0}
          .overview-event strong,.overview-event small{display:block}.overview-event small{margin-top:5px;color:#9eb3d5}
          .overview-actions{display:flex;flex-wrap:wrap;gap:10px}.overview-actions button{min-width:140px}
          @media(max-width:1050px){.overview-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.overview-sections{grid-template-columns:1fr}}
          @media(max-width:620px){.overview-grid{grid-template-columns:1fr}.overview-card{min-height:auto}}
        `;
        document.head.append(style);
    }

    function ensureUi() {
        if (document.getElementById("overviewView")) return;
        const dashboard = document.getElementById("dashboardView");
        const headerActions = dashboard && dashboard.querySelector(".header-actions");
        if (!dashboard || !headerActions) return;
        ensureStyle();

        const button = document.createElement("button");
        button.id = "overviewButton";
        button.type = "button";
        button.className = "secondary";
        button.textContent = text("Pulpit", "Dashboard");
        const portalsButton = document.getElementById("backButton");
        headerActions.insertBefore(button, portalsButton || headerActions.firstChild);

        const view = document.createElement("section");
        view.id = "overviewView";
        view.hidden = true;
        view.innerHTML = `
          <div class="overview-grid">
            <article class="overview-card"><small id="overviewPortalsLabel"></small><strong id="overviewPortalsValue">—</strong><span id="overviewPortalsState" class="status-line overview-info"></span></article>
            <article class="overview-card"><small id="overviewUpdateLabel"></small><strong id="overviewUpdateValue">—</strong><span id="overviewUpdateState" class="status-line overview-info"></span></article>
            <article class="overview-card"><small id="overviewBackupLabel"></small><strong id="overviewBackupValue">—</strong><span id="overviewBackupState" class="status-line overview-info"></span></article>
            <article class="overview-card"><small id="overviewSecurityLabel"></small><strong id="overviewSecurityValue">—</strong><span id="overviewSecurityState" class="status-line overview-info"></span></article>
          </div>
          <div class="overview-sections">
            <article class="settings-card"><div class="toolbar"><div><h2 id="overviewEventsTitle"></h2><p id="overviewEventsHelp" class="muted"></p></div><button id="overviewRefresh" class="secondary" type="button"></button></div><div id="overviewEvents"></div></article>
            <article class="settings-card"><h2 id="overviewActionsTitle"></h2><p id="overviewActionsHelp" class="muted"></p><div class="overview-actions"><button type="button" data-overview-target="portals"></button><button type="button" data-overview-target="audit"></button><button type="button" data-overview-target="updates"></button><button type="button" data-overview-target="backup"></button></div><p id="overviewUpdated" class="muted"></p></article>
          </div>`;
        dashboard.append(view);

        button.addEventListener("click", showOverview);
        document.getElementById("overviewRefresh").addEventListener("click", loadOverview);
        for (const action of view.querySelectorAll("[data-overview-target]")) {
            action.addEventListener("click", () => navigate(action.dataset.overviewTarget));
        }
        applyLanguage();
    }

    function hideOverview() {
        const view = document.getElementById("overviewView");
        if (view) view.hidden = true;
        clearTimeout(refreshTimer);
    }

    async function showOverview() {
        for (const id of ["portalsView", "settingsView", "accessView", "breakGlassView", "auditView"]) {
            const element = document.getElementById(id);
            if (element) element.hidden = true;
        }
        const view = document.getElementById("overviewView");
        if (!view) return;
        view.hidden = false;
        const back = document.getElementById("backButton");
        if (back) back.hidden = false;
        const title = document.getElementById("pageTitle");
        if (title) title.textContent = text("Pulpit operacyjny", "Operational dashboard");
        await loadOverview();
    }

    function navigate(target) {
        hideOverview();
        if (target === "portals") return document.getElementById("backButton")?.click();
        if (target === "audit") return document.getElementById("auditButton")?.click();
        if (target === "updates" || target === "backup") {
            document.getElementById("settingsButton")?.click();
            setTimeout(() => document.getElementById(target === "updates" ? "updatesTab" : "backupTab")?.click(), 120);
        }
    }

    function setCard(prefix, value, state, className) {
        const valueElement = document.getElementById(prefix + "Value");
        const stateElement = document.getElementById(prefix + "State");
        if (valueElement) valueElement.textContent = value;
        if (stateElement) {
            stateElement.textContent = state;
            stateElement.className = "status-line " + className;
        }
    }

    async function portalSummary() {
        try {
            const result = await api("/api/portals");
            const portals = Array.isArray(result.portals) ? result.portals : [];
            const online = portals.filter(item => item.status === "online").length;
            setCard("overviewPortals", String(portals.length), online + " " + text("online", "online"), online === portals.length ? "overview-ok" : online ? "overview-warn" : "overview-error");
        } catch (error) {
            setCard("overviewPortals", "—", error.status === 403 ? text("brak dostępu", "no access") : text("niedostępne", "unavailable"), "overview-error");
        }
    }

    async function updateSummary() {
        try {
            const result = await api("/api/settings/update/status");
            const status = result.status || {};
            const labels = {
                completed: ["OK", "ostatnia zakończona", "last completed", "overview-ok"],
                rollback_completed: ["Rollback", "wersja przywrócona", "version restored", "overview-warn"],
                failed: ["Błąd", "wymaga uwagi", "needs attention", "overview-error"],
                starting: ["Start", "uruchamianie", "starting", "overview-info"],
                running: ["W toku", "aktualizacja trwa", "update running", "overview-info"],
                rollback: ["Rollback", "przywracanie", "restoring", "overview-warn"]
            };
            const entry = labels[status.state] || ["Idle", "brak aktywnej operacji", "no active operation", "overview-info"];
            setCard("overviewUpdate", entry[0], text(entry[1], entry[2]), entry[3]);
        } catch (error) {
            setCard("overviewUpdate", "—", error.status === 403 ? text("brak dostępu", "no access") : text("niedostępne", "unavailable"), "overview-error");
        }
    }

    async function backupSummary() {
        try {
            const result = await api("/api/settings/backup/status");
            const backups = Array.isArray(result.backups) ? result.backups : [];
            const latest = backups[0];
            setCard("overviewBackup", String(backups.length), latest ? text("ostatnia: ", "latest: ") + localDate(latest.createdAtUtc) : text("brak kopii", "no backups"), latest ? "overview-ok" : "overview-warn");
        } catch (error) {
            setCard("overviewBackup", "—", error.status === 403 ? text("brak dostępu", "no access") : text("niedostępne", "unavailable"), "overview-error");
        }
    }

    async function securitySummary() {
        try {
            const result = await api("/readyz");
            const checks = result.checks || {};
            const failed = Object.entries(checks).filter(([, value]) => !value).map(([key]) => key);
            setCard("overviewSecurity", result.ok ? "OK" : "!", failed.length ? failed.join(", ") : text("wszystkie kontrole poprawne", "all checks passed"), result.ok ? "overview-ok" : "overview-error");
        } catch (_) {
            setCard("overviewSecurity", "!", text("kontrola niedostępna", "check unavailable"), "overview-error");
        }
    }

    async function auditSummary() {
        const container = document.getElementById("overviewEvents");
        if (!container) return;
        try {
            const result = await api("/api/audit?limit=6");
            const events = Array.isArray(result.events) ? result.events : [];
            if (!events.length) {
                container.textContent = text("Brak zarejestrowanych zdarzeń.", "No recorded events.");
                return;
            }
            container.replaceChildren(...events.map(event => {
                const row = document.createElement("div");
                row.className = "overview-event";
                const title = document.createElement("strong");
                title.textContent = event.action;
                const meta = document.createElement("small");
                const actor = event.actor && (event.actor.displayName || event.actor.username) || text("system", "system");
                meta.textContent = [localDate(event.timestampUtc), actor, event.result].filter(Boolean).join(" · ");
                row.append(title, meta);
                return row;
            }));
        } catch (error) {
            container.textContent = error.status === 403 ? text("Brak uprawnienia do odczytu audytu.", "No permission to read audit events.") : text("Nie można pobrać zdarzeń.", "Unable to load events.");
        }
    }

    async function loadOverview() {
        await Promise.allSettled([portalSummary(), updateSummary(), backupSummary(), securitySummary(), auditSummary()]);
        const updated = document.getElementById("overviewUpdated");
        if (updated) updated.textContent = text("Ostatnie odświeżenie: ", "Last refreshed: ") + new Date().toLocaleString(lang());
        clearTimeout(refreshTimer);
        const view = document.getElementById("overviewView");
        if (view && !view.hidden) refreshTimer = setTimeout(loadOverview, 15000);
    }

    function applyLanguage() {
        const values = {
            overviewButton: ["Pulpit", "Dashboard"],
            overviewPortalsLabel: ["Połączone Portale", "Connected Portals"],
            overviewUpdateLabel: ["Aktualizacje", "Updates"],
            overviewBackupLabel: ["Kopie zapasowe", "Backups"],
            overviewSecurityLabel: ["Stan bezpieczeństwa", "Security status"],
            overviewEventsTitle: ["Ostatnie zdarzenia", "Recent events"],
            overviewEventsHelp: ["Najnowsze operacje administracyjne i zdarzenia bezpieczeństwa.", "Latest administrative actions and security events."],
            overviewRefresh: ["Odśwież", "Refresh"],
            overviewActionsTitle: ["Szybkie akcje", "Quick actions"],
            overviewActionsHelp: ["Przejdź bezpośrednio do najczęściej używanych modułów.", "Go directly to frequently used modules."]
        };
        for (const [id, pair] of Object.entries(values)) {
            const element = document.getElementById(id);
            if (element) element.textContent = text(pair[0], pair[1]);
        }
        const actionLabels = {
            portals: ["Portale", "Portals"],
            audit: ["Audyt", "Audit"],
            updates: ["Aktualizacje", "Updates"],
            backup: ["Backup", "Backup"]
        };
        for (const button of document.querySelectorAll("[data-overview-target]")) {
            const pair = actionLabels[button.dataset.overviewTarget];
            if (pair) button.textContent = text(pair[0], pair[1]);
        }
    }

    async function initialize() {
        if (initialized) return;
        try {
            const session = await api("/api/session");
            if (!session || !session.role) return;
            initialized = true;
            ensureUi();
            new MutationObserver(() => { applyLanguage(); const view = document.getElementById("overviewView"); if (view && !view.hidden) loadOverview(); })
                .observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
            document.addEventListener("click", event => {
                const button = event.target.closest("#backButton,#accessButton,#breakGlassButton,#settingsButton,#auditButton,#logoutButton");
                if (button && button.id !== "overviewButton") hideOverview();
            }, true);
            setTimeout(() => document.getElementById("overviewButton")?.click(), 250);
        } catch (_) { /* not authenticated */ }
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
    else initialize();
}());
