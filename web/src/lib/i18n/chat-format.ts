import {
  DEFAULT_LOCALE,
  type Locale,
  type TrilingualText,
} from "@/lib/i18n/types";
import {
  PERSONA_LOCALIZATIONS,
  resolveLocalizedPersona,
} from "@/lib/i18n/dictionaries/common";
import { formatTimeOnly, formatUnixTime } from "@/lib/format";
import type {
  DemoPersonaId,
  ExternalCalendarSyncResult,
  ExternalCalendarTarget,
  NlMeetingWarningItem,
  ZoomMeetingResult,
} from "@/lib/types";

// ============================================================================
// Structured Locale-Neutral Chat Room Titles & System Messages (P0-2)
// ============================================================================

export const MEETING_BOOKED_TOKEN_PREFIX = "[[aios:meeting-booked|";
export const MEETING_BOOKED_TOKEN_SUFFIX = "]]";

export interface StructuredMeetingBookedPayload {
  title: string;
  startsAtIso: string;
  endsAtIso: string;
  zoomMode:
    | "live_mcp"
    | "live_api"
    | "sandbox_preview"
    | "error_fallback"
    | "skipped";
  joinUrl: string | null;
  meetingId: string | null;
  passcode: string | null;
}

function safeDecode(raw: string | undefined): string {
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function encodeMeetingBookedMessage(
  payload: StructuredMeetingBookedPayload,
): string {
  const parts: string[] = [
    "v=1",
    `title=${encodeURIComponent(payload.title.slice(0, 120))}`,
    `start=${encodeURIComponent(payload.startsAtIso)}`,
    `end=${encodeURIComponent(payload.endsAtIso)}`,
    `zoom=${encodeURIComponent(payload.zoomMode)}`,
  ];
  if (payload.joinUrl) {
    parts.push(`url=${encodeURIComponent(payload.joinUrl)}`);
  }
  if (payload.meetingId) {
    parts.push(`mid=${encodeURIComponent(payload.meetingId)}`);
  }
  if (payload.passcode) {
    parts.push(`pass=${encodeURIComponent(payload.passcode)}`);
  }
  return `${MEETING_BOOKED_TOKEN_PREFIX}${parts.join("|")}${MEETING_BOOKED_TOKEN_SUFFIX}`.slice(
    0,
    1000,
  );
}

const LEGACY_ZH_BOOKED_RE =
  /^已预约会议「([^」]+)」(?:[（(](.+?)(?:\s+[–—-]\s+|\s*[–—]\s*)(.+?)[）)])?/;

export function parseMeetingBookedMessage(
  rawText: string,
): StructuredMeetingBookedPayload | null {
  const trimmed = rawText.trim();

  if (
    trimmed.startsWith(MEETING_BOOKED_TOKEN_PREFIX) &&
    trimmed.endsWith(MEETING_BOOKED_TOKEN_SUFFIX)
  ) {
    const inner = trimmed.slice(
      MEETING_BOOKED_TOKEN_PREFIX.length,
      -MEETING_BOOKED_TOKEN_SUFFIX.length,
    );
    const kv = new Map<string, string>();
    for (const seg of inner.split("|")) {
      const eqIdx = seg.indexOf("=");
      if (eqIdx > 0) {
        kv.set(seg.slice(0, eqIdx), safeDecode(seg.slice(eqIdx + 1)));
      }
    }
    const title = kv.get("title") || "";
    if (!title) return null;
    const rawZoom = kv.get("zoom") || "sandbox_preview";
    const zoomMode: StructuredMeetingBookedPayload["zoomMode"] =
      rawZoom === "live_mcp" ||
      rawZoom === "live_api" ||
      rawZoom === "sandbox_preview" ||
      rawZoom === "error_fallback" ||
      rawZoom === "skipped"
        ? rawZoom
        : "sandbox_preview";
    return {
      title,
      startsAtIso: kv.get("start") || "",
      endsAtIso: kv.get("end") || "",
      zoomMode,
      joinUrl: kv.get("url") || null,
      meetingId: kv.get("mid") || null,
      passcode: kv.get("pass") || null,
    };
  }

  // Backwards-compatible fallback for any legacy zh-CN booked messages already stored in SQLite
  const legacy = trimmed.match(LEGACY_ZH_BOOKED_RE);
  if (legacy) {
    const urlMatch = trimmed.match(/Zoom\s*链接[：:]\s*(\S+)/);
    const idMatch = trimmed.match(/会议号[：:]\s*([^\s·]+)/);
    const passMatch = trimmed.match(/密码[：:]\s*(\S+)/);
    return {
      title: legacy[1]!.trim(),
      startsAtIso: legacy[2]?.trim() || "",
      endsAtIso: legacy[3]?.trim() || "",
      zoomMode: urlMatch ? "live_mcp" : "sandbox_preview",
      joinUrl: urlMatch ? urlMatch[1]! : null,
      meetingId: idMatch ? idMatch[1]! : null,
      passcode: passMatch ? passMatch[1]! : null,
    };
  }

  return null;
}

function formatIsoRangeCompact(
  startsAtIso: string,
  endsAtIso: string,
): string {
  const startMs = startsAtIso.includes("T") ? Date.parse(startsAtIso) : Number.NaN;
  const endMs = endsAtIso.includes("T") ? Date.parse(endsAtIso) : Number.NaN;

  if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
    const startUnix = Math.floor(startMs / 1000);
    const endUnix = Math.floor(endMs / 1000);
    return `${formatUnixTime(startUnix)} – ${formatTimeOnly(endUnix)}`;
  }

  const startPart = startsAtIso.includes("T")
    ? startsAtIso.slice(0, 16).replace("T", " ")
    : startsAtIso;
  const endPart = endsAtIso.includes("T")
    ? endsAtIso.slice(11, 16)
    : endsAtIso;
  if (!startPart && !endPart) return "";
  if (!endPart) return startPart;
  return `${startPart} – ${endPart}`;
}

