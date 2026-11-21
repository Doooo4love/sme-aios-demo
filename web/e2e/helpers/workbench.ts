import fs from "node:fs";
import path from "node:path";
import { expect, type Page, type Response } from "@playwright/test";

export const SCREENSHOT_DIR = path.resolve(__dirname, "../screenshots");

export const FORBIDDEN_JSON_KEYS: ReadonlySet<string> = new Set([
  "planner",
  "reasoning",
  "chain_of_thought",
  "thought",
  "raw_tokens",
  "prompt",
  "system_prompt",
  "tool_args",
  "internal_args",
  "model_name",
  "llm_model",
  "provider",
  "usage",
  "token_usage",
  "api_key",
  "secret",
  "traceback",
  "stack",
]);

export const FORBIDDEN_TEXT_PATTERNS: readonly RegExp[] = [
  /chain_of_thought/i,
  /system_prompt/i,
  /AIOS_DEMO_SECRET/,
  /AIOS_BROWSER_SESSION_KEY/,
  /AIOS_LLM_API_KEY/,
  /NEXT_PUBLIC_[A-Z0-9_]*(?:SECRET|KEY|TOKEN)/,
  /"planner"\s*:\s*"(?:local_rules|configured)"/,
];

export type DemoPersona =
  | "operator"
  | "manager"
  | "finance"
  | "access-admin"
  | "admin"
  | "other-manager"
  | "island-manager"
  | "viewer"
  | "quality"
  | "legal"
  | "executive";

export function uniqueSuffix(): string {
  const ts = Date.now().toString(36).toUpperCase().slice(-5);
  const rand = Math.random().toString(36).toUpperCase().slice(2, 6);
  return `${ts}${rand}`;
}

export async function saveEvidenceScreenshot(
  page: Page,
  filename: string,
): Promise<string> {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const normalized = filename.endsWith(".png") ? filename : `${filename}.png`;
  const targetPath = path.join(SCREENSHOT_DIR, normalized);
  await page.screenshot({ path: targetPath, fullPage: false });
  return targetPath;
}

export interface RuntimeAuditHandle {
  consoleErrors: string[];
  pageErrors: string[];
  apiViolations: string[];
  v1Responses: Array<{
    url: string;
    status: number;
    cacheControl: string | null;
    bodyText: string;
  }>;
  clearExpectedLoginProbeNoise: () => void;
  dispose: () => void;
}

export function findForbiddenKeysInValue(
  value: unknown,
  currentPath = "$",
): string[] {
  const hits: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((item, idx) => {
      hits.push(...findForbiddenKeysInValue(item, `${currentPath}[${idx}]`));
    });
    return hits;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_JSON_KEYS.has(key.toLowerCase())) {
        hits.push(`${currentPath}.${key}`);
      }
      hits.push(...findForbiddenKeysInValue(entry, `${currentPath}.${key}`));
    }
  }
  return hits;
}

export function attachRuntimeAudit(page: Page): RuntimeAuditHandle {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const apiViolations: string[] = [];
  const v1Responses: RuntimeAuditHandle["v1Responses"] = [];

  const onConsole = (msg: { type: () => string; text: () => string }) => {
    if (msg.type() === "error") {
      consoleErrors.push(msg.text());
    }
  };

  const onPageError = (err: Error) => {
    pageErrors.push(err.message || String(err));
  };

  const onResponse = async (res: Response) => {
    const url = res.url();
    let pathname = "";
    try {
      pathname = new URL(url).pathname;
    } catch {
      return;
    }
    if (!pathname.startsWith("/v1/") && !pathname.startsWith("/api/")) {
      return;
    }

    const cacheControl = res.headers()["cache-control"] ?? null;
    if (
      pathname.startsWith("/v1/") &&
      (!cacheControl || !cacheControl.toLowerCase().includes("no-store"))
    ) {
      apiViolations.push(`Missing Cache-Control: no-store on ${pathname}`);
    }

    const contentType = (res.headers()["content-type"] ?? "").toLowerCase();
    if (!contentType.includes("application/json")) {
      return;
    }

    let bodyText = "";
    try {
      bodyText = await res.text();
    } catch {
      return;
    }

    v1Responses.push({
      url: pathname,
      status: res.status(),
      cacheControl,
      bodyText,
    });

    try {
      const parsed: unknown = JSON.parse(bodyText);
      const forbiddenKeys = findForbiddenKeysInValue(parsed);
      if (forbiddenKeys.length > 0) {
        apiViolations.push(
          `Forbidden keys on ${pathname}: ${forbiddenKeys.join(", ")}`,
        );
      }
      if (
        pathname === "/v1/workbench/capabilities" &&
        typeof parsed === "object" &&
        parsed !== null &&
        "planner" in (parsed as Record<string, unknown>)
      ) {
        apiViolations.push("capabilities.planner leaked to browser!");
      }
    } catch {
      // Ignore non-JSON bodies
    }

    for (const pattern of FORBIDDEN_TEXT_PATTERNS) {
      if (pattern.test(bodyText)) {
        apiViolations.push(`Forbidden pattern ${pattern} matched on ${pathname}`);
      }
    }
  };

  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  page.on("response", onResponse);

  return {
    consoleErrors,
    pageErrors,
    apiViolations,
    v1Responses,
    clearExpectedLoginProbeNoise() {
      // Chromium logs a generic console.error when unauthenticated /login probes GET /v1/me -> 401.
      // Remove ONLY that expected pre-login 401 line so any JS error or post-login 401 still fails strictly.
      for (let i = consoleErrors.length - 1; i >= 0; i -= 1) {
        if (
          consoleErrors[i] ===
          "Failed to load resource: the server responded with a status of 401 (Unauthorized)"
        ) {
          consoleErrors.splice(i, 1);
        }
      }
    },
    dispose() {
      page.off("console", onConsole);
      page.off("pageerror", onPageError);
      page.off("response", onResponse);
    },
  };
}

