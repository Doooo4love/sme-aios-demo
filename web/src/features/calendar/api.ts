import { apiFetch } from "@/lib/api-client";
import type {
  CalendarEvent,
  CalendarEventDetail,
  CalendarEventPage,
} from "@/lib/types";

export function toLocalOffsetIso(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const absOffset = Math.abs(offsetMin);
  const offH = pad(Math.floor(absOffset / 60));
  const offM = pad(absOffset % 60);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${offH}:${offM}`;
}

export function toDateTimeLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function dateTimeLocalToOffsetIso(localValue: string): string | null {
  if (!localValue) return null;
  const parsed = new Date(localValue);
  if (Number.isNaN(parsed.getTime())) return null;
  return toLocalOffsetIso(parsed);
}

export function getNextRoundedSlot(durationMinutes = 60): {
  start: Date;
  end: Date;
} {
  const start = new Date();
  start.setMinutes(0, 0, 0);
  start.setHours(start.getHours() + 1);
  // Guarantee safely in the future even if just before the hour boundary
  if (start.getTime() - Date.now() < 15 * 60_000) {
    start.setHours(start.getHours() + 1);
  }
  const end = new Date(start.getTime() + durationMinutes * 60_000);
  return { start, end };
}

export interface CreateCalendarEventInput {
  client_id: string;
  title: string;
  starts_at: string;
  ends_at: string;
  attendees?: string[];
  room_id?: string | null;
}

export interface RescheduleCalendarEventInput {
  title: string;
  starts_at: string;
  ends_at: string;
  revision: number;
}

export function fetchCalendarEvents(
  params: {
    start: string;
    end: string;
    limit?: number;
    after_start?: number;
    after_id?: string;
  },
  signal?: AbortSignal,
) {
  const sp = new URLSearchParams({
    start: params.start,
    end: params.end,
  });
  if (params.limit) sp.set("limit", String(params.limit));
  if (params.after_start !== undefined && params.after_id) {
    sp.set("after_start", String(params.after_start));
    sp.set("after_id", params.after_id);
  }
  return apiFetch<CalendarEventPage>(`/v1/calendar/events?${sp.toString()}`, {
    signal,
  });
}

export function fetchCalendarEventDetail(id: string, signal?: AbortSignal) {
  return apiFetch<CalendarEventDetail>(
    `/v1/calendar/events/${encodeURIComponent(id)}`,
    { signal },
  );
}

export function createCalendarEvent(body: CreateCalendarEventInput) {
  return apiFetch<CalendarEvent>("/v1/calendar/events", {
    method: "POST",
    body,
  });
}

export function updateCalendarEvent(
  id: string,
  body: RescheduleCalendarEventInput,
) {
  return apiFetch<CalendarEvent>(
    `/v1/calendar/events/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      body,
    },
  );
}

export function cancelCalendarEvent(id: string, revision: number) {
  return apiFetch<CalendarEvent>(
    `/v1/calendar/events/${encodeURIComponent(id)}/cancel`,
    {
      method: "POST",
      body: { revision },
    },
  );
}
