import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  assertDomZeroLeaks,
  assertNoBrowserStorageLeaks,
  attachRuntimeAudit,
  bffRequest,
  createStructuredOrderProposalViaBff,
  loginAsPersona,
  saveEvidenceScreenshot,
  switchPersona,
  uniqueSuffix,
} from "./helpers/workbench";

type LocaleCode = "zh-CN" | "zh-HK" | "en";
type ThemeMode = "light" | "dark";

const DARK_BODY_BG = "rgb(12, 14, 19)"; // #0C0E13 (--bg-app in html[data-theme="dark"])
const LIGHT_BODY_BG = "rgb(245, 246, 248)"; // #F5F6F8 (--bg-app in :root)
const CJK_REGEX = /[\u4e00-\u9fff]/;

function visibleLocaleSwitcher(page: Page): Locator {
  return page.locator('[data-testid="locale-switcher"]:visible').first();
}

function visibleLocaleOption(page: Page, locale: LocaleCode): Locator {
  return page.locator(`[data-testid="locale-option-${locale}"]:visible`).first();
}

function visibleThemeToggle(page: Page): Locator {
  return page.locator('[data-testid="theme-toggle-btn"]:visible').first();
}

async function selectLocaleViaUi(page: Page, locale: LocaleCode): Promise<void> {
  const switcher = visibleLocaleSwitcher(page);
  await expect(switcher).toBeVisible({ timeout: 12_000 });
  const option = visibleLocaleOption(page, locale);
  if (!(await option.isVisible().catch(() => false))) {
    // Dropdown variant: open menu first
    await switcher.click();
    await expect(option).toBeVisible({ timeout: 8_000 });
  }
  await option.click();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.getAttribute("lang")), {
      timeout: 8_000,
    })
    .toBe(locale);
}

async function setThemeViaUi(page: Page, target: ThemeMode): Promise<void> {
  const current = await page.evaluate(
    () => document.documentElement.getAttribute("data-theme") || "light",
  );
  if (current === target) return;
  const toggle = visibleThemeToggle(page);
  await expect(toggle).toBeVisible({ timeout: 12_000 });
  await toggle.click();
  await expect
    .poll(
      () => page.evaluate(() => document.documentElement.getAttribute("data-theme")),
      { timeout: 8_000 },
    )
    .toBe(target);
}

async function assertThemeVisuals(page: Page, theme: ThemeMode): Promise<void> {
  const expectedBg = theme === "dark" ? DARK_BODY_BG : LIGHT_BODY_BG;
  await expect
    .poll(
      () =>
        page.evaluate(() => ({
          dataTheme: document.documentElement.getAttribute("data-theme"),
          bodyBg: window.getComputedStyle(document.body).backgroundColor,
        })),
      {
        message: `Expected html[data-theme="${theme}"] and body background ${expectedBg}`,
        timeout: 8_000,
      },
    )
    .toEqual({ dataTheme: theme, bodyBg: expectedBg });
}

async function assertPreferenceCookies(
  page: Page,
  locale: LocaleCode,
  theme: ThemeMode,
): Promise<void> {
  const cookies = await page.context().cookies();
  const localeCookie = cookies.find((c) => c.name === "aios_locale");
  const themeCookie = cookies.find((c) => c.name === "aios_theme");
  expect(localeCookie?.value, "aios_locale cookie must be persisted").toBe(locale);
  expect(themeCookie?.value, "aios_theme cookie must be persisted").toBe(theme);
}

async function assertZeroBrowserStorage(page: Page): Promise<void> {
  const lengths = await page.evaluate(() => ({
    localStorageLength: window.localStorage.length,
    sessionStorageLength: window.sessionStorage.length,
  }));
  expect(
    lengths.localStorageLength,
    "localStorage must remain strictly empty (0 keys)",
  ).toBe(0);
  expect(
    lengths.sessionStorageLength,
    "sessionStorage must remain strictly empty (0 keys)",
  ).toBe(0);
  await assertNoBrowserStorageLeaks(page);
}

/**
 * Reloads the current route and verifies zero-FOUC SSR rendering:
 * 1) Raw SSR HTML document already contains `<html lang="..." data-theme="...">`
 *    BEFORE client JavaScript executes.
 * 2) Live DOM attributes, cookies, and computed body background match immediately.
 */
async function reloadAndAssertZeroFoucSsr(
  page: Page,
  expectedLocale: LocaleCode,
  expectedTheme: ThemeMode,
): Promise<void> {
  const expectedPathname = new URL(page.url()).pathname;
  const docResponsePromise = page.waitForResponse(
    (res) =>
      res.request().isNavigationRequest() &&
      new URL(res.url()).pathname === expectedPathname &&
      res.status() === 200,
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  const docRes = await docResponsePromise;
  const rawHtml = await docRes.text();

  const htmlTagMatch = rawHtml.match(/<html\b[^>]*>/i);
  expect(htmlTagMatch, "SSR HTML must include an <html> root tag").not.toBeNull();
  const htmlTag = htmlTagMatch![0];
  expect(
    htmlTag,
    `SSR <html> tag must immediately render lang="${expectedLocale}" (zero FOUC)`,
  ).toContain(`lang="${expectedLocale}"`);
  expect(
    htmlTag,
    `SSR <html> tag must immediately render data-theme="${expectedTheme}" (zero FOUC)`,
  ).toContain(`data-theme="${expectedTheme}"`);

  await assertPreferenceCookies(page, expectedLocale, expectedTheme);
  await assertThemeVisuals(page, expectedTheme);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.getAttribute("lang")))
    .toBe(expectedLocale);
  await assertZeroBrowserStorage(page);
}

/**
 * Extracts visible text inside a root selector while excluding the intentional
 * native-script language switcher (`简`/`繁`/`EN`) and optional dynamic
 * user-generated data containers (e.g. room titles or calendar events created in prior specs).
 */
