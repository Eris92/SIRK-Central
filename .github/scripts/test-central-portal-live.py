#!/usr/bin/env python3

from __future__ import annotations

import http.cookiejar
import json
import os
import signal
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

CENTRAL_ORIGIN = "https://central-e2e.local:19443"
PORTAL_ORIGIN = "http://127.0.0.1:18082"
CENTRAL_USER = "breakglass"
CENTRAL_PASSWORD = "Central-E2E-BreakGlass-2026!"
CENTRAL_ACCESS = "central-e2e-access-code-0123456789ABCDEF"
PORTAL_PASSWORD = "Portal-E2E-BreakGlass-2026!"
PORTAL_ACCESS = "portal-e2e-access-code-0123456789ABCDEF"
PORTAL_ID = "portal-e2e"


class JsonClient:
    def __init__(self, origin: str, ssl_context: ssl.SSLContext | None = None) -> None:
        self.origin = origin.rstrip("/")
        self.cookies = http.cookiejar.CookieJar()
        handlers: list[Any] = [urllib.request.HTTPCookieProcessor(self.cookies)]
        if ssl_context is not None:
            handlers.append(urllib.request.HTTPSHandler(context=ssl_context))
        self.opener = urllib.request.build_opener(*handlers)
        self.csrf_header = ""
        self.csrf_token = ""

    def request(
        self,
        method: str,
        path: str,
        payload: Any | None = None,
        headers: dict[str, str] | None = None,
        expected: int = 200,
        timeout: int = 45,
    ) -> tuple[bytes, dict[str, str]]:
        data = None
        request_headers = {"Accept": "application/json"}
        if payload is not None:
            data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
            request_headers["Content-Type"] = "application/json"
        if method in {"POST", "PUT", "PATCH", "DELETE"} and self.csrf_header:
            request_headers[self.csrf_header] = self.csrf_token
        request_headers.update(headers or {})
        request = urllib.request.Request(
            self.origin + path,
            data=data,
            headers=request_headers,
            method=method,
        )
        try:
            with self.opener.open(request, timeout=timeout) as response:
                status = response.status
                raw = response.read()
                response_headers = {key.lower(): value for key, value in response.headers.items()}
        except urllib.error.HTTPError as error:
            status = error.code
            raw = error.read()
            response_headers = {key.lower(): value for key, value in error.headers.items()}
        if status != expected:
            raise RuntimeError(
                f"{method} {self.origin}{path}: expected HTTP {expected}, got {status}: "
                + raw.decode("utf-8", errors="replace")
            )
        return raw, response_headers

    def json(
        self,
        method: str,
        path: str,
        payload: Any | None = None,
        headers: dict[str, str] | None = None,
        expected: int = 200,
        timeout: int = 45,
    ) -> dict[str, Any]:
        raw, _ = self.request(method, path, payload, headers, expected, timeout)
        return json.loads(raw.decode("utf-8")) if raw else {}

    def csrf(self) -> None:
        value = self.json("GET", "/api/v1/auth/csrf")
        self.csrf_header = value.get("headerName", "X-SIRK-CSRF")
        self.csrf_token = value["requestToken"]


def wait_ready(client: JsonClient, product: str, timeout_seconds: int = 60) -> None:
    deadline = time.monotonic() + timeout_seconds
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            value = client.json("GET", "/readyz", timeout=5)
            if value.get("status") == "ready":
                return
        except Exception as error:  # noqa: BLE001 - bounded startup retry
            last_error = error
        time.sleep(0.25)
    raise RuntimeError(f"{product} did not become ready: {last_error}")


def stop_process(process: subprocess.Popen[str], log_path: Path) -> None:
    if process.poll() is None:
        process.send_signal(signal.SIGTERM)
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
    if process.returncode not in (0, -signal.SIGTERM):
        output = log_path.read_text(encoding="utf-8", errors="replace") if log_path.exists() else ""
        raise RuntimeError(f"Process exited with {process.returncode}:\n{output}")


def start_process(
    executable: Path,
    environment: dict[str, str],
    log_path: Path,
) -> subprocess.Popen[str]:
    log_file = log_path.open("w", encoding="utf-8")
    process = subprocess.Popen(
        ["dotnet", str(executable)],
        cwd=executable.parent,
        env=environment,
        stdout=log_file,
        stderr=subprocess.STDOUT,
        text=True,
    )
    log_file.close()
    return process


def login_central(client: JsonClient) -> None:
    authorization = {"Authorization": "Bearer " + CENTRAL_ACCESS}
    access = client.json("GET", "/api/access", headers=authorization)
    if access.get("localLoginEnabled") is not True:
        raise RuntimeError("Central Access URL did not enable Break-Glass login.")
    login = client.json(
        "POST",
        "/api/login",
        {"userName": CENTRAL_USER, "password": CENTRAL_PASSWORD},
        headers=authorization,
    )
    if login.get("role") != "BreakGlass":
        raise RuntimeError("Central Break-Glass login returned an invalid role.")
    client.csrf()