export async function assertNoBrowserStorageLeaks(page: Page): Promise<void> {
  const storageSnapshot = await page.evaluate(() => {
    const ls: Record<string, string> = {};
    const ss: Record<string, string> = {};
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key) ls[key] = window.localStorage.getItem(key) ?? "";
    }
    for (let i = 0; i < window.sessionStorage.length; i += 1) {
      const key = window.sessionStorage.key(i);
      if (key) ss[key] = window.sessionStorage.getItem(key) ?? "";
    }
    return { ls, ss };
  });

  const combined = JSON.stringify(storageSnapshot);
  const sensitiveTokens = [
    "csrf_token",
    "INV-100",
    "SHP-1001",
    "PO-100",
    "SYNTHETIC-BANK-ONLY",
    "AIOS_DEMO_SECRET",
    "digest",
    "proposal",
    "FE-DEMO",
  ];

  for (const token of sensitiveTokens) {
    expect(
      combined,
      `Browser storage leaked sensitive token "${token}"`,
    ).not.toContain(token);
  }
}

export async function assertDomZeroLeaks(page: Page): Promise<void> {
  const bodyText = await page.locator("body").innerText();
  for (const pattern of FORBIDDEN_TEXT_PATTERNS) {
    expect(
      bodyText,
      `DOM text matched forbidden pattern ${pattern}`,
    ).not.toMatch(pattern);
  }
  const secretEnv = process.env.AIOS_DEMO_SECRET;
  if (secretEnv && secretEnv.length >= 16) {
    expect(bodyText, "DOM leaked AIOS_DEMO_SECRET").not.toContain(secretEnv);
  }
}

export async function loginAsPersona(
  page: Page,
  persona: DemoPersona,
): Promise<void> {
  await page.goto("/login", { waitUntil: "domcontentloaded" });

  // If already authenticated, switch via header switcher instead
  const switcher = page.getByRole("button", { name: "切换本地演示身份" });
  const isLoginScreen = await page
    .getByRole("heading", { name: "登录企业工作台" })
    .isVisible()
    .catch(() => false);

  if (!isLoginScreen && (await switcher.isVisible().catch(() => false))) {
    const currentText = (await switcher.innerText()).trim();
    if (!new RegExp(`^${persona}\\b`).test(currentText)) {
      await switchPersona(page, persona);
    }
    return;
  }

  const byTestId = page.getByTestId(`login-persona-${persona}`);
  const exactPersonaBtn = page
    .locator("button")
    .filter({
      has: page.locator("span", { hasText: new RegExp(`^${persona}$`) }),
    })
    .first();

  const targetButton = (await byTestId.count()) > 0 ? byTestId : exactPersonaBtn;
  await expect(targetButton).toBeVisible({ timeout: 15_000 });
  await targetButton.click();

  await expect(page).not.toHaveURL(/\/login(?:\?|$)/, { timeout: 15_000 });
  await expect(switcher).toBeVisible({ timeout: 15_000 });
  await expect(switcher).toContainText(persona);
}

