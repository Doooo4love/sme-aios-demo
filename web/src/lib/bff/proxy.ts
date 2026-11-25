import {
  getBrowserOrigin,
  getUpstreamBaseUrlForPath,
  isValidBrowserOrigin,
  makeOriginRejectedResponse,
} from "@/lib/bff/config";
import {
  sanitizeErrorPayload,
  sanitizeSuccessPayload,
  stripForbiddenKeys,
} from "@/lib/bff/sanitize";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const MAX_PROXY_BODY_BYTES = 8_500_000;
const SSE_UPSTREAM_PATH = "/v1/workbench/events/stream";
const LONG_UPSTREAM_PATHS = new Set([
  "/v1/workbench/turns",
  "/v1/memory/tidy",
]);
const LONG_UPSTREAM_TIMEOUT_MS = 65_000;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 15_000;
const VALID_REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const VALID_TRACEPARENT_RE = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

const ALLOWED_V1_PATTERNS: readonly RegExp[] = [
  /^\/v1\/session$/,
  /^\/v1\/session\/login$/,
  /^\/v1\/session\/callback$/,
  /^\/v1\/me$/,
  /^\/v1\/workbench\/capabilities$/,
  /^\/v1\/workbench\/approvals$/,
  /^\/v1\/workbench\/calls$/,
  /^\/v1\/workbench\/turns$/,
  /^\/v1\/workbench\/history$/,
  /^\/v1\/workbench\/history\/[^/]+$/,
  /^\/v1\/workbench\/module-access\/catalog$/,
  /^\/v1\/workbench\/module-access\/employees$/,
  /^\/v1\/workbench\/module-access\/employees\/[^/]+$/,
  /^\/v1\/workbench\/module-access\/employees\/[^/]+\/[^/]+$/,
  /^\/v1\/workbench\/tasks$/,
  /^\/v1\/workbench\/notices$/,
  /^\/v1\/workbench\/notices\/[^/]+$/,
  /^\/v1\/workbench\/notices\/[^/]+\/read$/,
  /^\/v1\/workbench\/brief$/,
  /^\/v1\/intakes\/[^/]+$/,
  /^\/v1\/intakes\/[^/]+\/structured$/,
  /^\/v1\/intakes\/[^/]+\/structured\/batch$/,
  /^\/v1\/actions$/,
  /^\/v1\/proposals\/approve-batch$/,
  /^\/v1\/proposals\/[^/]+$/,
  /^\/v1\/proposals\/[^/]+\/approve$/,
  /^\/v1\/proposals\/[^/]+\/review$/,
  /^\/v1\/proposals\/[^/]+\/reconcile$/,
  /^\/v1\/profile$/,
  /^\/v1\/profile\/avatar$/,
  /^\/v1\/agent-profile$/,
  /^\/v1\/agent-profile\/avatar$/,
  /^\/v1\/memory$/,
  /^\/v1\/memory\/tidy$/,
  /^\/v1\/memory\/revert$/,
  /^\/v1\/memory\/forget$/,
  /^\/v1\/calendar\/events$/,
  /^\/v1\/calendar\/events\/[^/]+$/,
  /^\/v1\/calendar\/events\/[^/]+\/cancel$/,
  /^\/v1\/chat\/rooms$/,
  /^\/v1\/chat\/rooms\/[^/]+\/members$/,
  /^\/v1\/chat\/rooms\/[^/]+\/members\/[^/]+$/,
  /^\/v1\/chat\/rooms\/[^/]+\/members\/[^/]+\/profile$/,
  /^\/v1\/chat\/rooms\/[^/]+\/members\/[^/]+\/profile\/avatar$/,
  /^\/v1\/chat\/rooms\/[^/]+\/messages$/,
  /^\/v1\/chat\/rooms\/[^/]+\/read$/,
  /^\/v1\/chat\/rooms\/[^/]+\/receipts$/,
  /^\/v1\/channels\/catalog$/,
  /^\/v1\/channels\/bindings$/,
  /^\/v1\/channels\/bindings\/[^/]+$/,
  /^\/v1\/channels\/outbound$/,
  /^\/v1\/assurance\/cases$/,
  /^\/v1\/assurance\/cases\/[^/]+$/,
  /^\/v1\/assurance\/cases\/[^/]+\/reviews$/,
  /^\/v1\/assurance\/reviews\/[^/]+$/,
  /^\/v1\/assurance\/reviews\/[^/]+\/decisions$/,
  /^\/v1\/assurance\/audit\/checkpoint$/,
  /^\/v1\/operations\/summary$/,
  /^\/v1\/operations\/exceptions$/,
  /^\/v1\/operations\/write-control$/,
  /^\/v1\/operations\/subjects\/[^/]+\/suspension$/,
  /^\/v1\/operations\/prompt-policies$/,
  /^\/v1\/operations\/prompt-policies\/simulate$/,
  /^\/v1\/operations\/prompt-policies\/[^/]+$/,
  /^\/v1\/operations\/prompt-policies\/[^/]+\/reset$/,
  /^\/v1\/operations\/security-events$/,
  /^\/v1\/operations\/security-events\/summary$/,
  /^\/v1\/operations\/security-events\/[^/]+$/,
  /^\/v1\/operations\/off-topic-policy$/,
  /^\/v1\/operations\/llm-telemetry$/,
  /^\/v1\/operations\/quota-policies$/,
  /^\/v1\/operations\/provider-policy$/,
  /^\/v1\/operations\/system-health$/,
  /^\/v1\/workbench\/events\/stream$/,
  /^\/v1\/workbench\/work-pulse$/,
  /^\/v1\/workbench\/skills$/,
  /^\/v1\/workbench\/email-outbox$/,
  /^\/v1\/workbench\/external-outbox\/reserve$/,
  /^\/v1\/workbench\/external-outbox\/[^/]+\/finalize$/,
  /^\/v1\/demo\/worker-tick$/,
];

