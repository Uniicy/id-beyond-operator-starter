import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { buildApp, type App } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";
import type { Database } from "../../src/db/client.js";
import { registerRoutes } from "../../src/routes/index.js";

export interface TestContext {
  app: App;
  db: Database;
  sql: postgres.Sql;
  baseUrl: string;
  cleanup: () => Promise<void>;
}

/**
 * Boots an in-process Hono instance wired to the test Postgres.
 *
 * Strategy: drop + recreate the `public` schema, then run drizzle
 * migrations. Cheaper than per-test TRUNCATE when the test file owns a
 * fresh DB exclusively, and sidesteps foreign-key order gotchas.
 */
export async function createTestContext(): Promise<TestContext> {
  const config = loadConfig();

  const resetSql = postgres(config.DATABASE_URL, { max: 1, prepare: false });
  // Drop both `public` (our tables) and `drizzle` (migration bookkeeping) so
  // the migrator re-runs from scratch. Without this, migrator sees prior
  // applied rows and leaves us with no tables.
  await resetSql`DROP SCHEMA IF EXISTS public CASCADE`;
  await resetSql`DROP SCHEMA IF EXISTS drizzle CASCADE`;
  await resetSql`CREATE SCHEMA public`;
  await migrate(drizzle(resetSql), { migrationsFolder: "src/db/migrations" });
  await resetSql.end();

  const sql = postgres(config.DATABASE_URL, { max: 5, prepare: false });
  const db = drizzle(sql) as unknown as Database;

  const app = buildApp({ config, db });
  registerRoutes(app);

  return {
    app,
    db,
    sql,
    baseUrl: "http://localhost",
    async cleanup() {
      await sql.end();
    },
  };
}

export interface FetchResult<T = unknown> {
  status: number;
  headers: Headers;
  body: T;
  raw: Response;
}

/**
 * Convenience wrapper around Hono's in-memory `app.request` — gives us
 * parsed JSON and a typed result without sacrificing access to status /
 * headers.
 */
export async function request<T = unknown>(
  ctx: TestContext,
  path: string,
  init?: RequestInit,
): Promise<FetchResult<T>> {
  const res = await ctx.app.request(path, init);
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return {
    status: res.status,
    headers: res.headers,
    body: body as T,
    raw: res,
  };
}
