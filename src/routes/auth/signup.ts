import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { z } from "zod";
import { getConfig, getDb, type AppEnv } from "../../app.js";
import { users } from "../../db/schema.js";
import { issueAuthSession } from "../../lib/auth-session.js";
import { hashPassword } from "../../lib/password.js";
import { AppError } from "../../middleware/error-handler.js";

const SignupBody = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export async function handleSignup(c: Context<AppEnv>): Promise<Response> {
  const body = SignupBody.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) {
    throw new AppError(400, body.error.errors[0]?.message ?? "Invalid body", "invalid_body");
  }

  const db = getDb(c);
  const config = getConfig(c);

  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, body.data.email))
    .limit(1);
  if (existing.length > 0) {
    throw new AppError(409, "Email already registered", "email_taken");
  }

  const passwordHash = await hashPassword(body.data.password);
  const inserted = await db
    .insert(users)
    .values({ email: body.data.email, passwordHash })
    .returning();
  const user = inserted[0];
  if (!user) {
    throw new AppError(500, "Failed to create user", "signup_failed");
  }

  const session = await issueAuthSession({ db, jwtSecret: config.JWT_SECRET, user });
  return c.json(session, 201);
}
