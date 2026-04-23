import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { loadConfig } from "../config.js";

/**
 * Runs SQL migrations from `src/db/migrations/` against the database at
 * `DATABASE_URL`. Invoked by `pnpm db:migrate` in dev and by the CI suite
 * before tests run.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const sql = postgres(config.DATABASE_URL, { max: 1 });
  try {
    const db = drizzle(sql);
    await migrate(db, { migrationsFolder: "src/db/migrations" });
    console.log("[migrate] ok");
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error("[migrate] failed", err);
  process.exit(1);
});
