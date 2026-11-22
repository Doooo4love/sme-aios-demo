export type GateScope = "judge" | "team";

export interface GateEnv {
  AIOS_GATE_SECRET?: string;
  AIOS_REVIEWER_PASSCODE?: string;
  AIOS_TEAM_PASSCODE?: string;
  AIOS_REVIEWER_EXPIRES_AT?: string;
}

export interface GateSession {
  scope: GateScope;
  expUnix: number;
}

export interface GateCheckResult {
  response?: Response;
  session: GateSession | null;
}

export const DEFAULT_REVIEWER_EXPIRES_AT = "2027-03-31T23:59:59Z";
export const GATE_COOKIE_NAME = "__Host-aios_gate";
export const LOCALE_COOKIE_NAME = "aios_locale";
export const GATE_COOKIE_MAX_AGE_SECONDS = 28_800; // 8 hours
export const LOCALE_COOKIE_MAX_AGE_SECONDS = 2_592_000; // 30 days
export const X_ROBOTS_TAG_VALUE = "noindex, nofollow, noarchive";

const ROBOTS_TXT_BODY = "User-agent: *\nDisallow: /\n";
const AUTH_FAILURE_LIMIT = 5;
const AUTH_FAILURE_WINDOW_MS = 10 * 60 * 1000;
const AUTH_LOCKOUT_RETRY_AFTER_SECONDS = 600;

const LLM_TURN_MIN_LIMIT = 8;
const LLM_TURN_MIN_WINDOW_MS = 60 * 1000;
const LLM_TURN_HOUR_LIMIT = 40;
const LLM_TURN_HOUR_WINDOW_MS = 60 * 60 * 1000;

const MUTATION_MIN_LIMIT = 30;
const MUTATION_MIN_WINDOW_MS = 60 * 1000;
const MAX_MUTATION_CONTENT_LENGTH = 8_388_608;
const MAX_VERIFY_BODY_BYTES = 8_192;
const MAX_TRACKED_IPS = 10_000;

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const textEncoder = new TextEncoder();

// Isolate-local best-effort sliding-window trackers (bounded by MAX_TRACKED_IPS).
const authFailuresByIp = new Map<string, number[]>();
const llmTurnsByIp = new Map<string, number[]>();
const mutationsByIp = new Map<string, number[]>();

let clockProvider: () => number = () => Date.now();

export function setGateClockForTesting(fn: (() => number) | null): void {
  clockProvider = fn ?? (() => Date.now());
}

export function resetGateRateLimitsForTesting(): void {
  authFailuresByIp.clear();
  llmTurnsByIp.clear();
  mutationsByIp.clear();
}

function nowMs(): number {
  return clockProvider();
}

export function isReviewerGateEnabled(env: GateEnv): boolean {
  return typeof env.AIOS_GATE_SECRET === "string" && env.AIOS_GATE_SECRET.trim().length > 0;
}

function resolveExpiresAtMs(env: GateEnv): number {
  const raw =
    typeof env.AIOS_REVIEWER_EXPIRES_AT === "string" && env.AIOS_REVIEWER_EXPIRES_AT.trim().length > 0
      ? env.AIOS_REVIEWER_EXPIRES_AT.trim()
      : DEFAULT_REVIEWER_EXPIRES_AT;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getClientIp(request: Request): string {
  const cfIp = request.headers.get("cf-connecting-ip")?.trim();
  if (cfIp) {
    return cfIp;
  }
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) {
    return realIp;
  }
  return "unknown";
}

function pruneWindow(
  store: Map<string, number[]>,
  key: string,
  windowMs: number,
  currentMs: number,
): number[] {
  const existing = store.get(key);
  if (!existing || existing.length === 0) {
    return [];
  }
  const cutoff = currentMs - windowMs;
  const recent = existing.filter((ts) => ts > cutoff);
  if (recent.length === 0) {
    store.delete(key);
  } else if (recent.length !== existing.length) {
    store.set(key, recent);
  }
  return recent;
}

function pushWindowEvent(
  store: Map<string, number[]>,
  key: string,
  windowMs: number,
  currentMs: number,
): void {
  const recent = pruneWindow(store, key, windowMs, currentMs);
  if (!store.has(key) && store.size >= MAX_TRACKED_IPS) {
    const oldestKey = store.keys().next().value;
    if (oldestKey !== undefined) {
      store.delete(oldestKey);
    }
  }
  recent.push(currentMs);
  store.set(key, recent);
}

function computeRetryAfterSeconds(
  oldestTimestampMs: number | undefined,
  windowMs: number,
  currentMs: number,
): number {
  if (oldestTimestampMs === undefined) {
    return Math.max(1, Math.ceil(windowMs / 1000));
  }
  const remainingMs = oldestTimestampMs + windowMs - currentMs;
  return Math.max(1, Math.ceil(remainingMs / 1000));
}

function constantTimeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) {
    return null;
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function sha256Bytes(value: string): Promise<Uint8Array> {
  const encoded = textEncoder.encode(value);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return new Uint8Array(digest);
}

async function hmacSha256Bytes(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(message));
  return new Uint8Array(signature);
}

