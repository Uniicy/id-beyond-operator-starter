import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { z } from "zod";
import { getConfig, getDb, type AppEnv } from "../../app.js";
import { magicLinkTokens, users } from "../../db/schema.js";
import { issueAuthSession } from "../../lib/auth-session.js";
import { selectEmailTransport } from "../../lib/email.js";
import { hashRefreshToken } from "../../lib/tokens.js";
import { AppError } from "../../middleware/error-handler.js";

const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;

const RequestBody = z.object({
  email: z.string().trim().toLowerCase().email(),
});

const VerifyBody = z.object({
  token: z.string().min(1),
});

/**
 * POST /auth/magic-link/request
 *
 * Accepts an email. If the user exists we create one; otherwise we reuse
 * the existing row. We deliberately return 202 regardless so attackers
 * cannot probe the endpoint to discover which emails have accounts.
 *
 * The token returned to the caller is a random 32-byte base64url string.
 * The database stores only the SHA-256 hash. The plaintext reaches the
 * user via email (in dev, via the console transport).
 */
export async function handleMagicLinkRequest(c: Context<AppEnv>): Promise<Response> {
  const body = RequestBody.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) {
    throw new AppError(400, "Invalid body", "invalid_body");
  }

  const db = getDb(c);
  const config = getConfig(c);

  let user = (
    await db
      .select()
      .from(users)
      .where(eq(users.email, body.data.email))
      .limit(1)
  )[0];

  // Passwordless-first signup: the email's owner proves possession by
  // clicking the link, so creating the row on-request is safe.
  if (!user) {
    const inserted = await db
      .insert(users)
      .values({ email: body.data.email })
      .returning();
    user = inserted[0];
    if (!user) {
      throw new AppError(500, "Failed to create user", "magic_link_user_create_failed");
    }
  }

  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashRefreshToken(token); // SHA-256 reused for storage
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MS);

  await db.insert(magicLinkTokens).values({
    tokenHash,
    userId: user.id,
    expiresAt,
  });

  // Verification URL points at the operator's web/app return handler,
  // which will POST the token to /auth/magic-link/verify. Universal Links
  // make this open the mobile app directly.
  const verifyUrl = `${config.KYC_RETURN_URL.replace(/\/kyc\/return$/, "")}/auth/magic-link?token=${encodeURIComponent(token)}`;

  const transport = selectEmailTransport(config);
  await transport.sendMagicLink({ to: user.email, verifyUrl, expiresAt });

  return c.json({ status: "sent", expiresAt: expiresAt.toISOString() }, 202);
}

/**
 * POST /auth/magic-link/verify
 *
 * Consumes a magic-link token and returns a fresh auth session. Tokens
 * are single-use: consuming one marks `used_at` immediately. We never
 * delete the row so replay attempts remain auditable.
 */
export async function handleMagicLinkVerify(c: Context<AppEnv>): Promise<Response> {
  const body = VerifyBody.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) {
    throw new AppError(400, "Invalid body", "invalid_body");
  }

  const db = getDb(c);
  const config = getConfig(c);

  const tokenHash = hashRefreshToken(body.data.token);
  const now = new Date();

  const rows = await db
    .select({
      tokenHash: magicLinkTokens.tokenHash,
      userId: magicLinkTokens.userId,
    })
    .from(magicLinkTokens)
    .where(
      and(
        eq(magicLinkTokens.tokenHash, tokenHash),
        gt(magicLinkTokens.expiresAt, now),
        isNull(magicLinkTokens.usedAt),
      ),
    )
    .limit(1);
  const record = rows[0];
  if (!record) {
    throw new AppError(401, "Invalid or expired magic link", "invalid_magic_link");
  }

  // Consume first so a concurrent verify on the same token fails.
  const consumed = await db
    .update(magicLinkTokens)
    .set({ usedAt: now })
    .where(
      and(eq(magicLinkTokens.tokenHash, record.tokenHash), isNull(magicLinkTokens.usedAt)),
    )
    .returning({ tokenHash: magicLinkTokens.tokenHash });
  if (consumed.length === 0) {
    throw new AppError(401, "Invalid or expired magic link", "invalid_magic_link");
  }

  const userRows = await db.select().from(users).where(eq(users.id, record.userId)).limit(1);
  const user = userRows[0];
  if (!user) {
    throw new AppError(401, "Invalid or expired magic link", "invalid_magic_link");
  }

  const session = await issueAuthSession({ db, jwtSecret: config.JWT_SECRET, user });
  return c.json(session, 200);
}
