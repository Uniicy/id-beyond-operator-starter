# API Reference

Base URL in local dev: `http://localhost:4499`. All routes return JSON unless stated otherwise. All `POST` routes expect `Content-Type: application/json`.

## Conventions

### Auth

Bearer tokens for authed routes:

```
Authorization: Bearer <accessToken>
```

Access tokens are JWTs (HS256, 15-minute TTL). Refresh tokens are opaque strings (~64 chars, 30-day TTL) exchanged at `/auth/refresh`.

### Error shape

Every 4xx / 5xx response carries the same envelope:

```json
{
  "error": {
    "code": "invalid_credentials",
    "message": "Invalid credentials"
  }
}
```

`code` is stable and machine-readable; `message` is human-readable and may be surfaced in UI.

### Timestamps

ISO-8601 with timezone, e.g. `2026-04-23T17:55:15.817Z`.

---

## `GET /health`

Liveness probe. No auth, no body.

```json
{ "ok": true, "service": "operator-backend" }
```

---

## Authentication routes

### `POST /auth/signup`

Create a user account using email + password.

**Request**

```json
{
  "email": "alice@example.com",
  "password": "correct-horse-staple"
}
```

| Field | Type | Rules |
|---|---|---|
| `email` | string | Valid email. Normalised to lowercase + trimmed. |
| `password` | string | ≥ 8 chars. |

**Response `201 Created`**

```json
{
  "accessToken": "eyJhbGciOi...",
  "accessTokenExpiresIn": 900,
  "refreshToken": "X9a…k2",
  "refreshTokenExpiresAt": "2026-05-23T17:55:15.817Z",
  "user": {
    "id": "f9f0…-b3a1",
    "email": "alice@example.com",
    "kycStatus": "not_started"
  }
}
```

**Errors**

| Status | `code` | When |
|---|---|---|
| `400` | `invalid_body` | Validation failure (bad email, short password, malformed JSON). |
| `409` | `email_taken` | An account with that email already exists. |

---

### `POST /auth/login`

Exchange email + password for an auth session.

**Request**

```json
{ "email": "alice@example.com", "password": "correct-horse-staple" }
```

**Response `200 OK`** — identical shape to `/auth/signup`.

**Errors**

| Status | `code` | When |
|---|---|---|
| `400` | `invalid_body` | Malformed JSON or missing fields. |
| `401` | `invalid_credentials` | Unknown email OR wrong password. Uniform to prevent account enumeration. |

---

### `POST /auth/logout`

Revoke a refresh token. Idempotent — unknown or already-revoked tokens also return 204.

**Request**

```json
{ "refreshToken": "X9a…k2" }
```

**Response** — `204 No Content`, empty body.

**Errors**

| Status | `code` | When |
|---|---|---|
| `400` | `invalid_body` | Missing `refreshToken`. |

---

### `POST /auth/refresh`

Rotate a refresh token and get a fresh access token. The old refresh token is revoked; re-using it afterwards will 401.

**Request**

```json
{ "refreshToken": "X9a…k2" }
```

**Response `200 OK`** — same shape as `/auth/login`.

**Errors**

| Status | `code` | When |
|---|---|---|
| `400` | `invalid_body` | Missing `refreshToken`. |
| `401` | `invalid_refresh_token` | Token unknown, expired, or already revoked. |

---

### `POST /auth/magic-link/request`

Send a single-use sign-in link. Creates the user row if needed. Always 202 — response does not reveal whether the email was already registered.

**Request**

```json
{ "email": "alice@example.com" }
```

**Response `202 Accepted`**

```json
{
  "status": "sent",
  "expiresAt": "2026-04-23T18:10:15.817Z"
}
```

**Errors**

| Status | `code` | When |
|---|---|---|
| `400` | `invalid_body` | Malformed email. |

**Dev notes** — with `EMAIL_TRANSPORT=console` (the default), the verify URL is logged to stdout:

