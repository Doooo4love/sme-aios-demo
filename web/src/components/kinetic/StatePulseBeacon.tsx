"use client";

import React from "react";
import { useLocale, type TranslationKey } from "@/lib/i18n";
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

const DEFAULT_LABEL_KEYS: Record<BeaconState, TranslationKey> = {
  processing_turn: "kinetic.processingRequest",
  queued: "kinetic.beacon.queued",
  sending: "kinetic.beacon.sending",
  verifying: "kinetic.beacon.verifying",
  unknown: "kinetic.beacon.unknown",
  operator_needed: "kinetic.beacon.operatorNeeded",
  verified: "kinetic.beacon.verified",
  rejected: "kinetic.beacon.rejected",
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
  const { t } = useLocale();

  // Enforce literal truthful label for in-flight turns (never fake progress/percentages)
  const displayLabel =
    state === "processing_turn"
      ? t("kinetic.processingRequest")
      : (label ?? t(DEFAULT_LABEL_KEYS[state]));

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
              stroke="var(--accent-wash-strong)"
              strokeWidth="1.4"
            />
            <circle
              cx="9"
              cy="9"
              r="7.2"
              stroke="var(--accent)"
              strokeWidth="1.6"
              strokeDasharray="13 33"
              strokeLinecap="round"
              className="aios-beacon-arc"
            />
            <circle
              cx="9"
              cy="9"
              r="2.1"
              fill="var(--accent)"
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
              stroke="var(--status-amber)"
              strokeWidth="1.4"
              fill="var(--status-amber-wash)"
            />
            <line
              x1="9"
              y1="5.3"
              x2="9"
              y2="9.6"
              stroke="var(--status-amber)"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
            <circle cx="9" cy="12.2" r="0.9" fill="var(--status-amber)" />
          </>
        )}

        {(state === "operator_needed" || state === "rejected") && (
          <>
            <circle
              cx="9"
              cy="9"
              r="7.2"
              stroke="var(--status-crimson)"
              strokeWidth="1.4"
              fill="var(--status-crimson-wash)"
            />
            {state === "rejected" ? (
              <path
                d="M6.5 6.5L11.5 11.5M11.5 6.5L6.5 11.5"
                stroke="var(--status-crimson)"
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
                  stroke="var(--status-crimson)"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
                <circle cx="9" cy="12.2" r="0.9" fill="var(--status-crimson)" />
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
              stroke="var(--status-emerald)"
              strokeWidth="1.4"
              fill="var(--status-emerald-wash)"
            />
            <path
              d="M5.7 9.2L7.9 11.4L12.4 6.9"
              stroke="var(--status-emerald)"
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
