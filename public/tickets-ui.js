"use strict";

(function () {
    function t(pl, en) { return document.documentElement.lang === "en" ? en : pl; }
    function escapeHtml(value) { return String(value == null ? "" : value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
    function formatDate(value) { if (!value) return "—"; const d = new Date(value); return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString(); }
    async function api(url, options) { const response = await fetch(url, Object.assign({ credentials: "same-origin", cache: "no-store" }, options || {})); const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.error || ("HTTP " + response.status)); return body; }
    function ensureNav() {
        const nav = document.querySelector("nav, .top-nav, #mainNav"); if (!nav || document.getElementById("ticketsNavButton")) return;
        const button = document.createElement("button"); button.id = "ticketsNavButton"; button.type = "button"; button.className = "nav-button"; button.textContent = t("Zgłoszenia", "Tickets"); button.addEventListener("click", open); nav.append(button);
    }
    function ensureView() {
        let view = document.getElementById("ticketsWorkspace"); if (view) return view;
        view = document.createElement("section"); view.id = "ticketsWorkspace"; view.className = "page hidden";
        view.innerHTML = '<div class="page-header"><div><h1>' + t("Zgłoszenia", "Tickets") + '</h1><p class="muted">' + t("Zagregowane zgłoszenia opublikowane przez Portale.", "Aggregated tickets published by Portals.") + '</p></div><button id="ticketsRefresh" type="button">' + t("Odśwież", "Refresh") + '</button></div>' +
            '<div id="ticketSummary" class="ticket-summary"></div>' +
            '<div class="ticket-filters"><input id="ticketSearch" type="search" placeholder="' + t("Szukaj...", "Search...") + '"><select id="ticketStatus"><option value="">' + t("Wszystkie statusy", "All statuses") + '</option></select><select id="ticketPriority"><option value="">' + t("Wszystkie priorytety", "All priorities") + '</option></select><label><input id="ticketSla" type="checkbox"> ' + t("Tylko po SLA", "SLA breached only") + '</label></div>' +
            '<div id="ticketError" class="alert error hidden"></div><div id="ticketList" class="ticket-list"></div>';
        (document.querySelector("main") || document.body).append(view);
        view.querySelector("#ticketsRefresh").addEventListener("click", load);
        for (const id of ["ticketSearch", "ticketStatus", "ticketPriority", "ticketSla"]) view.querySelector("#" + id).addEventListener(id === "ticketSearch" ? "input" : "change", debounce(load, 250));
        return view;
    }
    function debounce(fn, wait) { let timer; return function () { clearTimeout(timer); timer = setTimeout(fn, wait); }; }
    function open() { for (const page of document.querySelectorAll("main > section.page, main > .page")) page.classList.add("hidden"); const view = ensureView(); view.classList.remove("hidden"); load(); }
    function option(value, label) { return '<option value="' + escapeHtml(value) + '">' + escapeHtml(label) + '</option>'; }
    function renderSummary(summary) {
        const target = document.getElementById("ticketSummary"); if (!target) return;
        const cards = [[t("Otwarte", "Open"), (summary.counts.new || 0) + (summary.counts.accepted || 0) + (summary.counts.in_progress || 0)], [t("Oczekujące", "Waiting"), (summary.counts.waiting_for_user || 0) + (summary.counts.waiting_for_external || 0)], [t("Krytyczne", "Critical"), summary.critical || 0], [t("Po SLA", "SLA breached"), summary.slaBreached || 0], [t("Błędy synchronizacji", "Sync errors"), summary.syncFailed || 0]];
        target.innerHTML = cards.map(item => '<article><strong>' + item[1] + '</strong><span>' + item[0] + '</span></article>').join("");
    }
    function badge(value, type) { return '<span class="ticket-badge ' + escapeHtml(type + "-" + value) + '">' + escapeHtml(value) + '</span>'; }
    function renderTickets(items) {
        const list = document.getElementById("ticketList"); if (!list) return;
        if (!items.length) { list.innerHTML = '<div class="empty">' + t("Brak zgłoszeń spełniających filtry.", "No tickets match the filters.") + '</div>'; return; }
        list.innerHTML = items.map(item => '<article class="ticket-card" data-portal="' + escapeHtml(item.portalId) + '" data-ticket="' + escapeHtml(item.ticketId) + '"><div class="ticket-card-head"><div><code>' + escapeHtml(item.ticketId) + '</code><h3>' + escapeHtml(item.title) + '</h3></div><div>' + badge(item.priority, "priority") + badge(item.status, "status") + (item.sla && item.sla.breached ? badge("SLA", "sla") : "") + '</div></div><div class="ticket-meta"><span>Portal: <strong>' + escapeHtml(item.portalId) + '</strong></span><span>' + t("System", "System") + ': <strong>' + escapeHtml(item.externalSystem || "local") + '</strong></span><span>' + t("Aktualizacja", "Updated") + ': <strong>' + escapeHtml(formatDate(item.updatedAtUtc)) + '</strong></span><span>Sync: <strong>' + escapeHtml(item.sync && item.sync.state || "local") + '</strong></span></div><p>' + escapeHtml(item.description || "") + '</p><div class="ticket-actions"><button type="button" data-action="details">' + t("Szczegóły", "Details") + '</button><button type="button" data-action="progress">' + t("Ustaw w toku", "Set in progress") + '</button><button type="button" data-action="resolve">' + t("Rozwiąż", "Resolve") + '</button></div></article>').join("");
        for (const button of list.querySelectorAll("button[data-action]")) button.addEventListener("click", () => act(button.closest(".ticket-card"), button.dataset.action));
    }
    async function act(card, action) {
        const portalId = card.dataset.portal, ticketId = card.dataset.ticket;
        try {
            if (action === "details") { const body = await api("/api/tickets/" + encodeURIComponent(portalId) + "/" + encodeURIComponent(ticketId)); alert(JSON.stringify(body.ticket, null, 2)); return; }
            const status = action === "resolve" ? "resolved" : "in_progress";
            await api("/api/tickets/" + encodeURIComponent(portalId) + "/" + encodeURIComponent(ticketId), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) });
            await load();
        } catch (error) { showError(error.message); }
    }
    function showError(message) { const box = document.getElementById("ticketError"); if (!box) return; box.textContent = message; box.classList.remove("hidden"); }
    async function load() {
        const view = ensureView(); const error = view.querySelector("#ticketError"); error.classList.add("hidden");
        const query = new URLSearchParams(); const search = view.querySelector("#ticketSearch").value.trim(); if (search) query.set("search", search); const status = view.querySelector("#ticketStatus").value; if (status) query.set("status", status); const priority = view.querySelector("#ticketPriority").value; if (priority) query.set("priority", priority); if (view.querySelector("#ticketSla").checked) query.set("slaBreached", "true");
        try {
            const body = await api("/api/tickets?" + query.toString());
            const statusSelect = view.querySelector("#ticketStatus"), prioritySelect = view.querySelector("#ticketPriority");
            if (statusSelect.options.length === 1) statusSelect.insertAdjacentHTML("beforeend", body.statuses.map(v => option(v, v)).join(""));
            if (prioritySelect.options.length === 1) prioritySelect.insertAdjacentHTML("beforeend", body.priorities.map(v => option(v, v)).join(""));
            renderSummary(body.summary); renderTickets(body.tickets);
        } catch (e) { showError(e.message); }
    }
    function style() { if (document.getElementById("ticketsCss")) return; const link = document.createElement("link"); link.id = "ticketsCss"; link.rel = "stylesheet"; link.href = "/tickets-ui.css"; document.head.append(link); }
    function init() { style(); ensureNav(); new MutationObserver(ensureNav).observe(document.body, { childList: true, subtree: true }); }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true }); else init();
}());
