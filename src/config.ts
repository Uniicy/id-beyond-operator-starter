import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  JWT_SECRET: z
    .string()
    .min(32, "JWT_SECRET must be at least 32 chars — generate with `openssl rand -base64 48`"),

  IDBEYOND_API_URL: z.string().url().default("https://api.uniicy.com"),
  IDBEYOND_SECRET: z.string().min(1, "IDBEYOND_SECRET (pk_live_*) is required"),
  IDBEYOND_WEBHOOK_SECRET: z
    .string()
    .min(16, "IDBEYOND_WEBHOOK_SECRET must be set and match the id beyond dashboard"),

  KYC_RETURN_URL: z
    .string()
    .url()
    .describe("Universal Link the hosted flow redirects to when verification finishes"),

  AUTH_APPLE_CLIENT_ID: z.string().optional(),
  AUTH_APPLE_TEAM_ID: z.string().optional(),

  EMAIL_TRANSPORT: z.enum(["console", "resend"]).default("console"),
  RESEND_API_KEY: z.string().optional(),
});

export type AppConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const summary = parsed.error.errors
      .map((e) => `  - ${e.path.join(".") || "(root)"}: ${e.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${summary}`);
  }
  if (parsed.data.EMAIL_TRANSPORT === "resend" && !parsed.data.RESEND_API_KEY) {
    throw new Error("EMAIL_TRANSPORT=resend requires RESEND_API_KEY");
  }
  return parsed.data;
}
