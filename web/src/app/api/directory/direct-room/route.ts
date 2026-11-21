import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
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
  PERSONA_LOCALIZATIONS,
  normalizeLocale,
} from "@/lib/i18n";
import type { ChatRoom, DemoPersonaId } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DirectRoomSchema = z
  .object({
    target_subject: z.string().trim().min(1).max(64),
    target_display_name: z.string().trim().max(80).optional(),
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
  if (!actor.grants.includes("chat.use")) {
    return jsonResponse(
      {
        detail: {
          code: "ACCESS_RESTRICTED",
          message: "当前账号未开通协作会话权限。",
        },
      },
      403,
    );
  }

  const csrfToken = req.headers.get("x-csrf-token");
  if (!csrfToken) {
    return jsonResponse(
      {
        detail: {
          code: "CSRF_REJECTED",
          message: "缺少安全校验令牌。",
        },
      },
      403,
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(
      { detail: { code: "INVALID_REQUEST", message: "请求体格式无效。" } },
      422,
    );
  }

  const parsed = DirectRoomSchema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse(
      { detail: { code: "INVALID_REQUEST", message: "请选择有效的同租户同事。" } },
      422,
    );
  }

  const targetSubject = parsed.data.target_subject;
  if (targetSubject === actor.subject) {
    return jsonResponse(
      { detail: { code: "INVALID_REQUEST", message: "无法与本人发起 1:1 私聊。" } },
      422,
    );
  }

  const locale = normalizeLocale(req.cookies.get(LOCALE_COOKIE_NAME)?.value);

  // Strictly verify target belongs to caller's tenant and check existing 1:1 room
  const directory = await resolveTenantContacts(actor, cookie, {
    includeSelf: false,
    limit: 50,
    locale,
  });
  const target = directory.items.find((c) => c.subject === targetSubject);
  if (!target) {
    return jsonResponse(
      { detail: { code: "RECORD_UNAVAILABLE", message: "当前账号无法访问这条记录。" } },
      404,
    );
  }

  const apiBase = getApiBaseUrl();
  const browserOrigin = getBrowserOrigin();

  const knownPersona = PERSONA_LOCALIZATIONS[targetSubject as DemoPersonaId];
  const rawDisplayLabel =
    parsed.data.target_display_name || target.display_name || targetSubject;
  const isDefaultSeededName =
    Boolean(knownPersona) &&
    (rawDisplayLabel.trim().toLowerCase() === targetSubject.toLowerCase() ||
      rawDisplayLabel.trim() === knownPersona!["zh-CN"].displayName ||
      rawDisplayLabel.trim() === knownPersona!["zh-HK"].displayName ||
      rawDisplayLabel.trim().toLowerCase() ===
        knownPersona!.en.displayName.toLowerCase());

  // Locale-neutral persisted DM title so every viewer renders in their own active locale (P0-2)
  const dmTitle = isDefaultSeededName
    ? `DM · ${targetSubject}`.slice(0, 100)
    : `DM · ${rawDisplayLabel} (${targetSubject})`.slice(0, 100);

  if (target.direct_room_id) {
    return jsonResponse(
      {
        room: {
          id: target.direct_room_id,
          title: dmTitle,
          owner: actor.subject,
        } satisfies ChatRoom,
        created: false,
      },
      200,
    );
  }

  const stableClientId = `dm_${actor.subject}_${targetSubject}`
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .slice(0, 64);

  const createRoomUpstream = async (clientId: string) =>
    fetch(`${apiBase}/v1/chat/rooms`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "X-CSRF-Token": csrfToken,
        Origin: browserOrigin,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ client_id: clientId, title: dmTitle }),
      cache: "no-store",
    });

  let roomRes = await createRoomUpstream(stableClientId);
  if (roomRes.status === 409) {
    // Handle title-mismatch 409 cleanly if colleague renamed display_name since earlier DM
    const freshId = `dm_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    roomRes = await createRoomUpstream(freshId);
  }

  const roomText = await roomRes.text();
  let roomParsed: unknown = null;
  if (roomText) {
    try {
      roomParsed = JSON.parse(roomText);
    } catch {
      roomParsed = roomText;
    }
  }

  if (!roomRes.ok) {
    return jsonResponse(sanitizeErrorPayload(roomRes.status, roomParsed), roomRes.status);
  }

  const room = roomParsed as ChatRoom;

  // CRITICAL: Admit colleague BEFORE any message is sent (chat.py from_seq rule)
  const admitRes = await fetch(
    `${apiBase}/v1/chat/rooms/${encodeURIComponent(room.id)}/members/${encodeURIComponent(targetSubject)}`,
    {
      method: "PUT",
      headers: {
        Cookie: cookie,
        "X-CSRF-Token": csrfToken,
        Origin: browserOrigin,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ active: true }),
      cache: "no-store",
    },
  );

  if (!admitRes.ok) {
    const errText = await admitRes.text();
    let errParsed: unknown = null;
    try {
      errParsed = errText ? JSON.parse(errText) : null;
    } catch {
      errParsed = errText;
    }
    return jsonResponse(sanitizeErrorPayload(admitRes.status, errParsed), admitRes.status);
  }

  return jsonResponse({ room, created: true }, 201);
}
