import type { DemoPersonaId, DemoPersonaMeta } from "@/lib/types";

export const DEMO_PERSONAS: readonly DemoPersonaMeta[] = [
  {
    subject: "operator",
    tenant: "harbour",
    role: "operator",
    warehouses: ["HK01"],
    label: "接单 / 运单经办",
    summary: "HK01 订单进件、运单改期提案与预审发起（不可自批）",
    group: "core",
    username: "operator",
    email: "operator@harbour.demo",
    display_name: "林明哲",
    department: "HK01 仓储运营部",
  },
  {
    subject: "manager",
    tenant: "harbour",
    role: "manager",
    warehouses: ["HK01"],
    label: "独立主管审批",
    summary: "HK01 审批队列、采购预审轨与异常复核",
    group: "core",
    username: "manager",
    email: "manager@harbour.demo",
    display_name: "陈志远",
    department: "HK01 仓储运营部",
  },
  {
    subject: "finance",
    tenant: "harbour",
    role: "viewer",
    warehouses: ["HK01"],
    label: "财务审阅",
    summary: "HK01 发票核对（INV-100）与财务预审轨（含银行字段）",
    group: "core",
    username: "finance",
    email: "finance@harbour.demo",
    display_name: "周婉清",
    department: "财务核算部",
  },
  {
    subject: "access-admin",
    tenant: "harbour",
    role: "admin",
    warehouses: ["HK01", "HK02"],
    label: "全站点权限管理员",
    summary: "管理员工模块授权与站点范围（HK01 / HK02）",
    group: "core",
    username: "access-admin",
    email: "access-admin@harbour.demo",
    display_name: "许嘉豪",
    department: "身份与权限治理部",
  },
  {
    subject: "admin",
    tenant: "harbour",
    role: "admin",
    warehouses: ["HK01"],
    label: "运维管理员",
    summary: "ERP 写入闸门、停权控制、Worker 步进与审计检查点",
    group: "core",
    username: "admin",
    email: "admin@harbour.demo",
    display_name: "郑启帆",
    department: "平台运维部",
  },
  {
    subject: "quality",
    tenant: "harbour",
    role: "viewer",
    warehouses: ["HK01"],
    label: "来料质检复核",
    summary: "HK01 质检预审案件（QA-200）与质量轨裁决",
    group: "specialist",
    username: "quality",
    email: "quality@harbour.demo",
    display_name: "梁思琪",
    department: "品质保障部",
  },
  {
    subject: "legal",
    tenant: "harbour",
    role: "viewer",
    warehouses: ["HK01"],
    label: "法务合同审阅",
    summary: "HK01 合同预审案件（CT-300）与法务轨裁决",
    group: "specialist",
    username: "legal",
    email: "legal@harbour.demo",
    display_name: "何咏琳",
    department: "法务合规部",
  },
  {
    subject: "executive",
    tenant: "harbour",
    role: "manager",
    warehouses: ["HK01", "HK02"],
    label: "跨仓经营视图",
    summary: "HK01 / HK02 经营汇总只读视图（默认无审批模块授权）",
    group: "specialist",
    username: "executive",
    email: "executive@harbour.demo",
    display_name: "顾承泽",
    department: "经营管理层",
  },
  {
    subject: "viewer",
    tenant: "harbour",
    role: "viewer",
    warehouses: ["HK01"],
    label: "只读运单查询",
    summary: "HK01 只读运单查询，无任何提交或改期权限",
    group: "specialist",
    username: "viewer",
    email: "viewer@harbour.demo",
    display_name: "苏文静",
    department: "客户支持部",
  },
  {
    subject: "other-manager",
    tenant: "harbour",
    role: "manager",
    warehouses: ["HK02"],
    label: "HK02 跨仓隔离主管",
    summary: "同租户 HK02 独立主管，无法访问 HK01 单据与运单",
    group: "isolation",
    username: "other-manager",
    email: "other-manager@harbour.demo",
    display_name: "方峻熙",
    department: "HK02 仓储运营部",
  },
  {
    subject: "island-manager",
    tenant: "island",
    role: "manager",
    warehouses: ["HK01"],
    label: "Island 跨租户隔离",
    summary: "第二租户 island（HK01），验证跨租户完全隔离",
    group: "isolation",
    username: "island-manager",
    email: "island-manager@island.demo",
    display_name: "陆景行",
    department: "Island 运营部",
  },
] as const;

export const DEMO_PERSONA_SET: ReadonlySet<string> = new Set<DemoPersonaId>(
  DEMO_PERSONAS.map((p) => p.subject),
);

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export function getApiBaseUrl(): string {
  const raw =
    process.env.AIOS_API_BASE_URL ||
    process.env.AIOS_API_INTERNAL_URL ||
    "http://127.0.0.1:8760";
  return trimTrailingSlash(raw.trim());
}

export function getAssuranceApiBaseUrl(): string {
  const raw = process.env.AIOS_ASSURANCE_API_BASE_URL?.trim();
  if (!raw) return getApiBaseUrl();
  return trimTrailingSlash(raw);
}

export function getUpstreamBaseUrlForPath(normalizedPath: string): string {
  if (
    normalizedPath === "/v1/assurance" ||
    normalizedPath.startsWith("/v1/assurance/")
  ) {
    return getAssuranceApiBaseUrl();
  }
  return getApiBaseUrl();
}

export function getBrowserOrigin(): string {
  const raw = process.env.AIOS_BROWSER_ORIGIN || "http://localhost:3000";
  return trimTrailingSlash(raw.trim());
}

export function getDemoSecret(): string | null {
  const raw = process.env.AIOS_DEMO_SECRET;
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes(".")) return null;
  return trimmed;
}

export function isDemoAuthEnabled(): boolean {
  return process.env.AIOS_ENABLE_DEMO_AUTH === "1" && getDemoSecret() !== null;
}

/**
 * Server-only password for controlled local enterprise account+password login.
 * Active ONLY when AIOS_ENABLE_DEMO_AUTH === "1". NEVER exposed in API payloads.
 */
export function getDemoLoginPassword(): string | null {
  if (!isDemoAuthEnabled()) return null;
  const raw = process.env.AIOS_DEMO_LOGIN_PASSWORD?.trim();
  return raw && raw.length > 0 ? raw : "aios2026";
}

export function isOidcLoginEnabled(): boolean {
  if (process.env.AIOS_OIDC_LOGIN_ENABLED === "1") return true;
  if (process.env.AIOS_OIDC_LOGIN_ENABLED === "0") return false;
  return !isDemoAuthEnabled();
}

export function isValidBrowserOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  return trimTrailingSlash(origin.trim()) === getBrowserOrigin();
}

export function makeOriginRejectedResponse(): Response {
  return new Response(
    JSON.stringify({
      detail: {
        code: "ORIGIN_REJECTED",
        message: "请求来源未获授权。",
      },
    }),
    {
      status: 403,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    },
  );
}
