#!/usr/bin/env python3

import http.cookiejar
import json
import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE_URL = "http://127.0.0.1:18082"
USER_NAME = "breakglass"
PASSWORD = "Correct-Horse-Battery-Staple-2026"
ACCESS_CODE = "0123456789abcdef0123456789ABCDEF"


def request_json(opener, method: str, path: str, body=None, headers=None):
    encoded = None if body is None else json.dumps(body, separators=(",", ":")).encode("utf-8")
    request_headers = {"Accept": "application/json"}
    if encoded is not None:
        request_headers["Content-Type"] = "application/json"
    if headers:
        request_headers.update(headers)
    request = urllib.request.Request(
        BASE_URL + path,
        data=encoded,
        headers=request_headers,
        method=method,
    )
    try:
        with opener.open(request, timeout=5) as response:
            raw = response.read()
            return response.status, json.loads(raw.decode("utf-8")) if raw else {}
    except urllib.error.HTTPError as error:
        raw = error.read()
        return error.code, json.loads(raw.decode("utf-8")) if raw else {}


def wait_ready(opener) -> None:
    deadline = time.monotonic() + 30
    last_status = None
    while time.monotonic() < deadline:
        status, _ = request_json(opener, "GET", "/readyz")
        last_status = status
        if status == 200:
            return
        time.sleep(0.25)
    raise RuntimeError(f"Central did not become ready; last HTTP status: {last_status}")


def assert_mode_600(path: Path) -> None:
    mode = path.stat().st_mode & 0o777
    if mode & 0o077:
        raise RuntimeError(f"Protected file has weak mode {oct(mode)}: {path}")


def main() -> int:
    central_dll = Path(os.environ["SIRK_TEST_CENTRAL_DLL"]).resolve()
    root = Path(os.environ["SIRK_TEST_ROOT"]).resolve()
    if not central_dll.is_file():
        raise RuntimeError(f"Central assembly was not found: {central_dll}")

    shutil.rmtree(root, ignore_errors=True)
    security_root = root / "security"
    portal_root = root / "portal"
    root.mkdir(parents=True, exist_ok=True)
    bootstrap_path = root / "break-glass-bootstrap.json"
    bootstrap_path.write_text(
        json.dumps(
            {
                "userName": USER_NAME,
                "password": PASSWORD,
                "accessCode": ACCESS_CODE,
            },
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    bootstrap_path.chmod(0o600)

    environment = os.environ.copy()
    environment.update(
        {
            "ASPNETCORE_ENVIRONMENT": "Development",
            "ASPNETCORE_URLS": BASE_URL,
            "Sirk__PortalProtocol__DataRoot": str(portal_root),
            "Sirk__Security__Enabled": "true",
            "Sirk__Security__DataRoot": str(security_root),
            "Sirk__Security__BootstrapSecretFile": str(bootstrap_path),
            "Sirk__Security__PasswordHashIterations": "100000",
            "Sirk__Security__SessionMinutes": "30",
            "Sirk__Security__LoginAttemptsPerFiveMinutes": "5",
        }
    )

    log_path = root / "central.log"
    with log_path.open("w", encoding="utf-8") as log_file:
        process = subprocess.Popen(
            ["dotnet", str(central_dll)],
            cwd=central_dll.parent,
            env=environment,
            stdout=log_file,
            stderr=subprocess.STDOUT,
            text=True,
        )

    cookie_jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookie_jar))

    try:
        wait_ready(opener)
        if bootstrap_path.exists():
            raise RuntimeError("One-time Break-Glass bootstrap file was not deleted.")

        login_path = f"/api/v1/break-glass/{ACCESS_CODE}/login"
        bad_status, _ = request_json(
            opener,
            "POST",
            login_path,
            {"userName": USER_NAME, "password": PASSWORD + "x"},
        )
        if bad_status != 401:
            raise RuntimeError(f"Invalid Break-Glass login returned HTTP {bad_status}, expected 401.")

        login_status, login = request_json(
            opener,
            "POST",
            login_path,
            {"userName": USER_NAME, "password": PASSWORD},
        )
        if login_status != 200 or SIRK_ROLE(login) != "BreakGlass":
            raise RuntimeError("Valid Break-Glass login failed or returned an invalid role.")

        session_status, session = request_json(opener, "GET", "/api/v1/auth/session")
        if session_status != 200 or not session.get("authenticated"):
            raise RuntimeError("Authenticated session endpoint failed.")
        if "BreakGlass" not in session.get("roles", []):
            raise RuntimeError("Authenticated session does not contain the BreakGlass role.")

        csrf_status, csrf = request_json(opener, "GET", "/api/v1/auth/csrf")
        if csrf_status != 200 or not csrf.get("requestToken"):
            raise RuntimeError("CSRF token endpoint failed.")

        logout_status, _ = request_json(
            opener,
            "POST",
            "/api/v1/auth/logout",
            {},
            {csrf.get("headerName", "X-SIRK-CSRF"): csrf["requestToken"]},
        )
        if logout_status != 200:
            raise RuntimeError(f"Break-Glass logout returned HTTP {logout_status}, expected 200.")

        logged_out_status, _ = request_json(opener, "GET", "/api/v1/auth/session")
        if logged_out_status != 401:
            raise RuntimeError(
                f"Logged-out session endpoint returned HTTP {logged_out_status}, expected 401."
            )

        rate_limited = False
        for _ in range(6):
            status, _ = request_json(
                opener,
                "POST",
                login_path,
                {"userName": USER_NAME, "password": "invalid-password-value"},
            )
            if status == 429:
                rate_limited = True
                break
        if not rate_limited:
            raise RuntimeError("Break-Glass login rate limiter did not return HTTP 429.")

        identity_path = security_root / "identity.net10.json"
        audit_path = security_root / "security-audit.net10.jsonl"
        audit_key_path = security_root / "security-audit.net10.key"
        for protected_path in (identity_path, audit_path, audit_key_path):
            if not protected_path.is_file():
                raise RuntimeError(f"Protected security file is missing: {protected_path}")
            assert_mode_600(protected_path)

        combined = identity_path.read_text(encoding="utf-8") + audit_path.read_text(encoding="utf-8")
        if PASSWORD in combined or ACCESS_CODE in combined:
            raise RuntimeError("Security state exposes a plaintext Break-Glass secret.")
        if "authentication.break-glass" not in combined or "authentication.logout" not in combined:
            raise RuntimeError("Security audit log does not contain expected authentication events.")

        print("SIRK Central live Break-Glass auth, CSRF, rate-limit and audit smoke: OK")
        return 0
    finally:
        if process.poll() is None:
            process.send_signal(signal.SIGTERM)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        if process.returncode not in (0, -signal.SIGTERM):
            print(log_path.read_text(encoding="utf-8"), file=sys.stderr)


def SIRK_ROLE(login: dict) -> str:
    roles = login.get("user", {}).get("roles", [])
    return roles[0] if roles else ""


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # noqa: BLE001 - CI entry point
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
