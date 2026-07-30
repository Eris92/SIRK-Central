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

    function fromB64url(value) {
        const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
        const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
        const binary = atob(padded);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        return bytes.buffer;
    }

    function toB64url(value) {
        const bytes = new Uint8Array(value || new ArrayBuffer(0));
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    }

    function registrationOptions(publicKey, attachment) {
        return Object.assign({}, publicKey, {
            challenge: fromB64url(publicKey.challenge),
            user: Object.assign({}, publicKey.user, { id: fromB64url(publicKey.user.id) }),
            excludeCredentials: (publicKey.excludeCredentials || []).map(item => Object.assign({}, item, { id: fromB64url(item.id) })),
            authenticatorSelection: Object.assign({}, publicKey.authenticatorSelection || {}, {
                authenticatorAttachment: attachment,
                residentKey: "preferred",
                userVerification: "required"
            })
        });
    }

    function registrationPayload(credential) {
        const response = credential.response;
        if (typeof response.getPublicKey !== "function" || typeof response.getAuthenticatorData !== "function" || typeof response.getPublicKeyAlgorithm !== "function") {
            throw new Error(text("Przeglądarka nie udostępnia wymaganych metod WebAuthn.", "The browser does not expose required WebAuthn methods."));
        }
        return {
            credentialId: toB64url(credential.rawId),
            rawId: toB64url(credential.rawId),
            clientDataJSON: toB64url(response.clientDataJSON),
            authenticatorData: toB64url(response.getAuthenticatorData()),
            publicKey: toB64url(response.getPublicKey()),
            publicKeyAlgorithm: response.getPublicKeyAlgorithm(),
            transports: typeof response.getTransports === "function" ? response.getTransports() : []
        };
    }

    async function registerWindowsHello(button, output) {
        button.disabled = true;
        output.textContent = "";
        try {
            if (!window.PublicKeyCredential || !navigator.credentials) throw new Error(text("Ta przeglądarka nie obsługuje Windows Hello/WebAuthn.", "This browser does not support Windows Hello/WebAuthn."));
            const available = typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === "function"
                ? await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
                : true;
            if (!available) throw new Error(text("Na tym urządzeniu nie wykryto Windows Hello.", "Windows Hello is not available on this device."));
            const begin = await api("/api/break-glass/passkeys/begin-registration", { method: "POST", body: "{}" });
            const credential = await navigator.credentials.create({ publicKey: registrationOptions(begin.publicKey, "platform") });
            if (!credential) throw new Error(text("Nie utworzono poświadczenia Windows Hello.", "No Windows Hello credential was created."));
            await api("/api/break-glass/passkeys/finish-registration", {
                method: "POST",
                body: JSON.stringify({ challengeId: begin.challengeId, displayName: "Windows Hello", credential: registrationPayload(credential) })
            });
            output.textContent = text("Windows Hello zostało zarejestrowane.", "Windows Hello has been registered.");
            const refresh = document.querySelector("[data-passkey-refresh]");
            if (refresh) refresh.click();
        } catch (error) {
            output.textContent = error.name === "NotAllowedError"
                ? text("Rejestracja Windows Hello została anulowana.", "Windows Hello registration was cancelled.")
                : error.message;
        } finally {
            button.disabled = false;
        }
    }

    function addWindowsHelloButton() {
        const register = document.querySelector("[data-passkey-register]");
        const output = document.querySelector("[data-passkey-message]");
        if (!register || !output || document.querySelector("[data-windows-hello-register]")) return;
        register.textContent = text("Zarejestruj klucz sprzętowy", "Register hardware key");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "secondary";
        button.dataset.windowsHelloRegister = "true";
        button.textContent = "Windows Hello";
        button.addEventListener("click", () => registerWindowsHello(button, output));
        register.parentElement.insertBefore(button, register.nextSibling);
    }

    function showPendingRole(identity) {
        if (!identity || identity.role) return;
        const dashboard = document.getElementById("dashboardView");
        if (!dashboard) return;
        const existing = document.getElementById("pendingRoleView");
        if (existing) return;
        for (const child of dashboard.children) child.hidden = true;
        const section = document.createElement("section");
        section.id = "pendingRoleView";
        section.className = "login-card";
        section.style.margin = "80px auto";
        section.innerHTML = '<div class="mark">S</div><p class="eyebrow">SIRK Central</p><h1 data-pending-title></h1><p class="muted" data-pending-description></p><p class="muted" data-pending-account></p><div class="form-actions"><button type="button" data-pending-refresh></button><button type="button" class="secondary" data-pending-logout></button></div><p class="error" data-pending-message></p>';
        dashboard.append(section);
        const apply = () => {
            section.querySelector("[data-pending-title]").textContent = text("Konto oczekuje na nadanie roli", "Account awaiting role assignment");
            section.querySelector("[data-pending-description]").textContent = text("Logowanie Microsoft Entra zakończyło się poprawnie. Administrator lub SecAdmin musi teraz zatwierdzić konto i nadać rolę.", "Microsoft Entra sign-in succeeded. An administrator or SecAdmin must now approve the account and assign a role.");
            section.querySelector("[data-pending-account]").textContent = (identity.displayName || identity.username || "") + (identity.username ? " · " + identity.username : "");
            section.querySelector("[data-pending-refresh]").textContent = text("Sprawdź ponownie", "Check again");
            section.querySelector("[data-pending-logout]").textContent = text("Wyloguj", "Sign out");
        };
        apply();
        new MutationObserver(apply).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
        section.querySelector("[data-pending-refresh]").addEventListener("click", () => location.reload());
        section.querySelector("[data-pending-logout]").addEventListener("click", async () => {
            try {
                const result = await api("/api/logout", { method: "POST", body: "{}" });
                location.assign(result.logoutUrl || "/");
            } catch (error) {
                section.querySelector("[data-pending-message]").textContent = error.message;
            }
        });
    }

    function createOperationsTabs(identity) {
        if (!identity || !(identity.builtIn || identity.role === "Admin" || identity.role === "SecAdmin")) return;
        const nav = document.querySelector(".settings-tabs");
        const settings = document.getElementById("settingsView");
        if (!nav || !settings || document.querySelector('[data-settings-tab="updates"]')) return;

        const updateTab = document.createElement("button");
        updateTab.className = "settings-tab";
        updateTab.dataset.settingsTab = "updates";
        const backupTab = document.createElement("button");
        backupTab.className = "settings-tab";
        backupTab.dataset.settingsTab = "backup";
        nav.append(updateTab, backupTab);

        const updatePanel = document.createElement("section");
        updatePanel.id = "settingsTabUpdates";
        updatePanel.className = "settings-tab-panel";
        updatePanel.hidden = true;
        updatePanel.innerHTML = '<article class="settings-card"><h2 data-updates-title></h2><p class="muted" data-update-status></p><div class="form-actions"><button type="button" data-update-refresh></button><button type="button" data-update-run></button></div><p class="error" data-update-message></p></article>';

        const backupPanel = document.createElement("section");
        backupPanel.id = "settingsTabBackup";
        backupPanel.className = "settings-tab-panel";
        backupPanel.hidden = true;
        backupPanel.innerHTML = '<article class="settings-card"><h2 data-backup-title></h2><p class="muted" data-backup-help></p><div class="form-actions"><button type="button" data-backup-refresh></button><button type="button" data-backup-run></button></div><div class="users-list" data-backup-list></div><p class="error" data-backup-message></p></article>';
        settings.append(updatePanel, backupPanel);

        const apply = () => {
            updateTab.textContent = text("Aktualizacje", "Updates");
            backupTab.textContent = text("Backup", "Backup");
            updatePanel.querySelector("[data-updates-title]").textContent = text("Aktualizacja SIRK Central", "SIRK Central update");
            updatePanel.querySelector("[data-update-refresh]").textContent = text("Odśwież status", "Refresh status");
            updatePanel.querySelector("[data-update-run]").textContent = text("Uruchom aktualizację", "Run update");
            backupPanel.querySelector("[data-backup-title]").textContent = text("Kopie zapasowe", "Backups");
            backupPanel.querySelector("[data-backup-help]").textContent = text("Backup obejmuje trwałe dane aplikacji, konfigurację użytkowników, role i klucze MFA.", "The backup includes persistent application data, users, roles and MFA keys.");
            backupPanel.querySelector("[data-backup-refresh]").textContent = text("Odśwież listę", "Refresh list");
            backupPanel.querySelector("[data-backup-run]").textContent = text("Utwórz backup teraz", "Create backup now");
        };
        apply();
        new MutationObserver(apply).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });

        function select(name) {
            for (const button of nav.querySelectorAll("[data-settings-tab]")) button.classList.toggle("active", button.dataset.settingsTab === name);
            for (const panel of settings.querySelectorAll(".settings-tab-panel")) panel.hidden = panel.id !== (name === "updates" ? "settingsTabUpdates" : "settingsTabBackup");
        }
        updateTab.addEventListener("click", () => { select("updates"); loadUpdateStatus(); });
        backupTab.addEventListener("click", () => { select("backup"); loadBackups(); });

        async function loadUpdateStatus() {
            const target = updatePanel.querySelector("[data-update-status]");
            try {
                const result = await api("/api/settings/update/status");
                const status = result.status || {};
                target.textContent = text("Stan: ", "State: ") + (status.state || "idle") + (status.startedAtUtc ? " · " + new Date(status.startedAtUtc).toLocaleString(lang()) : "");
            } catch (error) { target.textContent = error.message; }
        }
        async function loadBackups() {
            const list = backupPanel.querySelector("[data-backup-list]");
            try {
                const result = await api("/api/settings/backup/status");
                const backups = result.backups || [];
                list.replaceChildren(...backups.map(item => {
                    const row = document.createElement("div"); row.className = "user-row";
                    const info = document.createElement("div"); info.innerHTML = "<strong></strong><small></small>";
                    info.querySelector("strong").textContent = item.name;
                    info.querySelector("small").textContent = new Date(item.createdAtUtc).toLocaleString(lang()) + " · " + Math.ceil(item.size / 1024) + " KiB";
                    row.append(info); return row;
                }));
                if (!backups.length) list.textContent = text("Brak kopii zapasowych.", "No backups available.");
            } catch (error) { list.textContent = error.message; }
        }
        updatePanel.querySelector("[data-update-refresh]").addEventListener("click", loadUpdateStatus);
        updatePanel.querySelector("[data-update-run]").addEventListener("click", async () => {
            const message = updatePanel.querySelector("[data-update-message]");
            if (!confirm(text("Uruchomić aktualizację SIRK Central?", "Run the SIRK Central update?"))) return;
            try { await api("/api/settings/update/run", { method: "POST", body: JSON.stringify({ confirm: "UPDATE SIRK CENTRAL" }) }); message.textContent = text("Aktualizacja została uruchomiona.", "The update has started."); loadUpdateStatus(); }
            catch (error) { message.textContent = error.message; }
        });
        backupPanel.querySelector("[data-backup-refresh]").addEventListener("click", loadBackups);
        backupPanel.querySelector("[data-backup-run]").addEventListener("click", async () => {
            const message = backupPanel.querySelector("[data-backup-message]");
            try { await api("/api/settings/backup/run", { method: "POST", body: JSON.stringify({ confirm: "BACKUP SIRK CENTRAL" }) }); message.textContent = text("Backup został utworzony.", "Backup created."); loadBackups(); }
            catch (error) { message.textContent = error.message; }
        });
    }

    async function initialize() {
        addWindowsHelloButton();
        try {
            const identity = await api("/api/session");
            showPendingRole(identity);
            createOperationsTabs(identity);
        } catch (_) { /* unauthenticated */ }
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
    else initialize();
}());
