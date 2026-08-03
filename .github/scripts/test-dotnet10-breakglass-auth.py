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
AUTHORIZATION = {"Authorization": f"Bearer {ACCESS_CODE}"}


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
    last_error = None
    last_status = None
    while time.monotonic() < deadline:
        try:
            status, _ = request_json(opener, "GET", "/readyz")
            last_status = status
            if status == 200:
                return
        except urllib.error.URLError as error:
            last_error = error
        time.sleep(0.25)
    raise RuntimeError(
        f"Central did not become ready; last HTTP status: {last_status}; last error: {last_error}"
    )


def assert_mode_600(path: Path) -> None:
    mode = path.stat().st_mode & 0o777
    if mode & 0o077:
        raise RuntimeError(f"Protected file has weak mode {oct(mode)}: {path}")


def csrf(opener):
    status, result = request_json(opener, "GET", "/api/v1/auth/csrf")
    if status != 200 or not result.get("requestToken"):
        raise RuntimeError("CSRF token endpoint failed.")
    return {result.get("headerName", "X-SIRK-CSRF"): result["requestToken"]}


def require_logged_out(opener, message: str):
    status, _ = request_json(opener, "GET", "/api/session")
    if status != 401:
        raise RuntimeError(f"{message}: session returned HTTP {status}, expected 401.")


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

        access_status, access = request_json(opener, "GET", "/api/access", headers=AUTHORIZATION)
        if access_status != 200 or not access.get("localLoginEnabled"):
            raise RuntimeError("A valid Access URL did not enable the local login form.")

        bad_status, _ = request_json(
            opener,
            "POST",
            "/api/login",
            {"userName": USER_NAME, "password": PASSWORD + "x"},
            AUTHORIZATION,
        )
        if bad_status != 401:
            raise RuntimeError(f"Invalid Break-Glass login returned HTTP {bad_status}, expected 401.")

        login_status, login = request_json(
            opener,
            "POST",
            "/api/login",
            {"userName": USER_NAME, "password": PASSWORD},
            AUTHORIZATION,
        )
        if login_status != 200 or login.get("role") != "BreakGlass":
            raise RuntimeError("First Break-Glass login without configured MFA failed.")
        if login.get("mfaRequired") is not False or not login.get("mfaEnrollmentRecommended"):
            raise RuntimeError("First Break-Glass login returned an invalid MFA state.")

        session_status, session = request_json(opener, "GET", "/api/session")
        if session_status != 200 or session.get("role") != "BreakGlass":
            raise RuntimeError("Compatibility session endpoint failed after first login.")

        rotate_status, rotated = request_json(
            opener,
            "POST",
            "/api/v1/break-glass/mfa/recovery-codes/rotate",
            {"count": 10},
            csrf(opener),
        )
        recovery_codes = rotated.get("codes", [])
        if rotate_status != 200 or len(recovery_codes) != 10:
            raise RuntimeError("Recovery-code rotation failed.")

        logout_status, _ = request_json(
            opener,
            "POST",
            "/api/logout",
            {},
            csrf(opener),
        )
        if logout_status != 200:
            raise RuntimeError(f"Break-Glass logout returned HTTP {logout_status}, expected 200.")
        require_logged_out(opener, "After first logout")

        mfa_login_status, mfa_login = request_json(
            opener,
            "POST",
            "/api/login",
            {"userName": USER_NAME, "password": PASSWORD},
            AUTHORIZATION,
        )
        if mfa_login_status != 202 or not mfa_login.get("mfaRequired"):
            raise RuntimeError("Configured MFA was not required after password verification.")
        if "recovery-code" not in mfa_login.get("methods", []):
            raise RuntimeError("Recovery-code MFA method was not advertised.")
        transaction = mfa_login.get("transactionToken")
        if not transaction:
            raise RuntimeError("Password verification did not issue an MFA transaction.")
        require_logged_out(opener, "Before second factor")

        recovery_status, recovery = request_json(
            opener,
            "POST",
            "/api/login/mfa/recovery",
            {
                "transactionToken": transaction,
                "recoveryCode": recovery_codes[0],
            },
            AUTHORIZATION,
        )
        if recovery_status != 200 or not recovery.get("authenticated"):
            raise RuntimeError("Recovery-code second factor failed.")
        if recovery.get("recoveryCodesRemaining") != 9:
            raise RuntimeError("Recovery code was not consumed exactly once.")

        session_status, session = request_json(opener, "GET", "/api/v1/auth/session")
        if session_status != 200 or not session.get("authenticated"):
            raise RuntimeError("Authenticated session endpoint failed after MFA.")
        if session.get("authenticationMethod") != "local-break-glass":
            raise RuntimeError("Authenticated session source is invalid.")

        logout_status, _ = request_json(
            opener,
            "POST",
            "/api/v1/auth/logout",
            {},
            csrf(opener),
        )
        if logout_status != 200:
            raise RuntimeError("Logout after MFA failed.")
        require_logged_out(opener, "After MFA logout")

        limited_status = None
        for _ in range(6):
            limited_status, _ = request_json(
                opener,
                "POST",
                "/api/login",
                {"userName": USER_NAME, "password": "invalid-password-value"},
                AUTHORIZATION,
            )
            if limited_status == 429:
                break
        if limited_status != 429:
            raise RuntimeError(
                f"Break-Glass rate limiter returned HTTP {limited_status}, expected 429."
            )

        identity_path = security_root / "identity.net10.json"
        audit_path = security_root / "security-audit.net10.jsonl"
        audit_key_path = security_root / "security-audit.net10.key"
        recovery_path = security_root / "break-glass-recovery-codes.net10.json"
        for protected_path in (identity_path, audit_path, audit_key_path, recovery_path):
            if not protected_path.is_file():
                raise RuntimeError(f"Protected security file is missing: {protected_path}")
            assert_mode_600(protected_path)

        combined = "".join(
            path.read_text(encoding="utf-8")
            for path in (identity_path, audit_path, recovery_path)
        )
        if PASSWORD in combined or ACCESS_CODE in combined:
            raise RuntimeError("Security state exposes a plaintext Break-Glass secret.")
        if any(code in combined for code in recovery_codes):
            raise RuntimeError("Security state exposes a plaintext recovery code.")
        expected_events = (
            "authentication.break-glass",
            "authentication.break-glass.password-verified",
            "authentication.break-glass.mfa-success",
            "authentication.logout",
        )
        if any(event not in combined for event in expected_events):
            raise RuntimeError("Security audit log does not contain expected MFA events.")

        print("SIRK Central password-first Break-Glass MFA live flow: OK")
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


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # noqa: BLE001 - CI entry point
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
