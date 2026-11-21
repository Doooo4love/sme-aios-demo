import { NextRequest } from "next/server";
import { getApiBaseUrl } from "@/lib/bff/config";
import { resolveTenantContacts, verifyLiveActor } from "@/lib/bff/directory";
import { sanitizeErrorPayload } from "@/lib/bff/sanitize";
import {
  buildCalendarIcs,
  isValidZoomJoinUrl,
  type IcsEventInput,
} from "@/lib/mcp/ics";
import type { CalendarEventDetail, CalendarEventPage } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_RANGE_MS = 92 * 86_400_000; // Stay strictly <= 93-day FastAPI calendar limit

export async function GET(req: NextRequest): Promise<Response> {
  const verified = await verifyLiveActor(req);
  if (!verified.ok) {
    return verified.response;
  }

  const { actor, cookie } = verified;
  const apiBase = getApiBaseUrl();
  const sp = req.nextUrl.searchParams;
  const eventId = sp.get("event_id")?.trim() || null;

  // Resolve tenant contacts for nice ATTENDEE CN/email fields
  const directory = await resolveTenantContacts(actor, cookie, {
    includeSelf: true,
    limit: 50,
  });
  const contactMap = new Map(directory.items.map((c) => [c.subject, c]));

  // Mode 1: Single Event Export
  if (eventId) {
    const rawJoinUrl = sp.get("join_url")?.trim() || null;
    const rawPasscode = sp.get("passcode")?.trim() || null;
    const safeJoinUrl =
      rawJoinUrl && isValidZoomJoinUrl(rawJoinUrl) ? rawJoinUrl : null;

    let evRes: Response;
    try {
      evRes = await fetch(
        `${apiBase}/v1/calendar/events/${encodeURIComponent(eventId)}`,
        {
          method: "GET",
          headers: { Cookie: cookie, Accept: "application/json" },
          cache: "no-store",
          signal: AbortSignal.timeout(4000),
        },
      );
    } catch {
      return new Response(
        JSON.stringify({
          detail: {
            code: "UPSTREAM_UNAVAILABLE",
            message: "日历服务暂不可用，请稍后重试。",
          },
        }),
        {
          status: 503,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          },
        },
      );
    }

    const rawText = await evRes.text();
    let parsed: unknown = null;
    try {
      parsed = rawText ? JSON.parse(rawText) : null;
    } catch {
      parsed = rawText;
    }

    if (!evRes.ok) {
      return new Response(
        JSON.stringify(sanitizeErrorPayload(evRes.status, parsed)),
        {
          status: evRes.status,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          },
        },
      );
    }

    const detail = parsed as CalendarEventDetail;
    const icsEvent: IcsEventInput = {
      id: detail.id,
      tenant: actor.tenant,
      title: detail.title,
      organizer: detail.organizer,
      starts_at: detail.starts_at,
      ends_at: detail.ends_at,
      revision: detail.revision,
      cancelled: detail.cancelled,
      joinUrl: safeJoinUrl,
      passcode: rawPasscode,
      attendees: (detail.attendees ?? []).map((sub) => {
        const c = contactMap.get(sub);
        return {
          subject: sub,
          displayName: c?.display_name || sub,
          email: c?.email || `${sub}@${actor.tenant}.local`,
        };
      }),
    };

    const icsText = buildCalendarIcs([icsEvent], {
      calendarName: `AIOS · ${detail.title}`,
    });
    const safeFileId = detail.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "event";

    return new Response(icsText, {
      status: 200,
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": `attachment; filename="aios-meeting-${safeFileId}.ics"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  // Mode 2: Range Export (default: now - 7d to now + 60d, clamped <= 92d)
  const nowMs = Date.now();
  const rawStart = sp.get("start");
  const rawEnd = sp.get("end");
  const parsedStartMs = rawStart ? Date.parse(rawStart) : nowMs - 7 * 86_400_000;
  let startMs = Number.isFinite(parsedStartMs) ? parsedStartMs : nowMs - 7 * 86_400_000;
  const parsedEndMs = rawEnd ? Date.parse(rawEnd) : nowMs + 60 * 86_400_000;
  let endMs = Number.isFinite(parsedEndMs) ? parsedEndMs : nowMs + 60 * 86_400_000;

  if (endMs <= startMs) {
    endMs = startMs + 30 * 86_400_000;
  }
  if (endMs - startMs > MAX_RANGE_MS) {
    endMs = startMs + MAX_RANGE_MS;
  }

  const startIso = new Date(startMs).toISOString();
  const endIso = new Date(endMs).toISOString();

  const collected: IcsEventInput[] = [];
  let cursorStart: number | undefined;
  let cursorId: string | undefined;

  for (let pageIdx = 0; pageIdx < 5; pageIdx += 1) {
    const query = new URLSearchParams({
      start: startIso,
      end: endIso,
      limit: "100",
    });
    if (cursorStart !== undefined && cursorId) {
      query.set("after_start", String(cursorStart));
      query.set("after_id", cursorId);
    }

    let listRes: Response;
    try {
      listRes = await fetch(`${apiBase}/v1/calendar/events?${query.toString()}`, {
        method: "GET",
        headers: { Cookie: cookie, Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(4000),
      });
    } catch {
      return new Response(
        JSON.stringify({
          detail: {
            code: "UPSTREAM_UNAVAILABLE",
            message: "日历服务暂不可用，请稍后重试。",
          },
        }),
        {
          status: 503,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          },
        },
      );
    }

    const rawText = await listRes.text();
    let parsed: unknown = null;
    try {
      parsed = rawText ? JSON.parse(rawText) : null;
    } catch {
      parsed = rawText;
    }

    if (!listRes.ok) {
      return new Response(
        JSON.stringify(sanitizeErrorPayload(listRes.status, parsed)),
        {
          status: listRes.status,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          },
        },
      );
    }

    const page = parsed as CalendarEventPage;
    for (const item of page.items ?? []) {
      collected.push({
        id: item.id,
        tenant: actor.tenant,
        title: item.title,
        organizer: item.organizer,
        starts_at: item.starts_at,
        ends_at: item.ends_at,
        revision: item.revision,
        cancelled: item.cancelled,
      });
    }

    if (!page.next) break;
    cursorStart = page.next.after_start;
    cursorId = page.next.after_id;
  }

  const icsText = buildCalendarIcs(collected, {
    calendarName: `AIOS 企业日程 (${actor.tenant})`,
  });

  return new Response(icsText, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'attachment; filename="aios-calendar.ics"',
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
