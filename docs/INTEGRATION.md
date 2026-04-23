# iOS Integration Guide

This guide walks through every step an iOS engineer takes to wire an app against the operator backend in this repo plus the [`IDBeyondKYC`](https://github.com/Uniicy/id-beyond-kyc-ios-sdk) Swift package. By the end you'll have a working flow that:

1. Registers and signs in a user against **your operator backend** (not id beyond directly).
2. Stores auth tokens securely on-device.
3. Mints a KYC session on the backend and presents the hosted verification flow on-device.
4. Reacts to the outcome the moment the webhook lands server-side.

> **One sentence summary.** Your app only ever talks to **your backend**. The backend talks to id beyond with the `pk_live_*` secret. The SDK drives the hosted flow. Webhooks are the source of truth for `kycStatus`.

---

## 0. Prerequisites

On the server:

- A running operator backend (this repo) reachable from the device. Local dev is fine — `http://localhost:4499` by default.
- `IDBEYOND_SECRET` set to a real `pk_live_*` key.
- `KYC_RETURN_URL` set to a **Universal Link** that your iOS app owns (e.g. `https://app.example.com/kyc/return`). Configure the matching `apple-app-site-association` file on the web domain.
- `IDBEYOND_WEBHOOK_SECRET` set to a value you also paste into the id beyond dashboard's webhook secret field, and the dashboard's webhook URL pointing to your backend's `POST /webhooks/kyc`.

On the client:

- Xcode 15+.
- `IDBeyondKYC` Swift package added (`https://github.com/Uniicy/id-beyond-kyc-ios-sdk`, `1.0.0`).
- Associated Domains capability with `applinks:app.example.com` so your `returnUrl` opens the app.

---

## 1. End-to-end flow

```
┌────────────┐    1. signup/login       ┌──────────────────────┐
│   iOS app  │─────────────────────────▶│ Operator backend     │
│            │◀──── 2. {accessToken,  ──│  (this repo)         │
│            │       refreshToken}      │                      │
│            │                          │                      │
│            │    3. POST /kyc/sessions │                      │
│            │─────────────────────────▶│                      │
│            │◀──── 4. {sessionId,    ──│──── 5. pk_live_* ───▶│ id beyond API
│            │       hostedUrl}         │                      │
│            │                          │                      │
│            │ 6. ASWebAuthSession ────▶│                      │ id beyond
│            │    hostedUrl             │                      │ hosted flow
│            │◀── 7. returnUrl + status │                      │
│            │                          │                      │
│            │    8. GET /me            │◀─ 9. HMAC webhook ───│ id beyond
│            │─────────────────────────▶│   updates kyc_status │
│            │◀── {kycStatus: approved}─│                      │
└────────────┘                          └──────────────────────┘
```

Steps 1 and 2 run once per session. Steps 3–9 run every time a user needs KYC.

---

## 2. Create an API client

A minimal client wrapping the five routes you'll actually call.

```swift
import Foundation

struct AuthSession: Decodable {
    let accessToken: String
    let accessTokenExpiresIn: Int
    let refreshToken: String
    let refreshTokenExpiresAt: String
    let user: User
}

struct User: Decodable {
    let id: String
    let email: String
    let kycStatus: String
}

struct KYCSessionDTO: Decodable {
    let sessionId: String
    let hostedUrl: String
    let expiresAt: String
}

enum OperatorAPIError: Error {
    case network(URLError)
    case http(status: Int, code: String?, message: String?)
    case decoding(Error)
}

actor OperatorAPI {
    let baseURL: URL
    private let session = URLSession.shared

    init(baseURL: URL) {
        self.baseURL = baseURL
    }

    func signup(email: String, password: String) async throws -> AuthSession {
        try await post("/auth/signup", body: ["email": email, "password": password])
    }

    func login(email: String, password: String) async throws -> AuthSession {
        try await post("/auth/login", body: ["email": email, "password": password])
    }

    func refresh(refreshToken: String) async throws -> AuthSession {
        try await post("/auth/refresh", body: ["refreshToken": refreshToken])
    }

    func me(accessToken: String) async throws -> User {
        try await get("/me", accessToken: accessToken)
    }

    func createKYCSession(accessToken: String) async throws -> KYCSessionDTO {
        try await post("/kyc/sessions", body: [String: String](), accessToken: accessToken)
    }

    // MARK: - HTTP helpers

    private func get<T: Decodable>(_ path: String, accessToken: String? = nil) async throws -> T {
        var req = URLRequest(url: baseURL.appendingPathComponent(path))
        req.httpMethod = "GET"
        if let accessToken {
            req.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        }
        return try await perform(req)
    }

    private func post<T: Decodable>(
        _ path: String,
        body: [String: Any],
        accessToken: String? = nil
    ) async throws -> T {
        var req = URLRequest(url: baseURL.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let accessToken {
            req.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        }
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        return try await perform(req)
    }

    private func perform<T: Decodable>(_ req: URLRequest) async throws -> T {
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw OperatorAPIError.http(status: -1, code: nil, message: nil)
        }
        guard (200..<300).contains(http.statusCode) else {
            let err = try? JSONDecoder().decode(APIErrorBody.self, from: data)
            throw OperatorAPIError.http(
                status: http.statusCode,
                code: err?.error.code,
                message: err?.error.message
            )
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw OperatorAPIError.decoding(error)
        }
    }

    private struct APIErrorBody: Decodable {
        struct Inner: Decodable { let code: String; let message: String }
        let error: Inner
    }
}
```

---

## 3. Store tokens in the Keychain

Do **not** use `UserDefaults` or `@AppStorage` for tokens. The Keychain is the only location iOS zeroes out when the user removes the app or wipes the device, and it survives app reinstalls correctly with `kSecAttrAccessibleAfterFirstUnlock`.

```swift
import Security

enum TokenStore {
    private static let service = "com.yourop.app.auth"

    static func save(accessToken: String, refreshToken: String) throws {
        try write(key: "accessToken", value: accessToken)
        try write(key: "refreshToken", value: refreshToken)
    }

    static func accessToken() -> String? { read("accessToken") }
    static func refreshToken() -> String? { read("refreshToken") }

    static func clear() {
        delete("accessToken")
        delete("refreshToken")
    }

    // MARK: - Private

    private static func write(key: String, value: String) throws {
        let data = Data(value.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(query as CFDictionary)
        var add = query
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let status = SecItemAdd(add as CFDictionary, nil)
        if status != errSecSuccess { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
    }

    private static func read(_ key: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var out: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func delete(_ key: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
```

## 4. Signup / login screens

Use `OperatorAPI` above. On success, save the tokens and navigate into the app.

```swift
@MainActor
final class AuthViewModel: ObservableObject {
    @Published var isLoading = false
    @Published var errorText: String?

    let api: OperatorAPI

    init(api: OperatorAPI) { self.api = api }

    func signup(email: String, password: String) async {
        isLoading = true; defer { isLoading = false }
        do {
            let session = try await api.signup(email: email, password: password)
            try TokenStore.save(
                accessToken: session.accessToken,
                refreshToken: session.refreshToken
            )
            AppState.shared.didSignIn(user: session.user)
        } catch {
            errorText = (error as? OperatorAPIError).map(describe) ?? "\(error)"
        }
    }

    private func describe(_ err: OperatorAPIError) -> String {
        switch err {
        case .http(_, _, let message?): return message
        case .http(let status, _, _):   return "Request failed (\(status))"
        case .network:                  return "Network error"
        case .decoding:                 return "Unexpected response"
        }
    }
}
```

The same pattern covers `login`. `/auth/refresh` belongs in a URL-session interceptor — see [§ 8](#8-refresh-on-401).

---

## 5. Gate KYC-only features on `kycStatus`

After login (and on every warm launch), fetch `/me` to learn the current status.

```swift
func refreshUser() async throws {
    guard let access = TokenStore.accessToken() else { return }
    let user = try await api.me(accessToken: access)
    AppState.shared.user = user
}
```

Route the user based on `kycStatus`:

| `kycStatus` | What to show |
|---|---|
| `not_started` | "Verify your identity to continue." CTA opens the KYC flow. |
| `pending_review` | "We're reviewing your documents." Read-only state. |
| `approved` | Full app — no further KYC prompts. |
| `rejected` | Prompt to retry; clicking CTA mints a new session. |

---

## 6. Mint a KYC session and present the hosted flow

```swift
import IDBeyondKYC

@MainActor
final class KYCCoordinator {
    let api: OperatorAPI
    init(api: OperatorAPI) { self.api = api }

    func startVerification(presentingFrom viewController: UIViewController) async {
        guard let access = TokenStore.accessToken() else { return }

        do {
            let dto = try await api.createKYCSession(accessToken: access)
            let kycSession = KYCSession(
                sessionId: dto.sessionId,
                hostedUrl: dto.hostedUrl,
                expiresAt: ISO8601DateFormatter().date(from: dto.expiresAt) ?? .distantFuture
            )

            let result = try await KYCFlow().present(
                session: kycSession,
                from: viewController
            )
            // `result` is a KYCReturnStatus parsed from your returnUrl.
            // Treat it as advisory — the webhook is the source of truth.
            print("client-side status: \(result)")

            // Re-fetch `/me` so the UI updates to the new kycStatus.
            try? await Task.sleep(nanoseconds: 800_000_000)
            try? await AppState.shared.refreshUser(via: api)
        } catch {
            // Handle KYCError.userCancelled / KYCError.presentationFailed
            print("KYC flow failed: \(error)")
        }
    }
}
```

---

## 7. Configure Universal Links for the return URL

The hosted flow redirects to `KYC_RETURN_URL` when it's done (for example, `https://app.example.com/kyc/return?session_id=...&status=approved`). For this to open your app instead of Safari:

1. Host `.well-known/apple-app-site-association` on `app.example.com` with:

   ```json
   {
     "applinks": {
       "apps": [],
       "details": [
         {
           "appID": "ABCDE12345.com.yourop.app",
           "paths": ["/kyc/return"]
         }
       ]
     }
   }
   ```

2. In Xcode, add `applinks:app.example.com` under Signing & Capabilities → Associated Domains.
3. In your `SceneDelegate` / `App` struct, react to the incoming URL:

   ```swift
   .onOpenURL { url in
       guard url.path == "/kyc/return" else { return }
       let status = KYCReturnStatus.parse(from: url)
       // Navigate / refresh — but trust the webhook-driven `/me` for final truth.
   }
   ```

The `IDBeyondKYC` SDK's `KYCFlow` helper also surfaces the return URL via its async result; choose whichever integration point fits your navigation stack.

---

## 8. Refresh on 401

When an access token expires the backend returns `401 invalid_token`. Swap it for a new one transparently:

```swift
func authedRequest<T: Decodable>(_ block: (String) async throws -> T) async throws -> T {
    guard var access = TokenStore.accessToken() else { throw OperatorAPIError.http(status: 401, code: nil, message: nil) }

    do {
        return try await block(access)
    } catch OperatorAPIError.http(let status, _, _) where status == 401 {
        guard let refresh = TokenStore.refreshToken() else {
            TokenStore.clear()
            throw OperatorAPIError.http(status: 401, code: nil, message: nil)
        }
        let rotated = try await api.refresh(refreshToken: refresh)
        try TokenStore.save(
            accessToken: rotated.accessToken,
            refreshToken: rotated.refreshToken
        )
        access = rotated.accessToken
        return try await block(access)
    }
}
```

If `/auth/refresh` itself returns 401, clear the keychain and route back to the login screen.

---

## 9. Apple Sign In (optional)

Attach the standard `ASAuthorizationAppleIDProvider`, then POST the `identityToken` to `/auth/apple`:

```swift
func signInWithApple(credential: ASAuthorizationAppleIDCredential) async throws -> AuthSession {
    guard let tokenData = credential.identityToken,
          let identityToken = String(data: tokenData, encoding: .utf8) else {
        throw OperatorAPIError.http(status: 400, code: nil, message: nil)
    }
    var body: [String: Any] = ["identityToken": identityToken]
    if let email = credential.email { body["email"] = email }

    return try await api.post("/auth/apple", body: body)
}
```

The backend will upsert the Apple `sub` → `users.id` mapping and return the usual session shape. `AUTH_APPLE_CLIENT_ID` on the backend must match your app's bundle ID exactly.

---

## 10. Webhooks in one paragraph

You do not call the webhook; id beyond does. When the user finishes (or fails) the hosted flow, id beyond `POST`s to `/webhooks/kyc` with an HMAC-SHA256 signature. The backend verifies the signature against the **raw** request body, looks up the user via `externalUserId` (which is the `user.id` we sent on session creation), and updates `users.kyc_status` + `users.kyc_session_id`. The next time your app calls `/me`, it sees the fresh status. This is why the client-side return URL is advisory only: the user can close the web view before the webhook lands, but the webhook will still arrive and update the DB.

---

## 11. Local smoke test (no device needed)

```bash
# 1. Start the backend
docker compose up -d
pnpm dev

# 2. Sign up
curl -s -X POST http://localhost:4499/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","password":"correct-horse-staple"}' | tee /tmp/s.json

ACCESS=$(jq -r .accessToken /tmp/s.json)

# 3. Mint a KYC session
curl -s -X POST http://localhost:4499/kyc/sessions \
  -H "Authorization: Bearer $ACCESS"

# 4. Open the returned hostedUrl in a browser — that's exactly what
#    `KYCFlow().present(...)` would show in `ASWebAuthenticationSession`.

# 5. Simulate a webhook
USER_ID=$(jq -r .user.id /tmp/s.json)
BODY="{\"event\":\"verification.completed\",\"verificationSessionId\":\"11111111-1111-1111-1111-111111111111\",\"externalUserId\":\"$USER_ID\",\"decision\":\"approved\",\"reviewStatus\":\"approved\",\"rationale\":\"\"}"
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$IDBEYOND_WEBHOOK_SECRET" -hex | awk '{print $2}')
curl -X POST http://localhost:4499/webhooks/kyc \
  -H 'Content-Type: application/json' \
  -H "X-Verification-Signature: $SIG" \
  -d "$BODY"

# 6. Confirm
curl -s http://localhost:4499/me -H "Authorization: Bearer $ACCESS"
# → kycStatus: "approved"
```

Once that loop works with curl, the iOS code above runs exactly the same flow.
