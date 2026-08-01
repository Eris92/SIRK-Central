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
            const fileName = name.textContent;
            const details = row.querySelector("small");
            if (details) details.textContent += " · " + text("Szyfrowanie: age", "Encryption: age");

            const download = document.createElement("a");
            download.className = "button secondary";
            download.textContent = text("Pobierz", "Download");
            download.href = "/api/settings/backup/download/" + encodeURIComponent(fileName);
            download.download = fileName;
            download.rel = "nofollow";

            const restore = row.querySelector("button.danger");
            if (restore) {
                restore.disabled = true;
                restore.textContent = text("Wymaga klucza", "Identity required");
                restore.title = text(
                    "Odtworzenie zaszyfrowanego backupu będzie dostępne po wskazaniu prywatnej identity age.",
                    "Encrypted restore will be available after selecting the private age identity."
                );
                row.insertBefore(download, restore);
            } else row.append(download);
        }
    }

    function initialize() {
        const list = document.getElementById("backupList");
        if (!list) return;
        decorate();
        new MutationObserver(decorate).observe(list, { childList: true, subtree: true });
        new MutationObserver(() => {
            for (const row of list.querySelectorAll('[data-encrypted-backup="true"]')) row.dataset.encryptedBackup = "";
            decorate();
        }).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
    else initialize();
}());