/**
 * Signs an HMAC-SHA256 capability token formatted as `<exp_unix>.<scope>.<sig_hex>`.
 */
export async function signCapabilityToken(
  secret: string,
  expUnix: number,
  scope: GateScope,
): Promise<string> {
  const normalizedExp = Math.floor(expUnix);
  const payload = `aios-review-pass-v1:${normalizedExp}.${scope}`;
  const sig = await hmacSha256Bytes(secret, payload);
  return `${normalizedExp}.${scope}.${bytesToHex(sig)}`;
}

async function verifyCapabilityToken(
  token: string,
  secret: string,
  expiresAtMs: number,
  currentMs: number,
): Promise<GateScope | null> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const [expStr, rawScope, sigHex] = parts;
  if (!/^\d{1,12}$/.test(expStr)) {
    return null;
  }
  if (rawScope !== "judge" && rawScope !== "team") {
    return null;
  }
  if (!/^[0-9a-f]{64}$/i.test(sigHex)) {
    return null;
  }
  const sigBytes = hexToBytes(sigHex);
  if (!sigBytes) {
    return null;
  }

  const expectedSig = await hmacSha256Bytes(
    secret,
    `aios-review-pass-v1:${expStr}.${rawScope}`,
  );
  if (!constantTimeEqualBytes(expectedSig, sigBytes)) {
    return null;
  }

  const expUnix = Number(expStr);
  if (!Number.isFinite(expUnix) || currentMs >= expUnix * 1000 || currentMs >= expiresAtMs) {
    return null;
  }
  return rawScope;
}

/**
 * Mints a signed session cookie value for `__Host-aios_gate`.
 */
export async function createGateCookieToken(
  secret: string,
  scope: GateScope,
  currentMs = nowMs(),
): Promise<string> {
  const expUnix = Math.floor(currentMs / 1000) + GATE_COOKIE_MAX_AGE_SECONDS;
  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);
  const nonce = bytesToHex(nonceBytes);
  const payload = `aios-gate-cookie-v1:${expUnix}.${scope}.${nonce}`;
  const sig = await hmacSha256Bytes(secret, payload);
  return `${expUnix}.${scope}.${nonce}.${bytesToHex(sig)}`;
}

export async function verifyGateCookieToken(
  token: string,
  secret: string,
  expiresAtMs: number,
  currentMs = nowMs(),
): Promise<GateSession | null> {
  const parts = token.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const [expStr, rawScope, nonce, sigHex] = parts;
  if (!/^\d{1,12}$/.test(expStr)) {
    return null;
  }
  if (rawScope !== "judge" && rawScope !== "team") {
    return null;
  }
  if (!/^[0-9a-f]{16,64}$/i.test(nonce) || !/^[0-9a-f]{64}$/i.test(sigHex)) {
    return null;
  }
  const sigBytes = hexToBytes(sigHex);
  if (!sigBytes) {
    return null;
  }

  const expectedSig = await hmacSha256Bytes(
    secret,
    `aios-gate-cookie-v1:${expStr}.${rawScope}.${nonce}`,
  );
  if (!constantTimeEqualBytes(expectedSig, sigBytes)) {
    return null;
  }

  const expUnix = Number(expStr);
  if (!Number.isFinite(expUnix) || currentMs >= expUnix * 1000 || currentMs >= expiresAtMs) {
    return null;
  }
  return { scope: rawScope, expUnix };
}

/**
 * Normalizes human-entered passcodes (trims, maps Unicode dashes to ASCII `-`,
 * strips whitespace, and uppercases ASCII letters) while signed capability
 * tokens continue to be verified case-sensitively in `verifyCapabilityToken`.
 */
export function normalizePasscodeInput(raw: string): string {
  return raw
    .trim()
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\s+/g, "")
    .replace(/[a-z]/g, (ch) => ch.toUpperCase());
}

async function verifyPassInput(
  rawInput: string,
  env: GateEnv,
  expiresAtMs: number,
  currentMs: number,
): Promise<GateScope | null> {
  if (currentMs >= expiresAtMs) {
    return null;
  }
  const candidate = rawInput.trim();
  if (!candidate) {
    return null;
  }

  const gateSecret = (env.AIOS_GATE_SECRET ?? "").trim();
  if (!gateSecret) {
    return null;
  }

  const normalizedCandidate = normalizePasscodeInput(candidate);
  const reviewerPass = normalizePasscodeInput(env.AIOS_REVIEWER_PASSCODE ?? "");
  const teamPass = normalizePasscodeInput(env.AIOS_TEAM_PASSCODE ?? "");

  if (normalizedCandidate) {
    const candidateDigest = await sha256Bytes(normalizedCandidate);
    const [reviewerDigest, teamDigest] = await Promise.all([
      reviewerPass ? sha256Bytes(reviewerPass) : Promise.resolve(null),
      teamPass ? sha256Bytes(teamPass) : Promise.resolve(null),
    ]);

    const matchesReviewer =
      reviewerDigest !== null && constantTimeEqualBytes(candidateDigest, reviewerDigest);
    const matchesTeam =
      teamDigest !== null && constantTimeEqualBytes(candidateDigest, teamDigest);

    if (matchesReviewer) {
      return "judge";
    }
    if (matchesTeam) {
      return "team";
    }
  }

  return verifyCapabilityToken(candidate, gateSecret, expiresAtMs, currentMs);
}

