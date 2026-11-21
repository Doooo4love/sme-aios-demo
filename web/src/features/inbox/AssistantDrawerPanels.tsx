"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  Calendar,
  CheckCircle2,
  RefreshCw,
} from "lucide-react";
import {
  callWorkbenchTool,
  fetchProposal,
  generateIdempotencyKey,
  isApiError,
  isStaleAuthError,
  type ApiError,
} from "@/lib/api-client";
import { formatShortDigest } from "@/lib/format";
import { useLocale } from "@/lib/i18n";
import { useSession } from "@/lib/session-context";
import { ExecutionTopologyRibbon } from "@/components/kinetic/ExecutionTopologyRibbon";
import { AccessNoticeCard } from "@/components/ui/AccessNoticeCard";
import { Button } from "@/components/ui/Button";
import { SourceTag } from "@/components/ui/SourceTag";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { fetchWorkbenchBriefForRange } from "@/features/inbox/api";
import type {
  BriefResponse,
  Capabilities,
  DrawerObjectSelection,
  InvoiceView,
  Proposal,
  ShipmentView,
  TurnResult,
  WarehouseDecisionSummary,
} from "@/lib/types";

export function AssistantBriefDrawer() {
  const { authGeneration, handleAccessChanged } = useSession();
  const { tx, t, formatDateTime } = useLocale();
  const [windowDays, setWindowDays] = useState<1 | 7>(1);
  const [brief, setBrief] = useState<BriefResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(
    async (days: 1 | 7) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetchWorkbenchBriefForRange(days);
        setBrief(res);
      } catch (err) {
        if (isStaleAuthError(err)) return;
        if (isApiError(err)) {
          if (err.code === "ACCESS_CHANGED") {
            setBrief(null);
            void handleAccessChanged();
          }
          setError(err);
        }
      } finally {
        setLoading(false);
      }
    },
    [handleAccessChanged],
  );

  useEffect(() => {
    setBrief(null);
    setError(null);
    void load(windowDays);
  }, [authGeneration, windowDays, load]);

  return (
    <div className="space-y-4" data-testid="drawer-brief-panel">
      <div className="flex items-center justify-between gap-2">
        <div className="inline-flex rounded-full bg-[var(--bg-surface-subtle)] p-0.5">
          {([1, 7] as const).map((days) => (
            <button
              key={days}
              type="button"
              onClick={() => setWindowDays(days)}
              className={[
                "rounded-full px-3 py-1 text-[12px] font-medium transition-all duration-[140ms] cursor-pointer",
                windowDays === days
                  ? "bg-[var(--bg-surface)] text-[var(--ink-primary)] shadow-[var(--shadow-subtle)]"
                  : "text-[var(--ink-muted)] hover:text-[var(--ink-primary)]",
              ].join(" ")}
            >
              {days === 1
                ? tx({ "zh-CN": "今日", "zh-HK": "今日", en: "Today" })
                : tx({
                    "zh-CN": "未来 7 天",
                    "zh-HK": "未來 7 天",
                    en: "Next 7 Days",
                  })}
            </button>
          ))}
        </div>
        <Button
          size="sm"
          variant="ghost"
          pill
          onClick={() => void load(windowDays)}
          disabled={loading}
        >
          <RefreshCw
            className={["h-3.5 w-3.5", loading ? "animate-spin" : ""].join(" ")}
            strokeWidth={1.85}
          />
          <span>{t("common.refresh")}</span>
        </Button>
      </div>

      {loading && !brief && (
        <div className="py-8 text-center text-[12.5px] text-[var(--ink-muted)]">
          {windowDays === 1
            ? tx({
                "zh-CN": "正在汇总今日简报…",
                "zh-HK": "正在彙整今日簡報…",
                en: "Loading today's brief…",
              })
            : tx({
                "zh-CN": "正在汇总近 7 天简报…",
                "zh-HK": "正在彙整近 7 天簡報…",
                en: "Loading 7-day brief…",
              })}
        </div>
      )}

      {error && (
        <AccessNoticeCard error={error} onRetry={() => void load(windowDays)} />
      )}

      {brief && !error && (
        <>
          <div className="grid grid-cols-2 gap-2.5">
            <div className="rounded-tile bg-[var(--bg-surface-tint)] p-3.5">
              <div className="text-[11.5px] text-[var(--ink-muted)]">
                {t("assistant.brief.pendingApprovals")}
              </div>
              <div className="mt-1 text-[24px] font-semibold text-[var(--ink-primary)] tabular-nums">
                {brief.pending_approvals}
                {brief.pending_approvals_capped ? "+" : ""}
              </div>
            </div>
            <div className="rounded-tile bg-[var(--bg-surface-tint)] p-3.5">
              <div className="text-[11.5px] text-[var(--ink-muted)]">
                {windowDays === 1
                  ? tx({
                      "zh-CN": "今日会议",
                      "zh-HK": "今日會議",
                      en: "Meetings Today",
                    })
                  : tx({
                      "zh-CN": "7 天内会议",
                      "zh-HK": "7 天內會議",
                      en: "7-Day Meetings",
                    })}
              </div>
              <div className="mt-1 text-[24px] font-semibold text-[var(--ink-primary)] tabular-nums">
                {brief.meetings}
              </div>
            </div>
          </div>

          <div className="rounded-tile bg-[var(--bg-surface-tint)] overflow-hidden">
            <div className="px-3.5 py-2.5 text-[12px] font-medium text-[var(--ink-secondary)] border-b border-[var(--hairline-subtle)]">
              {tx({
                "zh-CN": "我提交的单据状态分布",
                "zh-HK": "我提交的單據狀態分佈",
                en: "Submitted Proposal States",
              })}
            </div>
            <div className="divide-y divide-[var(--hairline-subtle)]">
              {Object.entries(brief.submitted_current_states).length === 0 ? (
                <div className="px-3.5 py-5 text-center text-[12px] text-[var(--ink-muted)]">
                  {tx({
                    "zh-CN": "暂无已提交单据",
                    "zh-HK": "暫無已提交單據",
                    en: "No submitted proposals yet",
                  })}
                </div>
              ) : (
                Object.entries(brief.submitted_current_states).map(
                  ([stateKey, count]) => (
                    <div
                      key={stateKey}
                      className="flex items-center justify-between px-3.5 py-2.5 text-[12px]"
                    >
                      <StatusBadge status={stateKey} compact />
                      <span className="font-semibold text-[var(--ink-primary)] tabular-nums">
                        {count}
                      </span>
                    </div>
                  ),
                )
              )}
            </div>
          </div>

          <div className="text-[11px] text-[var(--ink-muted)] tabular-nums">
            {tx({
              "zh-CN": "快照时间：",
              "zh-HK": "快照時間：",
              en: "Snapshot: ",
            })}
            <span className="font-mono-code">{formatDateTime(brief.as_of)}</span>
          </div>

          <div className="grid grid-cols-2 gap-2 pt-1">
            <Link
              href="/work"
              className="inline-flex h-9 items-center justify-center gap-1 rounded-full bg-[var(--bg-surface)] px-3 text-[12.5px] font-medium text-[var(--ink-primary)] shadow-[var(--shadow-subtle)] hover:shadow-[var(--shadow-card)] transition-all"
            >
              <span>
                {tx({
                  "zh-CN": "打开工作台",
                  "zh-HK": "開啟工作台",
                  en: "Workbench",
                })}
              </span>
              <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.85} />
            </Link>
            <Link
              href="/calendar"
              className="inline-flex h-9 items-center justify-center gap-1 rounded-full bg-[var(--bg-surface)] px-3 text-[12.5px] font-medium text-[var(--ink-primary)] shadow-[var(--shadow-subtle)] hover:shadow-[var(--shadow-card)] transition-all"
            >
              <Calendar
                className="h-3.5 w-3.5 text-[var(--accent)]"
                strokeWidth={1.85}
              />
              <span>
                {tx({
                  "zh-CN": "打开日历",
                  "zh-HK": "開啟日曆",
                  en: "Calendar",
                })}
              </span>
            </Link>
          </div>
        </>
      )}
    </div>
  );
}

