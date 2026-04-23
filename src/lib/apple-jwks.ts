import { createRemoteJWKSet, jwtVerify } from "jose";

const APPLE_JWKS_URL = new URL("https://appleid.apple.com/auth/keys");
const APPLE_ISSUER = "https://appleid.apple.com";

/**
 * Lazy singleton. The JWKS client caches keys in-process so we hit Apple
 * at most once per key-rotation window (~24h) per server process.
 */
let jwksCache: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (!jwksCache) {
    jwksCache = createRemoteJWKSet(APPLE_JWKS_URL);
  }
  return jwksCache;
}

export interface VerifiedAppleIdentity {
  sub: string;
  email?: string;
  emailVerified: boolean;
}

/**
 * Verify an Apple ID token against Apple's public JWKS.
 *
 * The token is the `identityToken` field returned by
 * `ASAuthorizationAppleIDCredential` on iOS (or the equivalent from
 * Sign-in-with-Apple-JS). `audience` must match your Apple service
 * identifier — the app's bundle ID for native iOS.
 *
 * Throws on:
 *   - missing / malformed JWT
 *   - signature verification failure
 *   - expired token (Apple tokens are typically 10-minute validity)
 *   - issuer mismatch
 *   - audience mismatch
 */
export async function verifyAppleIdentityToken(
  token: string,
  audience: string,
): Promise<VerifiedAppleIdentity> {
  const { payload } = await jwtVerify(token, getJwks(), {
    issuer: APPLE_ISSUER,
    audience,
  });

  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new Error("apple_token_missing_sub");
  }

  const email = typeof payload.email === "string" ? payload.email : undefined;
  const emailVerified =
    payload.email_verified === true || payload.email_verified === "true";

  return {
    sub: payload.sub,
    email,
    emailVerified,
  };
}