function extractGateCookies(cookieHeader: string | null): string[] {
  if (!cookieHeader) {
    return [];
  }
  const matches: string[] = [];
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) {
      continue;
    }
    const name = trimmed.slice(0, eqIdx).trim();
    if (name === GATE_COOKIE_NAME) {
      matches.push(trimmed.slice(eqIdx + 1).trim());
    }
  }
  return matches;
}

/**
 * Removes `__Host-aios_gate` from an upstream-bound `Cookie` header while preserving all app cookies.
 */
export function stripGateCookieHeader(cookieHeader: string | null): string | null {
  if (!cookieHeader) {
    return null;
  }
  const kept: string[] = [];
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    const eqIdx = trimmed.indexOf("=");
    const name = (eqIdx === -1 ? trimmed : trimmed.slice(0, eqIdx)).trim();
    if (name === GATE_COOKIE_NAME) {
      continue;
    }
    kept.push(trimmed);
  }
  return kept.length > 0 ? kept.join("; ") : null;
}

function applyGateResponseSecurityHeaders(headers: Headers): void {
  headers.delete("x-powered-by");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-frame-options", "DENY");
  headers.set("x-robots-tag", X_ROBOTS_TAG_VALUE);
  headers.set("cache-control", "no-store, no-cache, must-revalidate, private");
  headers.set("pragma", "no-cache");
  headers.set("cdn-cache-control", "no-store");
}

function gateJsonResponse(
  status: number,
  payload: unknown,
  extraHeaders?: Record<string, string>,
  setCookies: string[] = [],
): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
  });
  applyGateResponseSecurityHeaders(headers);
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      headers.set(k, v);
    }
  }
  for (const cookie of setCookies) {
    headers.append("set-cookie", cookie);
  }
  return new Response(JSON.stringify(payload), { status, headers });
}

function gateJsonError(
  status: number,
  code: string,
  message: string,
  extraHeaders?: Record<string, string>,
): Response {
  return gateJsonResponse(status, { detail: { code, message } }, extraHeaders);
}

function appendAuthCookies(headers: Headers, cookieToken: string): void {
  headers.append(
    "set-cookie",
    `${GATE_COOKIE_NAME}=${cookieToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${GATE_COOKIE_MAX_AGE_SECONDS}`,
  );
  headers.append(
    "set-cookie",
    `${LOCALE_COOKIE_NAME}=en; Path=/; Secure; SameSite=Lax; Max-Age=${LOCALE_COOKIE_MAX_AGE_SECONDS}`,
  );
}

