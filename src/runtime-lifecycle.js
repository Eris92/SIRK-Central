"use strict";

function attachRuntimeLifecycle(app) {
    if (!app || !app.server) throw new TypeError("Runtime application with an HTTP server is required.");
    let connectionsClosed = false;
    let closePromise = null;
    const closeHttpServer = app.server.close.bind(app.server);

    function closeConnections() {
        if (connectionsClosed) return;
        connectionsClosed = true;
        if (app.broker && typeof app.broker.close === "function") app.broker.close();
        if (typeof app.server.closeIdleConnections === "function") app.server.closeIdleConnections();
    }

    app.server.close = function closeServer(callback) {
        closeConnections();
        return closeHttpServer(callback);
    };

    app.close = function closeRuntime() {
        if (closePromise) return closePromise;
        closePromise = new Promise((resolve, reject) => {
            closeConnections();
            if (!app.server.listening) return resolve();
            closeHttpServer(error => error ? reject(error) : resolve());
        });
        return closePromise;
    };

    return app;
}

module.exports = { attachRuntimeLifecycle };
