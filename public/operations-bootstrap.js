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

    function select(settings, name) {
        const nav = settings.querySelector(":scope > nav.settings-tabs");
        const panels = settings.querySelector(":scope > .settings-panels");
        if (!nav || !panels) return;
        for (const button of nav.querySelectorAll("[data-settings-tab]")) {
            const active = button.dataset.settingsTab === name;
            button.classList.toggle("active", active);
            button.setAttribute("aria-selected", String(active));
        }
        const selected = panelId(name);
        for (const panel of panels.querySelectorAll(":scope > .settings-tab-panel")) panel.hidden = panel.id !== selected;
    }

    function keepOperationsTabsVisible(updatesTab, backupTab) {
        for (const tab of [updatesTab, backupTab]) {
            if (tab.hasAttribute("hidden")) tab.removeAttribute("hidden");
            if (tab.style.display === "none") tab.style.removeProperty("display");
            if (tab.getAttribute("aria-hidden") !== "false") tab.setAttribute("aria-hidden", "false");
        }
    }

    function mount() {
        const settings = document.getElementById("settingsView");
        if (!settings) return;
        const nav = settings.querySelector(":scope > nav.settings-tabs");
        const panels = settings.querySelector(":scope > .settings-panels");
        if (!nav || !panels) return;

        let updatesTab = document.getElementById("updatesTab");
        if (!updatesTab) {
            updatesTab = document.createElement("button");
            updatesTab.type = "button";
            updatesTab.id = "updatesTab";
            updatesTab.className = "settings-tab";
            updatesTab.dataset.settingsTab = "updates";
            nav.append(updatesTab);
        }

        let backupTab = document.getElementById("backupTab");
        if (!backupTab) {
            backupTab = document.createElement("button");
            backupTab.type = "button";
            backupTab.id = "backupTab";
            backupTab.className = "settings-tab";
            backupTab.dataset.settingsTab = "backup";
            nav.append(backupTab);
        }

        keepOperationsTabsVisible(updatesTab, backupTab);

        let updatesPanel = document.getElementById("settingsTabUpdates");
        if (!updatesPanel) {
            updatesPanel = document.createElement("section");
            updatesPanel.id = "settingsTabUpdates";
            updatesPanel.className = "settings-tab-panel";
            updatesPanel.hidden = true;
            updatesPanel.innerHTML = '<article class="settings-card"><h2 id="updatesTitle"></h2><p id="updateHelp" class="muted"></p><p id="updateStatus" class="muted"></p><div class="form-actions"><button type="button" class="secondary" id="refreshUpdateButton"></button><button type="button" id="runUpdateButton"></button></div><p id="updateMessage" class="error" role="status"></p></article>';
            panels.append(updatesPanel);
        }

        let backupPanel = document.getElementById("settingsTabBackup");
        if (!backupPanel) {
            backupPanel = document.createElement("section");
            backupPanel.id = "settingsTabBackup";
            backupPanel.className = "settings-tab-panel";
            backupPanel.hidden = true;
            backupPanel.innerHTML = '<article class="settings-card"><h2 id="backupTitle"></h2><p id="backupHelp" class="muted"></p><div class="form-actions"><button type="button" class="secondary" id="refreshBackupButton"></button><button type="button" id="runBackupButton"></button></div><p id="restoreStatus" class="muted"></p><div id="backupList" class="users-list"></div><p id="backupMessage" class="error" role="status"></p></article>';
            panels.append(backupPanel);
        }

        function labels() {
            keepOperationsTabsVisible(updatesTab, backupTab);
            updatesTab.textContent = text("Aktualizacje", "Updates");
            backupTab.textContent = "Backup";
            document.getElementById("updatesTitle").textContent = text("Aktualizacja SIRK Central", "SIRK Central update");
            document.getElementById("updateHelp").textContent = text("Sprawdź stan usługi aktualizującej lub uruchom kontrolowaną aktualizację.", "Check updater status or start a controlled update.");
            document.getElementById("refreshUpdateButton").textContent = text("Odśwież status", "Refresh status");
            document.getElementById("runUpdateButton").textContent = text("Uruchom aktualizację", "Run update");
            document.getElementById("backupTitle").textContent = text("Kopie zapasowe", "Backups");
            document.getElementById("backupHelp").textContent = text("Backup obejmuje trwałe dane Central, użytkowników, role, konfigurację Entra oraz klucze MFA.", "The backup includes Central persistent data, users, roles, Entra configuration and MFA keys.");
            document.getElementById("refreshBackupButton").textContent = text("Odśwież listę", "Refresh list");
            document.getElementById("runBackupButton").textContent = text("Utwórz backup teraz", "Create backup now");
        }

        updatesTab.addEventListener("click", function (event) {
            event.preventDefault(); event.stopImmediatePropagation();
            select(settings, "updates");
            document.getElementById("refreshUpdateButton").click();
        }, true);
        backupTab.addEventListener("click", function (event) {
            event.preventDefault(); event.stopImmediatePropagation();
            select(settings, "backup");
            document.getElementById("refreshBackupButton").click();
        }, true);

        labels();
        new MutationObserver(labels).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
        new MutationObserver(function () { keepOperationsTabsVisible(updatesTab, backupTab); }).observe(nav, {
            subtree: true,
            attributes: true,
            attributeFilter: ["hidden", "style", "aria-hidden"]
        });
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
    else mount();
}());
