import { callMcpTool, validateMcpEndpointUrl } from "@/lib/mcp/client";
import { isValidZoomJoinUrl } from "@/lib/mcp/ics";
import type {
  ExternalCalendarSyncResult,
  ExternalCalendarTarget,
  McpConnectorStatusItem,
  ZoomMeetingResult,
} from "@/lib/types";

interface CalendarConnectorEnv {
  target: ExternalCalendarTarget;
  label: string;
  url: string | null;
  token: string | null;
  toolName: string;
  calendarId?: string;
  setupEnvKeys: string[];
}

function readCleanEnv(key: string): string | null {
  const val = process.env[key]?.trim();
  return val && val.length > 0 ? val : null;
}

function getCalendarConnectorEnv(target: ExternalCalendarTarget): CalendarConnectorEnv {
  switch (target) {
    case "google": {
      const url = readCleanEnv("AIOS_MCP_GOOGLE_CALENDAR_URL");
      return {
        target: "google",
        label: "Google Calendar",
        url: url && validateMcpEndpointUrl(url) ? url : null,
        token: readCleanEnv("AIOS_MCP_GOOGLE_CALENDAR_TOKEN"),
        toolName: readCleanEnv("AIOS_MCP_GOOGLE_CALENDAR_TOOL") || "create-event",
        calendarId: readCleanEnv("AIOS_MCP_GOOGLE_CALENDAR_ID") || "primary",
        setupEnvKeys: [
          "AIOS_MCP_GOOGLE_CALENDAR_URL",
          "AIOS_MCP_GOOGLE_CALENDAR_ID",
          "AIOS_MCP_GOOGLE_CALENDAR_TOOL",
        ],
      };
    }
    case "icloud": {
      const url = readCleanEnv("AIOS_MCP_ICLOUD_CALENDAR_URL");
      return {
        target: "icloud",
        label: "Apple iCloud 日历",
        url: url && validateMcpEndpointUrl(url) ? url : null,
        token: readCleanEnv("AIOS_MCP_ICLOUD_CALENDAR_TOKEN"),
        toolName: readCleanEnv("AIOS_MCP_ICLOUD_CALENDAR_TOOL") || "create_event",
        setupEnvKeys: [
          "AIOS_MCP_ICLOUD_CALENDAR_URL",
          "AIOS_MCP_ICLOUD_CALENDAR_TOKEN",
          "AIOS_MCP_ICLOUD_CALENDAR_TOOL",
        ],
      };
    }
    case "outlook": {
      const url = readCleanEnv("AIOS_MCP_OUTLOOK_CALENDAR_URL");
      return {
        target: "outlook",
        label: "Outlook / M365 日历",
        url: url && validateMcpEndpointUrl(url) ? url : null,
        token: readCleanEnv("AIOS_MCP_OUTLOOK_CALENDAR_TOKEN"),
        toolName:
          readCleanEnv("AIOS_MCP_OUTLOOK_CALENDAR_TOOL") || "create-calendar-event",
        setupEnvKeys: [
          "AIOS_MCP_OUTLOOK_CALENDAR_URL",
          "AIOS_MCP_OUTLOOK_CALENDAR_TOKEN",
          "AIOS_MCP_OUTLOOK_CALENDAR_TOOL",
        ],
      };
    }
  }
}

function getZoomMcpConfig(): {
  url: string;
  token: string | null;
  toolName: string;
} | null {
  const url = readCleanEnv("AIOS_MCP_ZOOM_URL");
  if (!url || !validateMcpEndpointUrl(url)) return null;
  return {
    url,
    token: readCleanEnv("AIOS_MCP_ZOOM_TOKEN"),
    toolName: readCleanEnv("AIOS_MCP_ZOOM_TOOL") || "create_meeting",
  };
}

function getZoomS2SConfig(): {
  accountId: string;
  clientId: string;
  clientSecret: string;
  hostUserId: string;
} | null {
  const accountId = readCleanEnv("ZOOM_ACCOUNT_ID");
  const clientId = readCleanEnv("ZOOM_CLIENT_ID");
  const clientSecret = readCleanEnv("ZOOM_CLIENT_SECRET");
  if (!accountId || !clientId || !clientSecret) return null;
  return {
    accountId,
    clientId,
    clientSecret,
    hostUserId: readCleanEnv("ZOOM_HOST_USER_ID") || "me",
  };
}

export function getZoomPreviewMode(): "live_mcp" | "live_api" | "sandbox_preview" {
  if (getZoomMcpConfig()) return "live_mcp";
  if (getZoomS2SConfig()) return "live_api";
  return "sandbox_preview";
}

