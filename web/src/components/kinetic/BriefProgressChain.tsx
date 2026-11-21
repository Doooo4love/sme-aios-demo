"use client";

import React, { useId, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, ChevronDown, Circle } from "lucide-react";
import type { ApiError } from "@/lib/api-client";
import { formatShortDigest, sortWarehouses } from "@/lib/format";
import { useLocale, type LocaleContextValue } from "@/lib/i18n";
import type { Actor, TurnResult } from "@/lib/types";

export interface BriefProgressStep {
  id: string;
  label: string;
  status: "done" | "waiting" | "error";
  meta?: string;
}

export interface BriefProgressChainProps {
  phase: "pending" | "done" | "error";
  retryAfter?: number | null;
  actor?: Actor | null;
  result?: TurnResult | null;
  error?: ApiError | null;
  /** Optional explicit real-state business checkpoints */
  steps?: BriefProgressStep[];
  summaryLabel?: string;
  /** "inline" embeds cleanly inside a card/stepper header with zero outer margin */
  variant?: "default" | "inline";
  defaultExpanded?: boolean;
  className?: string;
}

function extractWarehouseFromResult(
  result: TurnResult,
  actor: Actor | null | undefined,
  fallbackLabel: string,
): string {
  if (result.kind === "proposal" || result.kind === "approval_preview") {
    return result.proposal.warehouse;
  }
  if (result.kind === "result" && result.data && typeof result.data === "object") {
    const wh = (result.data as Record<string, unknown>).warehouse;
    if (typeof wh === "string" && wh.trim()) return wh.trim();
  }
  if (actor && actor.warehouses.length > 0) {
    return sortWarehouses(actor.warehouses).join(" / ");
  }
  return fallbackLabel;
}

function deriveRealSteps(
  phase: "done" | "error",
  i18n: Pick<
    LocaleContextValue,
    "t" | "localizeTool" | "localizeSource" | "localizeStatus"
  >,
  actor?: Actor | null,
  result?: TurnResult | null,
  error?: ApiError | null,
): { summary: string; steps: BriefProgressStep[] } {
  const { t, localizeTool, localizeSource, localizeStatus } = i18n;

  if (phase === "error" || error) {
    const metaParts: string[] = [];
    if (error?.code) metaParts.push(error.code);
    if (error?.status) metaParts.push(`HTTP ${error.status}`);
    if (error?.requestId) metaParts.push(error.requestId);
    const steps: BriefProgressStep[] = [
      {
        id: "err-gate",
        label: t("kinetic.serverCheckFailed"),
        status: "error",
        meta: metaParts.length > 0 ? metaParts.join(" · ") : undefined,
      },
    ];
    return {
      summary: t("kinetic.serverCheckFailed"),
      steps,
    };
  }

  if (!result) {
    return {
      summary: t("kinetic.completed"),
      steps: [
        {
          id: "done-generic",
          label: t("kinetic.completedGenericStep"),
          status: "done",
        },
      ],
    };
  }

  const tenantLabel = actor?.tenant || t("kinetic.currentTenant");
  const wh = extractWarehouseFromResult(result, actor, t("kinetic.currentScope"));

  if (result.kind === "result") {
    const toolLabel = localizeTool(result.tool);
    const sourceLabel = localizeSource(result.source);
    return {
      summary: t("kinetic.result.summary"),
      steps: [
        {
          id: "scope",
          label: t("kinetic.result.stepScope", {
            tenant: tenantLabel,
            warehouse: wh,
          }),
          status: "done",
        },
        {
          id: "tool",
          label: t("kinetic.result.stepTool", {
            tool: toolLabel,
            source: sourceLabel,
          }),
          status: "done",
        },
        {
          id: "output",
          label: t("kinetic.result.stepOutput"),
          status: "done",
        },
      ],
    };
  }

  if (result.kind === "proposal") {
    const p = result.proposal;
    const isVerified = p.state === "VERIFIED";
    const isErrorState = p.state === "REJECTED" || p.state === "NEEDS_OPERATOR";
    return {
      summary: isVerified
        ? t("kinetic.proposal.summaryVerified")
        : t("kinetic.proposal.summaryProposed"),
      steps: [
        {
          id: "scope",
          label: t("kinetic.proposal.stepScope", { warehouse: p.warehouse }),
          status: "done",
        },
        {
          id: "digest",
          label: t("kinetic.proposal.stepDigest"),
          status: "done",
          meta: formatShortDigest(p.digest),
        },
        {
          id: "state",
          label:
            p.state === "PROPOSED"
              ? t("kinetic.proposal.stepAwaitingApproval")
              : t("kinetic.proposal.stepState", {
                  state: localizeStatus(p.state),
                }),
          status: isVerified ? "done" : isErrorState ? "error" : "waiting",
          meta: formatShortDigest(p.id, 6, 4),
        },
      ],
    };
  }

  if (result.kind === "approval_preview") {
    const p = result.proposal;
    return {
      summary: t("kinetic.approvalPreview.summary"),
      steps: [
        {
          id: "snapshot",
          label: t("kinetic.approvalPreview.stepSnapshot", {
            warehouse: p.warehouse,
          }),
          status: "done",
          meta: formatShortDigest(p.digest),
        },
        {
          id: "confirm",
          label: t("kinetic.approvalPreview.stepConfirm"),
          status: "waiting",
          meta: formatShortDigest(p.id, 6, 4),
        },
      ],
    };
  }

  return {
    summary: t("kinetic.clarify.summary"),
    steps: [
      {
        id: "caps",
        label: t("kinetic.clarify.stepCaps", { tenant: tenantLabel }),
        status: "done",
      },
      {
        id: "clarify",
        label: t("kinetic.clarify.stepWait"),
        status: "waiting",
      },
    ],
  };
}

