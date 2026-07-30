"use strict";

(function () {
    function addLink() {
        const bootstrap = window.__SIRK_WORKSPACE_BOOTSTRAP || {};
        const allowed = new Set(Array.isArray(bootstrap.workspaces) ? bootstrap.workspaces : []);
        if (!allowed.has("update")) return;
        if (document.getElementById("systemUpdateButton")) return;
        const actions = document.querySelector(".header-actions");
        if (!actions) return;
        const button = document.createElement("button");
        button.id = "systemUpdateButton";
        button.type = "button";
        button.className = "secondary-button";
        button.textContent = "Aktualizacja";
        button.addEventListener("click", function () { window.location.assign("/update"); });
        actions.appendChild(button);
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", addLink, { once: true });
    else addLink();

    const observer = new MutationObserver(addLink);
    observer.observe(document.documentElement, { childList: true, subtree: true });
}());
