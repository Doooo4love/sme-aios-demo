import type {
  Actor,
  AgentProfile,
  BriefResponse,
  Capabilities,
  DemoPersonaId,
  DemoPersonasResponse,
  FieldValidationError,
  NormalizedApiError,
  NoticeDetail,
  NoticePage,
  Profile,
  Proposal,
  TaskLane,
  TaskPage,
  TurnResult,
  WorkbenchToolCall,
} from "@/lib/types";

export type AuthResetReason =
  | "unauthorized"
  | "logout"
  | "persona_switch"
  | "suspended"
  | "manual";

type AuthResetListener = (reason: AuthResetReason, generation: number) => void;

const PROPOSAL_TOOLS = new Set(["shipment.reschedule", "order.draft.prepare"]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Strictly in-memory runtime state — NEVER persisted to localStorage or sessionStorage
let csrfToken: string | null = null;
let csrfInFlight: Promise<string> | null = null;
let authGeneration = 0;

const activeControllers = new Set<AbortController>();
const authResetListeners = new Set<AuthResetListener>();
const globalObjectUrls = new Set<string>();

export class StaleAuthError extends Error {
  readonly isStaleAuth = true;
  constructor() {
    super("Request superseded by authentication state change");
    this.name = "StaleAuthError";
  }
}

export function isStaleAuthError(error: unknown): error is StaleAuthError {
  return (
    error instanceof StaleAuthError ||
    (typeof error === "object" &&
      error !== null &&
      "isStaleAuth" in error &&
      (error as { isStaleAuth?: unknown }).isStaleAuth === true)
  );
}

export class ApiError extends Error implements NormalizedApiError {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
  readonly retryAfter: number | null;
  readonly fieldErrors: FieldValidationError[];
  readonly nextStep: string | null;
  readonly viewProposalId: string | null;
  readonly allowedActions: string[];
  readonly warehouses: string[];
  readonly runId: string | null;
  readonly rawDetail: unknown;

  constructor(parsed: NormalizedApiError, rawDetail?: unknown) {
    super(parsed.message);
    this.name = "ApiError";
    this.status = parsed.status;
    this.code = parsed.code;
    this.requestId = parsed.requestId;
    this.retryAfter = parsed.retryAfter;
    this.fieldErrors = parsed.fieldErrors;
    this.nextStep = parsed.nextStep;
    this.viewProposalId = parsed.viewProposalId;
    this.allowedActions = parsed.allowedActions;
    this.warehouses = parsed.warehouses;
    this.runId = parsed.runId;
    this.rawDetail = rawDetail;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export function getAuthGeneration(): number {
  return authGeneration;
}

export function setCsrfToken(token: string | null): void {
  csrfToken = token && token.trim().length > 0 ? token.trim() : null;
}

export function clearCsrfToken(): void {
  csrfToken = null;
  csrfInFlight = null;
}

export function registerObjectUrl(blob: Blob | MediaSource): string {
  const url = URL.createObjectURL(blob);
  globalObjectUrls.add(url);
  return url;
}

export function revokeObjectUrl(url: string | null | undefined): void {
  if (!url) return;
  if (globalObjectUrls.has(url)) {
    globalObjectUrls.delete(url);
  }
  try {
    URL.revokeObjectURL(url);
  } catch {
    // ignore already-revoked URLs
  }
}

export function revokeAllObjectUrls(): void {
  for (const url of globalObjectUrls) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
  }
  globalObjectUrls.clear();
}

export interface ObjectUrlRegistry {
  create: (blob: Blob | MediaSource) => string;
  revoke: (url: string | null | undefined) => void;
  revokeAll: () => void;
}

export function createObjectUrlRegistry(): ObjectUrlRegistry {
  const scoped = new Set<string>();
  return {
    create(blob) {
      const url = registerObjectUrl(blob);
      scoped.add(url);
      return url;
    },
    revoke(url) {
      if (!url) return;
      scoped.delete(url);
      revokeObjectUrl(url);
    },
    revokeAll() {
      for (const url of scoped) {
        revokeObjectUrl(url);
      }
      scoped.clear();
    },
  };
}

export function onAuthReset(listener: AuthResetListener): () => void {
  authResetListeners.add(listener);
  return () => {
    authResetListeners.delete(listener);
  };
}

export function bumpAuthGeneration(reason: AuthResetReason = "manual"): number {
  authGeneration += 1;
  const nextGen = authGeneration;
  clearCsrfToken();

  // Immediately abort every in-flight request from the prior auth generation
  for (const controller of Array.from(activeControllers)) {
    try {
      controller.abort(new StaleAuthError());
    } catch {
      // ignore
    }
  }
  activeControllers.clear();

  // Immediately revoke all transient local object URLs (e.g. uploaded PO previews)
  revokeAllObjectUrls();

  for (const listener of Array.from(authResetListeners)) {
    try {
      listener(reason, nextGen);
    } catch {
      // keep notifying remaining listeners
    }
  }
  return nextGen;
}

export function generateClientId(prefix = "cid"): string {
  const safePrefix = prefix.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 12) || "cid";
  const rand =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 20)
      : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  return `${safePrefix}_${rand}`.slice(0, 64);
}

