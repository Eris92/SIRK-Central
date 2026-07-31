# SIRK Central - YubiKey production smoke test

Target: `https://central.sirkportal.com`

## Preconditions

- Deploy the exact tested commit from `feat/central-production-hardening`.
- `SIRK_PUBLIC_ORIGIN` must be exactly `https://central.sirkportal.com`.
- The browser must show a valid publicly trusted TLS certificate with no warning.
- Caddy must preserve the original host and HTTPS origin.
- Use Edge or Chrome with a clean InPrivate/Incognito window.
- Have one YubiKey that supports FIDO2/WebAuthn and a separate secure place for recovery codes.

## 1. Readiness

Open:

```text
https://central.sirkportal.com/readyz
```

Expected:

- HTTP 200
- `ok: true`
- version `1.0.0-rc.10`
- passkey, challenge, transaction, attestation and continuity checks enabled

## 2. Initial BreakGlass sign-in

1. Open the complete BreakGlass access URL.
2. Sign in with the local BreakGlass username and password.
3. Confirm that the session opens without MFA only when no passkey and no recovery code are configured.
4. Open the BreakGlass panel.

## 3. Configure recovery codes first

1. Generate recovery codes.
2. Store them outside SIRK Central in an encrypted password vault or offline sealed copy.
3. Confirm the one-time display and hide the plaintext codes.
4. Refresh the page and verify that plaintext codes are no longer available.

## 4. Register the YubiKey

1. Select `Register YubiKey`.
2. Enter a descriptive name containing location or custodian, not a secret.
3. Insert or tap the YubiKey when prompted.
4. Complete PIN/user-verification if requested.
5. Verify that the key appears as active.
6. Confirm the displayed transport and creation time.

Expected server behavior:

- challenge is one-time and expires,
- exact origin and RP ID are checked,
- `UP`, `UV` and `AT` flags are required,
- `attestationObject` is parsed server-side,
- only `fmt: none`, ES256 and P-256 are accepted,
- the frontend-provided public key is ignored.

## 5. Passkey sign-in

1. Sign out.
2. Close the private window.
3. Open a new private window and the BreakGlass access URL.
4. Enter the username and password.
5. Confirm that YubiKey is selected as the preferred second factor.
6. Complete the WebAuthn prompt.
7. Verify that a BreakGlass session is issued only after successful assertion verification.

## 6. Recovery-code fallback

1. Sign out and start a new BreakGlass sign-in.
2. Cancel the YubiKey prompt.
3. Select recovery-code fallback.
4. Use one recovery code.
5. Confirm successful sign-in.
6. Confirm that the same recovery code cannot be used again.

## 7. Continuity policy

1. With recovery codes active, remove the only registered YubiKey. Expected: allowed.
2. Attempt to revoke recovery codes while no active passkey exists. Expected: HTTP 409 / `MFA_CONTINUITY_REQUIRED`.
3. Register the YubiKey again.
4. Revoke recovery codes. Expected: allowed because an active passkey remains.
5. Attempt to remove the last passkey while no recovery code remains. Expected: HTTP 409 / `MFA_CONTINUITY_REQUIRED`.

At every point after MFA is first configured, at least one usable method must remain.

## 8. Negative tests

- Repeat a completed assertion request: must fail.
- Reuse an expired challenge: must fail.
- Change the host to another domain or direct IP: WebAuthn must fail.
- Try HTTP instead of HTTPS: registration/sign-in must not operate.
- Cancel the browser prompt: no session may be issued.
- Use a different user-agent or source address for an existing pending transaction: transaction must be rejected.

## 9. Evidence to retain

Record without secrets:

- deployed commit SHA,
- `/readyz` response,
- browser name and version,
- YubiKey model and firmware,
- registration timestamp,
- successful passkey sign-in timestamp,
- successful recovery fallback timestamp,
- audit event identifiers,
- result of both continuity-policy blocks.

Never record access keys, passwords, session cookies, recovery codes, clientDataJSON, authenticatorData, signatures or private key material.
