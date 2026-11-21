import { getApiBaseUrl, isDemoAuthEnabled } from "@/lib/bff/config";
import { sanitizeErrorPayload } from "@/lib/bff/sanitize";
import { sortWarehouses } from "@/lib/format";
import {
  DEFAULT_LOCALE,
  PERSONA_LOCALIZATIONS,
  isDirectRoomTitle,
  localizeContactDepartment,
  localizeContactJobTitle,
  type Locale,
} from "@/lib/i18n";
import type {
  Actor,
  ChatRoom,
  CompanyContact,
  DemoPersonaId,
  Profile,
  Role,
} from "@/lib/types";

export interface DirectorySeedEntry {
  subject: DemoPersonaId;
  tenant: "harbour" | "island";
  role: Role;
  warehouses: string[];
  default_display_name: string;
  email: string;
  department: string;
  job_title: string;
  login_aliases: readonly string[];
  search_keywords: readonly string[];
}

export const DEMO_DIRECTORY: readonly DirectorySeedEntry[] = [
  {
    subject: "operator",
    tenant: "harbour",
    role: "operator",
    warehouses: ["HK01"],
    default_display_name: "林明哲",
    email: "operator@harbour.demo",
    department: "HK01 仓储运营部",
    job_title: "接单 / 运单经办",
    login_aliases: [
      "operator",
      "operator@harbour.demo",
      "op@harbour.demo",
      "lin.mingzhe@harbour.demo",
      "hbr-op",
    ],
    search_keywords: ["经办", "接单", "运单", "林明哲", "lin", "op"],
  },
  {
    subject: "manager",
    tenant: "harbour",
    role: "manager",
    warehouses: ["HK01"],
    default_display_name: "陈志远",
    email: "manager@harbour.demo",
    department: "HK01 仓储运营部",
    job_title: "独立主管审批",
    login_aliases: [
      "manager",
      "manager@harbour.demo",
      "mgr@harbour.demo",
      "chen.zhiyuan@harbour.demo",
      "hbr-mgr",
    ],
    search_keywords: ["主管", "经理", "审批", "陈志远", "chen", "mgr"],
  },
  {
    subject: "finance",
    tenant: "harbour",
    role: "viewer",
    warehouses: ["HK01"],
    default_display_name: "周婉清",
    email: "finance@harbour.demo",
    department: "财务核算部",
    job_title: "财务审阅",
    login_aliases: [
      "finance",
      "finance@harbour.demo",
      "fin@harbour.demo",
      "zhou.wanqing@harbour.demo",
      "hbr-fin",
    ],
    search_keywords: ["财务", "发票", "会计", "周婉清", "zhou", "fin"],
  },
  {
    subject: "access-admin",
    tenant: "harbour",
    role: "admin",
    warehouses: ["HK01", "HK02"],
    default_display_name: "许嘉豪",
    email: "access-admin@harbour.demo",
    department: "身份与权限治理部",
    job_title: "全站点权限管理员",
    login_aliases: [
      "access-admin",
      "access-admin@harbour.demo",
      "iam@harbour.demo",
      "xu.jiahao@harbour.demo",
      "hbr-iam",
    ],
    search_keywords: ["权限", "权限管理员", "授权", "许嘉豪", "iam"],
  },
  {
    subject: "admin",
    tenant: "harbour",
    role: "admin",
    warehouses: ["HK01"],
    default_display_name: "郑启帆",
    email: "admin@harbour.demo",
    department: "平台运维部",
    job_title: "运维管理员",
    login_aliases: [
      "admin",
      "admin@harbour.demo",
      "ops@harbour.demo",
      "ops-admin@harbour.demo",
      "zheng.qifan@harbour.demo",
      "hbr-ops",
    ],
    search_keywords: ["运维", "运维管理员", "系统管理员", "郑启帆", "ops"],
  },
  {
    subject: "quality",
    tenant: "harbour",
    role: "viewer",
    warehouses: ["HK01"],
    default_display_name: "梁思琪",
    email: "quality@harbour.demo",
    department: "品质保障部",
    job_title: "来料质检复核",
    login_aliases: [
      "quality",
      "quality@harbour.demo",
      "qa@harbour.demo",
      "liang.siqi@harbour.demo",
      "hbr-qa",
    ],
    search_keywords: ["质检", "质量", "品控", "梁思琪", "qa"],
  },
  {
    subject: "legal",
    tenant: "harbour",
    role: "viewer",
    warehouses: ["HK01"],
    default_display_name: "何咏琳",
    email: "legal@harbour.demo",
    department: "法务合规部",
    job_title: "法务合同审阅",
    login_aliases: [
      "legal",
      "legal@harbour.demo",
      "counsel@harbour.demo",
      "he.yonglin@harbour.demo",
      "hbr-legal",
    ],
    search_keywords: ["法务", "合同", "合规", "何咏琳", "counsel"],
  },
  {
    subject: "executive",
    tenant: "harbour",
    role: "manager",
    warehouses: ["HK01", "HK02"],
    default_display_name: "顾承泽",
    email: "executive@harbour.demo",
    department: "经营管理层",
    job_title: "跨仓经营视图",
    login_aliases: [
      "executive",
      "executive@harbour.demo",
      "exec@harbour.demo",
      "gu.chengze@harbour.demo",
      "hbr-exec",
    ],
    search_keywords: ["高管", "经营", "管理层", "顾承泽", "exec"],
  },
  {
    subject: "viewer",
    tenant: "harbour",
    role: "viewer",
    warehouses: ["HK01"],
    default_display_name: "苏文静",
    email: "viewer@harbour.demo",
    department: "客户支持部",
    job_title: "只读运单查询",
    login_aliases: [
      "viewer",
      "viewer@harbour.demo",
      "su.wenjing@harbour.demo",
      "hbr-view",
    ],
    search_keywords: ["客服", "只读", "查询", "苏文静"],
  },
  {
    subject: "other-manager",
    tenant: "harbour",
    role: "manager",
    warehouses: ["HK02"],
    default_display_name: "方峻熙",
    email: "other-manager@harbour.demo",
    department: "HK02 仓储运营部",
    job_title: "HK02 跨仓隔离主管",
    login_aliases: [
      "other-manager",
      "other-manager@harbour.demo",
      "hk02-manager@harbour.demo",
      "fang.junxi@harbour.demo",
      "hbr-mgr2",
    ],
    search_keywords: ["hk02主管", "二仓主管", "方峻熙", "hk02"],
  },
  {
    subject: "island-manager",
    tenant: "island",
    role: "manager",
    warehouses: ["HK01"],
    default_display_name: "陆景行",
    email: "island-manager@island.demo",
    department: "Island 运营部",
    job_title: "Island 跨租户主管",
    login_aliases: [
      "island-manager",
      "island-manager@island.demo",
      "mgr@island.demo",
      "lu.jingxing@island.demo",
      "isl-mgr",
    ],
    search_keywords: ["island", "陆景行", "主管"],
  },
] as const;

