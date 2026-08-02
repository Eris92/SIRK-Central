"use strict";

(function () {
    // The current .NET 10 API uses same-site HttpOnly session cookies and
    // validates the request origin server-side. Keep this file as the single
    // integration point for a future synchronizer-token endpoint.
    window.__SIRK_CSRF_BOOTSTRAP = Object.freeze({ enabled: true });

    const fragment = new URLSearchParams(
        String(window.location.hash || "").replace(/^#/, "")
    );
    const hasAccess = Boolean(fragment.get("access"));
    if (!hasAccess || typeof window.fetch !== "function") return;

    // /api/access only controls whether the hidden local-login form is shown.
    // It must not consume the same rate-limit budget as POST /api/login.
    // The access code is still validated server-side by the actual login call.
    const originalFetch = window.fetch.bind(window);
    window.fetch = function sirkBootstrapFetch(input, init) {
        let url;
        try {
            url = new URL(
                typeof input === "string" ? input : input.url,
                window.location.href
            );
        } catch (_) {
            return originalFetch(input, init);
        }

        const method = String(
            (init && init.method) ||
            (typeof input !== "string" && input.method) ||
            "GET"
        ).toUpperCase();

        if (
            method === "GET" &&
            url.origin === window.location.origin &&
            url.pathname === "/api/access"
        ) {
            return Promise.resolve(new Response(
                JSON.stringify({ ok: true, localLoginEnabled: true }),
                {
                    status: 200,
                    headers: {
                        "Content-Type": "application/json; charset=utf-8",
                        "Cache-Control": "no-store"
                    }
                }
            ));
        }

        return originalFetch(input, init);
    };
}());
