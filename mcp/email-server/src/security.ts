import { createHash, timingSafeEqual } from "node:crypto";

const HEADER_CONTROL_RE = /[\r\n\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const EMAIL_CONTROL_RE = /[\r\n\x00-\x1f\x7f]/;
const EMAIL_ADDRESS_RE =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

export const MAX_EMAIL_RECIPIENTS = 10;

export function hasHeaderInjection(value: string): boolean {
  return HEADER_CONTROL_RE.test(value);
}

export function normalizeAndValidateEmail(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 254 || EMAIL_CONTROL_RE.test(trimmed)) {
    return null;
  }
  if (trimmed.includes("..")) {
    return null;
  }
  const atIndex = trimmed.indexOf("@");
  if (atIndex <= 0 || atIndex > 64) {
    return null;
  }
  if (!EMAIL_ADDRESS_RE.test(trimmed)) {
    return null;
  }
  return trimmed;
}

export function normalizeRecipientList(
  to: readonly string[],
  cc: readonly string[] = [],
):
  | { ok: true; to: string[]; cc: string[] }
  | { ok: false; reason: string } {
  const normalizedTo: string[] = [];
  const seen = new Set<string>();

  for (const raw of to) {
    const email = normalizeAndValidateEmail(raw);
    if (!email) {
      return {
        ok: false,
        reason: "Invalid recipient email address or illegal header characters.",
      };
    }
    const lower = email.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      normalizedTo.push(email);
    }
  }

  const normalizedCc: string[] = [];
  for (const raw of cc) {
    const email = normalizeAndValidateEmail(raw);
    if (!email) {
      return {
        ok: false,
        reason: "Invalid CC email address or illegal header characters.",
      };
    }
    const lower = email.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      normalizedCc.push(email);
    }
  }

  if (normalizedTo.length === 0) {
    return { ok: false, reason: "At least one recipient email is required." };
  }

  if (normalizedTo.length + normalizedCc.length > MAX_EMAIL_RECIPIENTS) {
    return {
      ok: false,
      reason: `Total recipients (To + CC) must not exceed ${MAX_EMAIL_RECIPIENTS}.`,
    };
  }

  return { ok: true, to: normalizedTo, cc: normalizedCc };
}

export function sanitizeEmailBody(raw: string): string | null {
  if (!raw || raw.includes("\x00")) {
    return null;
  }
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  return normalized.length > 0 ? normalized : null;
}

export class SlidingWindowRateLimiter {
  private readonly windows = new Map<string, number[]>();
  private readonly maxPerWindow: number;
  private readonly windowMs: number;

  constructor(maxPerWindow = 10, windowMs = 60_000) {
    this.maxPerWindow = Math.max(1, maxPerWindow);
    this.windowMs = Math.max(1000, windowMs);
  }

  checkAndConsume(senderKey: string, nowMs = Date.now()): {
    allowed: boolean;
    retryAfterSeconds: number;
  } {
    const key = (senderKey || "default").trim().slice(0, 128) || "default";
    const cutoff = nowMs - this.windowMs;
    const prev = this.windows.get(key) ?? [];
    const active = prev.filter((ts) => ts > cutoff);

    if (active.length >= this.maxPerWindow) {
      const oldest = active[0] ?? nowMs;
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((oldest + this.windowMs - nowMs) / 1000),
      );
      this.windows.set(key, active);
      return { allowed: false, retryAfterSeconds };
    }

    active.push(nowMs);
    this.windows.set(key, active);

    if (this.windows.size > 1024) {
      for (const [k, timestamps] of this.windows) {
        const kept = timestamps.filter((ts) => ts > cutoff);
        if (kept.length === 0) {
          this.windows.delete(k);
        } else {
          this.windows.set(k, kept);
        }
        if (this.windows.size <= 512) break;
      }
    }

    return { allowed: true, retryAfterSeconds: 0 };
  }
}

function sha256Digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function verifyBearerToken(
  authHeader: string | undefined,
  expectedToken: string | null,
): boolean {
  if (!expectedToken) return true;
  if (!authHeader) return false;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match || !match[1]) return false;
  const presented = match[1].trim();
  if (!presented) return false;
  return timingSafeEqual(sha256Digest(presented), sha256Digest(expectedToken));
}

export function sanitizeTransportError(err: unknown): string {
  if (err && typeof err === "object") {
    const code = (err as { code?: unknown }).code;
    const responseCode = (err as { responseCode?: unknown }).responseCode;
    if (code === "EAUTH" || responseCode === 535) {
      return "SMTP authentication failed. Verify server-side mail credentials.";
    }
    if (code === "ETIMEDOUT" || code === "ESOCKET" || code === "ECONNECTION") {
      return "SMTP transport connection timed out or was refused.";
    }
    if (code === "EENVELOPE") {
      return "SMTP server rejected one or more envelope addresses.";
    }
  }
  return "SMTP mail dispatch failed due to a transport error.";
}