export function generateIdempotencyKey(prefix = "idem"): string {
  const safePrefix =
    prefix.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 16) || "idem";
  const rand =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `${safePrefix}:${rand}`.slice(0, 128);
}

function defaultMessageForError(status: number, code: string, rawStr?: string): string {
  if (status === 404 || code === "RECORD_UNAVAILABLE") {
    return "当前账号无法访问这条记录。";
  }
  switch (code) {
    case "UNAUTHORIZED":
      return "登录状态已失效，请重新登录。";
    case "ORIGIN_REJECTED":
      return "请求来源未获授权。";
    case "CSRF_REJECTED":
      return "安全校验令牌已失效，请重试。";
    case "ACCESS_RESTRICTED":
      return "当前账号无权执行此操作或访问该站点范围。";
    case "ACTION_NOT_ALLOWED":
      return "当前账号无权批准该提案，可切换为只读查看详情。";
    case "ACCESS_CHANGED":
      return "访问权限已变更，界面能力已同步刷新。";
    case "SUSPENDED":
      return "当前账号访问已被停用。";
    case "TURN_IN_PROGRESS":
      return "该指令仍在处理中，请稍候自动同步结果。";
    case "REVIEW_IN_PROGRESS":
      return "受控预审正在执行中，请稍候重试。";
    case "REVIEW_SNAPSHOT_CONFLICT":
    case "REVIEW_SOURCE_CHANGED":
      return "源数据快照已变更，请刷新最新记录后重新确认。";
    case "REVIEW_EXPIRED":
      return "该预审记录已过期，请重新发起预审。";
    case "MODEL_BUDGET_EXHAUSTED":
    case "RATE_LIMITED":
      return "当前租户请求额度已达上限，请稍后再试。";
    case "STORAGE_UNAVAILABLE":
    case "DIRECTORY_UNAVAILABLE":
    case "ASSURANCE_OVERLOADED":
    case "AVATAR_BUSY":
    case "UPSTREAM_UNAVAILABLE":
      return "服务繁忙或上游连接暂不可用，请稍后重试。";
    default:
      break;
  }

  if (rawStr) {
    if (rawStr === "AIOS access is suspended") {
      return "当前账号访问已被停用。";
    }
    if (rawStr === "Tenant planner budget exhausted") {
      return "当前租户规划请求额度已达上限，请稍后重试。";
    }
    if (rawStr === "Assignment changed. Reload and review before saving.") {
      return "该模块授权已在其他会话中变更，已刷新最新快照，请核对后重新保存。";
    }
    if (rawStr === "Profile version changed") {
      return "资料版本已更新，请刷新最新内容后再保存。";
    }
    if (rawStr === "At least one attendee is busy") {
      return "所选时间段内至少有一位参会人时间冲突，请调整时间。";
    }
    if (rawStr === "Meeting has changed") {
      return "会议信息已被更新，请刷新后重试。";
    }
    if (rawStr === "An administrator must manage another employee") {
      return "管理员不可修改本人模块授权。";
    }
    if (rawStr === "Preview digest changed") {
      return "提案摘要已变更，请核对最新差异后再确认。";
    }
    return rawStr;
  }

  if (status === 401) return "登录状态已失效，请重新登录。";
  if (status === 403) return "当前账号无权执行此操作。";
  if (status === 409) return "数据状态已发生变更，请刷新后核对再试。";
  if (status === 422) return "请检查表单输入格式后重试。";
  if (status === 429) return "请求过于频繁，请稍后重试。";
  if (status >= 500) return "服务暂不可用，请稍后重试。";
  return "请求未能完成，请稍后重试。";
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const num = Number.parseInt(header.trim(), 10);
  if (Number.isFinite(num) && num >= 0) return num;
  return null;
}

