import { expect, test } from "@playwright/test";
import {
  assertDomZeroLeaks,
  assertNoBrowserStorageLeaks,
  attachRuntimeAudit,
  bffRequest,
  loginAsPersona,
  saveEvidenceScreenshot,
  uniqueSuffix,
} from "./helpers/workbench";

test.describe("Phase 1: v2 Porcelain Login, 2-Column macOS Messenger Shell, Profiles & Keyboard Drawer", () => {
  test("1.1 Root / renders Account+Password LoginView & Porcelain 3D stage, login verifies /v1/me, 2-col /inbox & tiered /work", async ({
    page,
  }) => {
    const audit = attachRuntimeAudit(page);
    try {
      // Unauthenticated root `/` renders Account + Password LoginView directly
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await expect(
        page.getByRole("heading", { name: "登录企业工作台" }),
      ).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId("login-account-input")).toBeVisible();
      await expect(page.getByTestId("login-password-input")).toBeVisible();
      await expect(page.getByTestId("login-submit-btn")).toBeVisible();

      // Demo quick-fill helper is collapsed by default on v2 LoginView
      const demoToggle = page.getByTestId("login-demo-helper-toggle");
      await expect(demoToggle).toBeVisible({ timeout: 15_000 });
      await expect(demoToggle).toHaveAttribute("aria-expanded", "false");

      // Verify Frosted Porcelain 3D ArchitecturalRelayCanvas renders with valid dimensions (zero obsidian-stage)
      await expect(page.locator('[data-surface="obsidian-stage"]')).toHaveCount(0);
      const relayStage = page.locator("aside").getByTestId("architectural-relay-canvas").first();
      await expect(relayStage).toBeVisible();
      const stageCanvas = page.locator("aside canvas").first();
      await expect(stageCanvas).toBeVisible();
      const box = await stageCanvas.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThan(200);
      expect(box!.height).toBeGreaterThan(200);

      // Brief settle for 3D canvas initial draw
      await page.waitForTimeout(350);
      await saveEvidenceScreenshot(page, "01-login-3d-stage.png");

      // Controlled local demo login as operator (expands collapsed demo helper)
      await loginAsPersona(page, "operator");
      audit.clearExpectedLoginProbeNoise();

      // Verify real /v1/me and sanitized /v1/workbench/capabilities
      const meRes = await bffRequest<{
        subject: string;
        tenant: string;
        role: string;
        warehouses: string[];
      }>(page, "/v1/me");
      expect(meRes.status).toBe(200);
      expect(meRes.body.subject).toBe("operator");
      expect(meRes.body.tenant).toBe("harbour");
      expect(meRes.body.warehouses).toContain("HK01");

      const capRes = await bffRequest<Record<string, unknown>>(
        page,
        "/v1/workbench/capabilities",
      );
      expect(capRes.status).toBe(200);
      expect(capRes.body).not.toHaveProperty("planner");

      // Verify /inbox renders native 2-column macOS Messenger (NO old 60px icon rail) + Pinned 3D Agent + Muse header/composer
      await page.goto("/inbox", { waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("inbox-shell")).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId("inbox-thread-list")).toBeVisible();
      const pinnedAgent = page.getByTestId("inbox-pinned-agent");
      await expect(pinnedAgent).toBeVisible({ timeout: 15_000 });
      await expect(pinnedAgent).toContainText("Agent");
      await expect(page.getByTestId("assistant-workspace")).toBeVisible();
      await expect(page.getByTestId("agent-open-workbench-btn")).toBeVisible();
      await expect(page.getByTestId("assistant-add-context-btn")).toBeVisible();
      await expect(page.getByTestId("assistant-send-btn")).toBeVisible();
      await expect(page.getByRole("button", { name: "账号与资料菜单" })).toBeVisible();

      // Pure 2-column Messenger has NO redundant global top nav and NO header PanelRight clutter on /inbox
      await expect(page.getByRole("navigation", { name: "主导航" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "切换右侧业务面板" })).toHaveCount(0);

      await page.waitForTimeout(300);
      await saveEvidenceScreenshot(page, "02-inbox-assistant.png");

      // Clicking top-right "工作台" enters /work with 56px frosted top bar; operator must NOT see /admin or /admin/people
      await page.getByTestId("agent-open-workbench-btn").click();
      await expect(page).toHaveURL(/\/work$/);
      const mainNav = page.getByRole("navigation", { name: "主导航" });
      await expect(mainNav).toBeVisible({ timeout: 15_000 });
      await expect(mainNav.locator('a[href="/admin"]')).toHaveCount(0);
      await expect(mainNav.locator('a[href="/admin/people"]')).toHaveCount(0);

      await assertDomZeroLeaks(page);
      await assertNoBrowserStorageLeaks(page);
      expect(audit.consoleErrors, "Zero console errors on /, /inbox & /work").toEqual([]);
      expect(audit.pageErrors, "Zero page errors on /, /inbox & /work").toEqual([]);
      expect(audit.apiViolations, "Zero BFF leak violations").toEqual([]);
    } finally {
      audit.dispose();
    }
  });

  test("1.2 Self profile & personal Agent display names persist across reload and project globally", async ({
    page,
  }) => {
    await loginAsPersona(page, "operator");
    const suffix = uniqueSuffix().slice(-4);
    const customUserName = `林明哲-${suffix}`;
    const customAgentName = `港湾协理-${suffix}`;

    // 1. Update self profile display_name
    await page.goto("/settings/profile", { waitUntil: "domcontentloaded" });
    const profileInput = page.getByTestId("profile-display-name-input");
    await expect(profileInput).toBeVisible({ timeout: 15_000 });
    await profileInput.fill(customUserName);

    const profileSaveBtn = page.getByTestId("profile-save-btn");
    const profilePatchPromise = page.waitForResponse(
      (res) =>
        new URL(res.url()).pathname === "/v1/profile" &&
        res.request().method() === "PATCH",
    );
    await profileSaveBtn.click();
    const profilePatchRes = await profilePatchPromise;
    expect(profilePatchRes.status()).toBe(200);

    // 2. Update personal Agent display_name
    await page.goto("/settings/agent", { waitUntil: "domcontentloaded" });
    const agentInput = page.getByTestId("agent-display-name-input");
    await expect(agentInput).toBeVisible({ timeout: 15_000 });
    await agentInput.fill(customAgentName);

    const agentSaveBtn = page.getByTestId("agent-save-btn");
    const agentPatchPromise = page.waitForResponse(
      (res) =>
        new URL(res.url()).pathname === "/v1/agent-profile" &&
        res.request().method() === "PATCH",
    );
    await agentSaveBtn.click();
    const agentPatchRes = await agentPatchPromise;
    expect(agentPatchRes.status()).toBe(200);

    // 3. Reload and verify persistence across /inbox pinned Agent hero, Muse header, and bottom dock account menu
    await page.goto("/inbox", { waitUntil: "domcontentloaded" });
    await page.reload({ waitUntil: "domcontentloaded" });

    const pinnedAgent = page.getByTestId("inbox-pinned-agent");
    await expect(pinnedAgent).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("inbox-pinned-agent-name")).toContainText(
      customAgentName,
    );
    await expect(page.getByTestId("assistant-header-name")).toContainText(
      customAgentName,
    );

    // Open bottom sidebar user dock menu and verify both customUserName & customAgentName projection
    const accountMenuBtn = page.getByRole("button", { name: "账号与资料菜单" });
    await expect(accountMenuBtn).toContainText(customUserName);
    await accountMenuBtn.click();
    await expect(page.getByText(customUserName).first()).toBeVisible();
    await expect(page.getByText(new RegExp(customAgentName)).first()).toBeVisible();
    await page.keyboard.press("Escape");

    // Verify backend persisted values directly
    const [profRes, agentProfRes] = await Promise.all([
      bffRequest<{ display_name: string | null }>(page, "/v1/profile"),
      bffRequest<{ display_name: string | null }>(page, "/v1/agent-profile"),
    ]);
    expect(profRes.body.display_name).toBe(customUserName);
    expect(agentProfRes.body.display_name).toBe(customAgentName);
  });

  test("1.3 Right business drawer keyboard toggle (Meta/Ctrl+.), Escape focus restoration & draft preservation", async ({
    page,
  }) => {
    await loginAsPersona(page, "operator");
    await page.goto("/inbox/assistant", { waitUntil: "domcontentloaded" });

    // Type a draft message into the Muse floating composer
    const composer = page
      .getByTestId("assistant-composer-input")
      .or(page.locator("[data-composer-input]").first())
      .or(page.locator("textarea").first());
    await expect(composer).toBeVisible({ timeout: 15_000 });

    const draftText = "草稿保留验证-查看运单 SHP-1001 仓库 HK01";
    await composer.fill(draftText);
    await expect(composer).toHaveValue(draftText);

    const drawerAside = page.locator('aside[aria-label="业务核对面板"]');

    // Muse header omits redundant PanelRight icon; drawer opens/closes strictly via keyboard shortcut
    await expect(page.getByRole("button", { name: "切换右侧业务面板" })).toHaveCount(0);
    await composer.focus();
    await expect(drawerAside).toHaveAttribute("aria-hidden", "true");

    // Toggle right business drawer via keyboard shortcut (Meta+. on macOS, Control+. elsewhere)
    const shortcut = process.platform === "darwin" ? "Meta+." : "Control+.";
    await page.keyboard.press(shortcut);
    await expect(drawerAside).toHaveAttribute("aria-hidden", "false");

    // Press Escape to close drawer and verify focus returns cleanly to the composer
    await page.keyboard.press("Escape");
    await expect(drawerAside).toHaveAttribute("aria-hidden", "true");

    // Verify focus was restored asynchronously (via requestAnimationFrame) back to composer
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const active = document.activeElement;
            if (!active) return false;
            return (
              active.hasAttribute("data-composer-input") ||
              active.tagName === "TEXTAREA"
            );
          }),
        {
          message: "Focus should restore to composer after Escape closes drawer",
          timeout: 5_000,
        },
      )
      .toBe(true);

    // Draft in composer must remain completely intact across drawer open/close
    await expect(composer).toHaveValue(draftText);
  });

  test("1.4 @mobile @mobile-only Mobile (390x844) navigation to iMessage thread detail, clean Back path & Workbench nav", async ({
    page,
  }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "登录企业工作台" }),
    ).toBeVisible({ timeout: 15_000 });

    // Compact 3D stage renders cleanly on narrow screen without horizontal scroll blowup
    const hasOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 4,
    );
    expect(hasOverflow, "Mobile login should not overflow horizontally").toBe(false);

    await loginAsPersona(page, "operator");
    await page.goto("/inbox", { waitUntil: "domcontentloaded" });

    // Verify mobile /inbox renders full-width Messenger sidebar with pinned Agent & bottom dock
    const pinnedAgent = page.getByTestId("inbox-pinned-agent");
    await expect(pinnedAgent).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("link", { name: "进入工作台" })).toBeVisible();

    // Tap pinned Agent thread to open /inbox/assistant
    await pinnedAgent.click();
    await expect(page).toHaveURL(/\/inbox\/assistant/);
    await expect(page.getByTestId("assistant-workspace")).toBeVisible({
      timeout: 15_000,
    });

    // Trigger one real query so the mobile screenshot showcases live iMessage bubbles + 3D result card
    const composer = page.getByTestId("assistant-composer-input");
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("查看运单 SHP-1001 仓库 HK01");
    const turnRespPromise = page.waitForResponse(
      (res) =>
        new URL(res.url()).pathname === "/v1/workbench/turns" &&
        res.request().method() === "POST",
    );
    await page.getByTestId("assistant-send-btn").click();
    const turnResp = await turnRespPromise;
    expect(turnResp.status()).toBe(200);
    await expect(page.getByTestId("turn-card-result").first()).toBeVisible({
      timeout: 12_000,
    });

    const threadOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 4,
    );
    expect(threadOverflow, "Mobile assistant thread should not overflow horizontally").toBe(
      false,
    );

    await page.waitForTimeout(300);
    await saveEvidenceScreenshot(page, "08-mobile-inbox.png");

    // Verify clean mobile Back button returns to /inbox
    const backLink = page.getByTestId("assistant-mobile-back");
    await expect(backLink).toBeVisible();
    await backLink.click();
    await expect(page).toHaveURL(/\/inbox$/);

    // Navigate to /work and verify mobile bottom navigation bar renders cleanly
    await page.getByRole("link", { name: "进入工作台" }).click();
    await expect(page).toHaveURL(/\/work$/);
    const mobileNav = page.getByRole("navigation", { name: "移动端主导航" });
    await expect(mobileNav).toBeVisible({ timeout: 15_000 });
  });
});
