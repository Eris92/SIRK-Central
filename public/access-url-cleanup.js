"use strict";

(function () {
    const parameters = new URLSearchParams(String(location.hash || "").replace(/^#/, ""));
    if (parameters.has("access")) {
        history.replaceState(null, "", location.pathname + location.search);
    }

    const originalFetch = window.fetch.bind(window);
    const accessBootstrapRoutes = new Set(["/api/access", "/api/login"]);
    window.fetch = function restrictedAccessFetch(input, init) {
        const options = Object.assign({}, init || {});
        let url;
        try {
            url = new URL(typeof input === "string" ? input : input.url, location.href);
        } catch (_) {
            return originalFetch(input, options);
        }
        const headers = new Headers(options.headers || (input && input.headers) || undefined);
        const authorization = String(headers.get("Authorization") || "");
        if (url.origin === location.origin && authorization.startsWith("Bearer ") && !accessBootstrapRoutes.has(url.pathname)) {
            headers.delete("Authorization");
        }
        options.headers = headers;
        return originalFetch(input, options);
    };

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
