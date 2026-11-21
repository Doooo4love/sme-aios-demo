"use client";

import React from "react";
import { AlertTriangle, Check, XCircle } from "lucide-react";
import { useLocale, type TranslationKey } from "@/lib/i18n";
import type { AuditEvent, ProposalState } from "@/lib/types";

export interface ExecutionTopologyRibbonProps {
  state: ProposalState;
  checks?: number;
  events?: AuditEvent[];
  variant?: "auto" | "horizontal" | "vertical-rail";
  /** Optional inline header slot (e.g. BriefProgressChain variant="inline") */
  headerRight?: React.ReactNode;
  className?: string;
}

interface SpineNode {
  index: string;
  key: "PROPOSED" | "QUEUED" | "SENDING" | "VERIFYING" | "VERIFIED";
  labelKey: TranslationKey;
  code: string;
}

const SPINE_NODES: readonly SpineNode[] = [
  {
    index: "1",
    key: "PROPOSED",
    labelKey: "kinetic.topology.step.proposed",
    code: "PROPOSED",
  },
  {
    index: "2",
    key: "QUEUED",
    labelKey: "kinetic.topology.step.queued",
    code: "QUEUED",
  },
  {
    index: "3",
    key: "SENDING",
    labelKey: "kinetic.topology.step.sending",
    code: "SENDING",
  },
  {
    index: "4",
    key: "VERIFYING",
    labelKey: "kinetic.topology.step.verifying",
    code: "VERIFYING",
  },
  {
    index: "5",
    key: "VERIFIED",
    labelKey: "kinetic.topology.step.verified",
    code: "VERIFIED",
  },
];

function getReachedStep(state: ProposalState, events?: AuditEvent[]): number {
  switch (state) {
    case "PROPOSED":
      return 0;
    case "QUEUED":
      return 1;
    case "SENDING":
      return 2;
    case "VERIFYING":
    case "CHECKING":
      return 3;
    case "VERIFIED":
      return 4;
    case "OUTCOME_UNKNOWN":
    case "NEEDS_OPERATOR":
      return 3;
    case "REJECTED": {
      if (events?.some((e) => e.event.includes("SENDING"))) return 2;
      if (events?.some((e) => e.event.includes("APPROVED"))) return 1;
      return 0;
    }
  }
}

function findTimestampForStep(
  key: SpineNode["key"],
  events?: AuditEvent[],
): number | null {
  if (!events || events.length === 0) return null;
  const match = events.find((e) => {
    const ev = e.event.toUpperCase();
    if (key === "PROPOSED") return ev.includes("PROPOSED");
    if (key === "QUEUED") return ev.includes("APPROVED") || ev.includes("QUEUED");
    if (key === "SENDING") return ev.includes("SENDING");
    if (key === "VERIFYING") return ev.includes("VERIFYING") || ev.includes("CHECKING");
    if (key === "VERIFIED") return ev === "VERIFIED";
    return false;
  });
  return match ? match.at : null;
}

function findBranchTimestamp(
  branch: "OUTCOME_UNKNOWN" | "NEEDS_OPERATOR" | "REJECTED",
  events?: AuditEvent[],
): number | null {
  if (!events || events.length === 0) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.event.toUpperCase().includes(branch)) return e.at;
  }
  return null;
}