function buildClearGateCookieHeader(): string {
  return `${GATE_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderReviewerGateHtml(options: {
  statusMessage?: string;
  isError?: boolean;
}): Response | string {
  // Returns the HTML string directly; callers wrap with headers/status.
  const initialBanner = options.statusMessage
    ? `<div id="gate-alert" class="alert ${options.isError ? "alert-error" : "alert-info"}" role="alert">${escapeHtml(options.statusMessage)}</div>`
    : `<div id="gate-alert" class="alert" role="status" hidden></div>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow, noarchive" />
  <meta name="referrer" content="no-referrer" />
  <title>Theodic · Live MVP Reviewer Gate</title>
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23171717'/%3E%3Cpath d='M6.5 22.5 13.8 11.4c1.2-1.8 3.2-1.8 4.4 0l2.8 4.2' fill='none' stroke='%23FAF6F0' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3Cpath d='M16.2 14.5 18.8 11.4c1.2-1.5 3.1-1.4 4.3.2l4.4 10.9' fill='none' stroke='%23A8A29A' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E" />
  <style>
    :root {
      color-scheme: light;
      --bg-app: #FAF8F5;
      --bg-surface: #FFFFFF;
      --bg-subtle: #F2EDE6;
      --bg-subtle-hover: #ECE6DC;
      --ink-primary: #171717;
      --ink-secondary: #4A4640;
      --ink-muted: #6E6860;
      --accent: #1B4F9C;
      --accent-ring: rgba(27, 79, 156, 0.22);
      --cta-bg: #171717;
      --cta-hover: #2A2825;
      --cta-fg: #FAF8F5;
      --crimson: #C02936;
      --crimson-wash: rgba(192, 41, 54, 0.08);
      --crimson-border: rgba(192, 41, 54, 0.22);
      --emerald: #127A46;
      --emerald-wash: rgba(18, 122, 70, 0.08);
      --hairline: #DCD5CB;
      --hairline-strong: #CFC8BE;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100dvh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background-color: var(--bg-app);
      background-image: radial-gradient(ellipse 75% 65% at 72% 24%, rgba(23, 23, 23, 0.03), transparent 72%);
      color: var(--ink-primary);
      font-family: "SF Pro Text", "SF Pro Display", -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    .shell {
      width: 100%;
      max-width: 448px;
    }
    .card {
      background: var(--bg-surface);
      border: 1px solid var(--hairline);
      border-radius: 18px;
      padding: 32px;
      box-shadow:
        0 1px 2px rgba(23, 23, 23, 0.04),
        0 12px 32px -8px rgba(23, 23, 23, 0.07);
    }
    .badge-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 20px;
    }
    .brand {
      display: inline-flex;
      align-items: center;
      gap: 9px;
      font-family: "Plus Jakarta Sans", "Avenir Next", "SF Pro Display", -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      font-weight: 650;
      font-size: 16.5px;
      color: var(--ink-primary);
      letter-spacing: -0.025em;
    }
    .brand-mark {
      width: 40px;
      height: 21px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 9999px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.02em;
      color: var(--ink-primary);
      background: var(--bg-subtle);
      border: 1px solid var(--hairline);
      white-space: nowrap;
    }
    .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--accent);
    }
    h1 {
      margin: 0 0 6px;
      font-size: 21px;
      line-height: 1.3;
      font-weight: 650;
      letter-spacing: -0.02em;
      color: var(--ink-primary);
    }
    .tagline {
      margin: 0 0 10px;
      font-size: 12.5px;
      font-weight: 500;
      color: var(--ink-muted);
      letter-spacing: -0.005em;
    }
    .subtitle {
      margin: 0 0 22px;
      font-size: 13.5px;
      line-height: 1.55;
      color: var(--ink-secondary);
    }
    .alert {
      margin-bottom: 16px;
      padding: 11px 13px;
      border-radius: 10px;
      font-size: 13px;
      line-height: 1.45;
      border: 1px solid var(--hairline);
      background: var(--bg-subtle);
      color: var(--ink-primary);
    }
    .alert-error {
      background: var(--crimson-wash);
      border-color: var(--crimson-border);
      color: var(--crimson);
    }
    .alert-info {
      background: var(--bg-subtle);
      border-color: var(--hairline);
      color: var(--ink-primary);
    }
    .alert-success {
      background: var(--emerald-wash);
      border-color: rgba(18, 122, 70, 0.22);
      color: var(--emerald);
    }
    label {
      display: block;
      font-size: 12.5px;
      font-weight: 600;
      color: var(--ink-primary);
      margin-bottom: 7px;
    }
    .input-wrap {
      position: relative;
      display: flex;
      align-items: center;
    }
    input[type="password"],
    input[type="text"] {
      width: 100%;
      height: 44px;
      padding: 0 68px 0 13px;
      border-radius: 10px;
      border: 1px solid var(--hairline-strong);
      background: var(--bg-surface);
      color: var(--ink-primary);
      font-size: 14px;
      font-family: "SF Mono", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      letter-spacing: 0.02em;
      transition: border-color 140ms ease, box-shadow 140ms ease;
    }
    input:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-ring);
    }
    .toggle-btn {
      position: absolute;
      right: 6px;
      height: 32px;
      padding: 0 10px;
      border: 1px solid var(--hairline);
      border-radius: 7px;
      background: var(--bg-subtle);
      color: var(--ink-secondary);
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
    }
    .toggle-btn:hover {
      background: var(--bg-subtle-hover);
      color: var(--ink-primary);
    }
    .submit-btn {
      margin-top: 14px;
      width: 100%;
      height: 44px;
      border: 0;
      border-radius: 10px;
      background: var(--cta-bg);
      color: var(--cta-fg);
      font-size: 14px;
      font-weight: 600;
      letter-spacing: -0.01em;
      cursor: pointer;
      transition: background-color 140ms ease, transform 120ms ease;
    }
    .submit-btn:hover:not(:disabled) {
      background: var(--cta-hover);
    }
    .submit-btn:active:not(:disabled) {
      transform: translateY(0.5px);
    }
    .submit-btn:disabled {
      opacity: 0.65;
      cursor: wait;
    }
    .noscript-note {
      margin: 12px 0 0;
      padding: 10px 12px;
      border-radius: 8px;
      border: 1px solid var(--hairline);
      background: var(--bg-subtle);
      color: var(--ink-secondary);
      font-size: 12px;
      line-height: 1.45;
    }
    .meta-grid {
      margin-top: 20px;
      padding-top: 16px;
      border-top: 1px solid var(--hairline);
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      font-size: 12px;
      color: var(--ink-muted);
    }
    .meta-item strong {
      display: block;
      font-weight: 600;
      color: var(--ink-primary);
      margin-bottom: 2px;
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="card" aria-labelledby="gate-title">
      <div class="badge-row">
        <div class="brand">
          <div class="brand-mark" aria-hidden="true">
            <svg width="40" height="21" viewBox="0 0 44 23" fill="none" xmlns="http://www.w3.org/2000/svg">
              <defs>
                <linearGradient id="theodic-arch-fold" x1="17" y1="6" x2="33" y2="21" gradientUnits="userSpaceOnUse">
                  <stop offset="0%" stop-color="#ECE8E1" />
                  <stop offset="38%" stop-color="#9E9991" />
                  <stop offset="100%" stop-color="#171717" />
                </linearGradient>
              </defs>
              <path d="M18.2 9.4C20.9 6.0 24.1 4.4 27.3 4.4C29.6 4.4 31.7 5.6 33.7 8.3L42.8 20.6C43.1 21.0 42.8 21.5 42.3 21.5H33.5C32.8 21.5 32.1 21.1 31.6 20.4L24.5 11.4C23.0 9.6 20.8 9.4 18.6 11.0L18.2 9.4Z" fill="url(#theodic-arch-fold)" />
              <path d="M1.2 21.5C0.7 21.5 0.4 20.9 0.7 20.5L12.1 6.0C14.7 2.7 18.0 1.2 21.8 1.2C25.3 1.2 28.1 2.7 30.8 6.1C27.8 4.6 24.4 5.4 21.3 8.5L11.4 20.4C10.9 21.1 10.2 21.5 9.4 21.5H1.2Z" fill="#171717" />
            </svg>
          </div>
          <span>Theodic</span>
        </div>
        <span class="pill"><span class="dot" aria-hidden="true"></span>Reviewer Sandbox</span>
      </div>

      <h1 id="gate-title">Theodic · Live MVP Reviewer Gate</h1>
      <p class="tagline">Connecting intelligence with the way industries work.</p>
      <p class="subtitle">
        Edge-verified reviewer gateway for the live SME AIOS sandbox. Unlocking sets the interface to English and protects administrative circuit breakers.
      </p>

      ${initialBanner}

      <form id="gate-form" method="POST" action="/__gate/verify" novalidate>
        <label for="passcode-input">Reviewer Passcode</label>
        <div class="input-wrap">
          <input
            id="passcode-input"
            name="passcode"
            type="password"
            autocomplete="one-time-code"
            spellcheck="false"
            autocapitalize="characters"
            placeholder="THEODIC-DEMO-XXXXX-XXXXX"
            required
          />
          <button type="button" id="toggle-visibility" class="toggle-btn" aria-label="Show passcode">Show</button>
        </div>
        <button type="submit" id="submit-btn" class="submit-btn">Unlock Live MVP</button>
      </form>

      <noscript>
        <p class="noscript-note">
          JavaScript is disabled. Enter your reviewer passcode above and select <strong>Unlock Live MVP</strong> to submit directly.
        </p>
      </noscript>

      <div class="meta-grid">
        <div class="meta-item">
          <strong>Session</strong>
          8-hour HttpOnly edge pass
        </div>
        <div class="meta-item">
          <strong>Language</strong>
          Auto-preset to English (EN)
        </div>
      </div>
    </section>
  </main>

  <script>
    (function () {
      var form = document.getElementById("gate-form");
      var input = document.getElementById("passcode-input");
      var submitBtn = document.getElementById("submit-btn");
      var toggleBtn = document.getElementById("toggle-visibility");
      var alertBox = document.getElementById("gate-alert");
      var verifying = false;

      function showAlert(message, kind) {
        alertBox.textContent = message;
        alertBox.className = "alert " + (kind === "error" ? "alert-error" : kind === "success" ? "alert-success" : "alert-info");
        alertBox.hidden = false;
      }

      window.addEventListener("pageshow", function () {
        verifying = false;
        if (submitBtn) {
          submitBtn.disabled = false;
        }
      });

      if (toggleBtn && input) {
        toggleBtn.addEventListener("click", function () {
          var isPassword = input.type === "password";
          input.type = isPassword ? "text" : "password";
          toggleBtn.textContent = isPassword ? "Hide" : "Show";
          toggleBtn.setAttribute("aria-label", isPassword ? "Hide passcode" : "Show passcode");
        });
      }

      async function verifyPasscode(passcode) {
        if (verifying) {
          return;
        }
        verifying = true;
        submitBtn.disabled = true;
        showAlert("Verifying reviewer pass...", "info");
        try {
          var response = await fetch("/__gate/verify", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Accept": "application/json"
            },
            credentials: "same-origin",
            body: JSON.stringify({ passcode: passcode })
          });
          var data = null;
          try {
            data = await response.json();
          } catch (_) {
            data = null;
          }
          if (response.ok && data && data.ok) {
            showAlert("Access verified. Redirecting to Theodic login...", "success");
            window.location.replace(data.redirect || "/login");
            return;
          }
          var msg =
            (data && data.detail && data.detail.message) ||
            (response.status === 429
              ? "Too many verification attempts. Please wait 10 minutes before retrying."
              : "Invalid or expired reviewer passcode.");
          showAlert(msg, "error");
          verifying = false;
          submitBtn.disabled = false;
        } catch (_) {
          showAlert("Network error while verifying passcode. Please retry.", "error");
          verifying = false;
          submitBtn.disabled = false;
        }
      }

      if (form) {
        form.addEventListener("submit", function (event) {
          event.preventDefault();
          if (verifying) {
            return;
          }
          var val = (input.value || "").trim();
          if (!val) {
            showAlert("Please enter your Theodic reviewer passcode.", "error");
            input.focus();
            return;
          }
          verifyPasscode(val);
        });
      }

      var rawFragment = window.location.hash.slice(1);
      if (window.location.hash || window.location.search.indexOf("pass=") !== -1) {
        try {
          history.replaceState(null, "", "/review");
        } catch (_) {}
      }
      if (rawFragment) {
        var decoded = rawFragment;
        try {
          decoded = decodeURIComponent(rawFragment);
        } catch (_) {}
        decoded = decoded.trim();
        if (decoded) {
          input.value = decoded;
          verifyPasscode(decoded);
        }
      }
    })();
  </script>
