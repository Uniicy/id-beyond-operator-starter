import type { AppConfig } from "../config.js";

export interface MagicLinkEmail {
  to: string;
  verifyUrl: string;
  expiresAt: Date;
}

export interface EmailTransport {
  sendMagicLink(msg: MagicLinkEmail): Promise<void>;
}

/**
 * Dev-friendly transport. Logs the verification URL to stdout so
 * developers can click it during local testing without configuring
 * an SMTP / Resend account.
 */
export const consoleTransport: EmailTransport = {
  async sendMagicLink(msg) {
    console.log("\n---");
    console.log(`[magic-link] to:         ${msg.to}`);
    console.log(`[magic-link] verify URL: ${msg.verifyUrl}`);
    console.log(`[magic-link] expires at: ${msg.expiresAt.toISOString()}`);
    console.log("---\n");
  },
};

/**
 * Thin Resend implementation. We hit the HTTP API directly rather than
 * pulling in the `resend` SDK so the starter has no SDK maintenance
 * burden — swap in the SDK once you start customizing the template.
 */
function resendTransport(apiKey: string): EmailTransport {
  return {
    async sendMagicLink(msg) {
      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "login@example.com",
          to: msg.to,
          subject: "Your sign-in link",
          html: `<p>Click to sign in: <a href="${msg.verifyUrl}">${msg.verifyUrl}</a></p><p>Expires ${msg.expiresAt.toISOString()}.</p>`,
        }),
      });
      if (!resp.ok) {
        throw new Error(`Resend send failed: ${resp.status}`);
      }
    },
  };
}

export function selectEmailTransport(config: AppConfig): EmailTransport {
  if (config.EMAIL_TRANSPORT === "resend" && config.RESEND_API_KEY) {
    return resendTransport(config.RESEND_API_KEY);
  }
  return consoleTransport;
}
