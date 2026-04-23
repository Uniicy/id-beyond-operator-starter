import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { z } from "zod";
import { getConfig, getDb, type AppEnv } from "../../app.js";
import { appleSubjects, users } from "../../db/schema.js";
import { verifyAppleIdentityToken } from "../../lib/apple-jwks.js";
import { issueAuthSession } from "../../lib/auth-session.js";
import { AppError } from "../../middleware/error-handler.js";

const AppleBody = z.object({
  identityToken: z.string().min(1),
  /**
   * iOS returns `givenName` / `familyName` only on the FIRST sign-in for
   * a given Apple ID. Forward them once; subsequent logins carry no name.
   * We don't use them server-side here but accept the shape so clients
   * can pass through without a 400.
   */
  email: z.string().email().optional(),
});

/**
 * POST /auth/apple
 *
 * Exchanges an Apple `identityToken` (from
 * `ASAuthorizationAppleIDCredential.identityToken`) for a fresh auth
 * session. Find-or-create semantics: if we've never seen this Apple `sub`,
 * we provision a user row, keyed on the email Apple reports (or a synthetic
 * one if Apple hid it). Otherwise we reuse the existing mapping.
 */
export async function handleApple(c: Context<AppEnv>): Promise<Response> {
  const body = AppleBody.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) {
    throw new AppError(400, "Invalid body", "invalid_body");
  }

  const config = getConfig(c);
  if (!config.AUTH_APPLE_CLIENT_ID) {
    throw new AppError(
      503,
      "Apple Sign In is not configured on this server",
      "apple_not_configured",
    );
  }

  let identity;
  try {
    identity = await verifyAppleIdentityToken(
      body.data.identityToken,
      config.AUTH_APPLE_CLIENT_ID,
    );
  } catch {
    throw new AppError(401, "Invalid Apple identity token", "invalid_apple_token");
  }

  const db = getDb(c);

  const existing = (
    await db
      .select({ userId: appleSubjects.userId })
      .from(appleSubjects)
      .where(eq(appleSubjects.sub, identity.sub))
      .limit(1)
  )[0];

  let user;
  if (existing) {
    user = (
      await db.select().from(users).where(eq(users.id, existing.userId)).limit(1)
    )[0];
  } else {
    // Apple may hide the email via private relay or withhold it on
    // subsequent logins. Fall back to a synthetic local-part so the
    // `users.email` UNIQUE constraint holds.
    const email =
      body.data.email ?? identity.email ?? `${identity.sub}@apple.private-relay.local`;

    user = (await db.insert(users).values({ email }).returning())[0];
    if (!user) {
      throw new AppError(500, "Failed to create user", "apple_user_create_failed");
    }
    await db.insert(appleSubjects).values({
      sub: identity.sub,
      userId: user.id,
    });
  }

  if (!user) {
    throw new AppError(500, "Failed to resolve user", "apple_user_resolve_failed");
  }

  const session = await issueAuthSession({ db, jwtSecret: config.JWT_SECRET, user });
  return c.json(session, 200);
}