</body>
</html>`;
}

function gateHtmlResponse(
  status: number,
  options: { statusMessage?: string; isError?: boolean } = {},
  method = "GET",
): Response {
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
  });
  applyGateResponseSecurityHeaders(headers);
  const html = renderReviewerGateHtml(options) as string;
  return new Response(method === "HEAD" ? null : html, { status, headers });
}

function isAuthRateLimited(ip: string, currentMs: number): boolean {
  const recent = pruneWindow(authFailuresByIp, ip, AUTH_FAILURE_WINDOW_MS, currentMs);
  return recent.length >= AUTH_FAILURE_LIMIT;
}

function recordAuthFailure(ip: string, currentMs: number): void {
  pushWindowEvent(authFailuresByIp, ip, AUTH_FAILURE_WINDOW_MS, currentMs);
}

function clearAuthFailures(ip: string): void {
  authFailuresByIp.delete(ip);
}

function normalizePathname(pathname: string): string {
  const collapsed = pathname.replace(/\/+/g, "/");
  if (collapsed.length > 1 && collapsed.endsWith("/")) {
    return collapsed.slice(0, -1);
  }
  return collapsed;
}

/**
 * Blocks destructive administrative mutations for judge-scoped reviewer sessions
 * while permitting all core workflow demonstrations.
 */
export function isDestructiveJudgeMutation(method: string, pathname: string): boolean {
  if (!MUTATING_METHODS.has(method.toUpperCase())) {
    return false;
  }
  const candidates = new Set<string>();
  const rawLower = normalizePathname(pathname).toLowerCase();
  candidates.add(rawLower);
  try {
    candidates.add(normalizePathname(decodeURIComponent(pathname)).toLowerCase());
  } catch {
    // Keep raw normalized path when percent-decoding fails.
  }

  for (const p of candidates) {
    if (
      p === "/v1/admin" ||
      p.startsWith("/v1/admin/") ||
      p.includes("/pause") ||
      p.includes("/suspend") ||
      p === "/v1/operations/write-control" ||
      /^\/v1\/operations\/subjects\/[^/]+\/suspension$/.test(p)
    ) {
      return true;
    }
  }
  return false;
}

function prefersHtml(request: Request): boolean {
  const accept = (request.headers.get("accept") ?? "").toLowerCase();
  return accept.includes("text/html");
}

function handleRobotsTxt(method: string): Response {
  if (method !== "GET" && method !== "HEAD") {
    return gateJsonError(405, "METHOD_NOT_ALLOWED", "Method not allowed.", {
      Allow: "GET, HEAD",
    });
  }
  const headers = new Headers({
    "content-type": "text/plain; charset=utf-8",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "x-robots-tag": X_ROBOTS_TAG_VALUE,
    "cache-control": "public, max-age=300",
  });
  return new Response(method === "HEAD" ? null : ROBOTS_TXT_BODY, {
    status: 200,
    headers,
  });
}

async function handleReviewGet(
  request: Request,
  publicUrl: URL,
  env: GateEnv,
  expiresAtMs: number,
  currentMs: number,
): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return gateJsonError(405, "METHOD_NOT_ALLOWED", "Method not allowed.", {
      Allow: "GET, HEAD",
    });
  }

  if (publicUrl.searchParams.has("pass")) {
    const clientIp = getClientIp(request);
    if (isAuthRateLimited(clientIp, currentMs)) {
      const res = gateHtmlResponse(
        429,
        {
          statusMessage:
            "Too many verification attempts from this IP. Please retry in 10 minutes.",
          isError: true,
        },
        method,
      );
      res.headers.set("retry-after", String(AUTH_LOCKOUT_RETRY_AFTER_SECONDS));
      return res;
    }

    const passVal = publicUrl.searchParams.get("pass") ?? "";
    const scope = await verifyPassInput(passVal, env, expiresAtMs, currentMs);
    if (!scope) {
      recordAuthFailure(clientIp, currentMs);
      return gateHtmlResponse(
        401,
        {
          statusMessage: "Invalid or expired reviewer link. Please enter your passcode below.",
          isError: true,
        },
        method,
      );
    }

    clearAuthFailures(clientIp);
    const gateSecret = (env.AIOS_GATE_SECRET ?? "").trim();
    const cookieToken = await createGateCookieToken(gateSecret, scope, currentMs);

    const headers = new Headers({
      location: `https://${publicUrl.host}/login`,
    });
    applyGateResponseSecurityHeaders(headers);
    appendAuthCookies(headers, cookieToken);
    return new Response(null, { status: 303, headers });
  }

  const gateSecret = (env.AIOS_GATE_SECRET ?? "").trim();
  const cookieTokens = extractGateCookies(request.headers.get("cookie"));
  const existingSession =
    cookieTokens.length === 1
      ? await verifyGateCookieToken(cookieTokens[0], gateSecret, expiresAtMs, currentMs)
      : null;
  if (existingSession) {
    const headers = new Headers({
      location: `https://${publicUrl.host}/login`,
    });
    applyGateResponseSecurityHeaders(headers);
    return new Response(null, { status: 303, headers });
  }

  return gateHtmlResponse(200, {}, method);
}

