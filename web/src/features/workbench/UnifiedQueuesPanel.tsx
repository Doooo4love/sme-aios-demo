"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  Inbox,
  PanelRight,
  RefreshCw,
} from "lucide-react";
import {
  fetchTasks,
  getAuthGeneration,
  isApiError,
  isStaleAuthError,
  type ApiError,
} from "@/lib/api-client";
import {
  formatProposalAction,
  formatRelativeCountdown,
  formatUnixTime,
} from "@/lib/format";
import { useSession } from "@/lib/session-context";
import { useWorkbench } from "@/lib/workbench-context";
import { AccessNoticeCard } from "@/components/ui/AccessNoticeCard";
import { Button } from "@/components/ui/Button";
import { StatusBadge } from "@/components/ui/StatusBadge";
import type { DueCursor, TaskItem } from "@/lib/types";
import { consolidateTaskItems } from "@/features/workbench/types";

type QueueSubView = "assigned" | "submitted" | "unified";

export interface UnifiedQueuesPanelProps {
  /** Optional filter to restrict shown action type (used by Orders module) */
  actionFilter?: TaskItem["action"];
  defaultView?: QueueSubView;
  compactHeader?: boolean;
}

export function UnifiedQueuesPanel({
  actionFilter,
  defaultView,
  compactHeader = false,
}: UnifiedQueuesPanelProps) {
  const { actor, capabilities, authGeneration, handleAccessChanged } =
    useSession();
  const { openDrawer, setAssignedCount } = useWorkbench();

  const hasApprovalRole = useMemo(() => {
    if (!actor || !capabilities) return false;
    const sites = [
      ...(capabilities.approval_warehouses["sales_order.create_draft"] ?? []),
      ...(capabilities.approval_warehouses["shipment.reschedule"] ?? []),
    ];
    return (
      (actor.role === "manager" || actor.role === "admin") && sites.length > 0
    );
  }, [actor, capabilities]);

  const [subView, setSubView] = useState<QueueSubView>(
    defaultView ?? (hasApprovalRole ? "assigned" : "submitted"),
  );
  const [warehouseFilter, setWarehouseFilter] = useState<string>("ALL");

  const [assignedItems, setAssignedItems] = useState<TaskItem[]>([]);
  const [assignedNext, setAssignedNext] = useState<DueCursor | null>(null);
  const [submittedItems, setSubmittedItems] = useState<TaskItem[]>([]);
  const [submittedNext, setSubmittedNext] = useState<DueCursor | null>(null);

  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!defaultView) {
      setSubView(hasApprovalRole ? "assigned" : "submitted");
    }
  }, [hasApprovalRole, defaultView, authGeneration]);

  const loadInitialQueues = useCallback(async () => {
    const startGen = getAuthGeneration();
    setLoading(true);
    setError(null);
    try {
      const [assignedRes, submittedRes] = await Promise.all([
        fetchTasks("assigned", { limit: 25 }),
        fetchTasks("submitted", { limit: 25 }),
      ]);
      if (startGen !== getAuthGeneration()) return;
      setAssignedItems(assignedRes.items);
      setAssignedNext(assignedRes.next);
      setSubmittedItems(submittedRes.items);
      setSubmittedNext(submittedRes.next);
      if (!actionFilter) {
        setAssignedCount(assignedRes.items.length);
      }
    } catch (err) {
      if (isStaleAuthError(err) || startGen !== getAuthGeneration()) return;
      if (isApiError(err)) {
        if (err.code === "ACCESS_CHANGED") {
          setAssignedItems([]);
          setSubmittedItems([]);
          void handleAccessChanged();
        }
        setError(err);
      }
    } finally {
      if (startGen === getAuthGeneration()) setLoading(false);
    }
  }, [actionFilter, setAssignedCount, handleAccessChanged]);

  useEffect(() => {
    setAssignedItems([]);
    setSubmittedItems([]);
    setAssignedNext(null);
    setSubmittedNext(null);
    setExpandedIds({});
    void loadInitialQueues();
  }, [loadInitialQueues, authGeneration]);

  const handleLoadMore = async (lane: "assigned" | "submitted") => {
    const cursor = lane === "assigned" ? assignedNext : submittedNext;
    if (!cursor) return;
    const startGen = getAuthGeneration();
    setLoadingMore(true);
    try {
      const res = await fetchTasks(lane, {
        limit: 25,
        after_due: cursor.after_due,
        after_id: cursor.after_id,
      });
      if (startGen !== getAuthGeneration()) return;
      if (lane === "assigned") {
        setAssignedItems((prev) => {
          const seen = new Set(prev.map((i) => i.id));
          return [...prev, ...res.items.filter((i) => !seen.has(i.id))];
        });
        setAssignedNext(res.next);
      } else {
        setSubmittedItems((prev) => {
          const seen = new Set(prev.map((i) => i.id));
          return [...prev, ...res.items.filter((i) => !seen.has(i.id))];
        });
        setSubmittedNext(res.next);
      }
    } catch (err) {
      if (isStaleAuthError(err) || startGen !== getAuthGeneration()) return;
      if (isApiError(err)) setError(err);
    } finally {
      if (startGen === getAuthGeneration()) setLoadingMore(false);
    }
  };

  const filteredAssigned = useMemo(() => {
    return assignedItems.filter((item) => {
      if (actionFilter && item.action !== actionFilter) return false;
      if (warehouseFilter !== "ALL" && item.warehouse !== warehouseFilter) {
        return false;
      }
      return true;
    });
  }, [assignedItems, actionFilter, warehouseFilter]);

  const filteredSubmitted = useMemo(() => {
    return submittedItems.filter((item) => {
      if (actionFilter && item.action !== actionFilter) return false;
      if (warehouseFilter !== "ALL" && item.warehouse !== warehouseFilter) {
        return false;
      }
      return true;
    });
  }, [submittedItems, actionFilter, warehouseFilter]);

  const displayedRows = useMemo(() => {
    if (subView === "assigned") {
      return consolidateTaskItems(filteredAssigned, [], actor?.subject);
    }
    if (subView === "submitted") {
      return consolidateTaskItems([], filteredSubmitted, actor?.subject);
    }
    return consolidateTaskItems(
      filteredAssigned,
      filteredSubmitted,
      actor?.subject,
    );
  }, [subView, filteredAssigned, filteredSubmitted, actor?.subject]);

  const knownWarehouses = useMemo(() => {
    const set = new Set<string>(actor?.warehouses ?? []);
    for (const i of assignedItems) set.add(i.warehouse);
    for (const i of submittedItems) set.add(i.warehouse);
    return Array.from(set).sort();
  }, [actor?.warehouses, assignedItems, submittedItems]);

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const hasMoreForActiveView =
    (subView === "assigned" && assignedNext !== null) ||
    (subView === "submitted" && submittedNext !== null) ||
    (subView === "unified" && (assignedNext !== null || submittedNext !== null));

  return (
    <div
      className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-sheet)] overflow-hidden"
      data-testid="workbench-unified-queues"
    >
      {/* Toolbar: Lane Switcher + Warehouse Filter + Refresh */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--hairline)] bg-[var(--bg-subtle)] px-4 py-2.5">
        <div
          role="tablist"
          aria-label="任务队列视图"
          className="flex flex-wrap items-center gap-1"
        >
          {(
            [
              {
                id: "assigned" as const,
                label: "待我处理",
                count: filteredAssigned.length,
                testId: "queue-lane-assigned",
              },
              {
                id: "submitted" as const,
                label: "已提交",
                count: filteredSubmitted.length,
                testId: "queue-lane-submitted",
              },
              {
                id: "unified" as const,
                label: "合并视角",
                count: consolidateTaskItems(
                  filteredAssigned,
                  filteredSubmitted,
                  actor?.subject,
                ).length,
                testId: "queue-lane-unified",
              },
            ] as const
          ).map((tab) => {
            const active = subView === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={active}
                data-testid={tab.testId}
                onClick={() => setSubView(tab.id)}
                className={[
                  "inline-flex h-8 items-center gap-1.5 rounded-[4px] border px-3 text-[12.5px] font-medium transition-colors duration-[120ms] cursor-pointer",
                  active
                    ? "border-[var(--accent-border)] bg-[var(--accent-wash)] text-[var(--accent)]"
                    : "border-transparent text-[var(--ink-secondary)] hover:bg-[var(--bg-plane)] hover:text-[var(--ink-primary)]",
                ].join(" ")}
              >
                <span>{tab.label}</span>
                <span className="font-mono-code text-[11px] opacity-80">
                  {tab.count}
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {!compactHeader && knownWarehouses.length > 1 && (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setWarehouseFilter("ALL")}
                className={[
                  "h-7 rounded-[4px] border px-2 font-mono-code text-[11px] cursor-pointer",
                  warehouseFilter === "ALL"
                    ? "border-[var(--accent-border)] bg-[var(--accent-wash)] text-[var(--accent)]"
                    : "border-[var(--hairline-strong)] bg-[var(--bg-sheet)] text-[var(--ink-muted)] hover:text-[var(--ink-primary)]",
                ].join(" ")}
              >
                全部站点
              </button>
              {knownWarehouses.map((wh) => (
                <button
                  key={wh}
                  type="button"
                  onClick={() => setWarehouseFilter(wh)}
                  className={[
                    "h-7 rounded-[4px] border px-2 font-mono-code text-[11px] cursor-pointer",
                    warehouseFilter === wh
                      ? "border-[var(--accent-border)] bg-[var(--accent-wash)] text-[var(--accent)]"
                      : "border-[var(--hairline-strong)] bg-[var(--bg-sheet)] text-[var(--ink-muted)] hover:text-[var(--ink-primary)]",
                  ].join(" ")}
                >
                  {wh}
                </button>
              ))}
            </div>
          )}

          <Button
            size="sm"
            variant="secondary"
            loading={loading}
            onClick={() => void loadInitialQueues()}
            data-testid="queue-refresh-btn"
          >
            <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} />
            <span>刷新队列</span>
          </Button>
        </div>
      </div>

      {error && (
        <div className="p-4">
          <AccessNoticeCard
            error={error}
            onRetry={() => void loadInitialQueues()}
          />
        </div>
      )}

      {!error && loading && displayedRows.length === 0 && (
        <div className="py-12 text-center text-[12.5px] text-[var(--ink-muted)]">
          正在加载当前授权范围内的业务队列…
        </div>
      )}

      {!error && !loading && displayedRows.length === 0 && (
        <div
          className="flex flex-col items-center gap-2 py-12 text-center text-[13px] text-[var(--ink-muted)]"
          data-testid="queue-empty-state"
        >
          <Inbox className="h-5 w-5 opacity-55" strokeWidth={1.5} />
          <span>
            {subView === "assigned"
              ? hasApprovalRole
                ? "当前没有待您审批的业务单据"
                : "当前账号无待审批任务（普通经办或只读岗位可切换至「已提交」查看）"
              : "当前条件下暂无单据记录"}
          </span>
        </div>
      )}

      {displayedRows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-[12.5px]">
            <thead>
              <tr className="border-b border-[var(--hairline)] bg-[var(--bg-plane)] text-[11.5px] text-[var(--ink-muted)]">
                <th className="w-8 px-2 py-2" aria-label="展开明细" />
                <th className="px-3 py-2 font-medium">单据编号 / 类型</th>
                <th className="px-3 py-2 font-medium">站点</th>
                <th className="px-3 py-2 font-medium">轮到我的原因</th>
                <th className="px-3 py-2 font-medium">状态</th>
                <th className="px-3 py-2 font-medium">下一步</th>
                <th className="px-3 py-2 font-medium text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--hairline-subtle)]">
              {displayedRows.map((row) => {
                const expanded = Boolean(expandedIds[row.id]);
                const expiry = formatRelativeCountdown(row.expires);
                const isDueSoon =
                  row.state === "PROPOSED" && (expiry.dueSoon || expiry.expired);
                const badgeStatus =
                  row.state === "REJECTED" && row.decision === "returned"
                    ? "returned"
                    : row.state;

                return (
                  <React.Fragment key={row.id}>
                    <tr
                      data-testid="queue-row"
                      data-proposal-id={row.id}
                      className="hover:bg-[var(--bg-subtle)] transition-colors duration-[120ms]"
                    >
                      <td className="px-2 py-2.5 align-top">
                        <button
                          type="button"
                          onClick={() => toggleExpand(row.id)}
                          aria-expanded={expanded}
                          aria-label={`展开 ${row.id} 时间与阶段详情`}
                          data-testid={`queue-expand-${row.id}`}
                          className="inline-flex h-6 w-6 items-center justify-center rounded-[4px] text-[var(--ink-muted)] hover:bg-[var(--bg-plane)] hover:text-[var(--ink-primary)] cursor-pointer"
                        >
                          {expanded ? (
                            <ChevronDown className="h-3.5 w-3.5" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5" />
                          )}
                        </button>
                      </td>
                      <td className="px-3 py-2.5 align-top">
                        <div className="flex flex-col gap-0.5">
                          <Link
                            href={`/proposals/${encodeURIComponent(row.id)}`}
                            className="font-mono-code font-semibold text-[var(--ink-primary)] hover:text-[var(--accent)] hover:underline"
                          >
                            {row.id}
                          </Link>
                          <span className="text-[11.5px] text-[var(--ink-muted)]">
                            {formatProposalAction(row.action)}
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 align-top">
                        <span className="rounded-[2px] border border-[var(--hairline-strong)] bg-[var(--bg-subtle)] px-1.5 py-0.5 font-mono-code text-[11px] text-[var(--ink-secondary)]">
                          {row.warehouse}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 align-top">
                        <div className="text-[var(--ink-primary)]">
                          {row.primaryReason}
                        </div>
                        {/* Dual-Hat Consolidation: render per-hat sub-statuses inside ONE unified row */}
                        {row.hats.length > 1 && (
                          <div
                            className="mt-1.5 space-y-1 border-t border-[var(--hairline-subtle)] pt-1.5"
                            data-testid="queue-dual-hat-substatuses"
                          >
                            {row.hats.map((hat) => (
                              <div
                                key={`${row.id}-${hat.lane}`}
                                className="flex items-center gap-2 text-[11.5px]"
                              >
                                <span className="rounded-[2px] border border-[var(--hairline-strong)] bg-[var(--bg-plane)] px-1 py-0.5 font-mono-code text-[10px] text-[var(--ink-secondary)]">
                                  {hat.roleLabel}
                                </span>
                                <span className="text-[var(--ink-muted)]">
                                  {hat.subStatus}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2.5 align-top">
                        <StatusBadge status={badgeStatus} compact />
                        {isDueSoon && (
                          <div className="mt-1 font-mono-code text-[11px] font-medium text-[var(--status-amber-ink)]">
                            {expiry.label}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2.5 align-top text-[12px] text-[var(--ink-secondary)]">
                        {row.primaryNextStep}
                      </td>
                      <td className="px-3 py-2.5 align-top text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1.5">
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={(e) =>
                              openDrawer(
                                {
                                  kind: "proposal",
                                  id: row.id,
                                  warehouse: row.warehouse,
                                  title: `${formatProposalAction(row.action)} · ${row.id}`,
                                },
                                { tab: "current", trigger: e.currentTarget },
                              )
                            }
                            data-testid={`queue-inspect-${row.id}`}
                          >
                            <PanelRight className="h-3.5 w-3.5" />
                            <span>面板核对</span>
                          </Button>
                          <Link
                            href={`/proposals/${encodeURIComponent(row.id)}`}
                            className="inline-flex h-7 items-center gap-1 rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-2 text-[12px] font-medium text-[var(--ink-primary)] hover:bg-[var(--bg-subtle)]"
                          >
                            <span>详情</span>
                            <ArrowUpRight className="h-3 w-3" />
                          </Link>
                        </div>
                      </td>
                    </tr>

                    {/* Expandable Inline Metadata Row */}
                    {expanded && (
                      <tr
                        className="bg-[var(--bg-subtle)]"
                        data-testid={`queue-expanded-${row.id}`}
                      >
                        <td colSpan={7} className="px-4 py-2.5">
                          <div className="grid grid-cols-1 gap-2 sm:grid-cols-4 text-[12px]">
                            <div>
                              <span className="text-[var(--ink-muted)]">
                                计划/到期时间：
                              </span>
                              <span
                                className={[
                                  "font-mono-code tabular-nums font-medium",
                                  isDueSoon
                                    ? "text-[var(--status-amber-ink)]"
                                    : "text-[var(--ink-primary)]",
                                ].join(" ")}
                              >
                                {formatUnixTime(row.expires, {
                                  withSeconds: true,
                                })}
                              </span>
                            </div>
                            <div>
                              <span className="text-[var(--ink-muted)]">
                                责任阶段：
                              </span>
                              <span className="font-medium text-[var(--ink-primary)]">
                                {row.hats.map((h) => h.roleLabel).join(" / ")}
                              </span>
                            </div>
                            <div>
                              <span className="text-[var(--ink-muted)]">
                                当前指派：
                              </span>
                              <span className="font-mono-code text-[var(--ink-primary)]">
                                {row.assigned_to ?? "未指定"}
                              </span>
                            </div>
                            <div>
                              <span className="text-[var(--ink-muted)]">
                                更新 / 队列时间 (due)：
                              </span>
                              <span className="font-mono-code tabular-nums text-[var(--ink-primary)]">
                                {formatUnixTime(row.due, { withSeconds: true })}
                              </span>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Dual-Cursor Pagination Footer */}
      {hasMoreForActiveView && (
        <div className="flex items-center justify-center gap-2 border-t border-[var(--hairline)] bg-[var(--bg-subtle)] px-4 py-2.5">
          {(subView === "assigned" || subView === "unified") && assignedNext && (
            <Button
              size="sm"
              variant="secondary"
              loading={loadingMore}
              onClick={() => void handleLoadMore("assigned")}
              data-testid="queue-load-more-assigned"
            >
              加载更多待我处理
            </Button>
          )}
          {(subView === "submitted" || subView === "unified") &&
            submittedNext && (
              <Button
                size="sm"
                variant="secondary"
                loading={loadingMore}
                onClick={() => void handleLoadMore("submitted")}
                data-testid="queue-load-more-submitted"
              >
                加载更多已提交
              </Button>
            )}
        </div>
      )}
    </div>
  );
}
