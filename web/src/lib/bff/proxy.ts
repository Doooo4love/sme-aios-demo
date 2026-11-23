import {
  getBrowserOrigin,
  getUpstreamBaseUrlForPath,
  isValidBrowserOrigin,
  makeOriginRejectedResponse,
} from "@/lib/bff/config";
import {
  sanitizeErrorPayload,
  sanitizeSuccessPayload,
} from "@/lib/bff/sanitize";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const MAX_PROXY_BODY_BYTES = 8_500_000;

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
  /^\/v1\/workbench\/events\/stream$/,
  /^\/v1\/workbench\/work-pulse$/,
  /^\/v1\/workbench\/skills$/,
  /^\/v1\/workbench\/email-outbox$/,
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

function copyCommonMetadataHeaders(
  upstreamHeaders: Headers,
  outgoingHeaders: Headers,
): void {
  const requestId = upstreamHeaders.get("x-request-id");
  if (requestId) outgoingHeaders.set("X-Request-ID", requestId);

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
        },
      },
    );
  }

  const incomingUrl = new URL(req.url);
  const upstreamUrl = `${getUpstreamBaseUrlForPath(normalizedPath)}${normalizedPath}${incomingUrl.search}`;

  const upstreamHeaders = new Headers();
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
          },
        },
      );
    }
    if (raw.byteLength > 0) {
      bodyBuffer = raw;
    }
  }

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstreamUrl, {
      method,
      headers: upstreamHeaders,
      body: bodyBuffer,
      redirect: "manual",
      cache: "no-store",
      signal: req.signal,
    });
  } catch {
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
        },
      },
    );
  }

  const outgoingHeaders = new Headers();
  copyCommonMetadataHeaders(upstreamRes.headers, outgoingHeaders);

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

  const upstreamContentType = (
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
    const bytes = await upstreamRes.arrayBuffer();
    outgoingHeaders.set("Content-Type", upstreamContentType);
    outgoingHeaders.set("X-Content-Type-Options", "nosniff");
    return new Response(bytes, {
      status: upstreamRes.status,
      headers: outgoingHeaders,
    });
  }

  // JSON or error responses — parse and apply strict whitelist/sanitization
  const textBody = await upstreamRes.text();
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
    const sanitizedError = sanitizeErrorPayload(upstreamRes.status, parsed);
    return new Response(JSON.stringify(sanitizedError), {
      status: upstreamRes.status,
      headers: outgoingHeaders,
    });
  }

  const sanitizedOk =
    normalizedPath === "/v1/workbench/skills"
      ? sanitizeSlashSkillsResponse(parsed)
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
