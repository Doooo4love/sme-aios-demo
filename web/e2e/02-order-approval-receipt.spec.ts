import { expect, test } from "@playwright/test";
import {
  attachRuntimeAudit,
  bffRequest,
  loginAsPersona,
  saveEvidenceScreenshot,
  switchPersona,
  uniqueSuffix,
} from "./helpers/workbench";

test.describe("Phase 2: Structured Order -> Self-Approval Block -> Manager Approval -> Admin Worker Tick -> ERP Receipt", () => {
  test("2.1 Full order lifecycle from HK01 structured intake to VERIFIED ERP receipt", async ({
    page,
  }) => {
    const audit = attachRuntimeAudit(page);
    const suffix = uniqueSuffix();
    const poNumber = `FE-DEMO-001-${suffix}`;

    try {
      // ── Step 1: Operator submits structured order FE-DEMO-001 in HK01 & prepares proposal ──
      await loginAsPersona(page, "operator");
      audit.clearExpectedLoginProbeNoise();
      await page.goto("/orders/new", { waitUntil: "domcontentloaded" });

      // Use one-click FE-DEMO-001 prefill, then set unique PO suffix
      const prefillBtn = page.getByTestId("orders-prefill-demo-btn");
      await expect(prefillBtn).toBeVisible({ timeout: 15_000 });
      await prefillBtn.click();

      const poInput = page.getByTestId("orders-input-po");
      await expect(poInput).toBeVisible({ timeout: 15_000 });
      await poInput.fill(poNumber);

      // Step 1: Submit structured intake
      const submitIntakeBtn = page.getByTestId("orders-submit-intake-btn");
      await expect(submitIntakeBtn).toBeVisible();

      const intakeRespPromise = page.waitForResponse(
        (res) =>
          /\/v1\/intakes\/HK01\/structured$/.test(new URL(res.url()).pathname) &&
          res.request().method() === "POST",
      );
      await submitIntakeBtn.click();
      const intakeResp = await intakeRespPromise;
      expect(intakeResp.status()).toBe(201);

      // Step 2: Prepare formal proposal via `order.draft.prepare`
      const prepareBtn = page.getByTestId("orders-prepare-proposal-btn");
      await expect(prepareBtn).toBeVisible({ timeout: 15_000 });

      const callRespPromise = page.waitForResponse(
        (res) =>
          new URL(res.url()).pathname === "/v1/workbench/calls" &&
          res.request().method() === "POST",
      );
      await prepareBtn.click();
      const callResp = await callRespPromise;
      expect(callResp.status()).toBe(200);
      const callJson = (await callResp.json()) as {
        kind: string;
        proposal?: { id: string; digest: string; state: string };
      };
      expect(callJson.kind).toBe("proposal");
      const proposalId = callJson.proposal?.id ?? "";
      const proposalDigest = callJson.proposal?.digest ?? "";

      await expect(page.getByTestId("orders-created-proposal-card")).toBeVisible({
        timeout: 12_000,
      });

      expect(proposalId, "Proposal ID must be created").toBeTruthy();
      expect(proposalDigest, "Proposal digest must be 64-char hex").toMatch(
        /^[0-9a-f]{64}$/,
      );

      // Navigate to proposal detail as operator and confirm PROPOSED status
      await page.goto(`/proposals/${encodeURIComponent(proposalId)}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(page.getByTestId("proposal-id-value")).toContainText(
        proposalId,
        { timeout: 15_000 },
      );
      await expect(page.getByText(/待审批|已生成提案/).first()).toBeVisible();
      await saveEvidenceScreenshot(page, "03-proposal-detail-operator.png");

      // ── Step 2: Operator attempts self-approval -> rejected with 403 ACTION_NOT_ALLOWED while staying viewable ──
      const selfTurnRes = await bffRequest<{ detail?: { code?: string; next_step?: string } }>(
        page,
        "/v1/workbench/turns",
        {
          method: "POST",
          body: { text: `approve proposal ${proposalId}` },
        },
      );
      expect(selfTurnRes.status).toBe(403);
      expect(selfTurnRes.body.detail?.code).toBe("ACTION_NOT_ALLOWED");
      expect(selfTurnRes.body.detail?.next_step).toBe("view_proposal");

      const selfApproveRes = await bffRequest(
        page,
        `/v1/proposals/${encodeURIComponent(proposalId)}/approve`,
        {
          method: "POST",
          body: { digest: proposalDigest },
        },
      );
      expect(selfApproveRes.status).toBe(403);

      // Clear ONLY the two expected Chromium resource-status logs from the deliberate self-approval 403 assertions above
      for (let i = audit.consoleErrors.length - 1; i >= 0; i -= 1) {
        if (
          audit.consoleErrors[i] ===
          "Failed to load resource: the server responded with a status of 403 (Forbidden)"
        ) {
          audit.consoleErrors.splice(i, 1);
        }
      }

      // Proposal remains viewable read-only by operator
      const operatorReadBack = await bffRequest<{ state: string }>(
        page,
        `/v1/proposals/${encodeURIComponent(proposalId)}`,
      );
      expect(operatorReadBack.status).toBe(200);
      expect(operatorReadBack.body.state).toBe("PROPOSED");

      // ── Step 3: Switch to manager -> approval queue -> verify digest, qty, unit, diff -> explicit confirm -> 202 QUEUED ──
      await switchPersona(page, "manager");
      await page.goto("/work", { waitUntil: "domcontentloaded" });

      // Ensure proposal appears in manager's approval queue / assigned tasks
      const approvalsRes = await bffRequest<{
        items: Array<{ id: string; warehouse: string; state: string }>;
      }>(page, "/v1/workbench/approvals?limit=50");
      expect(approvalsRes.status).toBe(200);
      expect(
        approvalsRes.body.items.some((item) => item.id === proposalId),
        `Manager approvals queue should include ${proposalId}`,
      ).toBe(true);

      // Open Approvals module in /work and confirm proposal appears
      const approvalsTab = page.getByTestId("work-tab-approvals");
      await expect(approvalsTab).toBeVisible({ timeout: 15_000 });
      await approvalsTab.click();
      await expect(
        page.getByTestId(`approval-open-link-${proposalId}`),
      ).toBeVisible({ timeout: 15_000 });

      // Open the SAME proposal detail page
      await page.getByTestId(`approval-open-link-${proposalId}`).click();
      await expect(page).toHaveURL(
        new RegExp(`/proposals/${encodeURIComponent(proposalId)}`),
      );
      await expect(page.getByTestId("proposal-id-value")).toContainText(proposalId, {
        timeout: 15_000,
      });

      // Verify digest, quantity (2 CASE -> 48 EACH), unit, and PO diff are displayed
      const shortDigestPrefix = proposalDigest.slice(0, 8);
      await expect(page.getByTestId("proposal-digest-value")).toContainText(
        new RegExp(shortDigestPrefix, "i"),
      );
      await expect(page.getByTestId("proposal-diff-view")).toBeVisible();
      await expect(page.getByText(poNumber).first()).toBeVisible();
      await expect(page.getByText(/48|EACH|CASE/).first()).toBeVisible();

      await saveEvidenceScreenshot(page, "04-manager-approval-diff.png");

      // Click Approve and explicitly confirm inside ConfirmDialog
      const approveBtn = page.getByTestId("proposal-approve-btn");
      await expect(approveBtn).toBeVisible();
      await approveBtn.click();

      const confirmDialog = page.getByRole("alertdialog");
      await expect(confirmDialog).toBeVisible({ timeout: 10_000 });
      await expect(confirmDialog).toContainText(
        new RegExp(`${proposalId}|${shortDigestPrefix}`, "i"),
      );

      const approveApiPromise = page.waitForResponse(
        (res) =>
          new URL(res.url()).pathname ===
            `/v1/proposals/${encodeURIComponent(proposalId)}/approve` &&
          res.request().method() === "POST",
      );
      const confirmSubmitBtn = confirmDialog
        .getByTestId("confirm-dialog-submit")
        .or(confirmDialog.getByRole("button", { name: /确认批准|确认|批准|提交/ }).last());
      await confirmSubmitBtn.click();

      const approveApiResp = await approveApiPromise;
      expect(approveApiResp.status()).toBe(202);

      await expect(page.getByText(/已批准|等待执行|待派发|QUEUED/).first()).toBeVisible({
        timeout: 12_000,
      });

      // Verify re-submitting approve does not duplicate or double-apply
      const duplicateApproveRes = await bffRequest<{ id: string; state: string }>(
        page,
        `/v1/proposals/${encodeURIComponent(proposalId)}/approve`,
        {
          method: "POST",
          body: { digest: proposalDigest },
        },
      );
      expect([202, 409]).toContain(duplicateApproveRes.status);
      const afterDupCheck = await bffRequest<{ id: string; state: string }>(
        page,
        `/v1/proposals/${encodeURIComponent(proposalId)}`,
      );
      expect(afterDupCheck.status).toBe(200);
      expect(afterDupCheck.body.id).toBe(proposalId);
      expect(["QUEUED", "SENDING", "VERIFYING", "CHECKING", "VERIFIED"]).toContain(
        afterDupCheck.body.state,
      );

      // ── Step 4: Switch to admin -> /admin verifies /healthz, /readyz, summary -> worker-tick until VERIFIED ──
      await switchPersona(page, "admin");
      await page.goto("/admin", { waitUntil: "domcontentloaded" });

      // Confirm /healthz, /readyz, and /v1/operations/summary respond cleanly
      const [healthRes, readyRes, summaryRes] = await Promise.all([
        bffRequest<{ status: string }>(page, "/healthz"),
        bffRequest<{ status: string }>(page, "/readyz"),
        bffRequest<{ proposals_by_state: Record<string, number>; writes_paused: boolean }>(
          page,
          "/v1/operations/summary",
        ),
      ]);
      expect(healthRes.status).toBe(200);
      expect(healthRes.body.status).toBe("up");
      expect(readyRes.status).toBe(200);
      expect(readyRes.body.status).toBe("ready");
      expect(summaryRes.status).toBe(200);

      await expect(page.getByTestId("probe-healthz")).toContainText(/up/i, {
        timeout: 12_000,
      });
      await expect(page.getByTestId("probe-readyz")).toContainText(/ready/i, {
        timeout: 12_000,
      });
      await expect(page.getByTestId("proposals-state-grid")).toBeVisible({
        timeout: 12_000,
      });

      await saveEvidenceScreenshot(page, "05-admin-ops-monitor.png");

      // Click worker-tick button on /admin until proposal reaches VERIFIED
      const workerTickBtn = page.getByTestId("worker-tick-btn");
      await expect(workerTickBtn).toBeVisible({ timeout: 15_000 });

      interface FinalProposalSnapshot {
        state: string;
        receipt: {
          tenant: string;
          operation_id: string;
          plan_digest: string;
          target: string;
          remote_id: string;
        } | null;
      }

      let finalProposal: FinalProposalSnapshot | null = null;

      for (let step = 0; step < 8; step += 1) {
        const tickPromise = page.waitForResponse(
          (res) =>
            new URL(res.url()).pathname === "/v1/demo/worker-tick" &&
            res.request().method() === "POST",
        );
        await workerTickBtn.click();
        const tickResp = await tickPromise;
        expect(tickResp.status()).toBe(200);

        const checkRes = await bffRequest<FinalProposalSnapshot>(
          page,
          `/v1/proposals/${encodeURIComponent(proposalId)}`,
        );
        expect(checkRes.status).toBe(200);
        finalProposal = checkRes.body;
        if (finalProposal.state === "VERIFIED") {
          break;
        }
      }

      expect(finalProposal?.state, "Proposal must settle to VERIFIED").toBe(
        "VERIFIED",
      );
      expect(finalProposal?.receipt, "ERP receipt must be populated").not.toBeNull();
      expect(finalProposal?.receipt?.remote_id).toBeTruthy();
      expect(finalProposal?.receipt?.plan_digest).toBe(proposalDigest);

      // Re-open proposal page and confirm VERIFIED + real ERP receipt rendered in UI
      await page.goto(`/proposals/${encodeURIComponent(proposalId)}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(page.getByText(/已核验入账|已写入.*已核对|VERIFIED/).first()).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByTestId("proposal-receipt-card")).toBeVisible();
      await expect(page.getByTestId("proposal-receipt-remote-id")).toContainText(
        finalProposal!.receipt!.remote_id,
      );

      await saveEvidenceScreenshot(page, "06-proposal-verified-receipt.png");

      expect(audit.consoleErrors).toEqual([]);
      expect(audit.pageErrors).toEqual([]);
      expect(audit.apiViolations).toEqual([]);
    } finally {
      audit.dispose();
    }
  });
});
