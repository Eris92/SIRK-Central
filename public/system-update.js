"use strict";

(function () {
    const state = document.getElementById("updateState");
    const commit = document.getElementById("updateCommit");
    const started = document.getElementById("updateStarted");
    const finished = document.getElementById("updateFinished");
    const message = document.getElementById("updateMessage");
    const details = document.getElementById("updateDetails");
    const confirmation = document.getElementById("confirmation");
    const runButton = document.getElementById("runButton");
    const refreshButton = document.getElementById("refreshButton");
    let timer = null;

    function format(value) {
        if (!value) return "—";
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
    }

    function render(status) {
        status = status || {};
        state.textContent = status.state || "idle";
        commit.textContent = status.commit ? String(status.commit).slice(0, 12) : "—";
        started.textContent = format(status.startedAtUtc);
        finished.textContent = format(status.finishedAtUtc);
        message.textContent = status.message || "";
        details.hidden = true;
        details.textContent = JSON.stringify(status, null, 2);
        runButton.disabled = Boolean(status.running);
        if (status.running && !timer) timer = window.setInterval(load, 3000);
        if (!status.running && timer) {
            window.clearInterval(timer);
            timer = null;
        }
    }

    async function request(url, options) {
        const response = await fetch(url, Object.assign({ credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } }, options || {}));
        const body = await response.json().catch(() => ({ ok: false, error: "Nieprawidłowa odpowiedź serwera." }));
        if (!response.ok) throw new Error(body.error || "Operacja nie powiodła się.");
        return body;
    }

    async function load() {
        refreshButton.disabled = true;
        try {
            const body = await request("/api/system-update/status");
            render(body.status);
        } catch (error) {
            message.textContent = error.message;
        } finally {
            refreshButton.disabled = false;
        }
    }

    async function run() {
        const value = confirmation.value.trim();
        if (value !== "UPDATE SIRK CENTRAL") {
            message.textContent = "Wpisz prawidłowe potwierdzenie.";
            confirmation.focus();
            return;
        }
        runButton.disabled = true;
        message.textContent = "Przekazywanie zlecenia aktualizacji…";
        try {
            const body = await request("/api/system-update/run", {
                method: "POST",
                headers: {
                    Accept: "application/json",
                    "X-SIRK-Update-Confirm": value
                }
            });
            confirmation.value = "";
            render({ state: "starting", running: true, startedAtUtc: body.startedAtUtc, message: "Aktualizacja została przyjęta." });
        } catch (error) {
            message.textContent = error.message;
            runButton.disabled = false;
        }
    }

    refreshButton.addEventListener("click", load);
    runButton.addEventListener("click", run);
    load();
}());
