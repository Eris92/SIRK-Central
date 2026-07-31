"use strict";

(function () {
    let identity = null;
    let currentState = "pending";
    let refreshTimer = 0;

    function lang() { return document.documentElement.lang === "en" ? "en" : "pl"; }
    function text(pl, en) { return lang() === "en" ? en : pl; }
    async function api(path, options) {
        const response = await fetch(path, Object.assign({ credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" } }, options || {}));
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || text("Błąd żądania.", "Request failed."));
        return body;
    }
    function stateLabel(value) {
        const labels = {
            pending: ["Oczekujące", "Pending"], approved: ["Zatwierdzone", "Approved"], rejected: ["Odrzucone", "Rejected"],
            cancelled: ["Anulowane", "Cancelled"], expired: ["Wygasłe", "Expired"]
        };
        const pair = labels[value] || [value, value];
        return text(pair[0], pair[1]);
    }
    function typeLabel(value) {
        const labels = {
            "role.assignment": ["Nadanie roli", "Role assignment"],
            "tenant.activation": ["Aktywacja tenantu", "Tenant activation"],
            "portal.enrollment": ["Enrollment Portalu", "Portal enrollment"],
            "operation.high-risk": ["Operacja wysokiego ryzyka", "High-risk operation"],
            "credential.use": ["Użycie poświadczenia", "Credential use"]
        };
        const pair = labels[value] || [value, value];
        return text(pair[0], pair[1]);
    }
    function ensureUi() {
        if (document.getElementById("approvalCenterView")) return;
        const dashboard = document.getElementById("dashboardView");
        const headerActions = dashboard && dashboard.querySelector(".header-actions");
        if (!dashboard || !headerActions) return;

        const button = document.createElement("button");
        button.id = "approvalCenterButton";
        button.type = "button";
        button.className = "secondary";
        button.textContent = text("Akceptacje", "Approvals");
        headerActions.insertBefore(button, document.getElementById("auditButton") || document.getElementById("settingsButton") || null);

        const view = document.createElement("section");
        view.id = "approvalCenterView";
        view.hidden = true;
        view.innerHTML = `
          <article class="settings-card">
            <div class="toolbar">
              <div><h2 id="approvalCenterTitle"></h2><p id="approvalCenterHelp" class="muted"></p></div>
              <button id="approvalRefresh" type="button" class="secondary"></button>
            </div>
            <nav class="settings-tabs" id="approvalStateTabs"></nav>
            <div id="approvalList" class="users-list"></div>
            <p id="approvalMessage" class="error" role="status"></p>
          </article>
          <article class="settings-card" id="approvalCreateCard">
            <h2 id="approvalCreateTitle"></h2>
            <form id="approvalCreateForm" class="stack-form">
              <label><span id="approvalTypeLabel"></span><select id="approvalType"><option value="role.assignment">role.assignment</option><option value="tenant.activation">tenant.activation</option><option value="portal.enrollment">portal.enrollment</option><option value="operation.high-risk">operation.high-risk</option><option value="credential.use">credential.use</option></select></label>
              <label><span id="approvalTitleLabel"></span><input id="approvalTitleInput" maxlength="160" required></label>
              <label><span id="approvalReasonLabel"></span><textarea id="approvalReasonInput" rows="3" maxlength="1000" required></textarea></label>
              <label><span id="approvalIdentityLabel"></span><input id="approvalIdentityInput" maxlength="128"></label>
              <label><span id="approvalRoleLabel"></span><select id="approvalRoleInput"><option value="">—</option><option>Auditor</option><option>OperatorL1</option><option>SupportL2</option><option>EngineerL3</option><option>Admin</option><option>SecAdmin</option></select></label>
              <label><span id="approvalCountLabel"></span><select id="approvalCountInput"><option value="1">1</option><option value="2">2</option></select></label>
              <label><span id="approvalTtlLabel"></span><input id="approvalTtlInput" type="number" min="5" max="1440" value="60"></label>
              <button id="approvalSubmitButton" type="submit"></button>
            </form>
          </article>`;
        dashboard.append(view);

        const states = ["pending", "approved", "rejected", "cancelled", "expired"];
        const tabs = document.getElementById("approvalStateTabs");
        for (const state of states) {
            const tab = document.createElement("button");
            tab.type = "button";
            tab.className = "settings-tab";
            tab.dataset.approvalState = state;
            tab.addEventListener("click", () => { currentState = state; loadApprovals(); });
            tabs.append(tab);
        }

        button.addEventListener("click", showView);
        document.getElementById("approvalRefresh").addEventListener("click", loadApprovals);
        document.getElementById("approvalCreateForm").addEventListener("submit", submitApproval);
        document.getElementById("approvalType").addEventListener("change", updateCreateForm);
        applyLanguage();
        updateCreateForm();
    }
    async function showView() {
        for (const id of ["overviewView", "portalsView", "settingsView", "accessView", "breakGlassView", "auditView"]) {
            const element = document.getElementById(id); if (element) element.hidden = true;
        }
        const view = document.getElementById("approvalCenterView");
        if (!view) return;
        view.hidden = false;
        const title = document.getElementById("pageTitle"); if (title) title.textContent = text("Centrum Akceptacji", "Approval Center");
        const back = document.getElementById("backButton"); if (back) back.hidden = false;
        await loadApprovals();
    }
    function updateCreateForm() {
        const role = document.getElementById("approvalRoleInput");
        const identityField = document.getElementById("approvalIdentityInput").closest("label");
        const roleField = role.closest("label");
        const roleRequest = document.getElementById("approvalType").value === "role.assignment";
        identityField.hidden = !roleRequest;
        roleField.hidden = !roleRequest;
        role.required = roleRequest;
        document.getElementById("approvalIdentityInput").required = roleRequest;
    }
    async function submitApproval(event) {
        event.preventDefault();
        const message = document.getElementById("approvalMessage");
        try {
            const type = document.getElementById("approvalType").value;
            const identityKey = document.getElementById("approvalIdentityInput").value.trim();
            const role = document.getElementById("approvalRoleInput").value;
            const payload = type === "role.assignment" ? { identityKey, role } : {};
            await api("/api/approval-center", {
                method: "POST",
                body: JSON.stringify({
                    type,
                    title: document.getElementById("approvalTitleInput").value.trim(),
                    reason: document.getElementById("approvalReasonInput").value.trim(),
                    scope: identityKey ? { identityKey } : {},
                    payload,
                    requiredApprovals: Number(document.getElementById("approvalCountInput").value),
                    ttlMinutes: Number(document.getElementById("approvalTtlInput").value)
                })
            });
            document.getElementById("approvalCreateForm").reset();
            document.getElementById("approvalTtlInput").value = "60";
            document.getElementById("approvalCountInput").value = "1";
            updateCreateForm();
            currentState = "pending";
            message.textContent = text("Wniosek został utworzony.", "Approval request created.");
            message.className = "success";
            await loadApprovals();
        } catch (error) {
            message.textContent = error.message;
            message.className = "error";
        }
    }
    function renderRequest(request) {
        const row = document.createElement("div");
        row.className = "user-row";
        const info = document.createElement("div");
        const title = document.createElement("strong");
        title.textContent = request.title;
        const meta = document.createElement("small");
        meta.textContent = [typeLabel(request.type), request.requestedBy, new Date(request.requestedAtUtc).toLocaleString(lang()), stateLabel(request.state)].join(" · ");
        const reason = document.createElement("p");
        reason.className = "muted";
        reason.textContent = request.reason;
        const details = document.createElement("details");
        const summary = document.createElement("summary");
        summary.textContent = text("Szczegóły", "Details") + " · " + String((request.decisions || []).length) + "/" + String(request.requiredApprovals);
        const pre = document.createElement("pre");
        pre.textContent = JSON.stringify({ scope: request.scope, payload: request.payload, decisions: request.decisions, execution: request.execution, expiresAtUtc: request.expiresAtUtc }, null, 2);
        details.append(summary, pre);
        info.append(title, meta, reason, details);
        row.append(info);

        if (request.state === "pending") {
            const actions = document.createElement("div");
            actions.className = "form-actions";
            for (const action of ["approve", "reject", "cancel"]) {
                const button = document.createElement("button");
                button.type = "button";
                button.className = action === "reject" ? "danger" : action === "cancel" ? "secondary" : "";
                button.textContent = action === "approve" ? text("Zatwierdź", "Approve") : action === "reject" ? text("Odrzuć", "Reject") : text("Anuluj", "Cancel");
                button.addEventListener("click", () => decide(request, action, button));
                actions.append(button);
            }
            row.append(actions);
        }
        return row;
    }
    async function decide(request, action, button) {
        const message = document.getElementById("approvalMessage");
        let comment = "";
        if (action !== "cancel") comment = prompt(text("Komentarz do decyzji (opcjonalnie)", "Decision comment (optional)"), "") || "";
        if (!confirm(text("Potwierdzić operację: ", "Confirm action: ") + action + "?")) return;
        button.disabled = true;
        try {
            await api("/api/approval-center/" + encodeURIComponent(request.id) + "/" + action, { method: "POST", body: JSON.stringify({ comment }) });
            message.textContent = text("Decyzja została zapisana.", "Decision recorded.");
            message.className = "success";
            await loadApprovals();
        } catch (error) {
            message.textContent = error.message;
            message.className = "error";
            button.disabled = false;
        }
    }
    async function loadApprovals() {
        clearTimeout(refreshTimer);
        const list = document.getElementById("approvalList");
        const message = document.getElementById("approvalMessage");
        if (!list) return;
        for (const tab of document.querySelectorAll("[data-approval-state]")) {
            tab.classList.toggle("active", tab.dataset.approvalState === currentState);
            tab.textContent = stateLabel(tab.dataset.approvalState);
        }
        try {
            const result = await api("/api/approval-center?state=" + encodeURIComponent(currentState));
            const requests = Array.isArray(result.requests) ? result.requests : [];
            list.replaceChildren(...requests.map(renderRequest));
            if (!requests.length) list.textContent = text("Brak wniosków w tej kategorii.", "No requests in this category.");
            if (message.className !== "success") message.textContent = "";
        } catch (error) {
            list.textContent = "";
            message.textContent = error.message;
            message.className = "error";
        }
        const view = document.getElementById("approvalCenterView");
        if (view && !view.hidden && currentState === "pending") refreshTimer = setTimeout(loadApprovals, 15000);
    }
    function applyLanguage() {
        const values = {
            approvalCenterButton: ["Akceptacje", "Approvals"], approvalCenterTitle: ["Centrum Akceptacji", "Approval Center"],
            approvalCenterHelp: ["Wnioski o role, enrollment i operacje wysokiego ryzyka.", "Requests for roles, enrollment and high-risk operations."],
            approvalRefresh: ["Odśwież", "Refresh"], approvalCreateTitle: ["Nowy wniosek", "New request"],
            approvalTypeLabel: ["Typ", "Type"], approvalTitleLabel: ["Tytuł", "Title"], approvalReasonLabel: ["Uzasadnienie", "Reason"],
            approvalIdentityLabel: ["Identity key Entra", "Entra identity key"], approvalRoleLabel: ["Żądana rola", "Requested role"],
            approvalCountLabel: ["Wymagane akceptacje", "Required approvals"], approvalTtlLabel: ["Ważność w minutach", "Validity in minutes"],
            approvalSubmitButton: ["Utwórz wniosek", "Create request"]
        };
        for (const [id, pair] of Object.entries(values)) { const element = document.getElementById(id); if (element) element.textContent = text(pair[0], pair[1]); }
        for (const tab of document.querySelectorAll("[data-approval-state]")) tab.textContent = stateLabel(tab.dataset.approvalState);
    }
    async function initialize() {
        try {
            identity = await api("/api/session");
            if (!identity || !identity.role) return;
            ensureUi();
            new MutationObserver(applyLanguage).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
            document.addEventListener("click", event => {
                const target = event.target.closest("#overviewButton,#backButton,#accessButton,#breakGlassButton,#settingsButton,#auditButton,#logoutButton");
                if (target) { const view = document.getElementById("approvalCenterView"); if (view) view.hidden = true; clearTimeout(refreshTimer); }
            }, true);
        } catch (_) { /* unauthenticated */ }
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
    else initialize();
}());
