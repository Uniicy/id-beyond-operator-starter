import type { AppConfig } from "../config.js";

/**
 * Narrowed response shape we forward to end-clients. The id beyond API
 * returns more than this (`token`, `clientSecret`) but those fields are
 * intended only for the browser SDK's client-side context — mobile apps
 * use the hosted flow and never need them. Stripping here is the critical
 * security boundary of this proxy route.
 */
export interface IdBeyondSessionDTO {
  sessionId: string;
  hostedUrl: string;
  expiresAt: string;
}

export interface CreateSessionParams {
  externalUserId: string;
  returnUrl: string;
  metadata?: Record<string, unknown>;
}

export class IdBeyondApiError extends Error {
  constructor(
    public override readonly message: string,
    public readonly status: number,
    public readonly upstreamBody: unknown,
  ) {
    super(message);
    this.name = "IdBeyondApiError";
  }
}

/**
 * Calls `POST /api/verification/sessions` on id beyond using the
 * operator's `pk_live_*` secret, then narrows the response to the DTO the
 * client (iOS SDK or any mobile consumer) expects.
 */
export async function createIdBeyondSession(
  config: Pick<AppConfig, "IDBEYOND_API_URL" | "IDBEYOND_SECRET">,
  params: CreateSessionParams,
  fetchImpl: typeof fetch = fetch,
): Promise<IdBeyondSessionDTO> {
  const resp = await fetchImpl(
    new URL("/api/verification/sessions", config.IDBEYOND_API_URL).toString(),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.IDBEYOND_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        externalUserId: params.externalUserId,
        returnUrl: params.returnUrl,
        metadata: params.metadata,
      }),
    },
  );

  const body = (await resp.json().catch(() => ({}))) as Record<string, unknown>;

  if (!resp.ok) {
    throw new IdBeyondApiError(
      typeof body["error"] === "string" ? body["error"] : "id beyond API request failed",
      resp.status,
      body,
    );
  }

  const sessionId = body["sessionId"];
  const hostedUrl = body["hostedUrl"];
  const expiresAt = body["expiresAt"];

  if (
    typeof sessionId !== "string" ||
    typeof hostedUrl !== "string" ||
    typeof expiresAt !== "string"
  ) {
    throw new IdBeyondApiError(
      "Unexpected id beyond response shape",
      502,
      body,
    );
  }

  return { sessionId, hostedUrl, expiresAt };
}
