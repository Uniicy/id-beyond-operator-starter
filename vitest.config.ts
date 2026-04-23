import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    // Each test file gets a fresh schema (dropped and recreated), so we
    // cannot parallelize across files safely without per-file DB isolation.
    fileParallelism: false,
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
