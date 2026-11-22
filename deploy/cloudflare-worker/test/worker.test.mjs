import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import worker, {
  applySecurityAndCacheHeaders,
  buildForwardHeaders,
  isStaticAssetPath,
  rewriteLocationHeader,
} from "../src/index.ts";
import {
  normalizePasscodeInput,
  resetGateRateLimitsForTesting,
  setGateClockForTesting,
  signCapabilityToken,
} from "../src/reviewer-gate.ts";

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

const TEST_GATE_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TEST_REVIEWER_PASS = "THEODIC-DEMO-K9M4Q-R7V2N";
const TEST_TEAM_PASS = "THEODIC-TEAM-X8P3L-W5N9K";

function createGateEnv(overrides = {}) {
  let originCalls = 0;
  let lastOriginInput = null;
  let lastOriginInit = null;

  const env = {
    AIOS_GATE_SECRET: TEST_GATE_SECRET,
    AIOS_REVIEWER_PASSCODE: TEST_REVIEWER_PASS,
    AIOS_TEAM_PASSCODE: TEST_TEAM_PASS,
    AIOS_REVIEWER_EXPIRES_AT: "2027-03-31T23:59:59Z",
    AIOS_ORIGIN: {
      async fetch(input, init) {
        originCalls += 1;
        lastOriginInput = String(input);
        lastOriginInit = init;
        return new Response(JSON.stringify({ ok: true, origin: true }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-powered-by": "Next.js",
          },
        });
      },
    },
    ...overrides,
  };

  return {
    env,
    stats: () => ({ originCalls, lastOriginInput, lastOriginInit }),
  };
}

function extractCookiePair(setCookieHeaders, cookieName) {
  for (const header of setCookieHeaders) {
    const firstSemi = header.indexOf(";");
    const pair = firstSemi === -1 ? header : header.slice(0, firstSemi);
    if (pair.startsWith(`${cookieName}=`)) {
      return pair;
    }
  }
  return null;
}

async function authenticateAs(env, passcode, ip = "203.0.113.50") {
  const res = await worker.fetch(
    new Request("https://aios-demo.hk-demo.workers.dev/__gate/verify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": ip,
      },
      body: JSON.stringify({ passcode }),
    }),
    env,
  );
  assert.equal(res.status, 200);
  const cookies = res.headers.getSetCookie();
  const gateCookie = extractCookiePair(cookies, "__Host-aios_gate");
  assert.ok(gateCookie);
  return gateCookie;
}