export function isZoomConfigured(): boolean {
  return getZoomPreviewMode() !== "sandbox_preview";
}

/**
 * Returns safe connector readiness status for all calendar & meeting integrations.
 * NEVER exposes URLs, tokens, secrets, or forbidden JSON keys.
 */
export function getMcpConnectorsStatus(): McpConnectorStatusItem[] {
  const zoomMode = getZoomPreviewMode();
  const zoomConfigured = zoomMode !== "sandbox_preview";

  const google = getCalendarConnectorEnv("google");
  const icloud = getCalendarConnectorEnv("icloud");
  const outlook = getCalendarConnectorEnv("outlook");

  return [
    {
      connector: "internal",
      connector_id: "internal",
      label: "AIOS 站内日历",
      category: "internal",
      configured: true,
      status: "connected",
      mode: "live_internal",
      protocol: "AIOS Internal Calendar API",
      supports_sync: true,
      setup_env_keys: [],
    },
    {
      connector: "zoom",
      connector_id: "zoom",
      label: "Zoom 视频会议",
      category: "meeting",
      configured: zoomConfigured,
      status: zoomConfigured ? "connected" : "sandbox_ready",
      mode: zoomMode,
      protocol: zoomMode === "live_api" ? "Zoom S2S OAuth v2" : "MCP Streamable HTTP / Zoom S2S",
      supports_sync: true,
      setup_env_keys: [
        "AIOS_MCP_ZOOM_URL",
        "ZOOM_ACCOUNT_ID",
        "ZOOM_CLIENT_ID",
        "ZOOM_CLIENT_SECRET",
      ],
    },
    {
      connector: "google",
      connector_id: "google",
      label: google.label,
      category: "calendar",
      configured: Boolean(google.url),
      status: google.url ? "connected" : "sandbox_ready",
      mode: google.url ? "live_mcp" : "ics_fallback",
      protocol: "MCP Streamable HTTP (Google Calendar)",
      supports_sync: true,
      setup_env_keys: google.setupEnvKeys,
    },
    {
      connector: "icloud",
      connector_id: "icloud",
      label: icloud.label,
      category: "calendar",
      configured: Boolean(icloud.url),
      status: icloud.url ? "connected" : "sandbox_ready",
      mode: icloud.url ? "live_mcp" : "ics_fallback",
      protocol: "MCP Streamable HTTP (Apple CalDAV)",
      supports_sync: true,
      setup_env_keys: icloud.setupEnvKeys,
    },
    {
      connector: "outlook",
      connector_id: "outlook",
      label: outlook.label,
      category: "calendar",
      configured: Boolean(outlook.url),
      status: outlook.url ? "connected" : "sandbox_ready",
      mode: outlook.url ? "live_mcp" : "ics_fallback",
      protocol: "MCP Streamable HTTP (Microsoft Graph)",
      supports_sync: true,
      setup_env_keys: outlook.setupEnvKeys,
    },
  ];
}

// ============================================================================
// Zoom Meeting Provisioning (Priority 1: MCP -> Priority 2: S2S -> Sandbox)
// ============================================================================

let cachedZoomToken: { token: string; expiresAtMs: number } | null = null;