export function AssistantProposalDrawer({
  proposalId,
}: {
  proposalId: string;
}) {
  const { authGeneration, handleAccessChanged } = useSession();
  const {
    tx,
    formatDateTime,
    localizeAction,
    localizePersona,
    localizeTimelineEvent,
  } = useLocale();
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchProposal(proposalId);
      setProposal(data);
    } catch (err) {
      if (isStaleAuthError(err)) return;
      if (isApiError(err)) {
        if (err.code === "ACCESS_CHANGED" || err.status === 404) {
          setProposal(null);
        }
        if (err.code === "ACCESS_CHANGED") {
          void handleAccessChanged();
        }
        setError(err);
      }
    } finally {
      setLoading(false);
    }
  }, [proposalId, handleAccessChanged]);

  useEffect(() => {
    setProposal(null);
    setError(null);
    void load();
  }, [proposalId, authGeneration, load]);

  if (loading && !proposal) {
    return (
      <div className="py-8 text-center text-[12.5px] text-[var(--ink-muted)]">
        {tx({
          "zh-CN": "正在实时核验提案单据…",
          "zh-HK": "正在即時核驗提案單據…",
          en: "Verifying proposal snapshot…",
        })}
      </div>
    );
  }

  if (error) {
    return <AccessNoticeCard error={error} onRetry={() => void load()} />;
  }

  if (!proposal) return null;

  const { action, before, after } = proposal.plan;

  return (
    <div className="space-y-4" data-testid="drawer-proposal-panel">
      <div className="flex items-center justify-between gap-2">
        <span
          title={proposal.id}
          className="truncate font-mono-code text-[13.5px] font-semibold text-[var(--ink-primary)]"
        >
          {formatShortDigest(proposal.id, 8, 6)}
        </span>
        <div className="flex items-center gap-1.5">
          <StatusBadge status={proposal.state} compact />
          <button
            type="button"
            onClick={() => void load()}
            aria-label={tx({
              "zh-CN": "刷新提案快照",
              "zh-HK": "重新整理提案快照",
              en: "Refresh proposal snapshot",
            })}
            className="inline-flex h-7 w-7 items-center justify-center rounded-full text-[var(--ink-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--ink-primary)] cursor-pointer"
          >
            <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.85} />
          </button>
        </div>
      </div>

      <ExecutionTopologyRibbon
        state={proposal.state}
        checks={proposal.checks}
        events={proposal.events}
        variant="vertical-rail"
      />

      <dl className="divide-y divide-[var(--hairline-subtle)] rounded-tile bg-[var(--bg-surface-tint)] text-[12px]">
        <div className="flex justify-between gap-2 px-3.5 py-2.5">
          <dt className="text-[var(--ink-muted)]">
            {tx({
              "zh-CN": "动作类型",
              "zh-HK": "操作類型",
              en: "Action",
            })}
          </dt>
          <dd className="font-medium text-[var(--ink-primary)]">
            {localizeAction(action)}
          </dd>
        </div>
        <div className="flex justify-between gap-2 px-3.5 py-2.5">
          <dt className="text-[var(--ink-muted)]">
            {tx({
              "zh-CN": "目标对象",
              "zh-HK": "目標對象",
              en: "Target",
            })}
          </dt>
          <dd className="font-mono-code text-[var(--ink-primary)]">
            {proposal.plan.target}
          </dd>
        </div>
        <div className="flex justify-between gap-2 px-3.5 py-2.5">
          <dt className="text-[var(--ink-muted)]">
            {tx({
              "zh-CN": "发起人 / 审批人",
              "zh-HK": "發起人 / 審批人",
              en: "Requester / Approver",
            })}
          </dt>
          <dd className="text-[var(--ink-primary)]">
            {localizePersona(proposal.requester).displayName} /{" "}
            {proposal.approver
              ? localizePersona(proposal.approver).displayName
              : tx({ "zh-CN": "待定", "zh-HK": "待定", en: "Pending" })}
          </dd>
        </div>
        <div className="flex justify-between gap-2 px-3.5 py-2.5">
          <dt className="text-[var(--ink-muted)]">
            {tx({
              "zh-CN": "摘要锁",
              "zh-HK": "摘要鎖",
              en: "Digest lock",
            })}
          </dt>
          <dd className="font-mono-code text-[var(--ink-primary)]">
            {formatShortDigest(proposal.digest)}
          </dd>
        </div>
      </dl>

      {action === "shipment.reschedule" && (
        <div className="rounded-tile bg-[var(--bg-surface-tint)] p-3.5 text-[12px]">
          <div className="text-[11.5px] font-medium text-[var(--ink-muted)]">
            {tx({
              "zh-CN": "字段变更比对",
              "zh-HK": "欄位變更比對",
              en: "Field Diff",
            })}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <span className="text-[var(--ink-muted)]">
              {tx({
                "zh-CN": "交付日期",
                "zh-HK": "交付日期",
                en: "Delivery Date",
              })}
            </span>
            <span className="font-mono-code line-through text-[var(--ink-secondary)]">
              {String(before.delivery_date ?? "—")}
            </span>
            <ArrowRight className="h-3 w-3 text-[var(--ink-muted)]" />
            <span className="rounded-xs bg-[var(--accent-wash)] px-2 py-0.5 font-mono-code font-semibold text-[var(--accent-ink)]">
              {String(after.delivery_date ?? "—")}
            </span>
          </div>
        </div>
      )}

      {proposal.state === "VERIFIED" && proposal.receipt && (
        <div className="rounded-tile bg-[var(--status-emerald-wash)] p-3.5 text-[12px]">
          <div className="flex items-center gap-1.5 font-semibold text-[var(--status-emerald)]">
            <CheckCircle2 className="h-4 w-4" strokeWidth={1.9} />
            <span>
              {tx({
                "zh-CN": "ERP 回执已核对一致",
                "zh-HK": "ERP 回執已核對一致",
                en: "ERP Receipt Verified",
              })}
            </span>
          </div>
          <div className="mt-1.5 space-y-1 text-[11px] text-[var(--ink-secondary)]">
            <div>
              {tx({
                "zh-CN": "远端回执号：",
                "zh-HK": "遠端回執號：",
                en: "Remote ID: ",
              })}
              <span className="font-mono-code">
                {proposal.receipt.remote_id}
              </span>
            </div>
            <div>
              {tx({
                "zh-CN": "操作编号：",
                "zh-HK": "操作編號：",
                en: "Operation ID: ",
              })}
              <span className="font-mono-code">
                {proposal.receipt.operation_id}
              </span>
            </div>
          </div>
        </div>
      )}

      {proposal.events.length > 0 && (
        <div className="rounded-tile bg-[var(--bg-surface-tint)] overflow-hidden">
          <div className="px-3.5 py-2 text-[11.5px] font-medium text-[var(--ink-secondary)] border-b border-[var(--hairline-subtle)]">
            {tx(
              {
                "zh-CN": "审计事件轨迹 ({count})",
                "zh-HK": "稽核事件軌跡 ({count})",
                en: "Audit Trail ({count})",
              },
              { count: proposal.events.length },
            )}
          </div>
          <ul className="divide-y divide-[var(--hairline-subtle)] text-[11.5px]">
            {proposal.events.slice(-5).map((ev, idx) => (
              <li
                key={`${ev.event}-${ev.at}-${idx}`}
                className="flex items-center justify-between gap-2 px-3.5 py-2"
              >
                <span
                  title={ev.event}
                  className="truncate font-medium text-[var(--ink-primary)]"
                >
                  {localizeTimelineEvent(ev.event).label}
                </span>
                <span className="shrink-0 text-[10.5px] text-[var(--ink-muted)] tabular-nums">
                  {ev.subject === "worker"
                    ? tx({
                        "zh-CN": "系统执行器",
                        "zh-HK": "系統執行器",
                        en: "System worker",
                      })
                    : localizePersona(ev.subject).displayName}{" "}
                  ·{" "}
                  <span className="font-mono-code">{formatDateTime(ev.at)}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Link
        href={`/proposals/${encodeURIComponent(proposal.id)}`}
        data-testid="drawer-proposal-open-full"
        className="inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-full bg-[var(--accent-solid)] px-4 text-[13px] font-medium text-[var(--accent-fg)] shadow-[var(--shadow-subtle)] hover:bg-[var(--accent-solid-hover)] transition-colors"
      >
        <span>
          {tx({
            "zh-CN": "打开完整单据与正式审批页",
            "zh-HK": "開啟完整單據與正式審批頁",
            en: "Open Full Proposal & Approval Page",
          })}
        </span>
        <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.9} />
      </Link>
    </div>
  );
}

export function AssistantResultDrawer({
  selection,
  capabilities,
  onProposalCreated,
}: {
  selection: DrawerObjectSelection;
  capabilities: Capabilities | null;
  onProposalCreated: (proposal: Proposal) => void;
}) {
  const { handleAccessChanged } = useSession();
  const { tx, localizeTool } = useLocale();
  const result = selection.meta?.result as
    | Extract<TurnResult, { kind: "result" }>
    | undefined;
  const rawData = (result?.data ?? {}) as Record<string, unknown>;

  const [newDate, setNewDate] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [rescheduleError, setRescheduleError] = useState<ApiError | null>(null);

  useEffect(() => {
    setNewDate("");
    setRescheduleError(null);
  }, [selection.id, selection.kind]);

  if (!result) {
    return (
      <div className="rounded-tile bg-[var(--bg-surface-tint)] p-4 text-[12.5px] text-[var(--ink-muted)]">
        {tx({
          "zh-CN": "请选择具体业务记录查看详情。",
          "zh-HK": "請選擇具體業務紀錄檢視詳情。",
          en: "Select a business record to inspect its details.",
        })}
      </div>
    );
  }

  const isShipment =
    result.tool === "shipment.read" &&
    typeof rawData.shipment_id === "string" &&
    typeof rawData.warehouse === "string";
  const shipment = isShipment ? (rawData as unknown as ShipmentView) : null;
  const canReschedule = Boolean(
    shipment &&
      shipment.status === "OPEN" &&
      capabilities?.tools.some(
        (t) =>
          t.id === "shipment.reschedule" &&
          t.available &&
          t.warehouses.includes(shipment.warehouse),
      ),
  );

  const handleReschedule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!shipment || !newDate || submitting) return;
    setSubmitting(true);
    setRescheduleError(null);
    try {
      const res = await callWorkbenchTool(
        {
          tool: "shipment.reschedule",
          warehouse: shipment.warehouse,
          shipment_id: shipment.shipment_id,
          delivery_date: newDate,
        },
        { idempotencyKey: generateIdempotencyKey("resched") },
      );
      if (res.kind === "proposal") {
        onProposalCreated(res.proposal);
      }
    } catch (err) {
      if (isStaleAuthError(err)) return;
      if (isApiError(err)) {
        if (err.code === "ACCESS_CHANGED") {
          void handleAccessChanged();
        }
        setRescheduleError(err);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="drawer-result-panel">
      <div className="flex items-center justify-between gap-2">
        <span
          title={result.tool}
          className="truncate text-[12px] font-medium text-[var(--ink-muted)]"
        >
          {localizeTool(result.tool)}
        </span>
        <SourceTag source={result.source} />
      </div>

      {shipment && (
        <>
          <dl className="divide-y divide-[var(--hairline-subtle)] rounded-tile bg-[var(--bg-surface-tint)] text-[12px]">
            <div className="flex justify-between px-3.5 py-2.5">
              <dt className="text-[var(--ink-muted)]">
                {tx({
                  "zh-CN": "运单编号",
                  "zh-HK": "運單編號",
                  en: "Shipment ID",
                })}
              </dt>
              <dd className="font-mono-code font-semibold text-[var(--ink-primary)]">
                {shipment.shipment_id}
              </dd>
            </div>
            <div className="flex justify-between px-3.5 py-2.5">
              <dt className="text-[var(--ink-muted)]">
                {tx({
                  "zh-CN": "仓库",
                  "zh-HK": "倉庫",
                  en: "Warehouse",
                })}
              </dt>
              <dd className="font-mono-code text-[var(--ink-primary)]">
                {shipment.warehouse}
              </dd>
            </div>
            <div className="flex justify-between px-3.5 py-2.5">
              <dt className="text-[var(--ink-muted)]">
                {tx({
                  "zh-CN": "当前交付日期",
                  "zh-HK": "目前交付日期",
                  en: "Current Delivery Date",
                })}
              </dt>
              <dd className="font-mono-code font-semibold text-[var(--ink-primary)] tabular-nums">
                {shipment.delivery_date}
              </dd>
            </div>
            <div className="flex justify-between px-3.5 py-2.5">
              <dt className="text-[var(--ink-muted)]">
                {tx({
                  "zh-CN": "状态 / 版本",
                  "zh-HK": "狀態 / 版本",
                  en: "Status / Version",
                })}
              </dt>
              <dd className="flex items-center gap-2">
                <StatusBadge status={shipment.status} compact />
                <span className="font-mono-code text-[var(--ink-muted)]">
                  v{shipment.version}
                </span>
              </dd>
            </div>
          </dl>

          {canReschedule && (
            <form
              onSubmit={(e) => void handleReschedule(e)}
              className="rounded-card bg-[var(--bg-surface)] p-4 shadow-[var(--shadow-card)] space-y-3"
            >
              <div className="text-[13px] font-semibold text-[var(--ink-primary)]">
                {tx({
                  "zh-CN": "发起运单改期提案",
                  "zh-HK": "發起運單改期提案",
                  en: "Propose Shipment Reschedule",
                })}
              </div>
              <p className="text-[12px] text-[var(--ink-muted)] leading-relaxed">
                {tx({
                  "zh-CN": "提交后将生成待审批提案，需独立审批人确认后方写入 ERP。",
                  "zh-HK": "提交後將產生待審批提案，須獨立審批人確認後方寫入 ERP。",
                  en: "Creates a pending proposal requiring independent approval before posting to ERP.",
                })}
              </p>
              <div>
                <label
                  htmlFor="drawer-reschedule-date"
                  className="block text-[11.5px] font-medium text-[var(--ink-secondary)]"
                >
                  {tx({
                    "zh-CN": "新交付日期 (YYYY-MM-DD)",
                    "zh-HK": "新交付日期 (YYYY-MM-DD)",
                    en: "New Delivery Date (YYYY-MM-DD)",
                  })}
                </label>
                <input
                  id="drawer-reschedule-date"
                  type="date"
                  required
                  value={newDate}
                  onChange={(e) => setNewDate(e.target.value)}
                  className="mt-1 h-9 w-full rounded-sm bg-[var(--bg-surface-tint)] px-3 font-mono-code text-[12.5px] text-[var(--ink-primary)] ring-1 ring-[var(--hairline-strong)] focus:bg-[var(--bg-surface)] focus:ring-2 focus:ring-[var(--accent)] focus:outline-none"
                />
              </div>
              {rescheduleError && <AccessNoticeCard error={rescheduleError} />}
              <Button
                type="submit"
                size="sm"
                variant="primary"
                pill
                loading={submitting}
                disabled={!newDate}
                className="w-full"
              >
                {submitting
                  ? tx({
                      "zh-CN": "生成提案中…",
                      "zh-HK": "產生提案中…",
                      en: "Creating proposal…",
                    })
                  : tx({
                      "zh-CN": "生成改期提案",
                      "zh-HK": "產生改期提案",
                      en: "Create Reschedule Proposal",
                    })}
              </Button>
            </form>
          )}
        </>
      )}

      {result.tool === "finance.invoice.read" &&
        typeof rawData.invoice_id === "string" && (
          <dl className="divide-y divide-[var(--hairline-subtle)] rounded-tile bg-[var(--bg-surface-tint)] text-[12px]">
            <div className="flex justify-between px-3.5 py-2.5">
              <dt className="text-[var(--ink-muted)]">
                {tx({
                  "zh-CN": "发票编号",
                  "zh-HK": "發票編號",
                  en: "Invoice ID",
                })}
              </dt>
              <dd className="font-mono-code font-semibold text-[var(--ink-primary)]">
                {(rawData as unknown as InvoiceView).invoice_id}
              </dd>
            </div>
            <div className="flex justify-between px-3.5 py-2.5">
              <dt className="text-[var(--ink-muted)]">
                {tx({
                  "zh-CN": "仓库",
                  "zh-HK": "倉庫",
                  en: "Warehouse",
                })}
              </dt>
              <dd className="font-mono-code text-[var(--ink-primary)]">
                {(rawData as unknown as InvoiceView).warehouse}
              </dd>
            </div>
            <div className="flex justify-between px-3.5 py-2.5">
              <dt className="text-[var(--ink-muted)]">
                {tx({
                  "zh-CN": "金额",
                  "zh-HK": "金額",
                  en: "Amount",
                })}
              </dt>
              <dd className="font-mono-code font-semibold text-[var(--ink-primary)] tabular-nums">
                {(rawData as unknown as InvoiceView).currency}{" "}
                {(rawData as unknown as InvoiceView).amount}
              </dd>
            </div>
            <div className="flex justify-between px-3.5 py-2.5">
              <dt className="text-[var(--ink-muted)]">
                {tx({
                  "zh-CN": "状态",
                  "zh-HK": "狀態",
                  en: "Status",
                })}
              </dt>
              <dd>
                <StatusBadge
                  status={(rawData as unknown as InvoiceView).state}
                  compact
                />
              </dd>
            </div>
          </dl>
        )}

      {result.tool === "decision.warehouse.summary" &&
        typeof rawData.open_shipments === "number" && (
          <dl className="divide-y divide-[var(--hairline-subtle)] rounded-tile bg-[var(--bg-surface-tint)] text-[12px]">
            <div className="flex justify-between px-3.5 py-2.5">
              <dt className="text-[var(--ink-muted)]">
                {tx({
                  "zh-CN": "仓库",
                  "zh-HK": "倉庫",
                  en: "Warehouse",
                })}
              </dt>
              <dd className="font-mono-code font-semibold text-[var(--ink-primary)]">
                {(rawData as unknown as WarehouseDecisionSummary).warehouse}
              </dd>
            </div>
            <div className="flex justify-between px-3.5 py-2.5">
              <dt className="text-[var(--ink-muted)]">
                {tx({
                  "zh-CN": "未关闭运单数",
                  "zh-HK": "未關閉運單數",
                  en: "Open Shipments",
                })}
              </dt>
              <dd className="font-semibold text-[var(--ink-primary)] tabular-nums">
                {(rawData as unknown as WarehouseDecisionSummary).open_shipments}
              </dd>
            </div>
            <div className="flex justify-between px-3.5 py-2.5">
              <dt className="text-[var(--ink-muted)]">
                {tx({
                  "zh-CN": "统计日期",
                  "zh-HK": "統計日期",
                  en: "As of",
                })}
              </dt>
              <dd className="font-mono-code text-[var(--ink-primary)] tabular-nums">
                {(rawData as unknown as WarehouseDecisionSummary).as_of}
              </dd>
            </div>
          </dl>
        )}

      {!shipment &&
        result.tool !== "finance.invoice.read" &&
        result.tool !== "decision.warehouse.summary" && (
          <dl className="divide-y divide-[var(--hairline-subtle)] rounded-tile bg-[var(--bg-surface-tint)] text-[12px]">
            {Object.entries(rawData).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-2 px-3.5 py-2">
                <dt className="font-mono-code text-[var(--ink-muted)]">{k}</dt>
                <dd className="font-mono-code text-right text-[var(--ink-primary)] break-all">
                  {typeof v === "string" ||
                  typeof v === "number" ||
                  typeof v === "boolean"
                    ? String(v)
                    : JSON.stringify(v)}
                </dd>
              </div>
            ))}
          </dl>
        )}
    </div>
  );
}
