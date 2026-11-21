import { expect, test } from "@playwright/test";
import {
  attachRuntimeAudit,
  bffRequest,
  createStructuredOrderProposalViaBff,
  loginAsPersona,
  saveEvidenceScreenshot,
  switchPersona,
  uniqueSuffix,
} from "./helpers/workbench";

test.describe("Phase 3: Employee Module Access Lifecycle, Cross-Warehouse & Cross-Tenant Isolation", () => {
  test("3.1 Grant -> Query -> Cross-WH/Cross-Tenant Isolation -> Revoke -> Pending-Dispatch Revocation", async ({
    page,
  }) => {
    const audit = attachRuntimeAudit(page);
    const suffix = uniqueSuffix();
    let operatorOrdersRevoked = false;

    try {
      // ── Step 1: Sign in as operator once (registers operator in aios_employee) and create a Harbour HK01 proposal ──
      await loginAsPersona(page, "operator");
      const harbourOrder = await createStructuredOrderProposalViaBff(
        page,
        `FE-ISO-${suffix}`,
        "HK01",
      );

      // ── Step 2: Verify regular ops `admin` CANNOT access /admin/people (workbench.access.manage gate) ──
      await switchPersona(page, "admin");
      await page.goto("/admin", { waitUntil: "domcontentloaded" });
      const adminNav = page.getByRole("navigation", { name: "主导航" });
      await expect(adminNav).toBeVisible({ timeout: 15_000 });
      await expect(adminNav.locator('a[href="/admin/people"]')).toHaveCount(0);

      await page.goto("/admin/people", { waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("people-access-denied")).toBeVisible({
        timeout: 15_000,
      });

      const adminCatalogCheck = await bffRequest(
        page,
        "/v1/workbench/module-access/catalog",
      );
      expect(adminCatalogCheck.status).toBe(403);

      // ── Step 3: Switch to `access-admin` -> /admin/people -> grant operator HK01 `发票审阅` (finance.read) ──
      await switchPersona(page, "access-admin");
      await page.goto("/admin/people", { waitUntil: "domcontentloaded" });

      const operatorOpenLink = page.getByTestId("employee-open-operator");
      await expect(operatorOpenLink).toBeVisible({ timeout: 15_000 });
      await operatorOpenLink.click();
      await expect(page).toHaveURL(/\/admin\/people\/operator$/);

      // Inspect current assignment for invoice-review so version matches live state
      const empBefore = await bffRequest<{
        assignments: Record<
          string,
          { version: number; grants: string[]; warehouses: string[] }
        >;
      }>(page, "/v1/workbench/module-access/employees/operator");
      expect(empBefore.status).toBe(200);

      // Locate invoice-review module card in UI
      const invoiceCard = page.getByTestId("module-card-invoice-review");
      await expect(invoiceCard).toBeVisible({ timeout: 15_000 });

      // Ensure finance.read grant and HK01 warehouse checkboxes are checked
      const financeGrantBox = page.getByTestId(
        "grant-checkbox-invoice-review-finance.read",
      );
      await expect(financeGrantBox).toBeVisible();
      if (!(await financeGrantBox.isChecked())) {
        await financeGrantBox.check();
      }

      const hk01WarehouseBox = page.getByTestId(
        "warehouse-checkbox-invoice-review-HK01",
      );
      await expect(hk01WarehouseBox).toBeVisible();
      if (!(await hk01WarehouseBox.isChecked())) {
        await hk01WarehouseBox.check();
      }

      const saveInvoiceBtn = page.getByTestId("module-save-invoice-review");
      const grantPutPromise = page.waitForResponse(
        (res) =>
          new URL(res.url()).pathname ===
            "/v1/workbench/module-access/employees/operator/invoice-review" &&
          res.request().method() === "PUT",
      );
      await saveInvoiceBtn.click();
      const grantPutResp = await grantPutPromise;
      expect(grantPutResp.status()).toBe(200);

      // Allow 150ms pill/checkbox color transition to settle before evidence capture
      await page.waitForTimeout(300);
      await saveEvidenceScreenshot(page, "07-admin-people-access.png");

      // ── Step 4: Switch to `operator` -> /inbox/assistant queries INV-100 in HK01 -> succeeds ──
      await switchPersona(page, "operator");
      await page.goto("/inbox/assistant", { waitUntil: "domcontentloaded" });

      const composer = page.getByTestId("assistant-composer-input");
      await expect(composer).toBeVisible({ timeout: 15_000 });

      await composer.fill("查看发票 INV-100 仓库 HK01");
      const sendBtn = page.getByTestId("assistant-send-btn");

      const turnPromise = page.waitForResponse(
        (res) =>
          new URL(res.url()).pathname === "/v1/workbench/turns" &&
          res.request().method() === "POST",
      );
      await sendBtn.click();
      const turnResp = await turnPromise;
      expect(turnResp.status()).toBe(200);
      const turnJson = (await turnResp.json()) as {
        kind: string;
        tool?: string;
        data?: { invoice_id?: string; amount?: string };
      };
      expect(turnJson.kind).toBe("result");
      expect(turnJson.tool).toBe("finance.invoice.read");
      expect(turnJson.data?.invoice_id).toBe("INV-100");
      expect(turnJson.data?.amount).toBe("804.00");

      await expect(page.getByText("INV-100").first()).toBeVisible({ timeout: 12_000 });
      await expect(page.getByText("804.00").first()).toBeVisible();

      // Record latest history item ID for post-revocation reload check
      const historyBefore = await bffRequest<{
        items: Array<{ id: string; started_at: number }>;
      }>(page, "/v1/workbench/history?limit=10");
      expect(historyBefore.status).toBe(200);
      const latestHistoryId = historyBefore.body.items[0]?.id ?? "";

      // ── Step 5: Switch to `other-manager` (same tenant harbour, HK02 only) -> cross-warehouse restriction ──
      await switchPersona(page, "other-manager");
      const otherMe = await bffRequest<{ tenant: string; warehouses: string[] }>(
        page,
        "/v1/me",
      );
      expect(otherMe.body.tenant).toBe("harbour");
      expect(otherMe.body.warehouses).toEqual(["HK02"]);

      // Opening HK01 proposal deep-link shows uniform 404 RECORD_UNAVAILABLE
      await page.goto(`/proposals/${encodeURIComponent(harbourOrder.proposalId)}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(page.getByText("当前账号无法访问这条记录。").first()).toBeVisible({
        timeout: 15_000,
      });

      // HK01 tool call is denied (403), while HK02 SHP-2001 succeeds (200)
      const hk01CallDenied = await bffRequest(page, "/v1/workbench/calls", {
        method: "POST",
        body: { tool: "shipment.read", warehouse: "HK01", shipment_id: "SHP-1001" },
      });
      expect(hk01CallDenied.status).toBe(403);

      const hk02CallOk = await bffRequest<{ kind: string; data: { shipment_id: string } }>(
        page,
        "/v1/workbench/calls",
        {
          method: "POST",
          body: { tool: "shipment.read", warehouse: "HK02", shipment_id: "SHP-2001" },
        },
      );
      expect(hk02CallOk.status).toBe(200);
      expect(hk02CallOk.body.data.shipment_id).toBe("SHP-2001");

      // ── Step 6: Switch to `island-manager` (second tenant island) -> Harbour deep-link uniform 404 zero existence leak ──
      await switchPersona(page, "island-manager");
      // Navigate away from the previous proposal page first so waitForResponse captures the fresh deep-link request cleanly
      await page.goto("/work", { waitUntil: "domcontentloaded" });
      const islandDeepLinkRespPromise = page.waitForResponse(
        (res) =>
          new URL(res.url()).pathname ===
          `/v1/proposals/${encodeURIComponent(harbourOrder.proposalId)}`,
      );
      await page.goto(`/proposals/${encodeURIComponent(harbourOrder.proposalId)}`, {
        waitUntil: "domcontentloaded",
      });
      const islandDeepLinkResp = await islandDeepLinkRespPromise;
      expect(islandDeepLinkResp.status()).toBe(404);
      const islandErrJson = (await islandDeepLinkResp.json()) as {
        detail?: { code?: string; message?: string };
      };
      expect(islandErrJson.detail?.code).toBe("RECORD_UNAVAILABLE");

      await expect(page.getByText("当前账号无法访问这条记录。").first()).toBeVisible({
        timeout: 15_000,
      });
      const islandBodyText = await page.locator("body").innerText();
      expect(islandBodyText).not.toContain(`FE-ISO-${suffix}`);
      expect(islandBodyText).not.toContain("HBR-47");

      // ── Step 7: Switch to `access-admin` -> revoke operator's invoice-review access ──
      await switchPersona(page, "access-admin");
      await page.goto("/admin/people/operator", { waitUntil: "domcontentloaded" });

      const revokeBtn = page.getByTestId("module-revoke-invoice-review");
      await expect(revokeBtn).toBeVisible({ timeout: 15_000 });
      await revokeBtn.click();

      const revokeDialog = page.getByTestId("revoke-confirm-dialog");
      await expect(revokeDialog).toBeVisible({ timeout: 10_000 });
      const revokePutPromise = page.waitForResponse(
        (res) =>
          new URL(res.url()).pathname ===
            "/v1/workbench/module-access/employees/operator/invoice-review" &&
          res.request().method() === "PUT",
      );
      await page.getByTestId("confirm-dialog-submit").click();
      const revokePutResp = await revokePutPromise;
      expect(revokePutResp.status()).toBe(200);

      // ── Step 8: Switch back to `operator` -> old history card, new query, and direct tool call ALL fail ──
      await switchPersona(page, "operator");
      await page.goto("/inbox/assistant", { waitUntil: "domcontentloaded" });

      // 8a. Reloading old Agent history record via v2 `+ 添加上下文` -> `context-menu-history` AND BFF fails cleanly (404 RECORD_UNAVAILABLE or 403 ACCESS_CHANGED)
      if (latestHistoryId) {
        const addCtxBtn = page.getByTestId("assistant-add-context-btn");
        await expect(addCtxBtn).toBeVisible({ timeout: 15_000 });
        await addCtxBtn.click();
        const historyMenuBtn = page.getByTestId("context-menu-history");
        await expect(historyMenuBtn).toBeVisible({ timeout: 10_000 });
        await historyMenuBtn.click();

        await expect(page.getByTestId("assistant-history-section")).toBeVisible({
          timeout: 12_000,
        });
        const expandBtn = page.getByTestId(`history-expand-${latestHistoryId}`);
        await expect(expandBtn).toBeVisible({ timeout: 12_000 });
        await expandBtn.click();
        await expect(
          page.getByText(/当前账号无法访问这条记录。|访问权限已变更/).first(),
        ).toBeVisible({ timeout: 12_000 });

        // Close frosted History Verification Modal cleanly before continuing to composer
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("assistant-history-section")).toBeHidden({
          timeout: 8_000,
        });

        const oldHistRes = await bffRequest<{ detail?: { code?: string } }>(
          page,
          `/v1/workbench/history/${encodeURIComponent(latestHistoryId)}`,
        );
        expect([403, 404]).toContain(oldHistRes.status);
        expect(JSON.stringify(oldHistRes.body)).not.toContain("804.00");
      }

      // 8b. New natural-language query in assistant fails cleanly
      const composerAfterRevoke = page.getByTestId("assistant-composer-input");
      await expect(composerAfterRevoke).toBeVisible({ timeout: 15_000 });
      await composerAfterRevoke.fill("Show invoice INV-100 in HK01");
      const sendAfterRevoke = page.getByTestId("assistant-send-btn");

      const deniedTurnPromise = page.waitForResponse(
        (res) =>
          new URL(res.url()).pathname === "/v1/workbench/turns" &&
          res.request().method() === "POST",
      );
      await sendAfterRevoke.click();
      const deniedTurnResp = await deniedTurnPromise;
      expect(deniedTurnResp.status()).toBe(403);
      await expect(page.getByText(/无权|访问范围受限|访问权限已变更/).first()).toBeVisible({
        timeout: 12_000,
      });

      // 8c. Direct tool call fails with 403
      const directInvoiceCall = await bffRequest(page, "/v1/workbench/calls", {
        method: "POST",
        body: {
          tool: "finance.invoice.read",
          warehouse: "HK01",
          invoice_id: "INV-100",
        },
      });
      expect(directInvoiceCall.status).toBe(403);

      // ── Step 9: Pending-dispatch revocation check (separate proposal sample) ──
      const pendingOrder = await createStructuredOrderProposalViaBff(
        page,
        `FE-REV-${suffix}`,
        "HK01",
      );

      // Manager approves the proposal -> QUEUED
      await switchPersona(page, "manager");
      const mgrApprove = await bffRequest<{ state: string }>(
        page,
        `/v1/proposals/${encodeURIComponent(pendingOrder.proposalId)}/approve`,
        {
          method: "POST",
          body: { digest: pendingOrder.digest },
        },
      );
      expect(mgrApprove.status).toBe(202);
      expect(mgrApprove.body.state).toBe("QUEUED");

      // access-admin revokes operator's `orders` module before worker dispatches
      await switchPersona(page, "access-admin");
      const empOrdersConfig = await bffRequest<{
        assignments: Record<string, { version: number }>;
      }>(page, "/v1/workbench/module-access/employees/operator");
      const ordersVer = empOrdersConfig.body.assignments?.orders?.version ?? 0;

      const revokeOrdersRes = await bffRequest<{ version: number }>(
        page,
        "/v1/workbench/module-access/employees/operator/orders",
        {
          method: "PUT",
          body: {
            version: ordersVer,
            grants: [],
            warehouses: [],
            expires_at: null,
          },
        },
      );
      expect(revokeOrdersRes.status).toBe(200);
      operatorOrdersRevoked = true;

      // Admin ticks worker -> dispatch MUST be blocked (REJECTED, MODULE_ACCESS_REVOKED_BEFORE_SEND, receipt null)
      await switchPersona(page, "admin");
      let blockedState = "";
      let blockedEvents: Array<{ event: string }> = [];
      let blockedReceipt: unknown = "UNSET";

      for (let i = 0; i < 6; i += 1) {
        const tick = await bffRequest<{ worked: boolean }>(
          page,
          "/v1/demo/worker-tick",
          { method: "POST" },
        );
        expect(tick.status).toBe(200);

        const inspect = await bffRequest<{
          state: string;
          receipt: unknown;
          events: Array<{ event: string }>;
        }>(page, `/v1/proposals/${encodeURIComponent(pendingOrder.proposalId)}`);
        expect(inspect.status).toBe(200);
        blockedState = inspect.body.state;
        blockedEvents = inspect.body.events;
        blockedReceipt = inspect.body.receipt;
        if (blockedState !== "QUEUED" && blockedState !== "SENDING") {
          break;
        }
      }

      expect(blockedState).toBe("REJECTED");
      expect(blockedReceipt).toBeNull();
      expect(
        blockedEvents.some((e) => e.event === "MODULE_ACCESS_REVOKED_BEFORE_SEND"),
        `Expected MODULE_ACCESS_REVOKED_BEFORE_SEND in ${JSON.stringify(blockedEvents)}`,
      ).toBe(true);

      expect(audit.apiViolations).toEqual([]);
    } finally {
      // Restore operator's `orders` module so shared SQLite state stays clean for subsequent tests
      if (operatorOrdersRevoked) {
        try {
          await switchPersona(page, "access-admin");
          const currentCfg = await bffRequest<{
            assignments: Record<string, { version: number }>;
          }>(page, "/v1/workbench/module-access/employees/operator");
          const currentOrdersVer =
            currentCfg.body.assignments?.orders?.version ?? 0;
          await bffRequest(
            page,
            "/v1/workbench/module-access/employees/operator/orders",
            {
              method: "PUT",
              body: {
                version: currentOrdersVer,
                grants: ["order.read", "order.work"],
                warehouses: ["HK01"],
                expires_at: null,
              },
            },
          );
        } catch {
          // Best-effort cleanup
        }
      }
      audit.dispose();
    }
  });
});
