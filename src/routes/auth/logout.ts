import { and, eq, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { z } from "zod";
import { getDb, type AppEnv } from "../../app.js";
import { refreshTokens } from "../../db/schema.js";
import { hashRefreshToken } from "../../lib/tokens.js";
import { AppError } from "../../middleware/error-handler.js";

const LogoutBody = z.object({
  refreshToken: z.string().min(1),
});

/**
 * Revoke a refresh token. Idempotent: revoking an already-revoked or
 * unknown token still returns 204 so clients can fire-and-forget on
 * app termination without error handling.
 */
export async function handleLogout(c: Context<AppEnv>): Promise<Response> {
  const body = LogoutBody.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) {
    throw new AppError(400, "Invalid body", "invalid_body");
  }

  const db = getDb(c);
  const tokenHash = hashRefreshToken(body.data.refreshToken);
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(eq(refreshTokens.tokenHash, tokenHash), isNull(refreshTokens.revokedAt)),
    );

  return c.body(null, 204);
}