export function parseApiError(
  status: number,
  body: unknown,
  headers: Headers,
): ApiError {
  const requestId = headers.get("x-request-id");
  const retryAfter = parseRetryAfter(headers.get("retry-after"));

  const detail =
    typeof body === "object" && body !== null && "detail" in body
      ? (body as { detail?: unknown }).detail
      : body;

  let code = status === 404 ? "RECORD_UNAVAILABLE" : `HTTP_${status}`;
  let message = "";
  let fieldErrors: FieldValidationError[] = [];
  let nextStep: string | null = null;
  let viewProposalId: string | null = null;
  let allowedActions: string[] = [];
  let warehouses: string[] = [];
  let runId: string | null = null;

  if (status === 404) {
    code = "RECORD_UNAVAILABLE";
    message = "当前账号无法访问这条记录。";
  } else if (Array.isArray(detail)) {
    code = "VALIDATION_ERROR";
    fieldErrors = detail
      .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
      .map((item) => ({
        loc: Array.isArray(item.loc)
          ? item.loc.filter(
              (p): p is string | number =>
                typeof p === "string" || typeof p === "number",
            )
          : [],
        msg: typeof item.msg === "string" ? item.msg : "输入格式不符合要求",
        type: typeof item.type === "string" ? item.type : undefined,
      }));
    message =
      fieldErrors.length > 0
        ? fieldErrors[0]!.msg
        : defaultMessageForError(status, code);
  } else if (typeof detail === "object" && detail !== null) {
    const obj = detail as Record<string, unknown>;
    if (typeof obj.code === "string") code = obj.code;
    if (typeof obj.next_step === "string") nextStep = obj.next_step;
    if (typeof obj.proposal_id === "string") viewProposalId = obj.proposal_id;
    else if (typeof obj.view_proposal_id === "string") {
      viewProposalId = obj.view_proposal_id;
    }
    if (Array.isArray(obj.allowed_actions)) {
      allowedActions = obj.allowed_actions.filter(
        (v): v is string => typeof v === "string",
      );
    }
    if (Array.isArray(obj.warehouses)) {
      warehouses = obj.warehouses.filter(
        (v): v is string => typeof v === "string",
      );
    }
    if (typeof obj.run_id === "string") runId = obj.run_id;
    const explicitMsg =
      typeof obj.message === "string" && obj.message.trim().length > 0
        ? obj.message.trim()
        : undefined;
    message = explicitMsg || defaultMessageForError(status, code);
  } else if (typeof detail === "string") {
    if (detail === "AIOS access is suspended") {
      code = "SUSPENDED";
    } else if (status === 429) {
      code = "RATE_LIMITED";
    } else if (status === 401) {
      code = "UNAUTHORIZED";
    } else if (status === 403) {
      code = "ACCESS_RESTRICTED";
    } else if (status === 409) {
      code = "CONFLICT";
    }
    message = defaultMessageForError(status, code, detail);
  } else {
    message = defaultMessageForError(status, code);
  }

  return new ApiError(
    {
      status,
      code,
      message,
      requestId,
      retryAfter,
      fieldErrors,
      nextStep,
      viewProposalId,
      allowedActions,
      warehouses,
      runId,
    },
    detail,
  );
}