async function readBoundedText(request: Request, maxBytes: number): Promise<string | null> {
  const raw = await request.text();
  if (textEncoder.encode(raw).byteLength > maxBytes) {
    return null;
  }
  return raw;
}

async function handleGateVerifyPost(
  request: Request,
  publicUrl: URL,
  env: GateEnv,
  expiresAtMs: number,
  currentMs: number,
): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") {
    return gateJsonError(405, "METHOD_NOT_ALLOWED", "Method not allowed.", {
      Allow: "POST",
    });
  }

  const clientIp = getClientIp(request);
  if (isAuthRateLimited(clientIp, currentMs)) {
    return gateJsonError(
      429,
      "GATE_RATE_LIMITED",
      "Too many invalid passcode attempts. Please try again in 10 minutes.",
      { "Retry-After": String(AUTH_LOCKOUT_RETRY_AFTER_SECONDS) },
    );
  }

  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const parsedLength = Number(contentLengthHeader.trim());
    if (Number.isFinite(parsedLength) && parsedLength > MAX_VERIFY_BODY_BYTES) {
      return gateJsonError(413, "PAYLOAD_TOO_LARGE", "Verification payload is too large.");
    }
  }

  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  const isFormPost = contentType.includes("application/x-www-form-urlencoded");
  const rawBody = await readBoundedText(request, MAX_VERIFY_BODY_BYTES);
  if (rawBody === null) {
    return gateJsonError(413, "PAYLOAD_TOO_LARGE", "Verification payload is too large.");
  }

  let passcode = "";
  if (isFormPost) {
    passcode = new URLSearchParams(rawBody).get("passcode") ?? "";
  } else {
    try {
      const parsed = JSON.parse(rawBody) as { passcode?: unknown };
      if (parsed && typeof parsed === "object" && typeof parsed.passcode === "string") {
        passcode = parsed.passcode;
      }
    } catch {
      recordAuthFailure(clientIp, currentMs);
      return gateJsonError(400, "INVALID_REQUEST", "Invalid JSON verification payload.");
    }
  }

  const scope = await verifyPassInput(passcode, env, expiresAtMs, currentMs);
  if (!scope) {
    recordAuthFailure(clientIp, currentMs);
    if (isFormPost && prefersHtml(request)) {
      return gateHtmlResponse(401, {
        statusMessage: "Invalid or expired reviewer passcode.",
        isError: true,
      });
    }
    return gateJsonError(
      401,
      "INVALID_REVIEWER_PASSCODE",
      "Invalid or expired reviewer passcode.",
    );
  }

  clearAuthFailures(clientIp);
  const gateSecret = (env.AIOS_GATE_SECRET ?? "").trim();
  const cookieToken = await createGateCookieToken(gateSecret, scope, currentMs);

  if (isFormPost) {
    const headers = new Headers({
      location: `https://${publicUrl.host}/login`,
    });
    applyGateResponseSecurityHeaders(headers);
    appendAuthCookies(headers, cookieToken);
    return new Response(null, { status: 303, headers });
  }

  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
  });
  applyGateResponseSecurityHeaders(headers);
  appendAuthCookies(headers, cookieToken);
  return new Response(
    JSON.stringify({ ok: true, redirect: "/login", scope }),
    { status: 200, headers },
  );
}

