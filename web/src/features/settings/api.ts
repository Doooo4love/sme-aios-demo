import { ApiError, apiFetch, isApiError } from "@/lib/api-client";
import { DEFAULT_LOCALE, translateInline, type Locale } from "@/lib/i18n";
import type {
  Profile,
  UserMemoryForgetResponse,
  UserMemoryState,
  UserMemoryTidyResponse,
  UserMemoryUpdatePayload,
} from "@/lib/types";

export type ProfileKind = "user" | "agent";

export const MAX_AVATAR_BYTES = 2 * 1024 * 1024; // 2 MiB strict backend limit
export const ALLOWED_AVATAR_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

function basePathFor(kind: ProfileKind): string {
  return kind === "agent" ? "/v1/agent-profile" : "/v1/profile";
}

export function patchProfileDisplayName(
  kind: ProfileKind,
  version: number,
  displayName: string | null,
) {
  return apiFetch<Profile>(basePathFor(kind), {
    method: "PATCH",
    body: {
      version,
      display_name: displayName,
    },
  });
}

export async function uploadProfileAvatar(
  kind: ProfileKind,
  version: number,
  file: File,
): Promise<Profile> {
  const bytes = await file.arrayBuffer();
  const sp = new URLSearchParams({ version: String(version) });
  return apiFetch<Profile>(`${basePathFor(kind)}/avatar?${sp.toString()}`, {
    method: "PUT",
    rawBody: bytes,
    contentType: "application/octet-stream",
  });
}

export function deleteProfileAvatar(kind: ProfileKind, version: number) {
  const sp = new URLSearchParams({ version: String(version) });
  return apiFetch<Profile>(`${basePathFor(kind)}/avatar?${sp.toString()}`, {
    method: "DELETE",
  });
}

export function validateAvatarFile(
  file: File,
  locale: Locale = DEFAULT_LOCALE,
): string | null {
  if (file.size <= 0) {
    return translateInline(locale, {
      "zh-CN": "所选图片文件为空，请重新选择。",
      "zh-HK": "所選圖片檔案為空，請重新選擇。",
      en: "The selected image file is empty. Please choose another file.",
    });
  }
  if (file.size > MAX_AVATAR_BYTES) {
    return translateInline(locale, {
      "zh-CN": "头像文件不能超过 2 MiB，请压缩后再上传。",
      "zh-HK": "頭像檔案不能超過 2 MiB，請壓縮後再上傳。",
      en: "Avatar file cannot exceed 2 MiB. Please compress and try again.",
    });
  }
  const type = (file.type || "").toLowerCase();
  const name = file.name.toLowerCase();
  const extOk =
    name.endsWith(".png") ||
    name.endsWith(".jpg") ||
    name.endsWith(".jpeg") ||
    name.endsWith(".webp");
  if (!ALLOWED_AVATAR_MIME_TYPES.has(type) && !extOk) {
    return translateInline(locale, {
      "zh-CN": "仅支持 PNG、JPEG 或 WEBP 格式的静态图片。",
      "zh-HK": "僅支援 PNG、JPEG 或 WEBP 格式的靜態圖片。",
      en: "Only static PNG, JPEG, or WEBP images are supported.",
    });
  }
  return null;
}

export class MemoryApiError extends ApiError {
  readonly detail: string | null;
  readonly reason: string | null;

  constructor(
    base: ApiError,
    code: string,
    message: string,
    detail: string | null,
    reason: string | null,
  ) {
    super(
      {
        status: base.status,
        code,
        message,
        requestId: base.requestId,
        retryAfter: base.retryAfter,
        fieldErrors: base.fieldErrors,
        nextStep: base.nextStep,
        viewProposalId: base.viewProposalId,
        allowedActions: base.allowedActions,
        warehouses: base.warehouses,
        runId: base.runId,
      },
      base.rawDetail,
    );
    this.name = "MemoryApiError";
    this.detail = detail;
    this.reason = reason;
  }
}

export function isMemoryApiError(error: unknown): error is MemoryApiError {
  return error instanceof MemoryApiError;
}

function toMemoryApiError(error: unknown): unknown {
  if (!isApiError(error)) {
    return error;
  }
  const raw = error.rawDetail;
  let code = error.code;
  let detail: string | null = null;
  let reason: string | null = null;

  if (typeof raw === "string" && raw.trim().length > 0) {
    detail = raw.trim();
  } else if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.code === "string" && obj.code.trim().length > 0) {
      code = obj.code.trim();
    }
    if (typeof obj.reason === "string" && obj.reason.trim().length > 0) {
      reason = obj.reason.trim();
    }
    if (typeof obj.detail === "string" && obj.detail.trim().length > 0) {
      detail = obj.detail.trim();
    } else if (
      typeof obj.message === "string" &&
      obj.message.trim().length > 0
    ) {
      detail = obj.message.trim();
    }
  }

  const preferredMessage = reason || detail || error.message;
  return new MemoryApiError(error, code, preferredMessage, detail, reason);
}

async function runMemoryRequest<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toMemoryApiError(err);
  }
}

export function fetchUserMemory(signal?: AbortSignal): Promise<UserMemoryState> {
  return runMemoryRequest(() =>
    apiFetch<UserMemoryState>("/v1/memory", { signal }),
  );
}

export function updateUserMemory(
  payload: UserMemoryUpdatePayload,
): Promise<UserMemoryState> {
  return runMemoryRequest(() =>
    apiFetch<UserMemoryState>("/v1/memory", {
      method: "PUT",
      body: {
        version: payload.version,
        content: payload.content,
      },
    }),
  );
}

export function revertUserMemory(version: number): Promise<UserMemoryState> {
  return runMemoryRequest(() =>
    apiFetch<UserMemoryState>("/v1/memory/revert", {
      method: "POST",
      body: { version },
    }),
  );
}

export function tidyUserMemory(
  useLlm = false,
): Promise<UserMemoryTidyResponse> {
  return runMemoryRequest(() =>
    apiFetch<UserMemoryTidyResponse>("/v1/memory/tidy", {
      method: "POST",
      body: { use_llm: useLlm },
    }),
  );
}

export function forgetUserMemory(
  query: string,
): Promise<UserMemoryForgetResponse> {
  return runMemoryRequest(() =>
    apiFetch<UserMemoryForgetResponse>("/v1/memory/forget", {
      method: "POST",
      body: { query },
    }),
  );
}

export function clearUserMemory(version: number): Promise<UserMemoryState> {
  const sp = new URLSearchParams({ version: String(version) });
  return runMemoryRequest(() =>
    apiFetch<UserMemoryState>(`/v1/memory?${sp.toString()}`, {
      method: "DELETE",
    }),
  );
}