export function ExecutionTopologyRibbon({
  state,
  checks = 0,
  events,
  variant = "auto",
  headerRight,
  className = "",
}: ExecutionTopologyRibbonProps) {
  const { t, formatDateTime, formatTimeOnly } = useLocale();
  const reached = getReachedStep(state, events);
  const isBranch =
    state === "OUTCOME_UNKNOWN" ||
    state === "NEEDS_OPERATOR" ||
    state === "REJECTED";

  const showHorizontal = variant === "horizontal" || variant === "auto";
  const showVertical = variant === "vertical-rail" || variant === "auto";

  const branchInfo = (() => {
    if (state === "OUTCOME_UNKNOWN") {
      return {
        code: "OUTCOME_UNKNOWN",
        label: t("kinetic.topology.branch.unknown"),
        tone: "amber" as const,
        at: findBranchTimestamp("OUTCOME_UNKNOWN", events),
      };
    }
    if (state === "NEEDS_OPERATOR") {
      return {
        code: "NEEDS_OPERATOR",
        label: t("kinetic.topology.branch.operator"),
        tone: "crimson" as const,
        at: findBranchTimestamp("NEEDS_OPERATOR", events),
      };
    }
    if (state === "REJECTED") {
      return {
        code: "REJECTED",
        label: t("kinetic.topology.branch.rejected"),
        tone: "crimson" as const,
        at: findBranchTimestamp("REJECTED", events),
      };
    }
    return null;
  })();

  const getStepState = (idx: number): "verified" | "current" | "done" | "idle" => {
    if (state === "VERIFIED" && idx === 4) return "verified";
    const isCurrent =
      !isBranch &&
      ((state === "PROPOSED" && idx === 0) ||
        (state === "QUEUED" && idx === 1) ||
        (state === "SENDING" && idx === 2) ||
        ((state === "VERIFYING" || state === "CHECKING") && idx === 3));
    if (isCurrent) return "current";
    if (idx < reached) return "done";
    return "idle";
  };

  const progressRatio = reached / (SPINE_NODES.length - 1);

  return (
    <div
      className={[
        "rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] p-5",
        className,
      ].join(" ")}
    >
      <div className="mb-5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span className="text-[13px] font-semibold text-[var(--ink-primary)]">
            {t("kinetic.topology.title")}
          </span>
          {(checks > 0 || state === "CHECKING" || state === "OUTCOME_UNKNOWN") && (
            <span className="rounded-full bg-[var(--status-amber-wash)] px-2.5 py-0.5 tabular-nums text-[11px] font-medium text-[var(--status-amber-ink)]">
              {t("kinetic.topology.checks", { checks })}
            </span>
          )}
        </div>
        {headerRight && <div className="shrink-0">{headerRight}</div>}
      </div>

      {/* Horizontal Circular Stepper with continuous flush connectors behind nodes */}
      {showHorizontal && (
        <div className={variant === "auto" ? "hidden sm:block" : "block"}>
          <div className="relative grid grid-cols-5">
            {/* Continuous background connector rail spanning exact center-to-center (10% to 90%) */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute top-[13.5px] left-[10%] right-[10%] h-[2px] rounded-full bg-[var(--hairline-strong)]"
            >
              <div
                className="h-full rounded-full transition-[width] duration-[300ms] ease-[var(--ease-settle)]"
                style={{
                  width: `${Math.max(0, Math.min(100, progressRatio * 100))}%`,
                  backgroundColor:
                    state === "VERIFIED"
                      ? "var(--status-emerald)"
                      : "var(--accent)",
                }}
              />
            </div>

            {SPINE_NODES.map((node, idx) => {
              const stepState = getStepState(idx);
              const ts = findTimestampForStep(node.key, events);
              const nodeLabel = t(node.labelKey);

              return (
                <div
                  key={node.key}
                  className="relative z-10 flex min-w-0 flex-col items-center px-1 text-center"
                >
                  {/* Opaque circular step node so the rail terminates cleanly flush against each circle */}
                  <div
                    className={[
                      "flex h-7 w-7 items-center justify-center rounded-full text-[12px] font-semibold ring-[3px] ring-[var(--bg-surface)] transition-all duration-[200ms]",
                      stepState === "verified"
                        ? "bg-[var(--status-emerald-solid)] text-white shadow-[0_0_0_5px_var(--status-emerald-wash)]"
                        : stepState === "current"
                          ? "bg-[var(--accent-solid)] text-[var(--accent-fg)] shadow-[0_0_0_5px_var(--accent-wash-strong)]"
                          : stepState === "done"
                            ? "bg-[color-mix(in_srgb,var(--status-emerald)_12%,var(--bg-surface))] text-[var(--status-emerald)] border border-[var(--status-emerald-border)]"
                            : "bg-[var(--bg-surface-subtle)] text-[var(--ink-muted)]",
                    ].join(" ")}
                  >
                    {stepState === "done" || stepState === "verified" ? (
                      <Check className="h-4 w-4" strokeWidth={2.6} />
                    ) : (
                      <span className="font-mono-code text-[11px]">
                        {node.index}
                      </span>
                    )}
                  </div>

                  <div
                    className={[
                      "mt-2 text-[12.5px] font-medium truncate max-w-full",
                      stepState === "idle"
                        ? "text-[var(--ink-muted)]"
                        : stepState === "current"
                          ? "text-[var(--accent-ink)] font-semibold"
                          : stepState === "verified"
                            ? "text-[var(--status-emerald)] font-semibold"
                            : "text-[var(--ink-primary)]",
                    ].join(" ")}
                  >
                    {nodeLabel}
                  </div>

                  <div className="mt-0.5 font-mono-code text-[10.5px] text-[var(--ink-muted)]">
                    {ts
                      ? formatTimeOnly(ts, { withSeconds: true })
                      : node.key === "VERIFYING" &&
                          (state === "CHECKING" || state === "VERIFYING") &&
                          checks > 0
                        ? `${checks}/3`
                        : "—"}
                  </div>
                </div>
              );
            })}
          </div>

          {branchInfo && (
            <div
              className={[
                "mt-4 flex items-center justify-between gap-3 rounded-sm px-3.5 py-2.5 text-[12.5px]",
                branchInfo.tone === "amber"
                  ? "bg-[var(--status-amber-wash)] text-[var(--status-amber-ink)]"
                  : "bg-[var(--status-crimson-wash)] text-[var(--status-crimson)]",
              ].join(" ")}
            >
              <div className="flex items-center gap-2 min-w-0">
                {branchInfo.tone === "amber" ? (
                  <AlertTriangle className="h-4 w-4 shrink-0" strokeWidth={1.85} />
                ) : (
                  <XCircle className="h-4 w-4 shrink-0" strokeWidth={1.85} />
                )}
                <span className="font-medium truncate">{branchInfo.label}</span>
              </div>
              {branchInfo.at && (
                <span className="font-mono-code text-[11px] opacity-80 shrink-0">
                  {formatDateTime(branchInfo.at, { withSeconds: true })}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Compact Vertical Rail (Drawer 360-440px & Mobile < 640px) */}
      {showVertical && (
        <div className={variant === "auto" ? "block sm:hidden" : "block"}>
          <ol className="relative space-y-2.5 pl-6">
            <span
              aria-hidden="true"
              className="absolute bottom-2.5 left-[9px] top-2.5 w-[1.5px] bg-[var(--hairline-strong)]"
            />
            {SPINE_NODES.map((node, idx) => {
              const stepState = getStepState(idx);
              const ts = findTimestampForStep(node.key, events);
              return (
                <li
                  key={node.key}
                  className="relative flex items-center justify-between gap-2 text-[12.5px]"
                >
                  <span
                    aria-hidden="true"
                    className={[
                      "absolute -left-6 flex h-5 w-5 items-center justify-center rounded-full ring-2 ring-[var(--bg-surface)]",
                      stepState === "verified"
                        ? "bg-[var(--status-emerald-solid)] text-white"
                        : stepState === "current"
                          ? "bg-[var(--accent-solid)] text-[var(--accent-fg)]"
                          : stepState === "done"
                            ? "bg-[color-mix(in_srgb,var(--status-emerald)_12%,var(--bg-surface))] text-[var(--status-emerald)] border border-[var(--status-emerald-border)]"
                            : "bg-[var(--bg-surface-subtle)] text-[var(--ink-muted)]",
                    ].join(" ")}
                  >
                    {stepState === "done" || stepState === "verified" ? (
                      <Check className="h-3.5 w-3.5" strokeWidth={2.5} />
                    ) : (
                      <span className="font-mono-code text-[9.5px] font-semibold">
                        {node.index}
                      </span>
                    )}
                  </span>
                  <span
                    className={[
                      "font-medium",
                      stepState === "idle"
                        ? "text-[var(--ink-muted)]"
                        : stepState === "current"
                          ? "text-[var(--accent-ink)] font-semibold"
                          : "text-[var(--ink-primary)]",
                    ].join(" ")}
                  >
                    {t(node.labelKey)}
                  </span>
                  <span className="font-mono-code text-[11px] text-[var(--ink-muted)]">
                    {ts ? formatTimeOnly(ts, { withSeconds: true }) : "—"}
                  </span>
                </li>
              );
            })}

            {branchInfo && (
              <li
                className={[
                  "relative mt-2 flex items-center justify-between gap-2 rounded-sm px-3 py-2 text-[12px]",
                  branchInfo.tone === "amber"
                    ? "bg-[var(--status-amber-wash)] text-[var(--status-amber-ink)]"
                    : "bg-[var(--status-crimson-wash)] text-[var(--status-crimson)]",
                ].join(" ")}
              >
                <span className="font-medium truncate">{branchInfo.label}</span>
                {branchInfo.at && (
                  <span className="font-mono-code text-[11px] shrink-0">
                    {formatTimeOnly(branchInfo.at, { withSeconds: true })}
                  </span>
                )}
              </li>
            )}
          </ol>
        </div>
      )}
    </div>
  );
}
