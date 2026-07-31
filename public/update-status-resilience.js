"use strict";

(function () {
    const oldFetch = window.fetch.bind(window);
    const originalShowSettings = window.showSettings;
    let retryTimer = 0;
    let retryCount = 0;
    const maxRetries = 20;
    const retryDelayMs = 3000;

    function tr(pl, en) { return document.documentElement.lang === "en" ? en : pl; }

    async function requestStatus() {
        const response = await oldFetch("/api/settings/update/status", { credentials: "same-origin", cache: "no-store" });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error(body.error || "Update status request failed.");
            error.status = response.status;
            error.code = body.code || "";
            error.maintenanceRequired = response.status === 409 && /maintenance window is closed/i.test(error.message);
            throw error;
        }
        return body;
    }

    function renderMaintenanceRequired() {
        const button = document.getElementById("runUpdateButton");
        const status = document.getElementById("updateStatus");
        if (button) {
            button.disabled = true;
            button.textContent = tr("Otwórz maintenance na serwerze", "Open server maintenance");
        }
        if (status) {
            status.className = "warning";
            status.textContent = tr(
                "Updater worker jest bezpiecznie wyłączony. Na serwerze uruchom: sudo bash /opt/sirk-central/deploy/maintenance-up.sh. Po operacji wykonaj maintenance-down.sh.",
                "The updater worker is safely disabled. On the server run: sudo bash /opt/sirk-central/deploy/maintenance-up.sh. Run maintenance-down.sh after the operation."
            );
        }
    }

    function renderUnavailable(error) {
        const button = document.getElementById("runUpdateButton");
        const status = document.getElementById("updateStatus");
        if (button) {
            button.disabled = true;
            button.textContent = tr("Aktualizacja niedostępna", "Update unavailable");
        }
        if (status) {
            status.className = "error";
            const suffix = retryCount < maxRetries
                ? tr(" Ponawiam sprawdzenie...", " Retrying status check...")
                : tr(" Sprawdź gateway i worker na serwerze.", " Check the gateway and worker on the server.");
            status.textContent = (error && error.message ? error.message : tr("Usługa aktualizacji jest niedostępna.", "Update service is unavailable.")) + suffix;
        }
    }

    function renderAvailable(body) {
        retryCount = 0;
        clearTimeout(retryTimer);
        const button = document.getElementById("runUpdateButton");
        const status = document.getElementById("updateStatus");
        if (button) {
            button.disabled = Boolean(body.status && body.status.running);
            button.textContent = body.status && body.status.running
                ? tr("Aktualizacja w toku...", "Update in progress...")
                : tr("Uruchom aktualizację", "Run update");
        }
        if (status) {
            status.className = body.status && body.status.state === "failed" ? "error" : "muted";
            status.textContent = body.status && body.status.message
                ? body.status.message
                : tr("Updater maintenance worker jest dostępny.", "Updater maintenance worker is available.");
        }
    }

    async function refreshStatus() {
        try {
            const body = await requestStatus();
            renderAvailable(body);
        } catch (error) {
            clearTimeout(retryTimer);
            if (error.maintenanceRequired) {
                retryCount = 0;
                renderMaintenanceRequired();
                return;
            }
            retryCount += 1;
            renderUnavailable(error);
            if (retryCount < maxRetries) retryTimer = setTimeout(refreshStatus, retryDelayMs);
        }
    }

    if (typeof originalShowSettings === "function") {
        window.showSettings = async function patchedShowSettings() {
            const result = await originalShowSettings.apply(this, arguments);
            refreshStatus();
            return result;
        };
    }

    document.addEventListener("click", event => {
        if (event.target.closest("#settingsButton,#settingsNavButton,#refreshUpdateStatusButton")) {
            setTimeout(refreshStatus, 50);
        }
        if (event.target.closest("#overviewButton,#backButton,#logoutButton")) {
            clearTimeout(retryTimer);
            retryCount = 0;
        }
    }, true);
}());
