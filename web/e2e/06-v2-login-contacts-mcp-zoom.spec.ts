import { expect, test } from "@playwright/test";
import {
  assertDomZeroLeaks,
  assertNoBrowserStorageLeaks,
  attachRuntimeAudit,
  bffRequest,
  loginAsPersona,
  loginWithPassword,
  saveEvidenceScreenshot,
  uniqueSuffix,
} from "./helpers/workbench";

test.describe("Phase 6: v2 Account+Password Login, Tenant Contacts Directory, Muse Agent UX & MCP Calendar / NL Zoom Booking", () => {
  test("6.1 Root / renders Account+Password form + Porcelain 3D stage, wrong password -> 401, operator/aios2026 -> /inbox", async ({
    page,
  }) => {
    const audit = attachRuntimeAudit(page);
    try {
      // 1. Unauthenticated root `/` renders Account + Password LoginView directly
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await expect(
        page.getByRole("heading", { name: "登录企业工作台" }),
      ).toBeVisible({ timeout: 15_000 });

      const usernameInput = page.locator('input[name="username"]');
      const passwordInput = page.locator('input[name="password"]');
      const submitBtn = page.getByTestId("login-submit-btn");

      await expect(usernameInput).toBeVisible();
      await expect(passwordInput).toBeVisible();
      await expect(submitBtn).toBeVisible();

      // Porcelain 3D showcase renders cleanly without obsidian-stage
      await expect(page.locator('[data-surface="obsidian-stage"]')).toHaveCount(0);
      await expect(
        page.locator("aside").getByTestId("architectural-relay-canvas").first(),
      ).toBeVisible();

      // Demo helper starts collapsed by default
      const demoToggle = page.getByTestId("login-demo-helper-toggle");
      await expect(demoToggle).toBeVisible({ timeout: 15_000 });
      await expect(demoToggle).toHaveAttribute("aria-expanded", "false");

      // 2. Wrong password returns 401 with anti-enumeration error banner
      await usernameInput.fill("operator");
      await passwordInput.fill("wrong-password-999");

      const wrongPwdPromise = page.waitForResponse(
        (res) =>
          new URL(res.url()).pathname === "/api/auth/login" &&
          res.request().method() === "POST",
      );
      await submitBtn.click();
      const wrongPwdRes = await wrongPwdPromise;
      expect(wrongPwdRes.status()).toBe(401);
      await expect(page.getByTestId("login-error")).toBeVisible({
        timeout: 10_000,
      });

      // Clear expected pre-login /v1/me 401 and deliberate wrong-password 401 console log
      audit.clearExpectedLoginProbeNoise();

      // 3. Valid Account + Password login (`operator` / `aios2026`) succeeds into /inbox
      await loginWithPassword(page, "operator", "aios2026", "operator");

      const meRes = await bffRequest<{
        subject: string;
        tenant: string;
        warehouses: string[];
      }>(page, "/v1/me");
      expect(meRes.status).toBe(200);
      expect(meRes.body.subject).toBe("operator");
      expect(meRes.body.tenant).toBe("harbour");
      expect(meRes.body.warehouses).toContain("HK01");

      await assertDomZeroLeaks(page);
      await assertNoBrowserStorageLeaks(page);
      expect(audit.consoleErrors).toEqual([]);
      expect(audit.pageErrors).toEqual([]);
      expect(audit.apiViolations).toEqual([]);
    } finally {
      audit.dispose();
    }
  });

  test("6.2 Company Contacts Directory isolates tenant (zero island-manager leak) and starts persistent 1:1 room with manager", async ({
    page,
  }) => {
    const audit = attachRuntimeAudit(page);
    const suffix = uniqueSuffix();
    const dmMessage = `通讯录直连协作确认-${suffix}`;

    try {
      await loginAsPersona(page, "operator");
      audit.clearExpectedLoginProbeNoise();
      await page.goto("/inbox", { waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("inbox-shell")).toBeVisible({
        timeout: 15_000,
      });

      // 1. Sidebar live contacts search (`contacts-search-input`) finds harbour colleague & never leaks cross-tenant `island-manager`
      const sidebarSearch = page.getByTestId("contacts-search-input");
      await expect(sidebarSearch).toBeVisible();
      await sidebarSearch.fill("island");
      await page.waitForTimeout(450);
      await expect(
        page.getByTestId("sidebar-contact-start-chat-island-manager"),
      ).toHaveCount(0);
      await expect(page.getByTestId("contact-start-chat-island-manager")).toHaveCount(0);
      await expect(page.locator("body")).not.toContainText("island-manager");
      await sidebarSearch.fill("");

      // Direct BFF tenant-isolation check on GET /api/directory/contacts
      const [allContactsRes, islandQueryRes] = await Promise.all([
        bffRequest<{ tenant: string; items: Array<{ subject: string; tenant: string }> }>(
          page,
          "/api/directory/contacts?limit=50",
        ),
        bffRequest<{ tenant: string; items: Array<{ subject: string; tenant: string }> }>(
          page,
          "/api/directory/contacts?q=island&limit=50",
        ),
      ]);
      expect(allContactsRes.status).toBe(200);
      expect(allContactsRes.body.tenant).toBe("harbour");
      expect(
        allContactsRes.body.items.some((c) => c.subject === "manager"),
        "harbour contacts directory should include manager",
      ).toBe(true);
      expect(
        allContactsRes.body.items.some(
          (c) => c.subject === "island-manager" || c.tenant !== "harbour",
        ),
        "harbour contacts directory MUST NEVER return island-manager or cross-tenant records",
      ).toBe(false);
      expect(islandQueryRes.status).toBe(200);
      expect(islandQueryRes.body.items).toEqual([]);

      // 2. Open Company Contacts Directory modal (`contacts-directory-btn`) over macOS Messenger
      const dirBtn = page.getByTestId("contacts-directory-btn");
      await expect(dirBtn).toBeVisible();
      await dirBtn.click();

      const dirModal = page.getByTestId("contacts-directory-modal");
      await expect(dirModal).toBeVisible({ timeout: 12_000 });
      await expect(
        dirModal.getByTestId("contact-start-chat-manager"),
      ).toBeVisible({
        timeout: 12_000,
      });

      await page.waitForTimeout(260);
      // Verify frosted modal is properly centered inside the viewport (catches Tailwind v4 translate vs transform double-offset)
      const dialogBox = await page.getByRole("dialog").boundingBox();
      expect(dialogBox, "Contacts directory dialog must have a valid bounding box").not.toBeNull();
      expect(dialogBox!.x, "Dialog must not clip off the left edge").toBeGreaterThanOrEqual(12);
      expect(dialogBox!.y, "Dialog must not clip off the top edge").toBeGreaterThanOrEqual(12);
      const centerX = dialogBox!.x + dialogBox!.width / 2;
      expect(
        Math.abs(centerX - 720),
        `Dialog should be horizontally centered around 720px (got ${centerX})`,
      ).toBeLessThan(40);

      await saveEvidenceScreenshot(page, "02c-contacts-directory.png");

      // Search `island` inside modal -> zero results, zero cross-tenant leak
      const modalSearch = dirModal.getByTestId("contacts-modal-search-input");
      await modalSearch.fill("island");
      await page.waitForTimeout(450);
      await expect(dirModal).not.toContainText("island-manager");
      await expect(
        dirModal.getByTestId("contact-start-chat-island-manager"),
      ).toHaveCount(0);

      // Search `manager` inside modal and click `contact-start-chat-manager` to open/create 1:1 room
      await modalSearch.fill("manager");
      const startChatBtn = dirModal.getByTestId("contact-start-chat-manager");
      await expect(startChatBtn).toBeVisible({ timeout: 10_000 });

      const directRoomRespPromise = page.waitForResponse(
        (res) =>
          new URL(res.url()).pathname === "/api/directory/direct-room" &&
          res.request().method() === "POST",
      );
      await startChatBtn.click();
      const directRoomResp = await directRoomRespPromise;
      expect([200, 201]).toContain(directRoomResp.status());

      await expect(page).toHaveURL(/\/inbox\/[^/]+$/, { timeout: 15_000 });
      await expect(page.getByTestId("chat-room-workspace")).toBeVisible({
        timeout: 15_000,
      });

      // 3. Send a message in the 1:1 room, reload, and verify persistence
      const roomComposer = page.getByTestId("room-composer-input");
      await expect(roomComposer).toBeVisible({ timeout: 12_000 });
      await roomComposer.fill(dmMessage);

      const postMsgPromise = page.waitForResponse(
        (res) =>
          /\/v1\/chat\/rooms\/[^/]+\/messages$/.test(new URL(res.url()).pathname) &&
          res.request().method() === "POST",
      );
      await page.getByTestId("room-send-btn").click();
      const postMsgResp = await postMsgPromise;
      expect(postMsgResp.status()).toBe(201);
      await expect(page.getByText(dmMessage).first()).toBeVisible({
        timeout: 12_000,
      });

      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.getByText(dmMessage).first()).toBeVisible({
        timeout: 15_000,
      });

      await assertDomZeroLeaks(page);
      await assertNoBrowserStorageLeaks(page);
      expect(audit.consoleErrors).toEqual([]);
      expect(audit.pageErrors).toEqual([]);
      expect(audit.apiViolations).toEqual([]);
    } finally {
      audit.dispose();
    }
  });

  test("6.3 Muse Agent UX: clean header, active iMessage bubbles + BriefProgressChain + 3D card + '+ 添加上下文' popover -> tiered /work", async ({
    page,
  }) => {
    const audit = attachRuntimeAudit(page);
    try {
      await loginAsPersona(page, "operator");
      audit.clearExpectedLoginProbeNoise();
      await page.goto("/inbox/assistant", { waitUntil: "domcontentloaded" });

      // 1. Verify pure Muse header: custom Agent avatar + name and ONLY top-right "工作台" pill (zero PanelRight clutter)
      await expect(page.getByTestId("assistant-workspace")).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByTestId("assistant-header-name")).toBeVisible();
      const openWorkbenchBtn = page.getByTestId("agent-open-workbench-btn");
      await expect(openWorkbenchBtn).toBeVisible();
      await expect(openWorkbenchBtn).toContainText("工作台");
      await expect(
        page.getByRole("button", { name: "切换右侧业务面板" }),
      ).toHaveCount(0);

      // 2. Verify floating capsule composer contains `+ 添加上下文` and Send button
      const addCtxBtn = page.getByTestId("assistant-add-context-btn");
      const sendBtn = page.getByTestId("assistant-send-btn");
      const composer = page.getByTestId("assistant-composer-input");
      await expect(addCtxBtn).toBeVisible();
      await expect(addCtxBtn).toContainText("添加上下文");
      await expect(sendBtn).toBeVisible();

      // 3. Submit a real business turn to render iMessage bubbles, BriefProgressChain & 3D result card
      await composer.fill("查看运单 SHP-1001 仓库 HK01");
      const turnPromise = page.waitForResponse(
        (res) =>
          new URL(res.url()).pathname === "/v1/workbench/turns" &&
          res.request().method() === "POST",
      );
      await sendBtn.click();
      const turnRes = await turnPromise;
      expect(turnRes.status()).toBe(200);

      await expect(page.getByTestId("turn-card-result").first()).toBeVisible({
        timeout: 12_000,
      });
      await expect(page.getByText("SHP-1001").first()).toBeVisible();

      // 4. Open `+ 添加上下文` popover and verify all key context actions
      await addCtxBtn.click();
      await expect(page.getByTestId("context-menu-brief")).toBeVisible({
        timeout: 8_000,
      });
      await expect(page.getByTestId("context-menu-history")).toBeVisible();
      await expect(page.getByTestId("context-menu-zoom")).toBeVisible();

      await page.waitForTimeout(300);
      await saveEvidenceScreenshot(page, "02b-inbox-active-chat-context.png");

      // Close popover and click top-right "工作台" -> enters permission-tiered /work
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("context-menu-history")).toBeHidden({
        timeout: 5_000,
      });
      await openWorkbenchBtn.click();

      await expect(page).toHaveURL(/\/work$/, { timeout: 15_000 });
      await expect(page.getByTestId("workbench-page")).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByTestId("work-tier-execution")).toBeVisible();

      await assertDomZeroLeaks(page);
      await assertNoBrowserStorageLeaks(page);
      expect(audit.consoleErrors).toEqual([]);
      expect(audit.pageErrors).toEqual([]);
      expect(audit.apiViolations).toEqual([]);
    } finally {
      audit.dispose();
    }
  });

  test("6.4 Calendar MCP Connectors (4 cards), valid .ics export & NL Zoom Booking -> real /v1/calendar/events + zero-leak audit", async ({
    page,
  }) => {
    const audit = attachRuntimeAudit(page);
    const suffix = uniqueSuffix();
    const confirmedTitle = `HK01订单评审会-${suffix}`;

    try {
      await loginAsPersona(page, "operator");
      audit.clearExpectedLoginProbeNoise();
      await page.goto("/calendar", { waitUntil: "domcontentloaded" });

      await expect(page.getByTestId("calendar-workspace")).toBeVisible({
        timeout: 15_000,
      });

      // 1. All 4 MCP connector cards display with honest status and appropriate CTA ("连接" when unconfigured)
      await expect(page.getByTestId("mcp-connectors-strip")).toBeVisible({
        timeout: 15_000,
      });
      for (const connector of ["google", "icloud", "outlook", "zoom"] as const) {
        const card = page.getByTestId(`mcp-connector-${connector}`);
        await expect(card).toBeVisible({ timeout: 12_000 });
        await expect(card).toContainText(/待配置 MCP|已连接/);
        await expect(card).toContainText(/连接|触发同步|预约 Zoom 会议/);
      }
      await expect(page.getByTestId("calendar-ics-download-btn")).toBeVisible({
        timeout: 12_000,
      });

      // 2. GET /api/calendar/ics returns valid RFC 5545 text/calendar containing BEGIN:VCALENDAR
      const icsCheck = await page.evaluate(async () => {
        const res = await fetch("/api/calendar/ics", {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
        });
        const text = await res.text();
        return {
          status: res.status,
          contentType: res.headers.get("content-type") || "",
          cacheControl: res.headers.get("cache-control") || "",
          body: text,
        };
      });
      expect(icsCheck.status).toBe(200);
      expect(icsCheck.contentType.toLowerCase()).toContain("text/calendar");
      expect(icsCheck.cacheControl.toLowerCase()).toContain("no-store");
      expect(icsCheck.body).toContain("BEGIN:VCALENDAR");
      expect(icsCheck.body).toContain("END:VCALENDAR");

      // 3. Natural-Language Zoom booking preview ("明天下午3点和manager用Zoom开HK01订单评审会")
      const nlInput = page.getByTestId("zoom-nl-input");
      await expect(nlInput).toBeVisible({ timeout: 12_000 });
      await nlInput.fill("明天下午3点和manager用Zoom开HK01订单评审会");

      const previewRespPromise = page.waitForResponse(
        (res) =>
          new URL(res.url()).pathname === "/api/integrations/zoom/book" &&
          res.request().method() === "POST",
      );
      await nlInput.press("Enter");
      const previewResp = await previewRespPromise;
      expect(previewResp.status()).toBe(200);

      const previewCard = page.getByTestId("zoom-booking-preview-card");
      await expect(previewCard).toBeVisible({ timeout: 12_000 });
      const titleInput = page.getByTestId("zoom-booking-title-input");
      await expect(titleInput).toBeVisible();
      await expect(titleInput).toHaveValue(/HK01/);
      await expect(previewCard).toContainText("manager");

      // Edit title to unique confirmedTitle so repeated runs are cleanly identifiable
      await titleInput.fill(confirmedTitle);

      // 4. Confirm booking -> creates real internal /v1/calendar/events record
      const confirmRespPromise = page.waitForResponse(
        (res) =>
          new URL(res.url()).pathname === "/api/integrations/zoom/book" &&
          res.request().method() === "POST",
      );
      await page.getByTestId("zoom-booking-confirm-btn").click();
      const confirmResp = await confirmRespPromise;
      expect(confirmResp.status()).toBe(201);

      const confirmedCard = page.getByTestId("zoom-booking-confirmed-card");
      await expect(confirmedCard).toBeVisible({ timeout: 15_000 });
      await expect(confirmedCard).toContainText(confirmedTitle);

      // Single-event .ics download link is present and serves valid VEVENT
      const icsHref = await page
        .getByTestId("zoom-booking-ics-download")
        .getAttribute("href");
      expect(icsHref).toBeTruthy();
      const singleIcs = await page.evaluate(async (href) => {
        const res = await fetch(href, {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
        });
        return {
          status: res.status,
          contentType: res.headers.get("content-type") || "",
          body: await res.text(),
        };
      }, icsHref!);
      expect(singleIcs.status).toBe(200);
      expect(singleIcs.contentType.toLowerCase()).toContain("text/calendar");
      expect(singleIcs.body).toContain("BEGIN:VCALENDAR");
      expect(singleIcs.body).toContain("BEGIN:VEVENT");
      expect(singleIcs.body).toContain(confirmedTitle);

      // Verify the real internal /v1/calendar/events record exists via BFF & renders in calendar list
      const startIso = new Date(Date.now() - 86_400_000).toISOString();
      const endIso = new Date(Date.now() + 14 * 86_400_000).toISOString();
      const calRes = await bffRequest<{
        items: Array<{ id: string; title: string; organizer: string }>;
      }>(
        page,
        `/v1/calendar/events?start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}&limit=100`,
      );
      expect(calRes.status).toBe(200);
      expect(
        calRes.body.items.some((ev) => ev.title === confirmedTitle),
        `Expected real /v1/calendar/events record for "${confirmedTitle}"`,
      ).toBe(true);

      await expect(page.getByTestId("calendar-event-list")).toContainText(
        confirmedTitle,
        { timeout: 12_000 },
      );

      // Capture /calendar screenshot showcasing NL Zoom confirmed card + 4 MCP 3D connectors
      await page.waitForTimeout(300);
      await saveEvidenceScreenshot(page, "10-calendar-mcp-zoom.png");

      // Strict zero-forbidden-key (`provider`/`prompt`/`planner`) & zero-error audit
      await assertDomZeroLeaks(page);
      await assertNoBrowserStorageLeaks(page);
      expect(audit.apiViolations, "Zero forbidden JSON keys or Cache-Control violations").toEqual(
        [],
      );
      expect(audit.consoleErrors, "Zero console errors").toEqual([]);
      expect(audit.pageErrors, "Zero page errors").toEqual([]);
    } finally {
      audit.dispose();
    }
  });
});
