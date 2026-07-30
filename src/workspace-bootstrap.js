"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const originalCreateServer = http.createServer;
const SCRIPT_PATH = path.join(__dirname, "..", "public", "workspace-routing.js");

function workspacesFor(identity) {
  if (!identity || !identity.ok) return [];
  if (identity.builtIn === true && identity.source === "local" && identity.role === "BreakGlass") {
    return ["portals", "admin", "security", "settings", "break-glass"];
  }

  const result = ["portals"];
  if (identity.role === "Admin") result.push("admin", "settings");
  if (identity.role === "SecAdmin") result.push("security", "settings");
  return result;
}

function workspaceForPath(pathname) {
  return ({
    "/": "portals",
    "/admin": "admin",
    "/security": "security",
    "/settings": "settings",
    "/break-glass": "break-glass"
  })[pathname] || null;
}

function cloneRequest(req, url) {
  const clone = Object.create(req);
  Object.defineProperty(clone, "url", { value: url, writable: true, configurable: true });
  Object.defineProperty(clone, "method", { value: "GET", writable: true, configurable: true });
  return clone;
}

async function capture(listener, req) {
  let statusCode = 200;
  let headers = {};
  const chunks = [];
  const response = {
    statusCode: 200,
    headersSent: false,
    setHeader(name, value) { headers[String(name).toLowerCase()] = value; },
    getHeader(name) { return headers[String(name).toLowerCase()]; },
    removeHeader(name) { delete headers[String(name).toLowerCase()]; },
    writeHead(status, reasonOrHeaders, possibleHeaders) {
      statusCode = Number(status) || 200;
      this.statusCode = statusCode;
      const supplied = typeof reasonOrHeaders === "object" ? reasonOrHeaders : possibleHeaders;
      if (supplied) for (const [name, value] of Object.entries(supplied)) headers[String(name).toLowerCase()] = value;
      this.headersSent = true;
      return this;
    },
    write(chunk) { if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); return true; },
    end(chunk) { if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); this.finished = true; },
    on() { return this; },
    once() { return this; },
    emit() { return false; }
  };
  await Promise.resolve(listener(req, response));
  return { statusCode, headers, body: Buffer.concat(chunks) };
}

function send(res, captured, bodyOverride) {
  const body = bodyOverride === undefined ? captured.body : Buffer.from(bodyOverride);
  const headers = Object.assign({}, captured.headers, { "content-length": String(body.length) });
  res.writeHead(captured.statusCode, headers);
  res.end(body);
}

async function readIdentity(listener, req) {
  const result = await capture(listener, cloneRequest(req, "/api/session"));
  if (result.statusCode !== 200) return null;
  try { return JSON.parse(result.body.toString("utf8")); } catch (_) { return null; }
}

function isExactBreakGlass(identity) {
  return Boolean(identity && identity.builtIn === true && identity.source === "local" && identity.role === "BreakGlass");
}

http.createServer = function patchedCreateServer(listener) {
  if (typeof listener !== "function") return originalCreateServer.apply(this, arguments);

  return originalCreateServer.call(this, async function workspaceGuard(req, res) {
    try {
      const url = new URL(req.url, "http://central.local");

      if (req.method === "GET" && url.pathname === "/workspace-routing.js") {
        const body = fs.readFileSync(SCRIPT_PATH);
        res.writeHead(200, {
          "Content-Type": "text/javascript; charset=utf-8",
          "Content-Length": body.length,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff"
        });
        res.end(body);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/session") {
        const captured = await capture(listener, req);
        if (captured.statusCode === 200) {
          try {
            const identity = JSON.parse(captured.body.toString("utf8"));
            identity.workspaces = workspacesFor(identity);
            send(res, captured, JSON.stringify(identity));
            return;
          } catch (_) {}
        }
        send(res, captured);
        return;
      }

      if (url.pathname.startsWith("/api/break-glass/")) {
        const identity = await readIdentity(listener, req);
        if (!isExactBreakGlass(identity)) {
          const body = Buffer.from(JSON.stringify({ ok: false, error: "Not found." }));
          res.writeHead(404, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length, "Cache-Control": "no-store" });
          res.end(body);
          return;
        }
      }

      const workspace = req.method === "GET" ? workspaceForPath(url.pathname) : null;
      if (workspace && workspace !== "portals") {
        const identity = await readIdentity(listener, req);
        if (!identity) {
          res.writeHead(302, { Location: "/", "Cache-Control": "no-store", "Content-Length": "0" });
          res.end();
          return;
        }
        const allowed = workspacesFor(identity).includes(workspace);
        if (!allowed) {
          const hidden = workspace === "break-glass";
          const body = Buffer.from(JSON.stringify({ ok: false, error: hidden ? "Not found." : "Workspace access denied." }));
          res.writeHead(hidden ? 404 : 403, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length, "Cache-Control": "no-store" });
          res.end(body);
          return;
        }
        const captured = await capture(listener, cloneRequest(req, "/" + url.search));
        send(res, captured);
        return;
      }

      await Promise.resolve(listener(req, res));
    } catch (error) {
      if (!res.headersSent) {
        const body = Buffer.from(JSON.stringify({ ok: false, error: "Workspace authorization failed." }));
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length, "Cache-Control": "no-store" });
        res.end(body);
      } else {
        res.destroy(error);
      }
    }
  });
};
