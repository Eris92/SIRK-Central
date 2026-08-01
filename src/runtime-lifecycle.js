"use strict";

function attachRuntimeLifecycle(app) {
    if (!app || !app.server) throw new TypeError("Runtime application with an HTTP server is required.");
    let closePromise = null;

    app.close = function closeRuntime() {
        if (closePromise) return closePromise;
        closePromise = new Promise((resolve, reject) => {
            if (app.broker && typeof app.broker.close === "function") app.broker.close();
            if (!app.server.listening) return resolve();
            app.server.close(error => error ? reject(error) : resolve());
            if (typeof app.server.closeIdleConnections === "function") app.server.closeIdleConnections();
        });
        return closePromise;
    };

    return app;
}

module.exports = { attachRuntimeLifecycle };
