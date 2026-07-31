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

    function ensureUi(settings) {
        if (document.getElementById("updatesTab")) return;
        const nav = settings.querySelector(":scope > nav.settings-tabs");
        const panels = settings.querySelector(":scope > .settings-panels");
        if (!nav || !panels) return;

        const updatesTab = document.createElement("button");
        updatesTab.type = "button";
        updatesTab.className = "settings-tab";
        updatesTab.id = "updatesTab";
        updatesTab.dataset.settingsTab = "updates";

        const backupTab = document.createElement("button");
        backupTab.type = "button";
        backupTab.className = "settings-tab";
        backupTab.id = "backupTab";
        backupTab.dataset.settingsTab = "backup";
        nav.append(updatesTab, backupTab);

        const updatesPanel = document.createElement("section");
        updatesPanel.id = "settingsTabUpdates";
        updatesPanel.className = "settings-tab-panel";
        updatesPanel.hidden = true;
        updatesPanel.innerHTML = `
          <article class="settings-card">
            <h2 id="updatesTitle"></h2>
            <p id="updateHelp" class="muted"></p>
            <p id="updateStatus" class="muted"></p>
            <div class="form-actions">
              <button type="button" class="secondary" id="refreshUpdateButton"></button>
              <button type="button" id="runUpdateButton"></button>
            </div>
            <p id="updateMessage" class="error" role="status"></p>
          </article>`;

        const backupPanel = document.createElement("section");
        backupPanel.id = "settingsTabBackup";
        backupPanel.className = "settings-tab-panel";
        backupPanel.hidden = true;
        backupPanel.innerHTML = `
          <article class="settings-card">
            <h2 id="backupTitle"></h2>
            <p id="backupHelp" class="muted"></p>
            <div class="form-actions">
              <button type="button" class="secondary" id="refreshBackupButton"></button>
              <button type="button" id="runBackupButton"></button>
            </div>
            <p id="restoreStatus" class="muted"></p>
            <div id="backupList" class="users-list"></div>
            <p id="backupMessage" class="error" role="status"></p>
          </article>`;
        panels.append(updatesPanel, backupPanel);
    }

    function panelId(name) {
        return {
            users: "settingsTabUsers",
            "add-user": "settingsTabAddUser",
            roles: "settingsTabRoles",
            entra: "settingsTabEntra",
            updates: "settingsTabUpdates",
            backup: "settingsTabBackup"
        }[name] || "";
    }

    function selectPanel(settings, name) {
        const nav = settings.querySelector(":scope > nav.settings-tabs");
        const panels = settings.querySelector(":scope > .settings-panels");
        if (!nav || !panels) return;
        for (const button of nav.querySelectorAll("[data-settings-tab]")) {
            button.classList.toggle("active", button.dataset.settingsTab === name);
            button.setAttribute("aria-selected", String(button.dataset.settingsTab === name));
        }
        const selectedId = panelId(name);
        for (const panel of panels.querySelectorAll(":scope > .settings-tab-panel")) panel.hidden = panel.id !== selectedId;
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

    function restoreStateText(state) {
        if (!state || !state.state || state.state === "idle") return "";
        const labels = {
            scheduled: ["Odtworzenie zaplanowane", "Restore scheduled"],
            stopping: ["Zatrzymywanie usług", "Stopping services"],
            restoring: ["Odtwarzanie danych", "Restoring data"],
            completed: ["Odtworzenie zakończone", "Restore completed"],
            failed: ["Odtworzenie nie powiodło się", "Restore failed"]
        };
        const label = labels[state.state] || [state.state, state.state];
        return text(label[0], label[1]) + (state.backup ? ": " + state.backup : "") + (state.error ? " · " + state.error : "");
    }

    async function restoreBackup(item) {
        const first = confirm(text(
            "Odtworzenie zastąpi bieżące dane Central i wyloguje użytkowników. Przed operacją zostanie automatycznie wykonany backup bezpieczeństwa. Kontynuować?",
            "Restore will replace current Central data and sign users out. A safety backup will be created automatically. Continue?"
        ));
        if (!first) return;
        const phrase = prompt(text(
            'Aby potwierdzić, wpisz dokładnie: RESTORE SIRK CENTRAL',
            'To confirm, type exactly: RESTORE SIRK CENTRAL'
        ), "");
        if (phrase !== "RESTORE SIRK CENTRAL") {
            throw new Error(text("Nieprawidłowa fraza potwierdzająca.", "Invalid confirmation phrase."));
        }
        return api("/api/settings/backup/restore", {
            method: "POST",
            body: JSON.stringify({ name: item.name, confirm: phrase })
        });
    }

    async function loadBackups() {
        const list = document.getElementById("backupList");
        const restoreStatus = document.getElementById("restoreStatus");
        try {
            const result = await api("/api/settings/backup/status");
            const backups = Array.isArray(result.backups) ? result.backups : [];
            restoreStatus.textContent = restoreStateText(result.restore);
            restoreStatus.className = result.restore && result.restore.state === "failed" ? "error" : "muted";
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
                const restore = document.createElement("button");
                restore.type = "button";
                restore.className = "danger";
                restore.textContent = text("Odtwórz", "Restore");
                restore.addEventListener("click", async () => {
                    const message = document.getElementById("backupMessage");
                    restore.disabled = true;
                    try {
                        const result = await restoreBackup(item);
                        if (!result) return;
                        message.textContent = text("Odtworzenie zostało zaplanowane. Backup bezpieczeństwa: ", "Restore scheduled. Safety backup: ") + (result.safetyBackup || "");
                        message.className = "success";
                        setTimeout(() => location.reload(), 12000);
                    } catch (error) {
                        message.textContent = error.message;
                        message.className = "error";
                        restore.disabled = false;
                    }
                });
                row.append(info, restore);
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
        const settings = document.getElementById("settingsView");
        if (!settings) return;
        let identity;
        try { identity = await api("/api/session"); }
        catch (_) { return; }
        if (!(identity.builtIn || identity.role === "Admin" || identity.role === "SecAdmin")) return;

        ensureUi(settings);
        const nav = settings.querySelector(":scope > nav.settings-tabs");
        nav.addEventListener("click", event => {
            const button = event.target.closest("[data-settings-tab]");
            if (!button || !nav.contains(button)) return;
            const name = button.dataset.settingsTab;
            queueMicrotask(() => selectPanel(settings, name));
            if (name === "updates") loadUpdateStatus();
            if (name === "backup") loadBackups();
        });
        document.getElementById("refreshUpdateButton").addEventListener("click", loadUpdateStatus);
        document.getElementById("refreshBackupButton").addEventListener("click", loadBackups);
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
