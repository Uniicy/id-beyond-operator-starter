import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { z } from "zod";
import { getConfig, getDb, type AppEnv } from "../../app.js";
import { users } from "../../db/schema.js";
import { issueAuthSession } from "../../lib/auth-session.js";
import { verifyPassword } from "../../lib/password.js";
import { AppError } from "../../middleware/error-handler.js";

const LoginBody = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

export async function handleLogin(c: Context<AppEnv>): Promise<Response> {
  const body = LoginBody.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) {
    throw new AppError(400, "Invalid body", "invalid_body");
  }

  const db = getDb(c);
  const config = getConfig(c);

  const rows = await db
    .select()
    .from(users)
    .where(eq(users.email, body.data.email))
    .limit(1);
  const user = rows[0];

  // Using a uniform error shape for "user not found" and "bad password"
  // avoids leaking account existence to attackers probing the endpoint.
  if (!user || !user.passwordHash) {
    throw new AppError(401, "Invalid credentials", "invalid_credentials");
  }

  const ok = await verifyPassword(user.passwordHash, body.data.password);
  if (!ok) {
    throw new AppError(401, "Invalid credentials", "invalid_credentials");
  }

  const session = await issueAuthSession({ db, jwtSecret: config.JWT_SECRET, user });
  return c.json(session, 200);
}
