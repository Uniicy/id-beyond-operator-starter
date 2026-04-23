import argon2 from "argon2";

/**
 * OWASP-recommended Argon2id parameters (2023 guidance): 19 MiB memory,
 * 2 iterations, parallelism 1. Matches the t=2, m=19456, p=1 profile used
 * by the `password` library and modern PHP `password_hash()` defaults.
 */
const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, ARGON2_OPTIONS);
}

/**
 * Returns true iff `plain` matches `hash`. Argon2 already provides a
 * constant-time comparison internally, so no timing-safe wrapping is
 * needed here.
 */
export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}
