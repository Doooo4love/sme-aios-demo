import { createHash, timingSafeEqual } from "node:crypto";
import {
  getApiBaseUrl,
  getBrowserOrigin,
  getDemoSecret,
} from "@/lib/bff/config";
import { copySetCookieHeaders } from "@/lib/bff/proxy";
import { sanitizeErrorPayload } from "@/lib/bff/sanitize";
import type { DemoPersonaId } from "@/lib/types";

const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const RATE_LIMIT_MAX_ATTEMPTS = 10;
const RATE_LIMIT_MAX_BUCKETS = 2000;

const failedLoginBuckets = new Map<string, number[]>();

function pruneBucket(timestamps: number[], now: number): number[] {
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  return timestamps.filter((ts) => ts > cutoff);
}

export function getRateLimitClientKey(req: Request, normalizedUsername: string): string {
  const forwarded = req.headers.get("x-forwarded-for");
  const ip =
    (forwarded ? forwarded.split(",")[0]?.trim() : null) ||
    req.headers.get("x-real-ip")?.trim() ||
    "local";
  return `${ip}|${normalizedUsername.slice(0, 80)}`;
}

export function isLoginRateLimited(key: string): boolean {
  const now = Date.now();
  const prev = failedLoginBuckets.get(key);
  if (!prev) return false;
  const fresh = pruneBucket(prev, now);
  if (fresh.length === 0) {
    failedLoginBuckets.delete(key);
    return false;
  }
  failedLoginBuckets.set(key, fresh);
  return fresh.length >= RATE_LIMIT_MAX_ATTEMPTS;
}

export function recordLoginFailure(key: string): void {
  const now = Date.now();
  if (failedLoginBuckets.size >= RATE_LIMIT_MAX_BUCKETS && !failedLoginBuckets.has(key)) {
    // Evict oldest bucket cleanly to keep memory bounded
    const oldestKey = failedLoginBuckets.keys().next().value;
    if (oldestKey !== undefined) {
      failedLoginBuckets.delete(oldestKey);
    }
  }
  const prev = failedLoginBuckets.get(key) ?? [];
  const fresh = pruneBucket(prev, now);
  fresh.push(now);
  failedLoginBuckets.set(key, fresh);
}

export function clearLoginFailures(key: string): void {
  failedLoginBuckets.delete(key);
}

/**
 * Constant-time SHA-256 digest comparison (eliminates length & byte timing side-channels).
 */
export function verifyPasswordConstantTime(input: string, expected: string): boolean {
  const digestA = createHash("sha256").update(input, "utf8").digest();
  const digestB = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(digestA, digestB);
}

/**
 * Shared FastAPI POST /v1/session exchange helper reused by both
 * POST /api/auth/login and POST /api/auth/demo-login.
 */
export async function exchangeDemoSession(
  req: Request,
  subject: DemoPersonaId,
): Promise<Response> {
  const demoSecret = getDemoSecret();
  if (!demoSecret) {
    return new Response(
      JSON.stringify({
        detail: {
          code: "DEMO_AUTH_DISABLED",
          message: "当前环境未配置演示会话密钥。",
        },
      }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        },
      },
    );
  }

  const upstreamHeaders = new Headers({
    Authorization: `Bearer ${demoSecret}.${subject}`,
    Origin: getBrowserOrigin(),
  });

  // Forward existing session cookie so upstream cleans up prior session row on switch
  const existingCookie = req.headers.get("cookie");
  if (existingCookie) {
    upstreamHeaders.set("Cookie", existingCookie);
  }

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(`${getApiBaseUrl()}/v1/session`, {
      method: "POST",
      headers: upstreamHeaders,
      redirect: "manual",
      cache: "no-store",
    });
  } catch {
    return new Response(
      JSON.stringify({
        detail: {
          code: "UPSTREAM_UNAVAILABLE",
          message: "认证服务暂不可用，请稍后重试。",
        },
      }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Retry-After": "2",
          "Cache-Control": "no-store",
        },
      },
    );
  }

  const outgoingHeaders = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  const requestId = upstreamRes.headers.get("x-request-id");
  if (requestId) outgoingHeaders.set("X-Request-ID", requestId);
  const retryAfter = upstreamRes.headers.get("retry-after");
  if (retryAfter) outgoingHeaders.set("Retry-After", retryAfter);
  copySetCookieHeaders(upstreamRes.headers, outgoingHeaders);

  const rawText = await upstreamRes.text();
  let parsedUpstream: unknown = null;
  if (rawText) {
    try {
      parsedUpstream = JSON.parse(rawText);
    } catch {
      parsedUpstream = rawText;
    }
  }

  if (!upstreamRes.ok) {
    return new Response(
      JSON.stringify(sanitizeErrorPayload(upstreamRes.status, parsedUpstream)),
      {
        status: upstreamRes.status,
        headers: outgoingHeaders,
      },
    );
  }

  const okObj =
    typeof parsedUpstream === "object" && parsedUpstream !== null
      ? (parsedUpstream as Record<string, unknown>)
      : {};

  return new Response(
    JSON.stringify({
      csrf_token: typeof okObj.csrf_token === "string" ? okObj.csrf_token : "",
      expires_in:
        typeof okObj.expires_in === "number" ? okObj.expires_in : 900,
    }),
    {
      status: 200,
      headers: outgoingHeaders,
    },
  );
}