test("whitespace AIOS_GATE_SECRET preserves pass-through behavior without X-Robots-Tag", async () => {
  const { env, stats } = createGateEnv({ AIOS_GATE_SECRET: "   " });
  const res = await worker.fetch(
    new Request("https://aios-demo.hk-demo.workers.dev/readyz"),
    env,
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-robots-tag"), null);
  assert.equal(stats().originCalls, 1);
});

test("gate serves /robots.txt directly and sets X-Robots-Tag on all responses", async () => {
  resetGateRateLimitsForTesting();
  const { env, stats } = createGateEnv();
  const res = await worker.fetch(
    new Request("https://aios-demo.hk-demo.workers.dev/robots.txt"),
    env,
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
  assert.equal(await res.text(), "User-agent: *\nDisallow: /\n");
  assert.equal(stats().originCalls, 0);
});

test("unauthenticated requests never reach AIOS_ORIGIN and return 401 HTML or JSON", async () => {
  resetGateRateLimitsForTesting();
  const { env, stats } = createGateEnv();

  const htmlReq = new Request("https://aios-demo.hk-demo.workers.dev/login", {
    headers: { accept: "text/html,application/xhtml+xml" },
  });
  const htmlRes = await worker.fetch(htmlReq, env);
  assert.equal(htmlRes.status, 401);
  assert.match(htmlRes.headers.get("content-type") ?? "", /^text\/html/);
  assert.equal(htmlRes.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
  const htmlBody = await htmlRes.text();
  assert.ok(htmlBody.includes("Theodic · Live MVP Reviewer Gate"));
  assert.equal(htmlBody.toLowerCase().includes("oth" + "eon"), false);
  assert.equal(htmlBody.toLowerCase().includes("cc" + "mf"), false);
  assert.equal(htmlBody.toLowerCase().includes("cyber" + "port"), false);

  const apiRes = await worker.fetch(
    new Request("https://aios-demo.hk-demo.workers.dev/v1/me", {
      headers: { accept: "application/json" },
    }),
    env,
  );
  assert.equal(apiRes.status, 401);
  assert.equal(apiRes.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
  const apiJson = await apiRes.json();
  assert.equal(apiJson.detail.code, "REVIEWER_PASS_REQUIRED");

  const staticRes = await worker.fetch(
    new Request("https://aios-demo.hk-demo.workers.dev/_next/static/chunks/main.js"),
    env,
  );
  assert.equal(staticRes.status, 401);

  const postWithHtmlAccept = await worker.fetch(
    new Request("https://aios-demo.hk-demo.workers.dev/api/auth/demo-login", {
      method: "POST",
      headers: { accept: "text/html" },
      body: JSON.stringify({ persona: "ops" }),
    }),
    env,
  );
  assert.equal(postWithHtmlAccept.status, 401);
  assert.equal((await postWithHtmlAccept.json()).detail.code, "REVIEWER_PASS_REQUIRED");

  assert.equal(stats().originCalls, 0);
});

test("GET /review serves Theodic Warm Museum Alabaster gate page with interlocking arch SVG and fragment scrubber", async () => {
  resetGateRateLimitsForTesting();
  const { env, stats } = createGateEnv();

  const res = await worker.fetch(
    new Request("https://aios-demo.hk-demo.workers.dev/review"),
    env,
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^text\/html/);
  assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
  assert.equal(
    res.headers.get("cache-control"),
    "no-store, no-cache, must-revalidate, private",
  );

  const html = await res.text();
  assert.ok(html.includes("Theodic · Live MVP Reviewer Gate"));
  assert.ok(html.includes("Reviewer Sandbox"));
  assert.ok(html.includes("THEODIC-DEMO-XXXXX-XXXXX"));
  assert.ok(html.includes("Please enter your Theodic reviewer passcode."));
  assert.ok(html.includes("Connecting intelligence with the way industries work."));
  assert.ok(html.includes("#FAF8F5"));
  assert.ok(html.includes("#FFFFFF"));
  assert.ok(html.includes("#DCD5CB"));
  assert.ok(html.includes("#171717"));
  assert.ok(html.includes("#1B4F9C"));
  assert.ok(html.includes("theodic-arch-fold"));
  assert.ok(html.includes("var verifying = false;"));
  assert.ok(html.includes("<noscript>"));
  assert.equal(html.toLowerCase().includes("oth" + "eon"), false);
  assert.equal(html.toLowerCase().includes("cc" + "mf"), false);
  assert.equal(html.toLowerCase().includes("cyber" + "port"), false);
  assert.ok(html.includes("window.location.hash.slice(1)"));
  assert.ok(html.includes('history.replaceState(null, "", "/review")'));
  assert.ok(html.includes("/__gate/verify"));
  assert.ok(html.includes("<form"));
  assert.equal(stats().originCalls, 0);
});

test("GET /review?pass=<val> verifies passcode or HMAC token, sets cookies, and 303 redirects to /login", async () => {
  resetGateRateLimitsForTesting();
  const now = Date.parse("2026-11-22T12:00:00Z");
  setGateClockForTesting(() => now);
  try {
    const { env, stats } = createGateEnv();

    // 1. Raw reviewer passcode via ?pass=
    const passRes = await worker.fetch(
      new Request(
        `https://aios-demo.hk-demo.workers.dev/review?pass=${encodeURIComponent(TEST_REVIEWER_PASS)}`,
        { headers: { "cf-connecting-ip": "198.51.100.20" } },
      ),
      env,
    );
    assert.equal(passRes.status, 303);
    assert.equal(
      passRes.headers.get("location"),
      "https://aios-demo.hk-demo.workers.dev/login",
    );
    assert.equal(passRes.headers.get("referrer-policy"), "no-referrer");
    assert.equal(
      passRes.headers.get("cache-control"),
      "no-store, no-cache, must-revalidate, private",
    );
    assert.equal(passRes.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");

    const cookies = passRes.headers.getSetCookie();
    assert.equal(cookies.length, 2);
    assert.match(
      cookies[0],
      /^__Host-aios_gate=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=28800$/,
    );
    assert.equal(
      cookies[1],
      "aios_locale=en; Path=/; Secure; SameSite=Lax; Max-Age=2592000",
    );

    // 2. Signed HMAC-SHA256 capability token via ?pass=
    const expUnix = Math.floor(Date.parse("2027-03-31T23:59:59Z") / 1000);
    const signedJudgeToken = await signCapabilityToken(TEST_GATE_SECRET, expUnix, "judge");
    const signedRes = await worker.fetch(
      new Request(
        `https://aios-demo.hk-demo.workers.dev/review?pass=${encodeURIComponent(signedJudgeToken)}`,
        { headers: { "cf-connecting-ip": "198.51.100.21" } },
      ),
      env,
    );
    assert.equal(signedRes.status, 303);
    assert.equal(
      signedRes.headers.get("location"),
      "https://aios-demo.hk-demo.workers.dev/login",
    );

    // 3. Expired capability token fails with 401 and zero cookies
    const expiredToken = await signCapabilityToken(
      TEST_GATE_SECRET,
      Math.floor(now / 1000) - 60,
      "judge",
    );
    const expiredRes = await worker.fetch(
      new Request(
        `https://aios-demo.hk-demo.workers.dev/review?pass=${encodeURIComponent(expiredToken)}`,
        { headers: { "cf-connecting-ip": "198.51.100.22" } },
      ),
      env,
    );
    assert.equal(expiredRes.status, 401);
    assert.equal(expiredRes.headers.getSetCookie().length, 0);

    // 4. Tampered capability token fails with 401
    const tampered = `${signedJudgeToken.slice(0, -2)}00`;
    const tamperedRes = await worker.fetch(
      new Request(
        `https://aios-demo.hk-demo.workers.dev/review?pass=${encodeURIComponent(tampered)}`,
        { headers: { "cf-connecting-ip": "198.51.100.23" } },
      ),
      env,
    );
    assert.equal(tamperedRes.status, 401);
    assert.equal(stats().originCalls, 0);
  } finally {
    setGateClockForTesting(null);
  }
});

test("POST /__gate/verify issues scoped cookies, respects expiry, and enforces 5 failures / 10 min brute-force limit", async () => {
  resetGateRateLimitsForTesting();
  let now = Date.parse("2026-11-22T12:00:00Z");
  setGateClockForTesting(() => now);
  try {
    const { env } = createGateEnv();

    // Valid judge passcode
    const judgeRes = await worker.fetch(
      new Request("https://aios-demo.hk-demo.workers.dev/__gate/verify", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "198.51.100.30",
        },
        body: JSON.stringify({ passcode: TEST_REVIEWER_PASS }),
      }),
      env,
    );
    assert.equal(judgeRes.status, 200);
    assert.deepEqual(await judgeRes.json(), {
      ok: true,
      redirect: "/login",
      scope: "judge",
    });
    assert.equal(judgeRes.headers.getSetCookie().length, 2);

    // Valid team passcode
    const teamRes = await worker.fetch(
      new Request("https://aios-demo.hk-demo.workers.dev/__gate/verify", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "198.51.100.31",
        },
        body: JSON.stringify({ passcode: TEST_TEAM_PASS }),
      }),
      env,
    );
    assert.equal(teamRes.status, 200);
    assert.deepEqual(await teamRes.json(), {
      ok: true,
      redirect: "/login",
      scope: "team",
    });

    // Brute-force lockout: 5 failures -> 401, 6th -> 429 + Retry-After: 600
    for (let i = 0; i < 5; i += 1) {
      const failRes = await worker.fetch(
        new Request("https://aios-demo.hk-demo.workers.dev/__gate/verify", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "cf-connecting-ip": "198.51.100.99",
          },
          body: JSON.stringify({ passcode: `WRONG-${i}` }),
        }),
        env,
      );
      assert.equal(failRes.status, 401);
    }

    const lockedRes = await worker.fetch(
      new Request("https://aios-demo.hk-demo.workers.dev/__gate/verify", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "198.51.100.99",
        },
        body: JSON.stringify({ passcode: TEST_REVIEWER_PASS }),
      }),
      env,
    );
    assert.equal(lockedRes.status, 429);
    assert.equal(lockedRes.headers.get("retry-after"), "600");

    // Different IP is unaffected
    const otherIpRes = await worker.fetch(
      new Request("https://aios-demo.hk-demo.workers.dev/__gate/verify", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "198.51.100.100",
        },
        body: JSON.stringify({ passcode: TEST_REVIEWER_PASS }),
      }),
      env,
    );
    assert.equal(otherIpRes.status, 200);

    // After 10 minutes + 1s, blocked IP recovers
    now += 601_000;
    const recoveredRes = await worker.fetch(
      new Request("https://aios-demo.hk-demo.workers.dev/__gate/verify", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "198.51.100.99",
        },
        body: JSON.stringify({ passcode: TEST_REVIEWER_PASS }),
      }),
      env,
    );
    assert.equal(recoveredRes.status, 200);

    // Expired AIOS_REVIEWER_EXPIRES_AT rejects valid passcodes
    const { env: expiredEnv } = createGateEnv({
      AIOS_REVIEWER_EXPIRES_AT: "2026-01-01T00:00:00Z",
    });
    const expRes = await worker.fetch(
      new Request("https://aios-demo.hk-demo.workers.dev/__gate/verify", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "198.51.100.101",
        },
        body: JSON.stringify({ passcode: TEST_REVIEWER_PASS }),
      }),
      expiredEnv,
    );
    assert.equal(expRes.status, 401);
  } finally {
    setGateClockForTesting(null);
  }
});

