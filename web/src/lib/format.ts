import type { ProposalAction, ProposalState } from "@/lib/types";

export function formatUnixTime(
  seconds: number | null | undefined,
  options?: { dateOnly?: boolean; withSeconds?: boolean },
): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    return "—";
  }
  const d = new Date(seconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const datePart = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (options?.dateOnly) return datePart;
  const timePart = options?.withSeconds
    ? `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${datePart} ${timePart}`;
}

export function formatClockRange(startsAt: number, endsAt: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const s = new Date(startsAt * 1000);
  const e = new Date(endsAt * 1000);
  return `${pad(s.getHours())}:${pad(s.getMinutes())} – ${pad(e.getHours())}:${pad(e.getMinutes())}`;
}

export function formatShortDigest(
  digest: string | null | undefined,
  head = 8,
  tail = 6,
): string {
  if (!digest) return "—";
  if (digest.length <= head + tail + 2) return digest;
  return `${digest.slice(0, head)}…${digest.slice(-tail)}`;
}

export function formatRelativeCountdown(expiresUnixSeconds: number): {
  label: string;
  dueSoon: boolean;
  expired: boolean;
} {
  const diff = Math.floor(expiresUnixSeconds - Date.now() / 1000);
  if (diff <= 0) {
    return { label: "已过期", dueSoon: false, expired: true };
  }
  const mins = Math.floor(diff / 60);
  const secs = diff % 60;
  if (mins < 5) {
    return {
      label: mins > 0 ? `${mins}m ${String(secs).padStart(2, "0")}s` : `${secs}s`,
      dueSoon: true,
      expired: false,
    };
  }
  if (mins < 60) {
    return { label: `${mins} 分钟后到期`, dueSoon: false, expired: false };
  }
  const hours = Math.floor(mins / 60);
  return {
    label: `${hours}h ${mins % 60}m`,
    dueSoon: false,
    expired: false,
  };
}

export function formatProposalAction(action: ProposalAction | string): string {
  switch (action) {
    case "sales_order.create_draft":
      return "销售订单草稿";
    case "shipment.reschedule":
      return "运单改期";
    default:
      return action;
  }
}

export function formatProposalStateLabel(state: ProposalState | string): string {
  switch (state) {
    case "PROPOSED":
      return "待审批";
    case "QUEUED":
      return "已批准 · 待派发";
    case "SENDING":
      return "ERP 写入中";
    case "VERIFYING":
      return "正在核对回执";
    case "CHECKING":
      return "回执复核中";
    case "OUTCOME_UNKNOWN":
      return "结果待确认";
    case "VERIFIED":
      return "已核验入账";
    case "REJECTED":
      return "已拒绝 / 终止";
    case "NEEDS_OPERATOR":
      return "需人工核查";
    default:
      return state;
  }
}

export function formatRoleLabel(role: string): string {
  switch (role) {
    case "viewer":
      return "只读";
    case "operator":
      return "经办";
    case "manager":
      return "主管";
    case "admin":
      return "管理员";
    default:
      return role;
  }
}

export function getTenantMark(tenant: string): string {
  const cleaned = tenant.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (cleaned === "HARBOUR") return "HB";
  if (cleaned === "ISLAND") return "IS";
  return (cleaned.slice(0, 2) || "AI").padEnd(2, "X");
}

export function getMonogram(name: string | null | undefined, fallback: string): string {
  const source = (name || fallback || "?").trim();
  if (!source) return "?";
  // For CJK names, take last 2 or first 1 char cleanly
  if (/[\u4e00-\u9fff]/.test(source)) {
    return source.slice(0, 2);
  }
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
  }
  return source.slice(0, 2).toUpperCase();
}

export function isSafeRelativeRedirect(next: string | null | undefined): string | null {
  if (!next) return null;
  if (!next.startsWith("/") || next.startsWith("//") || next.includes("\\")) {
    return null;
  }
  if (next.startsWith("/login")) return "/inbox";
  return next;
}
