"use strict";

(function () {
    const view = document.getElementById("breakGlassView");
    if (!view) return;

    const labels = {
        pl: {
            title: "Ochrona MFA Break-Glass",
            loading: "Wczytywanie stanu MFA...",
            configured: "Recovery codes są aktywne.",
            missing: "Recovery codes nie są jeszcze skonfigurowane.",
            remaining: "Pozostałe kody",
            rotated: "Ostatnia rotacja",
            blocked: "Weryfikacja zablokowana do",
            generate: "Wygeneruj nowe recovery codes",
            revoke: "Unieważnij recovery codes",
            confirmRotate: "Dotychczasowe recovery codes przestaną działać. Kontynuować?",
            confirmRevoke: "Recovery codes można usunąć tylko wtedy, gdy aktywna jest co najmniej jedna metoda Windows Hello, YubiKey lub passkey. Kontynuować?",
            shownOnce: "Kody są pokazane tylko raz. Zapisz je w bezpiecznym, niezależnym miejscu.",
            saved: "Zapisałem kody w bezpiecznym miejscu",
            hide: "Ukryj zapisane kody",
            revoked: "Recovery codes zostały unieważnione.",
            generated: "Nowe recovery codes zostały wygenerowane.",
            noPasskey: "Windows Hello / YubiKey / WebAuthn nie jest jeszcze aktywny.",
            activePasskeys: "Aktywne metody Windows Hello / YubiKey / WebAuthn: {count}.",
            requestError: "Nie udało się wykonać operacji MFA."
        },
        en: {
            title: "Break-Glass MFA protection",
            loading: "Loading MFA status...",
            configured: "Recovery codes are active.",
            missing: "Recovery codes are not configured yet.",
            remaining: "Codes remaining",
            rotated: "Last rotation",
            blocked: "Verification blocked until",
            generate: "Generate new recovery codes",
            revoke: "Revoke recovery codes",
            confirmRotate: "Existing recovery codes will stop working. Continue?",
            confirmRevoke: "Recovery codes can only be removed while at least one Windows Hello, YubiKey, or passkey method remains active. Continue?",
            shownOnce: "These codes are shown once. Store them in a secure, independent location.",
            saved: "I stored the codes securely",
            hide: "Hide stored codes",
            revoked: "Recovery codes have been revoked.",
            generated: "New recovery codes have been generated.",
            noPasskey: "Windows Hello / YubiKey / WebAuthn is not active yet.",
            activePasskeys: "Active Windows Hello / YubiKey / WebAuthn methods: {count}.",
            requestError: "The MFA operation failed."
        }
    };

    let activePasskeyCount = 0;

    function lang() {
        return document.documentElement.lang === "en" ? "en" : "pl";
    }

    function text(key) {
        return labels[lang()][key];
    }

    async function request(path, options) {
        const supplied = options || {};
        const headers = new Headers(supplied.headers || {});
        if (!headers.has("Content-Type") && supplied.body !== undefined)
            headers.set("Content-Type", "application/json");
        const response = await fetch(path, Object.assign({}, supplied, {
            credentials: "same-origin",
            cache: "no-store",
            headers
        }));
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || text("requestError"));
        return result;
    }

    async function csrfHeaders() {
        const token = await request("/api/v1/auth/csrf");
        return { [token.headerName || "X-SIRK-CSRF"]: token.requestToken };
    }

    const article = document.createElement("article");
    article.className = "settings-card danger-card";
    article.innerHTML = [
        '<h2 data-mfa-title></h2>',
        '<p class="muted" data-mfa-status></p>',
        '<div class="security-facts" data-mfa-facts></div>',
        '<p class="muted" data-mfa-passkey></p>',
        '<div class="form-actions">',
        '  <button type="button" data-mfa-rotate></button>',
        '  <button type="button" class="danger" data-mfa-revoke></button>',
        '</div>',
        '<section data-mfa-secret hidden>',
        '  <p class="warning" data-mfa-once></p>',
        '  <pre class="secret-output" data-mfa-codes></pre>',
        '  <label class="checkbox-row"><input type="checkbox" data-mfa-saved><span data-mfa-saved-label></span></label>',
        '  <button type="button" class="secondary" data-mfa-hide disabled></button>',
        '</section>',
        '<p class="muted" role="status" data-mfa-message></p>'
    ].join("");

    const grid = view.querySelector(".settings-grid") || view;
    grid.append(article);

    const title = article.querySelector("[data-mfa-title]");
    const status = article.querySelector("[data-mfa-status]");
    const facts = article.querySelector("[data-mfa-facts]");
    const passkey = article.querySelector("[data-mfa-passkey]");
    const rotate = article.querySelector("[data-mfa-rotate]");
    const revoke = article.querySelector("[data-mfa-revoke]");
    const secret = article.querySelector("[data-mfa-secret]");
    const once = article.querySelector("[data-mfa-once]");
    const codes = article.querySelector("[data-mfa-codes]");
    const saved = article.querySelector("[data-mfa-saved]");
    const savedLabel = article.querySelector("[data-mfa-saved-label]");
    const hide = article.querySelector("[data-mfa-hide]");
    const output = article.querySelector("[data-mfa-message]");

    function renderPasskeyStatus() {
        passkey.textContent = activePasskeyCount > 0
            ? text("activePasskeys").replace("{count}", String(activePasskeyCount))
            : text("noPasskey");
    }

    function applyLabels() {
        title.textContent = text("title");
        rotate.textContent = text("generate");
        revoke.textContent = text("revoke");
        once.textContent = text("shownOnce");
        savedLabel.textContent = text("saved");
        hide.textContent = text("hide");
        renderPasskeyStatus();
    }

    function fact(label, value) {
        const item = document.createElement("div");
        const name = document.createElement("span");
        const content = document.createElement("strong");
        name.textContent = label;
        content.textContent = value || "—";
        item.append(name, content);
        return item;
    }

    function clearSecrets() {
        codes.textContent = "";
        saved.checked = false;
        hide.disabled = true;
        secret.hidden = true;
    }

    async function loadStatus() {
        status.textContent = text("loading");
        output.textContent = "";
        try {
            const [result, credentials] = await Promise.all([
                request("/api/v1/break-glass/mfa/status"),
                request("/api/v1/webauthn/credentials")
            ]);
            const recovery = result.recoveryCodes || {};
            activePasskeyCount = Array.isArray(credentials) ? credentials.length : 0;
            status.textContent = recovery.configured ? text("configured") : text("missing");
            status.className = "muted";
            facts.replaceChildren(
                fact(text("remaining"), String(recovery.remaining || 0)),
                fact(text("rotated"), recovery.rotatedAtUtc
                    ? new Date(recovery.rotatedAtUtc).toLocaleString(lang())
                    : "—"),
                fact(text("blocked"), recovery.blockedUntilUtc
                    ? new Date(recovery.blockedUntilUtc).toLocaleString(lang())
                    : "—")
            );
            renderPasskeyStatus();
            revoke.disabled = !recovery.configured;
        } catch (error) {
            status.textContent = error.message;
            status.className = "error";
        }
    }

    rotate.addEventListener("click", async function () {
        if (!window.confirm(text("confirmRotate"))) return;
        rotate.disabled = true;
        revoke.disabled = true;
        output.textContent = "";
        clearSecrets();
        try {
            const result = await request(
                "/api/v1/break-glass/mfa/recovery-codes/rotate",
                {
                    method: "POST",
                    headers: await csrfHeaders(),
                    body: JSON.stringify({ count: 10 })
                });
            codes.textContent = (result.codes || []).join("\n");
            secret.hidden = false;
            output.textContent = text("generated");
            output.className = "muted";
            await loadStatus();
        } catch (error) {
            output.textContent = error.message;
            output.className = "error";
        } finally {
            rotate.disabled = false;
        }
    });

    revoke.addEventListener("click", async function () {
        if (!window.confirm(text("confirmRevoke"))) return;
        rotate.disabled = true;
        revoke.disabled = true;
        output.textContent = "";
        clearSecrets();
        try {
            await request("/api/v1/break-glass/mfa/recovery-codes", {
                method: "DELETE",
                headers: await csrfHeaders()
            });
            output.textContent = text("revoked");
            output.className = "muted";
            await loadStatus();
        } catch (error) {
            output.textContent = error.message;
            output.className = "error";
        } finally {
            rotate.disabled = false;
        }
    });

    saved.addEventListener("change", function () {
        hide.disabled = !saved.checked;
    });

    hide.addEventListener("click", function () {
        if (saved.checked) clearSecrets();
    });

    window.addEventListener("pagehide", clearSecrets);
    document.addEventListener("visibilitychange", function () {
        if (document.visibilityState === "hidden" && saved.checked) clearSecrets();
    });
    new MutationObserver(applyLabels).observe(
        document.documentElement,
        { attributes: true, attributeFilter: ["lang"] });

    applyLabels();
    loadStatus();
}());
