"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
require("../src/workspace-bootstrap");

function identityFor(cookie) {
  if (String(cookie || "").includes("session=bg")) return { ok:true, source:"local", role:"BreakGlass", builtIn:true, permissions:["*"] };
  if (String(cookie || "").includes("session=sec")) return { ok:true, source:"entra", role:"SecAdmin", builtIn:false, permissions:["security.manage"] };
  if (String(cookie || "").includes("session=admin")) return { ok:true, source:"entra", role:"Admin", builtIn:false, permissions:["settings.manage"] };
  return null;
}

function createServer() {
  return http.createServer((req, res) => {
    if (req.url === "/api/session") {
      const identity = identityFor(req.headers.cookie);
      const body = Buffer.from(JSON.stringify(identity || { ok:false }));
      res.writeHead(identity ? 200 : 401, { "Content-Type":"application/json", "Content-Length":body.length });
      res.end(body);
      return;
    }
    if (req.url === "/") {
      const body = Buffer.from("<!doctype html><html><body>Central</body></html>");
      res.writeHead(200, { "Content-Type":"text/html; charset=utf-8", "Content-Length":body.length });
      res.end(body);
      return;
    }
    if (req.url === "/api/break-glass/password") {
      const body = Buffer.from(JSON.stringify({ ok:true }));
      res.writeHead(200, { "Content-Type":"application/json", "Content-Length":body.length });
      res.end(body);
      return;
    }
    res.writeHead(404, { "Content-Length":"0" });
    res.end();
  });
}

function request(server, pathname, cookie, method = "GET") {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({ host:"127.0.0.1", port:address.port, path:pathname, method, headers:cookie ? { cookie } : {} }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status:res.statusCode, body:Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("workspace routes and Break-Glass API are protected server-side", async t => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  const secSecurity = await request(server, "/security", "session=sec");
  assert.equal(secSecurity.status, 200);
  assert.match(secSecurity.body, /workspace-routing\.js/);

  const secBreakGlass = await request(server, "/break-glass", "session=sec");
  assert.equal(secBreakGlass.status, 404);

  const bgSecurity = await request(server, "/security", "session=bg");
  assert.equal(bgSecurity.status, 200);

  const bgBreakGlass = await request(server, "/break-glass", "session=bg");
  assert.equal(bgBreakGlass.status, 200);

  const blockedApi = await request(server, "/api/break-glass/password", "session=sec", "POST");
  assert.equal(blockedApi.status, 404);

  const allowedApi = await request(server, "/api/break-glass/password", "session=bg", "POST");
  assert.equal(allowedApi.status, 200);

  const bgSession = await request(server, "/api/session", "session=bg");
  const payload = JSON.parse(bgSession.body);
  assert.deepEqual(payload.workspaces, ["portals", "admin", "security", "settings", "break-glass"]);
});