def login_portal(client: JsonClient) -> None:
    authorization = {"Authorization": "Bearer " + PORTAL_ACCESS}
    login = client.json(
        "POST",
        "/api/v1/auth/login",
        {
            "userName": "admin",
            "password": PORTAL_PASSWORD,
            "accessCode": PORTAL_ACCESS,
        },
        headers=authorization,
    )
    if login.get("user", {}).get("role") != "Break-Glass":
        raise RuntimeError("Portal Break-Glass login returned an invalid role.")
    client.csrf()


def create_connection_file(central: JsonClient) -> dict[str, Any]:
    created = central.json(
        "POST",
        "/api/v1/admin/portals/",
        {"id": PORTAL_ID, "name": "Portal E2E"},
        expected=201,
    )
    if created.get("portal", {}).get("id") != PORTAL_ID:
        raise RuntimeError("Central did not create the expected Portal.")

    raw, headers = central.request(
        "POST",
        f"/api/v1/admin/portals/{urllib.parse.quote(PORTAL_ID)}/connection-file",
        {},
    )
    if headers.get("x-sirk-credential-rotated") != "true":
        raise RuntimeError("Central did not mark the connection credential as rotated.")
    document = json.loads(raw.decode("utf-8"))
    expected = {
        "schemaVersion",
        "centralUrl",
        "tunnelUrl",
        "portalId",
        "portalName",
        "portalToken",
        "publicUrl",
        "updatedAtUtc",
    }
    if set(document) != expected:
        raise RuntimeError(f"Central connection file fields are invalid: {sorted(document)}")
    if document["centralUrl"] != CENTRAL_ORIGIN:
        raise RuntimeError("Central connection file contains the wrong HTTPS origin.")
    if document["tunnelUrl"] != "wss://central-e2e.local:19443/tunnel":
        raise RuntimeError("Central connection file contains the wrong tunnel URL.")
    if document["portalId"] != PORTAL_ID or len(document["portalToken"]) < 32:
        raise RuntimeError("Central connection file credential is invalid.")
    return document


def wait_connected(central: JsonClient, timeout_seconds: int = 60) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_seconds
    last: dict[str, Any] = {}
    while time.monotonic() < deadline:
        last = central.json("GET", f"/api/v1/admin/portals/{PORTAL_ID}")
        portal = last.get("portal", {})
        if portal.get("connected") is True:
            return portal
        time.sleep(0.5)
    raise RuntimeError(f"Central did not receive the Portal heartbeat: {last}")


def dump_log(label: str, path: Path) -> None:
    if not path.exists():
        return
    print(f"--- {label}: {path} ---", file=sys.stderr)
    print(path.read_text(encoding="utf-8", errors="replace")[-30000:], file=sys.stderr)


