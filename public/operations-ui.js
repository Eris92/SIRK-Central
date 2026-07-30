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
        if (document.getElementById("operationsSettingsBlock")) return;
        const block = document.createElement("section");
        block.id = "operationsSettingsBlock";
        block.hidden = true;
        block.style.marginTop = "18px";
        block.innerHTML = `
          <nav class="settings-tabs" id="operationsTabs" aria-label="Operations settings">
            <button type="button" class="settings-tab active" id="updatesTab" data-settings-tab="updates"></button>
            <button type="button" class="settings-tab" id="backupTab" data-settings-tab="backup"></button>
          </nav>
          <div class="settings-panels">
            <section id="settingsTabUpdates" class="settings-tab-panel">
              <article class="settings-card">
                <h2 id="updatesTitle"></h2>
                <p id="updateHelp" class="muted"></p>
                <p id="updateStatus" class="muted"></p>
                <div class="form-actions">
                  <button type="button" class="secondary" id="refreshUpdateButton"></button>
                  <button type="button" id="runUpdateButton"></button>
                </div>
                <p id="updateMessage" class="error" role="status"></p>
              </article>
            </section>
            <section id="settingsTabBackup" class="settings-tab-panel" hidden>
              <article class="settings-card">
                <h2 id="backupTitle"></h2>
                <p id="backupHelp" class="muted"></p>
                <div class="form-actions">
                  <button type="button" class="secondary" id="refreshBackupButton"></button>
                  <button type="button" id="runBackupButton"></button>
                </div>
                <div id="backupList" class="users-list"></div>
                <p id="backupMessage" class="error" role="status"></p>
              </article>
            </section>
          </div>`;
        settings.append(block);
    }

    function selectPanel(name) {
        document.getElementById("settingsTabUpdates").hidden = name !== "updates";
        document.getElementById("settingsTabBackup").hidden = name !== "backup";
        document.getElementById("updatesTab").classList.toggle("active", name === "updates");
        document.getElementById("backupTab").classList.toggle("active", name === "backup");
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
        const settings = document.getElementById("settingsView");
        if (!settings) return;
        let identity;
        try { identity = await api("/api/session"); }
        catch (_) { return; }
        if (!(identity.builtIn || identity.role === "Admin" || identity.role === "SecAdmin")) return;

        ensureUi(settings);
        document.getElementById("operationsSettingsBlock").hidden = false;
        document.getElementById("updatesTab").addEventListener("click", () => { selectPanel("updates"); loadUpdateStatus(); });
        document.getElementById("backupTab").addEventListener("click", () => { selectPanel("backup"); loadBackups(); });
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
        loadUpdateStatus();
        new MutationObserver(applyLanguage).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
    else initialize();
}());