async function collectChromeCjkHits(
  page: Page,
  options?: {
    rootSelector?: string;
    excludeSelectors?: string[];
  },
): Promise<string[]> {
  return page.evaluate(({ rootSelector, excludeSelectors }) => {
    const root = rootSelector ? document.querySelector(rootSelector) : document.body;
    if (!root) return [];

    const ignored = [
      '[data-testid="locale-switcher"]',
      ...(excludeSelectors ?? []),
    ];
    const hits: string[] = [];
    const cjk = /[\u4e00-\u9fff]/;

    const isIgnoredOrHidden = (el: Element | null): boolean => {
      let cur = el;
      while (cur) {
        for (const sel of ignored) {
          if (cur.matches(sel)) return true;
        }
        const style = window.getComputedStyle(cur);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          cur.getAttribute("aria-hidden") === "true"
        ) {
          return true;
        }
        cur = cur.parentElement;
      }
      return false;
    };

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Node | null = walker.nextNode();
    while (node) {
      const text = (node.textContent ?? "").trim();
      if (text && cjk.test(text) && !isIgnoredOrHidden(node.parentElement)) {
        hits.push(text);
      }
      node = walker.nextNode();
    }

    // Also inspect visible placeholders on inputs/textareas
    const fields = root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      "input[placeholder], textarea[placeholder]",
    );
    for (const field of fields) {
      if (isIgnoredOrHidden(field)) continue;
      const placeholder = (field.placeholder ?? "").trim();
      if (placeholder && cjk.test(placeholder)) {
        hits.push(`[placeholder] ${placeholder}`);
      }
    }

    return hits;
  }, options ?? {});
}

async function resetPreferencesViaUiOrCookies(page: Page): Promise<void> {
  try {
    const switcher = visibleLocaleSwitcher(page);
    if (await switcher.isVisible().catch(() => false)) {
      await selectLocaleViaUi(page, "zh-CN");
      await setThemeViaUi(page, "light");
      await assertThemeVisuals(page, "light");
      return;
    }
  } catch {
    // Fallback to direct cookie reset below if page closed or navigated away
  }
  await page.context().addCookies([
    { name: "aios_locale", value: "zh-CN", url: "http://localhost:3000" },
    { name: "aios_theme", value: "light", url: "http://localhost:3000" },
  ]);
}

async function ensureDefaultOperatorProfileNames(page: Page): Promise<void> {
  const [profRes, agentRes] = await Promise.all([
    bffRequest<{ version: number; display_name: string | null }>(page, "/v1/profile"),
    bffRequest<{ version: number; display_name: string | null }>(
      page,
      "/v1/agent-profile",
    ),
  ]);
  if (
    profRes.status === 200 &&
    profRes.body?.display_name &&
    typeof profRes.body.version === "number"
  ) {
    await bffRequest(page, "/v1/profile", {
      method: "PATCH",
      body: { version: profRes.body.version, display_name: null },
    });
  }
  if (
    agentRes.status === 200 &&
    agentRes.body?.display_name &&
    typeof agentRes.body.version === "number"
  ) {
    await bffRequest(page, "/v1/agent-profile", {
      method: "PATCH",
      body: { version: agentRes.body.version, display_name: null },
    });
  }
}

