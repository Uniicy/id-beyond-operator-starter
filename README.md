# id beyond Operator Starter

Reference **operator backend** that demonstrates the complete server-side integration path for a client application (iOS, Android, web) that needs to:

1. Sign users up and log them in.
2. Kick off an [id beyond](https://verify.uniicy.com) KYC verification.
3. Observe the outcome of the verification asynchronously via webhook.

This repo is the server-side companion to the [`IDBeyondKYC` iOS SDK](https://github.com/Uniicy/id-beyond-kyc-ios-sdk). Clone, configure three environment variables, run `docker compose up -d` + `pnpm dev`, and you have a working end-to-end flow in ~10 minutes.

- **Stack** — Hono · TypeScript · Drizzle · Postgres · Vitest
- **Package manager** — pnpm
- **License** — MIT

---

## Architecture

```
┌──────────────┐   1. signup / login             ┌───────────────────────┐
│   iOS app    │────────────────────────────────▶│  Operator backend     │
│ (IDBeyondKYC │                                 │   (this repo)         │
│     SDK)     │◀────────── 2. tokens ───────────│                       │
│              │                                 │  - /auth/* (argon2id  │
│              │   3. POST /kyc/sessions         │      + JWT)           │
│              │────────────────────────────────▶│  - /me                │
│              │                                 │  - /kyc/sessions ─┐   │
│              │◀ 4. { sessionId, hostedUrl } ───│  - /webhooks/kyc  │   │
└──────┬───────┘                                 └──────────▲────────┼───┘
       │                                                    │        │
       │                                            7. HMAC │        │ 5. pk_live_*
       │ 5. present ASWebAuthenticationSession      webhook │        ▼
       │    at hostedUrl                                    │   ┌──────────┐
       ▼                                                    │   │ id beyond│
┌──────────────┐   6. user completes flow, returnUrl hit    │   │   API    │
│ id beyond    │────────────────────────────────────────────┘   └──────────┘
│ hosted flow  │
└──────────────┘
```

Key design decisions:

- **`kyc_status` lives on `users`.** The webhook handler is the single writer; `/me` serves it to clients.
- **`clientSecret` / `token` are stripped.** The proxy route only returns `{ sessionId, hostedUrl, expiresAt }` — exactly the shape the iOS SDK decodes.
- **Bearer tokens only, no cookies.** Matches how mobile clients call this.
- **Refresh tokens are opaque and hashed at rest.** A DB leak cannot resurrect sessions.
- **Webhook HMAC is verified against the raw body** (not the re-serialised JSON) using `crypto.timingSafeEqual`.

---

## Quick start

```bash
# 1. Install deps
pnpm install

# 2. Boot a dev Postgres
docker compose up -d

# 3. Configure environment
cp .env.example .env
# edit JWT_SECRET, IDBEYOND_SECRET, IDBEYOND_WEBHOOK_SECRET, KYC_RETURN_URL

# 4. Apply the schema
pnpm db:migrate

# 5. Run
pnpm dev
# → http://localhost:3000/health
```

### Smoke-test the full flow

```bash
# Sign up
curl -s -X POST http://localhost:3000/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","password":"correct-horse-staple"}' | tee /tmp/session.json

ACCESS=$(jq -r .accessToken /tmp/session.json)

# Mint a KYC session
curl -s -X POST http://localhost:3000/kyc/sessions \
  -H "Authorization: Bearer $ACCESS"
# → { "sessionId": "...", "hostedUrl": "https://verify.uniicy.com/...", "expiresAt": "..." }

# Open hostedUrl in a browser (or hand to the iOS SDK)
```

---

## Environment

| Variable | Required | Description |
|---|---|---|
| `PORT` | — | HTTP port (default `3000`). |
| `NODE_ENV` | — | `development`, `test`, `production`. |
| `DATABASE_URL` | ✓ | Postgres connection string. |
| `JWT_SECRET` | ✓ | ≥32 chars. `openssl rand -base64 48`. |
| `IDBEYOND_API_URL` | — | Defaults to `https://api.uniicy.com`. |
| `IDBEYOND_SECRET` | ✓ | `pk_live_*` key from the id beyond dashboard. |
| `IDBEYOND_WEBHOOK_SECRET` | ✓ | Shared secret used by id beyond to sign webhook bodies. |
| `KYC_RETURN_URL` | ✓ | Universal Link the hosted flow redirects to on completion. |
| `AUTH_APPLE_CLIENT_ID` | Only for `/auth/apple` | The app's Apple service identifier (usually the bundle ID). |
| `AUTH_APPLE_TEAM_ID` | — | Reserved for future use (e.g. minting Apple client secrets). |
| `EMAIL_TRANSPORT` | — | `console` (default) or `resend`. |
| `RESEND_API_KEY` | Only when `EMAIL_TRANSPORT=resend` | Resend API key. |

---

## Routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/health` | — | Liveness probe. |
| `POST` | `/auth/signup` | — | Email + password → `{ accessToken, refreshToken, user }`. |
| `POST` | `/auth/login` | — | Email + password → same. |
| `POST` | `/auth/logout` | — | Revoke a refresh token. |
| `POST` | `/auth/refresh` | — | Rotate refresh + mint new access token. |
| `POST` | `/auth/magic-link/request` | — | Emails a single-use sign-in link. |
| `POST` | `/auth/magic-link/verify` | — | Consume the link, return a session. |
| `POST` | `/auth/apple` | — | Exchange an Apple identity token for a session. |
| `GET`  | `/me` | Bearer | Current user, including `kycStatus`. |
| `POST` | `/kyc/sessions` | Bearer | Mint an id beyond session for the authed user. |
| `POST` | `/webhooks/kyc` | HMAC | id beyond → updates `users.kyc_status`. |

### Curl examples

**Signup**

```bash
curl -X POST http://localhost:3000/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","password":"correct-horse-staple"}'
```

**Login**

```bash
curl -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","password":"correct-horse-staple"}'
```

**Refresh**

```bash
curl -X POST http://localhost:3000/auth/refresh \
  -H 'Content-Type: application/json' \
  -d '{"refreshToken":"<from-previous-response>"}'
```

**Magic-link request / verify**

```bash
curl -X POST http://localhost:3000/auth/magic-link/request \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com"}'
# In dev the verify URL is logged to the server console.

curl -X POST http://localhost:3000/auth/magic-link/verify \
  -H 'Content-Type: application/json' \
  -d '{"token":"<from-email>"}'
```

**Apple Sign In**

```bash
curl -X POST http://localhost:3000/auth/apple \
  -H 'Content-Type: application/json' \
  -d '{"identityToken":"<ASAuthorizationAppleIDCredential.identityToken>"}'
```

**Current user**

```bash
curl http://localhost:3000/me \
  -H "Authorization: Bearer $ACCESS"
```

**Mint a KYC session**

```bash
curl -X POST http://localhost:3000/kyc/sessions \
  -H "Authorization: Bearer $ACCESS"
```

**Webhook (what id beyond sends)**

```bash
BODY='{"event":"verification.completed","verificationSessionId":"...","externalUserId":"<user.id>","decision":"approved","reviewStatus":"approved","rationale":""}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$IDBEYOND_WEBHOOK_SECRET" -hex | cut -d' ' -f2)
curl -X POST http://localhost:3000/webhooks/kyc \
  -H 'Content-Type: application/json' \
  -H "X-Verification-Signature: $SIG" \
  -d "$BODY"
```

---

## How to replace for production

This is a **starter**, not a finished platform. What you'll want to swap before going live:

- **Email transport** — `src/lib/email.ts` ships with a console logger and a thin Resend implementation. Swap in SES / Postmark / Mailgun / an SMTP client by implementing the `EmailTransport` interface and wiring it in `selectEmailTransport`.
- **JWT secret rotation** — a single `JWT_SECRET` works for a solo service, but production systems typically sign with a key-set. Replace the `signAccessToken` / `verifyAccessToken` pair in `src/lib/tokens.ts` with a JWKS (e.g. store rotating keys in KMS and publish a JWKS endpoint).
- **Rate limiting** — there is no rate limiter. At minimum, add per-IP and per-email limits on `/auth/login`, `/auth/magic-link/request`, and `/auth/signup`. Hono has middleware patterns for this; drop one in `src/middleware/`.
- **Password policy / breached password check** — 8 characters is the floor we enforce; many operators want 12+ and a HIBP prefix check on signup.
- **Refresh-token family reuse detection** — this starter revokes the single old token on rotation. For full protection, track the "family" of a refresh token and revoke the whole family if a revoked one is re-presented (a classic refresh-token replay indicator).
- **Observability** — the app logs with Hono's default logger. Swap in Pino + OpenTelemetry for structured logs, metrics, and tracing.
- **Apple private relay email resolution** — when a user hides their email, we store a `<sub>@apple.private-relay.local` placeholder. To actually deliver email to these users, implement Apple's [private email relay](https://developer.apple.com/documentation/sign_in_with_apple/communicating_using_the_private_email_relay_service) setup.

---

## Testing

```bash
# One-off test run (boots the test Postgres for you if needed)
docker compose --profile test up -d postgres-test
pnpm test
```

- Tests use `app.request(...)` so there's no network listener — everything runs in-process against a real Postgres on port `5433`.
- Each test file gets a freshly dropped / re-migrated `public` schema.
- `fetch` is stubbed per-test for the id beyond proxy — no real API calls.

---

## Docker

```bash
docker build -t id-beyond-operator-starter .
docker run --rm -p 3000:3000 --env-file .env id-beyond-operator-starter
```

The image runs migrations via `pnpm db:migrate` as a separate step; add an init-container or `RUN pnpm db:migrate` hook in your deployment depending on how you like to sequence schema changes.

---

## Related

- [id beyond Integration Guide](https://verify.uniicy.com/docs/integration)
- [`IDBeyondKYC` iOS SDK](https://github.com/Uniicy/id-beyond-kyc-ios-sdk)

---

## License

MIT — see [LICENSE](./LICENSE).
