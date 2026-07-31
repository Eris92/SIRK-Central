"use strict";

(function () {
    const RETRY_DELAY_MS = 3000;
    const MAX_RETRIES = 20;
    let timer = null;
    let attempts = 0;
    let lastSuccessfulText = "";

    function lang() {
        return document.documentElement.lang === "en" ? "en" : "pl";
    }

    function text(pl, en) {
        return lang() === "en" ? en : pl;
    }

    function statusElement() {
        return document.getElementById("updateStatus");
    }

    function messageElement() {
        return document.getElementById("updateMessage");
    }

    function runButton() {
        return document.getElementById("runUpdateButton");
    }

    function formatStatus(status) {
        const parts = [text("Stan", "State") + ": " + String(status.state || "idle")];
        if (status.startedAtUtc) parts.push(text("uruchomiono", "started") + ": " + new Date(status.startedAtUtc).toLocaleString(lang()));
        if (status.finishedAtUtc) parts.push(text("zakończono", "finished") + ": " + new Date(status.finishedAtUtc).toLocaleString(lang()));
        if (status.message) parts.push(String(status.message));
        if (status.exitCode !== undefined && status.exitCode !== null) parts.push(text("kod", "exit code") + ": " + status.exitCode);
        if (status.logFile) parts.push(text("log", "log") + ": " + status.logFile);
        return parts.join(" · ");
    }

    async function refresh() {
        const target = statusElement();
        if (!target) return;

        try {
            const response = await fetch("/api/settings/update/status", {
                credentials: "same-origin",
                cache: "no-store",
                headers: { Accept: "application/json" }
            });
            const body = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(body.error || "HTTP " + response.status);

            const status = body.status || {};
            attempts = 0;
            lastSuccessfulText = formatStatus(status);
            target.textContent = lastSuccessfulText;
            target.className = status.state === "failed" ? "error" : "muted";

            const active = status.running === true || ["starting", "running", "rollback"].includes(status.state);
            const button = runButton();
            if (button) button.disabled = active;

            if (active) schedule();
            else stop();
        } catch (error) {
            attempts += 1;
            const suffix = attempts >= MAX_RETRIES
                ? text("Usługa nadal jest niedostępna. Użyj „Odśwież status”.", "The service is still unavailable. Use “Refresh status”.")
                : text("Trwa ponowne łączenie z usługą aktualizacji…", "Reconnecting to the update service…");
            target.textContent = (lastSuccessfulText ? lastSuccessfulText + " · " : "") + suffix;
            target.className = "muted";
            const message = messageElement();
            if (message && /Błąd żądania|Request failed/i.test(message.textContent || "")) message.textContent = "";
            if (attempts < MAX_RETRIES) schedule();
            else stop();
        }
    }

    function schedule() {
        if (timer) clearTimeout(timer);
        timer = setTimeout(refresh, RETRY_DELAY_MS);
    }

    function stop() {
        if (timer) clearTimeout(timer);
        timer = null;
    }

    function mount() {
        const refreshButton = document.getElementById("refreshUpdateButton");
        const updateTab = document.getElementById("updatesTab");
        const startButton = runButton();

        if (refreshButton) refreshButton.addEventListener("click", function () {
            attempts = 0;
            refresh();
        }, true);
        if (updateTab) updateTab.addEventListener("click", function () {
            attempts = 0;
            refresh();
        }, true);
        if (startButton) startButton.addEventListener("click", function () {
            attempts = 0;
            setTimeout(refresh, 750);
        }, true);
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
    else mount();
}());
