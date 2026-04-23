import { serve } from "@hono/node-server";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { registerRoutes } from "./routes/index.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDb(config.DATABASE_URL);

  const app = buildApp({ config, db });
  registerRoutes(app);

  serve({ fetch: app.fetch, port: config.PORT }, (info) => {
    console.log(`[operator] listening on http://localhost:${info.port}`);
  });
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
