import { expect, test } from "@playwright/test";
import {
  attachRuntimeAudit,
  bffRequest,
  loginAsPersona,
  saveEvidenceScreenshot,
  switchPersona,
  uniqueSuffix,
} from "./helpers/workbench";

test.describe("Phase 4: Roles (Finance), Human Chat, Meeting Idempotency, Notices & Assurance PO-100", () => {
  test("4.1 Finance persona reads INV-100, is denied order write, and sees labeled synthetic contract card", async ({
    page,
  }) => {
    const audit = attachRuntimeAudit(page);
    try {
      await loginAsPersona(page, "finance");

      // 1. Finance reads INV-100 cleanly via real tool call
      const invRes = await bffRequest<{
        kind: string;
        source: string;
        data: { invoice_id: string; warehouse: string; amount: string; currency: string };
      }>(page, "/v1/workbench/calls", {
        method: "POST",
        body: {
          tool: "finance.invoice.read",
          warehouse: "HK01",
          invoice_id: "INV-100",
        },
      });
      expect(invRes.status).toBe(200);
      expect(invRes.body.kind).toBe("result");
      expect(invRes.body.data.invoice_id).toBe("INV-100");
      expect(invRes.body.data.amount).toBe("804.00");

      // 2. Finance order write is strictly denied (403)
      const orderWriteDenied = await bffRequest(
        page,
        "/v1/intakes/HK01/structured",
        {
          method: "POST",
          body: {
            po: "FIN-DENY-01",
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
      expect(orderWriteDenied.status).toBe(403);

      // 3. Open /work -> Finance module shows INV-100 lookup & clearly labeled synthetic contract card (`合成数据`)
      await page.goto("/work", { waitUntil: "domcontentloaded" });
      const financeTab = page.getByTestId("work-tab-finance");
      await expect(financeTab).toBeVisible({ timeout: 15_000 });
      await financeTab.click();
      const syntheticContractCard = page.getByTestId(
        "finance-synthetic-contract-card",
      );
      await expect(syntheticContractCard).toBeVisible({ timeout: 15_000 });
      await expect(syntheticContractCard).toContainText("合成数据");

      expect(audit.apiViolations).toEqual([]);
    } finally {
      audit.dispose();
    }
  });

  test("4.2 Real human chat room -> message persistence across reload -> meeting draft rapid double-click idempotency", async ({
    page,
  }) => {
    const audit = attachRuntimeAudit(page);
    const suffix = uniqueSuffix();
    const roomTitle = `联调房间-${suffix}`;
    const msgText = `HK01 发运窗口确认-${suffix}`;
    const meetingTitle = `HK01 排期对齐-${suffix}`;

    try {
      await loginAsPersona(page, "operator");
      audit.clearExpectedLoginProbeNoise();
      await page.goto("/inbox", { waitUntil: "domcontentloaded" });

      // 1. Create a real human chat room
      const newRoomBtn = page.getByTestId("inbox-create-room-btn");
      await expect(newRoomBtn).toBeVisible({ timeout: 15_000 });
      await newRoomBtn.click();

      const roomTitleInput = page.getByTestId("create-room-title-input");
      await expect(roomTitleInput).toBeVisible({ timeout: 10_000 });
      await roomTitleInput.fill(roomTitle);

      const createRoomRespPromise = page.waitForResponse(
        (res) =>
          new URL(res.url()).pathname === "/v1/chat/rooms" &&
          res.request().method() === "POST",
      );
      const createRoomSubmit = page.getByTestId("create-room-submit");
      await createRoomSubmit.click();
      const createRoomResp = await createRoomRespPromise;
      expect(createRoomResp.status()).toBe(201);
      const createdRoom = (await createRoomResp.json()) as { id: string; title: string };
      expect(createdRoom.id).toBeTruthy();

      // Navigate into the created room if not redirected automatically
      if (!page.url().includes(`/inbox/${createdRoom.id}`)) {
        await page.goto(`/inbox/${encodeURIComponent(createdRoom.id)}`, {
          waitUntil: "domcontentloaded",
        });
      }
      await expect(page).toHaveURL(new RegExp(`/inbox/${createdRoom.id}`));

      // 2. Send a real human message & verify reload persistence
      const roomComposer = page.getByTestId("room-composer-input");
      await expect(roomComposer).toBeVisible({ timeout: 15_000 });
      await roomComposer.fill(msgText);

      const postMsgPromise = page.waitForResponse(
        (res) =>
          new URL(res.url()).pathname ===
            `/v1/chat/rooms/${encodeURIComponent(createdRoom.id)}/messages` &&
          res.request().method() === "POST",
      );
      const sendMsgBtn = page.getByTestId("room-send-btn");
      await sendMsgBtn.click();
      const postMsgResp = await postMsgPromise;
      expect(postMsgResp.status()).toBe(201);

      await expect(page.getByText(msgText).first()).toBeVisible({ timeout: 12_000 });

      // Reload and verify real DB persistence
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.getByText(msgText).first()).toBeVisible({ timeout: 15_000 });

      // 3. Preview meeting draft and rapid double-click confirm -> creates ONLY ONE calendar event
      const openMeetingBtn = page.getByTestId("room-schedule-meeting-btn");
      await expect(openMeetingBtn).toBeVisible({ timeout: 12_000 });
      await openMeetingBtn.click();

      const titleField = page.getByTestId("room-meeting-title-input");
      await expect(titleField).toBeVisible({ timeout: 10_000 });
      await titleField.fill(meetingTitle);

      const confirmMeetingBtn = page.getByTestId("room-meeting-confirm-btn");
      await expect(confirmMeetingBtn).toBeVisible();

      const createEventPromise = page.waitForResponse(
        (res) =>
          new URL(res.url()).pathname === "/v1/calendar/events" &&
          res.request().method() === "POST",
      );

      // Rapid double-click confirm to test idempotency & in-flight disable guard
      await confirmMeetingBtn.dblclick();
      const createEventResp = await createEventPromise;
      expect(createEventResp.status()).toBe(201);

      // Query /v1/calendar/events over a 30-day window and confirm EXACTLY ONE event matches meetingTitle
      const startIso = new Date(Date.now() - 86_400_000).toISOString();
      const endIso = new Date(Date.now() + 30 * 86_400_000).toISOString();
      const calRes = await bffRequest<{
        items: Array<{ id: string; title: string }>;
      }>(
        page,
        `/v1/calendar/events?start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}&limit=100`,
      );
      expect(calRes.status).toBe(200);
      const matchingEvents = calRes.body.items.filter(
        (ev) => ev.title === meetingTitle,
      );
      expect(
        matchingEvents.length,
        `Rapid double-click must create exactly ONE calendar event for "${meetingTitle}"`,
      ).toBe(1);

      // Navigate to /calendar and verify event renders cleanly
      await page.goto("/calendar", { waitUntil: "domcontentloaded" });
      await expect(page.getByText(meetingTitle).first()).toBeVisible({
        timeout: 15_000,
      });

      expect(audit.apiViolations).toEqual([]);
    } finally {
      audit.dispose();
    }
  });

  test("4.3 Notices list loads without leaking unauthorized kind/reference previews", async ({
    page,
  }) => {
    await loginAsPersona(page, "operator");

    const noticesRes = await bffRequest<{
      items: Array<Record<string, unknown>>;
      next: unknown;
    }>(page, "/v1/workbench/notices?limit=50");
    expect(noticesRes.status).toBe(200);
    expect(Array.isArray(noticesRes.body.items)).toBe(true);

    // Per contract: list endpoint MUST NOT expose `kind`, `reference`, or sensitive body text
    for (const item of noticesRes.body.items) {
      expect(item).toHaveProperty("id");
      expect(item).toHaveProperty("created_at");
      expect(item).not.toHaveProperty("kind");
      expect(item).not.toHaveProperty("reference");
      expect(item).not.toHaveProperty("title");
    }

    // Open NoticesPopover in UI shell and ensure it renders without errors
    const noticesBtn = page
      .locator('button[aria-label*="通知"], button[title*="通知"]')
      .first();
    if ((await noticesBtn.count()) > 0 && (await noticesBtn.isVisible())) {
      await noticesBtn.click();
      await page.keyboard.press("Escape");
    }
  });

  test("4.4 Assurance PO-100 multi-track flow (auto-detects active Assurance vs graceful unavailable)", async ({
    page,
  }) => {
    const audit = attachRuntimeAudit(page);
    try {
      await loginAsPersona(page, "operator");
      audit.clearExpectedLoginProbeNoise();

      const probe = await bffRequest<{
        items?: Array<{ id: string; kind: string; site: string }>;
        detail?: { code?: string };
      }>(page, "/v1/assurance/cases?kind=purchase&limit=50");

      if (probe.status === 200) {
        // Assurance is ACTIVE on this backend process — verify complete PO-100 dual-track flow!
        expect(
          probe.body.items?.some((c) => c.id === "PO-100"),
          "PO-100 should be present in purchase assurance cases",
        ).toBe(true);

        // Open /work Assurance module to confirm UI rendering
        await page.goto("/work", { waitUntil: "domcontentloaded" });
        const assuranceTab = page.getByTestId("work-tab-assurance");
        await expect(assuranceTab).toBeVisible({ timeout: 15_000 });
        await assuranceTab.click();
        await expect(page.getByTestId("assurance-case-row-PO-100")).toBeVisible({
          timeout: 15_000,
        });
        await page.getByTestId("assurance-case-row-PO-100").click();
        await expect(page.getByTestId("assurance-detail-PO-100")).toBeVisible({
          timeout: 12_000,
        });
        await saveEvidenceScreenshot(page, "09-assurance-po100.png");

        // Initiate PO-100 review as operator with unique client_id
        const reviewClientId = `e2e_po100_${uniqueSuffix()}`;
        const createReviewRes = await bffRequest<{
          id: string;
          state: string;
          snapshot: string;
          tracks: string[];
          rule_findings: string[];
        }>(page, "/v1/assurance/cases/PO-100/reviews", {
          method: "POST",
          body: {
            client_id: reviewClientId,
            instruction: "precheck",
          },
        });
        expect(createReviewRes.status).toBe(201);
        expect(createReviewRes.body.state).toBe("PENDING");
        expect(createReviewRes.body.tracks).toEqual(
          expect.arrayContaining(["procurement", "finance"]),
        );
        expect(createReviewRes.body.rule_findings).toContain("FINANCE_THRESHOLD");

        const reviewId = createReviewRes.body.id;
        const snapshot = createReviewRes.body.snapshot;

        // Track 1: Switch to manager -> approve procurement track
        await switchPersona(page, "manager");
        const procDecision = await bffRequest<{
          state: string;
          decisions: Record<string, { actor: string; action: string }>;
        }>(page, `/v1/assurance/reviews/${encodeURIComponent(reviewId)}/decisions`, {
          method: "POST",
          body: {
            track: "procurement",
            action: "approve",
            snapshot,
          },
        });
        expect(procDecision.status).toBe(200);
        expect(procDecision.body.decisions.procurement?.actor).toBe("manager");
        expect(procDecision.body.state).toBe("PENDING");

        // Track 2: Switch to finance -> verify finance-scoped supplier_bank field & approve finance track -> APPROVED
        await switchPersona(page, "finance");
        const financeCaseRes = await bffRequest<{
          fields: Record<string, unknown>;
        }>(page, "/v1/assurance/cases/PO-100");
        expect(financeCaseRes.status).toBe(200);
        expect(financeCaseRes.body.fields.supplier_bank).toBe(
          "SYNTHETIC-BANK-ONLY",
        );

        const finDecision = await bffRequest<{
          state: string;
          decisions: Record<string, { actor: string; action: string }>;
        }>(page, `/v1/assurance/reviews/${encodeURIComponent(reviewId)}/decisions`, {
          method: "POST",
          body: {
            track: "finance",
            action: "approve",
            snapshot,
          },
        });
        expect(finDecision.status).toBe(200);
        expect(finDecision.body.decisions.finance?.actor).toBe("finance");
        expect(finDecision.body.state).toBe("APPROVED");
      } else {
        // Assurance is disabled on this backend process (e.g., single-process pydantic-ai mode)
        expect([404, 503]).toContain(probe.status);
        await page.goto("/work", { waitUntil: "domcontentloaded" });
        const assuranceTab = page.getByTestId("work-tab-assurance");
        if ((await assuranceTab.count()) > 0 && (await assuranceTab.isVisible())) {
          await assuranceTab.click();
          await expect(
            page.getByTestId("assurance-unavailable-notice"),
          ).toBeVisible({ timeout: 12_000 });
        }
      }

      expect(audit.consoleErrors).toEqual([]);
      expect(audit.pageErrors).toEqual([]);
      expect(audit.apiViolations).toEqual([]);
    } finally {
      audit.dispose();
    }
  });
});
