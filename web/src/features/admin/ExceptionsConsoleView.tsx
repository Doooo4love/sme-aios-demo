"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowUpRight,
  CheckCircle2,
  Eye,
  Info,
  Play,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { isApiError, isStaleAuthError, type ApiError } from "@/lib/api-client";
import { formatUnixTime } from "@/lib/format";
import { useSession } from "@/lib/session-context";
import { useWorkbench } from "@/lib/workbench-context";
import {
  AccessNoticeCard,
  Button,
  SourceTag,
  StatusBadge,
} from "@/components/ui";
import { ActionConfirmDialog } from "@/features/admin/ActionConfirmDialog";
import {
  fetchOperationsExceptions,
  reconcileProposal,
  runDemoWorkerTick,
} from "@/features/admin/api";
import type { DueCursor, ExceptionItem } from "@/lib/types";

const PAGE_LIMIT = 50;

const LAST_EVENT_LABELS: Record<string, string> = {
  OUTCOME_UNKNOWN: "ERP 通信中断或超时，结果待确认",
  READBACK_REOPENED: "管理员已发起回执重新核查",
  READBACK_LIMIT_REACHED: "自动回执核查达到上限（3次），转人工核查",
  LEASE_EXPIRED_VERIFY_ONLY: "执行租约过期，转为只读回执核查",
  LEASE_LOST_BEFORE_SEND: "发送前租约失效",
  INVALID_STORED_PLAN: "已存提案结构校验失败",
  PLAN_DIGEST_OR_TENANT_MISMATCH: "提案摘要或租户边界不一致",
  ERP_RECEIPT_MISMATCH: "ERP 回执字段与已批准提案不一致",
  NEEDS_OPERATOR: "已转交运维人工核查",
};

interface BannerNotice {
  kind: "success" | "conflict";
  message: string;
}

