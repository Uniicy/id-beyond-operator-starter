import { createHash, randomBytes } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

/**
 * Short access-token TTL (15 min). The refresh token carries the
 * long-lived identity; leaking the access token should lose at most
 * 15 minutes of authority.
 */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

/**
 * Long refresh-token TTL (30 days). Stored hashed in `refresh_tokens`
 * and rotated on every `/auth/refresh`.
 */
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

const JWT_ISSUER = "id-beyond-operator";
const JWT_AUDIENCE = "id-beyond-operator";

interface AccessTokenClaims {
  userId: string;
  email: string;
}

export interface AccessTokenPayload extends AccessTokenClaims {
  iat: number;
  exp: number;
  iss: string;
  aud: string;
  sub: string;
}

function jwtKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signAccessToken(
  secret: string,
  claims: AccessTokenClaims,
): Promise<string> {
  return new SignJWT({ email: claims.email })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setSubject(claims.userId)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(jwtKey(secret));
}

export async function verifyAccessToken(
  secret: string,
  token: string,
): Promise<AccessTokenPayload> {
  const { payload } = await jwtVerify(token, jwtKey(secret), {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });
  if (typeof payload.sub !== "string" || typeof payload.email !== "string") {
    throw new Error("invalid_access_token");
  }
  return {
    ...(payload as Record<string, unknown>),
    userId: payload.sub,
    email: payload.email,
  } as AccessTokenPayload;
}

/**
 * Opaque refresh token. We return the plaintext to the client exactly
 * once; the database stores only the SHA-256 hash. 48 random bytes base64url
 * encoded gives ~64 character tokens with 384 bits of entropy — well above
 * any reasonable brute-force threshold.
 */
export function mintRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(48).toString("base64url");
  const hash = hashRefreshToken(token);
  return { token, hash };
}

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function refreshTokenExpiresAt(now: Date = new Date()): Date {
  return new Date(now.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000);
}