const LOGIN_ALIAS_MAP = new Map<string, DemoPersonaId>();
for (const entry of DEMO_DIRECTORY) {
  for (const alias of entry.login_aliases) {
    LOGIN_ALIAS_MAP.set(alias.toLowerCase(), entry.subject);
  }
}

/**
 * Resolves enterprise account / email alias to canonical demo subject.
 * Enforces strict tenant domain separation (e.g., island-manager@harbour.demo -> null).
 */
export function resolveEnterpriseAccountAlias(raw: string): DemoPersonaId | null {
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return null;
  return LOGIN_ALIAS_MAP.get(normalized) ?? null;
}

export function getDemoDirectoryEntryForTenant(
  tenant: string,
  subject: string,
): DirectorySeedEntry | null {
  return (
    DEMO_DIRECTORY.find(
      (entry) => entry.tenant === tenant && entry.subject === subject,
    ) ?? null
  );
}

export type LiveActorVerification =
  | { ok: true; actor: Actor; cookie: string }
  | { ok: false; response: Response };

/**
 * Mandatory server-side session verification against FastAPI GET /v1/me.
 * Forwards ONLY the browser Cookie header (never Authorization, never trusts client tenant/subject).
 */
export async function verifyLiveActor(req: Request): Promise<LiveActorVerification> {
  const cookie = req.headers.get("cookie") || "";
  if (!cookie.trim()) {
    return {
      ok: false,
      response: new Response(
        JSON.stringify({
          detail: {
            code: "UNAUTHORIZED",
            message: "会话已失效，请重新登录。",
          },
        }),
        {
          status: 401,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          },
        },
      ),
    };
  }

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(`${getApiBaseUrl()}/v1/me`, {
      method: "GET",
      headers: {
        Cookie: cookie,
        Accept: "application/json",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    return {
      ok: false,
      response: new Response(
        JSON.stringify({
          detail: {
            code: "UPSTREAM_UNAVAILABLE",
            message: "后端服务暂不可用，请稍后重试。",
          },
        }),
        {
          status: 503,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Retry-After": "2",
            "Cache-Control": "no-store",
          },
        },
      ),
    };
  }

  const rawText = await upstreamRes.text();
  let parsed: unknown = null;
  if (rawText) {
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = rawText;
    }
  }

  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  const reqId = upstreamRes.headers.get("x-request-id");
  if (reqId) headers.set("X-Request-ID", reqId);

  if (!upstreamRes.ok || typeof parsed !== "object" || parsed === null) {
    return {
      ok: false,
      response: new Response(
        JSON.stringify(sanitizeErrorPayload(upstreamRes.status, parsed)),
        {
          status: upstreamRes.status,
          headers,
        },
      ),
    };
  }

  const obj = parsed as Record<string, unknown>;
  if (typeof obj.subject !== "string" || typeof obj.tenant !== "string") {
    return {
      ok: false,
      response: new Response(
        JSON.stringify({
          detail: {
            code: "UNAUTHORIZED",
            message: "会话已失效，请重新登录。",
          },
        }),
        { status: 401, headers },
      ),
    };
  }

  const actor: Actor = {
    subject: obj.subject,
    tenant: obj.tenant,
    role: (typeof obj.role === "string" ? obj.role : "viewer") as Role,
    warehouses: Array.isArray(obj.warehouses)
      ? obj.warehouses.filter((w): w is string => typeof w === "string")
      : [],
    grants: Array.isArray(obj.grants)
      ? (obj.grants.filter((g): g is string => typeof g === "string") as Actor["grants"])
      : [],
  };

  return { ok: true, actor, cookie };
}

