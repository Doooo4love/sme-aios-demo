"use client";

import React, { useId, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, ChevronDown, Circle } from "lucide-react";
import type { ApiError } from "@/lib/api-client";
import { formatProposalStateLabel, formatShortDigest } from "@/lib/format";
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

const TOOL_LABELS: Record<string, string> = {
  "shipment.read": "运单查询",
  "shipment.reschedule": "运单改期提案",
  "order.draft.prepare": "销售订单草稿",
  "finance.invoice.read": "财务发票核对",
  "mail.inbox.read": "企业邮箱读取",
  "decision.warehouse.summary": "仓库经营汇总",
};

const SOURCE_LABELS: Record<string, string> = {
  erp: "ERP",
  synthetic: "合成数据",
  finance: "财务系统",
  mail: "企业邮箱",
  decision: "经营汇总",
  internal: "站内记录",
};

function extractWarehouseFromResult(result: TurnResult, actor?: Actor | null): string {
  if (result.kind === "proposal" || result.kind === "approval_preview") {
    return result.proposal.warehouse;
  }
  if (result.kind === "result" && result.data && typeof result.data === "object") {
    const wh = (result.data as Record<string, unknown>).warehouse;
    if (typeof wh === "string" && wh.trim()) return wh.trim();
  }
  if (actor && actor.warehouses.length > 0) {
    return actor.warehouses.join(" / ");
  }
  return "当前授权范围";
}

function deriveRealSteps(
  phase: "done" | "error",
  actor?: Actor | null,
  result?: TurnResult | null,
  error?: ApiError | null,
): { summary: string; steps: BriefProgressStep[] } {
  if (phase === "error" || error) {
    const metaParts: string[] = [];
    if (error?.code) metaParts.push(error.code);
    if (error?.status) metaParts.push(`HTTP ${error.status}`);
    if (error?.requestId) metaParts.push(error.requestId);
    const steps: BriefProgressStep[] = [
      {
        id: "err-gate",
        label: "服务端校验未通过",
        status: "error",
        meta: metaParts.length > 0 ? metaParts.join(" · ") : undefined,
      },
    ];
    return {
      summary: "服务端校验未通过",
      steps,
    };
  }

  if (!result) {
    return {
      summary: "已完成",
      steps: [
        {
          id: "done-generic",
          label: "已校验身份并完成服务端处理",
          status: "done",
        },
      ],
    };
  }

  const tenantLabel = actor?.tenant || "当前租户";
  const wh = extractWarehouseFromResult(result, actor);

  if (result.kind === "result") {
    const toolLabel = TOOL_LABELS[result.tool] || result.tool;
    const sourceLabel = SOURCE_LABELS[result.source.toLowerCase()] || result.source;
    return {
      summary: "已完成 · 3 步业务核验",
      steps: [
        {
          id: "scope",
          label: `身份与站点范围核验（${tenantLabel} · ${wh}）`,
          status: "done",
        },
        {
          id: "tool",
          label: `受控工具实时读取（${toolLabel} · 来源 ${sourceLabel}）`,
          status: "done",
        },
        {
          id: "output",
          label: "已输出实时只读视图",
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
        ? "已核验入账 · 3 步核验"
        : "已生成待审批提案 · 3 步核验",
      steps: [
        {
          id: "scope",
          label: `身份与发起权限核验（${p.warehouse}）`,
          status: "done",
        },
        {
          id: "digest",
          label: "已生成变更方案并锁定摘要",
          status: "done",
          meta: formatShortDigest(p.digest),
        },
        {
          id: "state",
          label:
            p.state === "PROPOSED"
              ? "等待独立主管确认"
              : `当前状态：${formatProposalStateLabel(p.state)}`,
          status: isVerified ? "done" : isErrorState ? "error" : "waiting",
          meta: formatShortDigest(p.id, 6, 4),
        },
      ],
    };
  }

  if (result.kind === "approval_preview") {
    const p = result.proposal;
    return {
      summary: "已生成审批预览 · 2 步核验",
      steps: [
        {
          id: "snapshot",
          label: `已核对单据最新状态与摘要（${p.warehouse}）`,
          status: "done",
          meta: formatShortDigest(p.digest),
        },
        {
          id: "confirm",
          label: "需在单据详情或右侧面板显式确认",
          status: "waiting",
          meta: formatShortDigest(p.id, 6, 4),
        },
      ],
    };
  }

  return {
    summary: "待补充查询要素 · 2 步核验",
    steps: [
      {
        id: "caps",
        label: `已核对账号可用业务工具范围（${tenantLabel}）`,
        status: "done",
      },
      {
        id: "clarify",
        label: "等待补充必要参数后继续执行",
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
  const [expanded, setExpanded] = useState(defaultExpanded);
  const stepsId = useId();

  const derived = useMemo(() => {
    if (phase === "pending") return null;
    if (explicitSteps && explicitSteps.length > 0) {
      return {
        summary:
          summaryLabel ||
          (phase === "error"
            ? "服务端校验未通过"
            : `已完成 · ${explicitSteps.length} 步业务核验`),
        steps: explicitSteps,
      };
    }
    const auto = deriveRealSteps(phase, actor, result, error);
    return {
      summary: summaryLabel || auto.summary,
      steps: auto.steps,
    };
  }, [phase, explicitSteps, summaryLabel, actor, result, error]);

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
            ? `请求正在排队处理（${retryAfter}s 后复查）`
            : "正在处理请求…"}
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
