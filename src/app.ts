import { Hono } from "hono";
import { logger } from "hono/logger";
import type { AppConfig } from "./config.js";
import type { Database } from "./db/client.js";
import { errorHandler } from "./middleware/error-handler.js";

/**
 * Request-scoped values set by middleware or route handlers.
 *
 * - `config` / `db` are seeded by `buildApp` before any route runs, so
 *   handlers can resolve them with `c.get("config")` / `c.get("db")`.
 * - `user` is populated by `requireAuth`; absence means the caller is
 *   anonymous.
 * - `refreshTokenId` is set by the refresh-token middleware on `/auth/refresh`
 *   and `/auth/logout`.
 */
export type AppVariables = {
  config: AppConfig;
  db: Database;
  user: { id: string; email: string };
  refreshTokenId: string;
};

export type AppEnv = { Variables: AppVariables };

export type App = Hono<AppEnv>;

export interface BuildAppOptions {
  config: AppConfig;
  db: Database;
}

/**
 * Build the Hono app. Dependencies are injected so tests can spin up an
 * instance against a test database without touching `process.env`.
 */
export function buildApp(opts: BuildAppOptions): App {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    c.set("config", opts.config);
    c.set("db", opts.db);
    await next();
  });

  if (opts.config.NODE_ENV !== "test") {
    app.use("*", logger());
  }

  app.onError(errorHandler);

  app.get("/health", (c) => c.json({ ok: true, service: "operator-backend" }));

  return app;
}

export function getConfig(c: { get: (k: "config") => AppConfig }): AppConfig {
  return c.get("config");
}

export function getDb(c: { get: (k: "db") => Database }): Database {
  return c.get("db");
}
