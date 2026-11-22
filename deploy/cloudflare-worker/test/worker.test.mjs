import test from "node:test";
import assert from "node:assert/strict";

import worker, {
  applySecurityAndCacheHeaders,
  buildForwardHeaders,
  isStaticAssetPath,
  rewriteLocationHeader,
} from "../src/index.ts";

test("returns 503 JSON with no-store when AIOS_ORIGIN binding is missing", async () => {
  const req = new Request("https://aios-demo.hk-demo.workers.dev/readyz");
  const res = await worker.fetch(req, {});

  assert.equal(res.status, 503);
  assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(
    res.headers.get("cache-control"),
    "no-store, no-cache, must-revalidate, private",
  );
  assert.equal(res.headers.get("pragma"), "no-cache");
  assert.equal(res.headers.get("cdn-cache-control"), "no-store");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.equal(res.headers.get("x-frame-options"), "DENY");

  const body = await res.json();
  assert.equal(body.detail.code, "ORIGIN_BINDING_MISSING");
  assert.equal(JSON.stringify(body).includes("127.0.0.1"), false);
  assert.equal(JSON.stringify(body).includes("47.242."), false);
});

test("forwards required proxy headers, CSRF, cookies, idempotency, and strips hop-by-hop headers", async () => {
  let capturedInput = "";
  let capturedInit;

  const env = {
    AIOS_ORIGIN: {
      async fetch(input, init) {
        capturedInput = String(input);
        capturedInit = init;
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-powered-by": "Next.js",
            connection: "keep-alive",
          },
        });
      },
    },
  };

  const req = new Request("https://aios-demo.hk-demo.workers.dev/api/v1/chat?stream=1", {
    method: "POST",
    headers: {
      origin: "https://aios-demo.hk-demo.workers.dev",
      cookie: "__Host-aios_session=abc123",
      "x-csrf-token": "csrf-xyz",
      "idempotency-key": "idem-001",
      "cf-connecting-ip": "203.0.113.10",
      connection: "keep-alive, x-custom-hop",
      "x-custom-hop": "drop-me",
      "proxy-authorization": "Basic secret",
      "content-type": "application/json",
    },
    body: JSON.stringify({ prompt: "hello" }),
  });

  const res = await worker.fetch(req, env);
  assert.equal(res.status, 200);
  assert.equal(capturedInput, "http://127.0.0.1:3000/api/v1/chat?stream=1");
  assert.equal(capturedInit.method, "POST");
  assert.equal(capturedInit.redirect, "manual");
  assert.deepEqual(capturedInit.cf, { cacheTtl: 0, cacheEverything: false });
  assert.ok(capturedInit.body);

  const sentHeaders = new Headers(capturedInit.headers);
  assert.equal(sentHeaders.get("host"), "aios-demo.hk-demo.workers.dev");
  assert.equal(sentHeaders.get("x-forwarded-host"), "aios-demo.hk-demo.workers.dev");
  assert.equal(sentHeaders.get("x-forwarded-proto"), "https");
  assert.equal(sentHeaders.get("x-real-ip"), "203.0.113.10");
  assert.equal(sentHeaders.get("origin"), "https://aios-demo.hk-demo.workers.dev");
  assert.equal(sentHeaders.get("cookie"), "__Host-aios_session=abc123");
  assert.equal(sentHeaders.get("x-csrf-token"), "csrf-xyz");
  assert.equal(sentHeaders.get("idempotency-key"), "idem-001");
  assert.equal(sentHeaders.get("connection"), null);
  assert.equal(sentHeaders.get("x-custom-hop"), null);
  assert.equal(sentHeaders.get("proxy-authorization"), null);

  assert.equal(res.headers.get("x-powered-by"), null);
  assert.equal(res.headers.get("connection"), null);
  assert.equal(
    res.headers.get("cache-control"),
    "no-store, no-cache, must-revalidate, private",
  );
  assert.equal(res.headers.get("cdn-cache-control"), "no-store");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
});

test("preserves multiple Set-Cookie headers on login/session responses", async () => {
  const upstreamHeaders = new Headers({
    "content-type": "application/json",
    "x-powered-by": "Express",
  });
  upstreamHeaders.append(
    "set-cookie",
    "__Host-aios_session=sess1; Path=/; HttpOnly; Secure; SameSite=Lax",
  );
  upstreamHeaders.append(
    "set-cookie",
    "__Host-aios_csrf=csrf1; Path=/; Secure; SameSite=Lax",
  );

  const env = {
    AIOS_ORIGIN: {
      async fetch() {
        return new Response(JSON.stringify({ authenticated: true }), {
          status: 200,
          headers: upstreamHeaders,
        });
      },
    },
  };

  const req = new Request("https://aios-demo.hk-demo.workers.dev/api/auth/login", {
    method: "POST",
  });
  const res = await worker.fetch(req, env);

  const cookies = res.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  assert.ok(cookies[0].startsWith("__Host-aios_session=sess1"));
  assert.ok(cookies[1].startsWith("__Host-aios_csrf=csrf1"));
  assert.equal(res.headers.get("x-powered-by"), null);
});

