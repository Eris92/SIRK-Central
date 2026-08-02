"use strict";

(function () {
    // The .NET 10 API uses same-site HttpOnly session cookies and validates
    // request origin server-side. This remains the integration point for a
    // future synchronizer-token endpoint.
    window.__SIRK_CSRF_BOOTSTRAP = Object.freeze({ enabled: true });

    const fragment = new URLSearchParams(
        String(window.location.hash || "").replace(/^#/, "")
    );
    const hasAccess = Boolean(fragment.get("access"));
    if (typeof window.fetch !== "function") return;

    const originalFetch = window.fetch.bind(window);
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

        const method = String(
            (init && init.method) ||
            (typeof input !== "string" && input.method) ||
            "GET"
        ).toUpperCase();

        // Showing the hidden local-login form must not consume the same
        // rate-limit budget as the real POST /api/login attempt. The access
        // code is still validated server-side by the login endpoint.
        if (
            hasAccess &&
            method === "GET" &&
            url.origin === window.location.origin &&
            url.pathname === "/api/access"
        ) {
            return new Response(
                JSON.stringify({ ok: true, localLoginEnabled: true }),
                {
                    status: 200,
                    headers: {
                        "Content-Type": "application/json; charset=utf-8",
                        "Cache-Control": "no-store"
                    }
                }
            );
        }

        const response = await originalFetch(input, init);

        // The current base UI still expects the legacy list endpoint. During
        // a fresh Central deployment its absence means zero connected Portals,
        // not an invalid session. Never mask POST/create/connect failures.
        if (
            method === "GET" &&
            url.origin === window.location.origin &&
            url.pathname === "/api/portals" &&
            response.status === 404
        ) {
            return new Response(JSON.stringify({ portals: [] }), {
                status: 200,
                headers: {
                    "Content-Type": "application/json; charset=utf-8",
                    "Cache-Control": "no-store"
                }
            });
        }

        return response;
    };
}());