export function BriefProgressChain({
  phase,
  retryAfter,
  actor,
  result,
  error,
  steps: explicitSteps,
  summaryLabel,
  variant = "default",
  defaultExpanded = false,
  className = "",
}: BriefProgressChainProps) {
  const i18n = useLocale();
  const { t, tp } = i18n;
  const [expanded, setExpanded] = useState(defaultExpanded);
  const stepsId = useId();

  const derived = useMemo(() => {
    if (phase === "pending") return null;
    if (explicitSteps && explicitSteps.length > 0) {
      return {
        summary:
          summaryLabel ||
          (phase === "error"
            ? t("kinetic.serverCheckFailed")
            : tp(
                {
                  "zh-CN": "已完成 {count} 项检查",
                  "zh-HK": "已完成 {count} 項檢查",
                  en: {
                    one: "{count} check completed",
                    other: "{count} checks completed",
                  },
                },
                explicitSteps.length,
              )),
        steps: explicitSteps,
      };
    }
    const auto = deriveRealSteps(phase, i18n, actor, result, error);
    return {
      summary: summaryLabel || auto.summary,
      steps: auto.steps,
    };
  }, [phase, explicitSteps, summaryLabel, actor, result, error, i18n, t, tp]);

  // Whisper-quiet literal single-line status while in-flight (ZERO fake sub-steps or percentages!)
  if (phase === "pending") {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="assistant-turn-pending"
        className={[
          "inline-flex items-center gap-2 py-1 text-[12.5px] font-medium text-[var(--ink-muted)] select-none",
          className,
        ].join(" ")}
      >
        <span className="relative inline-flex h-3.5 w-3.5 items-center justify-center">
          <span
            aria-hidden="true"
            className="aios-whisper-dot h-2 w-2 rounded-full bg-[var(--accent)]"
          />
        </span>
        <span>
          {retryAfter && retryAfter > 0
            ? t("kinetic.queuedRetry", { seconds: retryAfter })
            : t("kinetic.processingRequest")}
        </span>
      </div>
    );
  }

  if (!derived) return null;

  const isError = phase === "error" || Boolean(error);
  const isInline = variant === "inline";

  return (
    <div
      className={[
        isInline ? "relative inline-flex flex-col items-end" : "mb-1.5",
        className,
      ].join(" ")}
    >
      <button
        type="button"
        data-testid="brief-progress-toggle"
        aria-expanded={expanded}
        aria-controls={stepsId}
        onClick={() => setExpanded((v) => !v)}
        className={[
          "group inline-flex items-center gap-1.5 rounded-full text-[12px] font-medium text-[var(--ink-muted)] hover:text-[var(--ink-secondary)] transition-colors duration-[140ms] cursor-pointer",
          isInline ? "px-2 py-1 hover:bg-[var(--bg-hover)]" : "py-0.5",
        ].join(" ")}
      >
        {isError ? (
          <AlertCircle
            className="h-3.5 w-3.5 shrink-0 text-[var(--status-crimson)]"
            strokeWidth={1.9}
            aria-hidden="true"
          />
        ) : (
          <CheckCircle2
            className="h-3.5 w-3.5 shrink-0 text-[var(--status-emerald)]"
            strokeWidth={1.9}
            aria-hidden="true"
          />
        )}
        <span>{derived.summary}</span>
        <ChevronDown
          className={[
            "h-3 w-3 shrink-0 text-[var(--ink-faint)] group-hover:text-[var(--ink-secondary)] transition-transform duration-[200ms]",
            expanded ? "rotate-180" : "rotate-0",
          ].join(" ")}
          strokeWidth={2}
          aria-hidden="true"
        />
      </button>

      <div
        className={[
          "aios-accordion",
          isInline ? "w-full min-w-[260px] max-w-[380px]" : "w-full",
        ].join(" ")}
        data-open={expanded ? "true" : "false"}
      >
        <div className="aios-accordion-inner">
          <ol
            id={stepsId}
            data-testid="brief-progress-steps"
            className={[
              "mt-1.5 space-y-1.5",
              isInline
                ? "rounded-sm bg-[var(--bg-surface-tint)] p-2.5 text-left"
                : "ml-1.5 border-l border-[var(--hairline-strong)] pl-3 py-1",
            ].join(" ")}
          >
            {derived.steps.map((step) => (
              <li
                key={step.id}
                className="flex items-start justify-between gap-3 text-[12px] leading-snug"
              >
                <span className="flex items-start gap-1.5 text-[var(--ink-secondary)]">
                  {step.status === "done" ? (
                    <CheckCircle2
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--status-emerald)]"
                      strokeWidth={1.9}
                      aria-hidden="true"
                    />
                  ) : step.status === "error" ? (
                    <AlertCircle
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--status-crimson)]"
                      strokeWidth={1.9}
                      aria-hidden="true"
                    />
                  ) : (
                    <Circle
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--accent)]"
                      strokeWidth={1.9}
                      aria-hidden="true"
                    />
                  )}
                  <span>{step.label}</span>
                </span>
                {step.meta && (
                  <span className="shrink-0 font-mono-code text-[11px] text-[var(--ink-muted)]">
                    {step.meta}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}
