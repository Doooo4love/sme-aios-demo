import { apiFetch, isApiError, type ApiError } from "@/lib/api-client";
import type {
  AssuranceCheckpoint,
  ExceptionPage,
  OperationsSummary,
  Proposal,
} from "@/lib/types";

export interface HealthProbeResult {
  ok: boolean;
  status: string;
  httpStatus: number;
  message?: string;
  apiError?: ApiError;
  unreachable?: boolean;
  requestId?: string | null;
  checkedAt: number;
}

export async function fetchHealthz(
  signal?: AbortSignal,
): Promise<HealthProbeResult> {
  const checkedAt = Math.floor(Date.now() / 1000);
  try {
    const res = await apiFetch<{ status?: string }>("/healthz", {
      signal,
      suppressAuthReset: true,
    });
    const status = typeof res?.status === "string" ? res.status : "up";
    return {
      ok: status === "up",
      status,
      httpStatus: 200,
      checkedAt,
    };
  } catch (error) {
    if (isApiError(error)) {
      return {
        ok: false,
        status: "down",
        httpStatus: error.status,
        message: error.message,
        apiError: error,
        requestId: error.requestId,
        checkedAt,
      };
    }
    return {
      ok: false,
      status: "unreachable",
      httpStatus: 0,
      unreachable: true,
      checkedAt,
    };
  }
}

export async function fetchReadyz(
  signal?: AbortSignal,
): Promise<HealthProbeResult> {
  const checkedAt = Math.floor(Date.now() / 1000);
  try {
    const res = await apiFetch<{ status?: string }>("/readyz", {
      signal,
      suppressAuthReset: true,
    });
    const status = typeof res?.status === "string" ? res.status : "ready";
    return {
      ok: status === "ready",
      status,
      httpStatus: 200,
      checkedAt,
    };
  } catch (error) {
    if (isApiError(error)) {
      return {
        ok: false,
        status: error.status === 503 ? "unavailable" : "error",
        httpStatus: error.status,
        message: error.message,
        apiError: error,
        requestId: error.requestId,
        checkedAt,
      };
    }
    return {
      ok: false,
      status: "unreachable",
      httpStatus: 0,
      unreachable: true,
      checkedAt,
    };
  }
}

export function fetchOperationsSummary(signal?: AbortSignal) {
  return apiFetch<OperationsSummary>("/v1/operations/summary", { signal });
}

export function updateWriteControl(paused: boolean, signal?: AbortSignal) {
  return apiFetch<{ paused: boolean }>("/v1/operations/write-control", {
    method: "PUT",
    body: { paused },
    signal,
  });
}

export function runDemoWorkerTick(signal?: AbortSignal) {
  return apiFetch<{ worked: boolean }>("/v1/demo/worker-tick", {
    method: "POST",
    signal,
  });
}

export function updateSubjectSuspension(
  subject: string,
  suspended: boolean,
  signal?: AbortSignal,
) {
  return apiFetch<{ suspended: boolean }>(
    `/v1/operations/subjects/${encodeURIComponent(subject)}/suspension`,
    {
      method: "PUT",
      body: { suspended },
      signal,
    },
  );
}

export function fetchOperationsExceptions(
  params?: { limit?: number; after_due?: number; after_id?: string },
  signal?: AbortSignal,
) {
  const sp = new URLSearchParams();
  if (params?.limit !== undefined) {
    sp.set("limit", String(params.limit));
  }
  // Backend requires BOTH cursor values together (or neither), otherwise 422
  if (params?.after_due !== undefined && params?.after_id) {
    sp.set("after_due", String(params.after_due));
    sp.set("after_id", params.after_id);
  }
  const query = sp.toString();
  return apiFetch<ExceptionPage>(
    `/v1/operations/exceptions${query ? `?${query}` : ""}`,
    { signal },
  );
}

export function reconcileProposal(proposalId: string, signal?: AbortSignal) {
  return apiFetch<Proposal>(
    `/v1/proposals/${encodeURIComponent(proposalId)}/reconcile`,
    {
      method: "POST",
      signal,
    },
  );
}

export function fetchAssuranceAuditCheckpoint(signal?: AbortSignal) {
  return apiFetch<AssuranceCheckpoint>("/v1/assurance/audit/checkpoint", {
    signal,
  });
}
