"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  Check,
  CheckCircle2,
  ClipboardCheck,
  Copy,
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
import { formatShortDigest } from "@/lib/format";
import { useLocale } from "@/lib/i18n";
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

export interface ApprovalsModuleProps {
  onCountLoaded?: (count: number) => void;
}

export function ApprovalsModule({ onCountLoaded }: ApprovalsModuleProps = {}) {
  const {
    locale,
    t,
    tx,
    tp,
    formatDateTime,
    formatCountdown,
    localizeAction,
    localizeError,
  } = useLocale();
  const { authGeneration, handleAccessChanged } = useSession();
  const { openDrawer, setAssignedCount } = useWorkbench();

  const onCountLoadedRef = useRef(onCountLoaded);
  onCountLoadedRef.current = onCountLoaded;

  const [items, setItems] = useState<ApprovalItem[]>([]);
  const [nextCursor, setNextCursor] = useState<DueCursor | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

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
      onCountLoadedRef.current?.(page.items.length);
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

  const handleCopyId = async (id: string) => {
    try {
      await navigator.clipboard.writeText(id);
      setCopiedId(id);
      window.setTimeout(() => {
        setCopiedId((prev) => (prev === id ? null : prev));
      }, 1500);
    } catch {
      // Clipboard may be unavailable
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
          error: isApiError(err)
            ? localizeError(err)
            : tx({
                "zh-CN": "无法读取提案摘要",
                "zh-HK": "無法讀取提案摘要",
                en: "Unable to fetch proposal digest",
              }),
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
      <div className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--hairline)] px-5 py-4">
          <div>
            <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--ink-primary)]">
              {tx({
                "zh-CN": "主管审批队列",
                "zh-HK": "主管審批佇列",
                en: "Manager Approval Queue",
              })}
            </h2>
            <p className="mt-0.5 text-[12.5px] text-[var(--ink-muted)]">
              {tx({
                "zh-CN": "按需核对摘要并支持单笔或批量批准入队。",
                "zh-HK": "按需核對摘要並支援單筆或批次批准入隊。",
                en: "Verify digests on demand and approve single or selected proposals into the ERP queue.",
              })}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {selectedList.length > 0 && (
              <Button
                size="sm"
                pill
                variant="primary"
                onClick={() => void openBatchConfirmModal()}
                data-testid="batch-approve-trigger-btn"
              >
                <ShieldCheck className="h-3.5 w-3.5" strokeWidth={1.85} />
                <span>
                  {tx(
                    {
                      "zh-CN": "批量批准已选 ({count})",
                      "zh-HK": "批次批准已選 ({count})",
                      en: "Approve Selected ({count})",
                    },
                    { count: selectedList.length },
                  )}
                </span>
              </Button>
            )}
            <Button
              size="sm"
              pill
              variant="secondary"
              loading={loading}
              onClick={() => void loadApprovals()}
              data-testid="approvals-refresh-btn"
            >
              <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.85} />
              <span>
                {tx({
                  "zh-CN": "刷新审批列表",
                  "zh-HK": "重新整理審批清單",
                  en: "Refresh",
                })}
              </span>
            </Button>
          </div>
        </div>

        {error && (
          <div className="p-5">
            <AccessNoticeCard
              error={error}
              onRetry={() => void loadApprovals()}
            />
          </div>
        )}

        {!error && loading && items.length === 0 && (
          <div className="py-14 text-center text-[13px] text-[var(--ink-muted)]">
            {tx({
              "zh-CN": "正在加载待审批提案…",
              "zh-HK": "正在載入待審批提案…",
              en: "Loading pending proposals…",
            })}
          </div>
        )}

        {!error && !loading && items.length === 0 && (
          <div
            className="flex flex-col items-center gap-2.5 py-14 text-center text-[13px] text-[var(--ink-muted)]"
            data-testid="approvals-empty-state"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--bg-surface-subtle)] text-[var(--ink-muted)]">
              <ClipboardCheck className="h-5 w-5" strokeWidth={1.6} />
            </span>
            <span>
              {tx({
                "zh-CN": "当前授权仓库暂无待您审批的提案",
                "zh-HK": "目前授權倉庫暫無待您審批的提案",
                en: "No proposals awaiting your approval across authorized warehouses",
              })}
            </span>
          </div>
        )}

        {items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-[13px]">
              <thead>
                <tr className="border-b border-[var(--hairline-subtle)] bg-[var(--bg-surface-tint)] text-[11.5px] text-[var(--ink-muted)]">
                  <th className="w-11 px-4 py-2.5">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleAll}
                      aria-label={tx({
                        "zh-CN": "全选当前页待审批提案",
                        "zh-HK": "全選目前頁面待審批提案",
                        en: "Select all pending proposals on this page",
                      })}
                      data-testid="approvals-select-all"
                      className="h-4 w-4 rounded accent-[var(--accent)] cursor-pointer"
                    />
                  </th>
                  <th className="px-3.5 py-2.5 font-medium">
                    {tx({
                      "zh-CN": "审批单据",
                      "zh-HK": "審批單據",
                      en: "Proposal",
                    })}
                  </th>
                  <th className="px-3.5 py-2.5 font-medium">
                    {tx({ "zh-CN": "仓库", "zh-HK": "倉庫", en: "Warehouse" })}
                  </th>
                  <th className="px-3.5 py-2.5 font-medium">
                    {tx({ "zh-CN": "状态", "zh-HK": "狀態", en: "Status" })}
                  </th>
                  <th className="px-3.5 py-2.5 font-medium">
                    {tx({
                      "zh-CN": "审批有效期",
                      "zh-HK": "審批有效期",
                      en: "Expires",
                    })}
                  </th>
                  <th className="px-4 py-2.5 font-medium text-right">
                    {tx({ "zh-CN": "操作", "zh-HK": "操作", en: "Actions" })}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--hairline-subtle)]">
                {items.map((item) => {
                  const checked = Boolean(selectedIds[item.id]);
                  const expiry = formatCountdown(item.expires);
                  const shortId = formatShortDigest(item.id, 4, 4);
                  const actionLabel = localizeAction(item.action);
                  return (
                    <tr
                      key={item.id}
                      data-testid="approval-row"
                      data-proposal-id={item.id}
                      className={[
                        "group transition-colors duration-[160ms]",
                        checked
                          ? "bg-[var(--accent-wash)]/70"
                          : "hover:bg-[var(--bg-surface-tint)]/80",
                      ].join(" ")}
                    >
                      <td className="px-4 py-3.5">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) =>
                            setSelectedIds((prev) => ({
                              ...prev,
                              [item.id]: e.target.checked,
                            }))
                          }
                          aria-label={tx(
                            {
                              "zh-CN": "选择提案 {id}",
                              "zh-HK": "選擇提案 {id}",
                              en: "Select proposal {id}",
                            },
                            { id: item.id },
                          )}
                          data-testid={`approval-select-${item.id}`}
                          className="h-4 w-4 rounded accent-[var(--accent)] cursor-pointer"
                        />
                      </td>
                      <td className="px-3.5 py-3.5">
                        <div className="flex flex-col gap-0.5">
                          <Link
                            href={`/proposals/${encodeURIComponent(item.id)}`}
                            className="font-semibold text-[var(--ink-primary)] hover:text-[var(--accent)] transition-colors"
                          >
                            {actionLabel}
                          </Link>
                          <div className="inline-flex items-center gap-1 text-[11.5px] text-[var(--ink-muted)]">
                            <span
                              title={item.id}
                              className="font-mono-code tabular-nums"
                            >
                              {shortId}
                            </span>
                            <button
                              type="button"
                              onClick={() => void handleCopyId(item.id)}
                              title={tx(
                                {
                                  "zh-CN": "复制完整单号 {id}",
                                  "zh-HK": "複製完整單號 {id}",
                                  en: "Copy full ID {id}",
                                },
                                { id: item.id },
                              )}
                              aria-label={tx(
                                {
                                  "zh-CN": "复制单号 {id}",
                                  "zh-HK": "複製單號 {id}",
                                  en: "Copy ID {id}",
                                },
                                { id: item.id },
                              )}
                              className="inline-flex h-5 w-5 items-center justify-center rounded-full text-[var(--ink-muted)] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-[var(--bg-hover)] hover:text-[var(--ink-primary)] transition-all cursor-pointer"
                            >
                              {copiedId === item.id ? (
                                <Check className="h-3 w-3 text-[var(--status-emerald)]" />
                              ) : (
                                <Copy className="h-3 w-3" />
                              )}
                            </button>
                          </div>
                        </div>
                      </td>
                      <td className="px-3.5 py-3.5">
                        <span className="inline-flex items-center rounded-full bg-[var(--bg-surface-subtle)] px-2.5 py-0.5 font-mono-code text-[11px] font-medium text-[var(--ink-secondary)]">
                          {item.warehouse}
                        </span>
                      </td>
                      <td className="px-3.5 py-3.5">
                        <StatusBadge status={item.state} compact />
                      </td>
                      <td className="px-3.5 py-3.5 tabular-nums text-[12px]">
                        <div className="font-mono-code text-[var(--ink-primary)]">
                          {formatDateTime(item.expires)}
                        </div>
                        <div
                          className={
                            expiry.dueSoon || expiry.expired
                              ? "mt-0.5 text-[11px] font-semibold text-[var(--status-amber-ink)]"
                              : "mt-0.5 text-[11px] text-[var(--ink-muted)]"
                          }
                        >
                          {expiry.label}
                        </div>
                      </td>
                      <td className="px-4 py-3.5 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1.5">
                          <Button
                            size="sm"
                            pill
                            variant="quiet"
                            onClick={(e) =>
                              openDrawer(
                                {
                                  kind: "proposal",
                                  id: item.id,
                                  warehouse: item.warehouse,
                                  title: tx(
                                    {
                                      "zh-CN": "审批核对 · {id}",
                                      "zh-HK": "審批核對 · {id}",
                                      en: "Approval Review · {id}",
                                    },
                                    { id: shortId },
                                  ),
                                },
                                { tab: "current", trigger: e.currentTarget },
                              )
                            }
                            data-testid={`approval-inspect-${item.id}`}
                          >
                            <PanelRight className="h-3.5 w-3.5" />
                            <span>
                              {tx({
                                "zh-CN": "核对并审批",
                                "zh-HK": "核對並審批",
                                en: "Review & Approve",
                              })}
                            </span>
                          </Button>
                          <Link
                            href={`/proposals/${encodeURIComponent(item.id)}`}
                            data-testid={`approval-open-link-${item.id}`}
                            className="inline-flex h-8 items-center gap-1 rounded-full bg-[var(--bg-surface-subtle)] px-3 text-[12px] font-medium text-[var(--ink-primary)] hover:bg-[var(--bg-hover)] hover:text-[var(--accent)] transition-colors duration-[150ms]"
                          >
                            <span>
                              {tx({
                                "zh-CN": "详情页",
                                "zh-HK": "詳情頁",
                                en: "Open Page",
                              })}
                            </span>
                            <ArrowUpRight className="h-3.5 w-3.5" />
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
          <div className="flex justify-center border-t border-[var(--hairline-subtle)] bg-[var(--bg-surface-tint)] px-5 py-3">
            <Button
              size="sm"
              pill
              variant="secondary"
              loading={loadingMore}
              onClick={() => void handleLoadMore()}
              data-testid="approvals-load-more"
            >
              {tx({
                "zh-CN": "加载更多待审批提案",
                "zh-HK": "載入更多待審批提案",
                en: "Load More Approvals",
              })}
            </Button>
          </div>
        )}
      </div>

      {/* Per-item Batch Approval Results */}
      {batchResults && (
        <div
          className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] overflow-hidden"
          data-testid="batch-approve-results"
        >
          <div className="flex items-center justify-between border-b border-[var(--hairline)] px-5 py-3.5">
            <span className="text-[13.5px] font-semibold text-[var(--ink-primary)]">
              {tx({
                "zh-CN": "批量审批逐项结果",
                "zh-HK": "批次審批逐項結果",
                en: "Batch Approval Results",
              })}
            </span>
            <span className="rounded-full bg-[var(--bg-surface-subtle)] px-2.5 py-0.5 tabular-nums text-[11.5px] text-[var(--ink-secondary)]">
              {tx(
                {
                  "zh-CN": "成功 {ok} / 共 {total}",
                  "zh-HK": "成功 {ok} / 共 {total}",
                  en: "{ok} of {total} succeeded",
                },
                {
                  ok: batchResults.filter((r) => r.status === 202).length,
                  total: batchResults.length,
                },
              )}
            </span>
          </div>
          <div className="divide-y divide-[var(--hairline-subtle)]">
            {batchResults.map((res) => {
              const ok = res.status === 202;
              const rawMsg =
                typeof res.detail === "string"
                  ? res.detail
                  : typeof res.detail === "object" &&
                      res.detail !== null &&
                      "message" in res.detail &&
                      typeof (res.detail as { message?: unknown }).message ===
                        "string"
                    ? (res.detail as { message: string }).message
                    : "";
              const detailText =
                res.status === 404
                  ? t("notice.recordUnavailable.message")
                  : res.status === 403
                    ? tx({
                        "zh-CN": "无审批权限或不可自审批。",
                        "zh-HK": "無審批權限或不可自審批。",
                        en: "Not authorized or self-approval blocked.",
                      })
                    : res.status === 409
                      ? tx({
                          "zh-CN": "提案摘要、分派或状态已变更。",
                          "zh-HK": "提案摘要、分派或狀態已變更。",
                          en: "Proposal digest, assignment, or state changed.",
                        })
                      : rawMsg ||
                        localizeError({
                          status: res.status,
                          rawDetail: res.detail,
                        });
              return (
                <div
                  key={res.proposal_id}
                  data-testid={`batch-result-${res.proposal_id}`}
                  className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-[13px]"
                >
                  <div className="flex items-center gap-2.5">
                    {ok ? (
                      <CheckCircle2
                        className="h-4 w-4 text-[var(--status-emerald)]"
                        strokeWidth={1.85}
                      />
                    ) : (
                      <XCircle
                        className="h-4 w-4 text-[var(--status-crimson)]"
                        strokeWidth={1.85}
                      />
                    )}
                    <Link
                      href={`/proposals/${encodeURIComponent(res.proposal_id)}`}
                      title={res.proposal_id}
                      className="font-mono-code font-semibold text-[var(--ink-primary)] hover:text-[var(--accent)] transition-colors"
                    >
                      {formatShortDigest(res.proposal_id, 6, 4)}
                    </Link>
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className={[
                        "rounded-full px-2.5 py-0.5 text-[11.5px] font-medium",
                        ok
                          ? "bg-[var(--status-emerald-wash)] text-[var(--status-emerald)]"
                          : "bg-[var(--status-crimson-wash)] text-[var(--status-crimson)]",
                      ].join(" ")}
                    >
                      {ok
                        ? tx({
                            "zh-CN": "已批准并入队",
                            "zh-HK": "已批准並入隊",
                            en: "Approved & Queued",
                          })
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
        title={tp(
          {
            "zh-CN": "批量批准确认（已选 {count} 条提案）",
            "zh-HK": "批次批准確認（已選 {count} 筆提案）",
            en: {
              one: "Confirm Batch Approval ({count} proposal)",
              other: "Confirm Batch Approval ({count} proposals)",
            },
          },
          selectedList.length,
        )}
        subtitle={tx({
          "zh-CN":
            "提交前已按需读取所选提案的最新权威摘要锁，逐条独立提交并互不阻塞。",
          "zh-HK":
            "提交前已按需讀取所選提案的最新權威摘要鎖，逐筆獨立提交並互不阻塞。",
          en: "Latest authoritative digests were fetched on demand; each proposal is committed independently.",
        })}
        size="lg"
        footer={
          <>
            <Button
              variant="secondary"
              disabled={batchSubmitting}
              onClick={() => setBatchModalOpen(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={batchPreparing || readyBatchCount === 0}
              loading={batchSubmitting}
              onClick={() => void executeBatchApprove()}
              data-testid="batch-approve-confirm-btn"
            >
              {tx(
                {
                  "zh-CN": "确认批量批准 ({count})",
                  "zh-HK": "確認批次批准 ({count})",
                  en: "Confirm Batch Approve ({count})",
                },
                { count: readyBatchCount },
              )}
            </Button>
          </>
        }
      >
        <div className="space-y-3" data-testid="batch-approve-modal">
          {batchPreparing ? (
            <div className="py-8 text-center text-[13px] text-[var(--ink-muted)]">
              {tx({
                "zh-CN": "正在获取已选提案的权威快照与摘要锁…",
                "zh-HK": "正在取得已選提案的權威快照與摘要鎖…",
                en: "Fetching authoritative snapshots and digest locks…",
              })}
            </div>
          ) : (
            <div className="divide-y divide-[var(--hairline-subtle)] rounded-tile bg-[var(--bg-surface-tint)] overflow-hidden">
              {batchRows.map((row) => (
                <div key={row.item.id} className="p-3.5 text-[12.5px] space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span
                      title={row.item.id}
                      className="font-mono-code font-semibold text-[var(--ink-primary)]"
                    >
                      {formatShortDigest(row.item.id, 6, 4)} ·{" "}
                      {row.item.warehouse}
                    </span>
                    <span
                      className={[
                        "rounded-full bg-[var(--bg-surface)] px-2 py-0.5 text-[11px] text-[var(--ink-muted)] shadow-[var(--shadow-subtle)]",
                        row.proposal ? "font-mono-code" : "",
                      ].join(" ")}
                    >
                      {row.proposal
                        ? formatShortDigest(row.proposal.digest)
                        : tx({
                            "zh-CN": "读取失败",
                            "zh-HK": "讀取失敗",
                            en: "Load failed",
                          })}
                    </span>
                  </div>
                  {row.proposal ? (
                    <div className="text-[var(--ink-secondary)]">
                      {summarizePlanChange(row.proposal.plan, locale)} ·{" "}
                      {tx({
                        "zh-CN": "发起人",
                        "zh-HK": "發起人",
                        en: "Requester",
                      })}{" "}
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
