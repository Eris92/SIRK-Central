"use strict";

(function () {
    if (window.__sirkPortalUpdateCommandUiLoaded) return;
    window.__sirkPortalUpdateCommandUiLoaded = true;

    function text(pl, en) { return document.documentElement.lang === "en" ? en : pl; }
    function createField(id, labelText, type, placeholder) {
        const label = document.createElement("label");
        label.dataset.portalUpdateField = "1";
        label.hidden = true;
        const caption = document.createElement("span");
        caption.textContent = labelText;
        const input = document.createElement("input");
        input.id = id;
        input.type = type || "text";
        input.placeholder = placeholder || "";
        input.autocomplete = "off";
        label.append(caption, input);
        return { label, input, caption };
    }
    async function api(path) {
        const response = await fetch(path, { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } });
        const value = await response.json().catch(() => ({}));
        if (!response.ok || value.ok === false) throw new Error(value.error || text("Nie udało się pobrać release.", "Release lookup failed."));
        return value;
    }
    function initialize() {
        const form = document.getElementById("portalCommandForm");
        const type = document.getElementById("portalCommandType");
        const payload = document.getElementById("portalCommandPayload");
        if (!form || !type || !payload || form.dataset.updateFieldsReady === "1") return false;
        form.dataset.updateFieldsReady = "1";

        const url = createField("portalUpdatePackageUrl", text("URL pakietu release ZIP", "Release ZIP package URL"), "url", "https://github.com/Eris92/SIRK-Portal/releases/download/...");
        const sha = createField("portalUpdateSha256", "SHA-256", "text", "64 hex characters");
        const version = createField("portalUpdateTargetVersion", text("Wersja docelowa", "Target version"), "text", "2.0.0-dev.32");
        sha.input.pattern = "[A-Fa-f0-9]{64}";
        version.input.pattern = "[0-9A-Za-z][0-9A-Za-z.+_-]{0,79}";
        const payloadLabel = payload.closest("label");
        form.insertBefore(url.label, payloadLabel);
        form.insertBefore(sha.label, payloadLabel);
        form.insertBefore(version.label, payloadLabel);

        const releaseActions = document.createElement("div");
        releaseActions.dataset.portalUpdateField = "1";
        releaseActions.className = "form-actions";
        releaseActions.hidden = true;
        const channel = document.createElement("select");
        channel.id = "portalUpdateChannel";
        channel.innerHTML = '<option value="dev">Dev / prerelease</option><option value="stable">Stable</option>';
        const lookup = document.createElement("button");
        lookup.type = "button";
        lookup.className = "secondary";
        const message = document.createElement("span");
        message.className = "muted";
        releaseActions.append(channel, lookup, message);
        form.insertBefore(releaseActions, url.label);

        function buildPayload() {
            if (type.value !== "update") return;
            payload.value = JSON.stringify({
                applicationId: "sirk-portal",
                packageUrl: url.input.value.trim(),
                sha256: sha.input.value.trim().toUpperCase(),
                targetVersion: version.input.value.trim()
            }, null, 2);
        }
        async function loadLatest() {
            lookup.disabled = true;
            message.textContent = text("Pobieranie metadata…", "Loading metadata…");
            try {
                const result = await api("/api/portal-releases/latest?channel=" + encodeURIComponent(channel.value));
                const release = result.release || {};
                url.input.value = release.packageUrl || "";
                sha.input.value = release.sha256 || "";
                version.input.value = release.version || "";
                buildPayload();
                message.textContent = text("Wczytano ", "Loaded ") + release.version;
                message.className = "success";
            } catch (error) {
                message.textContent = error.message;
                message.className = "error";
            } finally { lookup.disabled = false; }
        }
        function refresh() {
            const update = type.value === "update";
            [url, sha, version].forEach(field => {
                field.label.hidden = !update;
                field.input.required = update;
            });
            releaseActions.hidden = !update;
            payload.readOnly = update;
            payload.closest("label").hidden = update;
            if (update) buildPayload();
        }
        function translate() {
            url.caption.textContent = text("URL pakietu release ZIP", "Release ZIP package URL");
            version.caption.textContent = text("Wersja docelowa", "Target version");
            lookup.textContent = text("Pobierz najnowszy release", "Load latest release");
            channel.options[0].textContent = text("Dev / prerelease", "Dev / prerelease");
            channel.options[1].textContent = "Stable";
        }
        [url.input, sha.input, version.input].forEach(input => input.addEventListener("input", buildPayload));
        lookup.addEventListener("click", loadLatest);
        type.addEventListener("change", refresh);
        form.addEventListener("submit", event => {
            if (type.value !== "update") return;
            buildPayload();
            if (!url.input.checkValidity() || !sha.input.checkValidity() || !version.input.checkValidity()) {
                event.preventDefault();
                event.stopImmediatePropagation();
                form.reportValidity();
            }
        }, true);
        new MutationObserver(translate).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
        translate();
        refresh();
        return true;
    }
    if (!initialize()) {
        let attempts = 0;
        const timer = setInterval(() => { attempts += 1; if (initialize() || attempts > 120) clearInterval(timer); }, 100);
    }
}());
