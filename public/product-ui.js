"use strict";

(function () {
    const state = {
        security: null,
        tickets: [],
        ticketFilter: "",
        securityLoading: false,
        ticketsLoading: false
    };

    const $ = id => document.getElementById(id);
    const isPolish = () => document.documentElement.lang !== "en";
    const text = (pl, en) => isPolish() ? pl : en;
    const formatDate = value => value ? new Date(value).toLocaleString(isPolish() ? "pl-PL" : "en-GB") : "—";

    async function readJson(response) {
        const contentType = response.headers.get("content-type") || "";
        if (response.status === 204) return null;
        if (contentType.includes("application/json")) return response.json();
        return { error: await response.text() };
    }

    async function csrf() {
        const response = await fetch("/api/v1/auth/csrf", {
            credentials: "same-origin",
            cache: "no-store",
            headers: { Accept: "application/json" }
        });
        const body = await readJson(response);
        if (!response.ok || !body?.requestToken) {
            throw new Error(body?.error || body?.title || text("Nie można pobrać tokenu CSRF.", "CSRF token could not be issued."));
        }
        return body;
    }

    async function api(path, options = {}) {
        const method = String(options.method || "GET").toUpperCase();
        const headers = new Headers(options.headers || {});
        headers.set("Accept", "application/json");
        if (options.body !== undefined) headers.set("Content-Type", "application/json");
        if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
            const token = await csrf();
            headers.set(token.headerName || "X-SIRK-CSRF", token.requestToken);
        }
        const response = await fetch(path, {
            method,
            credentials: "same-origin",
            cache: "no-store",
            headers,
            body: options.body === undefined ? undefined : JSON.stringify(options.body)
        });
        const body = await readJson(response);
        if (!response.ok) {
            const error = new Error(body?.error || body?.title || body?.code || `HTTP ${response.status}`);
            error.status = response.status;
            error.data = body;
            throw error;
        }
        return body;
    }

    function card(title) {
        const article = document.createElement("article");
        article.className = "settings-card";
        const heading = document.createElement("h2");
        heading.textContent = title;
        article.append(heading);
        return article;
    }

    function statusCard(title, message, retry) {
        const article = card(title);
        const paragraph = document.createElement("p");
        paragraph.className = "error";
        paragraph.textContent = message;
        article.append(paragraph);
        if (retry) {
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = text("Spróbuj ponownie", "Retry");
            button.addEventListener("click", retry);
            article.append(button);
        }
        return article;
    }

    function loadingCard(title) {
        const article = card(title);
        const paragraph = document.createElement("p");
        paragraph.className = "muted";
        paragraph.textContent = text("Ładowanie danych…", "Loading data…");
        article.append(paragraph);
        return article;
    }

    function getSecurityPanel(name) {
        return document.querySelector(`[data-security-panel="${name}"]`);
    }

    function securityTitle(name) {
        const labels = {
            approvals: ["Oczekujące role", "Pending roles"],
            sessions: ["Aktywne sesje", "Active sessions"],
            entra: ["Microsoft Entra", "Microsoft Entra"],
            breakglass: ["Break-Glass", "Break-Glass"],
            securityPolicies: ["Polityki bezpieczeństwa", "Security policies"],
            audit: ["Audyt", "Audit"],
            incidents: ["Incydenty", "Incidents"]
        };
        const value = labels[name] || ["Bezpieczeństwo", "Security"];
        return text(value[0], value[1]);
    }

    function activeSecurityName() {
        return document.querySelector("[data-security-tab].active")?.dataset.securityTab || "approvals";
    }

    function renderSecurityFallback(name) {
        const panel = getSecurityPanel(name);
        if (!panel || !state.security) return;
        panel.replaceChildren();
        const data = state.security;

        if (name === "audit") {
            const article = card(securityTitle(name));
            const list = document.createElement("div");
            list.className = "audit-list";
            const events = Array.isArray(data.audit) ? data.audit : [];
            if (!events.length) {
                const empty = document.createElement("p");
                empty.className = "muted";
                empty.textContent = text("Brak zdarzeń audytowych.", "No audit events.");
                list.append(empty);
            }
            for (const event of events) {
                const row = document.createElement("div");
                row.className = "audit-row";
                const strong = document.createElement("strong");
                strong.textContent = event.event || event.action || "event";
                const span = document.createElement("span");
                span.textContent = `${formatDate(event.atUtc || event.createdAtUtc)} · ${event.actor || event.actorName || "system"}`;
                const code = document.createElement("code");
                code.textContent = JSON.stringify(event.details || event.metadata || {});
                row.append(strong, span, code);
                list.append(row);
            }
            article.append(list);
            panel.append(article);
            return;
        }

        if (name === "incidents") {
            renderIncidents(panel, data.incidents || []);
            return;
        }

        if (name === "sessions") {
            const article = card(securityTitle(name));
            const list = document.createElement("div");
            list.className = "users-list";
            const sessions = Array.isArray(data.sessions) ? data.sessions : [];
            if (!sessions.length) {
                const empty = document.createElement("p");
                empty.className = "muted";
                empty.textContent = text("Brak aktywnych sesji.", "No active sessions.");
                list.append(empty);
            }
            for (const session of sessions) {
                const row = document.createElement("div");
                row.className = "security-row";
                const info = document.createElement("div");
                const strong = document.createElement("strong");
                strong.textContent = session.displayName || session.username || session.userName || session.id;
                const small = document.createElement("small");
                small.textContent = `${session.role || "—"} · ${session.ip || "—"} · ${formatDate(session.lastSeenAtUtc)}`;
                info.append(strong, small);
                const revoke = document.createElement("button");
                revoke.type = "button";
                revoke.className = "danger";
                revoke.textContent = text("Unieważnij", "Revoke");
                revoke.addEventListener("click", async () => {
                    await api(`/api/security/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
                    await loadSecurity(true);
                });
                row.append(info, revoke);
                list.append(row);
            }
            article.append(list);
            panel.append(article);
            return;
        }

        const article = card(securityTitle(name));
        const pre = document.createElement("pre");
        pre.className = "secret-output";
        const map = {
            approvals: data.pendingRoles || [],
            entra: data.entra || data.identityProvider || {},
            breakglass: data.breakGlass || {},
            securityPolicies: data.policies || {}
        };
        pre.textContent = JSON.stringify(map[name] ?? {}, null, 2);
        article.append(pre);
        panel.append(article);
    }

    function renderIncidents(panel, incidents) {
        const article = card(securityTitle("incidents"));
        const form = document.createElement("form");
        form.className = "stack-form incident-form";
        form.innerHTML = `
            <label>${text("Tytuł", "Title")}<input name="title" required maxlength="160"></label>
            <label>${text("Priorytet", "Severity")}<select name="severity"><option value="low">Low</option><option value="medium" selected>Medium</option><option value="high">High</option><option value="critical">Critical</option></select></label>
            <label>${text("Opis", "Description")}<textarea name="description" rows="3"></textarea></label>
            <button type="submit">${text("Utwórz incydent", "Create incident")}</button>
            <p class="error" role="status"></p>`;
        form.addEventListener("submit", async event => {
            event.preventDefault();
            const error = form.querySelector(".error");
            error.textContent = "";
            try {
                await api("/api/security/incidents", {
                    method: "POST",
                    body: {
                        title: form.elements.title.value,
                        severity: form.elements.severity.value,
                        description: form.elements.description.value
                    }
                });
                form.reset();
                await loadSecurity(true);
            } catch (exception) {
                error.textContent = exception.message;
            }
        });
        article.append(form);

        const list = document.createElement("div");
        list.className = "users-list";
        if (!incidents.length) {
            const empty = document.createElement("p");
            empty.className = "muted";
            empty.textContent = text("Brak incydentów.", "No incidents.");
            list.append(empty);
        }
        for (const incident of incidents) {
            const row = document.createElement("div");
            row.className = `security-row incident-${incident.severity || "medium"}`;
            const info = document.createElement("div");
            const strong = document.createElement("strong");
            strong.textContent = incident.title || incident.id;
            const small = document.createElement("small");
            small.textContent = `${incident.severity || "medium"} · ${incident.status || "open"} · ${formatDate(incident.createdAtUtc)}`;
            info.append(strong, small);
            row.append(info);
            if ((incident.status || "open") !== "resolved") {
                const resolve = document.createElement("button");
                resolve.type = "button";
                resolve.textContent = text("Zamknij", "Resolve");
                resolve.addEventListener("click", async () => {
                    await api(`/api/security/incidents/${encodeURIComponent(incident.id)}`, {
                        method: "PATCH",
                        body: { status: "resolved" }
                    });
                    await loadSecurity(true);
                });
                row.append(resolve);
            }
            list.append(row);
        }
        article.append(list);
        panel.append(article);
    }

    async function loadSecurity(force) {
        if (state.securityLoading) return;
        const name = activeSecurityName();
        const panel = getSecurityPanel(name);
        if (!panel) return;
        if (!force && panel.children.length > 0 && state.security) return;
        state.securityLoading = true;
        panel.replaceChildren(loadingCard(securityTitle(name)));
        try {
            state.security = await api("/api/security/overview");
            renderSecurityFallback(activeSecurityName());
        } catch (error) {
            panel.replaceChildren(statusCard(securityTitle(name), `${error.message}${error.status ? ` (HTTP ${error.status})` : ""}`, () => loadSecurity(true)));
        } finally {
            state.securityLoading = false;
        }
    }

    function installSecurityRecovery() {
        document.addEventListener("click", event => {
            const tab = event.target.closest?.("[data-security-tab]");
            if (!tab) return;
            window.setTimeout(() => loadSecurity(true), 0);
        });
        const securityButton = $("securityButton");
        if (securityButton) securityButton.addEventListener("click", () => window.setTimeout(() => loadSecurity(true), 0));
        const view = $("securityView");
        if (view) {
            new MutationObserver(() => {
                if (!view.hidden) loadSecurity(true);
            }).observe(view, { attributes: true, attributeFilter: ["hidden"] });
        }
    }

    function installTicketsWorkspace() {
        const dashboard = $("dashboardView");
        const headerActions = document.querySelector(".header-actions");
        const settingsButton = $("settingsButton");
        if (!dashboard || !headerActions || !settingsButton || $("ticketsButton")) return;

        const button = document.createElement("button");
        button.id = "ticketsButton";
        button.type = "button";
        button.className = "secondary";
        button.textContent = text("Zgłoszenia", "Tickets");
        headerActions.insertBefore(button, settingsButton);

        const view = document.createElement("section");
        view.id = "ticketsView";
        view.hidden = true;
        view.innerHTML = `
            <nav class="settings-tabs tickets-tabs">
                <button type="button" class="settings-tab active" data-ticket-tab="list">${text("Lista zgłoszeń", "Ticket list")}</button>
                <button type="button" class="settings-tab" data-ticket-tab="create">${text("Nowe zgłoszenie", "New ticket")}</button>
            </nav>
            <div class="settings-panels">
                <section id="ticketsListPanel" class="settings-tab-panel"></section>
                <section id="ticketsCreatePanel" class="settings-tab-panel" hidden></section>
            </div>`;
        const breakGlass = $("breakGlassView");
        dashboard.insertBefore(view, breakGlass || null);

        button.addEventListener("click", event => {
            event.preventDefault();
            event.stopImmediatePropagation();
            showTicketsView();
            history.pushState({}, "", "/tickets");
        }, true);
        for (const tab of view.querySelectorAll("[data-ticket-tab]")) {
            tab.addEventListener("click", () => showTicketTab(tab.dataset.ticketTab));
        }
        window.addEventListener("popstate", () => {
            if (location.pathname === "/tickets") showTicketsView();
        });
        if (location.pathname === "/tickets") window.setTimeout(showTicketsView, 100);
    }

    function hideProductViews(except) {
        for (const id of ["portalsView", "settingsView", "accessView", "securityView", "breakGlassView", "ticketsView"]) {
            const element = $(id);
            if (element) element.hidden = id !== except;
        }
        const back = $("backButton");
        if (back) back.hidden = except === "portalsView";
    }

    function showTicketsView() {
        hideProductViews("ticketsView");
        const title = $("pageTitle");
        if (title) title.textContent = text("Zgłoszenia", "Tickets");
        showTicketTab("list");
        loadTickets(true);
    }

    function showTicketTab(name) {
        const selected = name === "create" ? "create" : "list";
        const listPanel = $("ticketsListPanel");
        const createPanel = $("ticketsCreatePanel");
        if (listPanel) listPanel.hidden = selected !== "list";
        if (createPanel) createPanel.hidden = selected !== "create";
        document.querySelectorAll("[data-ticket-tab]").forEach(button => button.classList.toggle("active", button.dataset.ticketTab === selected));
        if (selected === "create") renderTicketCreate();
        else renderTickets();
    }

    function normalizeTickets(value) {
        if (Array.isArray(value)) return value;
        if (Array.isArray(value?.tickets)) return value.tickets;
        if (Array.isArray(value?.items)) return value.items;
        return [];
    }

    async function loadTickets(force) {
        if (state.ticketsLoading) return;
        const panel = $("ticketsListPanel");
        if (!panel) return;
        if (!force && state.tickets.length) return renderTickets();
        state.ticketsLoading = true;
        panel.replaceChildren(loadingCard(text("Zgłoszenia", "Tickets")));
        try {
            state.tickets = normalizeTickets(await api("/api/v1/tickets"));
            renderTickets();
        } catch (error) {
            panel.replaceChildren(statusCard(text("Zgłoszenia", "Tickets"), `${error.message}${error.status ? ` (HTTP ${error.status})` : ""}`, () => loadTickets(true)));
        } finally {
            state.ticketsLoading = false;
        }
    }

    function renderTickets() {
        const panel = $("ticketsListPanel");
        if (!panel || panel.hidden) return;
        panel.replaceChildren();
        const article = card(text("Zarządzanie zgłoszeniami", "Ticket management"));
        const toolbar = document.createElement("div");
        toolbar.className = "form-actions";
        const search = document.createElement("input");
        search.type = "search";
        search.placeholder = text("Szukaj zgłoszeń", "Search tickets");
        search.value = state.ticketFilter;
        search.addEventListener("input", () => {
            state.ticketFilter = search.value;
            renderTickets();
        });
        const refresh = document.createElement("button");
        refresh.type = "button";
        refresh.className = "secondary";
        refresh.textContent = text("Odśwież", "Refresh");
        refresh.addEventListener("click", () => loadTickets(true));
        const create = document.createElement("button");
        create.type = "button";
        create.textContent = text("Nowe zgłoszenie", "New ticket");
        create.addEventListener("click", () => showTicketTab("create"));
        toolbar.append(search, refresh, create);
        article.append(toolbar);

        const list = document.createElement("div");
        list.className = "users-list";
        const query = state.ticketFilter.trim().toLowerCase();
        const tickets = state.tickets.filter(ticket => !query || JSON.stringify(ticket).toLowerCase().includes(query));
        if (!tickets.length) {
            const empty = document.createElement("p");
            empty.className = "muted";
            empty.textContent = text("Brak zgłoszeń spełniających kryteria.", "No matching tickets.");
            list.append(empty);
        }
        for (const ticket of tickets) list.append(renderTicketRow(ticket));
        article.append(list);
        panel.append(article);
    }

    function renderTicketRow(ticket) {
        const row = document.createElement("div");
        row.className = "security-row ticket-row";
        const info = document.createElement("div");
        const strong = document.createElement("strong");
        strong.textContent = ticket.title || ticket.subject || ticket.id;
        const small = document.createElement("small");
        small.textContent = `${ticket.status || "open"} · ${ticket.priority || ticket.severity || "normal"} · ${ticket.portalId || ticket.source || "Central"} · ${formatDate(ticket.updatedAtUtc || ticket.createdAtUtc)}`;
        const description = document.createElement("p");
        description.className = "muted";
        description.textContent = ticket.description || ticket.summary || "";
        info.append(strong, small, description);

        const actions = document.createElement("div");
        actions.className = "form-actions";
        const status = document.createElement("select");
        for (const value of ["open", "in-progress", "pending", "resolved", "closed"]) {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = value;
            option.selected = value === ticket.status;
            status.append(option);
        }
        const save = document.createElement("button");
        save.type = "button";
        save.textContent = text("Zapisz status", "Save status");
        save.addEventListener("click", async () => {
            await api(`/api/v1/tickets/${encodeURIComponent(ticket.id)}`, { method: "PATCH", body: { status: status.value } });
            await loadTickets(true);
        });
        actions.append(status, save);
        row.append(info, actions);
        return row;
    }

    function renderTicketCreate() {
        const panel = $("ticketsCreatePanel");
        if (!panel) return;
        panel.replaceChildren();
        const article = card(text("Nowe zgłoszenie", "New ticket"));
        const form = document.createElement("form");
        form.className = "stack-form";
        form.innerHTML = `
            <label>${text("Tytuł", "Title")}<input name="title" required maxlength="200"></label>
            <label>${text("Opis", "Description")}<textarea name="description" rows="6" required></textarea></label>
            <label>${text("Priorytet", "Priority")}<select name="priority"><option value="low">Low</option><option value="normal" selected>Normal</option><option value="high">High</option><option value="critical">Critical</option></select></label>
            <label>Portal ID<input name="portalId"></label>
            <div class="form-actions"><button type="submit">${text("Utwórz zgłoszenie", "Create ticket")}</button><button type="button" class="secondary" data-cancel>${text("Anuluj", "Cancel")}</button></div>
            <p class="error" role="status"></p>`;
        form.querySelector("[data-cancel]").addEventListener("click", () => showTicketTab("list"));
        form.addEventListener("submit", async event => {
            event.preventDefault();
            const error = form.querySelector(".error");
            error.textContent = "";
            try {
                await api("/api/v1/tickets", {
                    method: "POST",
                    body: {
                        title: form.elements.title.value,
                        description: form.elements.description.value,
                        priority: form.elements.priority.value,
                        portalId: form.elements.portalId.value
                    }
                });
                form.reset();
                await loadTickets(true);
                showTicketTab("list");
            } catch (exception) {
                error.textContent = exception.message;
            }
        });
        article.append(form);
        panel.append(article);
    }

    function updateLanguage() {
        const ticketsButton = $("ticketsButton");
        if (ticketsButton) ticketsButton.textContent = text("Zgłoszenia", "Tickets");
        if ($("ticketsView") && !$("ticketsView").hidden) {
            const title = $("pageTitle");
            if (title) title.textContent = text("Zgłoszenia", "Tickets");
            renderTickets();
        }
        if ($("securityView") && !$("securityView").hidden) renderSecurityFallback(activeSecurityName());
    }

    function initialize() {
        installSecurityRecovery();
        installTicketsWorkspace();
        document.querySelectorAll("[data-lang]").forEach(button => button.addEventListener("click", () => window.setTimeout(updateLanguage, 0)));
        new MutationObserver(updateLanguage).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
    else initialize();
}());