function linkAbortSignals(
  internal: AbortController,
  external?: AbortSignal,
): () => void {
  if (!external) return () => {};
  if (external.aborted) {
    internal.abort(external.reason);
    return () => {};
  }
  const onAbort = () => internal.abort(external.reason);
  external.addEventListener("abort", onAbort, { once: true });
  return () => external.removeEventListener("abort", onAbort);
}

export async function ensureCsrfToken(signal?: AbortSignal): Promise<string> {
  if (csrfToken) return csrfToken;
  if (csrfInFlight) return csrfInFlight;

  const gen = authGeneration;
  csrfInFlight = (async () => {
    const controller = new AbortController();
    activeControllers.add(controller);
    const unlink = linkAbortSignals(controller, signal);
    try {
      const res = await fetch("/v1/session", {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
      });
      if (gen !== authGeneration) throw new StaleAuthError();
      if (!res.ok) {
        let errBody: unknown = null;
        try {
          errBody = await res.json();
        } catch {
          errBody = null;
        }
        if (res.status === 401) {
          bumpAuthGeneration("unauthorized");
        }
        throw parseApiError(res.status, errBody, res.headers);
      }
      const data = (await res.json()) as { csrf_token?: string };
      if (gen !== authGeneration) throw new StaleAuthError();
      const token = typeof data.csrf_token === "string" ? data.csrf_token : "";
      if (!token) {
        throw new ApiError({
          status: 401,
          code: "UNAUTHORIZED",
          message: "无法获取会话校验令牌，请重新登录。",
          requestId: res.headers.get("x-request-id"),
          retryAfter: null,
          fieldErrors: [],
          nextStep: null,
          viewProposalId: null,
          allowedActions: [],
          warehouses: [],
          runId: null,
        });
      }
      csrfToken = token;
      return token;
    } catch (error) {
      if (gen !== authGeneration) throw new StaleAuthError();
      throw error;
    } finally {
      unlink();
      activeControllers.delete(controller);
      csrfInFlight = null;
    }
  })();

  return csrfInFlight;
}

export interface ApiFetchOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  body?: unknown;
  rawBody?: Blob | ArrayBuffer | Uint8Array;
  contentType?: string;
  idempotencyKey?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Skip auto-attaching X-CSRF-Token (only for /api/auth/demo-login) */
  skipCsrf?: boolean;
  /** Do not trigger global authGeneration bump on 401 (used for initial session probe) */
  suppressAuthReset?: boolean;
}

function validateIdempotencyRules(
  path: string,
  method: string,
  body: unknown,
  idempotencyKey?: string,
): string | undefined {
  const pathname = path.split("?")[0] ?? path;
  if (method === "POST" && pathname === "/v1/workbench/turns") {
    if (
      typeof body === "object" &&
      body !== null &&
      "client_id" in body &&
      (body as { client_id?: unknown }).client_id != null
    ) {
      // CRITICAL: FastAPI returns 422 if both client_id and Idempotency-Key are sent
      return undefined;
    }
  }
  if (method === "POST" && pathname === "/v1/workbench/calls") {
    if (
      typeof body === "object" &&
      body !== null &&
      "tool" in body &&
      typeof (body as { tool?: unknown }).tool === "string" &&
      PROPOSAL_TOOLS.has((body as { tool: string }).tool)
    ) {
      if (!idempotencyKey || !idempotencyKey.trim()) {
        throw new Error(
          `Idempotency-Key is strictly required for proposal tool "${(body as { tool: string }).tool}" on POST /v1/workbench/calls`,
        );
      }
    }
  }
  return idempotencyKey;
}

