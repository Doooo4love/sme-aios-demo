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
            <polygon
              points="5.5,1.5 12.5,1.5 16.5,5.5 16.5,12.5 12.5,16.5 5.5,16.5 1.5,12.5 1.5,5.5"
              stroke="rgba(12, 110, 145, 0.24)"
              strokeWidth="1.2"
            />
            <circle
              cx="9"
              cy="9"
              r="5.5"
              stroke="#0C6E91"
              strokeWidth="1.5"
              strokeDasharray="12 23"
              strokeLinecap="square"
              className="aios-beacon-arc"
            />
            <rect
              x="7.6"
              y="7.6"
              width="2.8"
              height="2.8"
              transform="rotate(45 9 9)"
              fill="#0C6E91"
              className="aios-beacon-core"
            />
          </>
        )}

        {state === "unknown" && (
          <>
            <polygon
              points="5.5,1.5 12.5,1.5 16.5,5.5 16.5,12.5 12.5,16.5 5.5,16.5 1.5,12.5 1.5,5.5"
              stroke="#B86E00"
              strokeWidth="1.35"
              fill="rgba(184, 110, 0, 0.08)"
            />
            <line
              x1="9"
              y1="5.2"
              x2="9"
              y2="9.8"
              stroke="#B86E00"
              strokeWidth="1.5"
              strokeLinecap="square"
            />
            <rect x="8.25" y="11.5" width="1.5" height="1.5" fill="#B86E00" />
          </>
        )}

        {(state === "operator_needed" || state === "rejected") && (
          <>
            <polygon
              points="5.5,1.5 12.5,1.5 16.5,5.5 16.5,12.5 12.5,16.5 5.5,16.5 1.5,12.5 1.5,5.5"
              stroke="#C03235"
              strokeWidth="1.35"
              fill="rgba(192, 50, 53, 0.08)"
            />
            {state === "rejected" ? (
              <path
                d="M6.4 6.4L11.6 11.6M11.6 6.4L6.4 11.6"
                stroke="#C03235"
                strokeWidth="1.5"
                strokeLinecap="square"
              />
            ) : (
              <>
                <line
                  x1="9"
                  y1="5.2"
                  x2="9"
                  y2="9.8"
                  stroke="#C03235"
                  strokeWidth="1.5"
                  strokeLinecap="square"
                />
                <rect x="8.25" y="11.5" width="1.5" height="1.5" fill="#C03235" />
              </>
            )}
          </>
        )}

        {state === "verified" && (
          <>
            <polygon
              points="5.5,1.5 12.5,1.5 16.5,5.5 16.5,12.5 12.5,16.5 5.5,16.5 1.5,12.5 1.5,5.5"
              stroke="#1A7F4B"
              strokeWidth="1.35"
              fill="rgba(26, 127, 75, 0.08)"
            />
            <path
              d="M5.6 9.2L7.9 11.5L12.5 6.8"
              stroke="#1A7F4B"
              strokeWidth="1.6"
              strokeLinecap="square"
              strokeLinejoin="miter"
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
