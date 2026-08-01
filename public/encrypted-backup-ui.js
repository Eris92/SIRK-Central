"use strict";

(function () {
    function language() { return document.documentElement.lang === "en" ? "en" : "pl"; }
    function text(pl, en) { return language() === "en" ? en : pl; }

    function decorate() {
        const list = document.getElementById("backupList");
        if (!list) return;
        for (const row of list.querySelectorAll(".user-row")) {
            const name = row.querySelector("strong");
            if (!name || !name.textContent.endsWith(".tar.gz.age")) continue;
            if (row.dataset.encryptedBackup === "true") continue;
            row.dataset.encryptedBackup = "true";
            const details = row.querySelector("small");
            if (details) details.textContent += " · " + text("Szyfrowanie: age", "Encryption: age");
            const restore = row.querySelector("button.danger");
            if (restore) {
                restore.disabled = true;
                restore.textContent = text("Wymaga klucza", "Identity required");
                restore.title = text(
                    "Odtworzenie zaszyfrowanego backupu będzie dostępne po wskazaniu prywatnej identity age.",
                    "Encrypted restore will be available after selecting the private age identity."
                );
            }
        }
    }

    function initialize() {
        const list = document.getElementById("backupList");
        if (!list) return;
        decorate();
        new MutationObserver(decorate).observe(list, { childList: true, subtree: true });
        new MutationObserver(decorate).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
    else initialize();
}());
