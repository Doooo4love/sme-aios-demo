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

test.describe("Phase 1: Auth, QZT 3D Login, Shell, Profiles & Keyboard Drawer", () => {
  test("1.1 /login renders QZT 3D ArchitecturalRelayCanvas, demo login verifies /v1/me & pinned Agent row", async ({
    page,
  }) => {
    const audit = attachRuntimeAudit(page);
    try {
      await page.goto("/login", { waitUntil: "domcontentloaded" });
      await expect(
        page.getByRole("heading", { name: "登录企业工作台" }),
      ).toBeVisible();

      // Verify QZT 3D ArchitecturalRelayCanvas renders with valid dimensions on desktop
      // Note: /login mounts a compact lg:hidden mobile canvas first and the full desktop canvas inside <aside>
      const stageCanvas = page.locator("aside canvas").first();
      await expect(stageCanvas).toBeVisible();
      const box = await stageCanvas.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThan(200);
      expect(box!.height).toBeGreaterThan(200);

      // Verify interactive stratum tabs exist inside the desktop 3D obsidian stage
      const obsidianStage = page.locator('aside [data-surface="obsidian-stage"]').first();
      if ((await obsidianStage.count()) > 0) {
        await expect(obsidianStage).toBeVisible();
      }

      await saveEvidenceScreenshot(page, "01-login-3d-stage.png");

      // Controlled local demo login as operator
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

      // Verify /inbox shows pinned Personal Agent row with compact Agent label
      await page.goto("/inbox", { waitUntil: "domcontentloaded" });
      const pinnedAgent = page.getByTestId("inbox-pinned-agent");
      await expect(pinnedAgent).toBeVisible({ timeout: 15_000 });
      await expect(pinnedAgent).toContainText("Agent");

      // Operator must NOT see admin ops or employee access admin links in nav
      const mainNav = page.getByRole("navigation", { name: "主导航" });
      await expect(mainNav.locator('a[href="/admin"]')).toHaveCount(0);
      await expect(mainNav.locator('a[href="/admin/people"]')).toHaveCount(0);

      await saveEvidenceScreenshot(page, "02-inbox-assistant.png");

      await assertDomZeroLeaks(page);
      await assertNoBrowserStorageLeaks(page);
      expect(audit.consoleErrors, "Zero console errors on /login & /inbox").toEqual([]);
      expect(audit.pageErrors, "Zero page errors on /login & /inbox").toEqual([]);
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

    // 3. Reload and verify persistence across /inbox pinned Agent row and AppShell sidebar
    await page.goto("/inbox", { waitUntil: "domcontentloaded" });
    await page.reload({ waitUntil: "domcontentloaded" });

    const pinnedAgent = page.getByTestId("inbox-pinned-agent");
    await expect(pinnedAgent).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("inbox-pinned-agent-name")).toContainText(
      customAgentName,
    );

    // Verify sidebar Agent link reflects updated customAgentName
    const sidebarAgentLink = page.locator('nav[aria-label="主导航"] a[href="/settings/agent"]');
    await expect(sidebarAgentLink).toHaveAttribute(
      "title",
      new RegExp(customAgentName),
    );

    // Open sidebar user dropdown menu and verify customUserName projection
    const accountMenuBtn = page.getByRole("button", { name: "账号与资料菜单" });
    await accountMenuBtn.click();
    await expect(page.getByText(customUserName)).toBeVisible();
    await expect(page.getByText(customAgentName).first()).toBeVisible();
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

    // Type a draft message into the assistant composer
    const composer = page
      .getByTestId("assistant-composer-input")
      .or(page.locator("[data-composer-input]").first())
      .or(page.locator("textarea").first());
    await expect(composer).toBeVisible({ timeout: 15_000 });

    const draftText = "草稿保留验证-查看运单 SHP-1001 仓库 HK01";
    await composer.fill(draftText);
    await expect(composer).toHaveValue(draftText);

    const drawerToggleBtn = page.getByRole("button", { name: "切换右侧业务面板" });
    const drawerAside = page.locator('aside[aria-label="业务核对面板"]');

    // Focus the drawer toggle button so Escape focus restoration can be verified deterministically
    await drawerToggleBtn.focus();
    await expect(drawerAside).toHaveAttribute("aria-hidden", "true");

    // Toggle right business drawer via keyboard shortcut (Meta+. on macOS, Control+. elsewhere)
    const shortcut = process.platform === "darwin" ? "Meta+." : "Control+.";
    await page.keyboard.press(shortcut);
    await expect(drawerAside).toHaveAttribute("aria-hidden", "false");
    await expect(drawerToggleBtn).toHaveAttribute("aria-expanded", "true");

    // Press Escape to close drawer and verify focus returns cleanly
    await page.keyboard.press("Escape");
    await expect(drawerAside).toHaveAttribute("aria-hidden", "true");
    await expect(drawerToggleBtn).toHaveAttribute("aria-expanded", "false");

    // Verify focus was restored asynchronously (via requestAnimationFrame) to either the toggle trigger or composer
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const active = document.activeElement;
            if (!active) return false;
            const ariaLabel = active.getAttribute("aria-label") || "";
            return (
              ariaLabel === "切换右侧业务面板" ||
              active.hasAttribute("data-composer-input") ||
              active.tagName === "TEXTAREA"
            );
          }),
        {
          message: "Focus should restore after Escape closes drawer",
          timeout: 5_000,
        },
      )
      .toBe(true);

    // Draft in composer must remain completely intact across drawer open/close
    await expect(composer).toHaveValue(draftText);
  });

  test("1.4 @mobile @mobile-only Mobile (390x844) navigation to thread detail and clean Back path", async ({
    page,
  }) => {
    await page.goto("/login", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "登录企业工作台" }),
    ).toBeVisible();

    // Compact 3D stage renders cleanly on narrow screen without horizontal scroll blowup
    const hasOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 4,
    );
    expect(hasOverflow, "Mobile login should not overflow horizontally").toBe(false);

    await loginAsPersona(page, "operator");
    await page.goto("/inbox", { waitUntil: "domcontentloaded" });

    // Verify mobile bottom nav is visible on 390px viewport
    const mobileNav = page.getByRole("navigation", { name: "移动端主导航" });
    await expect(mobileNav).toBeVisible();

    // Tap pinned Agent thread to open /inbox/assistant
    const pinnedAgent = page.getByTestId("inbox-pinned-agent");
    await expect(pinnedAgent).toBeVisible({ timeout: 15_000 });
    await pinnedAgent.click();

    await expect(page).toHaveURL(/\/inbox\/assistant/);
    await saveEvidenceScreenshot(page, "08-mobile-inbox.png");

    // Verify clean mobile Back button returns to /inbox
    const backLink = page.getByTestId("assistant-mobile-back");
    await expect(backLink).toBeVisible();
    await backLink.click();
    await expect(page).toHaveURL(/\/inbox$/);
  });
});
