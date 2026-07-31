"use strict";

(function () {
    let currentIdentity = null;

    function lang() { return document.documentElement.lang === "en" ? "en" : "pl"; }
    function text(pl, en) { return lang() === "en" ? en : pl; }

    async function api(path) {
        const response = await fetch(path, { credentials: "same-origin", cache: "no-store" });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || text("Błąd żądania.", "Request failed."));
        return body;
    }

    function ensureUi() {
        if (document.getElementById("auditView")) return;
        const dashboard = document.getElementById("dashboardView");
        const headerActions = dashboard && dashboard.querySelector(".header-actions");
        if (!dashboard || !headerActions) return;

        const button = document.createElement("button");
        button.id = "auditButton";
        button.type = "button";
        button.className = "secondary";
        button.textContent = text("Audyt", "Audit");
        const settings = document.getElementById("settingsButton");
        headerActions.insertBefore(button, settings || null);

        const view = document.createElement("section");
        view.id = "auditView";
        view.hidden = true;
        view.innerHTML = `
          <article class="settings-card">
            <div class="toolbar">
              <div>
                <h2 id="auditTitle"></h2>
                <p id="auditHelp" class="muted"></p>
              </div>
              <button id="auditRefresh" type="button" class="secondary"></button>
            </div>
            <div class="audit-filters form-actions">
              <input id="auditQuery" type="search" autocomplete="off">
              <select id="auditCategory">
                <option value=""></option>
                <option value="authentication">authentication</option>
                <option value="identity">identity</option>
                <option value="operations">operations</option>
                <option value="security">security</option>
                <option value="access">access</option>
                <option value="system">system</option>
              </select>
              <select id="auditResult">
                <option value=""></option>
                <option value="success">success</option>
                <option value="failure">failure</option>
                <option value="denied">denied</option>
                <option value="info">info</option>
              </select>
            </div>
            <p id="auditIntegrity" class="muted"></p>
            <div id="auditList" class="users-list"></div>
            <p id="auditMessage" class="error" role="status"></p>
          </article>`;
        dashboard.append(view);

        button.addEventListener("click", async () => {
            for (const id of ["portalsView", "settingsView", "accessView", "breakGlassView"]) {
                const element = document.getElementById(id);
                if (element) element.hidden = true;
            }
            view.hidden = false;
            const back = document.getElementById("backButton");
            if (back) back.hidden = false;
            const pageTitle = document.getElementById("pageTitle");
            if (pageTitle) pageTitle.textContent = text("Centrum audytu", "Audit Center");
            await loadAudit();
        });
        document.getElementById("auditRefresh").addEventListener("click", loadAudit);
        for (const id of ["auditCategory", "auditResult"]) document.getElementById(id).addEventListener("change", loadAudit);
        let timer = 0;
        document.getElementById("auditQuery").addEventListener("input", () => {
            clearTimeout(timer);
            timer = setTimeout(loadAudit, 350);
        });
        applyLanguage();
    }

    function resultLabel(value) {
        const labels = {
            success: ["Sukces", "Success"],
            failure: ["Błąd", "Failure"],
            denied: ["Odmowa", "Denied"],
            info: ["Informacja", "Information"]
        };
        const pair = labels[value] || [value, value];
        return text(pair[0], pair[1]);
    }

    function resultClass(value) {
        if (value === "success") return "success";
        if (value === "failure" || value === "denied") return "error";
        return "muted";
    }

    function renderEvents(events) {
        const list = document.getElementById("auditList");
        if (!events.length) {
            list.textContent = text("Brak zdarzeń spełniających kryteria.", "No events match the filters.");
            return;
        }
        list.replaceChildren(...events.map(event => {
            const row = document.createElement("div");
            row.className = "user-row";
            const info = document.createElement("div");
            const title = document.createElement("strong");
            title.textContent = event.action;
            const meta = document.createElement("small");
            const actor = event.actor && (event.actor.displayName || event.actor.username) || text("system", "system");
            meta.textContent = [new Date(event.timestampUtc).toLocaleString(lang()), actor, event.actor && event.actor.role, event.request && event.request.ip, event.category].filter(Boolean).join(" · ");
            const details = document.createElement("details");
            const summary = document.createElement("summary");
            summary.textContent = resultLabel(event.result) + (event.target ? " · " + event.target : "");
            summary.className = resultClass(event.result);
            const pre = document.createElement("pre");
            pre.textContent = JSON.stringify({ details: event.details, request: event.request, id: event.id, hash: event.hash }, null, 2);
            details.append(summary, pre);
            info.append(title, meta, details);
            row.append(info);
            return row;
        }));
    }

    async function loadAudit() {
        const message = document.getElementById("auditMessage");
        if (!message) return;
        try {
            message.textContent = "";
            const params = new URLSearchParams({ limit: "200" });
            const query = document.getElementById("auditQuery").value.trim();
            const category = document.getElementById("auditCategory").value;
            const result = document.getElementById("auditResult").value;
            if (query) params.set("query", query);
            if (category) params.set("category", category);
            if (result) params.set("result", result);
            const response = await api("/api/audit?" + params.toString());
            renderEvents(Array.isArray(response.events) ? response.events : []);
            const integrity = response.integrity || {};
            const target = document.getElementById("auditIntegrity");
            target.textContent = integrity.ok
                ? text("Integralność dziennika poprawna", "Audit integrity verified") + " · " + String(integrity.count || 0)
                : text("UWAGA: naruszona integralność dziennika", "WARNING: audit integrity failure");
            target.className = integrity.ok ? "success" : "error";
        } catch (error) {
            message.textContent = error.message;
            message.className = "error";
        }
    }

    function applyLanguage() {
        const values = {
            auditButton: ["Audyt", "Audit"],
            auditTitle: ["Centrum audytu", "Audit Center"],
            auditHelp: ["Trwały dziennik działań administracyjnych i zdarzeń bezpieczeństwa.", "Persistent log of administrative actions and security events."],
            auditRefresh: ["Odśwież", "Refresh"]
        };
        for (const [id, pair] of Object.entries(values)) {
            const element = document.getElementById(id);
            if (element) element.textContent = text(pair[0], pair[1]);
        }
        const query = document.getElementById("auditQuery");
        if (query) query.placeholder = text("Szukaj użytkownika, akcji lub celu", "Search actor, action or target");
        const category = document.getElementById("auditCategory");
        if (category && category.options[0]) category.options[0].textContent = text("Wszystkie kategorie", "All categories");
        const result = document.getElementById("auditResult");
        if (result && result.options[0]) result.options[0].textContent = text("Wszystkie wyniki", "All results");
    }

    async function initialize() {
        try {
            const session = await api("/api/session");
            currentIdentity = session;
            if (!(session.builtIn || ["Admin", "SecAdmin", "Auditor"].includes(session.role))) return;
            ensureUi();
            new MutationObserver(applyLanguage).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
        } catch (_) { /* not authenticated */ }
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
    else initialize();
}());
