import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { z } from "zod";
import {
  getApiBaseUrl,
  getBrowserOrigin,
  isValidBrowserOrigin,
  makeOriginRejectedResponse,
} from "@/lib/bff/config";
import { resolveTenantContacts, verifyLiveActor } from "@/lib/bff/directory";
import { sanitizeErrorPayload } from "@/lib/bff/sanitize";
import {
  LOCALE_COOKIE_NAME,
  encodeMeetingBookedMessage,
  localizeZoomStatusLabel,
  normalizeLocale,
  type Locale,
} from "@/lib/i18n";
import {
  createZoomMeeting,
  getMcpConnectorsStatus,
  getZoomPreviewMode,
  isZoomConfigured,
  syncExternalCalendars,
} from "@/lib/mcp/connectors";
import { parseNaturalLanguageMeeting } from "@/lib/mcp/nl-meeting";
import type {
  BookedCalendarEvent,
  CalendarEventDetail,
  ChatRoom,
  ExternalCalendarTarget,
  ZoomBookingConfirmResponse,
  ZoomBookingPreviewResponse,
  ZoomMeetingResult,
} from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CalendarTargetSchema = z.enum(["google", "icloud", "outlook"]);

const ParseOrPreviewSchema = z.object({
  action: z.enum(["parse", "preview"]),
  utterance: z.string().trim().min(1, "请输入会议描述").max(400),
  timezone: z.string().trim().max(64).optional(),
  tz_offset_minutes: z.number().int().min(-840).max(840).optional(),
  room_id: z.string().trim().max(128).nullable().optional(),
  default_calendar_targets: z.array(CalendarTargetSchema).max(3).optional(),
  now_iso: z.string().trim().max(64).optional(),
});

const ConfirmSchema = z.object({
  action: z.literal("confirm"),
  client_id: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,64}$/, "无效的请求幂等标识"),
  title: z
    .string()
    .trim()
    .min(1, "请输入会议主题")
    .max(120, "会议主题不能超过 120 个字符")
    .refine((v) => !/[\x00-\x1f\x7f]/.test(v), "会议主题包含不可打印字符"),
  starts_at: z.string().trim().min(10).max(64),
  ends_at: z.string().trim().min(10).max(64),
  timezone: z.string().trim().max(64).optional(),
  attendees: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
  room_id: z.string().trim().max(128).nullable().optional(),
  create_zoom: z.boolean().optional(),
  notify_room: z.boolean().optional(),
  calendar_targets: z.array(CalendarTargetSchema).max(3).optional(),
});

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function shortHash(seed: string): string {
  return createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 24);
}

const VALID_REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const VALID_TRACEPARENT_RE = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