```
---
[magic-link] to:         alice@example.com
[magic-link] verify URL: https://app.example.com/auth/magic-link?token=ABC…
[magic-link] expires at: 2026-04-23T18:10:15.817Z
---
```

---

### `POST /auth/magic-link/verify`

Consume a magic-link token and receive an auth session.

**Request**

```json
{ "token": "ABC…" }
```

**Response `200 OK`** — same shape as `/auth/login`.

**Errors**

| Status | `code` | When |
|---|---|---|
| `400` | `invalid_body` | Missing `token`. |
| `401` | `invalid_magic_link` | Token unknown, expired, or already consumed (single-use). |

---

### `POST /auth/apple`

Exchange an Apple `identityToken` for an auth session. Find-or-create semantics: a new Apple `sub` provisions a new user.

**Request**

```json
{
  "identityToken": "eyJhbGciOi…",
  "email": "alice@example.com"
}
```

| Field | Type | Rules |
|---|---|---|
| `identityToken` | string | From `ASAuthorizationAppleIDCredential.identityToken`. |
| `email` | string? | Pass on first sign-in if Apple provides it; safe to omit on subsequent logins. |

**Response `200 OK`** — same shape as `/auth/login`.

**Errors**

| Status | `code` | When |
|---|---|---|
| `400` | `invalid_body` | Missing `identityToken`. |
| `401` | `invalid_apple_token` | Apple JWKS verification failed (bad signature, expired, issuer / audience mismatch). |
| `503` | `apple_not_configured` | `AUTH_APPLE_CLIENT_ID` is not set on the server. |

---

## User

### `GET /me`

Return the authenticated user, including the webhook-maintained `kycStatus`. **Authed.**

**Response `200 OK`**

```json
{
  "id": "f9f0…-b3a1",
  "email": "alice@example.com",
  "kycStatus": "approved",
  "kycSessionId": "c3ae1b0c-…-4a",
  "createdAt": "2026-04-23T17:55:15.817Z"
}
```

`kycStatus` values:

| Value | Meaning |
|---|---|
| `not_started` | User has not kicked off a session yet. |
| `pending_review` | Session finished, id beyond is reviewing. |
| `approved` | Webhook confirmed the verification. |
| `rejected` | Webhook confirmed a failure. |

**Errors**

| Status | `code` | When |
|---|---|---|
| `401` | `missing_bearer` | No `Authorization: Bearer …` header. |
| `401` | `invalid_token` | JWT signature / claims / expiry failed. |
| `401` | `user_not_found` | JWT was valid but the user row is gone. |

---

## KYC

### `POST /kyc/sessions`

Mint an id beyond verification session for the current user. **Authed.** The backend injects `externalUserId = user.id` and the configured `KYC_RETURN_URL`, and strips `clientSecret` / `token` from the upstream response before replying.

**Request** — empty body. Send `Content-Length: 0` or `{}`.

**Response `201 Created`**

```json
{
  "sessionId": "c3ae1b0c-59f1-4b55-bf2d-34d2a50ebe4a",
  "hostedUrl": "https://verify.uniicy.com/flow/c3ae1b0c?token=…",
  "expiresAt": "2026-04-23T18:55:15.817Z"
}
```

This is exactly the shape the `IDBeyondKYC` iOS SDK decodes via `JSONDecoder.idBeyondKYC()` into a `KYCSession`.

**Errors**

| Status | `code` | When |
|---|---|---|
| `401` | `missing_bearer` / `invalid_token` | Unauthenticated or expired. |
| `502` | `kyc_provider_unavailable` | id beyond API returned a non-2xx or unexpected shape. Retry the call; user session remains valid. |

---

### `POST /webhooks/kyc`

Called by **id beyond**, not by your app. Included here for completeness and to document the signature scheme.

**Headers**

