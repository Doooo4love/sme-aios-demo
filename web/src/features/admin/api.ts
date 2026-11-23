import { apiFetch, isApiError, type ApiError } from "@/lib/api-client";
import type {
  AssuranceCheckpoint,
  ExceptionPage,
  LlmRoutingTier,
  LlmTelemetrySummary,
  OffTopicPolicy,
  OffTopicPolicyUpdatePayload,
  OperationsSummary,
  PromptPoliciesResponse,
  PromptSimulateResponse,
  Proposal,
  QuotaPoliciesResponse,
  QuotaPolicyItem,
  QuotaPolicyUpdatePayload,
  SecurityEventItem,
  SecurityEventPage,
  SecurityEventSeverity,
  SecurityEventStatus,
  SecurityEventsSummary,
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

export function fetchPromptPolicies(signal?: AbortSignal) {
  return apiFetch<PromptPoliciesResponse>("/v1/operations/prompt-policies", {
    signal,
  });
}

export async function simulatePromptPolicy(
  body: {
    role: string;
    active_modules?: string[];
    grants?: string[];
    warehouses?: string[];
  },
  signal?: AbortSignal,
): Promise<PromptSimulateResponse> {
  const payload: Record<string, unknown> = {
    role: body.role,
    warehouses: body.warehouses ?? ["HK01"],
    grants: body.grants ?? [],
  };
  if (body.active_modules !== undefined) {
    payload.active_modules = body.active_modules;
  }
  const res = await apiFetch<Partial<PromptSimulateResponse>>(
    "/v1/operations/prompt-policies/simulate",
    {
      method: "POST",
      body: payload,
      signal,
    },
  );
  return {
    role: res.role ?? body.role,
    active_scopes: res.active_scopes ?? [],
    denied_scopes: res.denied_scopes ?? [],
    sealed: res.sealed ?? true,
    managed_by: res.managed_by ?? "theodic_core_team",
  };
}

export function fetchSecurityEvents(
  params?: {
    status?: SecurityEventStatus;
    severity?: SecurityEventSeverity;
    category?: string;
    subject?: string;
    limit?: number;
    before_at?: number;
    before_id?: string;
  },
  signal?: AbortSignal,
) {
  const sp = new URLSearchParams();
  if (params?.status) sp.set("status", params.status);
  if (params?.severity) sp.set("severity", params.severity);
  if (params?.category) sp.set("category", params.category);
  if (params?.subject) sp.set("subject", params.subject);
  if (params?.limit !== undefined) sp.set("limit", String(params.limit));
  if (params?.before_at !== undefined && params?.before_id) {
    sp.set("before_at", String(params.before_at));
    sp.set("before_id", params.before_id);
  }
  const query = sp.toString();
  return apiFetch<SecurityEventPage>(
    `/v1/operations/security-events${query ? `?${query}` : ""}`,
    { signal },
  );
}

interface RawSecurityEventsSummary {
  total_open?: number;
  open_total?: number;
  by_severity?: Partial<Record<SecurityEventSeverity, number>>;
  open_by_severity?: Partial<Record<SecurityEventSeverity, number>>;
  by_category?: Record<string, number>;
  last_24h_total?: number;
}

export async function fetchSecurityEventsSummary(
  signal?: AbortSignal,
): Promise<SecurityEventsSummary> {
  const raw = await apiFetch<RawSecurityEventsSummary>(
    "/v1/operations/security-events/summary",
    { signal },
  );
  const sev = raw.by_severity ?? raw.open_by_severity ?? {};
  return {
    total_open: raw.total_open ?? raw.open_total ?? 0,
    by_severity: {
      critical: sev.critical ?? 0,
      high: sev.high ?? 0,
      medium: sev.medium ?? 0,
      info: sev.info ?? 0,
    },
    by_category: raw.by_category ?? {},
    last_24h_total: raw.last_24h_total ?? 0,
  };
}

export function updateSecurityEventStatus(
  eventId: string,
  body: {
    status: SecurityEventStatus;
    resolution_note?: string | null;
  },
  signal?: AbortSignal,
) {
  return apiFetch<SecurityEventItem>(
    `/v1/operations/security-events/${encodeURIComponent(eventId)}`,
    {
      method: "PUT",
      body,
      signal,
    },
  );
}

function normalizeOffTopicPolicy(
  raw: Partial<OffTopicPolicy> | null | undefined,
): OffTopicPolicy {
  return {
    tenant: typeof raw?.tenant === "string" ? raw.tenant : "",
    daily_remind_threshold:
      typeof raw?.daily_remind_threshold === "number"
        ? raw.daily_remind_threshold
        : 1,
    daily_escalate_threshold:
      typeof raw?.daily_escalate_threshold === "number"
        ? raw.daily_escalate_threshold
        : 5,
    seven_day_escalate_threshold:
      typeof raw?.seven_day_escalate_threshold === "number"
        ? raw.seven_day_escalate_threshold
        : 12,
    daily_local_auto_escalate_threshold:
      typeof raw?.daily_local_auto_escalate_threshold === "number"
        ? raw.daily_local_auto_escalate_threshold
        : 2,
    app_allowlist: Array.isArray(raw?.app_allowlist)
      ? raw.app_allowlist.filter((item): item is string => typeof item === "string")
      : [],
    routing_rules:
      raw?.routing_rules && typeof raw.routing_rules === "object"
        ? raw.routing_rules
        : {},
    updated_by: typeof raw?.updated_by === "string" ? raw.updated_by : null,
    updated_at: typeof raw?.updated_at === "number" ? raw.updated_at : null,
  };
}

export async function fetchOffTopicPolicy(
  signal?: AbortSignal,
): Promise<OffTopicPolicy> {
  const res = await apiFetch<Partial<OffTopicPolicy>>(
    "/v1/operations/off-topic-policy",
    { signal },
  );
  return normalizeOffTopicPolicy(res);
}

export async function updateOffTopicPolicy(
  payload: OffTopicPolicyUpdatePayload,
  signal?: AbortSignal,
): Promise<OffTopicPolicy> {
  const res = await apiFetch<Partial<OffTopicPolicy>>(
    "/v1/operations/off-topic-policy",
    {
      method: "PUT",
      body: payload,
      signal,
    },
  );
  return normalizeOffTopicPolicy(res);
}

export async function fetchLlmTelemetry(
  hours = 24,
  signal?: AbortSignal,
): Promise<LlmTelemetrySummary> {
  const safeHours = Number.isFinite(hours)
    ? Math.max(1, Math.min(Math.round(hours), 720))
    : 24;
  const raw = await apiFetch<Partial<LlmTelemetrySummary>>(
    `/v1/operations/llm-telemetry?hours=${encodeURIComponent(String(safeHours))}`,
    { signal },
  );
  const rawTier = (raw?.by_tier ?? {}) as Partial<Record<LlmRoutingTier, number>>;
  return {
    window_hours:
      typeof raw?.window_hours === "number" ? raw.window_hours : safeHours,
    total_calls: typeof raw?.total_calls === "number" ? raw.total_calls : 0,
    cache_hit_ratio:
      typeof raw?.cache_hit_ratio === "number" ? raw.cache_hit_ratio : 0,
    total_prompt_tokens:
      typeof raw?.total_prompt_tokens === "number" ? raw.total_prompt_tokens : 0,
    total_cache_hit_tokens:
      typeof raw?.total_cache_hit_tokens === "number"
        ? raw.total_cache_hit_tokens
        : 0,
    total_reasoning_tokens:
      typeof raw?.total_reasoning_tokens === "number"
        ? raw.total_reasoning_tokens
        : 0,
    total_completion_tokens:
      typeof raw?.total_completion_tokens === "number"
        ? raw.total_completion_tokens
        : 0,
    total_estimated_usd:
      typeof raw?.total_estimated_usd === "number" ? raw.total_estimated_usd : 0,
    avg_latency_ms:
      typeof raw?.avg_latency_ms === "number" ? raw.avg_latency_ms : 0,
    by_tier: {
      T0: typeof rawTier.T0 === "number" ? rawTier.T0 : 0,
      T1: typeof rawTier.T1 === "number" ? rawTier.T1 : 0,
      T2: typeof rawTier.T2 === "number" ? rawTier.T2 : 0,
      T3: typeof rawTier.T3 === "number" ? rawTier.T3 : 0,
    },
    by_provider:
      raw?.by_provider && typeof raw.by_provider === "object"
        ? raw.by_provider
        : {},
    by_subject:
      raw?.by_subject && typeof raw.by_subject === "object"
        ? raw.by_subject
        : {},
  };
}

export async function fetchQuotaPolicies(
  signal?: AbortSignal,
): Promise<QuotaPoliciesResponse> {
  const raw = await apiFetch<QuotaPoliciesResponse | QuotaPolicyItem[]>(
    "/v1/operations/quota-policies",
    { signal },
  );
  if (Array.isArray(raw)) {
    return { items: raw };
  }
  return {
    items: Array.isArray(raw?.items) ? raw.items : [],
  };
}

export function updateQuotaPolicy(
  payload: QuotaPolicyUpdatePayload,
  signal?: AbortSignal,
): Promise<QuotaPolicyItem> {
  return apiFetch<QuotaPolicyItem>("/v1/operations/quota-policies", {
    method: "PUT",
    body: payload,
    signal,
  });
}
