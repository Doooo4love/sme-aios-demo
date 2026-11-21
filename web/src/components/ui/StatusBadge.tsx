"use client";

import React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  HelpCircle,
  Loader2,
  OctagonAlert,
  PauseCircle,
  Send,
  ShieldCheck,
  ShieldOff,
  XCircle,
} from "lucide-react";
import type { AssuranceState, ProposalState } from "@/lib/types";

export type KnownStatus =
  | ProposalState
  | AssuranceState
  | "inherited"
  | "active"
  | "revoked"
  | "expired"
  | "healthy"
  | "paused"
  | "unavailable"
  | "OPEN"
  | "CLOSED"
  | "PAID"
  | "VOID"
  | "cancelled"
  | "returned";

type Tone = "emerald" | "amber" | "crimson" | "accent" | "neutral";

interface StatusDescriptor {
  label: string;
  tone: Tone;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  spin?: boolean;
}

const STATUS_MAP: Record<string, StatusDescriptor> = {
  // Proposal states
  PROPOSED: { label: "待审批", tone: "neutral", icon: Clock },
  QUEUED: { label: "已批准 · 待派发", tone: "accent", icon: Clock },
  SENDING: { label: "ERP 写入中", tone: "accent", icon: Send },
  VERIFYING: { label: "回执核验中", tone: "accent", icon: Loader2, spin: true },
  CHECKING: { label: "回执复核中", tone: "amber", icon: Loader2, spin: true },
  OUTCOME_UNKNOWN: { label: "结果待确认", tone: "amber", icon: HelpCircle },
  VERIFIED: { label: "已核验入账", tone: "emerald", icon: CheckCircle2 },
  REJECTED: { label: "已拒绝 / 终止", tone: "crimson", icon: XCircle },
  NEEDS_OPERATOR: { label: "需人工核查", tone: "crimson", icon: OctagonAlert },
  returned: { label: "已退回修改", tone: "amber", icon: AlertTriangle },

  // Assurance states
  PENDING: { label: "待审阅", tone: "neutral", icon: Clock },
  HELD: { label: "硬性留置", tone: "crimson", icon: OctagonAlert },
  APPROVED: { label: "已批准", tone: "emerald", icon: CheckCircle2 },

  // Module access states
  inherited: { label: "继承身份默认", tone: "neutral", icon: ShieldCheck },
  active: { label: "已显式授权", tone: "emerald", icon: ShieldCheck },
  revoked: { label: "已撤销", tone: "crimson", icon: ShieldOff },
  expired: { label: "已到期", tone: "amber", icon: AlertTriangle },

  // System health / write control / domain states
  healthy: { label: "运行正常", tone: "emerald", icon: CheckCircle2 },
  paused: { label: "写入已暂停", tone: "crimson", icon: PauseCircle },
  unavailable: { label: "服务暂不可用", tone: "amber", icon: AlertTriangle },
  OPEN: { label: "进行中", tone: "accent", icon: Clock },
  CLOSED: { label: "已关闭", tone: "neutral", icon: CheckCircle2 },
  PAID: { label: "已结算", tone: "emerald", icon: CheckCircle2 },
  VOID: { label: "已作废", tone: "crimson", icon: XCircle },
  cancelled: { label: "已取消", tone: "crimson", icon: XCircle },
};

const TONE_STYLES: Record<Tone, string> = {
  emerald:
    "text-[var(--status-emerald)] bg-[var(--status-emerald-wash)] border-[var(--status-emerald-border)]",
  amber:
    "text-[var(--status-amber-ink)] bg-[var(--status-amber-wash)] border-[var(--status-amber-border)]",
  crimson:
    "text-[var(--status-crimson)] bg-[var(--status-crimson-wash)] border-[var(--status-crimson-border)]",
  accent:
    "text-[var(--accent)] bg-[var(--accent-wash)] border-[var(--accent-border)]",
  neutral:
    "text-[var(--status-neutral)] bg-[var(--status-neutral-wash)] border-[var(--status-neutral-border)]",
};

export interface StatusBadgeProps {
  status: KnownStatus | (string & {});
  label?: string;
  compact?: boolean;
  className?: string;
}

export function StatusBadge({
  status,
  label,
  compact = false,
  className = "",
}: StatusBadgeProps) {
  const desc: StatusDescriptor = STATUS_MAP[status] ?? {
    label: label ?? status,
    tone: "neutral",
    icon: Clock,
  };
  const Icon = desc.icon;
  const text = label ?? desc.label;

  return (
    <span
      className={[
        "inline-flex items-center gap-1.5 border rounded-[4px] font-medium whitespace-nowrap leading-none",
        compact ? "px-1.5 py-0.5 text-[11px]" : "px-2 py-1 text-[12px]",
        TONE_STYLES[desc.tone],
        className,
      ].join(" ")}
    >
      <Icon
        className={[
          compact ? "h-3 w-3" : "h-3.5 w-3.5",
          "shrink-0",
          desc.spin ? "animate-spin" : "",
        ].join(" ")}
        strokeWidth={1.75}
        aria-hidden="true"
      />
      <span>{text}</span>
    </span>
  );
}
