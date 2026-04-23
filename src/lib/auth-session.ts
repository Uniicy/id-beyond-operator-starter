import type { Database } from "../db/client.js";
import { refreshTokens, users } from "../db/schema.js";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  mintRefreshToken,
  refreshTokenExpiresAt,
  signAccessToken,
} from "./tokens.js";

export interface AuthSessionResponse {
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  user: {
    id: string;
    email: string;
    kycStatus: typeof users.$inferSelect.kycStatus;
  };
}

interface IssueSessionParams {
  db: Database;
  jwtSecret: string;
  user: typeof users.$inferSelect;
}

/**
 * Mint a fresh pair of tokens, persist the refresh token hash, and return
 * the response shape clients consume. Called at the end of every successful
 * login / signup / magic-link / Apple route.
 */
export async function issueAuthSession({
  db,
  jwtSecret,
  user,
}: IssueSessionParams): Promise<AuthSessionResponse> {
  const accessToken = await signAccessToken(jwtSecret, {
    userId: user.id,
    email: user.email,
  });

  const refresh = mintRefreshToken();
  const expiresAt = refreshTokenExpiresAt();

  await db.insert(refreshTokens).values({
    userId: user.id,
    tokenHash: refresh.hash,
    expiresAt,
  });

  return {
    accessToken,
    accessTokenExpiresIn: ACCESS_TOKEN_TTL_SECONDS,
    refreshToken: refresh.token,
    refreshTokenExpiresAt: expiresAt.toISOString(),
    user: {
      id: user.id,
      email: user.email,
      kycStatus: user.kycStatus,
    },
  };
}