function hasUnsafePathSegment(segments: string[]): boolean {
  for (const segment of segments) {
    if (
      !segment ||
      segment === "." ||
      segment === ".." ||
      segment.includes("/") ||
      segment.includes("\\") ||
      /[\x00-\x1f\x7f]/.test(segment)
    ) {
      return true;
    }
  }
  return false;
}

export function isAllowedV1Segments(segments: string[]): boolean {
  if (segments.length === 0 || hasUnsafePathSegment(segments)) {
    return false;
  }
  const encodedPath = `/v1/${segments.map(encodeURIComponent).join("/")}`;
  return ALLOWED_V1_PATTERNS.some((pattern) => pattern.test(encodedPath));
}

export function copySetCookieHeaders(
  upstreamHeaders: Headers,
  outgoingHeaders: Headers,
): void {
  const getSetCookie = (
    upstreamHeaders as Headers & { getSetCookie?: () => string[] }
  ).getSetCookie;
  if (typeof getSetCookie === "function") {
    for (const cookie of getSetCookie.call(upstreamHeaders)) {
      outgoingHeaders.append("Set-Cookie", cookie);
    }
    return;
  }
  const fallback = upstreamHeaders.get("set-cookie");
  if (fallback) {
    outgoingHeaders.append("Set-Cookie", fallback);
  }
}

function resolveRequestId(req: Request): string {
  const inbound = req.headers.get("x-request-id")?.trim() ?? "";
  if (VALID_REQUEST_ID_RE.test(inbound)) {
    return inbound;
  }
  return crypto.randomUUID().replace(/-/g, "");
}

function resolveTraceparent(req: Request): string {
  const inbound = req.headers.get("traceparent")?.trim() ?? "";
  if (
    VALID_TRACEPARENT_RE.test(inbound) &&
    !inbound.startsWith("00-00000000000000000000000000000000-") &&
    !inbound.includes("-0000000000000000-")
  ) {
    return inbound;
  }
  const traceId = crypto.randomUUID().replace(/-/g, "");
  const spanId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  return `00-${traceId}-${spanId}-01`;
}

function getUpstreamTimeoutMs(normalizedPath: string): number | null {
  if (normalizedPath === SSE_UPSTREAM_PATH) return null;
  return LONG_UPSTREAM_PATHS.has(normalizedPath)
    ? LONG_UPSTREAM_TIMEOUT_MS
    : DEFAULT_UPSTREAM_TIMEOUT_MS;
}

