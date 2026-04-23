import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { getDb, type AppEnv } from "../app.js";
import { users } from "../db/schema.js";
import { AppError } from "../middleware/error-handler.js";

/**
 * GET /me
 *
 * Requires `requireAuth`. Returns the full, up-to-date user row so the
 * client can read the webhook-written `kycStatus` (the source of truth for
 * whether to unlock KYC-gated features).
 */
export async function handleMe(c: Context<AppEnv>): Promise<Response> {
  const authed = c.get("user");
  const db = getDb(c);

  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      kycStatus: users.kycStatus,
      kycSessionId: users.kycSessionId,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, authed.id))
    .limit(1);
  const user = rows[0];
  if (!user) {
    throw new AppError(401, "User no longer exists", "user_not_found");
  }

  return c.json({
    id: user.id,
    email: user.email,
    kycStatus: user.kycStatus,
    kycSessionId: user.kycSessionId,
    createdAt: user.createdAt.toISOString(),
  });
}
