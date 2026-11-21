import { NextRequest } from "next/server";
import { z } from "zod";
import {
  getApiBaseUrl,
  isValidBrowserOrigin,
  makeOriginRejectedResponse,
} from "@/lib/bff/config";
import { resolveTenantContacts, verifyLiveActor } from "@/lib/bff/directory";
import { sanitizeErrorPayload } from "@/lib/bff/sanitize";
import { syncExternalCalendars } from "@/lib/mcp/connectors";
import { isValidZoomJoinUrl } from "@/lib/mcp/ics";
import type {
  CalendarEventDetail,
  CalendarSyncResponse,
  ExternalCalendarTarget,
} from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CalendarSyncSchema = z
  .object({
    calendar_targets: z
      .array(z.enum(["google", "icloud", "outlook"]))
      .min(1)
      .max(3)
      .optional(),
    event_id: z.string().trim().min(1).max(128).optional(),
    join_url: z.string().trim().max(260).nullable().optional(),
    timezone: z.string().trim().max(64).optional(),
  })
  .strict();

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  if (!isValidBrowserOrigin(req)) {
    return makeOriginRejectedResponse();
  }

  const verified = await verifyLiveActor(req);
  if (!verified.ok) {
    return verified.response;
  }

  const { actor, cookie } = verified;

  let rawBody: unknown = {};
  try {
    rawBody = await req.json();
  } catch {
    return jsonResponse(
      { detail: { code: "INVALID_REQUEST", message: "请求体格式无效。" } },
      422,
    );
  }

  const parsed = CalendarSyncSchema.safeParse(rawBody);
  if (!parsed.success) {
    return jsonResponse(
      { detail: { code: "INVALID_REQUEST", message: "日历同步参数无效。" } },
      422,
    );
  }

  const targets: ExternalCalendarTarget[] = parsed.data.calendar_targets ?? [
    "google",
    "icloud",
    "outlook",
  ];
  const timezone = parsed.data.timezone || "Asia/Shanghai";
  const safeJoinUrl =
    parsed.data.join_url && isValidZoomJoinUrl(parsed.data.join_url)
      ? parsed.data.join_url
      : null;

  const apiBase = getApiBaseUrl();
  let targetEvent: CalendarEventDetail | null = null;

  if (parsed.data.event_id) {
    const evRes = await fetch(
      `${apiBase}/v1/calendar/events/${encodeURIComponent(parsed.data.event_id)}`,
      {
        method: "GET",
        headers: { Cookie: cookie, Accept: "application/json" },
        cache: "no-store",
      },
    );
    const evText = await evRes.text();
    let evParsed: unknown = null;
    try {
      evParsed = evText ? JSON.parse(evText) : null;
    } catch {
      evParsed = evText;
    }
    if (!evRes.ok) {
      return jsonResponse(sanitizeErrorPayload(evRes.status, evParsed), evRes.status);
    }
    targetEvent = evParsed as CalendarEventDetail;
  } else {
    // Sync next upcoming internal event if no specific event_id provided
    const now = new Date();
    const end = new Date(now.getTime() + 30 * 86_400_000);
    const sp = new URLSearchParams({
      start: now.toISOString(),
      end: end.toISOString(),
      limit: "1",
    });
    const listRes = await fetch(`${apiBase}/v1/calendar/events?${sp.toString()}`, {
      method: "GET",
      headers: { Cookie: cookie, Accept: "application/json" },
      cache: "no-store",
    });
    if (listRes.ok) {
      const listData = (await listRes.json()) as { items?: CalendarEventDetail[] };
      if (Array.isArray(listData.items) && listData.items.length > 0) {
        targetEvent = listData.items[0]!;
      }
    }
  }

  const directory = await resolveTenantContacts(actor, cookie, {
    includeSelf: true,
    limit: 50,
  });
  const contactMap = new Map(directory.items.map((c) => [c.subject, c]));

  const startsAtIso = targetEvent
    ? new Date(targetEvent.starts_at * 1000).toISOString()
    : new Date(Date.now() + 3600_000).toISOString();
  const endsAtIso = targetEvent
    ? new Date(targetEvent.ends_at * 1000).toISOString()
    : new Date(Date.now() + 7200_000).toISOString();

  const attendeeList = (targetEvent?.attendees ?? [])
    .filter((sub) => sub !== actor.subject)
    .map((sub) => {
      const c = contactMap.get(sub);
      return {
        email: c?.email || `${sub}@${actor.tenant}.local`,
        displayName: c?.display_name || sub,
      };
    });

  const results = await syncExternalCalendars(targets, {
    title: targetEvent?.title || "AIOS 日程同步",
    startsAtIso,
    endsAtIso,
    timezone,
    location: safeJoinUrl || "AIOS 站内协作日历",
    description: safeJoinUrl
      ? `AIOS 站内日程同步\nZoom 链接: ${safeJoinUrl}`
      : "AIOS 站内日程同步",
    attendees: attendeeList,
  });

  const syncedCount = results.filter((r) => r.status === "synced").length;
  const syncMode: CalendarSyncResponse["sync_mode"] =
    syncedCount === results.length
      ? "live_mcp"
      : syncedCount > 0
        ? "partial"
        : "sandbox_ready";

  const icsDownloadUrl = targetEvent
    ? `/api/calendar/ics?event_id=${encodeURIComponent(targetEvent.id)}${safeJoinUrl ? `&join_url=${encodeURIComponent(safeJoinUrl)}` : ""}`
    : "/api/calendar/ics";

  const responseBody: CalendarSyncResponse = {
    tenant: actor.tenant,
    event_id: targetEvent?.id ?? null,
    sync_mode: syncMode,
    results,
    ics_download_url: icsDownloadUrl,
  };

  return jsonResponse(responseBody, 200);
}
