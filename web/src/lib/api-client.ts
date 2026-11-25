import type {
  Actor,
  AgentProfile,
  BriefResponse,
  CalendarSyncResponse,
  Capabilities,
  ChannelBindingItem,
  ChannelBindingsResponse,
  ChannelOutboundPage,
  ChannelOutboundReceipt,
  ChannelsCatalogResponse,
  ChatRoom,
  CompanyContactsResponse,
  DemoPersonaId,
  DemoPersonasResponse,
  EmailOutboxPage,
  EmailOutboxReceipt,
  EmailParseResponse,
  EmailSendResponse,
  ExternalCalendarTarget,
  FieldValidationError,
  McpStatusResponse,
  NormalizedApiError,
  NoticeDetail,
  NoticePage,
  Profile,
  Proposal,
  SendChannelOutboundRequest,
  SlashSkillItem,
  SlashSkillsResponse,
  TaskLane,
  TaskPage,
  TurnResult,
  UpsertChannelBindingRequest,
  WorkPulseResponse,
  WorkbenchToolCall,
  ZoomBookingConfirmResponse,
  ZoomBookingPreviewResponse,
} from "@/lib/types";
import {
  LOCALE_COOKIE_NAME,
  normalizeLocale,
  readCookieValue,
  type Locale,
} from "@/lib/i18n/types";
import { localizeErrorMessageForLocale } from "@/lib/i18n/dictionaries";

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

function getActiveClientLocale(): Locale {
  return normalizeLocale(readCookieValue(LOCALE_COOKIE_NAME));
}

export function localizeApiErrorMessage(
  error: Pick<ApiError, "status" | "code" | "message" | "rawDetail">,
  locale?: Locale,
): string {
  return localizeErrorMessageForLocale(
    {
      status: error.status,
      code: error.code,
      message: error.message,
      rawDetail: error.rawDetail,
    },
    locale ?? getActiveClientLocale(),
  );
}

