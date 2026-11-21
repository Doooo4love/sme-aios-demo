"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
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
  formatShortDigest,
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
  onCountsLoaded?: (counts: { assigned: number; submitted: number }) => void;
}

export function UnifiedQueuesPanel({
  actionFilter,
  defaultView,
  compactHeader = false,
  onCountsLoaded,
}: UnifiedQueuesPanelProps) {
  const { actor, capabilities, authGeneration, handleAccessChanged } =
    useSession();
  const { openDrawer, setAssignedCount } = useWorkbench();

  const onCountsLoadedRef = useRef(onCountsLoaded);
  onCountsLoadedRef.current = onCountsLoaded;

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
  const [copiedId, setCopiedId] = useState<string | null>(null);

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
        onCountsLoadedRef.current?.({
          assigned: assignedRes.items.length,
          submitted: submittedRes.items.length,
        });
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

  const handleCopyId = async (id: string) => {
    try {
      await navigator.clipboard.writeText(id);
      setCopiedId(id);
      window.setTimeout(() => {
        setCopiedId((prev) => (prev === id ? null : prev));
      }, 1500);
    } catch {
      // Clipboard may be unavailable in headless contexts
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

  const unifiedCount = useMemo(
    () =>
      consolidateTaskItems(filteredAssigned, filteredSubmitted, actor?.subject)
        .length,
    [filteredAssigned, filteredSubmitted, actor?.subject],
  );

  return (
    <div
      className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] overflow-hidden"
      data-testid="workbench-unified-queues"
    >
      {/* Toolbar: Segmented Lane Switcher + Warehouse Filter Pills + Refresh */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--hairline)] px-5 py-3.5">
        <div
          role="tablist"
          aria-label="任务队列视图"
          className="inline-flex flex-wrap items-center gap-1 rounded-full bg-[var(--bg-surface-subtle)] p-1"
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
                count: unifiedCount,
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
                  "inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[12.5px] transition-all duration-[165ms] cursor-pointer",
                  active
                    ? "bg-[var(--bg-surface)] text-[var(--accent)] font-semibold shadow-[var(--shadow-subtle)]"
                    : "text-[var(--ink-secondary)] font-medium hover:text-[var(--ink-primary)]",
                ].join(" ")}
              >
                <span>{tab.label}</span>
                <span className="font-mono-code tabular-nums text-[11px] opacity-80">
                  {tab.count}
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {!compactHeader && knownWarehouses.length > 1 && (
            <div className="flex flex-wrap items-center gap-1 rounded-full bg-[var(--bg-surface-tint)] p-1">
              <button
                type="button"
                onClick={() => setWarehouseFilter("ALL")}
                className={[
                  "h-7 rounded-full px-2.5 text-[11.5px] font-medium transition-all duration-[150ms] cursor-pointer",
                  warehouseFilter === "ALL"
                    ? "bg-[var(--accent-wash)] text-[var(--accent)] font-semibold"
                    : "text-[var(--ink-muted)] hover:text-[var(--ink-primary)]",
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
                    "h-7 rounded-full px-2.5 font-mono-code text-[11px] font-medium transition-all duration-[150ms] cursor-pointer",
                    warehouseFilter === wh
                      ? "bg-[var(--accent-wash)] text-[var(--accent)] font-semibold"
                      : "text-[var(--ink-muted)] hover:text-[var(--ink-primary)]",
                  ].join(" ")}
                >
                  {wh}
                </button>
              ))}
            </div>
          )}

          <Button
            size="sm"
            pill
            variant="secondary"
            loading={loading}
            onClick={() => void loadInitialQueues()}
            data-testid="queue-refresh-btn"
          >
            <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.85} />
            <span>刷新队列</span>
          </Button>
        </div>
      </div>

      {error && (
        <div className="p-5">
          <AccessNoticeCard
            error={error}
            onRetry={() => void loadInitialQueues()}
          />
        </div>
      )}

      {!error && loading && displayedRows.length === 0 && (
        <div className="py-14 text-center text-[13px] text-[var(--ink-muted)]">
          正在加载当前授权范围内的业务队列…
        </div>
      )}

      {!error && !loading && displayedRows.length === 0 && (
        <div
          className="flex flex-col items-center gap-2.5 py-14 text-center text-[13px] text-[var(--ink-muted)]"
          data-testid="queue-empty-state"
        >
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--bg-surface-subtle)] text-[var(--ink-faint)]">
            <Inbox className="h-5 w-5" strokeWidth={1.6} />
          </span>
          <span>
            {subView === "assigned"
              ? hasApprovalRole
                ? "当前没有待您审批的业务单据"
                : "当前账号无待审批任务（经办或只读岗位可切换至「已提交」查看）"
              : "当前条件下暂无单据记录"}
          </span>
        </div>
      )}

      {displayedRows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-[13px]">
            <thead>
              <tr className="border-b border-[var(--hairline-subtle)] bg-[var(--bg-surface-tint)] text-[11.5px] text-[var(--ink-muted)]">
                <th className="w-10 px-3 py-2.5" aria-label="展开明细" />
                <th className="px-3.5 py-2.5 font-medium">业务单据</th>
                <th className="px-3.5 py-2.5 font-medium">站点</th>
                <th className="px-3.5 py-2.5 font-medium">轮到我的原因</th>
                <th className="px-3.5 py-2.5 font-medium">状态</th>
                <th className="px-3.5 py-2.5 font-medium">下一步</th>
                <th className="px-4 py-2.5 font-medium text-right">操作</th>
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
                const shortId = formatShortDigest(row.id, 4, 4);

                return (
                  <React.Fragment key={row.id}>
                    <tr
                      data-testid="queue-row"
                      data-proposal-id={row.id}
                      className="group hover:bg-[var(--bg-surface-tint)]/80 transition-colors duration-[160ms]"
                    >
                      <td className="px-3 py-3.5 align-top">
                        <button
                          type="button"
                          onClick={() => toggleExpand(row.id)}
                          aria-expanded={expanded}
                          aria-label={`展开 ${row.id} 时间与阶段详情`}
                          data-testid={`queue-expand-${row.id}`}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-full text-[var(--ink-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--ink-primary)] transition-colors cursor-pointer"
                        >
                          {expanded ? (
                            <ChevronDown className="h-3.5 w-3.5" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5" />
                          )}
                        </button>
                      </td>
                      <td className="px-3.5 py-3.5 align-top">
                        <div className="flex flex-col gap-0.5">
                          <Link
                            href={`/proposals/${encodeURIComponent(row.id)}`}
                            className="font-semibold text-[var(--ink-primary)] hover:text-[var(--accent)] transition-colors"
                          >
                            {formatProposalAction(row.action)} · {row.warehouse}
                          </Link>
                          <div className="inline-flex items-center gap-1 text-[11.5px] text-[var(--ink-muted)]">
                            <span
                              title={row.id}
                              className="font-mono-code tabular-nums"
                            >
                              {shortId}
                            </span>
                            <button
                              type="button"
                              onClick={() => void handleCopyId(row.id)}
                              title={`复制完整单号 ${row.id}`}
                              aria-label={`复制单号 ${row.id}`}
                              className="inline-flex h-5 w-5 items-center justify-center rounded-full text-[var(--ink-faint)] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-[var(--bg-hover)] hover:text-[var(--ink-primary)] transition-all cursor-pointer"
                            >
                              {copiedId === row.id ? (
                                <Check className="h-3 w-3 text-[var(--status-emerald)]" />
                              ) : (
                                <Copy className="h-3 w-3" />
                              )}
                            </button>
                          </div>
                        </div>
                      </td>
                      <td className="px-3.5 py-3.5 align-top">
                        <span className="inline-flex items-center rounded-full bg-[var(--bg-surface-subtle)] px-2.5 py-0.5 font-mono-code text-[11px] font-medium text-[var(--ink-secondary)]">
                          {row.warehouse}
                        </span>
                      </td>
                      <td className="px-3.5 py-3.5 align-top">
                        <div className="text-[var(--ink-primary)] leading-snug">
                          {row.primaryReason}
                        </div>
                        {/* Dual-Hat Consolidation: per-hat sub-statuses inside ONE unified row */}
                        {row.hats.length > 1 && (
                          <div
                            className="mt-2 space-y-1.5 rounded-sm bg-[var(--bg-surface-tint)] p-2.5"
                            data-testid="queue-dual-hat-substatuses"
                          >
                            {row.hats.map((hat) => (
                              <div
                                key={`${row.id}-${hat.lane}`}
                                className="flex items-center gap-2 text-[11.5px]"
                              >
                                <span className="rounded-full bg-[var(--bg-surface)] px-2 py-0.5 text-[10.5px] font-medium text-[var(--ink-secondary)] shadow-[var(--shadow-subtle)]">
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
                      <td className="px-3.5 py-3.5 align-top">
                        <StatusBadge status={badgeStatus} compact />
                        {isDueSoon && (
                          <div className="mt-1.5 font-mono-code tabular-nums text-[11px] font-medium text-[var(--status-amber-ink)]">
                            {expiry.label}
                          </div>
                        )}
                      </td>
                      <td className="px-3.5 py-3.5 align-top text-[12.5px] text-[var(--ink-secondary)]">
                        {row.primaryNextStep}
                      </td>
                      <td className="px-4 py-3.5 align-top text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1.5">
                          <Button
                            size="sm"
                            pill
                            variant="quiet"
                            onClick={(e) =>
                              openDrawer(
                                {
                                  kind: "proposal",
                                  id: row.id,
                                  warehouse: row.warehouse,
                                  title: `${formatProposalAction(row.action)} · ${shortId}`,
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
                            className="inline-flex h-8 items-center gap-1 rounded-full bg-[var(--bg-surface-subtle)] px-3 text-[12px] font-medium text-[var(--ink-primary)] hover:bg-[var(--bg-hover)] hover:text-[var(--accent)] transition-colors duration-[150ms]"
                          >
                            <span>详情</span>
                            <ArrowUpRight className="h-3.5 w-3.5" />
                          </Link>
                        </div>
                      </td>
                    </tr>

                    {/* Expandable Inline Metadata Well */}
                    {expanded && (
                      <tr
                        className="bg-[var(--bg-surface-tint)]/90"
                        data-testid={`queue-expanded-${row.id}`}
                      >
                        <td colSpan={7} className="px-5 py-3.5">
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 text-[12px]">
                            <div className="rounded-sm bg-[var(--bg-surface)] px-3 py-2 shadow-[var(--shadow-subtle)]">
                              <div className="text-[11px] text-[var(--ink-muted)]">
                                计划 / 到期时间
                              </div>
                              <div
                                className={[
                                  "mt-0.5 font-mono-code tabular-nums font-medium",
                                  isDueSoon
                                    ? "text-[var(--status-amber-ink)]"
                                    : "text-[var(--ink-primary)]",
                                ].join(" ")}
                              >
                                {formatUnixTime(row.expires, {
                                  withSeconds: true,
                                })}
                              </div>
                            </div>
                            <div className="rounded-sm bg-[var(--bg-surface)] px-3 py-2 shadow-[var(--shadow-subtle)]">
                              <div className="text-[11px] text-[var(--ink-muted)]">
                                责任阶段
                              </div>
                              <div className="mt-0.5 font-medium text-[var(--ink-primary)]">
                                {row.hats.map((h) => h.roleLabel).join(" / ")}
                              </div>
                            </div>
                            <div className="rounded-sm bg-[var(--bg-surface)] px-3 py-2 shadow-[var(--shadow-subtle)]">
                              <div className="text-[11px] text-[var(--ink-muted)]">
                                当前指派
                              </div>
                              <div className="mt-0.5 font-mono-code text-[var(--ink-primary)]">
                                {row.assigned_to ?? "未指定"}
                              </div>
                            </div>
                            <div className="rounded-sm bg-[var(--bg-surface)] px-3 py-2 shadow-[var(--shadow-subtle)]">
                              <div className="text-[11px] text-[var(--ink-muted)]">
                                队列时间
                              </div>
                              <div className="mt-0.5 font-mono-code tabular-nums text-[var(--ink-primary)]">
                                {formatUnixTime(row.due, { withSeconds: true })}
                              </div>
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
        <div className="flex items-center justify-center gap-2.5 border-t border-[var(--hairline-subtle)] bg-[var(--bg-surface-tint)] px-5 py-3">
          {(subView === "assigned" || subView === "unified") && assignedNext && (
            <Button
              size="sm"
              pill
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
                pill
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
