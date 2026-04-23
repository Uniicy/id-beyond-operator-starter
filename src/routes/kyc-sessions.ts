import type { Context } from "hono";
import { getConfig, type AppEnv } from "../app.js";
import { createIdBeyondSession, IdBeyondApiError } from "../lib/idbeyond.js";
import { AppError } from "../middleware/error-handler.js";

/**
 * POST /kyc/sessions
 *
 * Authenticated proxy that mints an id beyond verification session on
 * behalf of the current user. The operator's `pk_live_*` secret only
 * lives server-side, never reaches the app.
 *
 * Returns the narrowed `{ sessionId, hostedUrl, expiresAt }` DTO the
 * IDBeyondKYC iOS SDK decodes via `JSONDecoder.idBeyondKYC()`.
 */
export async function handleCreateKycSession(c: Context<AppEnv>): Promise<Response> {
  const user = c.get("user");
  const config = getConfig(c);

  try {
    const session = await createIdBeyondSession(config, {
      externalUserId: user.id,
      returnUrl: config.KYC_RETURN_URL,
      metadata: { email: user.email },
    });
    return c.json(session, 201);
  } catch (err) {
    if (err instanceof IdBeyondApiError) {
      // Upstream failures are worth surfacing with a 502 so the client
      // knows to retry without invalidating the user session. We log the
      // upstream body server-side but do not leak it to the client.
      console.error("[kyc] id beyond API error", err.status, err.upstreamBody);
      throw new AppError(
        502,
        "Verification provider is currently unavailable",
        "kyc_provider_unavailable",
      );
    }
    throw err;
  }
}
