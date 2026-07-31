"use strict";

(function () {
    let telemetry = new Map();
    let timer = 0;

    function lang() { return document.documentElement.lang === "en" ? "en" : "pl"; }
    function text(pl, en) { return lang() === "en" ? en : pl; }
    function date(value) {
        if (!value) return text("nigdy", "never");
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? text("nigdy", "never") : parsed.toLocaleString(lang());
    }
    function age(value) {
        if (!value) return text("brak heartbeat", "no heartbeat");
        const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
        if (seconds < 60) return seconds + " s";
        if (seconds < 3600) return Math.round(seconds / 60) + " min";
        return Math.round(seconds / 3600) + " h";
    }
    async function load() {
        clearTimeout(timer);
        try {
            const response = await fetch("/api/portal-telemetry", { credentials: "same-origin", cache: "no-store" });
            const body = await response.json().catch(() => ({}));
            if (response.ok) telemetry = new Map((Array.isArray(body.portals) ? body.portals : []).map(item => [item.id, item]));
            enhance();
        } catch (_) { /* preserve existing portal list */ }
        timer = setTimeout(load, 15000);
    }
    function portalId(card) {
        const code = card.querySelector("code");
        return code ? code.textContent.trim().toLowerCase() : "";
    }
    function metric(label, value, className) {
        const row = document.createElement("div");
        row.className = "portal-metric";
        const key = document.createElement("span"); key.className = "muted"; key.textContent = label;
        const data = document.createElement("strong"); data.textContent = value; if (className) data.className = className;
        row.append(key, data); return row;
    }
    function enhance() {
        for (const card of document.querySelectorAll("#portalList .portal-card")) {
            const id = portalId(card); if (!id) continue;
            let panel = card.querySelector(".portal-telemetry-panel");
            if (!panel) { panel = document.createElement("div"); panel.className = "portal-telemetry-panel"; const button = card.querySelector("button,a.button"); card.insertBefore(panel, button || null); }
            const item = telemetry.get(id);
            if (!item) {
                panel.replaceChildren(metric(text("Monitoring", "Monitoring"), text("oczekuje na pierwszy heartbeat", "waiting for first heartbeat"), "overview-warn"));
                continue;
            }
            const stateClass = item.status === "online" ? "overview-ok" : item.status === "never" ? "overview-warn" : "overview-error";
            const heartbeat = item.telemetry || item;
            const agents = heartbeat.agents || {};
            const resources = heartbeat.resources || {};
            const backup = heartbeat.backup || {};
            const update = heartbeat.update || {};
            const health = heartbeat.health || {};
            panel.replaceChildren(
                metric(text("Stan", "Status"), item.status || "unknown", stateClass),
                metric(text("Wersja", "Version"), heartbeat.version || "—"),
                metric(text("Ostatni kontakt", "Last contact"), age(item.lastSeenAtUtc || heartbeat.receivedAtUtc)),
                metric(text("Agenci", "Agents"), String(agents.active ?? 0) + "/" + String(agents.total ?? 0)),
                metric("CPU / RAM", String(resources.cpuPercent ?? "—") + "% / " + String(resources.memoryMb ?? "—") + " MB"),
                metric("Health", health.status || (health.ok === true ? "healthy" : health.ok === false ? "unhealthy" : "—"), health.ok === false ? "overview-error" : ""),
                metric("Backup", backup.status || (backup.lastSuccessAtUtc ? date(backup.lastSuccessAtUtc) : "—"), backup.status === "failed" ? "overview-error" : ""),
                metric(text("Aktualizacja", "Update"), update.availableVersion ? text("dostępna: ", "available: ") + update.availableVersion : text("brak oczekującej", "none pending"), update.availableVersion ? "overview-warn" : "")
            );
        }
    }
    function ensureStyle() {
        if (document.getElementById("portalMonitoringStyle")) return;
        const link = document.createElement("link");
        link.id = "portalMonitoringStyle";
        link.rel = "stylesheet";
        link.href = "/portal-monitoring-ui.css";
        document.head.append(link);
    }
    function initialize() {
        ensureStyle();
        const list = document.getElementById("portalList");
        if (list) new MutationObserver(enhance).observe(list, { childList: true, subtree: true });
        load();
        new MutationObserver(enhance).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true }); else initialize();
}());