test("logout endpoints clear __Host-aios_gate with Max-Age=0 and expired session cookies are rejected", async () => {
  resetGateRateLimitsForTesting();
  let now = Date.parse("2026-11-22T12:00:00Z");
  setGateClockForTesting(() => now);
  try {
    const { env, stats } = createGateEnv();
    const gateCookie = await authenticateAs(env, TEST_REVIEWER_PASS, "198.51.100.40");

    // Valid before 8 hours
    const okRes = await worker.fetch(
      new Request("https://aios-demo.hk-demo.workers.dev/v1/me", {
        headers: { cookie: gateCookie },
      }),
      env,
    );
    assert.equal(okRes.status, 200);
    assert.equal(stats().originCalls, 1);

    // POST /__gate/logout clears __Host-aios_gate
    const apiLogout = await worker.fetch(
      new Request("https://aios-demo.hk-demo.workers.dev/__gate/logout", {
        method: "POST",
        headers: { cookie: gateCookie },
      }),
      env,
    );
    assert.equal(apiLogout.status, 200);
    assert.equal(apiLogout.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
    const apiLogoutCookies = apiLogout.headers.getSetCookie();
    assert.equal(apiLogoutCookies.length, 1);
    assert.ok(apiLogoutCookies[0].startsWith("__Host-aios_gate=;"));
    assert.ok(apiLogoutCookies[0].includes("Max-Age=0"));

    // GET /review/logout clears __Host-aios_gate and redirects to /review
    const browserLogout = await worker.fetch(
      new Request("https://aios-demo.hk-demo.workers.dev/review/logout", {
        headers: { cookie: gateCookie },
      }),
      env,
    );
    assert.equal(browserLogout.status, 303);
    assert.equal(
      browserLogout.headers.get("location"),
      "https://aios-demo.hk-demo.workers.dev/review",
    );
    const browserLogoutCookies = browserLogout.headers.getSetCookie();
    assert.equal(browserLogoutCookies.length, 1);
    assert.ok(browserLogoutCookies[0].includes("Max-Age=0"));

    // Advancing clock beyond 8 hours invalidates existing cookie token
    now += 28_801 * 1000;
    const expiredRes = await worker.fetch(
      new Request("https://aios-demo.hk-demo.workers.dev/v1/me", {
        headers: { cookie: gateCookie },
      }),
      env,
    );
    assert.equal(expiredRes.status, 401);
    assert.equal(stats().originCalls, 1);
  } finally {
    setGateClockForTesting(null);
  }
});

test("strips __Host-aios_gate from upstream Cookie header while preserving app cookies and X-Robots-Tag", async () => {
  resetGateRateLimitsForTesting();
  const { env, stats } = createGateEnv();
  const gateCookie = await authenticateAs(env, TEST_REVIEWER_PASS, "198.51.100.45");

  const res = await worker.fetch(
    new Request("https://aios-demo.hk-demo.workers.dev/v1/workbench/capabilities", {
      headers: {
        cookie: `__Host-aios_session=sess-abc; ${gateCookie}; aios_locale=en`,
      },
    }),
    env,
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");

  const forwardedHeaders = new Headers(stats().lastOriginInit.headers);
  assert.equal(forwardedHeaders.get("cookie"), "__Host-aios_session=sess-abc; aios_locale=en");

  // When only __Host-aios_gate is present, cookie header is removed completely
  await worker.fetch(
    new Request("https://aios-demo.hk-demo.workers.dev/v1/me", {
      headers: { cookie: gateCookie },
    }),
    env,
  );
  const forwardedOnlyGate = new Headers(stats().lastOriginInit.headers);
  assert.equal(forwardedOnlyGate.get("cookie"), null);
});

test("enforces per-IP LLM turn limits (8/min & 40/hr), mutation limits (30/min), and 8 MiB payload limit", async () => {
  resetGateRateLimitsForTesting();
  let now = Date.parse("2026-11-22T12:00:00Z");
  setGateClockForTesting(() => now);
  try {
    const { env, stats } = createGateEnv();
    const gateCookie = await authenticateAs(env, TEST_REVIEWER_PASS, "198.51.100.55");

    // 1. Payload > 8388608 -> 413
    const tooLargeRes = await worker.fetch(
      new Request("https://aios-demo.hk-demo.workers.dev/v1/intakes/po-1/structured", {
        method: "POST",
        headers: {
          cookie: gateCookie,
          "cf-connecting-ip": "198.51.100.55",
          "content-length": "8388609",
        },
        body: "{}",
      }),
      env,
    );
    assert.equal(tooLargeRes.status, 413);
    assert.equal(stats().originCalls, 0);

    // 2. LLM turns: 8/min allowed, 9th -> 429 REVIEWER_LLM_RATE_LIMITED
    for (let i = 0; i < 8; i += 1) {
      const okTurn = await worker.fetch(
        new Request("https://aios-demo.hk-demo.workers.dev/v1/workbench/turns", {
          method: "POST",
          headers: {
            cookie: gateCookie,
            "cf-connecting-ip": "198.51.100.55",
            "content-type": "application/json",
          },
          body: JSON.stringify({ prompt: `turn ${i}` }),
        }),
        env,
      );
      assert.equal(okTurn.status, 200);
    }
    const ninthTurn = await worker.fetch(
      new Request("https://aios-demo.hk-demo.workers.dev/v1/workbench/turns", {
        method: "POST",
        headers: {
          cookie: gateCookie,
          "cf-connecting-ip": "198.51.100.55",
          "content-type": "application/json",
        },
        body: JSON.stringify({ prompt: "turn 9" }),
      }),
      env,
    );
    assert.equal(ninthTurn.status, 429);
    assert.ok(ninthTurn.headers.get("retry-after"));
    assert.equal((await ninthTurn.json()).detail.code, "REVIEWER_LLM_RATE_LIMITED");

    // 3. Hourly LLM cap: 4 more batches of 8 (total 40 in 1 hr), 41st -> 429 REVIEWER_LLM_RATE_LIMITED
    for (let batch = 0; batch < 4; batch += 1) {
      now += 61_000;
      for (let i = 0; i < 8; i += 1) {
        const res = await worker.fetch(
          new Request("https://aios-demo.hk-demo.workers.dev/v1/workbench/turns", {
            method: "POST",
            headers: {
              cookie: gateCookie,
              "cf-connecting-ip": "198.51.100.55",
              "content-type": "application/json",
            },
            body: JSON.stringify({ prompt: `batch ${batch}-${i}` }),
          }),
          env,
        );
        assert.equal(res.status, 200);
      }
    }
    now += 61_000;
    const fortyFirstTurn = await worker.fetch(
      new Request("https://aios-demo.hk-demo.workers.dev/v1/workbench/turns", {
        method: "POST",
        headers: {
          cookie: gateCookie,
          "cf-connecting-ip": "198.51.100.55",
          "content-type": "application/json",
        },
        body: JSON.stringify({ prompt: "turn 41" }),
      }),
      env,
    );
    assert.equal(fortyFirstTurn.status, 429);
    assert.equal((await fortyFirstTurn.json()).detail.code, "REVIEWER_LLM_RATE_LIMITED");

    // 4. General mutating requests: 30/min allowed, 31st -> 429 (GET remains allowed)
    const gateCookieMut = await authenticateAs(env, TEST_REVIEWER_PASS, "198.51.100.56");
    for (let i = 0; i < 30; i += 1) {
      const okMut = await worker.fetch(
        new Request("https://aios-demo.hk-demo.workers.dev/v1/proposals/prop-1/approve", {
          method: "POST",
          headers: {
            cookie: gateCookieMut,
            "cf-connecting-ip": "198.51.100.56",
          },
          body: "{}",
        }),
        env,
      );
      assert.equal(okMut.status, 200);
    }
    const thirtyFirstMut = await worker.fetch(
      new Request("https://aios-demo.hk-demo.workers.dev/v1/proposals/prop-1/approve", {
        method: "POST",
        headers: {
          cookie: gateCookieMut,
          "cf-connecting-ip": "198.51.100.56",
        },
        body: "{}",
      }),
      env,
    );
    assert.equal(thirtyFirstMut.status, 429);
    assert.ok(thirtyFirstMut.headers.get("retry-after"));

    const getStillOk = await worker.fetch(
      new Request("https://aios-demo.hk-demo.workers.dev/v1/proposals/prop-1", {
        method: "GET",
        headers: {
          cookie: gateCookieMut,
          "cf-connecting-ip": "198.51.100.56",
        },
      }),
      env,
    );
    assert.equal(getStillOk.status, 200);
  } finally {
    setGateClockForTesting(null);
  }
});

test("judge scope blocks destructive admin mutations with 403 while allowing core demo workflows; team scope allows all", async () => {
  resetGateRateLimitsForTesting();
  const { env, stats } = createGateEnv();
  const judgeCookie = await authenticateAs(env, TEST_REVIEWER_PASS, "198.51.100.60");
  const teamCookie = await authenticateAs(env, TEST_TEAM_PASS, "198.51.100.61");

  const blockedForJudge = [
    ["POST", "/v1/admin/reset"],
    ["DELETE", "/v1/admin/users/123"],
    ["POST", "/v1//ADMIN/config"],
    ["POST", "/v1/ops/pause"],
    ["PUT", "/v1/tenants/t1/suspend"],
    ["PUT", "/v1/operations/write-control"],
    ["PUT", "/v1/operations/subjects/ops/suspension"],
  ];

  for (const [method, reqPath] of blockedForJudge) {
    const res = await worker.fetch(
      new Request(`https://aios-demo.hk-demo.workers.dev${reqPath}`, {
        method,
        headers: {
          cookie: judgeCookie,
          "cf-connecting-ip": "198.51.100.60",
        },
        body: "{}",
      }),
      env,
    );
    assert.equal(res.status, 403, `Expected 403 for judge ${method} ${reqPath}`);
    const body = await res.json();
    assert.equal(body.detail.code, "JUDGE_SANDBOX_PROTECTED");
  }
  assert.equal(stats().originCalls, 0);

  const allowedForJudge = [
    ["POST", "/api/auth/demo-login"],
    ["POST", "/v1/intakes/po-101/structured"],
    ["GET", "/v1/proposals/prop-101"],
    ["POST", "/v1/proposals/prop-101/approve"],
    ["POST", "/v1/proposals/prop-101/reconcile"],
    ["GET", "/v1/assurance/audit/checkpoint"],
    ["POST", "/v1/assurance/cases/case-1/reviews"],
    ["GET", "/v1/operations/summary"],
  ];

  for (const [method, reqPath] of allowedForJudge) {
    const res = await worker.fetch(
      new Request(`https://aios-demo.hk-demo.workers.dev${reqPath}`, {
        method,
        headers: {
          cookie: judgeCookie,
          "cf-connecting-ip": "198.51.100.60",
        },
        body: method === "GET" ? undefined : "{}",
      }),
      env,
    );
    assert.equal(res.status, 200, `Expected 200 for judge ${method} ${reqPath}`);
  }

  for (const [method, reqPath] of blockedForJudge) {
    const res = await worker.fetch(
      new Request(`https://aios-demo.hk-demo.workers.dev${reqPath}`, {
        method,
        headers: {
          cookie: teamCookie,
          "cf-connecting-ip": "198.51.100.61",
        },
        body: "{}",
      }),
      env,
    );
    assert.equal(res.status, 200, `Expected 200 for team ${method} ${reqPath}`);
  }
});

test("generate-reviewer-pass.mjs produces valid non-leaking credentials compatible with worker verification", async () => {
  resetGateRateLimitsForTesting();
  const tempDir = mkdtempSync(path.join(tmpdir(), "aios-pass-test-"));
  const outPath = path.join(tempDir, "pass.json");
  try {
    const stdout = execFileSync(
      process.execPath,
      [
        path.resolve("scripts/generate-reviewer-pass.mjs"),
        "--out",
        outPath,
      ],
      { encoding: "utf8" },
    );

    const generated = JSON.parse(readFileSync(outPath, "utf8"));
    assert.equal(generated.public_base_url, "https://aios-demo.hk-demo.workers.dev");
    assert.equal(generated.expires_at, "2027-03-31T23:59:59Z");
    assert.ok(generated.reviewer_passcode.startsWith("THEODIC-DEMO-"));
    assert.ok(generated.team_passcode.startsWith("THEODIC-TEAM-"));
    assert.ok(generated.reviewer_fragment_url.endsWith(`#${generated.reviewer_passcode}`));
    assert.ok(generated.reviewer_signed_url.includes("/review?pass="));

    // Confirm no secrets were printed to stdout
    assert.equal(stdout.includes(generated.gate_secret), false);
    assert.equal(stdout.includes(generated.reviewer_passcode), false);
    assert.equal(stdout.includes(generated.team_passcode), false);

    // Confirm generated signed URL unlocks the Worker gate
    const { env } = createGateEnv({
      AIOS_GATE_SECRET: generated.gate_secret,
      AIOS_REVIEWER_PASSCODE: generated.reviewer_passcode,
      AIOS_TEAM_PASSCODE: generated.team_passcode,
      AIOS_REVIEWER_EXPIRES_AT: generated.expires_at,
    });
    const signedRes = await worker.fetch(
      new Request(generated.reviewer_signed_url, {
        headers: { "cf-connecting-ip": "198.51.100.77" },
      }),
      env,
    );
    assert.equal(signedRes.status, 303);
    assert.equal(
      signedRes.headers.get("location"),
      "https://aios-demo.hk-demo.workers.dev/login",
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("normalizePasscodeInput tolerates lowercase, extra whitespace, and Unicode dashes while capability tokens stay case-sensitive", async () => {
  resetGateRateLimitsForTesting();
  const now = Date.parse("2026-11-22T12:00:00Z");
  setGateClockForTesting(() => now);
  try {
    assert.equal(
      normalizePasscodeInput("  theodic\u2013demo \u2014 k9m4q\u2212r7v2n  "),
      "THEODIC-DEMO-K9M4Q-R7V2N",
    );

    const { env, stats } = createGateEnv();
    const variants = [
      TEST_REVIEWER_PASS.toLowerCase(),
      `  ${TEST_REVIEWER_PASS}  `,
      "  theodic - demo \u2013 k9m4q \u2014 r7v2n ",
      TEST_REVIEWER_PASS.replaceAll("-", "\u2013"),
    ];

    for (let i = 0; i < variants.length; i += 1) {
      const variant = variants[i];
      const postRes = await worker.fetch(
        new Request("https://aios-demo.hk-demo.workers.dev/__gate/verify", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "cf-connecting-ip": `198.51.100.${120 + i}`,
          },
          body: JSON.stringify({ passcode: variant }),
        }),
        env,
      );
      assert.equal(postRes.status, 200, `Expected 200 on POST /__gate/verify for variant #${i}`);
      assert.deepEqual(await postRes.json(), {
        ok: true,
        redirect: "/login",
        scope: "judge",
      });

      const getRes = await worker.fetch(
        new Request(
          `https://aios-demo.hk-demo.workers.dev/review?pass=${encodeURIComponent(variant)}`,
          { headers: { "cf-connecting-ip": `198.51.100.${140 + i}` } },
        ),
        env,
      );
      assert.equal(getRes.status, 303, `Expected 303 on GET /review?pass= for variant #${i}`);
      assert.equal(
        getRes.headers.get("location"),
        "https://aios-demo.hk-demo.workers.dev/login",
      );
    }

    // Signed capability token must remain case-sensitive on scope/hex
    const expUnix = Math.floor(Date.parse("2027-03-31T23:59:59Z") / 1000);
    const signedToken = await signCapabilityToken(TEST_GATE_SECRET, expUnix, "judge");
    const upperTokenRes = await worker.fetch(
      new Request(
        `https://aios-demo.hk-demo.workers.dev/review?pass=${encodeURIComponent(signedToken.toUpperCase())}`,
        { headers: { "cf-connecting-ip": "198.51.100.160" } },
      ),
      env,
    );
    assert.equal(upperTokenRes.status, 401);
    assert.equal(stats().originCalls, 0);
  } finally {
    setGateClockForTesting(null);
  }
});

test("already-authenticated GET /review with valid __Host-aios_gate cookie redirects 303 to /login; invalid/expired falls back to 200 gate HTML", async () => {
  resetGateRateLimitsForTesting();
  let now = Date.parse("2026-11-22T12:00:00Z");
  setGateClockForTesting(() => now);
  try {
    const { env, stats } = createGateEnv();
    const gateCookie = await authenticateAs(env, TEST_REVIEWER_PASS, "198.51.100.170");

    const authedReviewRes = await worker.fetch(
      new Request("https://aios-demo.hk-demo.workers.dev/review", {
        headers: { cookie: gateCookie },
      }),
      env,
    );
    assert.equal(authedReviewRes.status, 303);
    assert.equal(
      authedReviewRes.headers.get("location"),
      "https://aios-demo.hk-demo.workers.dev/login",
    );
    assert.equal(authedReviewRes.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
    assert.equal(
      authedReviewRes.headers.get("cache-control"),
      "no-store, no-cache, must-revalidate, private",
    );
    assert.equal(authedReviewRes.headers.get("referrer-policy"), "no-referrer");
    assert.equal(stats().originCalls, 0);

    // Tampered cookie -> serves 200 gate page instead of redirecting
    const tamperedRes = await worker.fetch(
      new Request("https://aios-demo.hk-demo.workers.dev/review", {
        headers: { cookie: `${gateCookie.slice(0, -2)}00` },
      }),
      env,
    );
    assert.equal(tamperedRes.status, 200);
    const tamperedHtml = await tamperedRes.text();
    assert.ok(tamperedHtml.includes("THEODIC-DEMO-XXXXX-XXXXX"));

    // Expired cookie (> 8h) -> serves 200 gate page
    now += 28_801 * 1000;
    const expiredReviewRes = await worker.fetch(
      new Request("https://aios-demo.hk-demo.workers.dev/review", {
        headers: { cookie: gateCookie },
      }),
      env,
    );
    assert.equal(expiredReviewRes.status, 200);
    assert.equal(stats().originCalls, 0);
  } finally {
    setGateClockForTesting(null);
  }
});
