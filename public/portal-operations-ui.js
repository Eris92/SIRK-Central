"use strict";

(function () {
    let identity = null;
    let refreshTimer = 0;

    function lang() { return document.documentElement.lang === "en" ? "en" : "pl"; }
    function text(pl, en) { return lang() === "en" ? en : pl; }
    async function api(path, options) {
        const response = await fetch(path, Object.assign({ credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" } }, options || {}));
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw Object.assign(new Error(body.error || text("Błąd żądania.", "Request failed.")), { code: body.code || "", status: response.status });
        return body;
    }
    function ensureUi() {
        if (document.getElementById("portalOperationsView")) return;
        const dashboard = document.getElementById("dashboardView");
        const headerActions = dashboard && dashboard.querySelector(".header-actions");
        if (!dashboard || !headerActions) return;
        const button = document.createElement("button");
        button.id = "portalOperationsButton";
        button.type = "button";
        button.className = "secondary";
        button.textContent = text("Operacje", "Operations");
        headerActions.insertBefore(button, document.getElementById("approvalCenterButton") || document.getElementById("auditButton") || null);

        const view = document.createElement("section");
        view.id = "portalOperationsView";
        view.hidden = true;
        view.innerHTML = `
          <article class="settings-card">
            <div class="toolbar"><div><h2 id="portalOperationsTitle"></h2><p id="portalOperationsHelp" class="muted"></p></div><button id="portalOperationsRefresh" type="button" class="secondary"></button></div>
            <div class="overview-grid" id="portalOperationsSummary"></div>
            <div class="form-actions">
              <select id="portalOperationsState"><option value=""></option><option>queued</option><option>delivered</option><option>running</option><option>completed</option><option>failed</option><option>cancelled</option><option>expired</option></select>
              <select id="portalOperationsType"><option value=""></option><option>backup</option><option>update</option><option>restart</option><option>reconnect</option><option>sync</option><option>diagnostics</option></select>
            </div>
            <div id="portalOperationsList" class="users-list"></div>
            <p id="portalOperationsMessage" class="error" role="status"></p>
          </article>
          <article class="settings-card">
            <h2 id="portalCommandTitle"></h2>
            <form id="portalCommandForm" class="stack-form">
              <label><span id="portalCommandPortalLabel"></span><input id="portalCommandPortal" pattern="[a-z0-9][a-z0-9-]{2,62}" required></label>
              <label><span id="portalCommandTypeLabel"></span><select id="portalCommandType"><option>backup</option><option>reconnect</option><option>sync</option><option>update</option><option>restart</option><option>diagnostics</option></select></label>
              <label><span id="portalCommandApprovalLabel"></span><input id="portalCommandApproval" placeholder="apr-..."></label>
              <label><span id="portalCommandTtlLabel"></span><input id="portalCommandTtl" type="number" min="5" max="1440" value="60"></label>
              <label><span id="portalCommandPayloadLabel"></span><textarea id="portalCommandPayload" rows="5" placeholder='{"key":"value"}'></textarea></label>
              <button id="portalCommandSubmit" type="submit"></button>
            </form>
          </article>`;
        dashboard.append(view);
        button.addEventListener("click", showView);
        document.getElementById("portalOperationsRefresh").addEventListener("click", loadOperations);
        document.getElementById("portalOperationsState").addEventListener("change", loadOperations);
        document.getElementById("portalOperationsType").addEventListener("change", loadOperations);
        document.getElementById("portalCommandForm").addEventListener("submit", submitCommand);
        applyLanguage();
    }
    async function showView() {
        for (const id of ["overviewView", "portalsView", "settingsView", "accessView", "breakGlassView", "auditView", "approvalCenterView"]) {
            const element = document.getElementById(id); if (element) element.hidden = true;
        }
        const view = document.getElementById("portalOperationsView"); if (!view) return;
        view.hidden = false;
        const title = document.getElementById("pageTitle"); if (title) title.textContent = text("Operacje Portali", "Portal Operations");
        const back = document.getElementById("backButton"); if (back) back.hidden = false;
        await loadOperations();
    }
    function renderSummary(summary) {
        const target = document.getElementById("portalOperationsSummary");
        if (!target) return;
        const items = [
            [text("Aktywne", "Active"), summary.active || 0, "overview-info"],
            [text("W kolejce", "Queued"), summary.counts && summary.counts.queued || 0, "overview-warn"],
            [text("Zakończone", "Completed"), summary.counts && summary.counts.completed || 0, "overview-ok"],
            [text("Błędy", "Failed"), summary.counts && summary.counts.failed || 0, "overview-error"]
        ];
        target.replaceChildren(...items.map(([label, value, cls]) => {
            const card = document.createElement("article"); card.className = "overview-card";
            const small = document.createElement("small"); small.textContent = label;
            const strong = document.createElement("strong"); strong.textContent = String(value); strong.className = cls;
            card.append(small, strong); return card;
        }));
    }
    function renderCommand(command) {
        const row = document.createElement("div"); row.className = "user-row";
        const info = document.createElement("div");
        const title = document.createElement("strong"); title.textContent = command.portalId + " · " + command.type;
        const meta = document.createElement("small"); meta.textContent = [command.state, new Date(command.createdAtUtc).toLocaleString(lang()), command.requestedBy, command.progress + "%"].filter(Boolean).join(" · ");
        const details = document.createElement("details");
        const summary = document.createElement("summary"); summary.textContent = text("Szczegóły", "Details") + (command.message ? " · " + command.message : "");
        const pre = document.createElement("pre"); pre.textContent = JSON.stringify(command, null, 2);
        details.append(summary, pre); info.append(title, meta, details); row.append(info);
        const actions = document.createElement("div"); actions.className = "form-actions";
        if (["queued", "delivered"].includes(command.state)) actions.append(actionButton(text("Anuluj", "Cancel"), "secondary", () => commandAction(command.id, "cancel")));
        if (["failed", "expired", "cancelled"].includes(command.state)) actions.append(actionButton(text("Ponów", "Retry"), "", () => commandAction(command.id, "retry")));
        if (actions.children.length) row.append(actions);
        return row;
    }
    function actionButton(label, className, handler) {
        const button = document.createElement("button"); button.type = "button"; button.className = className; button.textContent = label; button.addEventListener("click", handler); return button;
    }
    async function commandAction(id, action) {
        if (!confirm(text("Potwierdzić operację?", "Confirm operation?"))) return;
        const message = document.getElementById("portalOperationsMessage");
        try {
            await api("/api/portal-operations/" + encodeURIComponent(id) + "/" + action, { method: "POST", body: "{}" });
            message.textContent = text("Operacja została zapisana.", "Operation recorded."); message.className = "success";
            await loadOperations();
        } catch (error) { message.textContent = error.message; message.className = "error"; }
    }
    async function submitCommand(event) {
        event.preventDefault();
        const message = document.getElementById("portalOperationsMessage");
        try {
            let payload = {};
            const raw = document.getElementById("portalCommandPayload").value.trim();
            if (raw) payload = JSON.parse(raw);
            const body = {
                portalId: document.getElementById("portalCommandPortal").value.trim(),
                type: document.getElementById("portalCommandType").value,
                approvalId: document.getElementById("portalCommandApproval").value.trim(),
                ttlMinutes: Number(document.getElementById("portalCommandTtl").value),
                payload
            };
            await api("/api/portal-operations", { method: "POST", body: JSON.stringify(body) });
            message.textContent = text("Polecenie dodano do kolejki.", "Command queued."); message.className = "success";
            document.getElementById("portalCommandPayload").value = "";
            await loadOperations();
        } catch (error) {
            message.textContent = error.code === "APPROVAL_REQUIRED" ? text("Ta operacja wymaga zatwierdzonego wniosku operation.high-risk.", "This operation requires an approved operation.high-risk request.") : error.message;
            message.className = "error";
        }
    }
    async function loadOperations() {
        clearTimeout(refreshTimer);
        const message = document.getElementById("portalOperationsMessage");
        const params = new URLSearchParams({ limit: "300" });
        const state = document.getElementById("portalOperationsState").value;
        const type = document.getElementById("portalOperationsType").value;
        if (state) params.set("state", state); if (type) params.set("type", type);
        try {
            const result = await api("/api/portal-operations?" + params.toString());
            renderSummary(result.summary || { counts: {} });
            const list = document.getElementById("portalOperationsList");
            const commands = Array.isArray(result.commands) ? result.commands : [];
            list.replaceChildren(...commands.map(renderCommand));
            if (!commands.length) list.textContent = text("Brak operacji.", "No operations.");
            if (message.className !== "success") message.textContent = "";
        } catch (error) { message.textContent = error.message; message.className = "error"; }
        const view = document.getElementById("portalOperationsView"); if (view && !view.hidden) refreshTimer = setTimeout(loadOperations, 10000);
    }
    function applyLanguage() {
        const values = {
            portalOperationsButton: ["Operacje", "Operations"], portalOperationsTitle: ["Operacje Portali", "Portal Operations"],
            portalOperationsHelp: ["Kolejka poleceń, postęp i wyniki wykonania po stronie Portali.", "Command queue, progress and Portal execution results."],
            portalOperationsRefresh: ["Odśwież", "Refresh"], portalCommandTitle: ["Nowe polecenie", "New command"],
            portalCommandPortalLabel: ["Portal ID", "Portal ID"], portalCommandTypeLabel: ["Typ polecenia", "Command type"],
            portalCommandApprovalLabel: ["Approval ID dla operacji wysokiego ryzyka", "Approval ID for high-risk operation"],
            portalCommandTtlLabel: ["Ważność w minutach", "Validity in minutes"], portalCommandPayloadLabel: ["Payload JSON", "JSON payload"],
            portalCommandSubmit: ["Dodaj do kolejki", "Queue command"]
        };
        for (const [id, pair] of Object.entries(values)) { const element = document.getElementById(id); if (element) element.textContent = text(pair[0], pair[1]); }
        const state = document.getElementById("portalOperationsState"); if (state && state.options[0]) state.options[0].textContent = text("Wszystkie stany", "All states");
        const type = document.getElementById("portalOperationsType"); if (type && type.options[0]) type.options[0].textContent = text("Wszystkie typy", "All types");
    }
    async function initialize() {
        try {
            identity = await api("/api/session"); if (!identity || !identity.role) return;
            ensureUi();
            new MutationObserver(applyLanguage).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
            document.addEventListener("click", event => {
                const target = event.target.closest("#overviewButton,#backButton,#accessButton,#breakGlassButton,#settingsButton,#auditButton,#approvalCenterButton,#logoutButton");
                if (target) { const view = document.getElementById("portalOperationsView"); if (view) view.hidden = true; clearTimeout(refreshTimer); }
            }, true);
        } catch (_) { /* unauthenticated */ }
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true }); else initialize();
}());
