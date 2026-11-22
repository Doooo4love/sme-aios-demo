import nodemailer, { type Transporter } from "nodemailer";
import { hasHeaderInjection, normalizeAndValidateEmail } from "./security.js";

export interface SmtpRuntimeConfig {
  host: string;
  port: number;
  secure: boolean;
  requireTls: boolean;
  user: string | null;
  pass: string | null;
  from: string;
  rejectUnauthorized: boolean;
}

function readCleanEnv(key: string): string | null {
  const val = process.env[key]?.trim();
  return val && val.length > 0 ? val : null;
}

export function loadSmtpConfigFromEnv(): SmtpRuntimeConfig | null {
  const host = readCleanEnv("AIOS_SMTP_HOST");
  if (!host || hasHeaderInjection(host)) {
    return null;
  }

  const rawPort = readCleanEnv("AIOS_SMTP_PORT");
  const parsedPort = rawPort ? Number.parseInt(rawPort, 10) : 587;
  const port =
    Number.isFinite(parsedPort) && parsedPort >= 1 && parsedPort <= 65535
      ? parsedPort
      : 587;

  const secureEnv = readCleanEnv("AIOS_SMTP_SECURE");
  const secure = secureEnv === "1" || secureEnv === "true" || port === 465;

  const user = readCleanEnv("AIOS_SMTP_USER");
  const pass = readCleanEnv("AIOS_SMTP_PASS");
  const rawFrom = readCleanEnv("AIOS_SMTP_FROM") ?? user;
  const validatedFrom = rawFrom ? normalizeAndValidateEmail(rawFrom) : null;
  if (!validatedFrom) {
    return null;
  }

  const rejectUnauthorized =
    readCleanEnv("AIOS_SMTP_ALLOW_SELF_SIGNED") !== "1";
  const requireTls = readCleanEnv("AIOS_SMTP_REQUIRE_TLS") !== "0";

  return {
    host,
    port,
    secure,
    requireTls,
    user,
    pass,
    from: validatedFrom,
    rejectUnauthorized,
  };
}

export class PooledSmtpService {
  private transporter: Transporter | null = null;
  private configSignature: string | null = null;

  private getOrCreateTransporter():
    | { transporter: Transporter; config: SmtpRuntimeConfig }
    | null {
    const cfg = loadSmtpConfigFromEnv();
    if (!cfg) return null;

    const sig = `${cfg.host}:${cfg.port}:${cfg.secure}:${cfg.requireTls}:${cfg.user ?? ""}:${cfg.from}`;
    if (!this.transporter || this.configSignature !== sig) {
      if (this.transporter) {
        this.transporter.close();
      }
      this.transporter = nodemailer.createTransport({
        pool: true,
        maxConnections: 3,
        maxMessages: 100,
        host: cfg.host,
        port: cfg.port,
        secure: cfg.secure,
        requireTLS: !cfg.secure && cfg.requireTls,
        auth:
          cfg.user && cfg.pass
            ? { user: cfg.user, pass: cfg.pass }
            : undefined,
        tls: {
          minVersion: "TLSv1.2",
          rejectUnauthorized: cfg.rejectUnauthorized,
        },
        connectionTimeout: 8_000,
        greetingTimeout: 8_000,
        socketTimeout: 10_000,
      });
      this.configSignature = sig;
    }

    return { transporter: this.transporter, config: cfg };
  }

  isConfigured(): boolean {
    return loadSmtpConfigFromEnv() !== null;
  }

  async verify(): Promise<{
    configured: boolean;
    verified: boolean;
    tlsMode: "smtps" | "starttls" | "unconfigured";
    timestamp: number;
  }> {
    const ctx = this.getOrCreateTransporter();
    const timestamp = Math.floor(Date.now() / 1000);
    if (!ctx) {
      return {
        configured: false,
        verified: false,
        tlsMode: "unconfigured",
        timestamp,
      };
    }
    const ok = await ctx.transporter.verify();
    return {
      configured: true,
      verified: Boolean(ok),
      tlsMode: ctx.config.secure ? "smtps" : "starttls",
      timestamp,
    };
  }

  async send(input: {
    to: string[];
    cc: string[];
    subject: string;
    body: string;
    replyTo?: string;
  }): Promise<{
    messageId: string;
    accepted: string[];
    rejected: string[];
    timestamp: number;
  }> {
    const ctx = this.getOrCreateTransporter();
    if (!ctx) {
      throw new Error("SMTP_UNCONFIGURED");
    }

    const info = await ctx.transporter.sendMail({
      from: ctx.config.from,
      to: input.to,
      cc: input.cc.length > 0 ? input.cc : undefined,
      replyTo: input.replyTo,
      subject: input.subject,
      text: input.body,
    });

    const extractEnvelopeAddress = (item: unknown): string => {
      if (typeof item === "string") return item;
      if (
        typeof item === "object" &&
        item !== null &&
        "address" in item &&
        typeof (item as { address?: unknown }).address === "string"
      ) {
        return (item as { address: string }).address;
      }
      return String(item);
    };

    const accepted = Array.isArray(info.accepted)
      ? info.accepted.map(extractEnvelopeAddress)
      : [...input.to, ...input.cc];
    const rejected = Array.isArray(info.rejected)
      ? info.rejected.map(extractEnvelopeAddress)
      : [];

    return {
      messageId:
        typeof info.messageId === "string" && info.messageId.trim()
          ? info.messageId.trim()
          : `<theodic-${Date.now()}@localhost>`,
      accepted,
      rejected,
      timestamp: Math.floor(Date.now() / 1000),
    };
  }

  close(): void {
    if (this.transporter) {
      this.transporter.close();
      this.transporter = null;
      this.configSignature = null;
    }
  }
}