function handleGateLogout(
  request: Request,
  publicUrl: URL,
  mode: "api" | "browser",
): Response {
  const method = request.method.toUpperCase();
  if (mode === "api") {
    if (method !== "POST") {
      return gateJsonError(405, "METHOD_NOT_ALLOWED", "Method not allowed.", {
        Allow: "POST",
      });
    }
    return gateJsonResponse(
      200,
      { ok: true, redirect: "/review" },
      undefined,
      [buildClearGateCookieHeader()],
    );
  }

  if (method !== "GET" && method !== "HEAD") {
    return gateJsonError(405, "METHOD_NOT_ALLOWED", "Method not allowed.", {
      Allow: "GET, HEAD",
    });
  }
  const headers = new Headers({
    location: `https://${publicUrl.host}/review`,
  });
  applyGateResponseSecurityHeaders(headers);
  headers.append("set-cookie", buildClearGateCookieHeader());
  return new Response(null, { status: 303, headers });
}

function checkAuthenticatedLimits(
  request: Request,
  publicUrl: URL,
  session: GateSession,
  currentMs: number,
): Response | null {
  const method = request.method.toUpperCase();
  if (!MUTATING_METHODS.has(method)) {
    return null;
  }

  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const parsedLength = Number(contentLengthHeader.trim());
    if (Number.isFinite(parsedLength) && parsedLength > MAX_MUTATION_CONTENT_LENGTH) {
      return gateJsonError(
        413,
        "PAYLOAD_TOO_LARGE",
        "Request payload exceeds 8 MiB reviewer limit.",
      );
    }
  }

  if (session.scope === "judge" && isDestructiveJudgeMutation(method, publicUrl.pathname)) {
    return gateJsonError(
      403,
      "JUDGE_SANDBOX_PROTECTED",
      "Destructive administrative mutations are disabled for reviewer passes.",
    );
  }

  const clientIp = getClientIp(request);
  const normalizedPath = normalizePathname(publicUrl.pathname).toLowerCase();
  const isTurnRequest = method === "POST" && normalizedPath === "/v1/workbench/turns";

  if (isTurnRequest) {
    const recentTurnsHour = pruneWindow(
      llmTurnsByIp,
      clientIp,
      LLM_TURN_HOUR_WINDOW_MS,
      currentMs,
    );
    const minCutoff = currentMs - LLM_TURN_MIN_WINDOW_MS;
    const recentTurnsMin = recentTurnsHour.filter((ts) => ts > minCutoff);

    if (recentTurnsMin.length >= LLM_TURN_MIN_LIMIT) {
      const retryAfter = computeRetryAfterSeconds(
        recentTurnsMin[0],
        LLM_TURN_MIN_WINDOW_MS,
        currentMs,
      );
      return gateJsonError(
        429,
        "REVIEWER_LLM_RATE_LIMITED",
        "Reviewer AI turn rate limit (8/min) reached. Please wait briefly before retrying.",
        { "Retry-After": String(retryAfter) },
      );
    }

    if (recentTurnsHour.length >= LLM_TURN_HOUR_LIMIT) {
      const retryAfter = computeRetryAfterSeconds(
        recentTurnsHour[0],
        LLM_TURN_HOUR_WINDOW_MS,
        currentMs,
      );
      return gateJsonError(
        429,
        "REVIEWER_LLM_RATE_LIMITED",
        "Reviewer hourly AI turn limit (40/hr) reached.",
        { "Retry-After": String(retryAfter) },
      );
    }
  }

  const recentMutations = pruneWindow(
    mutationsByIp,
    clientIp,
    MUTATION_MIN_WINDOW_MS,
    currentMs,
  );
  if (recentMutations.length >= MUTATION_MIN_LIMIT) {
    const retryAfter = computeRetryAfterSeconds(
      recentMutations[0],
      MUTATION_MIN_WINDOW_MS,
      currentMs,
    );
    return gateJsonError(
      429,
      "REVIEWER_MUTATION_RATE_LIMITED",
      "Reviewer write rate limit (30/min) reached. Please slow down.",
      { "Retry-After": String(retryAfter) },
    );
  }

  if (isTurnRequest) {
    pushWindowEvent(llmTurnsByIp, clientIp, LLM_TURN_HOUR_WINDOW_MS, currentMs);
  }
  pushWindowEvent(mutationsByIp, clientIp, MUTATION_MIN_WINDOW_MS, currentMs);
  return null;
}