function defaultMessageForError(
  status: number,
  code: string,
  rawStr?: string,
  locale?: Locale,
): string {
  const activeLocale = locale ?? getActiveClientLocale();
  return localizeErrorMessageForLocale(
    {
      status,
      code,
      rawDetail: rawStr,
      message: rawStr,
    },
    activeLocale,
  );
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
    message = defaultMessageForError(404, "RECORD_UNAVAILABLE");
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
        msg:
          typeof item.msg === "string"
            ? item.msg
            : defaultMessageForError(422, "VALIDATION_ERROR"),
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
          code: "SESSION_CSRF_MISSING",
          message: defaultMessageForError(401, "SESSION_CSRF_MISSING"),
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

export async function loginWithCredentials(
  username: string,
  password: string,
): Promise<{ csrf_token: string; expires_in: number }> {
  const res = await apiFetch<{ csrf_token: string; expires_in: number }>(
    "/api/auth/login",
    {
      method: "POST",
      body: { username, password },
      skipCsrf: true,
      suppressAuthReset: true,
    },
  );
  if (res?.csrf_token) {
    setCsrfToken(res.csrf_token);
  }
  return res;
}

export const loginWithPassword = loginWithCredentials;

export function fetchCompanyContacts(
  query?: string,
  options?: {
    subject?: string;
    includeSelf?: boolean;
    warehouse?: string;
    limit?: number;
    signal?: AbortSignal;
  },
) {
  const sp = new URLSearchParams();
  if (query && query.trim()) sp.set("q", query.trim());
  if (options?.subject && options.subject.trim()) {
    sp.set("subject", options.subject.trim());
  }
  if (options?.includeSelf) sp.set("include_self", "1");
  if (options?.warehouse) sp.set("warehouse", options.warehouse);
  if (options?.limit) sp.set("limit", String(options.limit));
  const qs = sp.toString();
  return apiFetch<CompanyContactsResponse>(
    `/api/directory/contacts${qs ? `?${qs}` : ""}`,
    { signal: options?.signal },
  );
}

/**
 * Opens an existing 1:1 room or creates one and admits the colleague BEFORE any message is sent.
 */
export async function openOrCreateDirectRoom(
  contactSubject: string,
  contactDisplayName?: string,
  existingDirectRoomId?: string | null,
): Promise<{ room: ChatRoom; created: boolean }> {
  if (existingDirectRoomId) {
    return {
      room: {
        id: existingDirectRoomId,
        title: `DM · ${contactDisplayName || contactSubject} (${contactSubject})`,
        owner: "",
      },
      created: false,
    };
  }
  return apiFetch<{ room: ChatRoom; created: boolean }>(
    "/api/directory/direct-room",
    {
      method: "POST",
      body: {
        target_subject: contactSubject,
        target_display_name: contactDisplayName,
      },
    },
  );
}

export function fetchMcpStatus(signal?: AbortSignal) {
  return apiFetch<McpStatusResponse>("/api/integrations/mcp/status", { signal });
}

export function parseNaturalLanguageZoomBooking(
  params: {
    utterance: string;
    timezone?: string;
    tz_offset_minutes?: number;
    room_id?: string | null;
    default_calendar_targets?: ExternalCalendarTarget[];
  },
  signal?: AbortSignal,
) {
  return apiFetch<ZoomBookingPreviewResponse>("/api/integrations/zoom/book", {
    method: "POST",
    body: {
      action: "preview",
      ...params,
    },
    skipCsrf: true,
    signal,
  });
}

export function confirmZoomBooking(
  params: {
    client_id: string;
    title: string;
    starts_at: string;
    ends_at: string;
    timezone?: string;
    attendees?: string[];
    room_id?: string | null;
    create_zoom?: boolean;
    notify_room?: boolean;
    calendar_targets?: ExternalCalendarTarget[];
  },
  signal?: AbortSignal,
) {
  return apiFetch<ZoomBookingConfirmResponse>("/api/integrations/zoom/book", {
    method: "POST",
    body: {
      action: "confirm",
      ...params,
    },
    signal,
  });
}

export function triggerExternalCalendarSync(
  params: {
    calendar_targets?: ExternalCalendarTarget[];
    event_id?: string;
    join_url?: string | null;
    timezone?: string;
  },
  signal?: AbortSignal,
) {
  return apiFetch<CalendarSyncResponse>("/api/integrations/calendar-sync", {
    method: "POST",
    body: params,
    signal,
  });
}

export function getCalendarIcsUrl(params?: {
  eventId?: string;
  joinUrl?: string | null;
  passcode?: string | null;
  start?: string;
  end?: string;
}): string {
  const sp = new URLSearchParams();
  if (params?.eventId) sp.set("event_id", params.eventId);
  if (params?.joinUrl) sp.set("join_url", params.joinUrl);
  if (params?.passcode) sp.set("passcode", params.passcode);
  if (params?.start) sp.set("start", params.start);
  if (params?.end) sp.set("end", params.end);
  const qs = sp.toString();
  return `/api/calendar/ics${qs ? `?${qs}` : ""}`;
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

export interface WorkbenchTextAttachment {
  doc_id: string;
  title: string;
  content: string;
}

export interface WorkbenchTurnOptions {
  signal?: AbortSignal;
  locale?: string;
  conversationContext?: Array<{ role: "user" | "assistant"; text: string }>;
  activeDocument?: WorkbenchTextAttachment;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    typeof value === "object" &&
    value !== null &&
    "aborted" in value &&
    typeof (value as AbortSignal).addEventListener === "function"
  );
}

export function submitWorkbenchTurn(
  text: string,
  clientId?: string | null,
  signalOrOptions?: AbortSignal | WorkbenchTurnOptions,
) {
  const options: WorkbenchTurnOptions = isAbortSignal(signalOrOptions)
    ? { signal: signalOrOptions }
    : (signalOrOptions ?? {});
  const body: Record<string, unknown> = { text };
  if (clientId) {
    body.client_id = clientId;
  }
  if (options.locale) {
    body.locale = options.locale;
  }
  if (options.activeDocument) body.active_document = options.activeDocument;
  if (options.conversationContext && options.conversationContext.length > 0) {
    body.conversation_context = options.conversationContext.slice(-6);
  }
  return apiFetch<TurnResult>("/v1/workbench/turns", {
    method: "POST",
    body,
    signal: options.signal,
  });
}

export async function fetchSlashSkills(
  signal?: AbortSignal,
): Promise<SlashSkillsResponse> {
  const res = await apiFetch<SlashSkillsResponse | SlashSkillItem[]>(
    "/v1/workbench/skills",
    { signal },
  );
  const rawItems = Array.isArray(res)
    ? res
    : Array.isArray(res?.items)
      ? res.items
      : [];
  return {
    items: rawItems.map((item) => ({
      ...item,
      usage: typeof item.usage === "string" ? item.usage : item.command,
      keywords: Array.isArray(item.keywords) ? item.keywords : [],
    })),
  };
}

export function fetchWorkPulse(signal?: AbortSignal) {
  return apiFetch<WorkPulseResponse>("/v1/workbench/work-pulse", { signal });
}

export function parseNaturalLanguageEmailApi(
  payload: { utterance: string; locale?: string },
  signal?: AbortSignal,
) {
  return apiFetch<EmailParseResponse>("/api/integrations/email/send", {
    method: "POST",
    body: {
      action: "parse",
      ...payload,
    },
    skipCsrf: true,
    signal,
  });
}

export function sendGovernedEmailApi(
  payload: {
    client_id: string;
    to: string[];
    cc?: string[];
    subject: string;
    body: string;
  },
  signal?: AbortSignal,
) {
  return apiFetch<EmailSendResponse>("/api/integrations/email/send", {
    method: "POST",
    body: {
      action: "send",
      ...payload,
    },
    signal,
  });
}

export async function fetchEmailOutbox(
  signal?: AbortSignal,
): Promise<EmailOutboxPage> {
  const res = await apiFetch<EmailOutboxPage | EmailOutboxReceipt[]>(
    "/v1/workbench/email-outbox",
    { signal },
  );
  if (Array.isArray(res)) {
    return { items: res };
  }
  return { items: Array.isArray(res?.items) ? res.items : [] };
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

// ============================================================================
// Enterprise Messaging Channels (8 Mainstream Connectors, Never `provider`)
// ============================================================================

export function fetchChannelsCatalog(signal?: AbortSignal) {
  return apiFetch<ChannelsCatalogResponse>("/v1/channels/catalog", { signal });
}

export function fetchChannelBindings(
  signalOrParams?:
    | AbortSignal
    | { scope?: "mine" | "tenant"; subject?: string },
  signalArg?: AbortSignal,
) {
  const signal = isAbortSignal(signalOrParams) ? signalOrParams : signalArg;
  const params = isAbortSignal(signalOrParams) ? undefined : signalOrParams;
  const sp = new URLSearchParams();
  if (params?.scope) sp.set("scope", params.scope);
  if (params?.subject) sp.set("subject", params.subject);
  const qs = sp.toString();
  return apiFetch<ChannelBindingsResponse>(
    `/v1/channels/bindings${qs ? `?${qs}` : ""}`,
    { signal },
  );
}

export function upsertChannelBinding(
  channelId: string,
  body: UpsertChannelBindingRequest,
  signal?: AbortSignal,
) {
  return apiFetch<ChannelBindingItem>(
    `/v1/channels/bindings/${encodeURIComponent(channelId)}`,
    {
      method: "PUT",
      body,
      signal,
    },
  );
}

export function sendChannelOutbound(
  body: SendChannelOutboundRequest,
  signal?: AbortSignal,
) {
  return apiFetch<ChannelOutboundReceipt>("/v1/channels/outbound", {
    method: "POST",
    body: {
      ...body,
      client_id: body.client_id || generateClientId("ch"),
    },
    signal,
  });
}

export async function fetchChannelOutbound(
  signalOrParams?:
    | AbortSignal
    | { limit?: number; channel_id?: string; scope?: "mine" | "tenant" },
  signalArg?: AbortSignal,
): Promise<ChannelOutboundPage> {
  const signal = isAbortSignal(signalOrParams) ? signalOrParams : signalArg;
  const params = isAbortSignal(signalOrParams) ? undefined : signalOrParams;
  const sp = new URLSearchParams();
  if (params?.limit !== undefined) sp.set("limit", String(params.limit));
  if (params?.channel_id) sp.set("channel_id", params.channel_id);
  if (params?.scope) sp.set("scope", params.scope);
  const qs = sp.toString();

  const res = await apiFetch<ChannelOutboundPage | ChannelOutboundReceipt[]>(
    `/v1/channels/outbound${qs ? `?${qs}` : ""}`,
    { signal },
  );
  if (Array.isArray(res)) {
    return { items: res };
  }
  return { items: Array.isArray(res?.items) ? res.items : [] };
}
