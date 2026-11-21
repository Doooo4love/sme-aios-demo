import { apiFetch, callWorkbenchTool } from "@/lib/api-client";
import type {
  ActionResponse,
  BatchIntakeResponse,
  ImageIntakeUploadResponse,
  IntakeDetail,
  PurchaseOrder,
  StructuredIntakeResponse,
  TurnResult,
} from "@/lib/types";

export function createStructuredIntake(
  warehouse: string,
  order: PurchaseOrder,
) {
  return apiFetch<StructuredIntakeResponse>(
    `/v1/intakes/${encodeURIComponent(warehouse)}/structured`,
    {
      method: "POST",
      body: order,
    },
  );
}

export function createStructuredBatchIntake(
  warehouse: string,
  orders: unknown[],
) {
  return apiFetch<BatchIntakeResponse>(
    `/v1/intakes/${encodeURIComponent(warehouse)}/structured/batch`,
    {
      method: "POST",
      body: { orders },
    },
  );
}

export function uploadImageIntake(warehouse: string, file: File | Blob) {
  return apiFetch<ImageIntakeUploadResponse>(
    `/v1/intakes/${encodeURIComponent(warehouse)}`,
    {
      method: "POST",
      rawBody: file,
      contentType: "application/octet-stream",
    },
  );
}

export function fetchIntakeDetail(intakeId: string, signal?: AbortSignal) {
  return apiFetch<IntakeDetail>(`/v1/intakes/${encodeURIComponent(intakeId)}`, {
    signal,
  });
}

export function prepareOrderDraft(
  warehouse: string,
  intakeId: string,
  idempotencyKey: string,
): Promise<TurnResult> {
  return callWorkbenchTool(
    {
      tool: "order.draft.prepare",
      warehouse,
      intake_id: intakeId,
    },
    { idempotencyKey },
  );
}

export function submitOrderOverridesAction(
  intakeId: string,
  overrides: Record<string, string>,
  idempotencyKey: string,
) {
  return apiFetch<ActionResponse>("/v1/actions", {
    method: "POST",
    body: {
      text: `create draft for intake ${intakeId}`,
      overrides,
    },
    idempotencyKey,
  });
}
