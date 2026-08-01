"use strict";

(function () {
    function lang() { return document.documentElement.lang === "en" ? "en" : "pl"; }
    function text(pl, en) { return lang() === "en" ? en : pl; }
    function formatBytes(value) {
        const bytes = Number(value || 0);
        if (!Number.isFinite(bytes) || bytes < 0) return "—";
        const units = ["B", "KiB", "MiB", "GiB", "TiB"];
        let size = bytes;
        let index = 0;
        while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1; }
        return size.toFixed(index > 1 ? 1 : 0) + " " + units[index];
    }
    async function api(path) {
        const response = await fetch(path, { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || text("Błąd diagnostyki.", "Diagnostics failed."));
        return body;
    }
    function fact(label, value) {
        const row = document.createElement("div");
        const name = document.createElement("span");
        const content = document.createElement("strong");
        name.textContent = label;
        content.textContent = value || "—";
        row.append(name, content);
        return row;
    }
    function selectSystem(settings) {
        const nav = settings.querySelector(":scope > nav.settings-tabs");
        const panels = settings.querySelector(":scope > .settings-panels");
        for (const button of nav.querySelectorAll("[data-settings-tab]")) {
            const active = button.dataset.settingsTab === "system";
            button.classList.toggle("active", active);
            button.setAttribute("aria-selected", String(active));
        }
        for (const panel of panels.querySelectorAll(":scope > .settings-tab-panel")) panel.hidden = panel.id !== "settingsTabSystem";
    }
    function renderContainers(items) {
        const target = document.getElementById("applianceContainers");
        const containers = Array.isArray(items) ? items : [];
        if (!containers.length) {
            target.textContent = text("Brak danych o kontenerach.", "No container data.");
            return;
        }
        target.replaceChildren(...containers.map(item => {
            const row = document.createElement("div");
            row.className = "user-row";
            const info = document.createElement("div");
            const title = document.createElement("strong");
            const detail = document.createElement("small");
            title.textContent = item.service;
            detail.textContent = [item.state, item.health, item.image].filter(Boolean).join(" · ");
            info.append(title, detail);
            const badge = document.createElement("span");
            const healthy = item.state === "running" && (!item.health || item.health === "healthy");
            badge.className = healthy ? "status online" : "status offline";
            badge.textContent = healthy ? "OK" : text("Błąd", "Error");
            row.append(info, badge);
            return row;
        }));
    }
    async function loadStatus() {
        const message = document.getElementById("applianceSystemMessage");
        message.textContent = text("Wczytywanie diagnostyki...", "Loading diagnostics...");
        message.className = "muted";
        try {
            const result = await api("/api/settings/appliance/status");
            const dataStorage = result.storage && result.storage.data || {};
            const installStorage = result.storage && result.storage.install || {};
            document.getElementById("applianceFacts").replaceChildren(
                fact(text("Commit", "Commit"), result.commit ? result.commit.slice(0, 12) : "—"),
                fact(text("Wygenerowano", "Generated"), result.generatedAtUtc ? new Date(result.generatedAtUtc).toLocaleString(lang()) : "—"),
                fact(text("Dane", "Data"), formatBytes(dataStorage.usedBytes) + " / " + formatBytes(dataStorage.totalBytes)),
                fact(text("System plików", "Filesystem"), formatBytes(installStorage.usedBytes) + " / " + formatBytes(installStorage.totalBytes)),
                fact(text("Aktualizacja", "Update"), result.update && result.update.state || "idle"),
                fact(text("Odtwarzanie", "Restore"), result.restore && result.restore.state || "idle")
            );
            renderContainers(result.containers);
            message.textContent = text("Diagnostyka appliance jest aktualna.", "Appliance diagnostics are current.");
            message.className = "success";
        } catch (error) {
            message.textContent = error.message;
            message.className = "error";
        }
    }
    function applyLanguage() {
        const values = {
            systemTab: ["System", "System"],
            applianceSystemTitle: ["Stan appliance", "Appliance status"],
            applianceSystemHelp: ["Stan usług, wdrożenia i przestrzeni dyskowej bez ujawniania sekretów.", "Service, deployment and storage status without exposing secrets."],
            refreshApplianceSystem: ["Odśwież diagnostykę", "Refresh diagnostics"],
            applianceContainersTitle: ["Usługi", "Services"]
        };
        for (const [id, pair] of Object.entries(values)) {
            const element = document.getElementById(id);
            if (element) element.textContent = text(pair[0], pair[1]);
        }
    }
    async function initialize() {
        const settings = document.getElementById("settingsView");
        if (!settings) return;
        let identity;
        try { identity = await api("/api/session"); } catch (_) { return; }
        if (!(identity.builtIn || ["Admin", "SecAdmin", "Auditor"].includes(identity.role))) return;
        const nav = settings.querySelector(":scope > nav.settings-tabs");
        const panels = settings.querySelector(":scope > .settings-panels");
        if (!nav || !panels || document.getElementById("systemTab")) return;

        const tab = document.createElement("button");
        tab.type = "button";
        tab.id = "systemTab";
        tab.className = "settings-tab";
        tab.dataset.settingsTab = "system";
        nav.append(tab);

        const panel = document.createElement("section");
        panel.id = "settingsTabSystem";
        panel.className = "settings-tab-panel";
        panel.hidden = true;
        panel.innerHTML = `
          <article class="settings-card">
            <h2 id="applianceSystemTitle"></h2>
            <p id="applianceSystemHelp" class="muted"></p>
            <div id="applianceFacts" class="security-facts"></div>
            <div class="form-actions"><button type="button" class="secondary" id="refreshApplianceSystem"></button></div>
            <p id="applianceSystemMessage" class="muted" role="status"></p>
          </article>
          <article class="settings-card">
            <h2 id="applianceContainersTitle"></h2>
            <div id="applianceContainers" class="users-list"></div>
          </article>`;
        panels.append(panel);

        nav.addEventListener("click", event => {
            const button = event.target.closest("[data-settings-tab='system']");
            if (!button) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            selectSystem(settings);
            loadStatus();
        }, true);
        document.getElementById("refreshApplianceSystem").addEventListener("click", loadStatus);
        applyLanguage();
        new MutationObserver(applyLanguage).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
    else initialize();
}());
