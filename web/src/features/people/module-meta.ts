import {
  DEFAULT_LOCALE,
  GRANT_LABELS_I18N,
  MODULE_ACCESS_META_I18N,
  TIMEZONE_LABELS_I18N,
  type Locale,
  type TrilingualText,
} from "@/lib/i18n";
import type { Grant, ModuleAssignment } from "@/lib/types";

export const MAX_EXPIRES_AT_UNIX = 4_102_444_800; // 2100-01-01T00:00:00Z (backend upper bound)

export const PREFERRED_MODULE_ORDER: readonly string[] = [
  "orders",
  "dispatch",
  "invoice-review",
  "warehouse-insights",
  "approvals",
  "agent-web",
  "agent-collaboration",
  "agent-knowledge",
];

/**
 * Harmonized module titles aligned with Workbench nav labels and S-3 canonical glossary
 * (orders -> 订单进件/訂單進件/Orders, dispatch -> 运单调度/運單調度/Dispatch,
 * invoice-review -> 发票审阅/發票審閱/Invoice Review,
 * warehouse-insights -> 仓库经营汇总/倉庫營運摘要/Warehouse Insights,
 * approvals -> 主管审批/主管審批/Approvals).
 */
const HARMONIZED_MODULE_TITLES: Readonly<Record<string, TrilingualText>> = {
  orders: {
    "zh-CN": "订单进件",
    "zh-HK": "訂單進件",
    en: "Orders",
  },
  dispatch: {
    "zh-CN": "运单调度",
    "zh-HK": "運單調度",
    en: "Dispatch",
  },
  "invoice-review": {
    "zh-CN": "发票审阅",
    "zh-HK": "發票審閱",
    en: "Invoice Review",
  },
  "warehouse-insights": {
    "zh-CN": "仓库经营汇总",
    "zh-HK": "倉庫營運摘要",
    en: "Warehouse Insights",
  },
  approvals: {
    "zh-CN": "主管审批",
    "zh-HK": "主管審批",
    en: "Approvals",
  },
};

export interface ModuleDisplayMeta {
  id: string;
  title: string;
  description: string;
  index: string;
}

export interface GrantDisplayMeta {
  label: string;
  mode: "read" | "write" | "approve";
  requires?: Grant;
}

const GRANT_MODES: Partial<
  Record<Grant, { mode: "read" | "write" | "approve"; requires?: Grant }>
> = {
  "order.read": { mode: "read" },
  "order.work": { mode: "write", requires: "order.read" },
  "shipment.read": { mode: "read" },
  "shipment.reschedule": { mode: "write", requires: "shipment.read" },
  "finance.read": { mode: "read" },
  "decision.read": { mode: "read" },
  "workbench.approve.orders": { mode: "approve" },
  "workbench.approve.shipments": { mode: "approve" },
};

const GRANT_MODE_RANK: Record<"read" | "write" | "approve", number> = {
  read: 0,
  write: 1,
  approve: 2,
};

// Mirrors aios_platform/module_access.py prerequisites verbatim
export const GRANT_PREREQUISITES: Partial<Record<Grant, Grant>> = {
  "order.work": "order.read",
  "shipment.reschedule": "shipment.read",
};

export function getGrantLabel(
  grant: Grant,
  locale: Locale = DEFAULT_LOCALE,
): string {
  return GRANT_LABELS_I18N[grant]?.[locale] ?? grant;
}

export function getGrantMeta(
  grant: Grant,
  locale: Locale = DEFAULT_LOCALE,
): GrantDisplayMeta | undefined {
  const modeInfo = GRANT_MODES[grant];
  const labelEntry = GRANT_LABELS_I18N[grant];
  if (!modeInfo && !labelEntry) return undefined;
  return {
    label: labelEntry?.[locale] ?? grant,
    mode: modeInfo?.mode ?? "read",
    requires: modeInfo?.requires,
  };
}

