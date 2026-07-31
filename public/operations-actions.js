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

    async function refreshUpdateDiagnostics() {
        const statusTarget = document.getElementById("updateStatus");
        const messageTarget = document.getElementById("updateMessage");
        if (!statusTarget || !messageTarget) return;
        try {
            const result = await api("/api/settings/update/status");
            const status = result.status || {};
            const details = [];
            if (status.message) details.push(status.message);
            if (status.error) details.push(status.error);
            if (status.exitCode !== undefined && status.exitCode !== null) details.push(text("Kod zakończenia", "Exit code") + ": " + status.exitCode);
            if (status.logFile) details.push(text("Log", "Log") + ": " + status.logFile);
            if (details.length) {
                messageTarget.textContent = details.join(" · ");
                messageTarget.className = status.state === "failed" ? "error" : status.state === "completed" ? "success" : "muted";
            }
            if (status.running) setTimeout(refreshUpdateDiagnostics, 2500);
        } catch (error) {
            messageTarget.textContent = error.message;
            messageTarget.className = "error";
        }
    }

    function backupName(row) {
        const strong = row.querySelector("strong");
        const name = strong ? strong.textContent.trim() : "";
        return /^sirk-central-\d{8}T\d{6}(?:Z|[+-]\d{4})\.tar\.gz$/.test(name) ? name : "";
    }

    function enhanceBackupRows() {
        const list = document.getElementById("backupList");
        if (!list) return;
        for (const row of Array.from(list.children)) {
            if (row.dataset.backupActionsReady === "true") continue;
            const name = backupName(row);
            if (!name) continue;
            const currentButtons = Array.from(row.querySelectorAll(":scope > button"));
            const actions = document.createElement("div");
            actions.className = "form-actions";
            for (const button of currentButtons) actions.append(button);

            const remove = document.createElement("button");
            remove.type = "button";
            remove.className = "danger";
            remove.textContent = text("Usuń", "Delete");
            remove.addEventListener("click", async () => {
                const message = document.getElementById("backupMessage");
                if (!confirm(text("Trwale usunąć backup " + name + "?", "Permanently delete backup " + name + "?"))) return;
                const phrase = prompt(text("Aby potwierdzić, wpisz dokładnie: DELETE SIRK BACKUP", "To confirm, type exactly: DELETE SIRK BACKUP"), "");
                if (phrase !== "DELETE SIRK BACKUP") {
                    if (message) {
                        message.textContent = text("Nieprawidłowa fraza potwierdzająca.", "Invalid confirmation phrase.");
                        message.className = "error";
                    }
                    return;
                }
                remove.disabled = true;
                try {
                    await api("/api/settings/backup/" + encodeURIComponent(name), {
                        method: "DELETE",
                        body: JSON.stringify({ confirm: phrase })
                    });
                    if (message) {
                        message.textContent = text("Backup został usunięty: ", "Backup deleted: ") + name;
                        message.className = "success";
                    }
                    const refresh = document.getElementById("refreshBackupButton");
                    if (refresh) refresh.click();
                } catch (error) {
                    if (message) {
                        message.textContent = error.message;
                        message.className = "error";
                    }
                    remove.disabled = false;
                }
            });
            actions.append(remove);
            row.append(actions);
            row.dataset.backupActionsReady = "true";
        }
    }

    function initialize() {
        const backupList = document.getElementById("backupList");
        if (backupList) {
            enhanceBackupRows();
            new MutationObserver(enhanceBackupRows).observe(backupList, { childList: true });
        }
        const refreshUpdate = document.getElementById("refreshUpdateButton");
        const runUpdate = document.getElementById("runUpdateButton");
        const updatesTab = document.getElementById("updatesTab");
        if (refreshUpdate) refreshUpdate.addEventListener("click", () => setTimeout(refreshUpdateDiagnostics, 100));
        if (runUpdate) runUpdate.addEventListener("click", () => setTimeout(refreshUpdateDiagnostics, 500));
        if (updatesTab) updatesTab.addEventListener("click", () => setTimeout(refreshUpdateDiagnostics, 100));
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
    else initialize();
}());
