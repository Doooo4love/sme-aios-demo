import type { Grant, ModuleAssignment } from "@/lib/types";

export const MAX_EXPIRES_AT_UNIX = 4_102_444_800; // 2100-01-01T00:00:00Z (backend upper bound)

export const PREFERRED_MODULE_ORDER: readonly string[] = [
  "orders",
  "dispatch",
  "invoice-review",
  "warehouse-insights",
  "approvals",
];

export interface ModuleDisplayMeta {
  id: string;
  title: string;
  description: string;
  index: string;
}

export const MODULE_META: Record<string, ModuleDisplayMeta> = {
  orders: {
    id: "orders",
    index: "01",
    title: "订单",
    description: "查看销售订单进件与草稿，或创建并提交销售订单草稿提案。",
  },
  dispatch: {
    id: "dispatch",
    index: "02",
    title: "调度",
    description: "查看仓内运单排期，或发起运单交期改期提案。",
  },
  "invoice-review": {
    id: "invoice-review",
    index: "03",
    title: "发票审阅",
    description: "按授权仓库范围查询财务发票金额、币种与结算状态。",
  },
  "warehouse-insights": {
    id: "warehouse-insights",
    index: "04",
    title: "仓库概览",
    description: "查看授权仓库的开放运单统计与经营汇总快照。",
  },
  approvals: {
    id: "approvals",
    index: "05",
    title: "审批",
    description: "独立审批订单草稿与运单改期提案（仅 manager / admin 角色生效）。",
  },
};

export interface GrantDisplayMeta {
  label: string;
  mode: "read" | "write" | "approve";
  requires?: Grant;
}

export const GRANT_META: Partial<Record<Grant, GrantDisplayMeta>> = {
  "order.read": {
    label: "读取订单进件与草稿",
    mode: "read",
  },
  "order.work": {
    label: "上传进件与创建订单草稿",
    mode: "write",
    requires: "order.read",
  },
  "shipment.read": {
    label: "读取运单排期",
    mode: "read",
  },
  "shipment.reschedule": {
    label: "发起运单改期提案",
    mode: "write",
    requires: "shipment.read",
  },
  "finance.read": {
    label: "读取财务发票",
    mode: "read",
  },
  "decision.read": {
    label: "读取仓库经营汇总",
    mode: "read",
  },
  "workbench.approve.orders": {
    label: "审批销售订单草稿",
    mode: "approve",
  },
  "workbench.approve.shipments": {
    label: "审批运单改期提案",
    mode: "approve",
  },
};

// Mirrors aios_platform/module_access.py prerequisites verbatim
export const GRANT_PREREQUISITES: Partial<Record<Grant, Grant>> = {
  "order.work": "order.read",
  "shipment.reschedule": "shipment.read",
};

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

export function classifyModuleAssignment(
  assignment: ModuleAssignment | undefined,
  nowUnixSeconds: number,
): ModuleStatePresentation {
  if (!assignment) {
    return {
      status: "inherited",
      label: "继承身份权限",
      summary: "尚未建立显式模块规则，当前沿用员工身份声明的默认权限（首次保存版本为 v0）。",
    };
  }
  if (assignment.grants.length === 0 && assignment.warehouses.length === 0) {
    return {
      status: "revoked",
      label: "已撤销",
      summary: "已写入空动作与空仓库规则，阻断该员工此模块的实时查询与待派发提案。",
    };
  }
  if (
    typeof assignment.expires_at === "number" &&
    assignment.expires_at <= nowUnixSeconds
  ) {
    return {
      status: "expired",
      label: "已到期",
      summary: "该显式配置已超过到期时间，当前不再向员工开放此模块能力。",
    };
  }
  return {
    status: "active",
    label: "已显式配置",
    summary: "显式模块规则生效中，实际访问范围将与员工身份已验证仓库取交集。",
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

export function unixSecondsToLocalInput(
  seconds: number | null | undefined,
): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    return "";
  }
  const d = new Date(seconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function localInputToUnixSeconds(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const ms = new Date(trimmed).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

export function getLocalTimezoneLabel(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const offsetMin = -new Date().getTimezoneOffset();
    const sign = offsetMin >= 0 ? "+" : "-";
    const abs = Math.abs(offsetMin);
    const hh = String(Math.floor(abs / 60)).padStart(2, "0");
    const mm = String(abs % 60).padStart(2, "0");
    return tz ? `${tz} (UTC${sign}${hh}:${mm})` : `UTC${sign}${hh}:${mm}`;
  } catch {
    return "本地时区";
  }
}

export function getModuleMeta(moduleId: string, fallbackIndex: number): ModuleDisplayMeta {
  const known = MODULE_META[moduleId];
  if (known) return known;
  return {
    id: moduleId,
    index: String(fallbackIndex + 1).padStart(2, "0"),
    title: moduleId,
    description: "租户级工作台模块授权配置。",
  };
}
