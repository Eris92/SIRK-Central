"use strict";

(function () {
    function clean() {
        const list = document.querySelector("[data-passkey-list]");
        if (!list) return;
        for (const row of Array.from(list.children)) {
            const details = row.querySelector("small");
            if (details && /^revoked\b/i.test(details.textContent.trim())) row.remove();
        }
    }
    function initialize() {
        const list = document.querySelector("[data-passkey-list]");
        if (!list) return;
        clean();
        new MutationObserver(clean).observe(list, { childList: true, subtree: true, characterData: true });
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
    else initialize();
}());
