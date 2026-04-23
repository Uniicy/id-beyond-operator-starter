/**
 * Global vitest setup. Loads the test environment variables each worker
 * needs and configures deterministic defaults so tests don't depend on
 * a developer's local shell.
 */
process.env["NODE_ENV"] = "test";
process.env["PORT"] ??= "4500";
process.env["DATABASE_URL"] ??= "postgres://operator:operator@localhost:54500/operator_test";
process.env["JWT_SECRET"] ??=
  "test-jwt-secret-that-is-at-least-thirty-two-characters-long";
process.env["IDBEYOND_API_URL"] ??= "https://api.idbeyond.test";
process.env["IDBEYOND_SECRET"] ??= "pk_live_test_secret";
process.env["IDBEYOND_WEBHOOK_SECRET"] ??= "test-webhook-shared-secret-1234";
process.env["KYC_RETURN_URL"] ??= "https://app.example.test/kyc/return";
process.env["AUTH_APPLE_CLIENT_ID"] ??= "com.example.app";
process.env["EMAIL_TRANSPORT"] ??= "console";
