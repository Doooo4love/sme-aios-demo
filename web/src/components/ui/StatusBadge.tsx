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
import { useLocale } from "@/lib/i18n";
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
  | "connected"
  | "sandbox_ready"
  | "OPEN"
  | "CLOSED"
  | "PAID"
  | "VOID"
  | "cancelled"
  | "returned";

type Tone = "emerald" | "amber" | "crimson" | "accent" | "neutral";

interface StatusVisualDescriptor {
  tone: Tone;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  spin?: boolean;
}

const STATUS_VISUAL_MAP: Record<string, StatusVisualDescriptor> = {
  // Proposal states
  PROPOSED: { tone: "amber", icon: Clock },
  QUEUED: { tone: "accent", icon: Clock },
  SENDING: { tone: "accent", icon: Send },
  VERIFYING: { tone: "accent", icon: Loader2, spin: true },
  CHECKING: { tone: "amber", icon: Loader2, spin: true },
  OUTCOME_UNKNOWN: { tone: "amber", icon: HelpCircle },
  VERIFIED: { tone: "emerald", icon: CheckCircle2 },
  REJECTED: { tone: "crimson", icon: XCircle },
  NEEDS_OPERATOR: { tone: "crimson", icon: OctagonAlert },
  returned: { tone: "amber", icon: AlertTriangle },

  // Assurance states
  PENDING: { tone: "neutral", icon: Clock },
  HELD: { tone: "crimson", icon: OctagonAlert },
  APPROVED: { tone: "emerald", icon: CheckCircle2 },

  // Module access states
  inherited: { tone: "neutral", icon: ShieldCheck },
  active: { tone: "emerald", icon: ShieldCheck },
  revoked: { tone: "crimson", icon: ShieldOff },
  expired: { tone: "amber", icon: AlertTriangle },

  // System health / integrations / domain states
  healthy: { tone: "emerald", icon: CheckCircle2 },
  paused: { tone: "crimson", icon: PauseCircle },
  unavailable: { tone: "amber", icon: AlertTriangle },
  connected: { tone: "emerald", icon: CheckCircle2 },
  sandbox_ready: { tone: "neutral", icon: Clock },
  OPEN: { tone: "accent", icon: Clock },
  CLOSED: { tone: "neutral", icon: CheckCircle2 },
  PAID: { tone: "emerald", icon: CheckCircle2 },
  VOID: { tone: "crimson", icon: XCircle },
  cancelled: { tone: "crimson", icon: XCircle },
};

const TONE_STYLES: Record<Tone, string> = {
  emerald:
    "text-[var(--status-emerald)] bg-[var(--status-emerald-wash)]",
  amber:
    "text-[var(--status-amber-ink)] bg-[var(--status-amber-wash)]",
  crimson:
    "text-[var(--status-crimson)] bg-[var(--status-crimson-wash)]",
  accent:
    "text-[var(--accent-ink)] bg-[var(--accent-wash)]",
  neutral:
    "text-[var(--status-neutral)] bg-[var(--status-neutral-wash)]",
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
  const { localizeStatus } = useLocale();
  const desc: StatusVisualDescriptor = STATUS_VISUAL_MAP[status] ?? {
    tone: "neutral",
    icon: Clock,
  };
  const Icon = desc.icon;
  const text = label ?? localizeStatus(status);

  return (
    <span
      className={[
        "inline-flex items-center gap-1.5 rounded-full font-medium whitespace-nowrap leading-none",
        compact ? "px-2 py-1 text-[11px]" : "px-2.5 py-1 text-[12px]",
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
        strokeWidth={1.85}
        aria-hidden="true"
      />
      <span>{text}</span>
    </span>
  );
}
