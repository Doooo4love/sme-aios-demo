"use client";

import React from "react";
import { formatUnixTime } from "@/lib/format";
import type { AuditEvent, ProposalState } from "@/lib/types";

export interface ExecutionTopologyRibbonProps {
  state: ProposalState;
  checks?: number;
  events?: AuditEvent[];
  variant?: "auto" | "horizontal" | "vertical-rail";
  className?: string;
}

interface SpineNode {
  index: string;
  key: "PROPOSED" | "QUEUED" | "SENDING" | "VERIFYING" | "VERIFIED";
  label: string;
  code: string;
}

const SPINE_NODES: readonly SpineNode[] = [
  { index: "01", key: "PROPOSED", label: "已提案 · 待审批", code: "PROPOSED" },
  { index: "02", key: "QUEUED", label: "已批准 · 待派发", code: "QUEUED" },
  { index: "03", key: "SENDING", label: "ERP 写入中", code: "SENDING" },
  {
    index: "04",
    key: "VERIFYING",
    label: "回执核验中",
    code: "VERIFYING / CHECKING",
  },
  { index: "05", key: "VERIFIED", label: "已核验入账", code: "VERIFIED" },
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
  className = "",
}: ExecutionTopologyRibbonProps) {
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
        label: "结果待确认 · 等待回查",
        tone: "amber" as const,
        at: findBranchTimestamp("OUTCOME_UNKNOWN", events),
      };
    }
    if (state === "NEEDS_OPERATOR") {
      return {
        code: "NEEDS_OPERATOR",
        label: "需人工核查回执",
        tone: "crimson" as const,
        at: findBranchTimestamp("NEEDS_OPERATOR", events),
      };
    }
    if (state === "REJECTED") {
      return {
        code: "REJECTED",
        label: "已退回 / 已拒绝 / 终止",
        tone: "crimson" as const,
        at: findBranchTimestamp("REJECTED", events),
      };
    }
    return null;
  })();

  const getNodeStyle = (idx: number) => {
    const isCompleted = !isBranch ? idx < reached : idx < reached;
    const isCurrent =
      !isBranch &&
      ((state === "PROPOSED" && idx === 0) ||
        (state === "QUEUED" && idx === 1) ||
        (state === "SENDING" && idx === 2) ||
        ((state === "VERIFYING" || state === "CHECKING") && idx === 3) ||
        (state === "VERIFIED" && idx === 4));

    if (state === "VERIFIED" && idx === 4) {
      return {
        box: "border-[var(--status-emerald-border)] border-b-2 border-b-[var(--status-emerald)] bg-[var(--status-emerald-wash)] text-[var(--status-emerald)]",
        dot: "bg-[var(--status-emerald)]",
      };
    }
    if (isCurrent) {
      return {
        box: "border-[var(--accent-border)] border-b-2 border-b-[var(--accent)] bg-[var(--accent-wash)] text-[var(--accent)]",
        dot: "bg-[var(--accent)]",
      };
    }
    if (isCompleted) {
      return {
        box: "border-[var(--hairline-strong)] border-b-2 border-b-[var(--ink-secondary)] bg-[var(--bg-sheet)] text-[var(--ink-primary)]",
        dot: "bg-[var(--ink-secondary)]",
      };
    }
    return {
      box: "border-[var(--hairline)] bg-[var(--bg-subtle)] text-[var(--ink-faint)]",
      dot: "bg-[var(--hairline-strong)]",
    };
  };

  return (
    <div
      className={[
        "rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-sheet)] p-3.5",
        className,
      ].join(" ")}
    >
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <span className="font-mono-code text-[11px] uppercase tracking-[0.04em] text-[var(--ink-muted)]">
          EXECUTION TOPOLOGY · 状态流转图谱
        </span>
        {(checks > 0 || state === "CHECKING" || state === "OUTCOME_UNKNOWN") && (
          <span className="font-mono-code text-[11px] text-[var(--status-amber-ink)]">
            核验轮次 {checks}/3
          </span>
        )}
      </div>

      {/* Horizontal Drafting Schematic (>= 640px when auto, or forced horizontal) */}
      {showHorizontal && (
        <div className={variant === "auto" ? "hidden sm:block" : "block"}>
          <div className="flex items-stretch gap-0">
            {SPINE_NODES.map((node, idx) => {
              const style = getNodeStyle(idx);
              const ts = findTimestampForStep(node.key, events);
              const connectorActive = idx < reached;

              return (
                <React.Fragment key={node.key}>
                  <div
                    className={[
                      "min-w-0 flex-1 rounded-[4px] border px-2.5 py-2 transition-colors duration-[150ms]",
                      style.box,
                    ].join(" ")}
                  >
                    <div className="flex items-center justify-between gap-1 font-mono-code text-[10px]">
                      <span>{node.index}</span>
                      {node.key === "VERIFYING" &&
                        (state === "CHECKING" || state === "VERIFYING") &&
                        checks > 0 && <span>{checks}/3</span>}
                    </div>
                    <div className="mt-0.5 truncate text-[12px] font-semibold">
                      {node.label}
                    </div>
                    <div className="mt-1 font-mono-code text-[10px] opacity-75 truncate">
                      {ts ? formatUnixTime(ts, { withSeconds: true }).slice(11) : node.code.split(" ")[0]}
                    </div>
                  </div>

                  {idx < SPINE_NODES.length - 1 && (
                    <div
                      className="flex w-6 shrink-0 items-center justify-center"
                      aria-hidden="true"
                    >
                      <svg
                        width="24"
                        height="12"
                        viewBox="0 0 24 12"
                        fill="none"
                      >
                        <line
                          x1="0"
                          y1="6"
                          x2="20"
                          y2="6"
                          stroke={
                            connectorActive
                              ? "var(--accent)"
                              : "var(--hairline-strong)"
                          }
                          strokeWidth={connectorActive ? "1.5" : "1"}
                          className={
                            connectorActive ? "aios-topology-trace" : undefined
                          }
                        />
                        <polyline
                          points="16,3 21,6 16,9"
                          stroke={
                            connectorActive
                              ? "var(--accent)"
                              : "var(--hairline-strong)"
                          }
                          strokeWidth="1.2"
                          fill="none"
                        />
                      </svg>
                    </div>
                  )}
                </React.Fragment>
              );
            })}
          </div>

          {/* Orthogonal Branch Track for OUTCOME_UNKNOWN / NEEDS_OPERATOR / REJECTED */}
          {branchInfo && (
            <div className="mt-2.5 flex items-center gap-2 pl-3">
              <svg
                width="20"
                height="20"
                viewBox="0 0 20 20"
                fill="none"
                aria-hidden="true"
                className="shrink-0"
              >
                <path
                  d="M2 0V12H18"
                  stroke={
                    branchInfo.tone === "amber"
                      ? "var(--status-amber)"
                      : "var(--status-crimson)"
                  }
                  strokeWidth="1.4"
                  strokeDasharray={
                    branchInfo.code === "OUTCOME_UNKNOWN" ? "3 2" : undefined
                  }
                />
              </svg>
              <div
                className={[
                  "flex flex-1 items-center justify-between gap-3 rounded-[4px] border border-b-2 px-3 py-1.5 text-[12px]",
                  branchInfo.tone === "amber"
                    ? "border-[var(--status-amber-border)] border-b-[var(--status-amber)] bg-[var(--status-amber-wash)] text-[var(--status-amber-ink)]"
                    : "border-[var(--status-crimson-border)] border-b-[var(--status-crimson)] bg-[var(--status-crimson-wash)] text-[var(--status-crimson)]",
                ].join(" ")}
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono-code text-[11px] font-semibold">
                    {branchInfo.code}
                  </span>
                  <span className="font-medium">{branchInfo.label}</span>
                </div>
                {branchInfo.at && (
                  <span className="font-mono-code text-[11px] opacity-80">
                    {formatUnixTime(branchInfo.at, { withSeconds: true })}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Compact Vertical Drafting Rail (Drawer 360-440px & Mobile < 640px) */}
      {showVertical && (
        <div className={variant === "auto" ? "block sm:hidden" : "block"}>
          <ol className="relative space-y-1.5 pl-4">
            <span
              aria-hidden="true"
              className="absolute bottom-2 left-[5px] top-2 w-px bg-[var(--hairline-strong)]"
            />
            {SPINE_NODES.map((node, idx) => {
              const style = getNodeStyle(idx);
              const ts = findTimestampForStep(node.key, events);
              return (
                <li
                  key={node.key}
                  className="relative flex items-center justify-between gap-2 text-[12px]"
                >
                  <span
                    aria-hidden="true"
                    className={[
                      "absolute -left-4 h-2.5 w-2.5 rounded-[2px] border border-[var(--bg-sheet)]",
                      style.dot,
                    ].join(" ")}
                  />
                  <span
                    className={[
                      "font-medium",
                      idx <= reached
                        ? "text-[var(--ink-primary)]"
                        : "text-[var(--ink-faint)]",
                    ].join(" ")}
                  >
                    <span className="font-mono-code text-[11px] text-[var(--ink-muted)] mr-1.5">
                      {node.index}
                    </span>
                    {node.label}
                  </span>
                  <span className="font-mono-code text-[11px] text-[var(--ink-muted)]">
                    {ts ? formatUnixTime(ts, { withSeconds: true }).slice(11) : "—"}
                  </span>
                </li>
              );
            })}

            {branchInfo && (
              <li
                className={[
                  "relative mt-2 flex items-center justify-between gap-2 rounded-[4px] border px-2.5 py-1.5 text-[12px]",
                  branchInfo.tone === "amber"
                    ? "border-[var(--status-amber-border)] bg-[var(--status-amber-wash)] text-[var(--status-amber-ink)]"
                    : "border-[var(--status-crimson-border)] bg-[var(--status-crimson-wash)] text-[var(--status-crimson)]",
                ].join(" ")}
              >
                <span className="font-medium">
                  <span className="font-mono-code text-[11px] mr-1.5">
                    {branchInfo.code}
                  </span>
                  {branchInfo.label}
                </span>
                {branchInfo.at && (
                  <span className="font-mono-code text-[11px]">
                    {formatUnixTime(branchInfo.at, { withSeconds: true }).slice(11)}
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
