import { and, eq, gt, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { z } from "zod";
import { getConfig, getDb, type AppEnv } from "../../app.js";
import { refreshTokens, users } from "../../db/schema.js";
import { issueAuthSession } from "../../lib/auth-session.js";
import { hashRefreshToken } from "../../lib/tokens.js";
import { AppError } from "../../middleware/error-handler.js";

const RefreshBody = z.object({
  refreshToken: z.string().min(1),
});

/**
 * Exchange an opaque refresh token for a fresh access + refresh token pair.
 * Old refresh token is marked revoked (rotation) to limit blast radius if
 * a refresh token leaks.
 */
export async function handleRefresh(c: Context<AppEnv>): Promise<Response> {
  const body = RefreshBody.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) {
    throw new AppError(400, "Invalid body", "invalid_body");
  }

  const db = getDb(c);
  const config = getConfig(c);

  const tokenHash = hashRefreshToken(body.data.refreshToken);
  const now = new Date();

  const rows = await db
    .select()
    .from(refreshTokens)
    .where(
      and(
        eq(refreshTokens.tokenHash, tokenHash),
        gt(refreshTokens.expiresAt, now),
        isNull(refreshTokens.revokedAt),
      ),
    )
    .limit(1);
  const record = rows[0];
  if (!record) {
    throw new AppError(401, "Invalid refresh token", "invalid_refresh_token");
  }

  const userRows = await db
    .select()
    .from(users)
    .where(eq(users.id, record.userId))
    .limit(1);
  const user = userRows[0];
  if (!user) {
    throw new AppError(401, "Invalid refresh token", "invalid_refresh_token");
  }

  await db
    .update(refreshTokens)
    .set({ revokedAt: now })
    .where(eq(refreshTokens.id, record.id));

  const session = await issueAuthSession({ db, jwtSecret: config.JWT_SECRET, user });
  return c.json(session, 200);
}