def main() -> int:
    central_dll = Path(os.environ["SIRK_E2E_CENTRAL_DLL"]).resolve()
    portal_dll = Path(os.environ["SIRK_E2E_PORTAL_DLL"]).resolve()
    central_pfx = Path(os.environ["SIRK_E2E_CENTRAL_PFX"]).resolve()
    central_pfx_password = os.environ["SIRK_E2E_CENTRAL_PFX_PASSWORD"]
    ca_file = Path(os.environ["SIRK_E2E_CA_FILE"]).resolve()
    for required in (central_dll, portal_dll, central_pfx, ca_file):
        if not required.is_file():
            raise RuntimeError(f"Required E2E file is missing: {required}")

    ssl_context = ssl.create_default_context(cafile=str(ca_file))
    central_client = JsonClient(CENTRAL_ORIGIN, ssl_context)
    portal_client = JsonClient(PORTAL_ORIGIN)

    with tempfile.TemporaryDirectory(prefix="sirk-cross-product-") as temporary:
        root = Path(temporary)
        central_root = root / "central"
        portal_root = root / "portal"
        central_security = central_root / "security"
        central_portals = central_root / "portals"
        connection_path = portal_root / "security" / "central-connection.json"
        for directory in (central_security, central_portals, portal_root):
            directory.mkdir(parents=True, mode=0o700, exist_ok=True)

        bootstrap = central_root / "break-glass-bootstrap.json"
        bootstrap.write_text(
            json.dumps(
                {
                    "userName": CENTRAL_USER,
                    "password": CENTRAL_PASSWORD,
                    "accessCode": CENTRAL_ACCESS,
                },
                separators=(",", ":"),
            ),
            encoding="utf-8",
        )
        bootstrap.chmod(0o600)

        central_env = os.environ.copy()
        central_env.update(
            {
                "ASPNETCORE_ENVIRONMENT": "Development",
                "ASPNETCORE_URLS": "https://0.0.0.0:19443",
                "AllowedHosts": "central-e2e.local;localhost;127.0.0.1",
                "Kestrel__Certificates__Default__Path": str(central_pfx),
                "Kestrel__Certificates__Default__Password": central_pfx_password,
                "Sirk__PortalProtocol__DataRoot": str(central_portals),
                "Sirk__PortalProtocol__HeartbeatIntervalSeconds": "30",
                "Sirk__PortalProtocol__OfflineAfterSeconds": "90",
                "Sirk__Security__Enabled": "true",
                "Sirk__Security__DataRoot": str(central_security),
                "Sirk__Security__BootstrapSecretFile": str(bootstrap),
                "Sirk__Security__PasswordHashIterations": "100000",
                "Sirk__Security__SessionMinutes": "30",
                "Sirk__Security__LoginAttemptsPerFiveMinutes": "10",
                "Sirk__Security__RequireProtectedDataProtectionKeys": "false",
                "Sirk__Security__RequireSignedReleases": "false",
                "Sirk__Security__RequireSingleWriterLease": "false",
                "Sirk__WebAuthn__ServerDomain": "central-e2e.local",
                "Sirk__WebAuthn__Origins__0": CENTRAL_ORIGIN,
            }
        )

        portal_env = os.environ.copy()
        portal_env.update(
            {
                "ASPNETCORE_ENVIRONMENT": "Development",
                "ASPNETCORE_URLS": PORTAL_ORIGIN,
                "Sirk__DataRoot": str(portal_root),
                "Sirk__Central__ConnectionFile": str(connection_path),
                "Sirk__Central__HeartbeatIntervalSeconds": "30",
                "Sirk__Central__RequestTimeoutSeconds": "10",
                "Sirk__CentralTunnel__Enabled": "true",
                "Sirk__CentralTunnel__LocalOrigin": PORTAL_ORIGIN + "/",
                "Sirk__CentralTunnel__PollIntervalMilliseconds": "250",
                "SIRK_BOOTSTRAP_PASSWORD": PORTAL_PASSWORD,
                "SIRK_BOOTSTRAP_ACCESS_CODE": PORTAL_ACCESS,
            }
        )

        central_log = root / "central.log"
        portal_log = root / "portal.log"
        central_process = start_process(central_dll, central_env, central_log)
        portal_process: subprocess.Popen[str] | None = None
        try:
            wait_ready(central_client, "Central")
            if bootstrap.exists():
                raise RuntimeError("Central one-time bootstrap file was not removed.")
            login_central(central_client)
            connection = create_connection_file(central_client)

            portal_process = start_process(portal_dll, portal_env, portal_log)
            wait_ready(portal_client, "Portal")
            login_portal(portal_client)
            saved = portal_client.json("PUT", "/api/v1/admin/central", connection)
            if saved.get("value", {}).get("configured") is not True:
                raise RuntimeError("Portal did not import the Central connection document.")
            if saved.get("value", {}).get("restartRequired") is not True:
                raise RuntimeError("Portal did not require restart after Central import.")

            redacted = portal_client.json("GET", "/api/v1/admin/central")
            if connection["portalToken"] in json.dumps(redacted, separators=(",", ":")):
                raise RuntimeError("Portal administration API exposed the Central token.")

            stop_process(portal_process, portal_log)
            portal_process = None

            if not connection_path.is_file():
                raise RuntimeError("Portal protected Central connection file was not created.")
            if connection_path.stat().st_mode & 0o077:
                raise RuntimeError("Portal Central connection file has weak permissions.")

            portal_process = start_process(portal_dll, portal_env, portal_log)
            portal_client = JsonClient(PORTAL_ORIGIN)
            wait_ready(portal_client, "Portal after Central import")
            login_portal(portal_client)

            heartbeat = wait_connected(central_client)
            capabilities = heartbeat.get("heartbeat", {}).get("capabilities", [])
            if "signed-heartbeat" not in capabilities or "central-tunnel-v1" not in capabilities:
                raise RuntimeError(f"Portal heartbeat capabilities are incomplete: {capabilities}")

            connected = central_client.json(
                "POST",
                f"/api/v1/portals/{PORTAL_ID}/connect",
                {},
                timeout=45,
            )
            if connected.get("ok") is not True:
                raise RuntimeError("Central reverse-tunnel connect failed.")

            proxied = central_client.json(
                "GET",
                f"/connect/{PORTAL_ID}/api/v1/system/info",
                timeout=45,
            )
            if proxied.get("product") != "SIRK Portal" or proxied.get("runtime") != ".NET 10":
                raise RuntimeError(f"Central reverse tunnel returned an invalid Portal response: {proxied}")
            if proxied.get("central", {}).get("connected") is not True:
                raise RuntimeError("Proxied Portal system state is not connected to Central.")

            print("SIRK Central -> Portal live connection, heartbeat and reverse tunnel: OK")
            return 0
        except Exception:
            dump_log("Central", central_log)
            dump_log("Portal", portal_log)
            raise
        finally:
            if portal_process is not None:
                stop_process(portal_process, portal_log)
            stop_process(central_process, central_log)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # noqa: BLE001 - CI entry point
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
