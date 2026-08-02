"use strict";

(function () {
    // The current .NET 10 API uses same-site HttpOnly session cookies and
    // validates the request origin server-side. Keep this bootstrap file as
    // the single integration point for a future synchronizer-token endpoint.
    window.__SIRK_CSRF_BOOTSTRAP = Object.freeze({ enabled: true });
}());
