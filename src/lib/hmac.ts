import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies an HMAC-SHA256 hex signature against the raw request body
 * in constant time. id beyond signs with the per-session webhook secret
 * (or the env-level fallback) using the same algorithm.
 *
 * The comparison MUST run on the untouched bytes of the HTTP body — not
 * the parsed JSON — because JSON reserialization can reorder keys or
 * change whitespace and break the signature.
 */
export function verifyHmacSignature(
  secret: string,
  body: Buffer | string,
  signatureHex: string,
): boolean {
  const expected = createHmac("sha256", secret).update(body).digest();

  let provided: Buffer;
  try {
    provided = Buffer.from(signatureHex, "hex");
  } catch {
    return false;
  }

  if (provided.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(provided, expected);
}
