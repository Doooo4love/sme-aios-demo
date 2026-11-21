"use client";

import React from "react";
import type { ProposalState } from "@/lib/types";

export type BeaconState =
  | "processing_turn"
  | "queued"
  | "sending"
  | "verifying"
  | "unknown"
  | "operator_needed"
  | "verified"
  | "rejected";

export interface StatePulseBeaconProps {
  state: BeaconState;
  label?: string;
  detail?: string;
  className?: string;
}

const DEFAULT_LABELS: Record<BeaconState, string> = {
  processing_turn: "正在处理请求…",
  queued: "已批准 · 等待执行",
  sending: "正在提交 ERP",
  verifying: "正在核对回执",
  unknown: "结果待确认",
  operator_needed: "需人工核查",
  verified: "已核验入账",
  rejected: "已拒绝 / 终止",
};

export function proposalStateToBeacon(state: ProposalState): BeaconState | null {
  switch (state) {
    case "QUEUED":
      return "queued";
    case "SENDING":
      return "sending";
    case "VERIFYING":
    case "CHECKING":
      return "verifying";
    case "OUTCOME_UNKNOWN":
      return "unknown";
    case "NEEDS_OPERATOR":
      return "operator_needed";
    case "VERIFIED":
      return "verified";
    case "REJECTED":
      return "rejected";
    default:
      return null;
  }
}

export function StatePulseBeacon({
  state,
  label,
  detail,
  className = "",
}: StatePulseBeaconProps) {
  // Enforce literal truthful label for in-flight turns (never fake progress/percentages)
  const displayLabel =
    state === "processing_turn"
      ? "正在处理请求…"
      : (label ?? DEFAULT_LABELS[state]);

  const isActive =
    state === "processing_turn" ||
    state === "queued" ||
    state === "sending" ||
    state === "verifying";

  const textTone =
    state === "verified"
      ? "text-[var(--status-emerald)]"
      : state === "unknown"
        ? "text-[var(--status-amber-ink)]"
        : state === "operator_needed" || state === "rejected"
          ? "text-[var(--status-crimson)]"
          : "text-[var(--ink-secondary)]";

  return (
    <span
      role="status"
      aria-live="polite"
      className={[
        "inline-flex items-center gap-2 text-[12.5px] font-medium leading-none",
        textTone,
        className,
      ].join(" ")}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 18 18"
        fill="none"
        className="shrink-0"
        aria-hidden="true"
      >
        {isActive && (
          <>
            <circle
              cx="9"
              cy="9"
              r="7.2"
              stroke="rgba(22, 104, 227, 0.16)"
              strokeWidth="1.4"
            />
            <circle
              cx="9"
              cy="9"
              r="7.2"
              stroke="#1668E3"
              strokeWidth="1.6"
              strokeDasharray="13 33"
              strokeLinecap="round"
              className="aios-beacon-arc"
            />
            <circle
              cx="9"
              cy="9"
              r="2.1"
              fill="#1668E3"
              className="aios-beacon-core"
            />
          </>
        )}

        {state === "unknown" && (
          <>
            <circle
              cx="9"
              cy="9"
              r="7.2"
              stroke="#B26200"
              strokeWidth="1.4"
              fill="rgba(178, 98, 0, 0.09)"
            />
            <line
              x1="9"
              y1="5.3"
              x2="9"
              y2="9.6"
              stroke="#B26200"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
            <circle cx="9" cy="12.2" r="0.9" fill="#B26200" />
          </>
        )}

        {(state === "operator_needed" || state === "rejected") && (
          <>
            <circle
              cx="9"
              cy="9"
              r="7.2"
              stroke="#C92A37"
              strokeWidth="1.4"
              fill="rgba(201, 42, 55, 0.09)"
            />
            {state === "rejected" ? (
              <path
                d="M6.5 6.5L11.5 11.5M11.5 6.5L6.5 11.5"
                stroke="#C92A37"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            ) : (
              <>
                <line
                  x1="9"
                  y1="5.3"
                  x2="9"
                  y2="9.6"
                  stroke="#C92A37"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
                <circle cx="9" cy="12.2" r="0.9" fill="#C92A37" />
              </>
            )}
          </>
        )}

        {state === "verified" && (
          <>
            <circle
              cx="9"
              cy="9"
              r="7.2"
              stroke="#127A46"
              strokeWidth="1.4"
              fill="rgba(18, 122, 70, 0.09)"
            />
            <path
              d="M5.7 9.2L7.9 11.4L12.4 6.9"
              stroke="#127A46"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="aios-check-reveal"
            />
          </>
        )}
      </svg>

      <span>{displayLabel}</span>

      {detail && (
        <span className="font-mono-code text-[11.5px] text-[var(--ink-muted)]">
          {detail}
        </span>
      )}
    </span>
  );
}