/**
 * Deterministic grant display order: prerequisite read grants always precede
 * dependent write grants, followed by approval grants; catalog order breaks ties.
 */
export function sortGrantsByDependency(
  grants: readonly Grant[],
  catalogOrder?: readonly Grant[],
): Grant[] {
  const catalogRank = new Map<Grant, number>(
    (catalogOrder ?? []).map((g, idx) => [g, idx]),
  );
  return [...grants].sort((a, b) => {
    // Explicit prerequisite relationship always wins
    if (GRANT_PREREQUISITES[b] === a) return -1;
    if (GRANT_PREREQUISITES[a] === b) return 1;

    const modeA = GRANT_MODES[a]?.mode ?? "read";
    const modeB = GRANT_MODES[b]?.mode ?? "read";
    if (GRANT_MODE_RANK[modeA] !== GRANT_MODE_RANK[modeB]) {
      return GRANT_MODE_RANK[modeA] - GRANT_MODE_RANK[modeB];
    }

    const rankA = catalogRank.get(a);
    const rankB = catalogRank.get(b);
    if (rankA !== undefined && rankB !== undefined && rankA !== rankB) {
      return rankA - rankB;
    }
    return a.localeCompare(b, "en");
  });
}

export function getDependentWriteGrants(readGrant: Grant): Grant[] {
  return (Object.entries(GRANT_PREREQUISITES) as Array<[Grant, Grant]>)
    .filter(([, required]) => required === readGrant)
    .map(([dependent]) => dependent);
}

export type ModuleEffectiveState = "inherited" | "active" | "revoked" | "expired";

export interface ModuleStatePresentation {
  status: ModuleEffectiveState;
  label: string;
  summary: string;
}

const MODULE_STATE_I18N: Readonly<
  Record<
    ModuleEffectiveState,
    { label: TrilingualText; summary: TrilingualText }
  >
> = {
  inherited: {
    label: {
      "zh-CN": "继承身份权限",
      "zh-HK": "繼承身份權限",
      en: "Inherited",
    },
    summary: {
      "zh-CN": "尚未单独配置，当前沿用员工默认权限。",
      "zh-HK": "尚未單獨設定，目前沿用員工預設權限。",
      en: "Not explicitly configured; currently inheriting the employee's default identity grants.",
    },
  },
  active: {
    label: {
      "zh-CN": "已显式配置",
      "zh-HK": "已顯式設定",
      en: "Configured",
    },
    summary: {
      "zh-CN":
        "独立授权规则生效中，实际访问范围将与员工身份已验证仓库取交集。",
      "zh-HK":
        "獨立授權規則生效中，實際存取範圍將與員工身份已驗證倉庫取交集。",
      en: "Explicit override active; effective access intersects with verified identity warehouses.",
    },
  },
  revoked: {
    label: {
      "zh-CN": "已撤销",
      "zh-HK": "已撤銷",
      en: "Revoked",
    },
    summary: {
      "zh-CN": "已撤销此模块授权，相关查询与待派发提案已阻断。",
      "zh-HK": "已撤銷此模組授權，相關查詢與待派發提案已阻斷。",
      en: "Module access revoked; related queries and queued proposals are blocked.",
    },
  },
  expired: {
    label: {
      "zh-CN": "已到期",
      "zh-HK": "已到期",
      en: "Expired",
    },
    summary: {
      "zh-CN": "该授权已超过设定到期时间，当前不再开放此模块。",
      "zh-HK": "該授權已超過設定到期時間，目前不再開放此模組。",
      en: "Assignment has passed its expiration timestamp and this module is no longer active.",
    },
  },
};

