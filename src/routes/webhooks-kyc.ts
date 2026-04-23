import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { z } from "zod";
import { getConfig, getDb, type AppEnv } from "../app.js";
import { users, type KycStatus } from "../db/schema.js";
import { verifyHmacSignature } from "../lib/hmac.js";
import { AppError } from "../middleware/error-handler.js";

/**
 * Minimal schema for the id beyond webhook body. Anything we don't use
 * is tolerated so version-forward payloads keep working.
 *
 * `externalUserId` is the key — it matches the `user.id` we sent on
 * session creation. Any other identifier in the payload is ignored here;
 * if you want to double-check the session belongs to this user, store
 * `kyc_session_id` on the user row and compare.
 */
const WebhookBody = z.object({
  event: z.string(),
  verificationSessionId: z.string().uuid().optional(),
  externalUserId: z.string().min(1),
  decision: z.enum(["approved", "rejected"]).optional(),
  reviewStatus: z.string().optional(),
});

function mapReviewStatus(
  reviewStatus: string | undefined,
  decision: "approved" | "rejected" | undefined,
): KycStatus {
  // Prefer the decision when id beyond emits a terminal call. `reviewStatus`
  // is used for transitional states (pending review) not fully captured by
  // the boolean decision field.
  if (decision === "approved") return "approved";
  if (decision === "rejected") return "rejected";

  switch (reviewStatus) {
    case "approved":
      return "approved";
    case "rejected":
      return "rejected";
    case "pending_review":
    case "pending":
      return "pending_review";
    default:
      return "pending_review";
  }
}

/**
 * POST /webhooks/kyc
 *
 * Signed by id beyond with HMAC-SHA256 in `X-Verification-Signature`.
 * Rejects anything without a valid signature. The response is always a
 * 2xx once the signature is verified — idempotent upserts keep replay
 * attempts (and at-least-once delivery) safe.
 */
export async function handleKycWebhook(c: Context<AppEnv>): Promise<Response> {
  const config = getConfig(c);

  // Capture raw bytes BEFORE parsing. Hono's `c.req.raw` is the WHATWG
  // Request; `.clone()` + `.text()` lets us still call `c.req.json()` if
  // we wanted, but we parse the captured text directly to avoid a second
  // body read.
  const raw = await c.req.raw.clone().text();

  const signature = c.req.header("x-verification-signature");
  if (!signature) {
    throw new AppError(401, "Missing signature", "missing_signature");
  }
  if (!verifyHmacSignature(config.IDBEYOND_WEBHOOK_SECRET, raw, signature)) {
    throw new AppError(401, "Invalid signature", "invalid_signature");
  }

  let parsed: z.infer<typeof WebhookBody>;
  try {
    parsed = WebhookBody.parse(JSON.parse(raw));
  } catch {
    throw new AppError(400, "Invalid webhook body", "invalid_body");
  }

  if (parsed.event !== "verification.completed") {
    // Unknown event types are acknowledged so id beyond doesn't retry.
    return c.json({ ok: true, ignored: true }, 200);
  }

  const newStatus = mapReviewStatus(parsed.reviewStatus, parsed.decision);
  const db = getDb(c);

  await db
    .update(users)
    .set({
      kycStatus: newStatus,
      kycSessionId: parsed.verificationSessionId ?? null,
    })
    .where(eq(users.id, parsed.externalUserId));

  return c.json({ ok: true }, 200);
}
