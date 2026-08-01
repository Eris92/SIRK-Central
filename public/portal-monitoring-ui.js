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
        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) return text("brak heartbeat", "no heartbeat");
        const seconds = Math.max(0, Math.round((Date.now() - parsed.getTime()) / 1000));
        if (seconds < 60) return seconds + " s";
        if (seconds < 3600) return Math.round(seconds / 60) + " min";
        return Math.round(seconds / 3600) + " h";
    }
    function bytes(value) {
        const number = Number(value);
        if (!Number.isFinite(number) || number < 0) return "—";
        if (number < 1024) return number + " B";
        if (number < 1024 ** 2) return (number / 1024).toFixed(1) + " KiB";
        if (number < 1024 ** 3) return (number / 1024 ** 2).toFixed(1) + " MiB";
        return (number / 1024 ** 3).toFixed(1) + " GiB";
    }
    async function load() {
        clearTimeout(timer);
        try {
            const response = await fetch("/api/portal-telemetry", { credentials: "same-origin", cache: "no-store" });
            const body = await response.json().catch(() => ({}));
            if (response.ok) telemetry = new Map((Array.isArray(body.portals) ? body.portals : []).map(item => [String(item.id || "").toLowerCase(), item]));
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
        const key = document.createElement("span");
        key.className = "muted";
        key.textContent = label;
        const data = document.createElement("strong");
        data.textContent = String(value == null || value === "" ? "—" : value);
        if (className) data.className = className;
        row.append(key, data);
        return row;
    }
    function renderValues(item) {
        if (!item) {
            return [{ label: text("Monitoring", "Monitoring"), value: text("oczekuje na pierwszy heartbeat", "waiting for first heartbeat"), className: "overview-warn" }];
        }
        const stateClass = item.status === "online" ? "overview-ok" : item.status === "never" ? "overview-warn" : "overview-error";
        const metrics = item.metrics && typeof item.metrics === "object" ? item.metrics : {};
        const healthClass = metrics.health === "critical" ? "overview-error" : metrics.health === "warning" ? "overview-warn" : "overview-ok";
        const backupClass = metrics.lastBackupStatus === "failed" ? "overview-error" : metrics.lastBackupStatus === "ok" ? "overview-ok" : "";
        const memory = bytes(metrics.memoryUsedBytes) + " / " + bytes(metrics.memoryTotalBytes);
        return [
            { label: text("Stan", "Status"), value: item.status || "unknown", className: stateClass },
            { label: text("Wersja", "Version"), value: metrics.portalVersion || "—" },
            { label: text("Commit", "Commit"), value: metrics.buildCommit || "—" },
            { label: text("Ostatni kontakt", "Last contact"), value: age(item.lastSeenAtUtc) },
            { label: text("Agenci", "Agents"), value: String(metrics.onlineAgents ?? 0) + "/" + String(metrics.agentCount ?? 0) },
            { label: "CPU", value: Number.isFinite(Number(metrics.cpuPercent)) ? Number(metrics.cpuPercent).toFixed(1) + "%" : "—" },
            { label: "RAM", value: memory },
            { label: "Health", value: metrics.health || "unknown", className: healthClass },
            { label: "Backup", value: metrics.lastBackupStatus === "ok" && metrics.lastBackupAtUtc ? date(metrics.lastBackupAtUtc) : metrics.lastBackupStatus || "unknown", className: backupClass },
            { label: text("Aktualizacja", "Update"), value: metrics.availableVersion ? text("dostępna: ", "available: ") + metrics.availableVersion : text("brak oczekującej", "none pending"), className: metrics.availableVersion ? "overview-warn" : "" }
        ];
    }
    function enhance() {
        for (const card of document.querySelectorAll("#portalList .portal-card")) {
            const id = portalId(card);
            if (!id) continue;
            let panel = card.querySelector(".portal-telemetry-panel");
            if (!panel) {
                panel = document.createElement("div");
                panel.className = "portal-telemetry-panel";
                const button = card.querySelector("button,a.button");
                card.insertBefore(panel, button || null);
            }
            const values = renderValues(telemetry.get(id));
            const signature = JSON.stringify(values);
            if (panel.dataset.renderSignature === signature) continue;
            panel.dataset.renderSignature = signature;
            panel.replaceChildren(...values.map(item => metric(item.label, item.value, item.className)));
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
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
    else initialize();
}());