export function formatChatMessagePreview(
  rawText: string,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const parsed = parseMeetingBookedMessage(rawText);
  if (!parsed) return rawText;
  const range = formatIsoRangeCompact(parsed.startsAtIso, parsed.endsAtIso);
  if (locale === "en") {
    return range
      ? `Scheduled "${parsed.title}" (${range})`
      : `Scheduled "${parsed.title}"`;
  }
  if (locale === "zh-HK") {
    return range
      ? `已預約會議「${parsed.title}」（${range}）`
      : `已預約會議「${parsed.title}」`;
  }
  return range
    ? `已预约会议「${parsed.title}」（${range}）`
    : `已预约会议「${parsed.title}」`;
}

export function formatChatMessageBody(
  rawText: string,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const parsed = parseMeetingBookedMessage(rawText);
  if (!parsed) return rawText;
  const lines: string[] = [formatChatMessagePreview(rawText, locale)];

  if (parsed.joinUrl) {
    lines.push(
      locale === "en"
        ? `Zoom link: ${parsed.joinUrl}`
        : locale === "zh-HK"
          ? `Zoom 連結：${parsed.joinUrl}`
          : `Zoom 链接：${parsed.joinUrl}`,
    );
    if (parsed.meetingId) {
      if (locale === "en") {
        lines.push(
          `Meeting ID: ${parsed.meetingId}${parsed.passcode ? ` · Passcode: ${parsed.passcode}` : ""}`,
        );
      } else if (locale === "zh-HK") {
        lines.push(
          `會議編號：${parsed.meetingId}${parsed.passcode ? ` · 密碼：${parsed.passcode}` : ""}`,
        );
      } else {
        lines.push(
          `会议号：${parsed.meetingId}${parsed.passcode ? ` · 密码：${parsed.passcode}` : ""}`,
        );
      }
    }
  } else if (parsed.zoomMode !== "skipped") {
    lines.push(
      locale === "en"
        ? "Saved to internal calendar. Zoom MCP credentials are not configured yet — view or export .ics on the Calendar page."
        : locale === "zh-HK"
          ? "Zoom MCP 尚未設定真實憑證，站內行程已入庫，與會者可於日曆頁檢視並匯出 .ics。"
          : "Zoom MCP 尚未配置真实凭证，站内日程已入库，参会人可在日历页查看并导出 .ics。",
    );
  }

  return lines.join("\n");
}

const DM_PREFIX_RE = /^(?:私聊|私訊|DM)\s*[·•]\s*(.+)$/i;
const MEETING_PREFIX_RE = /^(?:会议|會議|Meeting)\s*[·•]\s*(.+)$/i;