async function fetchZoomS2SToken(cfg: {
  accountId: string;
  clientId: string;
  clientSecret: string;
}): Promise<string> {
  if (cachedZoomToken && cachedZoomToken.expiresAtMs > Date.now() + 60_000) {
    return cachedZoomToken.token;
  }

  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`, "utf8").toString(
    "base64",
  );
  const res = await fetch(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(cfg.accountId)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        Accept: "application/json",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(6000),
    },
  );
  if (!res.ok) {
    throw new Error("ZOOM_OAUTH_FAILED");
  }
  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!data.access_token) {
    throw new Error("ZOOM_OAUTH_MISSING_TOKEN");
  }
  const ttlSec = typeof data.expires_in === "number" ? data.expires_in : 3600;
  cachedZoomToken = {
    token: data.access_token,
    expiresAtMs: Date.now() + ttlSec * 1000,
  };
  return data.access_token;
}

function extractZoomFieldsFromMcp(
  structured: Record<string, unknown> | undefined,
  rawText: string,
): { joinUrl: string | null; meetingId: string | null; passcode: string | null } {
  let obj: Record<string, unknown> | null = structured ?? null;
  if (!obj && rawText.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(rawText) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        obj = parsed as Record<string, unknown>;
      }
    } catch {
      // Fall back to regex extraction
    }
  }

  let joinUrl: string | null = null;
  let meetingId: string | null = null;
  let passcode: string | null = null;

  if (obj) {
    const rawJoin =
      typeof obj.join_url === "string"
        ? obj.join_url
        : typeof obj.joinUrl === "string"
          ? obj.joinUrl
          : null;
    if (rawJoin && isValidZoomJoinUrl(rawJoin)) {
      joinUrl = rawJoin;
    }
    const rawId = obj.id ?? obj.meeting_id ?? obj.meetingId;
    if (typeof rawId === "string" || typeof rawId === "number") {
      meetingId = String(rawId);
    }
    const rawPass = obj.password ?? obj.passcode;
    if (typeof rawPass === "string" && rawPass.trim()) {
      passcode = rawPass.trim();
    }
  }

  if (!joinUrl && rawText) {
    const match = rawText.match(/https:\/\/(?:[a-z0-9-]+\.)?zoom\.us\/j\/[A-Za-z0-9/?=&_%.-]+/);
    if (match && isValidZoomJoinUrl(match[0])) {
      joinUrl = match[0];
    }
  }

  return { joinUrl, meetingId, passcode };
}

export async function createZoomMeeting(input: {
  topic: string;
  startsAtIso: string;
  durationMinutes: number;
  timezone: string;
  agenda?: string;
}): Promise<ZoomMeetingResult> {
  const mcpCfg = getZoomMcpConfig();
  if (mcpCfg) {
    const res = await callMcpTool(
      { serverUrl: mcpCfg.url, bearerToken: mcpCfg.token, timeoutMs: 8000 },
      mcpCfg.toolName,
      {
        topic: input.topic,
        type: 2,
        start_time: input.startsAtIso,
        duration: input.durationMinutes,
        timezone: input.timezone,
        agenda: input.agenda || "AIOS 企业协作会议",
      },
    );
    if (res.ok) {
      const extracted = extractZoomFieldsFromMcp(res.structuredContent, res.rawText);
      return {
        requested: true,
        mode: "live_mcp",
        sync_mode: "live_mcp",
        status_label: extracted.joinUrl
          ? "Zoom MCP 已生成真实会议链接"
          : "Zoom MCP 已创建会议",
        join_url: extracted.joinUrl,
        meeting_id: extracted.meetingId,
        passcode: extracted.passcode,
      };
    }
    return {
      requested: true,
      mode: "error_fallback",
      sync_mode: "error_fallback",
      status_label: "Zoom MCP 连接暂不可用（站内日历已真实入库，可先导出 .ics）",
      join_url: null,
      meeting_id: null,
      passcode: null,
    };
  }

  const s2sCfg = getZoomS2SConfig();
  if (s2sCfg) {
    try {
      const accessToken = await fetchZoomS2SToken(s2sCfg);
      const startUtc = new Date(input.startsAtIso).toISOString().replace(/\.\d{3}Z$/, "Z");
      const res = await fetch(
        `https://api.zoom.us/v2/users/${encodeURIComponent(s2sCfg.hostUserId)}/meetings`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            topic: input.topic,
            type: 2,
            start_time: startUtc,
            duration: input.durationMinutes,
            timezone: input.timezone,
            agenda: input.agenda || "AIOS 企业协作会议",
            settings: {
              host_video: true,
              participant_video: true,
              join_before_host: true,
              waiting_room: false,
            },
          }),
          cache: "no-store",
          signal: AbortSignal.timeout(8000),
        },
      );
      if (!res.ok) {
        throw new Error("ZOOM_API_FAILED");
      }
      const data = (await res.json()) as {
        id?: string | number;
        join_url?: string;
        password?: string;
      };
      const safeJoin =
        typeof data.join_url === "string" && isValidZoomJoinUrl(data.join_url)
          ? data.join_url
          : null;
      return {
        requested: true,
        mode: "live_api",
        sync_mode: "live_api",
        status_label: "Zoom API 已生成真实会议链接",
        join_url: safeJoin,
        meeting_id: data.id !== undefined ? String(data.id) : null,
        passcode: typeof data.password === "string" ? data.password : null,
      };
    } catch {
      return {
        requested: true,
        mode: "error_fallback",
        sync_mode: "error_fallback",
        status_label: "Zoom 连接暂不可用（站内日历已真实入库，可先导出 .ics）",
        join_url: null,
        meeting_id: null,
        passcode: null,
      };
    }
  }

  // Priority 3: Honest transparent sandbox_preview — NEVER fabricates a fake clickable URL
  return {
    requested: true,
    mode: "sandbox_preview",
    sync_mode: "sandbox_preview",
    status_label: "MCP 待接入真实凭证（站内日历已真实入库）",
    join_url: null,
    meeting_id: null,
    passcode: null,
  };
}

