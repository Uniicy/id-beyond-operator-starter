import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestContext,
  request,
  type TestContext,
} from "./helpers/test-app.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

interface AuthSession {
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string; kycStatus: string };
}

interface ErrorBody {
  error: { code: string; message: string };
}

function jsonRequest(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

describe("POST /auth/signup", () => {
  it("creates a user and returns a session", async () => {
    const res = await request<AuthSession>(
      ctx,
      "/auth/signup",
      jsonRequest({ email: "alice@example.com", password: "correct-horse-staple" }),
    );
    expect(res.status).toBe(201);
    expect(res.body.accessToken).toMatch(/^eyJ/);
    expect(res.body.refreshToken.length).toBeGreaterThan(40);
    expect(res.body.user.email).toBe("alice@example.com");
    expect(res.body.user.kycStatus).toBe("not_started");
  });

  it("rejects duplicate emails with 409", async () => {
    const res = await request<ErrorBody>(
      ctx,
      "/auth/signup",
      jsonRequest({ email: "alice@example.com", password: "correct-horse-staple" }),
    );
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("email_taken");
  });

  it("rejects short passwords with 400", async () => {
    const res = await request<ErrorBody>(
      ctx,
      "/auth/signup",
      jsonRequest({ email: "bob@example.com", password: "short" }),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /auth/login", () => {
  it("issues a new session on valid credentials", async () => {
    const res = await request<AuthSession>(
      ctx,
      "/auth/login",
      jsonRequest({ email: "alice@example.com", password: "correct-horse-staple" }),
    );
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe("alice@example.com");
  });

  it("rejects bad passwords with 401", async () => {
    const res = await request<ErrorBody>(
      ctx,
      "/auth/login",
      jsonRequest({ email: "alice@example.com", password: "wrong-password" }),
    );
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("invalid_credentials");
  });

  it("returns the same error for unknown users (no account enumeration)", async () => {
    const res = await request<ErrorBody>(
      ctx,
      "/auth/login",
      jsonRequest({ email: "nobody@example.com", password: "anything-long-enough" }),
    );
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("invalid_credentials");
  });
});

describe("POST /auth/refresh and /auth/logout", () => {
  it("rotates tokens on refresh and revokes on logout", async () => {
    const login = await request<AuthSession>(
      ctx,
      "/auth/login",
      jsonRequest({ email: "alice@example.com", password: "correct-horse-staple" }),
    );
    const original = login.body.refreshToken;

    const refreshed = await request<AuthSession>(
      ctx,
      "/auth/refresh",
      jsonRequest({ refreshToken: original }),
    );
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.refreshToken).not.toBe(original);

    // The original token is now revoked — using it again must fail.
    const reused = await request<ErrorBody>(
      ctx,
      "/auth/refresh",
      jsonRequest({ refreshToken: original }),
    );
    expect(reused.status).toBe(401);

    // Logging out the current token makes it unusable too.
    const logout = await request(
      ctx,
      "/auth/logout",
      jsonRequest({ refreshToken: refreshed.body.refreshToken }),
    );
    expect(logout.status).toBe(204);

    const afterLogout = await request<ErrorBody>(
      ctx,
      "/auth/refresh",
      jsonRequest({ refreshToken: refreshed.body.refreshToken }),
    );
    expect(afterLogout.status).toBe(401);
  });
});

describe("magic-link round trip", () => {
  it("issues a session via request + verify", async () => {
    const email = "carol@example.com";
    let capturedUrl: string | null = null;

    // Capture the console output so we can extract the token without
    // depending on the real email transport.
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      for (const arg of args) {
        if (typeof arg === "string" && arg.includes("verify URL:")) {
          capturedUrl = arg.split("verify URL:")[1]?.trim() ?? null;
        }
      }
    };

    try {
      const requested = await request(
        ctx,
        "/auth/magic-link/request",
        jsonRequest({ email }),
      );
      expect(requested.status).toBe(202);
    } finally {
      console.log = originalLog;
    }

    expect(capturedUrl).not.toBeNull();
    const token = new URL(capturedUrl as unknown as string).searchParams.get("token");
    expect(token).toBeTruthy();

    const verified = await request<AuthSession>(
      ctx,
      "/auth/magic-link/verify",
      jsonRequest({ token }),
    );
    expect(verified.status).toBe(200);
    expect(verified.body.user.email).toBe(email);

    // Replay must fail.
    const replay = await request<ErrorBody>(
      ctx,
      "/auth/magic-link/verify",
      jsonRequest({ token }),
    );
    expect(replay.status).toBe(401);
  });
});
