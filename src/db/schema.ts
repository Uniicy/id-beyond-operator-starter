import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Advisory KYC status mirrored from the id beyond webhook. The client cares
 * about four states:
 *
 *  - `not_started`  — user has not kicked off a session yet
 *  - `pending_review` — session finished, id beyond is reviewing
 *  - `approved`     — webhook confirmed the verification
 *  - `rejected`     — webhook confirmed a failure
 *
 * The webhook handler is the single writer of this column — never update it
 * optimistically from the client callback.
 */
export const KYC_STATUS_VALUES = [
  "not_started",
  "pending_review",
  "approved",
  "rejected",
] as const;
export type KycStatus = (typeof KYC_STATUS_VALUES)[number];

/**
 * End-users of the operator app. `password_hash` is nullable so magic-link
 * and Apple-only accounts exist without a password on record.
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").notNull().unique(),
    passwordHash: text("password_hash"),
    kycStatus: text("kyc_status", { enum: KYC_STATUS_VALUES })
      .notNull()
      .default("not_started"),
    kycSessionId: text("kyc_session_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdate(() => new Date()),
  },
  (t) => [index("users_email_idx").on(t.email)],
);

/**
 * One row per active device / session. `token_hash` is a SHA-256 of the
 * opaque refresh token — we never store the plaintext so a DB leak can't
 * resurrect sessions. `revoked_at` enables logout / session revocation
 * without deleting the row (useful for audit).
 */
export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("refresh_tokens_user_idx").on(t.userId),
    index("refresh_tokens_expires_idx").on(t.expiresAt),
  ],
);

/**
 * Single-use magic-link tokens. Stored hashed so an attacker with database
 * read access cannot mint logins. `used_at` marks consumption; we never
 * delete rows so we can audit replay attempts.
 */
export const magicLinkTokens = pgTable(
  "magic_link_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index("magic_link_tokens_user_idx").on(t.userId)],
);

/**
 * Apple Sign-In mapping. `sub` is Apple's opaque user identifier — stable
 * across devices, unique per app / team. Multiple `users` rows cannot share
 * a `sub`; we enforce that with PK.
 */
export const appleSubjects = pgTable("apple_subjects", {
  sub: text("sub").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});
