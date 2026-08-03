"use strict";

(function () {
    window.__SIRK_CSRF_BOOTSTRAP = Object.freeze({ enabled: true });
    if (typeof window.fetch !== "function") return;

    const originalFetch = window.fetch.bind(window);
    let csrfPromise = null;

    function requestMethod(input, init) {
        return String(
            (init && init.method) ||
            (typeof input !== "string" && input && input.method) ||
            "GET"
        ).toUpperCase();
    }

    function isUnsafe(method) {
        return !["GET", "HEAD", "OPTIONS", "TRACE"].includes(method);
    }

    function isPreSessionWrite(url) {
        if (url.pathname === "/api/login") return true;
        if (url.pathname.startsWith("/api/login/mfa/")) return true;
        if (/^\/api\/v1\/break-glass\/[^/]+\/login$/.test(url.pathname)) return true;
        if (url.pathname.startsWith("/api/v1/break-glass/mfa/")) return true;
        return url.pathname === "/auth/entra/frontchannel-logout";
    }

    async function csrfToken() {
        if (!csrfPromise) {
            csrfPromise = originalFetch("/api/v1/auth/csrf", {
                method: "GET",
                credentials: "same-origin",
                cache: "no-store",
                headers: { Accept: "application/json" }
            }).then(async response => {
                const body = await response.json().catch(() => ({}));
                if (!response.ok || !body.headerName || !body.requestToken) {
                    throw new Error(body.error || "CSRF token could not be issued.");
                }
                return body;
            }).catch(error => {
                csrfPromise = null;
                throw error;
            });
        }
        return csrfPromise;
    }

    window.fetch = async function sirkBootstrapFetch(input, init) {
        let url;
        try {
            url = new URL(
                typeof input === "string" ? input : input.url,
                window.location.href
            );
        } catch (_) {
            return originalFetch(input, init);
        }

        const method = requestMethod(input, init);

        if (
            url.origin === window.location.origin &&
            isUnsafe(method) &&
            !isPreSessionWrite(url)
        ) {
            const token = await csrfToken();
            const options = Object.assign({}, init || {});
            const headers = new Headers(
                options.headers ||
                (typeof input !== "string" && input && input.headers) ||
                undefined
            );
            headers.set(token.headerName, token.requestToken);
            options.headers = headers;
            options.credentials = "same-origin";
            options.cache = "no-store";
            return originalFetch(input, options);
        }

        return originalFetch(input, init);
    };

    function loadProductUi() {
        if (document.querySelector('script[data-sirk-product-ui]')) return;
        const script = document.createElement("script");
        script.src = "/product-ui.js";
        script.defer = true;
        script.dataset.sirkProductUi = "1";
        script.addEventListener("error", function () {
            console.error("SIRK product UI module could not be loaded.");
        });
        document.head.append(script);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", loadProductUi, { once: true });
    } else {
        loadProductUi();
    }
}());
