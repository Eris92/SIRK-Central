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
    function initialize() {
        const form = document.getElementById("portalCommandForm");
        const type = document.getElementById("portalCommandType");
        const payload = document.getElementById("portalCommandPayload");
        const submit = document.getElementById("portalCommandSubmit");
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

        function buildPayload() {
            if (type.value !== "update") return;
            payload.value = JSON.stringify({
                applicationId: "sirk-portal",
                packageUrl: url.input.value.trim(),
                sha256: sha.input.value.trim().toUpperCase(),
                targetVersion: version.input.value.trim()
            }, null, 2);
        }
        function refresh() {
            const update = type.value === "update";
            [url, sha, version].forEach(field => {
                field.label.hidden = !update;
                field.input.required = update;
            });
            payload.readOnly = update;
            payload.closest("label").hidden = update;
            if (update) buildPayload();
        }
        [url.input, sha.input, version.input].forEach(input => input.addEventListener("input", buildPayload));
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
        new MutationObserver(() => {
            url.caption.textContent = text("URL pakietu release ZIP", "Release ZIP package URL");
            version.caption.textContent = text("Wersja docelowa", "Target version");
        }).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
        refresh();
        return true;
    }
    if (!initialize()) {
        let attempts = 0;
        const timer = setInterval(() => { attempts += 1; if (initialize() || attempts > 120) clearInterval(timer); }, 100);
    }
}());