export function classifyModuleAssignment(
  assignment: ModuleAssignment | undefined,
  nowUnixSeconds: number,
  locale: Locale = DEFAULT_LOCALE,
): ModuleStatePresentation {
  let status: ModuleEffectiveState;
  if (!assignment) {
    status = "inherited";
  } else if (
    assignment.grants.length === 0 &&
    assignment.warehouses.length === 0
  ) {
    status = "revoked";
  } else if (
    typeof assignment.expires_at === "number" &&
    assignment.expires_at <= nowUnixSeconds
  ) {
    status = "expired";
  } else {
    status = "active";
  }

  const copy = MODULE_STATE_I18N[status];
  return {
    status,
    label: copy.label[locale],
    summary: copy.summary[locale],
  };
}

export function sortCatalogModuleIds(moduleIds: string[]): string[] {
  const rank = new Map(PREFERRED_MODULE_ORDER.map((id, idx) => [id, idx]));
  return [...moduleIds].sort((a, b) => {
    const ra = rank.get(a);
    const rb = rank.get(b);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return a.localeCompare(b);
  });
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function unixSecondsToLocalInput(
  seconds: number | null | undefined,
): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    return "";
  }
  const d = new Date(seconds * 1000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function formatOffsetDaysLocalInput(days: number): string {
  const target = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return `${target.getFullYear()}-${pad2(target.getMonth() + 1)}-${pad2(target.getDate())} ${pad2(target.getHours())}:${pad2(target.getMinutes())}`;
}

/**
 * Parses localized `YYYY-MM-DD HH:MM` or ISO `YYYY-MM-DDTHH:MM` strings strictly
 * in the user's local timezone and returns Unix seconds (or null if invalid).
 */
export function localInputToUnixSeconds(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const match =
    /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(
      trimmed,
    );
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = match[4] !== undefined ? Number(match[4]) : 23;
  const minute = match[5] !== undefined ? Number(match[5]) : 59;
  const second = match[6] !== undefined ? Number(match[6]) : 0;

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    return null;
  }

  const d = new Date(year, month - 1, day, hour, minute, second, 0);
  // Reject calendar rollover such as 2026-02-31
  if (
    d.getFullYear() !== year ||
    d.getMonth() !== month - 1 ||
    d.getDate() !== day
  ) {
    return null;
  }
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

const LOCAL_TIME_FALLBACK: TrilingualText = {
  "zh-CN": "本地时间",
  "zh-HK": "本地時間",
  en: "Local time",
};

export function getLocalTimezoneLabel(locale: Locale = DEFAULT_LOCALE): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && TIMEZONE_LABELS_I18N[tz]) {
      return TIMEZONE_LABELS_I18N[tz]![locale];
    }
    const offsetMin = -new Date().getTimezoneOffset();
    const sign = offsetMin >= 0 ? "+" : "-";
    const abs = Math.abs(offsetMin);
    const hh = String(Math.floor(abs / 60)).padStart(2, "0");
    const mm = String(abs % 60).padStart(2, "0");
    return `${LOCAL_TIME_FALLBACK[locale]} UTC${sign}${hh}:${mm}`;
  } catch {
    return LOCAL_TIME_FALLBACK[locale];
  }
}

const FALLBACK_MODULE_DESC: TrilingualText = {
  "zh-CN": "租户级工作台模块授权配置。",
  "zh-HK": "租戶級工作台模組授權設定。",
  en: "Tenant-level workbench module access assignment.",
};

export function getModuleMeta(
  moduleId: string,
  fallbackIndex: number,
  locale: Locale = DEFAULT_LOCALE,
): ModuleDisplayMeta {
  const known = MODULE_ACCESS_META_I18N[moduleId];
  const harmonizedTitle = HARMONIZED_MODULE_TITLES[moduleId];
  if (known) {
    return {
      id: moduleId,
      index: known.index,
      title: (harmonizedTitle ?? known.title)[locale],
      description: known.description[locale],
    };
  }
  return {
    id: moduleId,
    index: String(fallbackIndex + 1).padStart(2, "0"),
    title: harmonizedTitle ? harmonizedTitle[locale] : moduleId,
    description: FALLBACK_MODULE_DESC[locale],
  };
}