export function isDirectRoomTitle(rawTitle: string): boolean {
  return DM_PREFIX_RE.test(rawTitle.trim());
}

export function extractDirectRoomInfo(rawTitle: string): {
  targetSubject: string | null;
  targetLabel: string | null;
} | null {
  const dmMatch = rawTitle.trim().match(DM_PREFIX_RE);
  if (!dmMatch) return null;
  const rest = dmMatch[1]!.trim();
  const parenMatch = rest.match(/^(.+?)\s*\(([A-Za-z0-9._-]+)\)\s*$/);
  if (parenMatch) {
    return {
      targetLabel: parenMatch[1]!.trim() || null,
      targetSubject: parenMatch[2]!.trim() || null,
    };
  }
  if (rest in PERSONA_LOCALIZATIONS) {
    return {
      targetSubject: rest,
      targetLabel: null,
    };
  }
  return {
    targetSubject: null,
    targetLabel: rest || null,
  };
}

export function isMeetingRoomTitle(rawTitle: string): boolean {
  return MEETING_PREFIX_RE.test(rawTitle.trim());
}

function isKnownPersonaDefaultName(subject: string, candidate: string): boolean {
  const entry = PERSONA_LOCALIZATIONS[subject as DemoPersonaId];
  if (!entry) return false;
  const norm = candidate.trim().toLowerCase();
  return (
    norm === subject.toLowerCase() ||
    norm === entry["zh-CN"].displayName.toLowerCase() ||
    norm === entry["zh-HK"].displayName.toLowerCase() ||
    norm === entry.en.displayName.toLowerCase()
  );
}

/**
 * Localizes BFF-persisted room titles (`DM · ...`, `私聊 · ...`, `Meeting · ...`, `会议 · ...`)
 * into the viewer's active locale cleanly without losing custom user room names.
 */
export function formatChatRoomTitle(
  rawTitle: string,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const trimmed = rawTitle.trim();
  if (!trimmed) return rawTitle;

  const dmMatch = trimmed.match(DM_PREFIX_RE);
  if (dmMatch) {
    const rest = dmMatch[1]!.trim();
    const parenMatch = rest.match(/^(.+?)\s*\(([A-Za-z0-9._-]+)\)\s*$/);
    if (parenMatch) {
      const label = parenMatch[1]!.trim();
      const subject = parenMatch[2]!.trim();
      if (isKnownPersonaDefaultName(subject, label)) {
        return resolveLocalizedPersona(subject, locale).displayName;
      }
      return label || resolveLocalizedPersona(subject, locale).displayName;
    }
    if (rest in PERSONA_LOCALIZATIONS) {
      return resolveLocalizedPersona(rest, locale).displayName;
    }
    return rest;
  }

  const meetingMatch = trimmed.match(MEETING_PREFIX_RE);
  if (meetingMatch) {
    const topic = meetingMatch[1]!.trim();
    const prefix =
      locale === "en" ? "Meeting" : locale === "zh-HK" ? "會議" : "会议";
    return `${prefix} · ${topic}`;
  }

  return trimmed;
}

// ============================================================================
// Directory Fallbacks & NL Meeting / MCP Connector Localizers (M-4, M-5, M-12e)
// ============================================================================

const DEFAULT_DEPARTMENT_SENTINELS = new Set([
  "企业协作成员",
  "企業協作成員",
  "Workspace Member",
]);

const DEFAULT_JOB_TITLE_SENTINELS = new Set([
  "团队成员",
  "團隊成員",
  "Team Member",
]);

export const DEFAULT_CONTACT_DEPARTMENT_I18N: TrilingualText = {
  "zh-CN": "企业协作成员",
  "zh-HK": "企業協作成員",
  en: "Workspace Member",
};

export const DEFAULT_CONTACT_JOB_TITLE_I18N: TrilingualText = {
  "zh-CN": "团队成员",
  "zh-HK": "團隊成員",
  en: "Team Member",
};

export function localizeContactDepartment(
  department: string,
  subject: string,
  locale: Locale = DEFAULT_LOCALE,
): string {
  if (subject in PERSONA_LOCALIZATIONS) {
    return resolveLocalizedPersona(subject, locale).department;
  }
  if (!department || DEFAULT_DEPARTMENT_SENTINELS.has(department.trim())) {
    return DEFAULT_CONTACT_DEPARTMENT_I18N[locale];
  }
  return department;
}

