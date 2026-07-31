"use strict";

(function () {
    const HISTORY_KEY = "sirk-central-update-history-v2";
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
            idle: ["Gotowy", "Ready"],
            starting: ["Uruchamianie aktualizacji", "Starting update"],
            running: ["Aktualizacja w toku", "Update in progress"],
            rollback: ["Przywracanie poprzedniej wersji", "Restoring previous version"],
            rollback_completed: ["Przywrócono poprzednią wersję", "Previous version restored"],
            completed: ["Aktualizacja zakończona", "Update completed"],
            failed: ["Awaria aktualizacji", "Update failure"]
        };
        const pair = labels[state] || [state || "Gotowy", state || "Ready"];
        return text(pair[0], pair[1]);
    }

    function stateIcon(state) {
        if (state === "completed") return "✓";
        if (state === "rollback_completed") return "↶";
        if (state === "failed") return "!";
        if (["starting", "running", "rollback"].includes(state)) return "●";
        return "○";
    }

    function stateClass(state) {
        if (state === "completed") return "success";
        if (state === "rollback_completed") return "warning";
        if (state === "failed") return "error";
        return "muted";
    }

    function cleanMessage(status) {
        if (status.state === "completed") return text(
            "Aktualizacja została zakończona pomyślnie. System działa na nowej wersji.",
            "The update completed successfully. The system is running the new version."
        );
        if (status.state === "rollback_completed") return text(
            "Aktualizacja nie powiodła się. Poprzednia wersja została automatycznie przywrócona i system działa prawidłowo.",
            "The update failed. The previous version was restored automatically and the system is healthy."
        );
        if (status.state === "failed") return text(
            "Aktualizacja nie powiodła się i nie potwierdzono poprawnego działania przywróconej wersji.",
            "The update failed and the restored version could not be confirmed healthy."
        );
        const messages = {
            "Preparing update.": ["Przygotowywanie aktualizacji.", "Preparing update."],
            "Running tests and validating configuration.": ["Uruchamianie testów i sprawdzanie konfiguracji.", "Running tests and validating configuration."],
            "Building updated application services.": ["Budowanie zaktualizowanych usług.", "Building updated application services."],
            "Deploying updated application services.": ["Wdrażanie zaktualizowanych usług.", "Deploying updated application services."],
            "Update failed. Restoring the previous version.": ["Aktualizacja nie powiodła się. Przywracanie poprzedniej wersji.", "Update failed. Restoring the previous version."]
        };
        const pair = messages[String(status.message || "")];
        return pair ? text(pair[0], pair[1]) : String(status.message || "").replace(/\s*Check the updater log:\s*\S+/i, "").trim();
    }

    function effectiveCommit(status) {
        if (status.state === "completed") return shortCommit(status.targetCommit || status.commit);
        if (status.state === "rollback_completed") return shortCommit(status.previousCommit || status.commit);
        return shortCommit(status.previousCommit || status.commit || status.targetCommit);
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

    function ensureStyles() {
        if (document.getElementById("updateCenterStyles")) return;
        const style = document.createElement("style");
        style.id = "updateCenterStyles";
        style.textContent = `
          .update-overview { display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:12px; margin:16px 0; }
          .update-metric { border:1px solid var(--border-color,#314b78); border-radius:12px; padding:14px 16px; background:rgba(7,20,43,.28); }
          .update-metric small { display:block; margin-bottom:6px; opacity:.76; }
          .update-metric strong { display:block; font-size:1.05rem; overflow-wrap:anywhere; }
          .update-state-line { display:flex; align-items:center; gap:10px; font-weight:700; font-size:1.05rem; }
          .update-state-dot { display:inline-grid; place-items:center; width:28px; height:28px; border-radius:999px; border:1px solid currentColor; }
          .update-log-path { margin-top:10px; padding:10px 12px; border:1px solid var(--border-color,#314b78); border-radius:9px; overflow-wrap:anywhere; font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:.86rem; }
          .update-history-row { align-items:center; gap:14px; }
          .update-history-marker { flex:0 0 32px; width:32px; height:32px; display:grid; place-items:center; border-radius:999px; border:1px solid currentColor; font-weight:800; }
          .update-history-row.success { color:#54e6b1; }
          .update-history-row.warning { color:#ffc857; }
          .update-history-row.error { color:#ff7d86; }
          .update-history-info { color:var(--text-color,#fff); flex:1; min-width:0; }
          .update-history-info small { display:block; margin-top:5px; opacity:.8; }
          .update-version-flow { margin-top:7px; font-family:ui-monospace,SFMono-Regular,Consolas,monospace; }
          .update-log-button { white-space:nowrap; }
        `;
        document.head.append(style);
    }

    function ensureUpdateOverview() {
        const card = document.querySelector("#settingsTabUpdates .settings-card");
        const actions = card && card.querySelector(".form-actions");
        if (!card || !actions) return;
        let overview = document.getElementById("updateOverview");
        if (!overview) {
            overview = document.createElement("div");
            overview.id = "updateOverview";
            overview.className = "update-overview";
            overview.innerHTML = `
              <div class="update-metric"><small id="currentVersionLabel"></small><strong id="currentVersionValue">—</strong></div>
              <div class="update-metric"><small id="lastUpdateLabel"></small><strong id="lastUpdateValue">—</strong></div>
              <div class="update-metric"><small id="systemStateLabel"></small><strong id="systemStateValue">—</strong></div>`;
            actions.before(overview);
        }
        let logArea = document.getElementById("updateLogArea");
        if (!logArea) {
            logArea = document.createElement("div");
            logArea.id = "updateLogArea";
            logArea.hidden = true;
            logArea.className = "update-log-path";
            const message = document.getElementById("updateMessage");
            if (message) message.after(logArea);
        }
    }

    function ensureHistoryUi() {
        const panel = document.getElementById("settingsTabUpdates");
        if (!panel || document.getElementById("updateHistory")) return;
        const card = document.createElement("article");
        card.className = "settings-card";
        card.innerHTML = `<h2 id="updateHistoryTitle"></h2><div id="updateHistory" class="users-list"></div>`;
        panel.append(card);
    }

    function createLogButton(logFile) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "secondary update-log-button";
        button.textContent = text("Pokaż log", "Show log");
        button.addEventListener("click", () => {
            const area = document.getElementById("updateLogArea");
            if (!area) return;
            area.textContent = logFile;
            area.hidden = !area.hidden;
            button.textContent = area.hidden ? text("Pokaż log", "Show log") : text("Ukryj log", "Hide log");
        });
        return button;
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
            row.className = "user-row update-history-row " + stateClass(item.state);
            const marker = document.createElement("span");
            marker.className = "update-history-marker";
            marker.textContent = stateIcon(item.state);
            const info = document.createElement("div");
            info.className = "update-history-info";
            const strong = document.createElement("strong");
            strong.textContent = stateLabel(item.state);
            const small = document.createElement("small");
            small.textContent = localDate(item.finishedAtUtc || item.startedAtUtc);
            info.append(strong, small);

            const previous = shortCommit(item.previousCommit);
            const target = shortCommit(item.targetCommit);
            const flow = document.createElement("div");
            flow.className = "update-version-flow";
            if (previous && target && previous === target) {
                flow.textContent = text("Brak nowej wersji kodu · ", "No new code version · ") + previous;
            } else if (previous && target) {
                flow.textContent = previous + "  →  " + target;
            } else {
                flow.textContent = target || previous || text("Wersja nieznana", "Unknown version");
            }
            info.append(flow);
            row.append(marker, info);
            if (item.logFile) row.append(createLogButton(item.logFile));
            return row;
        }));
    }

    function renderStatus(status, reconnecting) {
        ensureStyles();
        ensureUpdateOverview();
        const target = document.getElementById("updateStatus");
        const message = document.getElementById("updateMessage");
        const runButton = document.getElementById("runUpdateButton");
        if (!target || !message) return;

        const stateText = stateLabel(status.state);
        target.replaceChildren();
        const stateLine = document.createElement("span");
        stateLine.className = "update-state-line";
        const dot = document.createElement("span");
        dot.className = "update-state-dot";
        dot.textContent = stateIcon(status.state);
        stateLine.append(dot, document.createTextNode(stateText));
        target.append(stateLine);
        target.className = stateClass(status.state);

        const currentVersionLabel = document.getElementById("currentVersionLabel");
        const currentVersionValue = document.getElementById("currentVersionValue");
        const lastUpdateLabel = document.getElementById("lastUpdateLabel");
        const lastUpdateValue = document.getElementById("lastUpdateValue");
        const systemStateLabel = document.getElementById("systemStateLabel");
        const systemStateValue = document.getElementById("systemStateValue");
        if (currentVersionLabel) currentVersionLabel.textContent = text("Obecna wersja", "Current version");
        if (currentVersionValue) currentVersionValue.textContent = effectiveCommit(status) || "—";
        if (lastUpdateLabel) lastUpdateLabel.textContent = text("Ostatnia próba", "Last attempt");
        if (lastUpdateValue) lastUpdateValue.textContent = localDate(status.finishedAtUtc || status.startedAtUtc) || text("Brak", "None");
        if (systemStateLabel) systemStateLabel.textContent = text("Stan systemu", "System state");
        if (systemStateValue) systemStateValue.textContent = reconnecting
            ? text("Ponowne łączenie…", "Reconnecting…")
            : (["failed"].includes(status.state) ? text("Wymaga sprawdzenia", "Needs attention") : text("Działa prawidłowo", "Healthy"));

        message.replaceChildren();
        const summary = cleanMessage(status);
        if (summary) message.append(document.createTextNode(summary));
        if (reconnecting) message.append(document.createTextNode(" · " + text("Trwa ponowne łączenie z usługą aktualizacji…", "Reconnecting to the update service…")));
        if (status.logFile) {
            message.append(document.createTextNode(" "));
            message.append(createLogButton(status.logFile));
        }
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
                const backupMessage = document.getElementById("backupMessage");
                if (!confirm(text("Trwale usunąć backup " + name + "?", "Permanently delete backup " + name + "?"))) return;
                const phrase = prompt(text("Aby potwierdzić, wpisz dokładnie: DELETE SIRK BACKUP", "To confirm, type exactly: DELETE SIRK BACKUP"), "");
                if (phrase !== "DELETE SIRK BACKUP") return;
                remove.disabled = true;
                try {
                    await api("/api/settings/backup/" + encodeURIComponent(name), { method: "DELETE", body: JSON.stringify({ confirm: phrase }) });
                    if (backupMessage) { backupMessage.textContent = text("Backup został usunięty: ", "Backup deleted: ") + name; backupMessage.className = "success"; }
                    document.getElementById("refreshBackupButton")?.click();
                } catch (error) {
                    if (backupMessage) { backupMessage.textContent = error.message; backupMessage.className = "error"; }
                    remove.disabled = false;
                }
            });
            actions.append(remove);
            row.append(actions);
            row.dataset.backupActionsReady = "true";
        }
    }

    function initialize() {
        ensureStyles();
        ensureUpdateOverview();
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