// ============================================================================
// External Calendar MCP Fan-Out (Google, iCloud, Outlook)
// ============================================================================

export interface ExternalCalendarEventPayload {
  title: string;
  startsAtIso: string;
  endsAtIso: string;
  timezone: string;
  description: string;
  location: string;
  attendees: Array<{ email: string; displayName: string }>;
}

function stripIsoOffsetForGraph(iso: string): string {
  return iso.replace(/(?:Z|[+-]\d{2}:\d{2})$/, "");
}

function extractExternalEventId(
  structured: Record<string, unknown> | undefined,
  rawText: string,
): string | null {
  if (structured) {
    const id = structured.id ?? structured.event_id ?? structured.uid;
    if (typeof id === "string" && id.trim()) return id.trim().slice(0, 120);
  }
  if (rawText.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(rawText) as Record<string, unknown>;
      const id = parsed.id ?? parsed.event_id ?? parsed.uid;
      if (typeof id === "string" && id.trim()) return id.trim().slice(0, 120);
    } catch {
      // ignore
    }
  }
  return null;
}

async function syncSingleCalendar(
  target: ExternalCalendarTarget,
  payload: ExternalCalendarEventPayload,
): Promise<ExternalCalendarSyncResult> {
  const env = getCalendarConnectorEnv(target);

  if (!env.url) {
    return {
      connector: target,
      label: env.label,
      status: "unconfigured",
      external_event_id: null,
      message:
        target === "icloud"
          ? "未配置 iCloud CalDAV MCP，可使用 .ics 一键导入 Apple 日历"
          : `未配置 ${env.label} MCP，可使用 .ics 一键导入`,
      setup_env_keys: env.setupEnvKeys,
    };
  }

  let toolArgs: Record<string, unknown>;
  if (target === "google") {
    toolArgs = {
      calendarId: env.calendarId || "primary",
      summary: payload.title,
      start: payload.startsAtIso,
      end: payload.endsAtIso,
      location: payload.location,
      description: payload.description,
      attendees: payload.attendees.map((a) => a.email),
    };
  } else if (target === "icloud") {
    toolArgs = {
      summary: payload.title,
      start: payload.startsAtIso,
      end: payload.endsAtIso,
      location: payload.location,
      description: payload.description,
    };
  } else {
    toolArgs = {
      body: {
        subject: payload.title,
        body: {
          contentType: "Text",
          content: payload.description,
        },
        start: {
          dateTime: stripIsoOffsetForGraph(payload.startsAtIso),
          timeZone: payload.timezone,
        },
        end: {
          dateTime: stripIsoOffsetForGraph(payload.endsAtIso),
          timeZone: payload.timezone,
        },
        location: {
          displayName: payload.location || "AIOS Collaboration Meeting",
        },
        attendees: payload.attendees.map((a) => ({
          emailAddress: {
            address: a.email,
            name: a.displayName,
          },
          type: "required",
        })),
      },
    };
  }

  const res = await callMcpTool(
    { serverUrl: env.url, bearerToken: env.token, timeoutMs: 8000 },
    env.toolName,
    toolArgs,
  );

  if (res.ok) {
    return {
      connector: target,
      label: env.label,
      status: "synced",
      external_event_id: extractExternalEventId(res.structuredContent, res.rawText),
      message: `已实时写入 ${env.label}`,
    };
  }

  return {
    connector: target,
    label: env.label,
    status: "error",
    external_event_id: null,
    message: `${env.label} MCP 同步暂不可用，可使用 .ics 导入`,
    setup_env_keys: env.setupEnvKeys,
  };
}

export async function syncExternalCalendars(
  targets: readonly ExternalCalendarTarget[],
  payload: ExternalCalendarEventPayload,
): Promise<ExternalCalendarSyncResult[]> {
  const uniqueTargets = Array.from(new Set(targets));
  const settled = await Promise.allSettled(
    uniqueTargets.map((target) => syncSingleCalendar(target, payload)),
  );

  return settled.map((item, idx) => {
    const target = uniqueTargets[idx]!;
    if (item.status === "fulfilled") {
      return item.value;
    }
    const env = getCalendarConnectorEnv(target);
    return {
      connector: target,
      label: env.label,
      status: "error",
      external_event_id: null,
      message: `${env.label} 同步失败，请使用 .ics 导入`,
      setup_env_keys: env.setupEnvKeys,
    };
  });
}
