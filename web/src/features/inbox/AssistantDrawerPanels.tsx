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
import {
  formatProposalAction,
  formatShortDigest,
  formatUnixTime,
} from "@/lib/format";
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
    <div className="space-y-3" data-testid="drawer-brief-panel">
      <div className="flex items-center justify-between gap-2">
        <div className="inline-flex rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-subtle)] p-0.5">
          {([1, 7] as const).map((days) => (
            <button
              key={days}
              type="button"
              onClick={() => setWindowDays(days)}
              className={[
                "rounded-[3px] px-2.5 py-1 text-[11.5px] font-medium transition-colors duration-[120ms] cursor-pointer",
                windowDays === days
                  ? "bg-[var(--bg-sheet)] text-[var(--ink-primary)] border border-[var(--hairline-strong)]"
                  : "text-[var(--ink-muted)] hover:text-[var(--ink-primary)] border border-transparent",
              ].join(" ")}
            >
              {days === 1 ? "今日" : "未来 7 天"}
            </button>
          ))}
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void load(windowDays)}
          disabled={loading}
        >
          <RefreshCw
            className={["h-3.5 w-3.5", loading ? "animate-spin" : ""].join(" ")}
            strokeWidth={1.75}
          />
          <span>刷新</span>
        </Button>
      </div>

      {loading && !brief && (
        <div className="py-8 text-center text-[12.5px] text-[var(--ink-muted)]">
          正在汇总{windowDays === 1 ? "今日" : "近 7 天"}简报…
        </div>
      )}

      {error && (
        <AccessNoticeCard error={error} onRetry={() => void load(windowDays)} />
      )}

      {brief && !error && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] p-3">
              <div className="text-[11.5px] text-[var(--ink-muted)]">待我审批</div>
              <div className="mt-1 font-mono-code text-[22px] font-semibold text-[var(--ink-primary)]">
                {brief.pending_approvals}
                {brief.pending_approvals_capped ? "+" : ""}
              </div>
            </div>
            <div className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] p-3">
              <div className="text-[11.5px] text-[var(--ink-muted)]">
                {windowDays === 1 ? "今日会议" : "7 天内会议"}
              </div>
              <div className="mt-1 font-mono-code text-[22px] font-semibold text-[var(--ink-primary)]">
                {brief.meetings}
              </div>
            </div>
          </div>

          <div className="rounded-[4px] border border-[var(--hairline)]">
            <div className="border-b border-[var(--hairline)] bg-[var(--bg-plane)] px-3 py-1.5 text-[11.5px] font-medium text-[var(--ink-secondary)]">
              我提交的单据状态分布
            </div>
            <div className="divide-y divide-[var(--hairline-subtle)]">
              {Object.entries(brief.submitted_current_states).length === 0 ? (
                <div className="px-3 py-4 text-center text-[12px] text-[var(--ink-muted)]">
                  暂无已提交单据
                </div>
              ) : (
                Object.entries(brief.submitted_current_states).map(
                  ([stateKey, count]) => (
                    <div
                      key={stateKey}
                      className="flex items-center justify-between px-3 py-2 text-[12px]"
                    >
                      <StatusBadge status={stateKey} compact />
                      <span className="font-mono-code font-semibold text-[var(--ink-primary)]">
                        {count}
                      </span>
                    </div>
                  ),
                )
              )}
            </div>
          </div>

          <div className="font-mono-code text-[11px] text-[var(--ink-muted)]">
            快照时间：{formatUnixTime(brief.as_of)}
          </div>

          <div className="grid grid-cols-2 gap-2 pt-1">
            <Link
              href="/work"
              className="inline-flex h-8 items-center justify-center gap-1 rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-2.5 text-[12px] font-medium text-[var(--ink-primary)] hover:bg-[var(--bg-subtle)]"
            >
              <span>打开工作台</span>
              <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.75} />
            </Link>
            <Link
              href="/calendar"
              className="inline-flex h-8 items-center justify-center gap-1 rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-2.5 text-[12px] font-medium text-[var(--ink-primary)] hover:bg-[var(--bg-subtle)]"
            >
              <Calendar className="h-3.5 w-3.5" strokeWidth={1.75} />
              <span>打开日历</span>
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
        正在实时核验提案单据…
      </div>
    );
  }

  if (error) {
    return <AccessNoticeCard error={error} onRetry={() => void load()} />;
  }

  if (!proposal) return null;

  const { action, before, after } = proposal.plan;

  return (
    <div className="space-y-3.5" data-testid="drawer-proposal-panel">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono-code text-[13px] font-semibold text-[var(--ink-primary)] truncate">
          {proposal.id}
        </span>
        <div className="flex items-center gap-1.5">
          <StatusBadge status={proposal.state} compact />
          <button
            type="button"
            onClick={() => void load()}
            aria-label="刷新提案快照"
            className="inline-flex h-6 w-6 items-center justify-center rounded-[4px] text-[var(--ink-muted)] hover:bg-[var(--bg-plane)] cursor-pointer"
          >
            <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
        </div>
      </div>

      <ExecutionTopologyRibbon
        state={proposal.state}
        checks={proposal.checks}
        events={proposal.events}
        variant="vertical-rail"
      />

      <dl className="divide-y divide-[var(--hairline-subtle)] rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] text-[12px]">
        <div className="flex justify-between gap-2 px-3 py-2">
          <dt className="text-[var(--ink-muted)]">动作类型</dt>
          <dd className="font-medium text-[var(--ink-primary)]">
            {formatProposalAction(action)}
          </dd>
        </div>
        <div className="flex justify-between gap-2 px-3 py-2">
          <dt className="text-[var(--ink-muted)]">目标对象</dt>
          <dd className="font-mono-code text-[var(--ink-primary)]">
            {proposal.plan.target}
          </dd>
        </div>
        <div className="flex justify-between gap-2 px-3 py-2">
          <dt className="text-[var(--ink-muted)]">发起人 / 审批人</dt>
          <dd className="font-mono-code text-[var(--ink-primary)]">
            {proposal.requester} / {proposal.approver || "待定"}
          </dd>
        </div>
        <div className="flex justify-between gap-2 px-3 py-2">
          <dt className="text-[var(--ink-muted)]">摘要锁</dt>
          <dd className="font-mono-code text-[var(--ink-primary)]">
            {formatShortDigest(proposal.digest)}
          </dd>
        </div>
      </dl>

      {/* Diff summary */}
      {action === "shipment.reschedule" && (
        <div className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-sheet)] p-3 text-[12px]">
          <div className="font-mono-code text-[10.5px] uppercase text-[var(--ink-muted)]">
            字段变更比对
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <span className="text-[var(--ink-muted)]">交付日期</span>
            <span className="font-mono-code line-through text-[var(--ink-secondary)]">
              {String(before.delivery_date ?? "—")}
            </span>
            <ArrowRight className="h-3 w-3 text-[var(--ink-muted)]" />
            <span className="font-mono-code font-semibold text-[var(--accent)]">
              {String(after.delivery_date ?? "—")}
            </span>
          </div>
        </div>
      )}

      {proposal.state === "VERIFIED" && proposal.receipt && (
        <div className="rounded-[4px] border border-[var(--status-emerald-border)] bg-[var(--status-emerald-wash)] p-3 text-[12px]">
          <div className="flex items-center gap-1.5 font-semibold text-[var(--status-emerald)]">
            <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={1.75} />
            <span>ERP 回执已核对一致</span>
          </div>
          <div className="mt-1.5 space-y-1 font-mono-code text-[11px] text-[var(--ink-secondary)]">
            <div>远端回执号：{proposal.receipt.remote_id}</div>
            <div>操作编号：{proposal.receipt.operation_id}</div>
          </div>
        </div>
      )}

      {proposal.events.length > 0 && (
        <div className="rounded-[4px] border border-[var(--hairline)]">
          <div className="border-b border-[var(--hairline)] bg-[var(--bg-plane)] px-3 py-1.5 text-[11.5px] font-medium text-[var(--ink-secondary)]">
            审计事件轨迹 ({proposal.events.length})
          </div>
          <ul className="divide-y divide-[var(--hairline-subtle)] text-[11.5px]">
            {proposal.events.slice(-5).map((ev, idx) => (
              <li
                key={`${ev.event}-${ev.at}-${idx}`}
                className="flex items-center justify-between gap-2 px-3 py-1.5"
              >
                <span className="font-mono-code text-[var(--ink-primary)] truncate">
                  {ev.event}
                </span>
                <span className="shrink-0 font-mono-code text-[10.5px] text-[var(--ink-muted)]">
                  {ev.subject} · {formatUnixTime(ev.at)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Link
        href={`/proposals/${encodeURIComponent(proposal.id)}`}
        data-testid="drawer-proposal-open-full"
        className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-[4px] bg-[var(--accent)] px-3 text-[13px] font-medium text-white hover:bg-[var(--accent-hover)]"
      >
        <span>打开完整单据与正式审批页</span>
        <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.75} />
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
      <div className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] p-3 text-[12.5px] text-[var(--ink-muted)]">
        请选择具体业务记录查看详情。
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
    <div className="space-y-3.5" data-testid="drawer-result-panel">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono-code text-[12px] text-[var(--ink-muted)]">
          {result.tool}
        </span>
        <SourceTag source={result.source} />
      </div>

      {shipment && (
        <>
          <dl className="divide-y divide-[var(--hairline-subtle)] rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] text-[12px]">
            <div className="flex justify-between px-3 py-2">
              <dt className="text-[var(--ink-muted)]">运单编号</dt>
              <dd className="font-mono-code font-semibold text-[var(--ink-primary)]">
                {shipment.shipment_id}
              </dd>
            </div>
            <div className="flex justify-between px-3 py-2">
              <dt className="text-[var(--ink-muted)]">仓库站点</dt>
              <dd className="font-mono-code text-[var(--ink-primary)]">
                {shipment.warehouse}
              </dd>
            </div>
            <div className="flex justify-between px-3 py-2">
              <dt className="text-[var(--ink-muted)]">当前交付日期</dt>
              <dd className="font-mono-code font-semibold text-[var(--ink-primary)]">
                {shipment.delivery_date}
              </dd>
            </div>
            <div className="flex justify-between px-3 py-2">
              <dt className="text-[var(--ink-muted)]">状态 / 版本</dt>
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
              className="rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] p-3 space-y-2.5"
            >
              <div className="text-[12.5px] font-semibold text-[var(--ink-primary)]">
                发起运单改期提案
              </div>
              <p className="text-[11.5px] text-[var(--ink-muted)]">
                提交后将生成待审批提案（PROPOSED），需独立审批人确认后方写入 ERP。
              </p>
              <div>
                <label
                  htmlFor="drawer-reschedule-date"
                  className="block text-[11.5px] text-[var(--ink-secondary)]"
                >
                  新交付日期 (YYYY-MM-DD)
                </label>
                <input
                  id="drawer-reschedule-date"
                  type="date"
                  required
                  value={newDate}
                  onChange={(e) => setNewDate(e.target.value)}
                  className="mt-1 h-8 w-full rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-2.5 font-mono-code text-[12.5px] text-[var(--ink-primary)] focus:border-[var(--accent)] focus:outline-none"
                />
              </div>
              {rescheduleError && <AccessNoticeCard error={rescheduleError} />}
              <Button
                type="submit"
                size="sm"
                variant="primary"
                loading={submitting}
                disabled={!newDate}
                className="w-full"
              >
                {submitting ? "生成提案中…" : "生成改期提案"}
              </Button>
            </form>
          )}
        </>
      )}

      {result.tool === "finance.invoice.read" &&
        typeof rawData.invoice_id === "string" && (
          <dl className="divide-y divide-[var(--hairline-subtle)] rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] text-[12px]">
            <div className="flex justify-between px-3 py-2">
              <dt className="text-[var(--ink-muted)]">发票编号</dt>
              <dd className="font-mono-code font-semibold text-[var(--ink-primary)]">
                {(rawData as unknown as InvoiceView).invoice_id}
              </dd>
            </div>
            <div className="flex justify-between px-3 py-2">
              <dt className="text-[var(--ink-muted)]">仓库</dt>
              <dd className="font-mono-code text-[var(--ink-primary)]">
                {(rawData as unknown as InvoiceView).warehouse}
              </dd>
            </div>
            <div className="flex justify-between px-3 py-2">
              <dt className="text-[var(--ink-muted)]">金额</dt>
              <dd className="font-mono-code font-semibold text-[var(--ink-primary)]">
                {(rawData as unknown as InvoiceView).currency}{" "}
                {(rawData as unknown as InvoiceView).amount}
              </dd>
            </div>
            <div className="flex justify-between px-3 py-2">
              <dt className="text-[var(--ink-muted)]">状态</dt>
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
          <dl className="divide-y divide-[var(--hairline-subtle)] rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] text-[12px]">
            <div className="flex justify-between px-3 py-2">
              <dt className="text-[var(--ink-muted)]">仓库站点</dt>
              <dd className="font-mono-code font-semibold text-[var(--ink-primary)]">
                {(rawData as unknown as WarehouseDecisionSummary).warehouse}
              </dd>
            </div>
            <div className="flex justify-between px-3 py-2">
              <dt className="text-[var(--ink-muted)]">未关闭运单数</dt>
              <dd className="font-mono-code font-semibold text-[var(--ink-primary)]">
                {(rawData as unknown as WarehouseDecisionSummary).open_shipments}
              </dd>
            </div>
            <div className="flex justify-between px-3 py-2">
              <dt className="text-[var(--ink-muted)]">统计日期</dt>
              <dd className="font-mono-code text-[var(--ink-primary)]">
                {(rawData as unknown as WarehouseDecisionSummary).as_of}
              </dd>
            </div>
          </dl>
        )}

      {!shipment &&
        result.tool !== "finance.invoice.read" &&
        result.tool !== "decision.warehouse.summary" && (
          <dl className="divide-y divide-[var(--hairline-subtle)] rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] text-[12px]">
            {Object.entries(rawData).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-2 px-3 py-2">
                <dt className="font-mono-code text-[var(--ink-muted)]">{k}</dt>
                <dd className="font-mono-code text-right text-[var(--ink-primary)] break-all">
                  {typeof v === "string" || typeof v === "number" || typeof v === "boolean"
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
