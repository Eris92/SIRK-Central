"use strict";

(function () {
    const parameters = new URLSearchParams(String(location.hash || "").replace(/^#/, ""));

    // app.js reads #access synchronously during script initialization. Do not
    // remove the fragment before the remaining scripts have had a chance to
    // consume it. Scheduling the cleanup for the next task preserves the
    // in-memory token while still removing it from the visible URL/history.
    if (parameters.has("access")) {
        setTimeout(() => {
            history.replaceState(null, "", location.pathname + location.search);
        }, 0);
    }

    function accessRejectedMessage() {
        const english = document.documentElement.lang === "en";
        return english
            ? "The Break-Glass access link is invalid or has expired. Close this tab and open the complete current Access URL again."
            : "Link dostępu Break-Glass jest nieprawidłowy albo wygasł. Zamknij tę kartę i ponownie otwórz pełny, aktualny Access URL.";
    }

    function showAccessRejected() {
        const error = document.getElementById("loginError");
        if (!error) return;
        error.textContent = accessRejectedMessage();
        error.className = "error";
        error.setAttribute("role", "alert");
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
        return originalFetch(input, options).then(response => {
            if (url.origin === location.origin && url.pathname === "/api/login" && response.status === 404) {
                setTimeout(showAccessRejected, 0);
            }
            return response;
        });
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
