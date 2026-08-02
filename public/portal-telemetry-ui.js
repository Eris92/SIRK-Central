(function () {
    "use strict";

    if (window.__sirkPortalTelemetryUiLoaded) return;
    window.__sirkPortalTelemetryUiLoaded = true;

    var telemetry = new Map();
    var loading = false;
    var timer = 0;

    function language() {
        return document.documentElement.lang === "en" ? "en" : "pl";
    }
    function text(pl, en) { return language() === "en" ? en : pl; }
    function injectStyle() {
        if (document.getElementById("sirkPortalTelemetryStyle")) return;
        var style = document.createElement("style");
        style.id = "sirkPortalTelemetryStyle";
        style.textContent = ".portal-telemetry{display:grid;gap:5px;margin:8px 0;padding:9px 10px;border:1px solid #29446f;border-radius:8px;background:rgba(12,25,48,.42);font-size:12px}.portal-telemetry-row{display:flex;justify-content:space-between;gap:12px}.portal-telemetry-row span:first-child{color:#8da3c5}.portal-telemetry-value{font-weight:700;text-align:right}.portal-telemetry-value.ok{color:#56d69b}.portal-telemetry-value.warning{color:#f4c15d}.portal-telemetry-value.critical{color:#ff768c}";
        (document.head || document.documentElement).appendChild(style);
    }
    function updaterLabel(updater) {
        updater = updater || {};
        var labels = language() === "en"
            ? { "not-installed": "Not installed", stopped: "Stopped", ready: "Ready", busy: "Updating", failed: "Failed" }
            : { "not-installed": "Brak", stopped: "Zatrzymany", ready: "Gotowy", busy: "Aktualizacja", failed: "Błąd" };
        return labels[updater.status] || updater.status || "—";
    }
    function severity(value) {
        if (value === "failed" || value === "not-installed") return "critical";
        if (value === "stopped" || value === "busy") return "warning";
        return "ok";
    }
    function row(label, value, className) {
        var node = document.createElement("div");
        node.className = "portal-telemetry-row";
        var key = document.createElement("span");
        key.textContent = label;
        var data = document.createElement("span");
        data.className = "portal-telemetry-value" + (className ? " " + className : "");
        data.textContent = value || "—";
        node.append(key, data);
        return node;
    }
    function enhance() {
        injectStyle();
        var list = document.getElementById("portalList");
        if (!list) return;
        Array.prototype.forEach.call(list.querySelectorAll(".portal-card"), function (card) {
            var code = card.querySelector("code");
            var id = String(code && code.textContent || "").trim().toLowerCase();
            if (!id) return;
            var current = telemetry.get(id);
            var existing = card.querySelector(".portal-telemetry");
            if (!current) { if (existing) existing.remove(); return; }
            if (existing) existing.remove();
            var metrics = current.metrics || {};
            var updater = metrics.updater || {};
            var panel = document.createElement("div");
            panel.className = "portal-telemetry";
            panel.append(
                row(text("Portal", "Portal"), metrics.portalVersion || "—", metrics.health === "ok" ? "ok" : "warning"),
                row(text("Agenci online", "Agents online"), String(metrics.onlineAgents || 0) + " / " + String(metrics.agentCount || 0), metrics.onlineAgents === metrics.agentCount ? "ok" : "warning"),
                row(text("SIRK Updater", "SIRK Updater"), updaterLabel(updater), severity(updater.status)),
                row(text("Kanał / faza", "Channel / phase"), [updater.channel, updater.phase].filter(Boolean).join(" · ") || "—"),
                row(text("Ostatni heartbeat", "Last heartbeat"), current.lastSeenAtUtc ? new Date(current.lastSeenAtUtc).toLocaleString() : "—")
            );
            var button = card.querySelector("button");
            card.insertBefore(panel, button || null);
        });
    }
    async function refresh() {
        if (loading || document.getElementById("dashboardView") && document.getElementById("dashboardView").hidden) return;
        loading = true;
        try {
            var response = await fetch("/api/portal-telemetry", { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } });
            if (!response.ok) return;
            var payload = await response.json();
            telemetry = new Map((payload.portals || []).map(function (portal) { return [String(portal.id || "").toLowerCase(), portal]; }));
            enhance();
        } catch (_) {
        } finally {
            loading = false;
        }
    }
    function start() {
        var list = document.getElementById("portalList");
        if (list && !list.getAttribute("data-telemetry-observed")) {
            list.setAttribute("data-telemetry-observed", "1");
            new MutationObserver(enhance).observe(list, { childList: true, subtree: true });
        }
        refresh();
        if (!timer) timer = window.setInterval(refresh, 5000);
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
    else start();
    window.addEventListener("hashchange", refresh);
}());