test("rewrites loopback Location redirects to https public host", async () => {
  const env = {
    AIOS_ORIGIN: {
      async fetch() {
        return new Response(null, {
          status: 307,
          headers: {
            location: "http://127.0.0.1:3000/login?next=%2Fworkspace",
          },
        });
      },
    },
  };

  const req = new Request("https://aios-demo.hk-demo.workers.dev/");
  const res = await worker.fetch(req, env);

  assert.equal(res.status, 307);
  assert.equal(
    res.headers.get("location"),
    "https://aios-demo.hk-demo.workers.dev/login?next=%2Fworkspace",
  );

  const publicUrl = new URL("https://aios-demo.hk-demo.workers.dev/test");
  assert.equal(
    rewriteLocationHeader("http://localhost:3000/chat#top", publicUrl),
    "https://aios-demo.hk-demo.workers.dev/chat#top",
  );
  assert.equal(
    rewriteLocationHeader("http://[::1]:3000/readyz", publicUrl),
    "https://aios-demo.hk-demo.workers.dev/readyz",
  );
  assert.equal(
    rewriteLocationHeader("https://127.0.0.1/callback", publicUrl),
    "https://aios-demo.hk-demo.workers.dev/callback",
  );
  assert.equal(
    rewriteLocationHeader("https://accounts.google.com/o/oauth2/auth", publicUrl),
    "https://accounts.google.com/o/oauth2/auth",
  );
  assert.equal(rewriteLocationHeader("/relative/path", publicUrl), "/relative/path");
});

test("preserves upstream cache headers on static assets while stripping x-powered-by", async () => {
  assert.equal(isStaticAssetPath("/_next/static/chunks/main.js"), true);
  assert.equal(isStaticAssetPath("/favicon.ico"), true);
  assert.equal(isStaticAssetPath("/robots.txt"), true);
  assert.equal(isStaticAssetPath("/api/health"), false);

  const env = {
    AIOS_ORIGIN: {
      async fetch() {
        return new Response("console.log('ok');", {
          status: 200,
          headers: {
            "content-type": "application/javascript",
            "cache-control": "public, max-age=31536000, immutable",
            "x-powered-by": "Next.js",
          },
        });
      },
    },
  };

  const req = new Request("https://aios-demo.hk-demo.workers.dev/_next/static/chunks/app.js");
  const res = await worker.fetch(req, env);

  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(res.headers.get("cdn-cache-control"), null);
  assert.equal(res.headers.get("x-powered-by"), null);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
});

test("masks upstream network/VPC errors as sanitized 502 JSON with no-store", async () => {
  const env = {
    AIOS_ORIGIN: {
      async fetch() {
        throw new Error("ECONNREFUSED 127.0.0.1:3000 via tunnel 3d90b761");
      },
    },
  };

  const req = new Request("https://aios-demo.hk-demo.workers.dev/api/sessions");
  const res = await worker.fetch(req, env);

  assert.equal(res.status, 502);
  assert.equal(
    res.headers.get("cache-control"),
    "no-store, no-cache, must-revalidate, private",
  );
  const rawText = await res.text();
  assert.equal(rawText.includes("ECONNREFUSED"), false);
  assert.equal(rawText.includes("127.0.0.1"), false);
  assert.equal(rawText.includes("3d90b761"), false);
  const parsed = JSON.parse(rawText);
  assert.equal(parsed.detail.code, "UPSTREAM_UNREACHABLE");
});

test("buildForwardHeaders and applySecurityAndCacheHeaders work independently", () => {
  const incoming = new Headers({
    "cf-connecting-ip": "198.51.100.7",
    "transfer-encoding": "chunked",
  });
  const forwarded = buildForwardHeaders(
    incoming,
    new URL("https://demo.example.org/workspace"),
  );
  assert.equal(forwarded.get("host"), "demo.example.org");
  assert.equal(forwarded.get("x-forwarded-host"), "demo.example.org");
  assert.equal(forwarded.get("x-forwarded-proto"), "https");
  assert.equal(forwarded.get("x-real-ip"), "198.51.100.7");
  assert.equal(forwarded.get("transfer-encoding"), null);

  const headers = new Headers({ "x-powered-by": "Next.js" });
  applySecurityAndCacheHeaders(headers, "/workspace");
  assert.equal(headers.get("x-powered-by"), null);
  assert.equal(headers.get("x-frame-options"), "DENY");
  assert.equal(headers.get("pragma"), "no-cache");
});
