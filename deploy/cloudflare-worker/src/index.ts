export interface VpcServiceFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface Env {
  AIOS_ORIGIN?: VpcServiceFetcher;
}

type WorkersRequestInit = RequestInit & {
  cf?: {
    cacheTtl?: number;
    cacheEverything?: boolean;
  };
};

const UPSTREAM_BASE = "http://127.0.0.1:3000";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function isStaticAssetPath(pathname: string): boolean {
  return (
    pathname.startsWith("/_next/static/") ||
    pathname === "/favicon.ico" ||
    pathname === "/robots.txt"
  );
}

function stripHopByHopHeaders(headers: Headers): void {
  const connectionValue = headers.get("connection");
  if (connectionValue) {
    for (const token of connectionValue.split(",")) {
      const normalized = token.trim().toLowerCase();
      if (normalized) {
        headers.delete(normalized);
      }
    }
  }
  for (const headerName of HOP_BY_HOP_HEADERS) {
    headers.delete(headerName);
  }
}

export function buildForwardHeaders(
  incomingHeaders: Headers,
  publicUrl: URL,
): Headers {
  const forward = new Headers(incomingHeaders);
  stripHopByHopHeaders(forward);

  forward.set("host", publicUrl.host);
  forward.set("x-forwarded-host", publicUrl.host);
  forward.set("x-forwarded-proto", "https");

  const cfConnectingIp = incomingHeaders.get("cf-connecting-ip");
  if (cfConnectingIp) {
    forward.set("x-real-ip", cfConnectingIp);
  }

  return forward;
}

export function rewriteLocationHeader(
  locationValue: string,
  publicUrl: URL,
): string {
  if (
    !locationValue.startsWith("http://") &&
    !locationValue.startsWith("https://")
  ) {
    return locationValue;
  }

  let parsed: URL;
  try {
    parsed = new URL(locationValue);
  } catch {
    return locationValue;
  }

  const normalizedHost = parsed.hostname.toLowerCase();
  const isLoopback = LOOPBACK_HOSTS.has(normalizedHost);
  const isOriginPort = parsed.port === "" || parsed.port === "3000";

  if (isLoopback && isOriginPort) {
    return `https://${publicUrl.host}${parsed.pathname}${parsed.search}${parsed.hash}`;
  }

  return locationValue;
}

export function applySecurityAndCacheHeaders(
  headers: Headers,
  pathname: string,
): void {
  headers.delete("x-powered-by");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-frame-options", "DENY");

  if (!isStaticAssetPath(pathname)) {
    headers.set("cache-control", "no-store, no-cache, must-revalidate, private");
    headers.set("pragma", "no-cache");
    headers.set("cdn-cache-control", "no-store");
  }
}

export function jsonErrorResponse(
  status: number,
  code: string,
  message: string,
): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
  });
  applySecurityAndCacheHeaders(headers, "/__worker_error");
  return new Response(
    JSON.stringify({ detail: { code, message } }),
    { status, headers },
  );
}

function readSetCookies(headers: Headers): string[] {
  const maybeHeaders = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof maybeHeaders.getSetCookie === "function") {
    return maybeHeaders.getSetCookie();
  }
  const singleCookie = headers.get("set-cookie");
  return singleCookie ? [singleCookie] : [];
}

function buildResponseHeaders(
  upstreamHeaders: Headers,
  publicUrl: URL,
): Headers {
  const responseHeaders = new Headers();
  const setCookies = readSetCookies(upstreamHeaders);

  for (const [key, value] of upstreamHeaders.entries()) {
    if (key.toLowerCase() === "set-cookie") {
      continue;
    }
    responseHeaders.append(key, value);
  }

  for (const cookie of setCookies) {
    responseHeaders.append("set-cookie", cookie);
  }

  stripHopByHopHeaders(responseHeaders);

  const location = responseHeaders.get("location");
  if (location) {
    responseHeaders.set(
      "location",
      rewriteLocationHeader(location, publicUrl),
    );
  }

  applySecurityAndCacheHeaders(responseHeaders, publicUrl.pathname);
  return responseHeaders;
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  if (!env.AIOS_ORIGIN || typeof env.AIOS_ORIGIN.fetch !== "function") {
    return jsonErrorResponse(
      503,
      "ORIGIN_BINDING_MISSING",
      "AIOS origin VPC service binding is not configured.",
    );
  }

  const publicUrl = new URL(request.url);
  const upstreamUrl = `${UPSTREAM_BASE}${publicUrl.pathname}${publicUrl.search}`;
  const forwardHeaders = buildForwardHeaders(request.headers, publicUrl);

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const init: WorkersRequestInit = {
    method: request.method,
    headers: forwardHeaders,
    redirect: "manual",
    cf: {
      cacheTtl: 0,
      cacheEverything: false,
    },
  };

  if (hasBody && request.body !== null) {
    init.body = request.body;
  }

  let upstreamResponse: Response;
  try {
    upstreamResponse = await env.AIOS_ORIGIN.fetch(upstreamUrl, init);
  } catch {
    return jsonErrorResponse(
      502,
      "UPSTREAM_UNREACHABLE",
      "AIOS upstream origin is temporarily unreachable.",
    );
  }

  const responseHeaders = buildResponseHeaders(
    upstreamResponse.headers,
    publicUrl,
  );

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
};