function buildTraceHeaders(req: NextRequest): Record<string, string> {
  const headers: Record<string, string> = {};
  const reqId = req.headers.get("x-request-id")?.trim() ?? "";
  if (VALID_REQUEST_ID_RE.test(reqId)) {
    headers["X-Request-ID"] = reqId;
  }
  const tp = req.headers.get("traceparent")?.trim() ?? "";
  if (VALID_TRACEPARENT_RE.test(tp)) {
    headers.traceparent = tp;
  }
  return headers;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildReserveConflictDetail(
  parsed: unknown,
  locale: Locale,
): { code: string; message: string } {
  const rawDetail = isPlainRecord(parsed) ? parsed.detail : parsed;
  const code =
    isPlainRecord(rawDetail) && typeof rawDetail.code === "string"
      ? rawDetail.code
      : "";
  const rawMsg =
    isPlainRecord(rawDetail) && typeof rawDetail.message === "string"
      ? rawDetail.message
      : typeof rawDetail === "string"
        ? rawDetail
        : "";

  if (
    code === "IDEMPOTENCY_CONFLICT" ||
    rawMsg.includes("different request payload")
  ) {
    return {
      code: "IDEMPOTENCY_CONFLICT",
      message:
        locale === "en"
          ? "This meeting booking ID is already bound to a different meeting payload."
          : locale === "zh-HK"
            ? "此會議預約編號已綁定至另一組會議內容。"
            : "此会议预约标识已绑定至另一组会议内容。",
    };
  }
  if (code === "OUTCOME_UNKNOWN" || rawMsg.includes("UNKNOWN")) {
    return {
      code: "OUTCOME_UNKNOWN",
      message:
        locale === "en"
          ? "Previous Zoom booking outcome is UNKNOWN; manual verification is required before retry."
          : locale === "zh-HK"
            ? "上次會議預約結果未知，須人工核實後再重試。"
            : "上次会议预约结果未知，需人工核实后再重试。",
    };
  }
  return {
    code: "DISPATCH_IN_PROGRESS",
    message:
      locale === "en"
        ? "This Zoom meeting booking is already in progress."
        : locale === "zh-HK"
          ? "此會議預約請求正在處理中，請勿重複提交。"
          : "该会议预约请求正在处理中，请勿重复提交。",
  };
}

interface OutboxReserveSuccess {
  status: "reserved" | "replay";
  outbox_id: string;
  attempt: number;
  cached_result: unknown;
}

async function reserveZoomOutbox(params: {
  apiBase: string;
  browserOrigin: string;
  cookie: string;
  csrfToken: string;
  traceHeaders: Record<string, string>;
  clientId: string;
  requestSha256: string;
  locale: Locale;
}): Promise<
  | { ok: true; data: OutboxReserveSuccess }
  | { ok: false; response: Response }
> {
  let res: Response;
  try {
    res = await fetch(
      `${params.apiBase}/v1/workbench/external-outbox/reserve`,
      {
        method: "POST",
        headers: {
          Cookie: params.cookie,
          "X-CSRF-Token": params.csrfToken,
          Origin: params.browserOrigin,
          "Content-Type": "application/json",
          Accept: "application/json",
          ...params.traceHeaders,
        },
        body: JSON.stringify({
          action_kind: "zoom.book",
          client_id: params.clientId,
          request_sha256: params.requestSha256,
          lease_s: 60,
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(4000),
      },
    );
  } catch {
    return {
      ok: false,
      response: jsonResponse(
        {
          detail: {
            code: "UPSTREAM_UNAVAILABLE",
            message:
              params.locale === "en"
                ? "Booking outbox reservation service is temporarily unavailable."
                : params.locale === "zh-HK"
                  ? "會議預約預留服務暫不可用，請稍後重試。"
                  : "会议预约预留服务暂不可用，请稍后重试。",
          },
        },
        503,
      ),
    };
  }

  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  if (res.status === 409) {
    return {
      ok: false,
      response: jsonResponse(
        { detail: buildReserveConflictDetail(parsed, params.locale) },
        409,
      ),
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      response: jsonResponse(sanitizeErrorPayload(res.status, parsed), res.status),
    };
  }

  if (!isPlainRecord(parsed) || typeof parsed.outbox_id !== "string") {
    return {
      ok: false,
      response: jsonResponse(
        {
          detail: {
            code: "UPSTREAM_UNAVAILABLE",
            message: "会议预约预留响应无效，请稍后重试。",
          },
        },
        503,
      ),
    };
  }

  return {
    ok: true,
    data: {
      status: parsed.status === "replay" ? "replay" : "reserved",
      outbox_id: parsed.outbox_id,
      attempt: typeof parsed.attempt === "number" ? parsed.attempt : 1,
      cached_result: parsed.cached_result ?? null,
    },
  };
}

async function finalizeZoomOutbox(params: {
  apiBase: string;
  browserOrigin: string;
  cookie: string;
  csrfToken: string;
  traceHeaders: Record<string, string>;
  outboxId: string;
  state: "SUCCEEDED" | "FAILED" | "UNKNOWN";
  externalId?: string | null;
  result?: Record<string, unknown> | null;
}): Promise<boolean> {
  try {
    const res = await fetch(
      `${params.apiBase}/v1/workbench/external-outbox/${encodeURIComponent(params.outboxId)}/finalize`,
      {
        method: "POST",
        headers: {
          Cookie: params.cookie,
          "X-CSRF-Token": params.csrfToken,
          Origin: params.browserOrigin,
          "Content-Type": "application/json",
          Accept: "application/json",
          ...params.traceHeaders,
        },
        body: JSON.stringify({
          state: params.state,
          external_id: params.externalId ?? null,
          result: params.result ?? null,
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(4000),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}

async function resolveOrCreateMeetingRoom(params: {
  apiBase: string;
  browserOrigin: string;
  cookie: string;
  csrfToken: string;
  traceHeaders: Record<string, string>;
  actorSubject: string;
  otherAttendees: string[];
  requestedRoomId: string | null;
  clientId: string;
  title: string;
}): Promise<{ ok: true; roomId: string } | { ok: false; response: Response }> {
  const {
    apiBase,
    browserOrigin,
    cookie,
    csrfToken,
    traceHeaders,
    actorSubject,
    otherAttendees,
    requestedRoomId,
    clientId,
    title,
  } = params;

  const admitMembers = async (roomId: string, missing: string[]) => {
    for (const sub of missing) {
      const admitRes = await fetch(
        `${apiBase}/v1/chat/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(sub)}`,
        {
          method: "PUT",
          headers: {
            Cookie: cookie,
            "X-CSRF-Token": csrfToken,
            Origin: browserOrigin,
            "Content-Type": "application/json",
            Accept: "application/json",
            ...traceHeaders,
          },
          body: JSON.stringify({ active: true }),
          cache: "no-store",
        },
      );
      if (!admitRes.ok) {
        const text = await admitRes.text();
        let parsed: unknown = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          parsed = text;
        }
        return {
          ok: false as const,
          response: jsonResponse(
            sanitizeErrorPayload(admitRes.status, parsed),
            admitRes.status,
          ),
        };
      }
    }
    return { ok: true as const };
  };

  // Case A: Explicit room_id supplied
  if (requestedRoomId) {
    const memRes = await fetch(
      `${apiBase}/v1/chat/rooms/${encodeURIComponent(requestedRoomId)}/members?limit=50`,
      {
        method: "GET",
        headers: { Cookie: cookie, Accept: "application/json", ...traceHeaders },
        cache: "no-store",
      },
    );
    if (!memRes.ok) {
      const text = await memRes.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      return {
        ok: false,
        response: jsonResponse(sanitizeErrorPayload(memRes.status, parsed), memRes.status),
      };
    }
    const memData = (await memRes.json()) as { items?: string[] };
    const existingMembers = new Set(Array.isArray(memData.items) ? memData.items : []);
    const missing = otherAttendees.filter((sub) => !existingMembers.has(sub));
    if (missing.length > 0) {
      const admitted = await admitMembers(requestedRoomId, missing);
      if (!admitted.ok) return admitted;
    }
    return { ok: true, roomId: requestedRoomId };
  }

  // Case B: Search existing rooms containing all required participants
  try {
    const roomsRes = await fetch(`${apiBase}/v1/chat/rooms?limit=50`, {
      method: "GET",
      headers: { Cookie: cookie, Accept: "application/json", ...traceHeaders },
      cache: "no-store",
      signal: AbortSignal.timeout(2500),
    });
    if (roomsRes.ok) {
      const roomsData = (await roomsRes.json()) as { items?: ChatRoom[] };
      const rooms = Array.isArray(roomsData.items) ? roomsData.items.slice(0, 25) : [];
      const required = new Set([actorSubject, ...otherAttendees]);
      let fallbackRoomId: string | null = null;

      for (const room of rooms) {
        const memRes = await fetch(
          `${apiBase}/v1/chat/rooms/${encodeURIComponent(room.id)}/members?limit=50`,
          {
            method: "GET",
            headers: { Cookie: cookie, Accept: "application/json", ...traceHeaders },
            cache: "no-store",
            signal: AbortSignal.timeout(1500),
          },
        );
        if (!memRes.ok) continue;
        const memData = (await memRes.json()) as { items?: string[] };
        const members = Array.isArray(memData.items) ? memData.items : [];
        const memSet = new Set(members);
        const containsAll = Array.from(required).every((s) => memSet.has(s));
        if (!containsAll) continue;

        // Exact 1:1 DM room preferred for single colleague meetings
        if (otherAttendees.length === 1 && members.length === 2) {
          return { ok: true, roomId: room.id };
        }
        if (!fallbackRoomId) {
          fallbackRoomId = room.id;
        }
      }

      if (fallbackRoomId) {
        return { ok: true, roomId: fallbackRoomId };
      }
    }
  } catch {
    // Fall through to idempotent room creation
  }

  // Case C: Create a dedicated meeting room idempotently with locale-neutral prefix (P0-2)
  const roomClientId = `zrm_${shortHash(clientId)}`;
  const roomTitle = `Meeting · ${title}`.slice(0, 100);
  const createRes = await fetch(`${apiBase}/v1/chat/rooms`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      "X-CSRF-Token": csrfToken,
      Origin: browserOrigin,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...traceHeaders,
    },
    body: JSON.stringify({ client_id: roomClientId, title: roomTitle }),
    cache: "no-store",
  });

  const createText = await createRes.text();
  let createParsed: unknown = null;
  try {
    createParsed = createText ? JSON.parse(createText) : null;
  } catch {
    createParsed = createText;
  }

  if (!createRes.ok) {
    return {
      ok: false,
      response: jsonResponse(
        sanitizeErrorPayload(createRes.status, createParsed),
        createRes.status,
      ),
    };
  }

  const createdRoom = createParsed as ChatRoom;
  const admitted = await admitMembers(createdRoom.id, otherAttendees);
  if (!admitted.ok) return admitted;

  return { ok: true, roomId: createdRoom.id };
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
  const locale: Locale = normalizeLocale(
    req.cookies.get(LOCALE_COOKIE_NAME)?.value,
  );

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return jsonResponse(
      { detail: { code: "INVALID_REQUEST", message: "请求体格式无效。" } },
      422,
    );
  }

  const action =
    typeof rawBody === "object" && rawBody !== null && "action" in rawBody
      ? (rawBody as { action?: unknown }).action
      : null;

  // =========================================================================
  // Phase 1: Parse / Preview (Zero Side Effects)
  // =========================================================================
  if (action === "parse" || action === "preview") {
    const parsed = ParseOrPreviewSchema.safeParse(rawBody);
    if (!parsed.success) {
      return jsonResponse(
        {
          detail: {
            code: "INVALID_REQUEST",
            message: parsed.error.issues[0]?.message || "请输入有效的会议预约描述。",
          },
        },
        422,
      );
    }

    // Include self so parser strips self-mentions from English/Chinese titles cleanly (M-3)
    const directory = await resolveTenantContacts(actor, cookie, {
      includeSelf: true,
      limit: 50,
      locale,
    });

    const parsedMeeting = parseNaturalLanguageMeeting(
      parsed.data.utterance,
      parsed.data.now_iso,
      directory.items,
      {
        timezone: parsed.data.timezone,
        tzOffsetMinutes: parsed.data.tz_offset_minutes,
        roomId: parsed.data.room_id ?? null,
        defaultCalendarTargets: parsed.data.default_calendar_targets,
        locale,
        selfSubject: actor.subject,
      },
    );

    const responsePayload: ZoomBookingPreviewResponse = {
      phase: "preview",
      draft: parsedMeeting.draft,
      warnings: parsedMeeting.warnings,
      warning_items: parsedMeeting.warningItems,
      zoom_configured: isZoomConfigured(),
      zoom_mode_preview: getZoomPreviewMode(),
      connectors: getMcpConnectorsStatus(locale),
    };

    return jsonResponse(responsePayload, 200);
  }

  // =========================================================================
  // Phase 2: Explicit Confirmation & Transactional Execution
  // =========================================================================
  if (action === "confirm") {
    const csrfToken = req.headers.get("x-csrf-token");
    if (!csrfToken) {
      return jsonResponse(
        {
          detail: {
            code: "CSRF_REJECTED",
            message: "安全校验令牌缺失，请重试。",
          },
        },
        403,
      );
    }

    const parsed = ConfirmSchema.safeParse(rawBody);
    if (!parsed.success) {
      return jsonResponse(
        {
          detail: {
            code: "INVALID_REQUEST",
            message: parsed.error.issues[0]?.message || "会议参数格式不符合要求。",
          },
        },
        422,
      );
    }

    const data = parsed.data;
    const startMs = Date.parse(data.starts_at);
    const endMs = Date.parse(data.ends_at);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      return jsonResponse(
        {
          detail: {
            code: "INVALID_TIME_RANGE",
            message: "会议结束时间必须晚于开始时间。",
          },
        },
        422,
      );
    }
    const durationMs = endMs - startMs;
    if (durationMs > 86_400_000) {
      return jsonResponse(
        {
          detail: {
            code: "INVALID_TIME_RANGE",
            message: "单次会议时长不能超过 24 小时。",
          },
        },
        422,
      );
    }

    // Tenant-scoped attendee validation
    const rawAttendees = Array.from(new Set(data.attendees ?? []));
    const otherAttendees = rawAttendees.filter((sub) => sub !== actor.subject);

    const directory = await resolveTenantContacts(actor, cookie, {
      includeSelf: true,
      limit: 50,
      locale,
    });
    const tenantContactMap = new Map(directory.items.map((c) => [c.subject, c]));

    for (const sub of otherAttendees) {
      if (!tenantContactMap.has(sub)) {
        return jsonResponse(
          {
            detail: {
              code: "INVALID_ATTENDEE",
              message: `参会人 ${sub} 不在当前租户通讯录中。`,
            },
          },
          422,
        );
      }
    }

    const apiBase = getApiBaseUrl();
    const browserOrigin = getBrowserOrigin();
    const traceHeaders = buildTraceHeaders(req);
    const timezone = data.timezone || "Asia/Hong_Kong";
    const wantsZoom = data.create_zoom !== false;
    const calendarTargets: ExternalCalendarTarget[] =
      data.calendar_targets && data.calendar_targets.length > 0
        ? data.calendar_targets
        : ["google", "icloud", "outlook"];

    // Reserve-first atomic external outbox BEFORE mutating rooms/calendar/Zoom!
    const canonicalRequestPayload = JSON.stringify({
      attendees: [...rawAttendees].sort(),
      calendar_targets: [...calendarTargets].sort(),
      create_zoom: wantsZoom,
      ends_at: data.ends_at,
      room_id: data.room_id ?? null,
      starts_at: data.starts_at,
      timezone,
      title: data.title,
    });
    const requestSha256 = createHash("sha256")
      .update(canonicalRequestPayload, "utf8")
      .digest("hex");

    const reservation = await reserveZoomOutbox({
      apiBase,
      browserOrigin,
      cookie,
      csrfToken,
      traceHeaders,
      clientId: data.client_id,
      requestSha256,
      locale,
    });
    if (!reservation.ok) {
      return reservation.response;
    }
    if (reservation.data.status === "replay") {
      return jsonResponse(
        isPlainRecord(reservation.data.cached_result)
          ? reservation.data.cached_result
          : { phase: "confirmed", outbox_id: reservation.data.outbox_id },
        200,
      );
    }
    const outboxId = reservation.data.outbox_id;

    // Step 1: Authorized room resolution for multi-attendee events (calendar.py invariant)
    let resolvedRoomId: string | null = data.room_id ?? null;
    if (otherAttendees.length > 0) {
      if (!actor.grants.includes("chat.use")) {
        await finalizeZoomOutbox({
          apiBase,
          browserOrigin,
          cookie,
          csrfToken,
          traceHeaders,
          outboxId,
          state: "FAILED",
        });
        return jsonResponse(
          {
            detail: {
              code: "CHAT_REQUIRED",
              message: "邀请同事参会需要协作会话权限。",
            },
          },
          403,
        );
      }
      try {
        const roomResolution = await resolveOrCreateMeetingRoom({
          apiBase,
          browserOrigin,
          cookie,
          csrfToken,
          traceHeaders,
          actorSubject: actor.subject,
          otherAttendees,
          requestedRoomId: resolvedRoomId,
          clientId: data.client_id,
          title: data.title,
        });
        if (!roomResolution.ok) {
          await finalizeZoomOutbox({
            apiBase,
            browserOrigin,
            cookie,
            csrfToken,
            traceHeaders,
            outboxId,
            state: "FAILED",
          });
          return roomResolution.response;
        }
        resolvedRoomId = roomResolution.roomId;
      } catch {
        await finalizeZoomOutbox({
          apiBase,
          browserOrigin,
          cookie,
          csrfToken,
          traceHeaders,
          outboxId,
          state: "FAILED",
        });
        return jsonResponse(
          {
            detail: {
              code: "UPSTREAM_UNAVAILABLE",
              message: "协作房间服务暂不可用，请稍后重试。",
            },
          },
          503,
        );
      }
    }

    // Step 2: REAL internal event creation via FastAPI POST /v1/calendar/events (Fail-Fast!)
    const eventPayload: Record<string, unknown> = {
      client_id: data.client_id,
      title: data.title,
      starts_at: data.starts_at,
      ends_at: data.ends_at,
      attendees: otherAttendees,
    };
    if (resolvedRoomId) {
      eventPayload.room_id = resolvedRoomId;
    }

    let calRes: Response;
    try {
      calRes = await fetch(`${apiBase}/v1/calendar/events`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          "X-CSRF-Token": csrfToken,
          Origin: browserOrigin,
          "Content-Type": "application/json",
          Accept: "application/json",
          ...traceHeaders,
        },
        body: JSON.stringify(eventPayload),
        cache: "no-store",
      });
    } catch {
      await finalizeZoomOutbox({
        apiBase,
        browserOrigin,
        cookie,
        csrfToken,
        traceHeaders,
        outboxId,
        state: "FAILED",
      });
      return jsonResponse(
        {
          detail: {
            code: "UPSTREAM_UNAVAILABLE",
            message: "日历服务暂不可用，请稍后重试。",
          },
        },
        503,
      );
    }

    const calText = await calRes.text();
    let calParsed: unknown = null;
    try {
      calParsed = calText ? JSON.parse(calText) : null;
    } catch {
      calParsed = calText;
    }

    if (!calRes.ok) {
      // Fail-fast: NEVER invoke Zoom or external calendars on 409 busy / 422 / 403 / 404
      await finalizeZoomOutbox({
        apiBase,
        browserOrigin,
        cookie,
        csrfToken,
        traceHeaders,
        outboxId,
        state: "FAILED",
      });
      return jsonResponse(sanitizeErrorPayload(calRes.status, calParsed), calRes.status);
    }

    const createdEvent = calParsed as CalendarEventDetail;
    const bookedEvent: BookedCalendarEvent = {
      ...createdEvent,
      attendees: Array.isArray(createdEvent.attendees)
        ? createdEvent.attendees
        : Array.from(new Set([actor.subject, ...otherAttendees])),
      room_id: resolvedRoomId,
    };

    // Step 3: Zoom provisioning (MCP -> S2S OAuth -> transparent sandbox_preview)
    const durationMinutes = Math.max(15, Math.round(durationMs / 60_000));

    const agendaText =
      locale === "en"
        ? `AIOS Enterprise Meeting · Organizer ${actor.subject}`
        : locale === "zh-HK"
          ? `AIOS 企業會議 · 組織者 ${actor.subject}`
          : `AIOS 企业会议 · 组织者 ${actor.subject}`;

    let zoomResult: ZoomMeetingResult;
    try {
      zoomResult = wantsZoom
        ? await createZoomMeeting(
            {
              topic: data.title,
              startsAtIso: data.starts_at,
              durationMinutes,
              timezone,
              agenda: agendaText,
            },
            locale,
          )
        : {
            requested: false,
            mode: "skipped",
            sync_mode: "skipped",
            status_code: "SKIPPED",
            status_label: localizeZoomStatusLabel(
              {
                mode: "skipped",
                join_url: null,
                status_label: "",
                status_code: "SKIPPED",
              },
              locale,
            ),
            join_url: null,
            meeting_id: null,
            passcode: null,
          };
    } catch {
      await finalizeZoomOutbox({
        apiBase,
        browserOrigin,
        cookie,
        csrfToken,
        traceHeaders,
        outboxId,
        state: "UNKNOWN",
        externalId: bookedEvent.id,
      });
      return jsonResponse(
        {
          detail: {
            code: "OUTCOME_UNKNOWN",
            message:
              locale === "en"
                ? "Zoom meeting transport threw a network/timeout error; outcome is UNKNOWN until manually verified."
                : "Zoom 外部接口超时或网络异常，预约结果未知，已锁定防止重复创建。",
          },
        },
        503,
      );
    }

    // Step 4: Best-effort persistent locale-neutral structured system message (P0-2)
    let roomNotified = false;
    if (resolvedRoomId && data.notify_room !== false) {
      const structuredMsg = encodeMeetingBookedMessage({
        title: data.title,
        startsAtIso: data.starts_at,
        endsAtIso: data.ends_at,
        zoomMode: zoomResult.mode,
        joinUrl: zoomResult.join_url,
        meetingId: zoomResult.meeting_id,
        passcode: zoomResult.passcode,
      });

      try {
        const msgRes = await fetch(
          `${apiBase}/v1/chat/rooms/${encodeURIComponent(resolvedRoomId)}/messages`,
          {
            method: "POST",
            headers: {
              Cookie: cookie,
              "X-CSRF-Token": csrfToken,
              Origin: browserOrigin,
              "Content-Type": "application/json",
              Accept: "application/json",
              ...traceHeaders,
            },
            body: JSON.stringify({
              client_id: `zmsg_${shortHash(data.client_id)}`,
              text: structuredMsg,
            }),
            cache: "no-store",
            signal: AbortSignal.timeout(2500),
          },
        );
        roomNotified = msgRes.ok;
      } catch {
        roomNotified = false;
      }
    }

    // Step 5: Parallel external calendar MCP fan-out (Google / iCloud / Outlook)
    const externalDescriptionParts = [
      locale === "en"
        ? `AIOS Internal Calendar Sync · Organizer: ${actor.subject}`
        : locale === "zh-HK"
          ? `AIOS 站內會議同步 · 組織者: ${actor.subject}`
          : `AIOS 站内会议同步 · 组织者: ${actor.subject}`,
    ];
    if (zoomResult.join_url) {
      externalDescriptionParts.push(
        locale === "en"
          ? `Zoom Join URL: ${zoomResult.join_url}`
          : locale === "zh-HK"
            ? `Zoom 連結: ${zoomResult.join_url}`
            : `Zoom 链接: ${zoomResult.join_url}`,
      );
      if (zoomResult.meeting_id) {
        externalDescriptionParts.push(
          locale === "en"
            ? `Meeting ID: ${zoomResult.meeting_id}`
            : locale === "zh-HK"
              ? `會議編號: ${zoomResult.meeting_id}`
              : `会议号: ${zoomResult.meeting_id}`,
        );
      }
    }

    const defaultCalLocation =
      locale === "en"
        ? "AIOS Internal Calendar"
        : locale === "zh-HK"
          ? "AIOS 站內協作日曆"
          : "AIOS 站内协作日历";

    let externalSyncResults: Awaited<ReturnType<typeof syncExternalCalendars>>;
    try {
      externalSyncResults = await syncExternalCalendars(
        calendarTargets,
        {
          title: data.title,
          startsAtIso: data.starts_at,
          endsAtIso: data.ends_at,
          timezone,
          location: zoomResult.join_url || defaultCalLocation,
          description: externalDescriptionParts.join("\n"),
          attendees: otherAttendees.map((sub) => {
            const contact = tenantContactMap.get(sub);
            return {
              email: contact?.email || `${sub}@${actor.tenant}.local`,
              displayName: contact?.display_name || sub,
            };
          }),
        },
        locale,
      );
    } catch {
      await finalizeZoomOutbox({
        apiBase,
        browserOrigin,
        cookie,
        csrfToken,
        traceHeaders,
        outboxId,
        state: "UNKNOWN",
        externalId: zoomResult.meeting_id || bookedEvent.id,
      });
      return jsonResponse(
        {
          detail: {
            code: "OUTCOME_UNKNOWN",
            message:
              locale === "en"
                ? "External calendar synchronization threw a network/timeout error; outcome is UNKNOWN until verified."
                : "外部日历同步超时或网络异常，结果未知，已锁定防止重复同步。",
          },
        },
        503,
      );
    }

    // Step 6: Build .ics download link & unified 201 response
    const icsParams = new URLSearchParams({ event_id: bookedEvent.id });
    if (zoomResult.join_url) {
      icsParams.set("join_url", zoomResult.join_url);
      if (zoomResult.passcode) {
        icsParams.set("passcode", zoomResult.passcode);
      }
    }
    const icsDownloadUrl = `/api/calendar/ics?${icsParams.toString()}`;

    const topMode: ZoomBookingConfirmResponse["mode"] =
      zoomResult.mode === "live_mcp" ||
      zoomResult.mode === "live_api" ||
      zoomResult.mode === "error_fallback"
        ? zoomResult.mode
        : "sandbox_preview";

    const statusBadge =
      topMode === "live_mcp" || topMode === "live_api"
        ? locale === "en"
          ? "Synced to Zoom & internal calendar"
          : locale === "zh-HK"
            ? "已同步 Zoom 真實會議與站內日曆"
            : "已同步 Zoom 真实会议与站内日历"
        : topMode === "error_fallback"
          ? locale === "en"
            ? "Zoom unavailable (saved to internal calendar)"
            : locale === "zh-HK"
              ? "Zoom 暫時無法使用（站內日曆已真實入庫）"
              : "Zoom 暂不可用（站内日历已真实入库）"
          : locale === "en"
            ? "MCP credentials pending (saved to internal calendar)"
            : locale === "zh-HK"
              ? "MCP 待接入真實憑證（站內日曆已真實入庫）"
              : "MCP 待接入真实凭证（站内日历已真实入库）";

    const payload: ZoomBookingConfirmResponse = {
      phase: "confirmed",
      mode: topMode,
      sync_mode: topMode,
      status_badge: statusBadge,
      event: bookedEvent,
      internal_event: bookedEvent,
      zoom: zoomResult,
      zoom_meeting: zoomResult,
      external_sync: externalSyncResults,
      calendar_sync_results: externalSyncResults,
      room_notified: roomNotified,
      ics_download_url: icsDownloadUrl,
    };

    const finalized = await finalizeZoomOutbox({
      apiBase,
      browserOrigin,
      cookie,
      csrfToken,
      traceHeaders,
      outboxId,
      state: "SUCCEEDED",
      externalId: zoomResult.meeting_id || bookedEvent.id,
      result: payload as unknown as Record<string, unknown>,
    });
    if (!finalized) {
      await finalizeZoomOutbox({
        apiBase,
        browserOrigin,
        cookie,
        csrfToken,
        traceHeaders,
        outboxId,
        state: "UNKNOWN",
        externalId: zoomResult.meeting_id || bookedEvent.id,
      });
      return jsonResponse(
        {
          detail: {
            code: "UPSTREAM_UNAVAILABLE",
            message: "会议预约回执确认失败，已锁定防止重复创建。",
          },
        },
        503,
      );
    }

    return jsonResponse(payload, 201);
  }

  return jsonResponse(
    {
      detail: {
        code: "INVALID_REQUEST",
        message: "不支持的操作类型，请使用 parse/preview 或 confirm。",
      },
    },
    422,
  );
}
