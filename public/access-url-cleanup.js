"use strict";

(function () {
    const parameters = new URLSearchParams(String(location.hash || "").replace(/^#/, ""));
    if (parameters.has("access")) {
        history.replaceState(null, "", location.pathname + location.search);
    }

    document.addEventListener("submit", event => {
        const form = event.target;
        if (!form || !["loginForm", "mfaRecoveryForm"].includes(form.id)) return;
        setTimeout(() => {
            for (const id of ["password", "mfaRecoveryCode"]) {
                const field = document.getElementById(id);
                if (field) field.value = "";
            }
        }, 0);
    }, true);
}());
