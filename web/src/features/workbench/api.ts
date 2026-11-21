import { apiFetch } from "@/lib/api-client";
import type {
  ApprovalPage,
  AssuranceCaseDetail,
  AssuranceCasePage,
  AssuranceKind,
  AssuranceReview,
  AssuranceReviewPage,
  AssuranceTrack,
} from "@/lib/types";

export function fetchWorkbenchApprovals(
  params?: { limit?: number; after_due?: number; after_id?: string },
  signal?: AbortSignal,
) {
  const sp = new URLSearchParams();
  if (params?.limit) sp.set("limit", String(params.limit));
  if (params?.after_due !== undefined && params?.after_id) {
    sp.set("after_due", String(params.after_due));
    sp.set("after_id", params.after_id);
  }
  const q = sp.toString();
  return apiFetch<ApprovalPage>(`/v1/workbench/approvals${q ? `?${q}` : ""}`, {
    signal,
  });
}

export function fetchAssuranceCases(
  kind: AssuranceKind,
  params?: { limit?: number; after?: string },
  signal?: AbortSignal,
) {
  const sp = new URLSearchParams({ kind });
  if (params?.limit) sp.set("limit", String(params.limit));
  if (params?.after) sp.set("after", params.after);
  return apiFetch<AssuranceCasePage>(`/v1/assurance/cases?${sp.toString()}`, {
    signal,
  });
}

export function fetchAssuranceCaseDetail(
  reference: string,
  signal?: AbortSignal,
) {
  return apiFetch<AssuranceCaseDetail>(
    `/v1/assurance/cases/${encodeURIComponent(reference)}`,
    { signal },
  );
}

export function fetchAssuranceCaseReviews(
  reference: string,
  params?: { limit?: number; after?: string },
  signal?: AbortSignal,
) {
  const sp = new URLSearchParams();
  if (params?.limit) sp.set("limit", String(params.limit));
  if (params?.after) sp.set("after", params.after);
  const q = sp.toString();
  return apiFetch<AssuranceReviewPage>(
    `/v1/assurance/cases/${encodeURIComponent(reference)}/reviews${q ? `?${q}` : ""}`,
    { signal },
  );
}

export function createAssuranceReview(
  reference: string,
  clientId: string,
  instruction = "",
) {
  return apiFetch<AssuranceReview>(
    `/v1/assurance/cases/${encodeURIComponent(reference)}/reviews`,
    {
      method: "POST",
      body: {
        client_id: clientId,
        instruction,
      },
    },
  );
}

export function fetchAssuranceReview(reviewId: string, signal?: AbortSignal) {
  return apiFetch<AssuranceReview>(
    `/v1/assurance/reviews/${encodeURIComponent(reviewId)}`,
    { signal },
  );
}

export function submitAssuranceDecision(
  reviewId: string,
  body: {
    track: AssuranceTrack;
    action: "approve" | "reject";
    snapshot: string;
  },
) {
  return apiFetch<AssuranceReview>(
    `/v1/assurance/reviews/${encodeURIComponent(reviewId)}/decisions`,
    {
      method: "POST",
      body,
    },
  );
}
