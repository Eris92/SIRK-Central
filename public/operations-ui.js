"use strict";

(function () {
    function lang() { return document.documentElement.lang === "en" ? "en" : "pl"; }
    function text(pl, en) { return lang() === "en" ? en : pl; }

    async function api(path, options) {
        const response = await fetch(path, Object.assign({
            credentials: "same-origin",
            cache: "no-store",
            headers: { "Content-Type": "application/json" }
        }, options || {}));
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || text("Błąd żądania.", "Request failed."));
        return body;
    }

    function showOperationPanel(name) {
        const updatePanel = document.getElementById("settingsTabUpdates");
        const backupPanel = document.getElementById("settingsTabBackup");
        if (updatePanel) updatePanel.hidden = name !== "updates";
        if (backupPanel) backupPanel.hidden = name !== "backup";
        for (const id of ["settingsTabUsers", "settingsTabAddUser", "settingsTabRoles", "settingsTabEntra"]) {
            const panel = document.getElementById(id);
            if (panel) panel.hidden = true;
        }
        for (const button of document.querySelectorAll("[data-settings-tab]")) {
            button.classList.toggle("active", button.dataset.settingsTab === name);
        }
    }

    function hideOperationPanels() {
        const updatePanel = document.getElementById("settingsTabUpdates");
        const backupPanel = document.getElementById("settingsTabBackup");
        if (updatePanel) updatePanel.hidden = true;
        if (backupPanel) backupPanel.hidden = true;
    }

    async function loadUpdateStatus() {
        const target = document.getElementById("updateStatus");
        try {
            const result = await api("/api/settings/update/status");
            const status = result.status || {};
            const parts = [text("Stan", "State") + ": " + (status.state || "idle")];
            if (status.startedAtUtc) parts.push(text("uruchomiono", "started") + ": " + new Date(status.startedAtUtc).toLocaleString(lang()));
            if (status.finishedAtUtc) parts.push(text("zakończono", "finished") + ": " + new Date(status.finishedAtUtc).toLocaleString(lang()));
            if (status.error) parts.push(status.error);
            target.textContent = parts.join(" · ");
            target.className = status.state === "failed" ? "error" : "muted";
        } catch (error) {
            target.textContent = error.message;
            target.className = "error";
        }
    }

    async function loadBackups() {
        const list = document.getElementById("backupList");
        try {
            const result = await api("/api/settings/backup/status");
            const backups = Array.isArray(result.backups) ? result.backups : [];
            if (!backups.length) {
                list.textContent = text("Brak kopii zapasowych.", "No backups available.");
                return;
            }
            list.replaceChildren(...backups.map(item => {
                const row = document.createElement("div");
                row.className = "user-row";
                const info = document.createElement("div");
                info.innerHTML = "<strong></strong><small></small>";
                info.querySelector("strong").textContent = item.name;
                info.querySelector("small").textContent = new Date(item.createdAtUtc).toLocaleString(lang()) + " · " + Math.ceil(Number(item.size || 0) / 1024) + " KiB";
                row.append(info);
                return row;
            }));
        } catch (error) {
            list.textContent = error.message;
        }
    }

    function applyLanguage() {
        const values = {
            updatesTab: ["Aktualizacje", "Updates"],
            backupTab: ["Backup", "Backup"],
            updatesTitle: ["Aktualizacja SIRK Central", "SIRK Central update"],
            updateHelp: ["Sprawdź stan usługi aktualizującej lub uruchom kontrolowaną aktualizację.", "Check the updater status or start a controlled update."],
            refreshUpdateButton: ["Odśwież status", "Refresh status"],
            runUpdateButton: ["Uruchom aktualizację", "Run update"],
            backupTitle: ["Kopie zapasowe", "Backups"],
            backupHelp: ["Backup obejmuje trwałe dane Central, użytkowników, role, konfigurację Entra oraz klucze MFA.", "The backup includes Central persistent data, users, roles, Entra configuration and MFA keys."],
            refreshBackupButton: ["Odśwież listę", "Refresh list"],
            runBackupButton: ["Utwórz backup teraz", "Create backup now"]
        };
        for (const [id, pair] of Object.entries(values)) {
            const element = document.getElementById(id);
            if (element) element.textContent = text(pair[0], pair[1]);
        }
    }

    async function initialize() {
        const updateTab = document.getElementById("updatesTab");
        const backupTab = document.getElementById("backupTab");
        if (!updateTab || !backupTab) return;

        let identity;
        try { identity = await api("/api/session"); }
        catch (_) { return; }
        const allowed = Boolean(identity.builtIn || identity.role === "Admin" || identity.role === "SecAdmin");
        updateTab.hidden = !allowed;
        backupTab.hidden = !allowed;
        if (!allowed) return;

        updateTab.addEventListener("click", () => { showOperationPanel("updates"); loadUpdateStatus(); });
        backupTab.addEventListener("click", () => { showOperationPanel("backup"); loadBackups(); });
        for (const button of document.querySelectorAll("[data-settings-tab]:not(#updatesTab):not(#backupTab)")) {
            button.addEventListener("click", hideOperationPanels);
        }

        document.getElementById("refreshUpdateButton").addEventListener("click", loadUpdateStatus);
        document.getElementById("runUpdateButton").addEventListener("click", async () => {
            const message = document.getElementById("updateMessage");
            if (!confirm(text("Uruchomić aktualizację SIRK Central?", "Run the SIRK Central update?"))) return;
            try {
                await api("/api/settings/update/run", { method: "POST", body: JSON.stringify({ confirm: "UPDATE SIRK CENTRAL" }) });
                message.textContent = text("Aktualizacja została uruchomiona.", "The update has started.");
                message.className = "success";
                await loadUpdateStatus();
            } catch (error) {
                message.textContent = error.message;
                message.className = "error";
            }
        });
        document.getElementById("refreshBackupButton").addEventListener("click", loadBackups);
        document.getElementById("runBackupButton").addEventListener("click", async () => {
            const message = document.getElementById("backupMessage");
            try {
                const result = await api("/api/settings/backup/run", { method: "POST", body: JSON.stringify({ confirm: "BACKUP SIRK CENTRAL" }) });
                message.textContent = text("Backup został utworzony: ", "Backup created: ") + (result.backup && result.backup.name || "");
                message.className = "success";
                await loadBackups();
            } catch (error) {
                message.textContent = error.message;
                message.className = "error";
            }
        });

        applyLanguage();
        new MutationObserver(applyLanguage).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
    else initialize();
}());
