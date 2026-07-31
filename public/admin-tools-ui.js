"use strict";

(function () {
    let initialized = false;
    let alertTimer = 0;

    function lang() { return document.documentElement.lang === "en" ? "en" : "pl"; }
    function text(pl, en) { return lang() === "en" ? en : pl; }
    function csrfToken() {
        const match = document.cookie.match(/(?:^|;\s*)sirk_central_csrf=([^;]+)/);
        return match ? decodeURIComponent(match[1]) : "";
    }
    async function api(path, options) {
        const headers = { "Content-Type": "application/json" };
        const csrf = csrfToken();
        if (csrf) headers["X-SIRK-CSRF"] = csrf;
        const response = await fetch(path, Object.assign({ credentials: "same-origin", cache: "no-store", headers }, options || {}));
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw Object.assign(new Error(body.error || text("Błąd żądania.", "Request failed.")), { status: response.status });
        return body;
    }
    function formatDate(value) {
        const date = new Date(value || "");
        return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString(lang());
    }
    function formatSize(bytes) {
        const value = Number(bytes || 0);
        if (value < 1024) return value + " B";
        if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " KiB";
        return (value / 1024 / 1024).toFixed(1) + " MiB";
    }

    function ensureBackupPolicyUi() {
        const panel = document.getElementById("settingsTabBackup");
        if (!panel || document.getElementById("backupPolicyCard")) return;
        const card = document.createElement("article");
        card.id = "backupPolicyCard";
        card.className = "settings-card";
        card.innerHTML = `
          <h2 id="backupPolicyTitle"></h2>
          <p id="backupPolicyHelp" class="muted"></p>
          <form id="backupPolicyForm" class="stack-form">
            <label class="checkbox-row"><input id="backupPolicyEnabled" type="checkbox"><span id="backupPolicyEnabledLabel"></span></label>
            <div class="admin-tools-inline">
              <label><span id="backupHourLabel"></span><input id="backupHour" type="number" min="0" max="23" required></label>
              <label><span id="backupMinuteLabel"></span><input id="backupMinute" type="number" min="0" max="59" required></label>
              <label><span id="backupRetentionLabel"></span><input id="backupRetention" type="number" min="1" max="365" required></label>
            </div>
            <div class="admin-tools-actions">
              <button type="submit" id="saveBackupPolicy"></button>
              <button type="button" class="secondary" id="refreshBackupPolicy"></button>
            </div>
            <p id="backupPolicyStatus" class="admin-tools-status muted"></p>
          </form>`;
        panel.prepend(card);
        document.getElementById("backupPolicyForm").addEventListener("submit", saveBackupPolicy);
        document.getElementById("refreshBackupPolicy").addEventListener("click", loadBackupPolicy);
    }

    async function loadBackupPolicy() {
        const status = document.getElementById("backupPolicyStatus");
        if (!status) return;
        try {
            status.textContent = text("Wczytywanie…", "Loading…");
            const result = await api("/api/settings/backup/policy");
            const policy = result.policy || {};
            document.getElementById("backupPolicyEnabled").checked = Boolean(policy.enabled);
            document.getElementById("backupHour").value = String(policy.hour ?? 2);
            document.getElementById("backupMinute").value = String(policy.minute ?? 0);
            document.getElementById("backupRetention").value = String(policy.retention ?? 10);
            status.textContent = [
                policy.enabled ? text("Harmonogram aktywny", "Schedule enabled") : text("Harmonogram wyłączony", "Schedule disabled"),
                text("strefa", "timezone") + ": Europe/Warsaw",
                text("kopie", "backups") + ": " + String((result.backups || []).length),
                policy.updatedAtUtc ? text("zmieniono", "updated") + ": " + formatDate(policy.updatedAtUtc) : ""
            ].filter(Boolean).join(" · ");
            status.className = "admin-tools-status " + (policy.enabled ? "success" : "muted");
            enhanceBackupDownloads(result.backups || []);
        } catch (error) {
            status.textContent = error.message;
            status.className = "admin-tools-status error";
        }
    }

    async function saveBackupPolicy(event) {
        event.preventDefault();
        const button = document.getElementById("saveBackupPolicy");
        const status = document.getElementById("backupPolicyStatus");
        button.disabled = true;
        try {
            const result = await api("/api/settings/backup/policy", {
                method: "PUT",
                body: JSON.stringify({
                    enabled: document.getElementById("backupPolicyEnabled").checked,
                    hour: Number(document.getElementById("backupHour").value),
                    minute: Number(document.getElementById("backupMinute").value),
                    retention: Number(document.getElementById("backupRetention").value)
                })
            });
            status.textContent = text("Polityka backupu została zapisana.", "Backup policy saved.") + (result.removed && result.removed.length ? " " + text("Usunięto zgodnie z retencją: ", "Removed by retention: ") + result.removed.length : "");
            status.className = "admin-tools-status success";
            await loadBackupPolicy();
        } catch (error) {
            status.textContent = error.message;
            status.className = "admin-tools-status error";
        } finally { button.disabled = false; }
    }

    function enhanceBackupDownloads(backups) {
        const list = document.getElementById("backupList");
        if (!list) return;
        const byName = new Map((backups || []).map(item => [item.name, item]));
        for (const row of Array.from(list.children)) {
            const strong = row.querySelector("strong");
            const name = strong ? strong.textContent.trim() : "";
            if (!/^sirk-central-\d{8}T\d{6}(?:Z|[+-]\d{4})\.tar\.gz$/.test(name)) continue;
            if (row.querySelector("[data-backup-download]")) continue;
            const link = document.createElement("a");
            link.dataset.backupDownload = name;
            link.href = "/api/settings/backup/" + encodeURIComponent(name) + "/download";
            link.textContent = text("Pobierz", "Download");
            link.setAttribute("download", name);
            const actions = row.querySelector(".form-actions") || row;
            actions.append(link);
            const data = byName.get(name);
            if (data) link.title = formatSize(data.size) + " · " + formatDate(data.createdAtUtc);
        }
    }

    function ensureAuditExport() {
        const view = document.getElementById("auditView");
        if (!view || document.getElementById("auditExportActions")) return;
        const filters = view.querySelector(".audit-filters");
        if (!filters) return;
        const actions = document.createElement("div");
        actions.id = "auditExportActions";
        actions.className = "audit-export-actions";
        actions.innerHTML = `<a id="auditExportCsv"></a><a id="auditExportJson"></a>`;
        filters.after(actions);
        for (const [id, format] of [["auditExportCsv", "csv"], ["auditExportJson", "json"]]) {
            document.getElementById(id).addEventListener("click", event => {
                event.preventDefault();
                const params = new URLSearchParams({ format, limit: "5000" });
                const query = document.getElementById("auditQuery")?.value.trim();
                const category = document.getElementById("auditCategory")?.value;
                const result = document.getElementById("auditResult")?.value;
                if (query) params.set("query", query);
                if (category) params.set("category", category);
                if (result) params.set("result", result);
                location.assign("/api/audit/export?" + params.toString());
            });
        }
    }

    function ensureSystemVersion() {
        const settings = document.getElementById("settingsView");
        if (!settings || document.getElementById("systemVersionCard")) return;
        const card = document.createElement("article");
        card.id = "systemVersionCard";
        card.className = "settings-card";
        card.innerHTML = `<h2 id="systemVersionTitle"></h2><div class="system-version-grid"><div><small id="systemVersionLabel"></small><strong id="systemVersionValue">—</strong></div><div><small>Runtime</small><strong id="systemRuntimeValue">—</strong></div><div><small>Node.js</small><strong id="systemNodeValue">—</strong></div><div><small id="systemUptimeLabel"></small><strong id="systemUptimeValue">—</strong></div></div><p id="systemVersionStatus" class="muted"></p>`;
        settings.append(card);
    }

    async function loadSystemVersion() {
        const status = document.getElementById("systemVersionStatus");
        if (!status) return;
        try {
            const result = await api("/api/system/version");
            document.getElementById("systemVersionValue").textContent = result.version || "—";
            document.getElementById("systemRuntimeValue").textContent = result.runtime || "—";
            document.getElementById("systemNodeValue").textContent = result.node || "—";
            document.getElementById("systemUptimeValue").textContent = Math.floor(Number(result.uptimeSeconds || 0) / 60) + " min";
            status.textContent = result.backupManager ? text("Wszystkie usługi administracyjne dostępne.", "All administrative services available.") : text("Usługa backup manager niedostępna.", "Backup manager unavailable.");
            status.className = result.backupManager ? "success" : "error";
        } catch (error) {
            status.textContent = error.message;
            status.className = "error";
        }
    }

    function ensureAlertCenter() {
        const overview = document.getElementById("overviewView");
        if (!overview || document.getElementById("alertCenterCard")) return;
        const card = document.createElement("article");
        card.id = "alertCenterCard";
        card.className = "settings-card";
        card.innerHTML = `<div class="toolbar"><div><h2 id="alertCenterTitle"></h2><p id="alertCenterHelp" class="muted"></p></div><button id="alertCenterRefresh" type="button" class="secondary"></button></div><div id="alertCenter" class="alert-center"></div>`;
        overview.append(card);
        document.getElementById("alertCenterRefresh").addEventListener("click", loadAlerts);
    }

    function alertRow(level, title, detail) {
        const row = document.createElement("div");
        row.className = "alert-row alert-" + level;
        const badge = document.createElement("span");
        badge.className = "alert-badge";
        badge.textContent = ({ ok: "OK", warning: text("UWAGA", "WARNING"), error: text("BŁĄD", "ERROR"), info: "INFO" })[level] || level;
        const info = document.createElement("div");
        const strong = document.createElement("strong"); strong.textContent = title;
        const small = document.createElement("small"); small.textContent = detail;
        info.append(strong, small); row.append(badge, info); return row;
    }

    async function loadAlerts() {
        const container = document.getElementById("alertCenter");
        if (!container) return;
        const alerts = [];
        const results = await Promise.allSettled([
            api("/readyz"), api("/api/settings/update/status"), api("/api/settings/backup/policy"), api("/api/audit?limit=50&result=failure")
        ]);
        const readiness = results[0].status === "fulfilled" ? results[0].value : null;
        if (!readiness || !readiness.ok) alerts.push(alertRow("error", text("Stan bezpieczeństwa", "Security status"), text("Co najmniej jedna kontrola gotowości nie przechodzi.", "At least one readiness check is failing.")));
        else alerts.push(alertRow("ok", text("Stan bezpieczeństwa", "Security status"), text("Wszystkie kontrole gotowości przechodzą.", "All readiness checks pass.")));
        const update = results[1].status === "fulfilled" ? results[1].value.status || {} : null;
        if (!update) alerts.push(alertRow("warning", text("Aktualizacje", "Updates"), text("Nie udało się odczytać usługi aktualizacji.", "Unable to read update service.")));
        else if (update.state === "failed") alerts.push(alertRow("error", text("Ostatnia aktualizacja", "Last update"), text("Aktualizacja zakończyła się błędem i wymaga uwagi.", "Update failed and needs attention.")));
        else if (update.state === "rollback_completed") alerts.push(alertRow("warning", text("Ostatnia aktualizacja", "Last update"), text("Poprzednia wersja została przywrócona.", "Previous version was restored.")));
        else alerts.push(alertRow("ok", text("Aktualizacje", "Updates"), text("Brak krytycznego błędu aktualizacji.", "No critical update failure.")));
        const backup = results[2].status === "fulfilled" ? results[2].value : null;
        const backups = backup && Array.isArray(backup.backups) ? backup.backups : [];
        if (!backup) alerts.push(alertRow("warning", text("Backup", "Backup"), text("Usługa backupu jest niedostępna.", "Backup service is unavailable.")));
        else if (!backups.length) alerts.push(alertRow("error", text("Backup", "Backup"), text("Nie istnieje żadna kopia zapasowa.", "No backup exists.")));
        else {
            const ageHours = (Date.now() - new Date(backups[0].createdAtUtc).getTime()) / 3600000;
            alerts.push(alertRow(ageHours > 48 ? "warning" : "ok", text("Ostatni backup", "Latest backup"), formatDate(backups[0].createdAtUtc) + " · " + formatSize(backups[0].size)));
        }
        const failures = results[3].status === "fulfilled" ? results[3].value.events || [] : [];
        if (failures.length) alerts.push(alertRow("info", text("Zdarzenia nieudane", "Failed events"), text("Liczba ostatnich zdarzeń z wynikiem failure: ", "Recent failure events: ") + failures.length));
        container.replaceChildren(...alerts);
        clearTimeout(alertTimer);
        const overview = document.getElementById("overviewView");
        if (overview && !overview.hidden) alertTimer = setTimeout(loadAlerts, 30000);
    }

    function applyLanguage() {
        const values = {
            backupPolicyTitle: ["Automatyczne kopie zapasowe", "Automatic backups"],
            backupPolicyHelp: ["Ustaw codzienny harmonogram i liczbę zachowywanych kopii.", "Configure a daily schedule and retained backup count."],
            backupPolicyEnabledLabel: ["Włącz automatyczne backupy", "Enable automatic backups"],
            backupHourLabel: ["Godzina", "Hour"], backupMinuteLabel: ["Minuta", "Minute"], backupRetentionLabel: ["Retencja", "Retention"],
            saveBackupPolicy: ["Zapisz politykę", "Save policy"], refreshBackupPolicy: ["Odśwież", "Refresh"],
            auditExportCsv: ["Eksport CSV", "Export CSV"], auditExportJson: ["Eksport JSON", "Export JSON"],
            systemVersionTitle: ["Informacje o systemie", "System information"], systemVersionLabel: ["Wersja", "Version"], systemUptimeLabel: ["Czas pracy", "Uptime"],
            alertCenterTitle: ["Centrum alertów", "Alert Center"], alertCenterHelp: ["Najważniejsze ostrzeżenia wymagające uwagi administratora.", "Important warnings requiring administrator attention."], alertCenterRefresh: ["Odśwież", "Refresh"]
        };
        for (const [id, pair] of Object.entries(values)) {
            const element = document.getElementById(id);
            if (element) element.textContent = text(pair[0], pair[1]);
        }
    }

    function initialize() {
        if (initialized) return;
        initialized = true;
        ensureBackupPolicyUi();
        ensureAuditExport();
        ensureSystemVersion();
        ensureAlertCenter();
        applyLanguage();
        loadBackupPolicy();
        loadSystemVersion();
        loadAlerts();
        const backupList = document.getElementById("backupList");
        if (backupList) new MutationObserver(() => loadBackupPolicy()).observe(backupList, { childList: true });
        new MutationObserver(() => { applyLanguage(); ensureAuditExport(); ensureAlertCenter(); })
            .observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
        document.getElementById("backupTab")?.addEventListener("click", () => setTimeout(loadBackupPolicy, 100));
        document.getElementById("settingsButton")?.addEventListener("click", () => setTimeout(loadSystemVersion, 150));
        document.getElementById("overviewButton")?.addEventListener("click", () => setTimeout(loadAlerts, 200));
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => setTimeout(initialize, 400), { once: true });
    else setTimeout(initialize, 400);
}());