export async function switchPersona(
  page: Page,
  persona: DemoPersona,
): Promise<void> {
  const switcher = page.getByRole("button", { name: "切换本地演示身份" });
  await expect(switcher).toBeVisible({ timeout: 15_000 });

  const currentLabel = (await switcher.innerText()).trim();
  if (new RegExp(`^${persona}\\b`).test(currentLabel)) {
    return;
  }

  await switcher.click();

  const byTestId = page.getByTestId(`persona-option-${persona}`);
  const byMenuItem = page
    .getByRole("menuitem")
    .filter({
      has: page.locator("span", { hasText: new RegExp(`^${persona}$`) }),
    })
    .first();

  const option = (await byTestId.count()) > 0 ? byTestId : byMenuItem;
  await expect(option).toBeVisible({ timeout: 10_000 });
  await option.click();

  await expect(switcher).toContainText(persona, { timeout: 15_000 });
  // Wait briefly for post-switch capabilities/profile hydration
  await expect(switcher).toBeEnabled({ timeout: 10_000 });
}

export interface BffResponse<T = unknown> {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: T;
}

export async function bffRequest<T = unknown>(
  page: Page,
  apiPath: string,
  options?: {
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    body?: unknown;
    idempotencyKey?: string;
    skipCsrf?: boolean;
  },
): Promise<BffResponse<T>> {
  return page.evaluate(
    async ({ path: reqPath, opts }) => {
      const method = (opts?.method || "GET").toUpperCase();
      const headers: Record<string, string> = { Accept: "application/json" };

      if (!["GET", "HEAD", "OPTIONS"].includes(method) && !opts?.skipCsrf) {
        const sessRes = await fetch("/v1/session", {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
        });
        if (sessRes.ok) {
          const sessData = (await sessRes.json()) as { csrf_token?: string };
          if (sessData.csrf_token) {
            headers["X-CSRF-Token"] = sessData.csrf_token;
          }
        }
      }

      if (opts?.idempotencyKey) {
        headers["Idempotency-Key"] = opts.idempotencyKey;
      }

      let bodyStr: string | undefined;
      if (opts?.body !== undefined) {
        headers["Content-Type"] = "application/json";
        bodyStr = JSON.stringify(opts.body);
      }

      const res = await fetch(reqPath, {
        method,
        credentials: "same-origin",
        cache: "no-store",
        headers,
        body: bodyStr,
      });

      const respHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        respHeaders[k.toLowerCase()] = v;
      });

      let parsed: unknown = null;
      const text = await res.text();
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }

      return {
        status: res.status,
        ok: res.ok,
        headers: respHeaders,
        body: parsed as T,
      };
    },
    { path: apiPath, opts: options },
  );
}

export async function createStructuredOrderProposalViaBff(
  page: Page,
  poNumber: string,
  warehouse = "HK01",
): Promise<{
  intakeId: string;
  proposalId: string;
  digest: string;
  state: string;
}> {
  const intakeRes = await bffRequest<{ intake_id: string; warehouse: string }>(
    page,
    `/v1/intakes/${encodeURIComponent(warehouse)}/structured`,
    {
      method: "POST",
      body: {
        po: poNumber,
        buyer: "HBR-47",
        currency: "HKD",
        delivery: "2026-12-15",
        total: "50.00",
        lines: [
          {
            sku: "TEA-24",
            unit: "CASE",
            quantity: 2,
            unit_price: "25.00",
            amount: "50.00",
          },
        ],
      },
    },
  );
  expect(intakeRes.status, `Expected 201 for structured intake ${poNumber}`).toBe(
    201,
  );
  const intakeId = intakeRes.body.intake_id;
  expect(intakeId).toBeTruthy();

  const prepRes = await bffRequest<{
    kind: string;
    proposal: { id: string; digest: string; state: string };
  }>(page, "/v1/workbench/calls", {
    method: "POST",
    idempotencyKey: `e2e-order-${poNumber}`,
    body: {
      tool: "order.draft.prepare",
      warehouse,
      intake_id: intakeId,
    },
  });
  expect(prepRes.status, `Expected 200 for order.draft.prepare`).toBe(200);
  expect(prepRes.body.kind).toBe("proposal");

  return {
    intakeId,
    proposalId: prepRes.body.proposal.id,
    digest: prepRes.body.proposal.digest,
    state: prepRes.body.proposal.state,
  };
}
