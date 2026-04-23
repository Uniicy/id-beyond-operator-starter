import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";

/**
 * Narrow error class for user-facing failures. The handler below preserves
 * the message; everything else gets logged and returns a generic 500 so we
 * never leak stack traces or database shapes to clients.
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public override readonly message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function errorHandler(err: Error, c: Context): Response {
  if (err instanceof AppError) {
    return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
  }
  if (err instanceof HTTPException) {
    return err.getResponse();
  }

  console.error("[unhandled]", err);
  return c.json({ error: { code: "internal_error", message: "Internal server error" } }, 500);
}
