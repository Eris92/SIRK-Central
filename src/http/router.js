"use strict";

function create(fallback) {
    const middleware = [];
    const handlers = [];
    if (typeof fallback === "function") handlers.push(fallback);

    function before(handler) {
        if (typeof handler !== "function") throw new TypeError("HTTP middleware must be a function.");
        middleware.push(handler);
        return handler;
    }
    function prepend(handler) {
        if (typeof handler !== "function") throw new TypeError("HTTP handler must be a function.");
        handlers.unshift(handler);
        return handler;
    }
    function append(handler) {
        if (typeof handler !== "function") throw new TypeError("HTTP handler must be a function.");
        handlers.push(handler);
        return handler;
    }
    async function dispatch(req, res) {
        for (const handler of middleware) {
            const handled = await handler(req, res);
            if (handled === true || res.writableEnded || res.destroyed) return;
        }
        for (const handler of handlers) {
            const handled = await handler(req, res);
            if (handled === true || res.writableEnded || res.destroyed) return;
        }
        if (!res.headersSent) {
            const data = Buffer.from(JSON.stringify({ ok: false, error: "Not found." }));
            res.writeHead(404, {
                "Content-Type": "application/json; charset=utf-8",
                "Content-Length": String(data.length),
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff"
            });
            res.end(data);
        }
    }
    return { before, prepend, append, dispatch, middleware, handlers };
}

module.exports = { create };
