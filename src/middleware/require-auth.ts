import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { getConfig, getDb, type AppEnv } from "../app.js";
import { users } from "../db/schema.js";
import { verifyAccessToken } from "../lib/tokens.js";
import { AppError } from "./error-handler.js";

/**
 * Extracts a bearer access token from the Authorization header, verifies
 * the JWT signature + claims, loads the corresponding user row, and stashes
 * it on `c.var.user`. Handlers behind this middleware can rely on
 * `c.get("user")` being populated.
 *
 * Reasons to reject:
 *
 *  - No or malformed Authorization header → 401 `missing_bearer`
 *  - JWT invalid / expired              → 401 `invalid_token`
 *  - User no longer exists              → 401 `user_not_found`
 */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header("authorization");
  if (!header || !header.toLowerCase().startsWith("bearer ")) {
    throw new AppError(401, "Missing bearer token", "missing_bearer");
  }
  const token = header.slice("bearer ".length).trim();
  if (!token) {
    throw new AppError(401, "Missing bearer token", "missing_bearer");
  }

  const config = getConfig(c);
  let payload;
  try {
    payload = await verifyAccessToken(config.JWT_SECRET, token);
  } catch {
    throw new AppError(401, "Invalid or expired token", "invalid_token");
  }

  const db = getDb(c);
  const row = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, payload.userId))
    .limit(1);

  const user = row[0];
  if (!user) {
    throw new AppError(401, "User no longer exists", "user_not_found");
  }

  c.set("user", user);
  await next();
};
