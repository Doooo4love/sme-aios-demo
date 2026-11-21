import { expect, test } from "@playwright/test";
import {
  assertDomZeroLeaks,
  assertNoBrowserStorageLeaks,
  attachRuntimeAudit,
  loginAsPersona,
  switchPersona,
} from "./helpers/workbench";

test.describe("Phase 5: Strict Zero-Leak Security Audit & Resilience / Error Matrix", () => {
  test("5.1 Strict Zero-Leak Audit across network, DOM, console, and browser storage", async ({
    page,
  }) => {
    const audit = attachRuntimeAudit(page);
    try {
      await loginAsPersona(page, "operator");
      audit.clearExpectedLoginProbeNoise();

      // Walk through key authenticated workspaces across multiple roles
      await page.goto("/inbox/assistant", { waitUntil: "domcontentloaded" });
      const composer = page.getByTestId("assistant-composer-input");
      await expect(composer).toBeVisible({ timeout: 15_000 });
      await composer.fill("查看运单 SHP-1001 仓库 HK01");
      const sendBtn = page.getByTestId("assistant-send-btn");
      const turnDone = page.waitForResponse(
        (res) =>
          new URL(res.url()).pathname === "/v1/workbench/turns" &&
          res.request().method() === "POST",
      );
      await sendBtn.click();
      await turnDone;

      await page.goto("/work", { waitUntil: "domcontentloaded" });
      await page.goto("/calendar", { waitUntil: "domcontentloaded" });
      await page.goto("/settings/profile", { waitUntil: "domcontentloaded" });
      await assertDomZeroLeaks(page);
      await assertNoBrowserStorageLeaks(page);

      await switchPersona(page, "admin");
      await page.goto("/admin", { waitUntil: "domcontentloaded" });
      await assertDomZeroLeaks(page);

      await switchPersona(page, "access-admin");
      await page.goto("/admin/people", { waitUntil: "domcontentloaded" });
      await assertDomZeroLeaks(page);
      await assertNoBrowserStorageLeaks(page);

      // Verify capabilities was fetched and never contained `planner`
      const capResponses = audit.v1Responses.filter(
        (r) => r.url === "/v1/workbench/capabilities" && r.status === 200,
      );
      expect(capResponses.length).toBeGreaterThan(0);
      for (const cap of capResponses) {
        expect(cap.bodyText).not.toContain('"planner"');
      }

      expect(audit.apiViolations, "Zero API leak/header violations").toEqual([]);
      expect(audit.consoleErrors, "Zero console errors").toEqual([]);
      expect(audit.pageErrors, "Zero uncaught page errors").toEqual([]);
    } finally {
      audit.dispose();
    }
  });

  test("5.2 Late response from old authGeneration is discarded after persona switch", async ({
    page,
  }) => {
    await loginAsPersona(page, "operator");
    await page.goto("/inbox/assistant", { waitUntil: "domcontentloaded" });

    const gate: { release: () => void } = { release: () => {} };
    const turnIntercepted = new Promise<void>((resolve) => {
      void page.route("**/v1/workbench/turns", async (route) => {
        if (route.request().method() !== "POST") {
          await route.continue();
          return;
        }
        resolve();
        await new Promise<void>((res) => {
          gate.release = res;
        });
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: { "Cache-Control": "no-store" },
          body: JSON.stringify({
            kind: "clarification",
            question: "SENTINEL-OLD-AUTH-GEN-LEAK-999",
          }),
        });
      });
    });

    const composer = page.getByTestId("assistant-composer-input");
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("查看运单 SHP-1001 仓库 HK01");
    const sendBtn = page.getByTestId("assistant-send-btn");
    await sendBtn.click();

    // Wait until the slow request is in-flight, then switch persona BEFORE releasing response
    await turnIntercepted;
    await switchPersona(page, "finance");

    // Release the stale response from operator's old authGeneration
    gate.release();
    await page.waitForTimeout(600);

    const bodyText = await page.locator("body").innerText();
    expect(
      bodyText,
      "Late response from old authGeneration must NEVER render after persona switch",
    ).not.toContain("SENTINEL-OLD-AUTH-GEN-LEAK-999");

    await page.unroute("**/v1/workbench/turns");
  });

  test("5.3 401 Unauthorized purges state and redirects to /login", async ({
    page,
  }) => {
    await loginAsPersona(page, "operator");
    await page.goto("/inbox/assistant", { waitUntil: "domcontentloaded" });

    await page.route("**/v1/workbench/turns", async (route) => {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        headers: { "Cache-Control": "no-store" },
        body: JSON.stringify({ detail: "Browser session has expired" }),
      });
    });

    const composer = page.getByTestId("assistant-composer-input");
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("查看运单 SHP-1001 仓库 HK01");
    const sendBtn = page.getByTestId("assistant-send-btn");
    await sendBtn.click();

    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
    await page.unroute("**/v1/workbench/turns");
  });

  test("5.4 403 ACCESS_CHANGED purges open card and refreshes capabilities", async ({
    page,
  }) => {
    await loginAsPersona(page, "operator");

    let proposalFetchCount = 0;
    let capabilitiesRefreshed = false;

    await page.route("**/v1/workbench/capabilities", async (route) => {
      capabilitiesRefreshed = true;
      await route.continue();
    });

    await page.route("**/v1/proposals/MOCK-ACCESS-CHG", async (route) => {
      proposalFetchCount += 1;
      if (proposalFetchCount === 1) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: { "Cache-Control": "no-store" },
          body: JSON.stringify({
            tenant: "harbour",
            id: "MOCK-ACCESS-CHG",
            warehouse: "HK01",
            requester: "operator",
            approver: null,
            digest: "a".repeat(64),
            plan: {
              tenant: "harbour",
              warehouse: "HK01",
              action: "shipment.reschedule",
              target: "SHP-SENSITIVE-SECRET-777",
              expected_version: 1,
              before: { delivery_date: "2026-12-01" },
              after: { delivery_date: "2026-12-10" },
            },
            state: "PROPOSED",
            epoch: 1,
            checks: 0,
            due: Math.floor(Date.now() / 1000) + 600,
            expires: Math.floor(Date.now() / 1000) + 900,
            receipt: null,
            events: [],
            review: null,
          }),
        });
        return;
      }

      await route.fulfill({
        status: 403,
        contentType: "application/json",
        headers: { "Cache-Control": "no-store" },
        body: JSON.stringify({ detail: { code: "ACCESS_CHANGED" } }),
      });
    });

    await page.goto("/proposals/MOCK-ACCESS-CHG", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("SHP-SENSITIVE-SECRET-777").first()).toBeVisible({
      timeout: 15_000,
    });

    capabilitiesRefreshed = false;
    await page.reload({ waitUntil: "domcontentloaded" });

    // Open card sensitive target must be purged and ACCESS_CHANGED banner shown
    await expect(page.getByText(/访问权限已变更/).first()).toBeVisible({
      timeout: 15_000,
    });
    const textAfterRevoke = await page.locator("body").innerText();
    expect(textAfterRevoke).not.toContain("SHP-SENSITIVE-SECRET-777");
    expect(capabilitiesRefreshed).toBe(true);

    await page.unroute("**/v1/proposals/MOCK-ACCESS-CHG");
    await page.unroute("**/v1/workbench/capabilities");
  });

  test("5.5 404 uniform copy, 409 conflict reload, 422 inline errors, 429/503 Retry-After & OUTCOME_UNKNOWN", async ({
    page,
  }) => {
    await loginAsPersona(page, "operator");

    // ── 5.5a 404 uniform non-existence copy ──
    await page.goto("/proposals/NON-EXISTENT-999999", {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByText("当前账号无法访问这条记录。").first()).toBeVisible({
      timeout: 15_000,
    });

    // ── 5.5b 409 Conflict reloads fresh snapshot (via /settings/profile PATCH) ──
    await page.goto("/settings/profile", { waitUntil: "domcontentloaded" });
    let patch409Injected = false;
    let profileReloadCount = 0;

    await page.route("**/v1/profile", async (route) => {
      if (route.request().method() === "PATCH" && !patch409Injected) {
        patch409Injected = true;
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          headers: { "Cache-Control": "no-store" },
          body: JSON.stringify({ detail: "Profile version changed" }),
        });
        return;
      }
      if (route.request().method() === "GET" && patch409Injected) {
        profileReloadCount += 1;
      }
      await route.continue();
    });

    const profileInput = page.getByTestId("profile-display-name-input");
    await expect(profileInput).toBeVisible({ timeout: 15_000 });
    await profileInput.fill("冲突测试名称");
    const profileSaveBtn = page.getByTestId("profile-save-btn");
    await profileSaveBtn.click();

    await expect(page.getByTestId("profile-conflict-banner")).toBeVisible({
      timeout: 12_000,
    });
    expect(patch409Injected).toBe(true);
    await page.waitForTimeout(300);
    expect(profileReloadCount).toBeGreaterThanOrEqual(1);
    await page.unroute("**/v1/profile");

    // ── 5.5c 422 inline validation error on structured order form ──
    await page.goto("/orders/new", { waitUntil: "domcontentloaded" });
    await page.route("**/v1/intakes/*/structured", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 422,
          contentType: "application/json",
          headers: { "Cache-Control": "no-store" },
          body: JSON.stringify({
            detail: [
              {
                loc: ["body", "po"],
                msg: "采购单号格式不符合要求",
                type: "string_pattern_mismatch",
              },
            ],
          }),
        });
        return;
      }
      await route.continue();
    });

    const prefillBtn = page.getByTestId("orders-prefill-demo-btn");
    await expect(prefillBtn).toBeVisible({ timeout: 15_000 });
    await prefillBtn.click();
    const submitBtn = page.getByTestId("orders-submit-intake-btn");
    await expect(submitBtn).toBeVisible();
    await submitBtn.click();
    await expect(
      page.getByText(/采购单号格式不符合要求|输入格式不符合要求/).first(),
    ).toBeVisible({ timeout: 12_000 });
    await page.unroute("**/v1/intakes/*/structured");

    // ── 5.5d 429 & 503 respect Retry-After without infinite retry loops ──
    await page.goto("/inbox/assistant", { waitUntil: "domcontentloaded" });
    let rateLimitedCalls = 0;
    await page.route("**/v1/workbench/turns", async (route) => {
      if (route.request().method() === "POST") {
        rateLimitedCalls += 1;
        await route.fulfill({
          status: 429,
          contentType: "application/json",
          headers: {
            "Cache-Control": "no-store",
            "Retry-After": "12",
          },
          body: JSON.stringify({ detail: "Tenant planner budget exhausted" }),
        });
        return;
      }
      await route.continue();
    });

    const composer = page.getByTestId("assistant-composer-input");
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.fill("查看运单 SHP-1001 仓库 HK01");
    const sendBtn = page.getByTestId("assistant-send-btn");
    await sendBtn.click();

    await expect(page.getByText(/额度|Retry-After|稍后|等待|频繁/).first()).toBeVisible({
      timeout: 12_000,
    });
    await page.waitForTimeout(1500);
    expect(rateLimitedCalls, "429 must NOT trigger an infinite retry loop").toBeLessThanOrEqual(
      2,
    );
    await page.unroute("**/v1/workbench/turns");

    // Verify 503 Retry-After behavior similarly
    let unavailableCalls = 0;
    await page.route("**/v1/workbench/turns", async (route) => {
      if (route.request().method() === "POST") {
        unavailableCalls += 1;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          headers: {
            "Cache-Control": "no-store",
            "Retry-After": "4",
          },
          body: JSON.stringify({
            detail: { code: "STORAGE_UNAVAILABLE", message: "服务暂不可用，请稍后重试。" },
          }),
        });
        return;
      }
      await route.continue();
    });
    await composer.fill("查看运单 SHP-1001 仓库 HK01");
    await sendBtn.click();
    await expect(page.getByText(/暂不可用|繁忙|稍后重试|Retry-After/).first()).toBeVisible({
      timeout: 12_000,
    });
    await page.waitForTimeout(1200);
    expect(unavailableCalls, "503 must NOT trigger an infinite retry loop").toBeLessThanOrEqual(
      2,
    );
    await page.unroute("**/v1/workbench/turns");

    // ── 5.5e OUTCOME_UNKNOWN displays receipt-check guidance ──
    await page.route("**/v1/proposals/MOCK-UNKNOWN-01", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "Cache-Control": "no-store" },
        body: JSON.stringify({
          tenant: "harbour",
          id: "MOCK-UNKNOWN-01",
          warehouse: "HK01",
          requester: "operator",
          approver: "manager",
          digest: "b".repeat(64),
          plan: {
            tenant: "harbour",
            warehouse: "HK01",
            action: "sales_order.create_draft",
            target: "HK01:HBR-47:FE-UNK-01",
            expected_version: null,
            before: { intake_id: "INT-UNK-01", source_sha256: "c".repeat(64) },
            after: {
              po: "FE-UNK-01",
              buyer: "HBR-47",
              currency: "HKD",
              legal_entity: "HK01",
              delivery: "2026-12-15",
              total: "50.00",
              items: [
                {
                  sku: "SKU-1028",
                  source_sku: "TEA-24",
                  source_quantity: 2,
                  source_uom: "CASE",
                  erp_quantity: 48,
                  erp_uom: "EACH",
                  line_total: "50.00",
                },
              ],
            },
          },
          state: "OUTCOME_UNKNOWN",
          epoch: 1,
          checks: 2,
          due: Math.floor(Date.now() / 1000) + 600,
          expires: Math.floor(Date.now() / 1000) + 900,
          receipt: null,
          events: [
            {
              subject: "worker",
              event: "OUTCOME_UNKNOWN",
              at: Math.floor(Date.now() / 1000) - 30,
            },
          ],
          review: null,
        }),
      });
    });

    await page.goto("/proposals/MOCK-UNKNOWN-01", { waitUntil: "domcontentloaded" });
    await expect(page.getByText(/结果待确认|OUTCOME_UNKNOWN/).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("proposal-outcome-guidance")).toBeVisible();
    await page.unroute("**/v1/proposals/MOCK-UNKNOWN-01");
  });
});
