"use strict";

const { randomToken } = require("./security");

function create(options) {
    const requestTimeoutMs = Number(options && options.requestTimeoutMs) || 30000;
    const connections = new Map();
    const pending = new Map();

    function attach(portal, socket) {
        const previous = connections.get(portal.id);
        if (previous && previous.socket !== socket) previous.socket.close(4001, "Replaced by a newer portal connection.");
        const state = {
            portal,
            socket,
            connectedAtUtc: new Date().toISOString(),
            lastSeenAtUtc: new Date().toISOString()
        };
        connections.set(portal.id, state);
        socket.on("pong", () => { state.lastSeenAtUtc = new Date().toISOString(); });
        socket.on("message", (raw) => {
            let message;
            try { message = JSON.parse(String(raw)); } catch (_) { return; }
            if (message.type !== "response" || typeof message.requestId !== "string") return;
            const waiter = pending.get(message.requestId);
            if (!waiter || waiter.portalId !== portal.id) return;
            clearTimeout(waiter.timer);
            pending.delete(message.requestId);
            waiter.resolve(message);
        });
        socket.on("close", () => {
            if (connections.get(portal.id) === state) connections.delete(portal.id);
            for (const [id, waiter] of pending) {
                if (waiter.portalId !== portal.id) continue;
                clearTimeout(waiter.timer);
                pending.delete(id);
                waiter.reject(new Error("Portal connection closed."));
            }
        });
        return state;
    }

    function list(portals) {
        return portals.map((portal) => {
            const state = connections.get(portal.id);
            return Object.assign({}, portal, state ? {
                status: "online",
                connectedAtUtc: state.connectedAtUtc,
                lastSeenAtUtc: state.lastSeenAtUtc
            } : { status: "offline", connectedAtUtc: null, lastSeenAtUtc: null });
        });
    }

    function request(portalId, request) {
        const state = connections.get(portalId);
        if (!state || state.socket.readyState !== 1) {
            return Promise.reject(new Error("Portal is offline."));
        }
        const requestId = randomToken(18);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(requestId);
                reject(new Error("Portal request timed out."));
            }, requestTimeoutMs);
            pending.set(requestId, { portalId, resolve, reject, timer });
            state.socket.send(JSON.stringify(Object.assign({ type: "request", requestId }, request)), (error) => {
                if (!error) return;
                clearTimeout(timer);
                pending.delete(requestId);
                reject(error);
            });
        });
    }

    const heartbeat = setInterval(() => {
        for (const state of connections.values()) {
            if (state.socket.readyState === 1) state.socket.ping();
        }
    }, 20000);
    if (heartbeat.unref) heartbeat.unref();

    return { attach, list, request };
}

module.exports = { create };