function copyCommonMetadataHeaders(
  upstreamHeaders: Headers,
  outgoingHeaders: Headers,
  fallbackRequestId?: string,
  fallbackTraceparent?: string,
): void {
  const requestId = upstreamHeaders.get("x-request-id") || fallbackRequestId;
  if (requestId) outgoingHeaders.set("X-Request-ID", requestId);

  const traceparent = upstreamHeaders.get("traceparent") || fallbackTraceparent;
  if (traceparent) outgoingHeaders.set("traceparent", traceparent);

  const retryAfter = upstreamHeaders.get("retry-after");
  if (retryAfter) outgoingHeaders.set("Retry-After", retryAfter);

  const referrerPolicy = upstreamHeaders.get("referrer-policy");
  if (referrerPolicy) outgoingHeaders.set("Referrer-Policy", referrerPolicy);

  copySetCookieHeaders(upstreamHeaders, outgoingHeaders);
  outgoingHeaders.set("Cache-Control", "no-store");
}

export async function proxyToAios(
  req: Request,
  normalizedPath: string,
  options?: { allowPublicHealth?: boolean },
): Promise<Response> {
  const method = req.method.toUpperCase();

  // Enforce browser Origin check on all mutating requests
  if (!SAFE_METHODS.has(method) && !isValidBrowserOrigin(req)) {
    return makeOriginRejectedResponse();
  }

  const requestId = resolveRequestId(req);
  const traceparent = resolveTraceparent(req);

  // Block POST /v1/session directly from browser (demo-login handles server-side bearer exchange; OIDC uses /v1/session/callback)
  if (normalizedPath === "/v1/session" && method === "POST") {
    return new Response(
      JSON.stringify({
        detail: {
          code: "METHOD_NOT_ALLOWED",
          message: "请通过受控登录入口建立浏览器会话。",
        },
      }),
      {
        status: 405,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Request-ID": requestId,
          traceparent,
        },
      },
    );
  }

  const incomingUrl = new URL(req.url);
  const upstreamUrl = `${getUpstreamBaseUrlForPath(normalizedPath)}${normalizedPath}${incomingUrl.search}`;

  const upstreamHeaders = new Headers();
  upstreamHeaders.set("X-Request-ID", requestId);
  upstreamHeaders.set("traceparent", traceparent);
  const browserOrigin = getBrowserOrigin();

  if (!options?.allowPublicHealth) {
    // Always supply exact trusted Origin upstream so FastAPI BrowserSessions checks pass cleanly
    if (!SAFE_METHODS.has(method) || normalizedPath.startsWith("/v1/session")) {
      upstreamHeaders.set("Origin", browserOrigin);
    }
    const cookie = req.headers.get("cookie");
    if (cookie) upstreamHeaders.set("Cookie", cookie);

    const csrfToken = req.headers.get("x-csrf-token");
    if (csrfToken) upstreamHeaders.set("X-CSRF-Token", csrfToken);

    const idempotencyKey = req.headers.get("idempotency-key");
    if (idempotencyKey) upstreamHeaders.set("Idempotency-Key", idempotencyKey);

    const contentType = req.headers.get("content-type");
    if (contentType) upstreamHeaders.set("Content-Type", contentType);

    const accept = req.headers.get("accept");
    if (accept) upstreamHeaders.set("Accept", accept);

    const lastEventId = req.headers.get("last-event-id");
    if (lastEventId) upstreamHeaders.set("Last-Event-ID", lastEventId);
    // CRITICAL: NEVER forward browser Authorization header to FastAPI /v1/* (breaks GET/DELETE /v1/session and cookie-only boundary)
  }

  let bodyBuffer: ArrayBuffer | undefined;
  if (!SAFE_METHODS.has(method)) {
    const contentLengthHeader = req.headers.get("content-length");
    if (contentLengthHeader) {
      const parsedLen = Number.parseInt(contentLengthHeader, 10);
      if (Number.isFinite(parsedLen) && parsedLen > MAX_PROXY_BODY_BYTES) {
        return new Response(
          JSON.stringify({
            detail: {
              code: "PAYLOAD_TOO_LARGE",
              message: "请求内容超出大小限制。",
            },
          }),
          {
            status: 413,
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "no-store",
              "X-Request-ID": requestId,
              traceparent,
            },
          },
        );
      }
    }
    const raw = await req.arrayBuffer();
    if (raw.byteLength > MAX_PROXY_BODY_BYTES) {
      return new Response(
        JSON.stringify({
          detail: {
            code: "PAYLOAD_TOO_LARGE",
            message: "请求内容超出大小限制。",
          },
        }),
        {
          status: 413,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Request-ID": requestId,
            traceparent,
          },
        },
      );
    }
    if (raw.byteLength > 0) {
      bodyBuffer = raw;
    }
  }

  const timeoutMs = getUpstreamTimeoutMs(normalizedPath);
  const timeoutController = timeoutMs !== null ? new AbortController() : null;
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let onAbort: (() => void) | null = null;

  if (timeoutController && timeoutMs !== null) {
    if (req.signal?.aborted) {
      timeoutController.abort();
    } else {
      onAbort = () => {
        timeoutController.abort();
      };
      req.signal?.addEventListener("abort", onAbort, { once: true });
      timeoutId = setTimeout(() => {
        timedOut = true;
        timeoutController.abort();
      }, timeoutMs);
    }
  }

  let upstreamRes: Response;
  let upstreamContentType = "";
  let binaryBytes: ArrayBuffer | null = null;
  let textBody = "";

  try {
    upstreamRes = await fetch(upstreamUrl, {
      method,
      headers: upstreamHeaders,
      body: bodyBuffer,
      redirect: "manual",
      cache: "no-store",
      signal: timeoutController ? timeoutController.signal : req.signal,
    });

    const outgoingHeaders = new Headers();
    copyCommonMetadataHeaders(
      upstreamRes.headers,
      outgoingHeaders,
      requestId,
      traceparent,
    );

    // Preserve redirects cleanly for OIDC /v1/session/login and /v1/session/callback
    if (upstreamRes.status >= 300 && upstreamRes.status < 400) {
      const location = upstreamRes.headers.get("location");
      if (location) {
        outgoingHeaders.set("Location", location);
      }
      return new Response(null, {
        status: upstreamRes.status,
        headers: outgoingHeaders,
      });
    }

    // 204 No Content (e.g. DELETE /v1/session)
    if (upstreamRes.status === 204 || method === "HEAD") {
      return new Response(null, {
        status: upstreamRes.status,
        headers: outgoingHeaders,
      });
    }

    upstreamContentType = (
      upstreamRes.headers.get("content-type") || ""
    ).toLowerCase();

    // True zero-buffer SSE streaming passthrough BEFORE JSON buffering
    if (upstreamRes.ok && upstreamContentType.includes("text/event-stream")) {
      outgoingHeaders.set("Content-Type", "text/event-stream; charset=utf-8");
      outgoingHeaders.set("Cache-Control", "no-cache, no-transform");
      outgoingHeaders.set("X-Accel-Buffering", "no");
      return new Response(upstreamRes.body, {
        status: upstreamRes.status,
        headers: outgoingHeaders,
      });
    }

    // Binary image / octet-stream passthrough (avatars, etc.)
    if (
      upstreamRes.ok &&
      (upstreamContentType.startsWith("image/") ||
        upstreamContentType.startsWith("application/octet-stream"))
    ) {
      binaryBytes = await upstreamRes.arrayBuffer();
      outgoingHeaders.set("Content-Type", upstreamContentType);
      outgoingHeaders.set("X-Content-Type-Options", "nosniff");
      return new Response(binaryBytes, {
        status: upstreamRes.status,
        headers: outgoingHeaders,
      });
    }

    // JSON or error responses — read inside timeout envelope before sanitization
    textBody = await upstreamRes.text();
  } catch {
    if (timedOut && !req.signal?.aborted) {
      return new Response(
        JSON.stringify({
          detail: {
            code: "UPSTREAM_TIMEOUT",
            message: "后端处理超时，请稍后重试。",
          },
        }),
        {
          status: 504,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Request-ID": requestId,
            traceparent,
          },
        },
      );
    }
    return new Response(
      JSON.stringify({
        detail: {
          code: "UPSTREAM_UNAVAILABLE",
          message: "后端服务暂不可用，请稍后重试。",
        },
      }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Retry-After": "2",
          "Cache-Control": "no-store",
          "X-Request-ID": requestId,
          traceparent,
        },
      },
    );
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
    if (onAbort) {
      req.signal?.removeEventListener("abort", onAbort);
    }
  }

  const outgoingHeaders = new Headers();
  copyCommonMetadataHeaders(
    upstreamRes.headers,
    outgoingHeaders,
    requestId,
    traceparent,
  );

  let parsed: unknown = null;
  if (textBody.length > 0) {
    try {
      parsed = JSON.parse(textBody);
    } catch {
      parsed = textBody;
    }
  }

  outgoingHeaders.set("Content-Type", "application/json; charset=utf-8");

  if (!upstreamRes.ok) {
    const isMemoryPath =
      normalizedPath === "/v1/memory" ||
      normalizedPath.startsWith("/v1/memory/");
    const errorInput = isMemoryPath
      ? normalizeMemoryErrorPayload(upstreamRes.status, parsed)
      : parsed;
    const sanitizedError = sanitizeErrorPayload(upstreamRes.status, errorInput);
    const responseError = isMemoryPath
      ? enrichSanitizedMemoryError(upstreamRes.status, sanitizedError)
      : sanitizedError;
    return new Response(JSON.stringify(responseError), {
      status: upstreamRes.status,
      headers: outgoingHeaders,
    });
  }

  const sanitizedOk =
    normalizedPath === "/v1/workbench/skills"
      ? sanitizeSlashSkillsResponse(parsed)
      : normalizedPath === "/v1/operations/system-health"
        ? sanitizeSystemHealthResponse(parsed)
        : sanitizeSuccessPayload(normalizedPath, parsed);
  return new Response(JSON.stringify(sanitizedOk), {
    status: upstreamRes.status,
    headers: outgoingHeaders,
  });
}

