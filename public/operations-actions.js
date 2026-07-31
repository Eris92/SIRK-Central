"use strict";

(function () {
    const HISTORY_KEY = "sirk-central-update-history-v1";
    let pollTimer = 0;
    let lastStatus = null;

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

    function shortCommit(value) {
        const commit = String(value || "").trim();
        return commit ? commit.slice(0, 8) : "";
    }

    function localDate(value) {
        if (!value) return "";
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(lang());
    }

    function stateLabel(state) {
        const labels = {
            idle: ["bezczynny", "idle"],
            starting: ["uruchamianie", "starting"],
            running: ["w toku", "running"],
            rollback: ["przywracanie poprzedniej wersji", "restoring previous version"],
            rollback_completed: ["przywrócono poprzednią wersję", "previous version restored"],
            completed: ["zakończona powodzeniem", "completed"],
            failed: ["awaria aktualizacji", "failed"]
        };
        const pair = labels[state] || [state || "idle", state || "idle"];
        return text(pair[0], pair[1]);
    }

    function stateClass(state) {
        if (state === "completed" || state === "rollback_completed") return "success";
        if (state === "failed") return "error";
        return "muted";
    }

    function cleanMessage(status) {
        if (status.state === "completed") return text("Aktualizacja została zakończona pomyślnie.", "The update completed successfully.");
        if (status.state === "rollback_completed") return text(
            "Aktualizacja nie powiodła się, ale poprzednia wersja została przywrócona. System działa prawidłowo.",
            "The update failed, but the previous version was restored. The system is healthy."
        );
        if (status.state === "failed") return text(
            "Aktualizacja nie powiodła się i nie potwierdzono poprawnego działania poprzedniej wersji.",
            "The update failed and the previous version could not be confirmed healthy."
        );
        return String(status.message || "").replace(/\s*Check the updater log:\s*\S+/i, "").trim();
    }

    function readHistory() {
        try {
            const value = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
            return Array.isArray(value) ? value : [];
        } catch (_) { return []; }
    }

    function storeTerminalStatus(status) {
        if (!["completed", "rollback_completed", "failed"].includes(status.state) || !status.startedAtUtc) return;
        const history = readHistory().filter(item => item.startedAtUtc !== status.startedAtUtc);
        history.unshift({
            state: status.state,
            startedAtUtc: status.startedAtUtc,
            finishedAtUtc: status.finishedAtUtc || "",
            previousCommit: status.previousCommit || "",
            targetCommit: status.targetCommit || status.commit || "",
            logFile: status.logFile || ""
        });
        localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 10)));
    }

    function ensureHistoryUi() {
        const panel = document.getElementById("settingsTabUpdates");
        if (!panel || document.getElementById("updateHistory")) return;
        const card = document.createElement("article");
        card.className = "settings-card";
        card.innerHTML = `<h2 id="updateHistoryTitle"></h2><div id="updateHistory" class="users-list"></div>`;
        panel.append(card);
    }

    function renderHistory() {
        ensureHistoryUi();
        const title = document.getElementById("updateHistoryTitle");
        const list = document.getElementById("updateHistory");
        if (!title || !list) return;
        title.textContent = text("Historia aktualizacji", "Update history");
        const history = readHistory();
        if (!history.length) {
            list.textContent = text("Brak zapisanych prób aktualizacji.", "No update attempts recorded.");
            return;
        }
        list.replaceChildren(...history.map(item => {
            const row = document.createElement("div");
            row.className = "user-row";
            const info = document.createElement("div");
            const strong = document.createElement("strong");
            strong.textContent = stateLabel(item.state);
            const small = document.createElement("small");
            const details = [localDate(item.finishedAtUtc || item.startedAtUtc)];
            if (shortCommit(item.previousCommit)) details.push(text("poprzedni", "previous") + ": " + shortCommit(item.previousCommit));
            if (shortCommit(item.targetCommit)) details.push(text("docelowy", "target") + ": " + shortCommit(item.targetCommit));
            small.textContent = details.filter(Boolean).join(" · ");
            info.append(strong, small);
            row.append(info);
            return row;
        }));
    }

    function renderStatus(status, reconnecting) {
        const target = document.getElementById("updateStatus");
        const message = document.getElementById("updateMessage");
        const runButton = document.getElementById("runUpdateButton");
        if (!target || !message) return;

        const details = [text("Stan", "State") + ": " + stateLabel(status.state)];
        if (status.startedAtUtc) details.push(text("uruchomiono", "started") + ": " + localDate(status.startedAtUtc));
        if (status.finishedAtUtc) details.push(text("zakończono", "finished") + ": " + localDate(status.finishedAtUtc));
        if (shortCommit(status.previousCommit)) details.push(text("poprzednia wersja", "previous version") + ": " + shortCommit(status.previousCommit));
        if (shortCommit(status.targetCommit)) details.push(text("wersja docelowa", "target version") + ": " + shortCommit(status.targetCommit));
        if (reconnecting) details.push(text("trwa ponowne łączenie", "reconnecting"));
        target.textContent = details.join(" · ");
        target.className = stateClass(status.state);

        const lines = [];
        const summary = cleanMessage(status);
        if (summary) lines.push(summary);
        if (status.logFile) lines.push(text("Log", "Log") + ": " + status.logFile);
        message.textContent = lines.join(" · ");
        message.className = stateClass(status.state);
        if (runButton) runButton.disabled = Boolean(status.running || ["starting", "running", "rollback"].includes(status.state));

        storeTerminalStatus(status);
        renderHistory();
    }

    async function refreshUpdateStatus() {
        clearTimeout(pollTimer);
        try {
            const result = await api("/api/settings/update/status");
            lastStatus = result.status || { state: "idle", running: false };
            renderStatus(lastStatus, false);
            if (lastStatus.running || ["starting", "running", "rollback"].includes(lastStatus.state)) {
                pollTimer = setTimeout(refreshUpdateStatus, 3000);
            }
        } catch (_) {
            if (lastStatus) renderStatus(lastStatus, true);
            else {
                const target = document.getElementById("updateStatus");
                if (target) {
                    target.textContent = text("Trwa ponowne łączenie z usługą aktualizacji…", "Reconnecting to the update service…");
                    target.className = "muted";
                }
            }
            pollTimer = setTimeout(refreshUpdateStatus, 3000);
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
                if (phrase !== "DELETE SIRK BACKUP") return;
                remove.disabled = true;
                try {
                    await api("/api/settings/backup/" + encodeURIComponent(name), { method: "DELETE", body: JSON.stringify({ confirm: phrase }) });
                    if (message) { message.textContent = text("Backup został usunięty: ", "Backup deleted: ") + name; message.className = "success"; }
                    document.getElementById("refreshBackupButton")?.click();
                } catch (error) {
                    if (message) { message.textContent = error.message; message.className = "error"; }
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
        document.getElementById("refreshUpdateButton")?.addEventListener("click", refreshUpdateStatus);
        document.getElementById("runUpdateButton")?.addEventListener("click", () => setTimeout(refreshUpdateStatus, 500));
        document.getElementById("updatesTab")?.addEventListener("click", () => setTimeout(refreshUpdateStatus, 100));
        new MutationObserver(() => { renderHistory(); if (lastStatus) renderStatus(lastStatus, false); })
            .observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
        ensureHistoryUi();
        renderHistory();
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
    else initialize();
}());