export async function apiFetch<T = unknown>(
  path: string,
  options: ApiFetchOptions = {},
): Promise<T> {
  const method = (options.method || "GET").toUpperCase();
  const isMutation = !SAFE_METHODS.has(method);
  const gen = authGeneration;

  const effectiveIdempotencyKey = validateIdempotencyRules(
    path,
    method,
    options.body,
    options.idempotencyKey,
  );

  const runAttempt = async (allowCsrfRetry: boolean): Promise<T> => {
    if (gen !== authGeneration) throw new StaleAuthError();

    const headers = new Headers(options.headers);
    headers.set("Accept", "application/json");

    if (isMutation && !options.skipCsrf) {
      const token = await ensureCsrfToken(options.signal);
      if (gen !== authGeneration) throw new StaleAuthError();
      headers.set("X-CSRF-Token", token);
    }

    if (effectiveIdempotencyKey) {
      headers.set("Idempotency-Key", effectiveIdempotencyKey);
    }

    let requestBody: BodyInit | undefined;
    if (options.rawBody !== undefined) {
      headers.set(
        "Content-Type",
        options.contentType || "application/octet-stream",
      );
      requestBody =
        options.rawBody instanceof Uint8Array
          ? new Blob([options.rawBody as BlobPart], {
              type: options.contentType || "application/octet-stream",
            })
          : options.rawBody;
    } else if (options.body !== undefined) {
      headers.set("Content-Type", options.contentType || "application/json");
      requestBody = JSON.stringify(options.body);
    }

    const controller = new AbortController();
    activeControllers.add(controller);
    const unlink = linkAbortSignals(controller, options.signal);

    try {
      const res = await fetch(path, {
        method,
        credentials: "same-origin",
        cache: "no-store",
        headers,
        body: requestBody,
        signal: controller.signal,
      });

      if (gen !== authGeneration) throw new StaleAuthError();

      if (res.status === 204) {
        return undefined as T;
      }

      const contentType = (res.headers.get("content-type") || "").toLowerCase();
      let payload: unknown = null;
      if (contentType.includes("application/json")) {
        try {
          payload = await res.json();
        } catch {
          payload = null;
        }
      } else {
        const text = await res.text();
        payload = text.length > 0 ? text : null;
      }

      if (gen !== authGeneration) throw new StaleAuthError();

      if (!res.ok) {
        const apiError = parseApiError(res.status, payload, res.headers);

        // One-time CSRF token refresh & retry if cookie session is still valid
        if (
          res.status === 403 &&
          apiError.code === "CSRF_REJECTED" &&
          allowCsrfRetry &&
          isMutation &&
          !options.skipCsrf
        ) {
          clearCsrfToken();
          await ensureCsrfToken(options.signal);
          return runAttempt(false);
        }

        if (res.status === 401 && !options.suppressAuthReset) {
          bumpAuthGeneration("unauthorized");
        } else if (
          res.status === 403 &&
          apiError.code === "SUSPENDED" &&
          !options.suppressAuthReset
        ) {
          bumpAuthGeneration("suspended");
        }

        throw apiError;
      }

      return payload as T;
    } catch (error) {
      if (gen !== authGeneration) {
        throw new StaleAuthError();
      }
      if (isStaleAuthError(error)) {
        throw error;
      }
      throw error;
    } finally {
      unlink();
      activeControllers.delete(controller);
    }
  };

  return runAttempt(true);
}

export async function apiFetchBlob(
  path: string,
  options?: { signal?: AbortSignal; suppressAuthReset?: boolean },
): Promise<Blob | null> {
  const gen = authGeneration;
  const controller = new AbortController();
  activeControllers.add(controller);
  const unlink = linkAbortSignals(controller, options?.signal);

  try {
    const res = await fetch(path, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
    });
    if (gen !== authGeneration) throw new StaleAuthError();
    if (res.status === 404) return null;
    if (!res.ok) {
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      if (res.status === 401 && !options?.suppressAuthReset) {
        bumpAuthGeneration("unauthorized");
      }
      throw parseApiError(res.status, body, res.headers);
    }
    const blob = await res.blob();
    if (gen !== authGeneration) throw new StaleAuthError();
    return blob;
  } catch (error) {
    if (gen !== authGeneration) throw new StaleAuthError();
    throw error;
  } finally {
    unlink();
    activeControllers.delete(controller);
  }
}

// ============================================================================
// Typed Core API Helpers (reusable across AppShell and Wave 3 feature modules)
// ============================================================================

export function fetchDemoPersonas(signal?: AbortSignal) {
  return apiFetch<DemoPersonasResponse>("/api/auth/demo-personas", {
    signal,
    suppressAuthReset: true,
  });
}

