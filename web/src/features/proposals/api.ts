import { apiFetch } from "@/lib/api-client";
import type {
  BatchApprovalResponse,
  IntakeDetail,
  Proposal,
} from "@/lib/types";

export interface ProposalReviewBody {
  digest: string;
  action: "return" | "reject" | "assign" | "release";
  reason?: string | null;
  assignee?: string | null;
}

export function fetchProposalDetail(id: string, signal?: AbortSignal) {
  return apiFetch<Proposal>(`/v1/proposals/${encodeURIComponent(id)}`, {
    signal,
  });
}

export function approveProposal(id: string, digest: string) {
  return apiFetch<Proposal>(
    `/v1/proposals/${encodeURIComponent(id)}/approve`,
    {
      method: "POST",
      body: { digest },
    },
  );
}

export function approveProposalsBatch(
  proposals: Array<{ proposal_id: string; digest: string }>,
) {
  return apiFetch<BatchApprovalResponse>("/v1/proposals/approve-batch", {
    method: "POST",
    body: { proposals },
  });
}

export function reviewProposal(id: string, body: ProposalReviewBody) {
  const payload: Record<string, unknown> = {
    digest: body.digest,
    action: body.action,
  };
  if (body.action === "return" || body.action === "reject") {
    payload.reason = body.reason ?? "";
  } else if (body.action === "assign") {
    payload.assignee = body.assignee ?? "";
  }
  return apiFetch<Proposal>(
    `/v1/proposals/${encodeURIComponent(id)}/review`,
    {
      method: "POST",
      body: payload,
    },
  );
}

export function reconcileProposal(id: string) {
  return apiFetch<Proposal>(
    `/v1/proposals/${encodeURIComponent(id)}/reconcile`,
    {
      method: "POST",
    },
  );
}

export function triggerDemoWorkerTick() {
  return apiFetch<{ worked: boolean }>("/v1/demo/worker-tick", {
    method: "POST",
  });
}

export function fetchProposalIntake(intakeId: string, signal?: AbortSignal) {
  return apiFetch<IntakeDetail>(`/v1/intakes/${encodeURIComponent(intakeId)}`, {
    signal,
  });
}
