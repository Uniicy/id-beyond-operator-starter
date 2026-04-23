import { eq } from "drizzle-orm";
import { createHmac } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { users } from "../src/db/schema.js";
import {
  createTestContext,
  request,
  type TestContext,
} from "./helpers/test-app.js";

let ctx: TestContext;
let session: { accessToken: string; refreshToken: string; user: { id: string } };

async function signup(): Promise<typeof session> {
  const res = await request<typeof session>(ctx, "/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "dave@example.com", password: "correct-horse-staple" }),
  });
  return res.body;
}

beforeAll(async () => {
  ctx = await createTestContext();
  session = await signup();
});

afterAll(async () => {
  await ctx.cleanup();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("GET /me", () => {
  it("returns the current user when authenticated", async () => {
    const res = await request<{ id: string; email: string; kycStatus: string }>(
      ctx,
      "/me",
      { headers: { Authorization: `Bearer ${session.accessToken}` } },
    );
    expect(res.status).toBe(200);
    expect(res.body.email).toBe("dave@example.com");
    expect(res.body.kycStatus).toBe("not_started");
  });

  it("rejects missing bearer tokens with 401", async () => {
    const res = await request<{ error: { code: string } }>(ctx, "/me");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("missing_bearer");
  });
});

describe("POST /kyc/sessions", () => {
  it("mints a session and strips clientSecret before returning", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          sessionId: "c3ae1b0c-59f1-4b55-bf2d-34d2a50ebe4a",
          token: "tok_SHOULD_NOT_LEAK",
          clientSecret: "secret_SHOULD_NOT_LEAK",
          hostedUrl: "https://verify.example.test/flow/c3ae1b0c",
          expiresAt: "2026-01-01T00:00:00.000Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const res = await request<Record<string, unknown>>(ctx, "/kyc/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      sessionId: "c3ae1b0c-59f1-4b55-bf2d-34d2a50ebe4a",
      hostedUrl: "https://verify.example.test/flow/c3ae1b0c",
      expiresAt: "2026-01-01T00:00:00.000Z",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0] as unknown as [unknown, RequestInit];
    expect(String(call[0])).toBe("https://api.idbeyond.test/api/verification/sessions");
    const body = JSON.parse(String(call[1].body));
    expect(body.externalUserId).toBe(session.user.id);
    expect(body.returnUrl).toBe("https://app.example.test/kyc/return");
  });

  it("returns 401 when unauthenticated", async () => {
    const res = await request<{ error: { code: string } }>(ctx, "/kyc/sessions", {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  it("surfaces upstream failures as 502", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "bad" }), { status: 500 }),
      ),
    );
    const res = await request<{ error: { code: string } }>(ctx, "/kyc/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("kyc_provider_unavailable");
  });
});

describe("POST /webhooks/kyc", () => {
  const WEBHOOK_SECRET = "test-webhook-shared-secret-1234";

  function signedRequest(body: unknown, secret = WEBHOOK_SECRET): RequestInit {
    const raw = JSON.stringify(body);
    const signature = createHmac("sha256", secret).update(raw).digest("hex");
    return {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Verification-Signature": signature,
      },
      body: raw,
    };
  }

  it("updates users.kyc_status on a valid approved webhook", async () => {
    const res = await request(
      ctx,
      "/webhooks/kyc",
      signedRequest({
        event: "verification.completed",
        verificationSessionId: "11111111-1111-1111-1111-111111111111",
        externalUserId: session.user.id,
        decision: "approved",
        reviewStatus: "approved",
        rationale: "",
      }),
    );
    expect(res.status).toBe(200);

    const row = await ctx.db.select().from(users).where(eq(users.id, session.user.id));
    expect(row[0]?.kycStatus).toBe("approved");
    expect(row[0]?.kycSessionId).toBe("11111111-1111-1111-1111-111111111111");
  });

  it("rejects tampered bodies with 401", async () => {
    const body = {
      event: "verification.completed",
      externalUserId: session.user.id,
      decision: "rejected",
    };
    const raw = JSON.stringify(body);
    const signature = createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");

    // Change the payload AFTER signing — signature no longer matches.
    const tampered = JSON.stringify({ ...body, decision: "approved" });

    const res = await request<{ error: { code: string } }>(ctx, "/webhooks/kyc", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Verification-Signature": signature,
      },
      body: tampered,
    });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("invalid_signature");
  });

  it("rejects requests without a signature", async () => {
    const res = await request<{ error: { code: string } }>(ctx, "/webhooks/kyc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "verification.completed",
        externalUserId: session.user.id,
      }),
    });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("missing_signature");
  });

  it("ignores unknown event types idempotently", async () => {
    const res = await request<{ ok: boolean; ignored: boolean }>(
      ctx,
      "/webhooks/kyc",
      signedRequest({
        event: "verification.extraction",
        externalUserId: session.user.id,
      }),
    );
    expect(res.status).toBe(200);
    expect(res.body.ignored).toBe(true);
  });
});