function sanitizeSlashSkillsResponse(payload: unknown): { items: unknown[] } {
  const rawItems = Array.isArray(payload)
    ? payload
    : typeof payload === "object" &&
        payload !== null &&
        Array.isArray((payload as { items?: unknown }).items)
      ? ((payload as { items: unknown[] }).items)
      : [];

  const items = rawItems
    .filter(
      (entry): entry is Record<string, unknown> =>
        typeof entry === "object" && entry !== null && !Array.isArray(entry),
    )
    .map((entry) => {
      const command = typeof entry.command === "string" ? entry.command : "";
      return {
        command,
        title: typeof entry.title === "string" ? entry.title : command,
        title_en: typeof entry.title_en === "string" ? entry.title_en : command,
        description:
          typeof entry.description === "string" ? entry.description : "",
        description_en:
          typeof entry.description_en === "string" ? entry.description_en : "",
        category:
          typeof entry.category === "string" ? entry.category : "workflow",
        usage: typeof entry.usage === "string" ? entry.usage : command,
        requires_args: Boolean(entry.requires_args),
        allowed: Boolean(entry.allowed),
        required_module:
          typeof entry.required_module === "string"
            ? entry.required_module
            : null,
        keywords: Array.isArray(entry.keywords)
          ? entry.keywords.filter((k): k is string => typeof k === "string")
          : [],
      };
    })
    .filter((entry) => entry.command.length > 0);

  return { items };
}

function asFiniteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function sanitizeSystemHealthResponse(payload: unknown): Record<string, unknown> {
  const raw =
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};

  const rawCircuits = Array.isArray(raw.provider_circuits)
    ? raw.provider_circuits
    : [];
  const provider_circuits = rawCircuits
    .filter(
      (entry): entry is Record<string, unknown> =>
        typeof entry === "object" && entry !== null && !Array.isArray(entry),
    )
    .map((entry) => {
      const state =
        entry.state === "open" ||
        entry.state === "half_open" ||
        entry.state === "closed"
          ? entry.state
          : "closed";
      return {
        provider:
          typeof entry.provider === "string" && entry.provider.trim().length > 0
            ? entry.provider.trim().slice(0, 64)
            : "default",
        state,
        failures: asFiniteNumber(entry.failures, 0),
        retry_in_seconds: asFiniteNumber(entry.retry_in_seconds, 0),
      };
    });

  const rawCache =
    typeof raw.l1_cache === "object" &&
    raw.l1_cache !== null &&
    !Array.isArray(raw.l1_cache)
      ? (raw.l1_cache as Record<string, unknown>)
      : {};

  const rawSchemaSec =
    typeof raw.schema_security === "object" &&
    raw.schema_security !== null &&
    !Array.isArray(raw.schema_security)
      ? (raw.schema_security as Record<string, unknown>)
      : null;

  const rawProviderPol =
    typeof raw.provider_policy === "object" &&
    raw.provider_policy !== null &&
    !Array.isArray(raw.provider_policy)
      ? (raw.provider_policy as Record<string, unknown>)
      : null;

  return {
    status: raw.status === "ok" ? "ok" : "degraded",
    db_engine_mode:
      typeof raw.db_engine_mode === "string" &&
      raw.db_engine_mode.trim().length > 0
        ? raw.db_engine_mode.trim().slice(0, 64)
        : "unknown",
    storage_ok: Boolean(raw.storage_ok),
    provider_circuits,
    l1_cache: {
      hits: asFiniteNumber(rawCache.hits, 0),
      misses: asFiniteNumber(rawCache.misses, 0),
      hit_ratio: asFiniteNumber(rawCache.hit_ratio, 0),
      entries: asFiniteNumber(rawCache.entries, 0),
      max_entries: asFiniteNumber(rawCache.max_entries, 0),
      estimated_usd_saved: asFiniteNumber(rawCache.estimated_usd_saved, 0),
      tokens_saved: asFiniteNumber(rawCache.tokens_saved, 0),
    },
    fallback_configured: Boolean(raw.fallback_configured),
    active_sse_subscribers: asFiniteNumber(raw.active_sse_subscribers, 0),
    rate_limit_rejections: asFiniteNumber(raw.rate_limit_rejections, 0),
    otel_genai_enabled: Boolean(raw.otel_genai_enabled),
    ...(rawSchemaSec ? { schema_security: stripForbiddenKeys(rawSchemaSec) } : {}),
    ...(rawProviderPol ? { provider_policy: stripForbiddenKeys(rawProviderPol) } : {}),
    uptime_seconds: asFiniteNumber(raw.uptime_seconds, 0),
  };
}