export function localizeContactJobTitle(
  jobTitle: string,
  subject: string,
  locale: Locale = DEFAULT_LOCALE,
): string {
  if (subject in PERSONA_LOCALIZATIONS) {
    return resolveLocalizedPersona(subject, locale).label;
  }
  if (!jobTitle || DEFAULT_JOB_TITLE_SENTINELS.has(jobTitle.trim())) {
    return DEFAULT_CONTACT_JOB_TITLE_I18N[locale];
  }
  return jobTitle;
}

export function localizeNlMeetingWarning(
  warning: NlMeetingWarningItem | string,
  locale: Locale = DEFAULT_LOCALE,
): string {
  if (typeof warning === "string") {
    if (warning.includes("未指定具体开始时间")) {
      return localizeNlMeetingWarning({ code: "DEFAULT_NEXT_HOUR" }, locale);
    }
    if (warning.includes("早于当前时刻")) {
      return localizeNlMeetingWarning({ code: "ROLLED_TO_TOMORROW" }, locale);
    }
    if (warning.includes("15 分钟后")) {
      return localizeNlMeetingWarning({ code: "ADJUSTED_15_MIN" }, locale);
    }
    const missingMatch = warning.match(/未在当前租户通讯录中找到[：:]\s*(.+)$/);
    if (missingMatch) {
      return localizeNlMeetingWarning(
        { code: "UNRESOLVED_MENTION", params: { token: missingMatch[1]! } },
        locale,
      );
    }
    return warning;
  }

  switch (warning.code) {
    case "DEFAULT_NEXT_HOUR":
      return locale === "en"
        ? "No start time was specified — defaulted to the next full hour. You can adjust it before confirming."
        : locale === "zh-HK"
          ? "未指定具體開始時間，已預設安排於下一個整點，可於確認前調整。"
          : "未指定具体开始时间，已默认安排在下一个整点，可在确认前调整。";
    case "ROLLED_TO_TOMORROW":
      return locale === "en"
        ? "Parsed time has already passed today — moved to the same slot tomorrow."
        : locale === "zh-HK"
          ? "解析時間早於目前時刻，已自動順延至翌日同一時段。"
          : "解析时间早于当前时刻，已自动顺延至次日同一时段。";
    case "ADJUSTED_15_MIN":
      return locale === "en"
        ? "Selected date/time is in the past — adjusted to 15 minutes from now. Please review."
        : locale === "zh-HK"
          ? "所選日期時間已過，已自動調整為 15 分鐘後，請核對時間。"
          : "所选日期时间已过，已自动调整为 15 分钟后，请核对时间。";
    case "UNRESOLVED_MENTION": {
      const token = warning.params?.token || "";
      return locale === "en"
        ? `Not found in current tenant directory: ${token}`
        : locale === "zh-HK"
          ? `未在目前租戶聯絡人清單中找到：${token}`
          : `未在当前租户通讯录中找到：${token}`;
    }
  }
}

export const CALENDAR_CONNECTOR_LABELS_I18N: Readonly<
  Record<ExternalCalendarTarget | "internal" | "zoom" | "email", TrilingualText>
> = {
  internal: {
    "zh-CN": "AIOS 站内日历",
    "zh-HK": "AIOS 站內日曆",
    en: "AIOS Internal Calendar",
  },
  zoom: {
    "zh-CN": "Zoom 视频会议",
    "zh-HK": "Zoom 視像會議",
    en: "Zoom Meetings",
  },
  email: {
    "zh-CN": "企业邮件 MCP / SMTP",
    "zh-HK": "企業電郵 MCP / SMTP",
    en: "Enterprise Email MCP / SMTP",
  },
  google: {
    "zh-CN": "Google 日历",
    "zh-HK": "Google 日曆",
    en: "Google",
  },
  icloud: {
    "zh-CN": "Apple iCloud 日历",
    "zh-HK": "Apple iCloud 日曆",
    en: "Apple iCloud",
  },
  outlook: {
    "zh-CN": "Outlook / M365 日历",
    "zh-HK": "Outlook / M365 日曆",
    en: "Outlook / M365",
  },
};

