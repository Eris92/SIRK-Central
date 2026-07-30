"use strict";

(function () {
    function isEnglish() {
        return document.documentElement.lang === "en";
    }

    function text(pl, en) {
        return isEnglish() ? en : pl;
    }

    function apply() {
        const form = document.getElementById("mfaRecoveryForm");
        if (!form) return;

        const methodActions = form.querySelector(".mfa-method-actions");
        const heading = methodActions ? methodActions.previousElementSibling && methodActions.previousElementSibling.previousElementSibling : null;
        const description = methodActions ? methodActions.previousElementSibling : null;
        const passkeyButton = methodActions ? methodActions.querySelector("button:not(.secondary)") : null;
        const recoveryButton = methodActions ? methodActions.querySelector("button.secondary") : null;
        const cancelButton = document.getElementById("cancelMfaButton");
        const actions = form.querySelector(".mfa-actions");
        const backButton = actions ? Array.from(actions.querySelectorAll("button.secondary")).find(button => button !== cancelButton) : null;
        const recoveryPrompt = form.querySelector("p:not(.muted)");

        if (heading) heading.textContent = text("Wybierz metodę weryfikacji", "Choose a verification method");
        if (description) description.textContent = text(
            "Zaloguj się kluczem bezpieczeństwa albo użyj jednorazowego kodu odzyskiwania.",
            "Sign in with a security key or use a one-time recovery code."
        );
        if (passkeyButton) passkeyButton.textContent = text("Użyj klucza bezpieczeństwa", "Use security key");
        if (recoveryButton) recoveryButton.textContent = text("Użyj kodu odzyskiwania", "Use recovery code");
        if (backButton) backButton.textContent = text("Wróć do wyboru metody", "Back to method selection");
        if (cancelButton) {
            cancelButton.textContent = text("Anuluj", "Cancel");
            cancelButton.style.marginTop = "12px";
        }

        if (recoveryPrompt && !recoveryPrompt.hidden) {
            recoveryPrompt.textContent = text(
                "Kod odzyskiwania jest awaryjną, jednorazową metodą logowania Break-Glass.",
                "A recovery code is an emergency, one-time Break-Glass sign-in method."
            );
        }
    }

    function initialize() {
        apply();
        new MutationObserver(apply).observe(document.documentElement, {
            attributes: true,
            attributeFilter: ["lang"]
        });
        new MutationObserver(apply).observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
    else initialize();
}());
