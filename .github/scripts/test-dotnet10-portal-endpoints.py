#!/usr/bin/env python3

import base64
import hashlib
import hmac
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE_URL = os.environ["SIRK_TEST_BASE_URL"].rstrip("/")
PORTAL_ID = os.environ["SIRK_TEST_PORTAL_ID"]
PORTAL_TOKEN = os.environ["SIRK_TEST_PORTAL_TOKEN"]
REGISTRY_PATH = Path(os.environ["SIRK_TEST_REGISTRY_PATH"])


def base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def authorization() -> str:
    return "SIRK-Portal " + base64url(f"{PORTAL_ID}:{PORTAL_TOKEN}".encode("utf-8"))


def wait_ready() -> None:
    deadline = time.monotonic() + 30
    last_error = None
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f"{BASE_URL}/readyz", timeout=2) as response:
                if response.status == 200:
                    return
        except Exception as error:  # noqa: BLE001 - bounded startup retry
            last_error = error
        time.sleep(0.25)
    raise RuntimeError(f"Central did not become ready: {last_error}")


def signed_heartbeat() -> tuple[bytes, dict[str, str]]:
    body = json.dumps(
        {
            "protocolVersion": 1,
            "portalVersion": "3.0.0-dev.1",
            "buildCommit": "endpoint-smoke",
            "platform": "linux-x64",
            "hostname": "portal-test",
            "publicUrl": "https://portal.example",
            "health": "ok",
            "agentCount": 2,
            "onlineAgents": 1,
            "updateChannel": "dev",
            "availableVersion": "3.0.0-dev.1",
            "capabilities": ["dotnet10-runtime", "signed-heartbeat"],
        },
        separators=(",", ":"),
    ).encode("utf-8")
    timestamp = str(int(time.time() * 1000))
    nonce = base64url(secrets.token_bytes(18))
    signature = hmac.new(
        PORTAL_TOKEN.encode("utf-8"),
        timestamp.encode("ascii") + b"\n" + nonce.encode("ascii") + b"\n" + body,
        hashlib.sha256,
    ).digest()
    return body, {
        "Authorization": authorization(),
        "Content-Type": "application/json; charset=utf-8",
        "X-SIRK-Timestamp": timestamp,
        "X-SIRK-Nonce": nonce,
        "X-SIRK-Signature": base64url(signature),
    }


def post_heartbeat(body: bytes, headers: dict[str, str]) -> int:
    request = urllib.request.Request(
        f"{BASE_URL}/api/portal/v1/heartbeat",
        data=body,
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            response.read()
            return response.status
    except urllib.error.HTTPError as error:
        error.read()
        return error.code


def get_configuration() -> tuple[int, dict]:
    request = urllib.request.Request(
        f"{BASE_URL}/api/portal/v1/config",
        headers={"Authorization": authorization()},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read().decode("utf-8"))


def main() -> int:
    wait_ready()

    body, headers = signed_heartbeat()
    first_status = post_heartbeat(body, headers)
    if first_status != 202:
        raise RuntimeError(f"Signed heartbeat returned HTTP {first_status}, expected 202.")

    replay_status = post_heartbeat(body, headers)
    if replay_status != 409:
        raise RuntimeError(f"Replayed heartbeat returned HTTP {replay_status}, expected 409.")

    invalid_headers = dict(headers)
    invalid_headers["X-SIRK-Nonce"] = base64url(secrets.token_bytes(18))
    invalid_headers["X-SIRK-Signature"] = base64url(bytes(32))
    invalid_status = post_heartbeat(body, invalid_headers)
    if invalid_status != 401:
        raise RuntimeError(f"Invalid HMAC returned HTTP {invalid_status}, expected 401.")

    config_status, config = get_configuration()
    if config_status != 200 or config.get("portalId") != PORTAL_ID:
        raise RuntimeError("Authenticated Portal configuration endpoint failed.")

    registry_text = REGISTRY_PATH.read_text(encoding="utf-8")
    if PORTAL_TOKEN in registry_text:
        raise RuntimeError("Portal registry contains the plaintext token.")

    print("SIRK Central Portal HTTP endpoint smoke: OK")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # noqa: BLE001 - CI entry point
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
