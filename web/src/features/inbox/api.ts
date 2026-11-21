import { apiFetch, fetchBrief } from "@/lib/api-client";
import type {
  BriefResponse,
  ChatRoom,
  ChatRoomPage,
  HistoryPage,
  TurnResult,
} from "@/lib/types";

/**
 * Formats a Date into a timezone-aware ISO-8601 string using the browser's local offset
 * (e.g. "2026-11-21T00:00:00+08:00"), satisfying FastAPI Pydantic AwareDatetime strictly.
 */
export function formatLocalOffsetIso(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const absOffset = Math.abs(offsetMin);
  const offH = pad(Math.floor(absOffset / 60));
  const offM = pad(absOffset % 60);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${offH}:${offM}`;
}

export function fetchHistoryPage(
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
  return apiFetch<HistoryPage>(`/v1/workbench/history${q ? `?${q}` : ""}`, {
    signal,
  });
}

export function fetchHistoryEntry(identifier: string, signal?: AbortSignal) {
  return apiFetch<TurnResult>(
    `/v1/workbench/history/${encodeURIComponent(identifier)}`,
    { signal },
  );
}

export function fetchWorkbenchBriefForRange(
  windowDays: 1 | 7 = 1,
  signal?: AbortSignal,
): Promise<BriefResponse> {
  const now = new Date();
  const start = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    0,
    0,
    0,
  );
  const end = new Date(start.getTime() + windowDays * 86_400_000);
  return fetchBrief(
    formatLocalOffsetIso(start),
    formatLocalOffsetIso(end),
    signal,
  );
}

export function fetchChatRooms(
  params?: { limit?: number; after?: string },
  signal?: AbortSignal,
) {
  const sp = new URLSearchParams();
  if (params?.limit) sp.set("limit", String(params.limit));
  if (params?.after) sp.set("after", params.after);
  const q = sp.toString();
  return apiFetch<ChatRoomPage>(`/v1/chat/rooms${q ? `?${q}` : ""}`, {
    signal,
  });
}

export function createChatRoom(body: { client_id: string; title: string }) {
  return apiFetch<ChatRoom>("/v1/chat/rooms", {
    method: "POST",
    body,
  });
}