test.describe("Phase 7: Trilingual i18n (zh-CN / zh-HK / en) + Apple Sequoia Dark Mode & Zero-FOUC SSR Audit", () => {
  test("7.1 Root / Login: zh-CN <-> zh-HK <-> en, Light <-> Dark, zero-FOUC SSR reload & 11-login-dark-en.png", async ({
    page,
  }) => {
    const audit = attachRuntimeAudit(page);
    try {
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await expect(page.locator('div[hidden][id^="S:"]')).toHaveCount(0, {
        timeout: 15_000,
      });
      await expect(
        page.getByRole("heading", { name: "登录企业工作台" }),
      ).toBeVisible({ timeout: 15_000 });
      await assertThemeVisuals(page, "light");
      await assertZeroBrowserStorage(page);

      // 1. Live switch to Traditional Chinese (zh-HK)
      await selectLocaleViaUi(page, "zh-HK");
      await expect(
        page.getByRole("heading", { name: "登入企業工作台" }),
      ).toBeVisible();
      await expect(page.getByTestId("login-submit-btn")).toContainText("登入工作台");
      await expect(page.getByTestId("login-demo-helper-toggle")).toContainText(
        "示範帳號",
      );

      // 2. Live switch to English (en) + Dark Mode
      await selectLocaleViaUi(page, "en");
      await setThemeViaUi(page, "dark");

      await expect(
        page.getByRole("heading", { name: "Sign in to Workspace" }),
      ).toBeVisible();
      await expect(page.getByTestId("login-submit-btn")).toContainText("Sign In");
      await expect(page.getByTestId("login-demo-helper-toggle")).toContainText(
        "Demo Accounts",
      );
      await assertThemeVisuals(page, "dark");
      await assertPreferenceCookies(page, "en", "dark");

      // 3. Full reload -> verify zero-FOUC SSR <html lang="en" data-theme="dark">
      await reloadAndAssertZeroFoucSsr(page, "en", "dark");
      await expect(
        page.getByRole("heading", { name: "Sign in to Workspace" }),
      ).toBeVisible({ timeout: 15_000 });

      // Strictly zero untranslated Chinese UI chrome on English Login page (excluding 简/繁 switcher pills)
      const cjkHits = await collectChromeCjkHits(page);
      expect(
        cjkHits,
        `Unexpected untranslated CJK text on / in en mode: ${cjkHits.join(" | ")}`,
      ).toEqual([]);

      // Wait briefly for Obsidian Porcelain 3D ArchitecturalRelayCanvas draw
      await page.waitForTimeout(350);
      await saveEvidenceScreenshot(page, "11-login-dark-en.png");

      // 4. Reset back to zh-CN + light via UI controls and verify restoration
      await selectLocaleViaUi(page, "zh-CN");
      await setThemeViaUi(page, "light");
      await assertThemeVisuals(page, "light");
      await assertPreferenceCookies(page, "zh-CN", "light");
      await expect(
        page.getByRole("heading", { name: "登录企业工作台" }),
      ).toBeVisible();

      audit.clearExpectedLoginProbeNoise();
      await assertDomZeroLeaks(page);
      await assertZeroBrowserStorage(page);
      expect(audit.consoleErrors).toEqual([]);
      expect(audit.pageErrors).toEqual([]);
      expect(audit.apiViolations).toEqual([]);
    } finally {
      await resetPreferencesViaUiOrCookies(page);
      audit.dispose();
    }
  });

  test("7.2 Messenger (/inbox/assistant): Dark zh-HK active chat + Light en '+ Add Context' & 12/13 screenshots", async ({
    page,
  }) => {
    const audit = attachRuntimeAudit(page);
    try {
      await loginAsPersona(page, "operator");
      audit.clearExpectedLoginProbeNoise();
      await ensureDefaultOperatorProfileNames(page);

      await page.goto("/inbox/assistant", { waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("assistant-workspace")).toBeVisible({
        timeout: 15_000,
      });

      // 1. Switch to 繁體中文 (zh-HK) + Dark Mode via sidebar dock controls
      await selectLocaleViaUi(page, "zh-HK");
      await setThemeViaUi(page, "dark");

      // Reload & prove zero-FOUC SSR cookie persistence on /inbox/assistant
      await reloadAndAssertZeroFoucSsr(page, "zh-HK", "dark");
      await expect(page.getByTestId("assistant-workspace")).toBeVisible({
        timeout: 15_000,
      });

      // Verify authentic Traditional Chinese chrome
      await expect(page.getByTestId("inbox-thread-list").locator("h1")).toContainText(
        "訊息",
      );
      await expect(page.getByTestId("agent-open-workbench-btn")).toContainText(
        "工作台",
      );
      await expect(page.getByTestId("assistant-add-context-btn")).toContainText(
        "加入上下文",
      );
      await expect(page.getByTestId("contacts-directory-btn")).toHaveAttribute(
        "aria-label",
        /聯絡人/,
      );

      // Submit a live shipment query in Traditional Chinese to render Obsidian Dark bubbles + 3D result card
      const composer = page.getByTestId("assistant-composer-input");
      await composer.fill("查看運單 SHP-1001 倉庫 HK01");
      const hkTurnPromise = page.waitForResponse(
        (res) =>
          new URL(res.url()).pathname === "/v1/workbench/turns" &&
          res.request().method() === "POST",
      );
      await page.getByTestId("assistant-send-btn").click();
      expect((await hkTurnPromise).status()).toBe(200);
      await expect(page.getByTestId("turn-card-result").first()).toBeVisible({
        timeout: 12_000,
      });

      await page.waitForTimeout(350);
      await saveEvidenceScreenshot(page, "12-inbox-dark-zh-HK.png");

      // 2. Switch to English (en) + Light Mode, reload for clean English chat thread & SSR check
      await selectLocaleViaUi(page, "en");
      await setThemeViaUi(page, "light");
      await reloadAndAssertZeroFoucSsr(page, "en", "light");
      await expect(page.getByTestId("assistant-workspace")).toBeVisible({
        timeout: 15_000,
      });

      // Assert crisp English nav/header/composer labels
      await expect(page.getByTestId("inbox-thread-list").locator("h1")).toContainText(
        "Messages",
      );
      await expect(page.getByTestId("agent-open-workbench-btn")).toContainText(
        "Workbench",
      );
      await expect(page.getByTestId("assistant-add-context-btn")).toContainText(
        "Add Context",
      );
      await expect(page.getByTestId("inbox-pinned-agent-name")).toContainText(
        "Personal Agent",
      );

      // Run live English shipment query -> renders English BriefProgressChain + TurnResultCard
      const enComposer = page.getByTestId("assistant-composer-input");
      await enComposer.fill("Show shipment SHP-1001 at HK01");
      const enTurnPromise = page.waitForResponse(
        (res) =>
          new URL(res.url()).pathname === "/v1/workbench/turns" &&
          res.request().method() === "POST",
      );
      await page.getByTestId("assistant-send-btn").click();
      expect((await enTurnPromise).status()).toBe(200);
      await expect(page.getByTestId("turn-card-result").first()).toBeVisible({
        timeout: 12_000,
      });

      // Open `+ Add Context` popover in English Light Mode
      await page.getByTestId("assistant-add-context-btn").click();
      await expect(page.getByTestId("context-menu-brief")).toBeVisible({
        timeout: 8_000,
      });
      await expect(page.getByTestId("context-menu-brief")).toContainText(
        /Daily Brief/i,
      );
      await expect(page.getByTestId("context-menu-zoom")).toContainText(/Zoom/i);

      // Zero leftover Chinese UI chrome in Assistant canvas, popover, and sidebar chrome (excluding prior-spec room previews)
      const enCanvasCjk = await collectChromeCjkHits(page, {
        rootSelector: '[data-testid="assistant-workspace"]',
      });
      expect(
        enCanvasCjk,
        `Unexpected CJK text in /inbox/assistant canvas (en): ${enCanvasCjk.join(" | ")}`,
      ).toEqual([]);

      const enSidebarChromeCjk = await collectChromeCjkHits(page, {
        rootSelector: '[data-testid="inbox-thread-list"]',
        excludeSelectors: ['[data-testid="inbox-room-list"]'],
      });
      expect(
        enSidebarChromeCjk,
        `Unexpected CJK text in Messenger sidebar chrome (en): ${enSidebarChromeCjk.join(" | ")}`,
      ).toEqual([]);

      const popoverCjk = await collectChromeCjkHits(page, {
        rootSelector: "[data-radix-popper-content-wrapper]",
      });
      expect(
        popoverCjk,
        `Unexpected CJK text in + Add Context popover (en): ${popoverCjk.join(" | ")}`,
      ).toEqual([]);

      await page.waitForTimeout(300);
      await saveEvidenceScreenshot(page, "13-inbox-light-en.png");

      await page.keyboard.press("Escape");

      // 3. Reset back to zh-CN + light
      await selectLocaleViaUi(page, "zh-CN");
      await setThemeViaUi(page, "light");
      await assertPreferenceCookies(page, "zh-CN", "light");

      await assertDomZeroLeaks(page);
      await assertZeroBrowserStorage(page);
      expect(audit.consoleErrors).toEqual([]);
      expect(audit.pageErrors).toEqual([]);
      expect(audit.apiViolations).toEqual([]);
    } finally {
      await resetPreferencesViaUiOrCookies(page);
      audit.dispose();
    }
  });

  test("7.3 Workbench (/work) & Calendar (/calendar): Dark zh-CN Hub + Dark en MCP/Zoom & 14/15 screenshots", async ({
    page,
  }) => {
    const audit = attachRuntimeAudit(page);
    try {
      await loginAsPersona(page, "manager");
      audit.clearExpectedLoginProbeNoise();

      // 1. /work in Dark Mode + 简体中文 (zh-CN)
      await page.goto("/work", { waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("workbench-page")).toBeVisible({
        timeout: 15_000,
      });
      await setThemeViaUi(page, "dark");
      await selectLocaleViaUi(page, "zh-CN");

      await reloadAndAssertZeroFoucSsr(page, "zh-CN", "dark");
      await expect(page.getByTestId("workbench-page")).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByTestId("work-tier-execution")).toBeVisible();
      await expect(page.getByTestId("work-tier-approval_decision")).toBeVisible();
      await expect(page.getByTestId("work-tier-execution")).toContainText("执行与进件层");
      await expect(page.getByTestId("work-tier-approval_decision")).toContainText(
        "审批与经营层",
      );

      await page.waitForTimeout(350);
      await saveEvidenceScreenshot(page, "14-workbench-dark-zh-CN.png");

      // 2. Live switch on /work -> zh-HK -> en
      await selectLocaleViaUi(page, "zh-HK");
      await expect(page.getByTestId("shell-back-to-inbox")).toContainText("返回訊息");
      await expect(page.getByTestId("work-tier-execution")).toContainText("執行與進件層");
      await expect(page.getByTestId("work-tier-approval_decision")).toContainText(
        "審批與營運層",
      );

      await selectLocaleViaUi(page, "en");
      await expect(page.getByTestId("shell-back-to-inbox")).toContainText("Messages");
      await expect(page.getByTestId("work-tier-execution")).toContainText(
        "Execution & Intake",
      );
      await expect(page.getByTestId("work-tier-approval_decision")).toContainText(
        "Approvals & Insights",
      );

      // Verify zero Chinese UI chrome across AppShell header and Workbench chrome (excluding dynamic proposal user text if any)
      const workHeaderCjk = await collectChromeCjkHits(page, {
        rootSelector: "header",
      });
      expect(
        workHeaderCjk,
        `Unexpected CJK in /work header (en): ${workHeaderCjk.join(" | ")}`,
      ).toEqual([]);
      const workPageCjk = await collectChromeCjkHits(page, {
        rootSelector: '[data-testid="workbench-page"]',
      });
      expect(
        workPageCjk,
        `Unexpected CJK in /work page (en): ${workPageCjk.join(" | ")}`,
      ).toEqual([]);

      // 3. Navigate to /calendar in Dark Mode + English, reload for zero-FOUC SSR check
      await page.goto("/calendar", { waitUntil: "domcontentloaded" });
      await reloadAndAssertZeroFoucSsr(page, "en", "dark");
      await expect(page.getByTestId("calendar-workspace")).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByTestId("mcp-connectors-strip")).toBeVisible({
        timeout: 15_000,
      });

      // Verify all 4 MCP connector cards render crisp English
      for (const connector of ["google", "icloud", "outlook", "zoom"] as const) {
        const card = page.getByTestId(`mcp-connector-${connector}`);
        await expect(card).toBeVisible({ timeout: 12_000 });
        await expect(card).toContainText(/MCP Setup Needed|Connected/);
      }

      // Trigger English NL Zoom preview so screenshot showcases both MCP Connectors + Zoom Preview in Dark EN
      const nlInput = page.getByTestId("zoom-nl-input");
      await expect(nlInput).toBeVisible({ timeout: 12_000 });
      await nlInput.fill(
        "Book a Zoom meeting with manager tomorrow at 3pm for HK01 order review",
      );
      const previewPromise = page.waitForResponse(
        (res) =>
          new URL(res.url()).pathname === "/api/integrations/zoom/book" &&
          res.request().method() === "POST",
      );
      await nlInput.press("Enter");
      expect((await previewPromise).status()).toBe(200);
      await expect(page.getByTestId("zoom-booking-preview-card")).toBeVisible({
        timeout: 12_000,
      });
      // M-3: self-mention ("manager" when logged in as manager) must be stripped from title
      await expect(page.getByTestId("zoom-booking-title-input")).toHaveValue(
        "HK01 order review",
      );

      // Zero CJK in /calendar UI chrome, MCP strip, and Zoom preview card (excluding prior Chinese event rows in list)
      const calChromeCjk = await collectChromeCjkHits(page, {
        rootSelector: '[data-testid="calendar-workspace"]',
        excludeSelectors: ['[data-testid="calendar-event-list"]'],
      });
      expect(
        calChromeCjk,
        `Unexpected CJK in /calendar chrome & Zoom preview (en): ${calChromeCjk.join(" | ")}`,
      ).toEqual([]);

      await page.waitForTimeout(350);
      await saveEvidenceScreenshot(page, "15-calendar-dark-en.png");

      // Also verify Traditional Chinese (zh-HK) on /calendar
      await selectLocaleViaUi(page, "zh-HK");
      await expect(page.getByTestId("calendar-workspace")).toContainText("日曆");
      await expect(page.getByTestId("mcp-connectors-strip")).toContainText(
        /待設定 MCP|已連線/,
      );

      // Reset back to zh-CN + light
      await selectLocaleViaUi(page, "zh-CN");
      await setThemeViaUi(page, "light");
      await assertThemeVisuals(page, "light");
      const resetCookies = await page.context().cookies();
      expect(resetCookies.find((c) => c.name === "aios_locale")?.value).toBe(
        "zh-CN",
      );

      await assertDomZeroLeaks(page);
      await assertZeroBrowserStorage(page);
      expect(audit.consoleErrors).toEqual([]);
      expect(audit.pageErrors).toEqual([]);
      expect(audit.apiViolations).toEqual([]);
    } finally {
      await resetPreferencesViaUiOrCookies(page);
      audit.dispose();
    }
  });

  test("7.4 Admin Ops (/admin) & People ACL (/admin/people/operator): Dark zh-HK Ops + Dark en ACL & 16/17 screenshots", async ({
    page,
  }) => {
    const audit = attachRuntimeAudit(page);
    try {
      // 1. Admin Ops Monitor (/admin) in Dark Mode + 繁體中文 (zh-HK)
      await loginAsPersona(page, "admin");
      audit.clearExpectedLoginProbeNoise();

      await page.goto("/admin", { waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("admin-ops-page")).toBeVisible({
        timeout: 15_000,
      });

      await selectLocaleViaUi(page, "zh-HK");
      await setThemeViaUi(page, "dark");
      await reloadAndAssertZeroFoucSsr(page, "zh-HK", "dark");

      await expect(page.getByTestId("admin-ops-page")).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByTestId("probe-healthz")).toContainText(/up/i, {
        timeout: 12_000,
      });
      await expect(page.getByTestId("probe-readyz")).toContainText(/ready/i, {
        timeout: 12_000,
      });
      await expect(page.locator("header")).toContainText("維運監控");
      await expect(page.getByTestId("admin-ops-page")).toContainText(/維運|寫入|稽核/);

      await page.waitForTimeout(350);
      await saveEvidenceScreenshot(page, "16-admin-dark-zh-HK.png");

      // Switch /admin to English and assert zero leftover Chinese UI chrome
      await selectLocaleViaUi(page, "en");
      await expect(page.locator("header")).toContainText("Ops");
      const adminEnCjk = await collectChromeCjkHits(page, {
        rootSelector: "body",
      });
      expect(
        adminEnCjk,
        `Unexpected CJK text on /admin (en): ${adminEnCjk.join(" | ")}`,
      ).toEqual([]);

      // 2. Switch to access-admin -> /admin/people/operator in Dark Mode + English
      await switchPersona(page, "access-admin");
      await page.goto("/admin/people/operator", { waitUntil: "domcontentloaded" });
      await reloadAndAssertZeroFoucSsr(page, "en", "dark");

      for (const mod of [
        "orders",
        "dispatch",
        "invoice-review",
        "warehouse-insights",
        "approvals",
      ] as const) {
        await expect(page.getByTestId(`module-card-${mod}`)).toBeVisible({
          timeout: 15_000,
        });
      }

      // Strictly zero leftover Chinese UI chrome anywhere on /admin/people/operator in en mode
      const peopleEnCjk = await collectChromeCjkHits(page, {
        rootSelector: "body",
      });
      expect(
        peopleEnCjk,
        `Unexpected CJK text on /admin/people/operator (en): ${peopleEnCjk.join(" | ")}`,
      ).toEqual([]);

      // A-1: Humanized H1 + A-5: unconfigured en version badge says "Default" (not "Initial")
      await expect(page.locator("h1").first()).toContainText("Mingzhe Lin");
      await expect(page.getByTestId("module-card-orders")).toContainText("Orders");
      await expect(page.getByTestId("module-card-approvals")).toContainText(
        "Approvals",
      );
      await expect(page.getByTestId("module-card-approvals")).toContainText(
        "Default",
      );

      await page.waitForTimeout(350);
      await saveEvidenceScreenshot(page, "17-people-dark-en.png");

      // Verify Traditional Chinese (zh-HK) labels on /admin/people/operator (`授權`, `模組`, `倉庫`, `訂單`)
      await selectLocaleViaUi(page, "zh-HK");
      await expect(page.locator("body")).toContainText("授權");
      await expect(page.getByTestId("module-card-orders")).toContainText("訂單");
      await expect(page.getByTestId("module-card-dispatch")).toContainText("調度");
      await expect(page.getByTestId("module-card-invoice-review")).toContainText(
        "發票審閱",
      );

      // Reset back to zh-CN + light
      await selectLocaleViaUi(page, "zh-CN");
      await setThemeViaUi(page, "light");
      await assertThemeVisuals(page, "light");
      const resetCookies = await page.context().cookies();
      expect(resetCookies.find((c) => c.name === "aios_locale")?.value).toBe(
        "zh-CN",
      );

      await assertDomZeroLeaks(page);
      await assertZeroBrowserStorage(page);
      expect(audit.consoleErrors).toEqual([]);
      expect(audit.pageErrors).toEqual([]);
      expect(audit.apiViolations).toEqual([]);
    } finally {
      await resetPreferencesViaUiOrCookies(page);
      audit.dispose();
    }
  });

  test("7.5 @mobile @mobile-only Mobile (390x844): Dark zh-HK Messenger + SSR reload + zero overflow & 18-mobile-dark-zh-HK.png", async ({
    page,
  }) => {
    const audit = attachRuntimeAudit(page);
    try {
      await loginAsPersona(page, "operator");
      audit.clearExpectedLoginProbeNoise();
      await ensureDefaultOperatorProfileNames(page);

      // 1. Mobile /inbox list shows sidebar bottom dock with locale-switcher & theme-toggle-btn
      await page.goto("/inbox", { waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("inbox-pinned-agent")).toBeVisible({
        timeout: 15_000,
      });

      await selectLocaleViaUi(page, "zh-HK");
      await setThemeViaUi(page, "dark");

      // Reload & prove zero-FOUC SSR cookie persistence on mobile /inbox
      await reloadAndAssertZeroFoucSsr(page, "zh-HK", "dark");
      await expect(page.getByTestId("inbox-thread-list").locator("h1")).toContainText(
        "訊息",
      );
      await expect(page.getByTestId("inbox-pinned-agent-name")).toContainText(
        "個人業務助手",
      );

      const listOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 4,
      );
      expect(
        listOverflow,
        "Mobile /inbox in dark zh-HK must not overflow horizontally",
      ).toBe(false);

      // 2. Tap Pinned Agent -> active Mobile Messenger thread in Dark Mode + 繁體中文
      await page.getByTestId("inbox-pinned-agent").click();
      await expect(page).toHaveURL(/\/inbox\/assistant/);
      await expect(page.getByTestId("assistant-workspace")).toBeVisible({
        timeout: 15_000,
      });
      await assertThemeVisuals(page, "dark");

      const composer = page.getByTestId("assistant-composer-input");
      await composer.fill("查看運單 SHP-1001 倉庫 HK01");
      const turnPromise = page.waitForResponse(
        (res) =>
          new URL(res.url()).pathname === "/v1/workbench/turns" &&
          res.request().method() === "POST",
      );
      await page.getByTestId("assistant-send-btn").click();
      expect((await turnPromise).status()).toBe(200);
      await expect(page.getByTestId("turn-card-result").first()).toBeVisible({
        timeout: 12_000,
      });

      const threadOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 4,
      );
      expect(
        threadOverflow,
        "Mobile /inbox/assistant in dark zh-HK must not overflow horizontally",
      ).toBe(false);

      await page.waitForTimeout(350);
      await saveEvidenceScreenshot(page, "18-mobile-dark-zh-HK.png");

      // 3. Return to /inbox, verify live switch to en + mobile /work account-menu preferences
      await page.getByTestId("assistant-mobile-back").click();
      await expect(page).toHaveURL(/\/inbox$/);
      await selectLocaleViaUi(page, "en");
      await expect(page.getByTestId("inbox-thread-list").locator("h1")).toContainText(
        "Messages",
      );
      await expect(page.getByTestId("inbox-pinned-agent-name")).toContainText(
        "Personal Agent",
      );

      // Navigate to /work and verify mobile top bar hides desktop PreferencesBar (no overlap with Back pill)
      // while the Account menu exposes mobile locale & theme controls cleanly
      await page.goto("/work", { waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("workbench-page")).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByTestId("preferences-bar")).toBeHidden();
      const workMobileOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 4,
      );
      expect(
        workMobileOverflow,
        "Mobile /work in dark en must not overflow horizontally",
      ).toBe(false);

      const accountMenuBtn = page.getByRole("button", { name: "Account menu" });
      await expect(accountMenuBtn).toBeVisible({ timeout: 12_000 });
      await accountMenuBtn.click();
      await selectLocaleViaUi(page, "zh-CN");
      await setThemeViaUi(page, "light");
      await page.keyboard.press("Escape");

      await assertThemeVisuals(page, "light");
      await assertPreferenceCookies(page, "zh-CN", "light");
      await assertDomZeroLeaks(page);
      await assertZeroBrowserStorage(page);
      expect(audit.consoleErrors).toEqual([]);
      expect(audit.pageErrors).toEqual([]);
      expect(audit.apiViolations).toEqual([]);
    } finally {
      await resetPreferencesViaUiOrCookies(page);
      audit.dispose();
    }
  });

  test("7.6 Round 3 P0-1/P0-2: zh-HK NL Zoom parse (+2d HKT 10:00, finance, INV-100對帳會) & en system message localization (19 & 20)", async ({
    page,
  }) => {
    const audit = attachRuntimeAudit(page);
    try {
      await loginAsPersona(page, "operator");
      audit.clearExpectedLoginProbeNoise();
      await ensureDefaultOperatorProfileNames(page);

      // 1. Go to /calendar in zh-HK Light Mode and parse the exact zh-HK example utterance
      await page.goto("/calendar", { waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("calendar-workspace")).toBeVisible({
        timeout: 15_000,
      });
      await selectLocaleViaUi(page, "zh-HK");
      await setThemeViaUi(page, "light");
      await assertThemeVisuals(page, "light");

      const nlInput = page.getByTestId("zoom-nl-input");
      await expect(nlInput).toBeVisible({ timeout: 12_000 });
      await nlInput.fill("後天上午10點和finance開INV-100對帳會");

      const parsePromise = page.waitForResponse(
        (res) =>
          new URL(res.url()).pathname === "/api/integrations/zoom/book" &&
          res.request().method() === "POST",
      );
      await nlInput.press("Enter");
      const parseRes = await parsePromise;
      expect(parseRes.status()).toBe(200);
      const parseBody = (await parseRes.json()) as {
        draft: {
          title: string;
          starts_at: string;
          attendees: Array<string | { subject: string; display_name?: string }>;
        };
      };

      // Compute expected +2 HKT days (Asia/Hong_Kong) date string YYYY-MM-DD
      const expectedHktDate = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Hong_Kong",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(Date.now() + 2 * 86_400_000));

      expect(
        parseBody.draft.title,
        "zh-HK NL parse must extract exact title INV-100對帳會",
      ).toBe("INV-100對帳會");
      const attendeeSubjects = parseBody.draft.attendees.map((a) =>
        typeof a === "string" ? a : a.subject,
      );
      expect(
        attendeeSubjects,
        "zh-HK NL parse must resolve finance attendee",
      ).toContain("finance");
      expect(
        parseBody.draft.starts_at,
        `zh-HK NL parse must resolve +2 HKT days (${expectedHktDate}) at 10:00`,
      ).toMatch(new RegExp(`^${expectedHktDate}T10:00`));

      const previewCard = page.getByTestId("zoom-booking-preview-card");
      await expect(previewCard).toBeVisible({ timeout: 12_000 });
      await expect(page.getByTestId("zoom-booking-title-input")).toHaveValue(
        "INV-100對帳會",
      );
      await expect(
        previewCard.locator('input[type="datetime-local"]').first(),
      ).toHaveValue(`${expectedHktDate}T10:00`);
      await expect(previewCard).toContainText(/周婉清|finance/);

      await page.waitForTimeout(300);
      await saveEvidenceScreenshot(page, "19-zh-hk-nl-parse.png");

      // 2. Confirm meeting with English title so sidebar + chat room showcase pure English system message localization (P0-2)
      const syncTitle = `INV-100 Reconciliation Sync ${uniqueSuffix().slice(-3)}`;
      await page.getByTestId("zoom-booking-title-input").fill(syncTitle);
      const confirmPromise = page.waitForResponse(
        (res) =>
          new URL(res.url()).pathname === "/api/integrations/zoom/book" &&
          res.request().method() === "POST",
      );
      await page.getByTestId("zoom-booking-confirm-btn").click();
      const confirmRes = await confirmPromise;
      expect(confirmRes.status()).toBe(201);
      const confirmBody = (await confirmRes.json()) as {
        event: { id: string; room_id: string | null };
      };
      const meetingRoomId = confirmBody.event.room_id;
      expect(
        meetingRoomId,
        "Confirmed multi-attendee Zoom booking must create/link a collaboration room",
      ).toBeTruthy();

      await expect(page.getByTestId("zoom-booking-confirmed-card")).toBeVisible({
        timeout: 12_000,
      });

      // Switch to English and inspect BOTH sidebar room preview and chat room feed
      await selectLocaleViaUi(page, "en");
      await page.goto(`/inbox/${encodeURIComponent(meetingRoomId!)}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(page.getByTestId("chat-room-workspace")).toBeVisible({
        timeout: 15_000,
      });

      const roomRow = page.getByTestId(`inbox-room-item-${meetingRoomId}`);
      await expect(roomRow).toBeVisible({ timeout: 15_000 });
      await expect(roomRow).toContainText(syncTitle);
      await expect(roomRow).toContainText(`Scheduled "${syncTitle}"`, {
        timeout: 12_000,
      });

      const roomWorkspace = page.getByTestId("chat-room-workspace");
      await expect(roomWorkspace).toContainText(`Scheduled "${syncTitle}"`, {
        timeout: 12_000,
      });

      // Strict P0-2 assertions: ZERO raw Chinese prefixes/messages and ZERO raw structured tokens leak
      const [sidebarRowText, roomWorkspaceText] = await Promise.all([
        roomRow.innerText(),
        roomWorkspace.innerText(),
      ]);
      for (const [label, txt] of [
        ["sidebar room preview", sidebarRowText],
        ["chat room workspace", roomWorkspaceText],
      ] as const) {
        expect(txt, `${label} must not leak raw zh-CN 已预约会议`).not.toContain(
          "已预约会议",
        );
        expect(txt, `${label} must not leak raw zh-CN 会议 ·`).not.toContain(
          "会议 ·",
        );
        expect(
          txt,
          `${label} must not leak raw [[aios:meeting-booked| token`,
        ).not.toContain("[[aios:meeting-booked");
      }

      const roomEnCjk = await collectChromeCjkHits(page, {
        rootSelector: '[data-testid="chat-room-workspace"]',
      });
      expect(
        roomEnCjk,
        `Unexpected CJK text in English meeting chat room: ${roomEnCjk.join(" | ")}`,
      ).toEqual([]);

      await page.waitForTimeout(300);
      await saveEvidenceScreenshot(page, "20-en-system-message.png");

      // Bonus check: switching live to zh-HK re-localizes the same structured message cleanly
      await selectLocaleViaUi(page, "zh-HK");
      await expect(roomWorkspace).toContainText(`已預約會議「${syncTitle}」`);

      // Reset back to zh-CN + light
      await selectLocaleViaUi(page, "zh-CN");
      await setThemeViaUi(page, "light");
      await assertThemeVisuals(page, "light");
      const resetCookies = await page.context().cookies();
      expect(resetCookies.find((c) => c.name === "aios_locale")?.value).toBe(
        "zh-CN",
      );

      await assertDomZeroLeaks(page);
      await assertZeroBrowserStorage(page);
      expect(audit.consoleErrors).toEqual([]);
      expect(audit.pageErrors).toEqual([]);
      expect(audit.apiViolations).toEqual([]);
    } finally {
      await resetPreferencesViaUiOrCookies(page);
      audit.dispose();
    }
  });

  test("7.7 Round 3 P0-4/W-1/W-3: Workbench Pending Approval KPI matches /v1/workbench/approvals & Dark EN Verified Proposal Stepper (21)", async ({
    page,
  }) => {
    const audit = attachRuntimeAudit(page);
    const poNumber = `FE-R3-${uniqueSuffix()}`;
    try {
      // 1. Create a fresh HK01 structured order proposal as operator
      await loginAsPersona(page, "operator");
      audit.clearExpectedLoginProbeNoise();
      const created = await createStructuredOrderProposalViaBff(
        page,
        poNumber,
        "HK01",
      );

      // 2. Switch to manager -> /work in Dark Mode + English -> assert Pending Approval KPI matches /v1/workbench/approvals (W-1)
      await switchPersona(page, "manager");
      await page.goto("/work", { waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("workbench-page")).toBeVisible({
        timeout: 15_000,
      });
      await selectLocaleViaUi(page, "en");
      await setThemeViaUi(page, "dark");

      const approvalsRes = await bffRequest<{
        items: Array<{ id: string; state: string }>;
      }>(page, "/v1/workbench/approvals?limit=50");
      expect(approvalsRes.status).toBe(200);
      const expectedApprovalsCount = approvalsRes.body.items.length;
      expect(
        expectedApprovalsCount,
        "Manager must have at least 1 real pending approval",
      ).toBeGreaterThanOrEqual(1);

      const pendingApprovalCard = page
        .locator('[data-testid="workbench-page"] [role="button"]')
        .filter({ hasText: "Pending Approval" })
        .first();
      await expect(pendingApprovalCard).toBeVisible({ timeout: 12_000 });
      await expect(pendingApprovalCard).toContainText(
        String(expectedApprovalsCount),
        { timeout: 12_000 },
      );
      await expect(page.getByTestId("work-tab-approvals")).toContainText(
        String(expectedApprovalsCount),
      );

      // 3. Approve proposal as manager -> run admin worker-tick until VERIFIED
      const approveRes = await bffRequest<{ state: string }>(
        page,
        `/v1/proposals/${encodeURIComponent(created.proposalId)}/approve`,
        {
          method: "POST",
          body: { digest: created.digest },
        },
      );
      expect([200, 202]).toContain(approveRes.status);

      await switchPersona(page, "admin");
      let verified = false;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const tickRes = await bffRequest(page, "/v1/demo/worker-tick", {
          method: "POST",
        });
        expect(tickRes.status).toBe(200);
        const checkRes = await bffRequest<{ state: string }>(
          page,
          `/v1/proposals/${encodeURIComponent(created.proposalId)}`,
        );
        if (checkRes.status === 200 && checkRes.body?.state === "VERIFIED") {
          verified = true;
          break;
        }
      }
      expect(verified, "Proposal must transition to VERIFIED after worker tick").toBe(
        true,
      );

      // 4. Switch to manager -> open Verified proposal in Dark Mode + English -> zero-FOUC SSR reload
      await switchPersona(page, "manager");
      await page.goto(
        `/proposals/${encodeURIComponent(created.proposalId)}`,
        { waitUntil: "domcontentloaded" },
      );
      await reloadAndAssertZeroFoucSsr(page, "en", "dark");

      await expect(page.getByTestId("proposal-id-value")).toContainText(
        created.proposalId,
        { timeout: 15_000 },
      );
      await expect(page.getByTestId("proposal-receipt-card")).toBeVisible({
        timeout: 15_000,
      });

      // P0-4: ExecutionTopologyRibbon completed step circles must be opaque (no translucent alpha < 1 allowing rail strikethrough)
      const topology = page
        .locator("div.rounded-card")
        .filter({ hasText: "Execution Progress" })
        .first();
      await expect(topology).toBeVisible({ timeout: 12_000 });
      const nodeBackgrounds = await topology.evaluate((root) => {
        const circles = Array.from(
          root.querySelectorAll<HTMLElement>(".grid-cols-5 div.rounded-full.h-7.w-7"),
        );
        return circles.map((el) => window.getComputedStyle(el).backgroundColor);
      });
      expect(
        nodeBackgrounds.length,
        "ExecutionTopologyRibbon must render all 5 spine step circles",
      ).toBe(5);
      for (const bg of nodeBackgrounds) {
        // Opaque colors have either rgb(...) / color(srgb ... without `/ <1`) or alpha === 1
        expect(
          bg,
          `Stepper circle background must be opaque (got ${bg})`,
        ).not.toMatch(/rgba\([^)]*,\s*0(?:\.\d+)?\)|\/\s*0(?:\.\d+)?\)/);
      }

      // W-3: Audit timeline must humanize worker -> "System worker" and never display raw uppercase enum codes
      const timeline = page.getByTestId("proposal-events-timeline");
      await expect(timeline).toBeVisible({ timeout: 12_000 });
      await expect(timeline).toContainText("System worker");
      const timelineText = await timeline.innerText();
      for (const rawEnum of [
        "PROPOSED",
        "APPROVED_AND_QUEUED",
        "SENDING",
        "VERIFYING",
        "VERIFIED",
        "APPROVAL_DENIED",
      ]) {
        expect(
          timelineText,
          `Audit timeline must not display raw enum code ${rawEnum}`,
        ).not.toContain(rawEnum);
      }

      // Strictly zero leftover CJK UI chrome across the entire Dark EN Verified Proposal page
      const proposalEnCjk = await collectChromeCjkHits(page, {
        rootSelector: "body",
      });
      expect(
        proposalEnCjk,
        `Unexpected CJK text on /proposals/[id] (en): ${proposalEnCjk.join(" | ")}`,
      ).toEqual([]);

      await page.waitForTimeout(350);
      await saveEvidenceScreenshot(page, "21-dark-en-proposal-stepper.png");

      // Reset back to zh-CN + light
      await selectLocaleViaUi(page, "zh-CN");
      await setThemeViaUi(page, "light");
      await assertThemeVisuals(page, "light");
      const resetCookies = await page.context().cookies();
      expect(resetCookies.find((c) => c.name === "aios_locale")?.value).toBe(
        "zh-CN",
      );

      await assertDomZeroLeaks(page);
      await assertZeroBrowserStorage(page);
      expect(audit.consoleErrors).toEqual([]);
      expect(audit.pageErrors).toEqual([]);
      expect(audit.apiViolations).toEqual([]);
    } finally {
      await resetPreferencesViaUiOrCookies(page);
      audit.dispose();
    }
  });
});