export function localizeMcpSyncMessage(
  item: Pick<
    ExternalCalendarSyncResult,
    "connector" | "status" | "message" | "message_code"
  >,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const label = CALENDAR_CONNECTOR_LABELS_I18N[item.connector][locale];
  const code =
    item.message_code ??
    (item.status === "synced"
      ? "SYNCED"
      : item.status === "unconfigured"
        ? "UNCONFIGURED"
        : "MCP_ERROR");

  switch (code) {
    case "SYNCED":
      return locale === "en"
        ? `Synced live to ${label}`
        : locale === "zh-HK"
          ? `已即時寫入 ${label}`
          : `已实时写入 ${label}`;
    case "UNCONFIGURED":
      return item.connector === "icloud"
        ? locale === "en"
          ? "iCloud CalDAV MCP not configured. Use .ics to import into Apple Calendar."
          : locale === "zh-HK"
            ? "未設定 iCloud CalDAV MCP，可使用 .ics 一鍵匯入 Apple 日曆"
            : "未配置 iCloud CalDAV MCP，可使用 .ics 一键导入 Apple 日历"
        : locale === "en"
          ? `${label} MCP not configured. Use .ics to import.`
          : locale === "zh-HK"
            ? `未設定 ${label} MCP，可使用 .ics 一鍵匯入`
            : `未配置 ${label} MCP，可使用 .ics 一键导入`;
    case "SYNC_FAILED":
      return locale === "en"
        ? `${label} sync failed. Use .ics to import.`
        : locale === "zh-HK"
          ? `${label} 同步失敗，請使用 .ics 匯入`
          : `${label} 同步失败，请使用 .ics 导入`;
    case "MCP_ERROR":
    default:
      return locale === "en"
        ? `${label} MCP sync is temporarily unavailable. Use .ics to import.`
        : locale === "zh-HK"
          ? `${label} MCP 同步暫時無法使用，可使用 .ics 匯入`
          : `${label} MCP 同步暂不可用，可使用 .ics 导入`;
  }
}

export function localizeZoomStatusLabel(
  zoom: Pick<
    ZoomMeetingResult,
    "mode" | "join_url" | "status_label" | "status_code"
  >,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const code =
    zoom.status_code ??
    (zoom.mode === "live_mcp"
      ? zoom.join_url
        ? "LIVE_MCP_JOIN"
        : "LIVE_MCP_CREATED"
      : zoom.mode === "live_api"
        ? "LIVE_API_JOIN"
        : zoom.mode === "error_fallback"
          ? "ERROR_FALLBACK"
          : zoom.mode === "skipped"
            ? "SKIPPED"
            : "SANDBOX_PREVIEW");

  switch (code) {
    case "LIVE_MCP_JOIN":
      return locale === "en"
        ? "Zoom MCP generated live meeting link"
        : locale === "zh-HK"
          ? "Zoom MCP 已產生真實會議連結"
          : "Zoom MCP 已生成真实会议链接";
    case "LIVE_MCP_CREATED":
      return locale === "en"
        ? "Zoom MCP created meeting"
        : locale === "zh-HK"
          ? "Zoom MCP 已建立會議"
          : "Zoom MCP 已创建会议";
    case "LIVE_API_JOIN":
      return locale === "en"
        ? "Zoom API generated live meeting link"
        : locale === "zh-HK"
          ? "Zoom API 已產生真實會議連結"
          : "Zoom API 已生成真实会议链接";
    case "ERROR_FALLBACK":
      return locale === "en"
        ? "Zoom temporarily unavailable (saved to internal calendar; export .ics)"
        : locale === "zh-HK"
          ? "Zoom 連線暫時無法使用（站內日曆已真實入庫，可先匯出 .ics）"
          : "Zoom 连接暂不可用（站内日历已真实入库，可先导出 .ics）";
    case "SKIPPED":
      return locale === "en"
        ? "Saved to internal calendar only (Zoom not requested)"
        : locale === "zh-HK"
          ? "已僅建立站內行程（未請求 Zoom 會議）"
          : "已仅创建站内日程（未请求 Zoom 会议）";
    case "SANDBOX_PREVIEW":
    default:
      return locale === "en"
        ? "Zoom MCP credentials pending (saved to internal calendar)"
        : locale === "zh-HK"
          ? "MCP 待接入真實憑證（站內日曆已真實入庫）"
          : "MCP 待接入真实凭证（站内日历已真实入库）";
  }
}