/**
 * Enforces the Edge Reviewer Gate before any request reaches `AIOS_ORIGIN`.
 */
export async function enforceReviewerGateBeforeOrigin(
  request: Request,
  publicUrl: URL,
  env: GateEnv,
): Promise<GateCheckResult> {
  const currentMs = nowMs();
  const expiresAtMs = resolveExpiresAtMs(env);
  const method = request.method.toUpperCase();
  const path = normalizePathname(publicUrl.pathname);

  if (path === "/robots.txt") {
    return { response: handleRobotsTxt(method), session: null };
  }

  if (path === "/review") {
    return {
      response: await handleReviewGet(request, publicUrl, env, expiresAtMs, currentMs),
      session: null,
    };
  }

  if (path === "/__gate/verify") {
    return {
      response: await handleGateVerifyPost(request, publicUrl, env, expiresAtMs, currentMs),
      session: null,
    };
  }

  if (path === "/__gate/logout") {
    return { response: handleGateLogout(request, publicUrl, "api"), session: null };
  }

  if (path === "/review/logout") {
    return { response: handleGateLogout(request, publicUrl, "browser"), session: null };
  }

  const gateSecret = (env.AIOS_GATE_SECRET ?? "").trim();
  const cookieTokens = extractGateCookies(request.headers.get("cookie"));
  const session =
    cookieTokens.length === 1
      ? await verifyGateCookieToken(cookieTokens[0], gateSecret, expiresAtMs, currentMs)
      : null;

  if (!session) {
    if ((method === "GET" || method === "HEAD") && prefersHtml(request)) {
      return {
        response: gateHtmlResponse(
          401,
          {
            statusMessage:
              "Live MVP reviewer pass required. Enter your passcode or open your reviewer link to continue.",
            isError: false,
          },
          method,
        ),
        session: null,
      };
    }
    return {
      response: gateJsonError(
        401,
        "REVIEWER_PASS_REQUIRED",
        "Live MVP reviewer pass is required. Open /review to unlock access.",
      ),
      session: null,
    };
  }

  const limitResponse = checkAuthenticatedLimits(request, publicUrl, session, currentMs);
  if (limitResponse) {
    return { response: limitResponse, session };
  }

  return { session };
}
