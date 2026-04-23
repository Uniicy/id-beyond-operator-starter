import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Database = ReturnType<typeof drizzle<typeof schema>>;

export interface CreateDbOptions {
  /**
   * Max concurrent connections. Defaults to 10 — plenty for a reference
   * backend and well below Postgres's default 100.
   */
  max?: number;
}

/**
 * Create a Drizzle client around postgres-js. We keep the raw client as a
 * property so the test harness can call `.end()` between runs.
 */
export function createDb(url: string, opts: CreateDbOptions = {}): Database {
  const sql = postgres(url, { max: opts.max ?? 10, prepare: false });
  return drizzle(sql, { schema });
}
