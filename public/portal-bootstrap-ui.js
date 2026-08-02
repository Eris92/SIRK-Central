"use strict";

(function () {
    let currentBootstrap = null;

    function cookie(name) {
        const prefix = name + "=";
        for (const part of String(document.cookie || "").split(";")) {
            const value = part.trim();
            if (value.startsWith(prefix)) return decodeURIComponent(value.slice(prefix.length));
        }
        return "";
    }

    function downloadJson(name, value) {
        const blob = new Blob([JSON.stringify(value, null, 2) + "\n"], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        try {
            const link = document.createElement("a");
            link.href = url;
            link.download = name;
            document.body.appendChild(link);
            link.click();
            link.remove();
        } finally {
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
    }

    function ensureActions(panel) {
        let actions = document.getElementById("portalBootstrapActions");
        if (actions) return actions;
        actions = document.createElement("div");
        actions.id = "portalBootstrapActions";
        actions.className = "form-actions";
        actions.hidden = true;

        const download = document.createElement("button");
        download.id = "downloadPortalBootstrapButton";
        download.type = "button";
        download.textContent = "Pobierz konfigurację Portalu";
        download.addEventListener("click", () => {
            if (!currentBootstrap) return;
            downloadJson("sirk-portal-" + currentBootstrap.portalId + "-bootstrap.json", currentBootstrap);
        });

        const clear = document.createElement("button");
        clear.id = "clearPortalBootstrapButton";
        clear.type = "button";
        clear.className = "secondary";
        clear.textContent = "Ukryj dane jednorazowe";
        clear.addEventListener("click", () => {
            currentBootstrap = null;
            actions.hidden = true;
            const tokenPanel = document.getElementById("tokenPanel");
            const token = document.getElementById("portalToken");
            if (token) token.textContent = "";
            if (tokenPanel) tokenPanel.hidden = true;
        });

        actions.append(download, clear);
        panel.appendChild(actions);
        return actions;
    }

    async function createBootstrap(event) {
        const form = event.currentTarget;
        if (!form || form.hidden) return;
        event.preventDefault();
        event.stopImmediatePropagation();

        const idInput = document.getElementById("portalId");
        const nameInput = document.getElementById("portalName");
        const tokenPanel = document.getElementById("tokenPanel");
        const token = document.getElementById("portalToken");
        if (!idInput || !nameInput || !tokenPanel || !token) return;

        const submit = form.querySelector('button[type="submit"]');
        const previous = submit ? submit.textContent : "";
        if (submit) {
            submit.disabled = true;
            submit.textContent = "Tworzenie...";
        }

        try {
            const csrf = cookie("sirk_central_csrf");
            if (!csrf) throw new Error("Brak tokenu CSRF. Odśwież stronę i spróbuj ponownie.");
            const response = await fetch("/api/portals/bootstrap", {
                method: "POST",
                credentials: "same-origin",
                headers: {
                    "Content-Type": "application/json",
                    "X-SIRK-CSRF": csrf
                },
                body: JSON.stringify({ id: idInput.value.trim(), name: nameInput.value.trim() })
            });
            const body = await response.json().catch(() => ({}));
            if (!response.ok || !body.ok || !body.bootstrap) {
                throw new Error(body.error || "Nie udało się utworzyć konfiguracji Portalu.");
            }

            currentBootstrap = body.bootstrap;
            token.textContent = currentBootstrap.portalToken;
            tokenPanel.hidden = false;
            const actions = ensureActions(tokenPanel);
            actions.hidden = false;
            form.reset();
            window.dispatchEvent(new CustomEvent("sirk:portal-bootstrap-created", {
                detail: { portalId: currentBootstrap.portalId }
            }));
        } catch (error) {
            window.alert(error.message || "Nie udało się utworzyć konfiguracji Portalu.");
        } finally {
            if (submit) {
                submit.disabled = false;
                submit.textContent = previous;
            }
        }
    }

    function initialize() {
        const form = document.getElementById("createForm");
        const tokenPanel = document.getElementById("tokenPanel");
        if (!form || !tokenPanel || form.dataset.bootstrapBound === "true") return;
        form.dataset.bootstrapBound = "true";
        ensureActions(tokenPanel);
        form.addEventListener("submit", createBootstrap, true);
        window.addEventListener("beforeunload", () => { currentBootstrap = null; });
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize);
    else initialize();
})();