export async function loginWithDemoPersona(
  persona: DemoPersonaId,
): Promise<{ csrf_token: string; expires_in: number }> {
  const res = await apiFetch<{ csrf_token: string; expires_in: number }>(
    "/api/auth/demo-login",
    {
      method: "POST",
      body: { persona },
      skipCsrf: true,
      suppressAuthReset: true,
    },
  );
  if (res?.csrf_token) {
    setCsrfToken(res.csrf_token);
  }
  return res;
}

export async function logoutSession(): Promise<void> {
  try {
    await apiFetch<void>("/v1/session", {
      method: "DELETE",
      suppressAuthReset: true,
    });
  } catch {
    // Even if cookie already expired upstream, proceed with local purge
  } finally {
    bumpAuthGeneration("logout");
  }
}

export function fetchMe(options?: {
  signal?: AbortSignal;
  suppressAuthReset?: boolean;
}) {
  return apiFetch<Actor>("/v1/me", options);
}

export function fetchCapabilities(options?: {
  signal?: AbortSignal;
  suppressAuthReset?: boolean;
}) {
  return apiFetch<Capabilities>("/v1/workbench/capabilities", options);
}

export function fetchProfile(options?: {
  signal?: AbortSignal;
  suppressAuthReset?: boolean;
}) {
  return apiFetch<Profile>("/v1/profile", options);
}

export function fetchAgentProfile(options?: {
  signal?: AbortSignal;
  suppressAuthReset?: boolean;
}) {
  return apiFetch<AgentProfile>("/v1/agent-profile", options);
}

export function fetchTasks(
  lane: TaskLane,
  params?: { limit?: number; after_due?: number; after_id?: string },
  signal?: AbortSignal,
) {
  const sp = new URLSearchParams({ lane });
  if (params?.limit) sp.set("limit", String(params.limit));
  if (params?.after_due !== undefined && params?.after_id) {
    sp.set("after_due", String(params.after_due));
    sp.set("after_id", params.after_id);
  }
  return apiFetch<TaskPage>(`/v1/workbench/tasks?${sp.toString()}`, { signal });
}

export function fetchNotices(
  params?: { limit?: number; before_at?: number; before_id?: string },
  signal?: AbortSignal,
) {
  const sp = new URLSearchParams();
  if (params?.limit) sp.set("limit", String(params.limit));
  if (params?.before_at !== undefined && params?.before_id) {
    sp.set("before_at", String(params.before_at));
    sp.set("before_id", params.before_id);
  }
  const q = sp.toString();
  return apiFetch<NoticePage>(`/v1/workbench/notices${q ? `?${q}` : ""}`, {
    signal,
  });
}

export function fetchNoticeDetail(id: string, signal?: AbortSignal) {
  return apiFetch<NoticeDetail>(
    `/v1/workbench/notices/${encodeURIComponent(id)}`,
    { signal },
  );
}

export function markNoticeRead(id: string) {
  return apiFetch<{ read_at: number }>(
    `/v1/workbench/notices/${encodeURIComponent(id)}/read`,
    { method: "PUT" },
  );
}

export function fetchBrief(startIso: string, endIso: string, signal?: AbortSignal) {
  const sp = new URLSearchParams({ start: startIso, end: endIso });
  return apiFetch<BriefResponse>(`/v1/workbench/brief?${sp.toString()}`, {
    signal,
  });
}

export function fetchProposal(id: string, signal?: AbortSignal) {
  return apiFetch<Proposal>(`/v1/proposals/${encodeURIComponent(id)}`, {
    signal,
  });
}

export function submitWorkbenchTurn(
  text: string,
  clientId?: string | null,
  signal?: AbortSignal,
) {
  const body = clientId ? { text, client_id: clientId } : { text };
  return apiFetch<TurnResult>("/v1/workbench/turns", {
    method: "POST",
    body,
    signal,
  });
}

export function callWorkbenchTool(
  call: WorkbenchToolCall,
  options?: { idempotencyKey?: string; signal?: AbortSignal },
) {
  return apiFetch<TurnResult>("/v1/workbench/calls", {
    method: "POST",
    body: call,
    idempotencyKey: options?.idempotencyKey,
    signal: options?.signal,
  });
}