function normalizeMemoryErrorPayload(
  status: number,
  parsed: unknown,
): unknown {
  if (
    (status !== 409 && status !== 422) ||
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    return parsed;
  }

  const record = parsed as Record<string, unknown>;
  const rawDetail = record.detail;
  if (Array.isArray(rawDetail)) {
    return parsed;
  }

  const detailObj: Record<string, unknown> =
    typeof rawDetail === "object" && rawDetail !== null && !Array.isArray(rawDetail)
      ? { ...(rawDetail as Record<string, unknown>) }
      : {};

  if (typeof record.code === "string" && typeof detailObj.code !== "string") {
    detailObj.code = record.code;
  }
  if (typeof record.reason === "string" && typeof detailObj.reason !== "string") {
    detailObj.reason = record.reason;
  }
  if (typeof rawDetail === "string" && rawDetail.trim().length > 0) {
    if (typeof detailObj.detail !== "string") {
      detailObj.detail = rawDetail;
    }
    if (typeof detailObj.message !== "string") {
      detailObj.message = rawDetail;
    }
  }
  if (
    typeof detailObj.message !== "string" &&
    typeof detailObj.reason === "string" &&
    detailObj.reason.trim().length > 0
  ) {
    detailObj.message = detailObj.reason;
  }

  if (Object.keys(detailObj).length === 0) {
    return parsed;
  }
  return { detail: detailObj };
}

function enrichSanitizedMemoryError(
  status: number,
  sanitizedError: Record<string, unknown>,
): Record<string, unknown> {
  if (status !== 409 && status !== 422) {
    return sanitizedError;
  }
  const detail = sanitizedError.detail;
  if (typeof detail !== "object" || detail === null || Array.isArray(detail)) {
    return sanitizedError;
  }
  const detailRecord = detail as Record<string, unknown>;
  const enriched: Record<string, unknown> = { ...sanitizedError };
  if (typeof detailRecord.code === "string") {
    enriched.code = detailRecord.code;
  }
  if (typeof detailRecord.reason === "string") {
    enriched.reason = detailRecord.reason;
  }
  return enriched;
}
