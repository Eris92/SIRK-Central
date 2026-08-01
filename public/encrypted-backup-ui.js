"use strict";

(function () {
    let restoreAllowed = false;

    function language() { return document.documentElement.lang === "en" ? "en" : "pl"; }
    function text(pl, en) { return language() === "en" ? en : pl; }

    async function restoreEncrypted(fileName) {
        const first = confirm(text(
            "Odtworzenie zastąpi bieżące dane Central, wyloguje użytkowników i utworzy zaszyfrowany safety backup. Kontynuować?",
            "Restore will replace current Central data, sign users out and create an encrypted safety backup. Continue?"
        ));
        if (!first) return;
        const phrase = prompt(text(
            "Aby potwierdzić, wpisz dokładnie: RESTORE SIRK CENTRAL",
            "To confirm, type exactly: RESTORE SIRK CENTRAL"
        ), "");
        if (phrase !== "RESTORE SIRK CENTRAL") throw new Error(text("Nieprawidłowa fraza potwierdzająca.", "Invalid confirmation phrase."));

        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".agekey,text/plain";
        input.hidden = true;
        document.body.append(input);
        try {
            const file = await new Promise(resolve => {
                input.addEventListener("change", () => resolve(input.files && input.files[0] || null), { once: true });
                input.click();
            });
            if (!file) return;
            if (file.size < 1 || file.size > 16384) throw new Error(text("Plik identity ma nieprawidłowy rozmiar.", "The identity file has an invalid size."));
            let identity = await file.text();
            if (!/^AGE-SECRET-KEY-1[0-9A-Z]+$/m.test(identity)) throw new Error(text("Plik nie zawiera prawidłowej identity age.", "The file does not contain a valid age identity."));
            const response = await fetch("/api/settings/backup/restore-encrypted", {
                method: "POST",
                credentials: "same-origin",
                cache: "no-store",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: fileName, identity, confirm: phrase })
            });
            identity = "";
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.error || text("Odtworzenie zostało odrzucone.", "Restore was rejected."));
            alert(text(
                "Odtworzenie zostało uruchomione. Stan operacji sprawdzisz w zakładce System.",
                "Restore has started. Check its state in the System tab."
            ));
        } finally {
            input.value = "";
            input.remove();
        }
    }

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
                restore.disabled = !restoreAllowed;
                restore.textContent = restoreAllowed ? text("Odtwórz", "Restore") : text("Brak uprawnień", "Not allowed");
                restore.title = restoreAllowed ? text(
                    "Wskaż prywatny plik identity age pasujący do backupu.",
                    "Select the private age identity matching this backup."
                ) : text("Restore wymaga roli Admin lub Break-Glass.", "Restore requires Admin or Break-Glass.");
                if (restoreAllowed) restore.addEventListener("click", event => {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    restoreEncrypted(fileName).catch(error => alert(error.message));
                }, { capture: true });
                row.insertBefore(download, restore);
            } else row.append(download);
        }
    }

    async function initialize() {
        const list = document.getElementById("backupList");
        if (!list) return;
        try {
            const response = await fetch("/api/session", { credentials: "same-origin", cache: "no-store" });
            const identity = await response.json();
            restoreAllowed = Boolean(identity && (identity.builtIn === true || identity.role === "Admin"));
        } catch (_) { restoreAllowed = false; }
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
