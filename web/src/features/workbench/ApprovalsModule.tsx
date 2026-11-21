"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  CheckCircle2,
  ClipboardCheck,
  PanelRight,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import {
  getAuthGeneration,
  isApiError,
  isStaleAuthError,
  type ApiError,
} from "@/lib/api-client";
import {
  formatProposalAction,
  formatRelativeCountdown,
  formatShortDigest,
  formatUnixTime,
} from "@/lib/format";
import { useSession } from "@/lib/session-context";
import { useWorkbench } from "@/lib/workbench-context";
import { AccessNoticeCard } from "@/components/ui/AccessNoticeCard";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { StatusBadge } from "@/components/ui/StatusBadge";
import type {
  ApprovalItem,
  BatchApprovalResultItem,
  DueCursor,
  Proposal,
} from "@/lib/types";
import {
  approveProposalsBatch,
  fetchProposalDetail,
} from "@/features/proposals/api";
import { summarizePlanChange } from "@/features/proposals/ProposalDiffView";
import { fetchWorkbenchApprovals } from "@/features/workbench/api";

interface BatchPreparedRow {
  item: ApprovalItem;
  proposal: Proposal | null;
  error: string | null;
}

export function ApprovalsModule() {
  const { authGeneration, handleAccessChanged } = useSession();
  const { openDrawer, setAssignedCount } = useWorkbench();

  const [items, setItems] = useState<ApprovalItem[]>([]);
  const [nextCursor, setNextCursor] = useState<DueCursor | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({});

  // Batch confirmation modal state (digests fetched ONLY when user clicks batch approve)
  const [batchModalOpen, setBatchModalOpen] = useState(false);
  const [batchPreparing, setBatchPreparing] = useState(false);
  const [batchRows, setBatchRows] = useState<BatchPreparedRow[]>([]);
  const [batchSubmitting, setBatchSubmitting] = useState(false);
  const [batchSubmitError, setBatchSubmitError] = useState<ApiError | null>(
    null,
  );
  const [batchResults, setBatchResults] = useState<
    BatchApprovalResultItem[] | null
  >(null);

  const loadApprovals = useCallback(async () => {
    const startGen = getAuthGeneration();
    setLoading(true);
    setError(null);
    try {
      const page = await fetchWorkbenchApprovals({ limit: 30 });
      if (startGen !== getAuthGeneration()) return;
      setItems(page.items);
      setNextCursor(page.next);
      setAssignedCount(page.items.length);
      setSelectedIds({});
    } catch (err) {
      if (isStaleAuthError(err) || startGen !== getAuthGeneration()) return;
      if (isApiError(err)) {
        if (err.code === "ACCESS_CHANGED") {
          setItems([]);
          void handleAccessChanged();
        }
        setError(err);
      }
    } finally {
      if (startGen === getAuthGeneration()) setLoading(false);
    }
  }, [setAssignedCount, handleAccessChanged]);

  useEffect(() => {
    setItems([]);
    setNextCursor(null);
    setSelectedIds({});
    setBatchResults(null);
    setBatchModalOpen(false);
    void loadApprovals();
  }, [loadApprovals, authGeneration]);

  const handleLoadMore = async () => {
    if (!nextCursor) return;
    const startGen = getAuthGeneration();
    setLoadingMore(true);
    try {
      const page = await fetchWorkbenchApprovals({
        limit: 30,
        after_due: nextCursor.after_due,
        after_id: nextCursor.after_id,
      });
      if (startGen !== getAuthGeneration()) return;
      setItems((prev) => {
        const seen = new Set(prev.map((i) => i.id));
        return [...prev, ...page.items.filter((i) => !seen.has(i.id))];
      });
      setNextCursor(page.next);
    } catch (err) {
      if (isStaleAuthError(err) || startGen !== getAuthGeneration()) return;
      if (isApiError(err)) setError(err);
    } finally {
      if (startGen === getAuthGeneration()) setLoadingMore(false);
    }
  };

  const selectedList = useMemo(
    () => items.filter((item) => Boolean(selectedIds[item.id])),
    [items, selectedIds],
  );

  const allSelected = items.length > 0 && selectedList.length === items.length;

  const toggleAll = () => {
    if (allSelected) {
      setSelectedIds({});
      return;
    }
    const next: Record<string, boolean> = {};
    for (const item of items) next[item.id] = true;
    setSelectedIds(next);
  };

  // Fetch digests strictly on demand ONLY for user-checked proposals inside confirmation modal
  const openBatchConfirmModal = async () => {
    if (selectedList.length === 0) return;
    const startGen = getAuthGeneration();
    setBatchModalOpen(true);
    setBatchPreparing(true);
    setBatchSubmitError(null);
    setBatchResults(null);
    setBatchRows(
      selectedList.map((item) => ({ item, proposal: null, error: null })),
    );

    const prepared: BatchPreparedRow[] = [];
    for (const item of selectedList) {
      if (startGen !== getAuthGeneration()) return;
      try {
        const detail = await fetchProposalDetail(item.id);
        prepared.push({ item, proposal: detail, error: null });
      } catch (err) {
        if (isStaleAuthError(err)) return;
        prepared.push({
          item,
          proposal: null,
          error: isApiError(err) ? err.message : "无法读取提案摘要",
        });
      }
    }

    if (startGen !== getAuthGeneration()) return;
    setBatchRows(prepared);
    setBatchPreparing(false);
  };

  const executeBatchApprove = async () => {
    const validPayloads = batchRows
      .filter((row): row is BatchPreparedRow & { proposal: Proposal } =>
        Boolean(row.proposal),
      )
      .map((row) => ({
        proposal_id: row.proposal.id,
        digest: row.proposal.digest,
      }));
    if (validPayloads.length === 0) return;

    const startGen = getAuthGeneration();
    setBatchSubmitting(true);
    setBatchSubmitError(null);
    try {
      const res = await approveProposalsBatch(validPayloads);
      if (startGen !== getAuthGeneration()) return;
      setBatchResults(res.items);
      setBatchModalOpen(false);
      await loadApprovals();
    } catch (err) {
      if (isStaleAuthError(err) || startGen !== getAuthGeneration()) return;
      if (isApiError(err)) {
        if (err.code === "ACCESS_CHANGED") {
          setBatchModalOpen(false);
          void handleAccessChanged();
        }
        setBatchSubmitError(err);
      }
    } finally {
      if (startGen === getAuthGeneration()) setBatchSubmitting(false);
    }
  };

  const readyBatchCount = batchRows.filter((r) => r.proposal !== null).length;

  return (
    <div className="space-y-4" data-testid="workbench-approvals-module">
      <div className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-sheet)] overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--hairline)] bg-[var(--bg-subtle)] px-4 py-2.5">
          <div>
            <h2 className="text-[14px] font-semibold text-[var(--ink-primary)]">
              主管审批队列（GET /v1/workbench/approvals）
            </h2>
            <p className="text-[12px] text-[var(--ink-muted)]">
              按需加载详情与摘要锁，列表渲染零 N+1 请求；勾选多条后可核对摘要并批量批准入队。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {selectedList.length > 0 && (
              <Button
                size="sm"
                variant="primary"
                onClick={() => void openBatchConfirmModal()}
                data-testid="batch-approve-trigger-btn"
              >
                <ShieldCheck className="h-3.5 w-3.5" strokeWidth={1.75} />
                <span>批量批准已选 ({selectedList.length})</span>
              </Button>
            )}
            <Button
              size="sm"
              variant="secondary"
              loading={loading}
              onClick={() => void loadApprovals()}
              data-testid="approvals-refresh-btn"
            >
              <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} />
              <span>刷新审批列表</span>
            </Button>
          </div>
        </div>

        {error && (
          <div className="p-4">
            <AccessNoticeCard
              error={error}
              onRetry={() => void loadApprovals()}
            />
          </div>
        )}

        {!error && loading && items.length === 0 && (
          <div className="py-12 text-center text-[12.5px] text-[var(--ink-muted)]">
            正在加载待审批提案…
          </div>
        )}

        {!error && !loading && items.length === 0 && (
          <div
            className="flex flex-col items-center gap-2 py-12 text-center text-[13px] text-[var(--ink-muted)]"
            data-testid="approvals-empty-state"
          >
            <ClipboardCheck className="h-5 w-5 opacity-55" strokeWidth={1.5} />
            <span>当前授权仓库暂无待您审批的提案</span>
          </div>
        )}

        {items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-[12.5px]">
              <thead>
                <tr className="border-b border-[var(--hairline)] bg-[var(--bg-plane)] text-[11.5px] text-[var(--ink-muted)]">
                  <th className="w-10 px-3 py-2">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleAll}
                      aria-label="全选当前页待审批提案"
                      data-testid="approvals-select-all"
                      className="h-3.5 w-3.5 rounded-[2px] accent-[var(--accent)] cursor-pointer"
                    />
                  </th>
                  <th className="px-3 py-2 font-medium">提案编号</th>
                  <th className="px-3 py-2 font-medium">动作类型</th>
                  <th className="px-3 py-2 font-medium">站点</th>
                  <th className="px-3 py-2 font-medium">状态</th>
                  <th className="px-3 py-2 font-medium">审批有效期</th>
                  <th className="px-3 py-2 font-medium text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--hairline-subtle)]">
                {items.map((item) => {
                  const checked = Boolean(selectedIds[item.id]);
                  const expiry = formatRelativeCountdown(item.expires);
                  return (
                    <tr
                      key={item.id}
                      data-testid="approval-row"
                      data-proposal-id={item.id}
                      className={[
                        "transition-colors duration-[120ms]",
                        checked
                          ? "bg-[var(--accent-wash)]/60"
                          : "hover:bg-[var(--bg-subtle)]",
                      ].join(" ")}
                    >
                      <td className="px-3 py-2.5">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) =>
                            setSelectedIds((prev) => ({
                              ...prev,
                              [item.id]: e.target.checked,
                            }))
                          }
                          aria-label={`选择提案 ${item.id}`}
                          data-testid={`approval-select-${item.id}`}
                          className="h-3.5 w-3.5 rounded-[2px] accent-[var(--accent)] cursor-pointer"
                        />
                      </td>
                      <td className="px-3 py-2.5">
                        <Link
                          href={`/proposals/${encodeURIComponent(item.id)}`}
                          className="font-mono-code font-semibold text-[var(--ink-primary)] hover:text-[var(--accent)] hover:underline"
                        >
                          {item.id}
                        </Link>
                      </td>
                      <td className="px-3 py-2.5 text-[var(--ink-primary)]">
                        {formatProposalAction(item.action)}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="rounded-[2px] border border-[var(--hairline-strong)] bg-[var(--bg-subtle)] px-1.5 py-0.5 font-mono-code text-[11px] text-[var(--ink-secondary)]">
                          {item.warehouse}
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        <StatusBadge status={item.state} compact />
                      </td>
                      <td className="px-3 py-2.5 font-mono-code text-[12px]">
                        <div className="text-[var(--ink-primary)]">
                          {formatUnixTime(item.expires)}
                        </div>
                        <div
                          className={
                            expiry.dueSoon || expiry.expired
                              ? "text-[11px] font-semibold text-[var(--status-amber-ink)]"
                              : "text-[11px] text-[var(--ink-muted)]"
                          }
                        >
                          {expiry.label}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1.5">
                          <Button
                            size="sm"
                            variant="primary"
                            onClick={(e) =>
                              openDrawer(
                                {
                                  kind: "proposal",
                                  id: item.id,
                                  warehouse: item.warehouse,
                                  title: `审批核对 · ${item.id}`,
                                },
                                { tab: "current", trigger: e.currentTarget },
                              )
                            }
                            data-testid={`approval-inspect-${item.id}`}
                          >
                            <PanelRight className="h-3.5 w-3.5" />
                            <span>核对并审批</span>
                          </Button>
                          <Link
                            href={`/proposals/${encodeURIComponent(item.id)}`}
                            data-testid={`approval-open-link-${item.id}`}
                            className="inline-flex h-7 items-center gap-1 rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-2 text-[12px] font-medium text-[var(--ink-primary)] hover:bg-[var(--bg-subtle)]"
                          >
                            <span>详情页</span>
                            <ArrowUpRight className="h-3 w-3" />
                          </Link>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {nextCursor && (
          <div className="flex justify-center border-t border-[var(--hairline)] bg-[var(--bg-subtle)] px-4 py-2.5">
            <Button
              size="sm"
              variant="secondary"
              loading={loadingMore}
              onClick={() => void handleLoadMore()}
              data-testid="approvals-load-more"
            >
              加载更多待审批提案
            </Button>
          </div>
        )}
      </div>

      {/* Per-item Batch Approval Results */}
      {batchResults && (
        <div
          className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-sheet)] overflow-hidden"
          data-testid="batch-approve-results"
        >
          <div className="flex items-center justify-between border-b border-[var(--hairline)] bg-[var(--bg-plane)] px-4 py-2">
            <span className="font-mono-code text-[11px] uppercase tracking-[0.04em] text-[var(--ink-secondary)]">
              BATCH APPROVAL RESULTS · 批量审批逐项结果
            </span>
            <span className="font-mono-code text-[11.5px] text-[var(--ink-muted)]">
              成功 {batchResults.filter((r) => r.status === 202).length} / 共{" "}
              {batchResults.length}
            </span>
          </div>
          <div className="divide-y divide-[var(--hairline-subtle)]">
            {batchResults.map((res) => {
              const ok = res.status === 202;
              const detailText =
                typeof res.detail === "string"
                  ? res.detail
                  : typeof res.detail === "object" &&
                      res.detail !== null &&
                      "message" in res.detail &&
                      typeof (res.detail as { message?: unknown }).message ===
                        "string"
                    ? (res.detail as { message: string }).message
                    : res.status === 404
                      ? "当前账号无法访问这条记录。"
                      : res.status === 403
                        ? "无审批权限或不可自审批。"
                        : res.status === 409
                          ? "提案摘要、分派或状态已变更。"
                          : "";
              return (
                <div
                  key={res.proposal_id}
                  data-testid={`batch-result-${res.proposal_id}`}
                  className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-[12.5px]"
                >
                  <div className="flex items-center gap-2">
                    {ok ? (
                      <CheckCircle2
                        className="h-4 w-4 text-[var(--status-emerald)]"
                        strokeWidth={1.75}
                      />
                    ) : (
                      <XCircle
                        className="h-4 w-4 text-[var(--status-crimson)]"
                        strokeWidth={1.75}
                      />
                    )}
                    <Link
                      href={`/proposals/${encodeURIComponent(res.proposal_id)}`}
                      className="font-mono-code font-semibold text-[var(--ink-primary)] hover:underline"
                    >
                      {res.proposal_id}
                    </Link>
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className={[
                        "font-mono-code text-[11.5px] font-medium",
                        ok
                          ? "text-[var(--status-emerald)]"
                          : "text-[var(--status-crimson)]",
                      ].join(" ")}
                    >
                      {ok
                        ? "202 · 已批准并入队 (QUEUED)"
                        : `${res.status} · ${detailText}`}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Batch Approval Explicit Confirmation Modal */}
      <Modal
        open={batchModalOpen}
        onOpenChange={setBatchModalOpen}
        title={`批量批准确认（已选 ${selectedList.length} 条提案）`}
        subtitle="提交前已按需读取所选提案的最新权威摘要锁（Digest），逐条独立提交并互不阻塞。"
        size="lg"
        footer={
          <>
            <Button
              variant="secondary"
              disabled={batchSubmitting}
              onClick={() => setBatchModalOpen(false)}
            >
              取消
            </Button>
            <Button
              variant="primary"
              disabled={batchPreparing || readyBatchCount === 0}
              loading={batchSubmitting}
              onClick={() => void executeBatchApprove()}
              data-testid="batch-approve-confirm-btn"
            >
              确认批量批准 ({readyBatchCount})
            </Button>
          </>
        }
      >
        <div className="space-y-3" data-testid="batch-approve-modal">
          {batchPreparing ? (
            <div className="py-8 text-center text-[12.5px] text-[var(--ink-muted)]">
              正在获取已选提案的权威快照与摘要锁…
            </div>
          ) : (
            <div className="divide-y divide-[var(--hairline)] rounded-[4px] border border-[var(--hairline)]">
              {batchRows.map((row) => (
                <div key={row.item.id} className="p-3 text-[12px] space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono-code font-semibold text-[var(--ink-primary)]">
                      {row.item.id} · {row.item.warehouse}
                    </span>
                    <span className="font-mono-code text-[11px] text-[var(--ink-muted)]">
                      {row.proposal
                        ? `digest ${formatShortDigest(row.proposal.digest)}`
                        : "读取失败"}
                    </span>
                  </div>
                  {row.proposal ? (
                    <div className="text-[var(--ink-secondary)]">
                      {summarizePlanChange(row.proposal.plan)} · 发起人{" "}
                      <span className="font-mono-code">
                        {row.proposal.requester}
                      </span>
                    </div>
                  ) : (
                    <div className="text-[var(--status-crimson)]">
                      {row.error}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {batchSubmitError && <AccessNoticeCard error={batchSubmitError} />}
        </div>
      </Modal>
    </div>
  );
}
