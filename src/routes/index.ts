import type { App } from "../app.js";
import { requireAuth } from "../middleware/require-auth.js";
import { handleApple } from "./auth/apple.js";
import { handleLogin } from "./auth/login.js";
import { handleLogout } from "./auth/logout.js";
import {
  handleMagicLinkRequest,
  handleMagicLinkVerify,
} from "./auth/magic-link.js";
import { handleRefresh } from "./auth/refresh.js";
import { handleSignup } from "./auth/signup.js";
import { handleCreateKycSession } from "./kyc-sessions.js";
import { handleMe } from "./me.js";
import { handleKycWebhook } from "./webhooks-kyc.js";

/**
 * Route registration entry point. Kept in one file so `src/index.ts` stays
 * dependency-free and the test harness can register the same surface.
 */
export function registerRoutes(app: App): void {
  app.post("/auth/signup", handleSignup);
  app.post("/auth/login", handleLogin);
  app.post("/auth/logout", handleLogout);
  app.post("/auth/refresh", handleRefresh);
  app.post("/auth/magic-link/request", handleMagicLinkRequest);
  app.post("/auth/magic-link/verify", handleMagicLinkVerify);
  app.post("/auth/apple", handleApple);

  app.get("/me", requireAuth, handleMe);

  app.post("/kyc/sessions", requireAuth, handleCreateKycSession);

  app.post("/webhooks/kyc", handleKycWebhook);
}