| Header | Required | Value |
|---|---|---|
| `Content-Type` | ✓ | `application/json` |
| `X-Verification-Signature` | ✓ | Hex-encoded HMAC-SHA256 of the raw request body, keyed by `IDBEYOND_WEBHOOK_SECRET`. |

**Body**

```json
{
  "event": "verification.completed",
  "verificationSessionId": "c3ae1b0c-59f1-4b55-bf2d-34d2a50ebe4a",
  "externalUserId": "f9f0…-b3a1",
  "decision": "approved",
  "reviewStatus": "approved",
  "rationale": "",
  "metadata": { },
  "timestamp": "2026-04-23T18:55:15.817Z"
}
```

| Field | Description |
|---|---|
| `event` | Always `verification.completed` for terminal outcomes. Other events are acknowledged but ignored. |
| `externalUserId` | The `user.id` the backend passed in when minting the session. |
| `decision` | `approved` \| `rejected` \| `null` for transitional states. |
| `reviewStatus` | Free-form status from id beyond. Used as fallback when `decision` is absent. |

**Responses**

| Status | Body | When |
|---|---|---|
| `200` | `{ "ok": true }` | Valid signature, `verification.completed` processed. |
| `200` | `{ "ok": true, "ignored": true }` | Valid signature, event type not a terminal decision — id beyond gets a 2xx and won't retry. |
| `400` | `{ "error": { "code": "invalid_body" } }` | Body failed schema validation. |
| `401` | `{ "error": { "code": "missing_signature" } }` | Header absent. |
| `401` | `{ "error": { "code": "invalid_signature" } }` | HMAC mismatch (tampered body or wrong secret). |

**Signing reference** (matches the KYC service)

```bash
BODY='{"event":"verification.completed","verificationSessionId":"c3ae1b0c-…","externalUserId":"…","decision":"approved","reviewStatus":"approved","rationale":""}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$IDBEYOND_WEBHOOK_SECRET" -hex | awk '{print $2}')

curl -X POST http://localhost:4499/webhooks/kyc \
  -H "Content-Type: application/json" \
  -H "X-Verification-Signature: $SIG" \
  -d "$BODY"
```

> The HMAC is computed over the **raw** request body, byte-for-byte. Do not re-serialize the JSON before signing (or before verifying) — key order or whitespace changes will break the signature.

---

## Status code summary

| Status | Meaning here |
|---|---|
| `200` | Successful GET / accepted POST. |
| `201` | Resource created (signup, KYC session). |
| `202` | Accepted but side effect is async (magic-link emailed). |
| `204` | No content (logout). |
| `400` | Validation error — see `error.code`. |
| `401` | Unauthenticated or credentials invalid. |
| `409` | Conflict — only `email_taken` today. |
| `500` | Unhandled server error — body is `{ "error": { "code": "internal_error" } }`. |
| `502` | Upstream (id beyond) failure. |
| `503` | Feature not configured (e.g. Apple Sign In). |

---

## Error code reference

| `code` | Status | Route(s) |
|---|---|---|
| `invalid_body` | 400 | All routes accepting JSON bodies. |
| `email_taken` | 409 | `POST /auth/signup` |
| `invalid_credentials` | 401 | `POST /auth/login` |
| `invalid_refresh_token` | 401 | `POST /auth/refresh` |
| `invalid_magic_link` | 401 | `POST /auth/magic-link/verify` |
| `invalid_apple_token` | 401 | `POST /auth/apple` |
| `apple_not_configured` | 503 | `POST /auth/apple` |
| `missing_bearer` | 401 | All authed routes. |
| `invalid_token` | 401 | All authed routes. |
| `user_not_found` | 401 | All authed routes. |
| `kyc_provider_unavailable` | 502 | `POST /kyc/sessions` |
| `missing_signature` / `invalid_signature` | 401 | `POST /webhooks/kyc` |
| `internal_error` | 500 | Fallback for unexpected exceptions. |