async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (cursor < items.length) {
        const idx = cursor;
        cursor += 1;
        await worker(items[idx]!);
      }
    },
  );
  await Promise.all(runners);
}

interface ContactAccumulator {
  subject: string;
  tenant: string;
  display_name: string;
  default_display_name: string;
  email: string;
  department: string;
  job_title: string;
  role: string;
  warehouses: string[];
  has_avatar: boolean;
  avatar_url: string | null;
  profile_version: number;
  direct_room_id: string | null;
  direct_room_preferred: boolean;
  shared_room_ids: string[];
  search_keywords: string[];
}

export interface ResolveTenantContactsOptions {
  q?: string;
  includeSelf?: boolean;
  warehouse?: string;
  limit?: number;
  locale?: Locale;
}

export async function resolveTenantContacts(
  actor: Actor,
  cookie: string,
  options?: ResolveTenantContactsOptions,
): Promise<{
  tenant: string;
  can_chat: boolean;
  total: number;
  items: CompanyContact[];
}> {
  const apiBase = getApiBaseUrl();
  const canChat = actor.grants.includes("chat.use");
  const locale: Locale = options?.locale ?? DEFAULT_LOCALE;
  const accMap = new Map<string, ContactAccumulator>();

  const ensureEntry = (subject: string): ContactAccumulator => {
    const existing = accMap.get(subject);
    if (existing) return existing;
    const seed = isDemoAuthEnabled()
      ? getDemoDirectoryEntryForTenant(actor.tenant, subject)
      : null;
    const trilingualPersona = PERSONA_LOCALIZATIONS[subject as DemoPersonaId];
    const extraSearchTerms = trilingualPersona
      ? [
          trilingualPersona["zh-CN"].displayName,
          trilingualPersona["zh-HK"].displayName,
          trilingualPersona.en.displayName,
          trilingualPersona["zh-HK"].label,
          trilingualPersona.en.label,
          trilingualPersona["zh-HK"].department,
          trilingualPersona.en.department,
        ]
      : [];
    const defaultDisplayName = trilingualPersona
      ? trilingualPersona[locale].displayName
      : (seed?.default_display_name ?? subject);
    const created: ContactAccumulator = {
      subject,
      tenant: actor.tenant,
      display_name: defaultDisplayName,
      default_display_name: defaultDisplayName,
      email: seed?.email ?? `${subject}@${actor.tenant}.local`,
      department: localizeContactDepartment(
        seed?.department ?? "",
        subject,
        locale,
      ),
      job_title: localizeContactJobTitle(
        seed?.job_title ?? "",
        subject,
        locale,
      ),
      role: seed?.role ?? "member",
      warehouses: seed ? sortWarehouses(seed.warehouses) : [],
      has_avatar: false,
      avatar_url: null,
      profile_version: 0,
      direct_room_id: null,
      direct_room_preferred: false,
      shared_room_ids: [],
      search_keywords: seed
        ? [...seed.search_keywords, ...extraSearchTerms]
        : extraSearchTerms,
    };
    accMap.set(subject, created);
    return created;
  };

  // Source A: Strictly tenant-scoped local demo directory (when demo auth is enabled)
  if (isDemoAuthEnabled()) {
    for (const seed of DEMO_DIRECTORY) {
      if (seed.tenant !== actor.tenant) continue;
      ensureEntry(seed.subject);
    }
  }

  // Source B: Live shared chat rooms (works in both Demo and Production OIDC)
  if (canChat) {
    try {
      const roomsRes = await fetch(`${apiBase}/v1/chat/rooms?limit=50`, {
        method: "GET",
        headers: { Cookie: cookie, Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(2500),
      });
      if (roomsRes.ok) {
        const roomsPayload = (await roomsRes.json()) as { items?: ChatRoom[] };
        const rooms = Array.isArray(roomsPayload.items)
          ? roomsPayload.items.slice(0, 25)
          : [];

        await runWithConcurrency(rooms, 5, async (room) => {
          try {
            const memRes = await fetch(
              `${apiBase}/v1/chat/rooms/${encodeURIComponent(room.id)}/members?limit=25`,
              {
                method: "GET",
                headers: { Cookie: cookie, Accept: "application/json" },
                cache: "no-store",
                signal: AbortSignal.timeout(1500),
              },
            );
            if (!memRes.ok) return;
            const memPayload = (await memRes.json()) as { items?: string[] };
            const members = Array.isArray(memPayload.items)
              ? memPayload.items.filter((m): m is string => typeof m === "string")
              : [];

            const isTwoMemberDm =
              members.length === 2 && members.includes(actor.subject);
            const isPreferredDmTitle = isDirectRoomTitle(room.title);

            for (const memberSub of members) {
              const entry = ensureEntry(memberSub);
              if (!entry.shared_room_ids.includes(room.id)) {
                entry.shared_room_ids.push(room.id);
              }
              if (isTwoMemberDm && memberSub !== actor.subject) {
                if (
                  entry.direct_room_id === null ||
                  (isPreferredDmTitle && !entry.direct_room_preferred)
                ) {
                  entry.direct_room_id = room.id;
                  entry.direct_room_preferred = isPreferredDmTitle;
                }
              }
            }
          } catch {
            // Non-blocking per-room degradation
          }
        });
      }
    } catch {
      // Non-blocking room discovery degradation
    }
  }

  // Source C: Optional admin employee directory merge for access-admin
  if (
    actor.role === "admin" &&
    actor.grants.includes("workbench.access.manage")
  ) {
    try {
      const empRes = await fetch(
        `${apiBase}/v1/workbench/module-access/employees?limit=100`,
        {
          method: "GET",
          headers: { Cookie: cookie, Accept: "application/json" },
          cache: "no-store",
          signal: AbortSignal.timeout(1500),
        },
      );
      if (empRes.ok) {
        const empPayload = (await empRes.json()) as { items?: string[] };
        if (Array.isArray(empPayload.items)) {
          for (const sub of empPayload.items) {
            if (typeof sub === "string" && sub.trim()) {
              ensureEntry(sub.trim());
            }
          }
        }
      }
    } catch {
      // Best-effort only
    }
  }

  // Source D: Live room-member profile projection (updates display_name & avatar_url)
  const peersWithSharedRoom = Array.from(accMap.values())
    .filter((entry) => entry.shared_room_ids.length > 0 && entry.subject !== actor.subject)
    .slice(0, 20);

  await runWithConcurrency(peersWithSharedRoom, 5, async (entry) => {
    const sharedRoomId = entry.direct_room_id || entry.shared_room_ids[0];
    if (!sharedRoomId) return;
    try {
      const profRes = await fetch(
        `${apiBase}/v1/chat/rooms/${encodeURIComponent(sharedRoomId)}/members/${encodeURIComponent(entry.subject)}/profile`,
        {
          method: "GET",
          headers: { Cookie: cookie, Accept: "application/json" },
          cache: "no-store",
          signal: AbortSignal.timeout(1500),
        },
      );
      if (!profRes.ok) return;
      const prof = (await profRes.json()) as Profile;
      if (typeof prof.display_name === "string" && prof.display_name.trim()) {
        entry.display_name = prof.display_name.trim();
      }
      entry.has_avatar = Boolean(prof.has_avatar);
      entry.profile_version = typeof prof.version === "number" ? prof.version : 0;
      entry.avatar_url = prof.has_avatar
        ? `/v1/chat/rooms/${encodeURIComponent(sharedRoomId)}/members/${encodeURIComponent(entry.subject)}/profile/avatar?v=${entry.profile_version}`
        : null;
    } catch {
      // Non-blocking profile projection
    }
  });

  // Filter & rank deterministically
  const includeSelf = Boolean(options?.includeSelf);
  const warehouseFilter = options?.warehouse?.trim().toUpperCase() || "";
  const query = (options?.q || "").trim().toLowerCase();
  const limit = Math.max(1, Math.min(50, options?.limit ?? 30));

  let list = Array.from(accMap.values());
  if (!includeSelf) {
    list = list.filter((entry) => entry.subject !== actor.subject);
  }
  if (warehouseFilter) {
    list = list.filter((entry) =>
      entry.warehouses.some((w) => w.toUpperCase() === warehouseFilter),
    );
  }
  if (query) {
    list = list.filter((entry) => {
      const haystacks = [
        entry.subject,
        entry.display_name,
        entry.default_display_name,
        entry.email,
        entry.department,
        entry.job_title,
        entry.role,
        ...entry.warehouses,
        ...entry.search_keywords,
      ];
      return haystacks.some((h) => h.toLowerCase().includes(query));
    });
  }

  const actorWhSet = new Set(actor.warehouses);
  list.sort((a, b) => {
    if (query) {
      const aExact =
        a.subject.toLowerCase() === query ||
        a.display_name.toLowerCase().startsWith(query) ||
        a.subject.toLowerCase().startsWith(query);
      const bExact =
        b.subject.toLowerCase() === query ||
        b.display_name.toLowerCase().startsWith(query) ||
        b.subject.toLowerCase().startsWith(query);
      if (aExact !== bExact) return aExact ? -1 : 1;
    }
    const aHasDm = a.direct_room_id !== null;
    const bHasDm = b.direct_room_id !== null;
    if (aHasDm !== bHasDm) return aHasDm ? -1 : 1;

    const aSharesWh = a.warehouses.some((w) => actorWhSet.has(w));
    const bSharesWh = b.warehouses.some((w) => actorWhSet.has(w));
    if (aSharesWh !== bSharesWh) return aSharesWh ? -1 : 1;

    return a.subject.localeCompare(b.subject);
  });

  const total = list.length;
  const items: CompanyContact[] = list.slice(0, limit).map((entry) => ({
    subject: entry.subject,
    tenant: entry.tenant,
    display_name: entry.display_name,
    default_display_name: entry.default_display_name,
    email: entry.email,
    department: entry.department,
    job_title: entry.job_title,
    role: entry.role,
    warehouses: entry.warehouses,
    has_avatar: entry.has_avatar,
    avatar_url: entry.avatar_url,
    profile_version: entry.profile_version,
    direct_room_id: entry.direct_room_id,
    shared_room_count: entry.shared_room_ids.length,
  }));

  return {
    tenant: actor.tenant,
    can_chat: canChat,
    total,
    items,
  };
}