export function ExceptionsConsoleView() {
  const {
    actor,
    demoConfig,
    canAccessAdminOps,
    authGeneration,
    handleAccessChanged,
  } = useSession();
  const { openDrawer } = useWorkbench();

  const [items, setItems] = useState<ExceptionItem[]>([]);
  const [nextCursor, setNextCursor] = useState<DueCursor | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<ApiError | null>(null);

  // Reconcile action state
  const [reconcileTarget, setReconcileTarget] = useState<ExceptionItem | null>(
    null,
  );
  const [reconciling, setReconciling] = useState(false);
  const [actionNotice, setActionNotice] = useState<BannerNotice | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);

  // Optional demo worker tick shortcut
  const [tickBusy, setTickBusy] = useState(false);
  const [tickNotice, setTickNotice] = useState<string | null>(null);

  const canRunDemoTick = Boolean(
    demoConfig?.enabled &&
      actor?.role === "admin" &&
      actor?.grants.includes("operations.manage"),
  );

  const loadExceptions = useCallback(
    async (signal?: AbortSignal) => {
      if (!canAccessAdminOps) return;
      setLoading(true);
      setLoadError(null);
      try {
        const page = await fetchOperationsExceptions(
          { limit: PAGE_LIMIT },
          signal,
        );
        setItems(page.items);
        setNextCursor(page.next);
      } catch (err) {
        if (isStaleAuthError(err)) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (isApiError(err)) {
          if (err.code === "ACCESS_CHANGED") {
            setItems([]);
            setNextCursor(null);
            void handleAccessChanged();
          }
          setLoadError(err);
        }
      } finally {
        setLoading(false);
      }
    },
    [canAccessAdminOps, handleAccessChanged],
  );

  useEffect(() => {
    setItems([]);
    setNextCursor(null);
    setLoadError(null);
    setReconcileTarget(null);
    setActionNotice(null);
    setActionError(null);
    setTickNotice(null);

    if (!canAccessAdminOps) return;

    const controller = new AbortController();
    void loadExceptions(controller.signal);
    return () => {
      controller.abort();
    };
  }, [authGeneration, canAccessAdminOps, loadExceptions]);

  const handleLoadMore = useCallback(async () => {
    if (!canAccessAdminOps || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    setLoadError(null);
    try {
      const page = await fetchOperationsExceptions({
        limit: PAGE_LIMIT,
        after_due: nextCursor.after_due,
        after_id: nextCursor.after_id,
      });
      setItems((prev) => {
        const seen = new Set(prev.map((row) => row.proposal_id));
        const merged = [...prev];
        for (const item of page.items) {
          if (!seen.has(item.proposal_id)) {
            seen.add(item.proposal_id);
            merged.push(item);
          }
        }
        return merged;
      });
      setNextCursor(page.next);
    } catch (err) {
      if (isStaleAuthError(err)) return;
      if (isApiError(err)) {
        if (err.code === "ACCESS_CHANGED") {
          setItems([]);
          setNextCursor(null);
          void handleAccessChanged();
        }
        setLoadError(err);
      }
    } finally {
      setLoadingMore(false);
    }
  }, [canAccessAdminOps, nextCursor, loadingMore, handleAccessChanged]);

  const handleConfirmReconcile = useCallback(async () => {
    if (!reconcileTarget || reconciling) return;
    const targetId = reconcileTarget.proposal_id;
    setReconciling(true);
    setActionNotice(null);
    setActionError(null);
    try {
      const updated = await reconcileProposal(targetId);
      setReconcileTarget(null);
      setActionNotice({
        kind: "success",
        message: `已为提案 ${targetId} 发起只读回执核查，最新状态为 ${updated.state}（核验计数已重置为 ${updated.checks}）。`,
      });
      await loadExceptions();
    } catch (err) {
      if (isStaleAuthError(err)) return;
      setReconcileTarget(null);
      if (isApiError(err)) {
        if (err.code === "ACCESS_CHANGED") {
          void handleAccessChanged();
        }
        if (err.status === 409) {
          setActionNotice({
            kind: "conflict",
            message: `提案 ${targetId} 状态已变更，当前不可发起回执核查（409），已刷新最新队列。`,
          });
          await loadExceptions();
        } else {
          // Handles 403 ACCESS_RESTRICTED, 404 RECORD_UNAVAILABLE, 503 cleanly
          setActionError(err);
        }
      }
    } finally {
      setReconciling(false);
    }
  }, [reconcileTarget, reconciling, loadExceptions, handleAccessChanged]);

  const handleDemoTick = useCallback(async () => {
    if (!canRunDemoTick || tickBusy) return;
    setTickBusy(true);
    setTickNotice(null);
    setActionError(null);
    try {
      const res = await runDemoWorkerTick();
      setTickNotice(
        res.worked
          ? `worker-tick: worked=true — 已推进 1 条任务并刷新异常队列。`
          : `worker-tick: worked=false — 当前无待执行的队列任务（或写入已暂停）。`,
      );
      await loadExceptions();
    } catch (err) {
      if (isStaleAuthError(err)) return;
      if (isApiError(err)) {
        setActionError(err);
      }
    } finally {
      setTickBusy(false);
    }
  }, [canRunDemoTick, tickBusy, loadExceptions]);

  // Strict capability gate: never fetch /v1/operations/exceptions for unauthorized roles
  if (!canAccessAdminOps) {
    return (
      <div
        className="mx-auto max-w-[820px] p-4 sm:p-6"
        data-testid="exceptions-access-denied"
      >
        <AccessNoticeCard
          variant="ACCESS_RESTRICTED"
          title="需要运维管理权限 (operations.manage)"
          message="异常单据队列仅限具备 operations.manage 权限的主管或管理员查看与发起回执核查。"
          backHref="/inbox"
          backLabel="返回工作台"
        />
      </div>
    );
  }

  return (
    <div
      className="mx-auto max-w-[1160px] space-y-4 p-4 sm:p-6"
      data-testid="admin-exceptions-page"
    >
      {/* Header Sheet */}
      <section className="rounded-[6px] border border-[var(--hairline)] bg-[var(--bg-sheet)] p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <Link
              href="/admin"
              className="inline-flex items-center gap-1.5 text-[12px] font-medium text-[var(--ink-muted)] hover:text-[var(--ink-primary)]"
            >
              <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} />
              <span>返回运维控制中心</span>
            </Link>
            <h2 className="mt-2 text-[20px] font-semibold tracking-[-0.02em] text-[var(--ink-primary)]">
              异常单据队列
            </h2>
            <p className="mt-1 text-[13px] text-[var(--ink-muted)]">
              集中展示授权仓库范围内的{" "}
              <code className="font-mono-code text-[12px]">NEEDS_OPERATOR</code>{" "}
              与{" "}
              <code className="font-mono-code text-[12px]">OUTCOME_UNKNOWN</code>{" "}
              单据；支持对人工挂起单据发起只读回执核查（Reconcile），不会重复写入 ERP。
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {canRunDemoTick && (
              <Button
                size="sm"
                variant="secondary"
                loading={tickBusy}
                data-testid="exceptions-worker-tick-btn"
                onClick={() => void handleDemoTick()}
              >
                <Play className="h-3.5 w-3.5" strokeWidth={1.75} />
                <span>演示 Worker Tick</span>
              </Button>
            )}
            <Button
              size="sm"
              variant="secondary"
              loading={loading}
              data-testid="exceptions-refresh-btn"
              onClick={() => void loadExceptions()}
            >
              <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} />
              <span>刷新队列</span>
            </Button>
          </div>
        </div>

        <div className="mt-3.5 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--hairline)] pt-3 text-[12px] text-[var(--ink-secondary)]">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span>
              租户：
              <strong className="font-mono-code text-[var(--ink-primary)]">
                {actor?.tenant ?? "—"}
              </strong>
            </span>
            <span>
              授权仓库：
              <strong className="font-mono-code text-[var(--ink-primary)]">
                {actor?.warehouses.join(", ") || "无"}
              </strong>
            </span>
            <span className="font-mono-code text-[var(--ink-muted)] tabular-nums">
              当前已加载 {items.length} 条{nextCursor ? "+" : ""}
            </span>
          </div>
          {canRunDemoTick && <SourceTag source="synthetic" />}
        </div>

        <div className="mt-3 flex items-start gap-2 rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] px-3 py-2 text-[12px] text-[var(--ink-secondary)] leading-relaxed">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--ink-muted)]" strokeWidth={1.75} />
          <span>
            点击「查看单据」将进入单据详情页并重新校验当前账号的业务模块读取权限；执行「发起回执核查 (Reconcile)」仅触发 ERP 只读回查，不会重复发送业务写入。
          </span>
        </div>
      </section>

      {/* Action Feedback Banners */}
      {tickNotice && (
        <div
          role="status"
          data-testid="exceptions-worker-tick-result"
          className="flex items-center gap-2 rounded-[4px] border border-[var(--accent-border)] bg-[var(--accent-wash)] px-3.5 py-2.5 font-mono-code text-[12px] text-[var(--accent)]"
        >
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
          <span>{tickNotice}</span>
        </div>
      )}

      {actionNotice && (
        <div
          role="status"
          data-testid="reconcile-feedback"
          className={[
            "flex items-center gap-2 rounded-[4px] border px-3.5 py-2.5 text-[12.5px]",
            actionNotice.kind === "success"
              ? "border-[var(--status-emerald-border)] bg-[var(--status-emerald-wash)] text-[var(--status-emerald)]"
              : "border-[var(--status-amber-border)] bg-[var(--status-amber-wash)] text-[var(--status-amber-ink)]",
          ].join(" ")}
        >
          <CheckCircle2 className="h-4 w-4 shrink-0" strokeWidth={1.75} />
          <span>{actionNotice.message}</span>
        </div>
      )}

      {actionError && (
        <AccessNoticeCard
          error={actionError}
          onRetry={() => {
            setActionError(null);
            void loadExceptions();
          }}
        />
      )}

      {loadError && (
        <AccessNoticeCard
          error={loadError}
          onRetry={() => void loadExceptions()}
          backHref="/admin"
          backLabel="返回运维控制中心"
        />
      )}

      {/* Exceptions Table Sheet */}
      {!loadError && (
        <section className="rounded-[6px] border border-[var(--hairline)] bg-[var(--bg-sheet)] overflow-hidden">
          {loading && items.length === 0 ? (
            <div className="px-4 py-12 text-center font-mono-code text-[12.5px] text-[var(--ink-muted)]">
              正在加载异常单据队列…
            </div>
          ) : items.length === 0 ? (
            <div
              data-testid="exceptions-empty-state"
              className="flex flex-col items-center gap-2 px-4 py-14 text-center"
            >
              <CheckCircle2
                className="h-6 w-6 text-[var(--status-emerald)]"
                strokeWidth={1.75}
              />
              <div className="text-[14px] font-medium text-[var(--ink-primary)]">
                当前没有待处置异常单据
              </div>
              <p className="text-[12.5px] text-[var(--ink-muted)]">
                授权仓库范围内所有已派发提案均未滞留在{" "}
                <code className="font-mono-code">NEEDS_OPERATOR</code> 或{" "}
                <code className="font-mono-code">OUTCOME_UNKNOWN</code> 状态。
              </p>
            </div>
          ) : (
            <>
              {/* Desktop Compact Hairline Table */}
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full border-collapse text-left">
                  <thead>
                    <tr className="border-b border-[var(--hairline)] bg-[var(--bg-plane)] text-[11.5px] font-medium text-[var(--ink-secondary)]">
                      <th className="px-4 py-2.5">提案编号</th>
                      <th className="px-3 py-2.5">仓库</th>
                      <th className="px-3 py-2.5">状态</th>
                      <th className="px-3 py-2.5 text-right">核验轮次</th>
                      <th className="px-3 py-2.5">最近异常事件</th>
                      <th className="px-3 py-2.5 text-right">计划/到期时间</th>
                      <th className="px-4 py-2.5 text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--hairline)]">
                    {items.map((item) => {
                      const canReconcile = item.state === "NEEDS_OPERATOR";
                      const eventExplanation = item.last_event
                        ? LAST_EVENT_LABELS[item.last_event]
                        : null;
                      return (
                        <tr
                          key={item.proposal_id}
                          data-testid={`exception-row-${item.proposal_id}`}
                          className="transition-colors duration-[120ms] hover:bg-[var(--bg-subtle)]"
                        >
                          <td className="px-4 py-3">
                            <Link
                              href={`/proposals/${encodeURIComponent(item.proposal_id)}`}
                              className="font-mono-code text-[12.5px] font-semibold text-[var(--ink-primary)] hover:text-[var(--accent)] hover:underline"
                            >
                              {item.proposal_id}
                            </Link>
                          </td>
                          <td className="px-3 py-3">
                            <span className="rounded-[2px] border border-[var(--hairline)] bg-[var(--bg-subtle)] px-1.5 py-0.5 font-mono-code text-[11.5px] text-[var(--ink-secondary)]">
                              {item.warehouse}
                            </span>
                          </td>
                          <td className="px-3 py-3">
                            <StatusBadge status={item.state} compact />
                          </td>
                          <td className="px-3 py-3 text-right font-mono-code text-[12.5px] text-[var(--ink-primary)] tabular-nums">
                            {item.checks}/3
                          </td>
                          <td className="px-3 py-3">
                            <div className="font-mono-code text-[11.5px] text-[var(--ink-primary)]">
                              {item.last_event ?? "—"}
                            </div>
                            {eventExplanation && (
                              <div className="mt-0.5 text-[11.5px] text-[var(--ink-muted)]">
                                {eventExplanation}
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-3 text-right font-mono-code text-[12px] text-[var(--ink-secondary)] tabular-nums whitespace-nowrap">
                            {formatUnixTime(item.due, { withSeconds: true })}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center justify-end gap-1.5">
                              <button
                                type="button"
                                onClick={(e) =>
                                  openDrawer(
                                    {
                                      kind: "proposal",
                                      id: item.proposal_id,
                                      warehouse: item.warehouse,
                                      title: "异常单据核对",
                                    },
                                    { tab: "current", trigger: e.currentTarget },
                                  )
                                }
                                title="在右侧面板预览提案详情"
                                className="inline-flex h-7 items-center gap-1 rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-2 text-[11.5px] font-medium text-[var(--ink-secondary)] hover:bg-[var(--bg-subtle)] hover:text-[var(--ink-primary)] cursor-pointer"
                              >
                                <Eye className="h-3 w-3" strokeWidth={1.75} />
                                <span>面板</span>
                              </button>

                              <Link
                                href={`/proposals/${encodeURIComponent(item.proposal_id)}`}
                                data-testid={`exception-view-${item.proposal_id}`}
                                className="inline-flex h-7 items-center gap-1 rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-2 text-[11.5px] font-medium text-[var(--ink-primary)] hover:bg-[var(--bg-subtle)]"
                              >
                                <span>详情</span>
                                <ArrowUpRight
                                  className="h-3 w-3"
                                  strokeWidth={1.75}
                                />
                              </Link>

                              <Button
                                size="sm"
                                variant={canReconcile ? "primary" : "secondary"}
                                disabled={!canReconcile || reconciling}
                                title={
                                  canReconcile
                                    ? "发起只读回执核查 (Reconcile)"
                                    : "OUTCOME_UNKNOWN 将自动重试回查；仅 NEEDS_OPERATOR 可手动重启核查"
                                }
                                data-testid={`reconcile-btn-${item.proposal_id}`}
                                onClick={() => setReconcileTarget(item)}
                              >
                                <RotateCcw
                                  className="h-3 w-3"
                                  strokeWidth={1.75}
                                />
                                <span>发起回执核查</span>
                              </Button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Mobile Stacked Hairline List */}
              <div className="divide-y divide-[var(--hairline)] md:hidden">
                {items.map((item) => {
                  const canReconcile = item.state === "NEEDS_OPERATOR";
                  return (
                    <div
                      key={item.proposal_id}
                      data-testid={`exception-mobile-row-${item.proposal_id}`}
                      className="space-y-2.5 p-4"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <Link
                          href={`/proposals/${encodeURIComponent(item.proposal_id)}`}
                          className="font-mono-code text-[13px] font-semibold text-[var(--ink-primary)] hover:text-[var(--accent)]"
                        >
                          {item.proposal_id}
                        </Link>
                        <StatusBadge status={item.state} compact />
                      </div>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono-code text-[11.5px] text-[var(--ink-muted)] tabular-nums">
                        <span>仓库 {item.warehouse}</span>
                        <span>核验 {item.checks}/3</span>
                        <span>
                          时间 {formatUnixTime(item.due, { withSeconds: true })}
                        </span>
                      </div>
                      {item.last_event && (
                        <div className="text-[12px] text-[var(--ink-secondary)]">
                          <code className="font-mono-code text-[11.5px]">
                            {item.last_event}
                          </code>
                          {LAST_EVENT_LABELS[item.last_event] && (
                            <span className="ml-1.5 text-[var(--ink-muted)]">
                              · {LAST_EVENT_LABELS[item.last_event]}
                            </span>
                          )}
                        </div>
                      )}
                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        <Link
                          href={`/proposals/${encodeURIComponent(item.proposal_id)}`}
                          className="inline-flex h-9 items-center gap-1 rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-3 text-[12.5px] font-medium text-[var(--ink-primary)]"
                        >
                          <span>查看单据详情</span>
                          <ArrowUpRight className="h-3.5 w-3.5" />
                        </Link>
                        <Button
                          size="md"
                          variant={canReconcile ? "primary" : "secondary"}
                          disabled={!canReconcile || reconciling}
                          data-testid={`exception-mobile-reconcile-btn-${item.proposal_id}`}
                          onClick={() => setReconcileTarget(item)}
                        >
                          <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.75} />
                          <span>发起回执核查</span>
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Dual-Value Cursor Pagination Footer */}
              <div className="flex flex-col gap-2 border-t border-[var(--hairline)] bg-[var(--bg-subtle)] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <span className="font-mono-code text-[11.5px] text-[var(--ink-muted)] tabular-nums">
                  {nextCursor
                    ? `双值游标 after_due=${nextCursor.after_due} · after_id=${nextCursor.after_id}`
                    : `已加载全部可见异常单据（共 ${items.length} 条）`}
                </span>
                {nextCursor && (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={loadingMore}
                    data-testid="exceptions-load-more"
                    onClick={() => void handleLoadMore()}
                  >
                    加载更多异常
                  </Button>
                )}
              </div>
            </>
          )}
        </section>
      )}

      {/* Reconcile Confirmation Dialog */}
      <ActionConfirmDialog
        open={reconcileTarget !== null}
        onOpenChange={(open) => {
          if (!open && !reconciling) setReconcileTarget(null);
        }}
        destructive={false}
        loading={reconciling}
        title="确认发起回执核查 (Reconcile)"
        description="系统将仅向 ERP 执行只读回执核查，不会重复发送任何 ERP 写入请求。确认后提案状态将由 NEEDS_OPERATOR 转为 OUTCOME_UNKNOWN，并将自动核验计数重置为 0。"
        scopeSummary={`租户 ${actor?.tenant ?? "—"} · 仓库 ${reconcileTarget?.warehouse ?? "—"} · 提案 ${reconcileTarget?.proposal_id ?? "—"}`}
        metadata={[
          {
            label: "提案编号",
            value: reconcileTarget?.proposal_id ?? "—",
            mono: true,
          },
          {
            label: "仓库站点",
            value: reconcileTarget?.warehouse ?? "—",
            mono: true,
          },
          {
            label: "当前状态",
            value: reconcileTarget?.state ?? "—",
            mono: true,
          },
          {
            label: "当前核验轮次",
            value:
              reconcileTarget !== null ? `${reconcileTarget.checks}/3` : "—",
            mono: true,
          },
          {
            label: "最近异常事件",
            value: reconcileTarget?.last_event ?? "—",
            mono: true,
          },
        ]}
        confirmLabel="确认发起回执核查"
        cancelLabel="取消"
        dialogTestId="reconcile-confirm-dialog"
        confirmTestId="confirm-dialog-submit"
        onConfirm={handleConfirmReconcile}
      />
    </div>
  );
}
