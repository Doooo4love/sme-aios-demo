"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  CheckCircle2,
  Eye,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { isApiError, isStaleAuthError, type ApiError } from "@/lib/api-client";
import { sortWarehouses } from "@/lib/format";
import {
  useLocale,
  type LocaleVars,
  type TrilingualText,
} from "@/lib/i18n";
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
  fetchSecurityEventsSummary,
  reconcileProposal,
  runDemoWorkerTick,
} from "@/features/admin/api";
import type {
  DueCursor,
  ExceptionItem,
  SecurityEventsSummary,
} from "@/lib/types";

const PAGE_LIMIT = 50;

const LAST_EVENT_LABELS: Readonly<Record<string, TrilingualText>> = {
  OUTCOME_UNKNOWN: {
    "zh-CN": "ERP 通信中断或超时，结果待确认",
    "zh-HK": "ERP 通訊中斷或逾時，結果待確認",
    en: "ERP connection interrupted or timed out; outcome pending",
  },
  READBACK_REOPENED: {
    "zh-CN": "管理员已发起回执重新核查",
    "zh-HK": "管理員已發起回執重新核查",
    en: "Operator reopened read-only receipt verification",
  },
  READBACK_LIMIT_REACHED: {
    "zh-CN": "自动回执核查达到上限（3次），转人工核查",
    "zh-HK": "自動回執核查達到上限（3次），轉人工核查",
    en: "Automatic receipt readback limit reached (3/3); escalated to operator",
  },
  LEASE_EXPIRED_VERIFY_ONLY: {
    "zh-CN": "执行租约过期，转为只读回执核查",
    "zh-HK": "執行租約過期，轉為唯讀回執核查",
    en: "Execution lease expired; switched to read-only receipt verification",
  },
  LEASE_LOST_BEFORE_SEND: {
    "zh-CN": "发送前租约失效",
    "zh-HK": "發送前租約失效",
    en: "Execution lease lost before outbound dispatch",
  },
  INVALID_STORED_PLAN: {
    "zh-CN": "已存提案结构校验失败",
    "zh-HK": "已存提案結構校驗失敗",
    en: "Stored proposal plan validation failed",
  },
  PLAN_DIGEST_OR_TENANT_MISMATCH: {
    "zh-CN": "提案摘要或租户边界不一致",
    "zh-HK": "提案摘要或租戶邊界不一致",
    en: "Proposal digest or tenant boundary mismatch",
  },
  ERP_RECEIPT_MISMATCH: {
    "zh-CN": "ERP 回执字段与已批准提案不一致",
    "zh-HK": "ERP 回執欄位與已批准提案不一致",
    en: "ERP receipt fields do not match the approved proposal",
  },
  NEEDS_OPERATOR: {
    "zh-CN": "已转交运维人工核查",
    "zh-HK": "已轉交維運人工核查",
    en: "Escalated for manual operator review",
  },
};

interface BannerNotice {
  kind: "success" | "conflict";
  text: TrilingualText;
  vars?: LocaleVars;
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
  const { t, tx, tp, formatDateTime, localizeStatus } = useLocale();

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
  const [tickNotice, setTickNotice] = useState<TrilingualText | null>(null);
  const [securitySummary, setSecuritySummary] =
    useState<SecurityEventsSummary | null>(null);

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

        fetchSecurityEventsSummary(signal)
          .then((sec) => {
            if (!signal?.aborted) setSecuritySummary(sec);
          })
          .catch(() => {
            // Non-blocking if security summary endpoint unavailable
          });
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
    setSecuritySummary(null);

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
        text: {
          "zh-CN":
            "已为提案 {id} 发起只读回执核查，最新状态为 {state}（核验计数已重置为 {checks}）。",
          "zh-HK":
            "已為提案 {id} 發起唯讀回執核查，最新狀態為 {state}（核驗計數已重設為 {checks}）。",
          en: "Reopened read-only receipt verification for {id}. State is now {state} (checks reset to {checks}).",
        },
        vars: {
          id: targetId,
          state: updated.state,
          checks: updated.checks,
        },
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
            text: {
              "zh-CN":
                "提案 {id} 状态已变更，当前不可发起回执核查，已刷新最新队列。",
              "zh-HK":
                "提案 {id} 狀態已變更，目前不可發起回執核查，已重新整理最新佇列。",
              en: "Proposal {id} changed state and can no longer be reconciled. Queue refreshed.",
            },
            vars: { id: targetId },
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
          ? {
              "zh-CN": "已推进 1 条队列任务并刷新异常队列。",
              "zh-HK": "已推進 1 筆佇列任務並重新整理異常佇列。",
              en: "Advanced 1 queued job and refreshed the exceptions queue.",
            }
          : {
              "zh-CN": "当前无待执行的队列任务（或写入已暂停）。",
              "zh-HK": "目前無待執行的佇列任務（或寫入已暫停）。",
              en: "No pending worker jobs right now (or writes are paused).",
            },
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
        className="mx-auto max-w-[820px] px-4 py-8 sm:px-6"
        data-testid="exceptions-access-denied"
      >
        <AccessNoticeCard
          variant="ACCESS_RESTRICTED"
          title={tx({
            "zh-CN": "需要运维管理权限 (operations.manage)",
            "zh-HK": "需要維運管理權限 (operations.manage)",
            en: "Operations Permission Required (operations.manage)",
          })}
          message={tx({
            "zh-CN":
              "异常单据队列仅限具备 operations.manage 权限的主管或管理员查看与发起回执核查。",
            "zh-HK":
              "異常單據佇列僅限具備 operations.manage 權限的主管或管理員檢視與發起回執核查。",
            en: "The exceptions queue is restricted to managers or administrators with operations.manage.",
          })}
          backHref="/inbox"
          backLabel={t("common.backToWorkbench")}
        />
      </div>
    );
  }

  const sortedActorWarehouses = actor?.warehouses.length
    ? sortWarehouses(actor.warehouses)
    : [];

  return (
    <div
      className="mx-auto max-w-[1160px] space-y-5 px-4 py-6 sm:px-6 lg:py-7 pb-16"
      data-testid="admin-exceptions-page"
    >
      {/* Back Link */}
      <div>
        <Link
          href="/admin"
          className="inline-flex items-center gap-1.5 rounded-sm border border-[var(--hairline)] bg-[var(--bg-surface)] px-3 py-1.5 text-[12px] font-medium text-[var(--ink-secondary)] shadow-[var(--shadow-subtle)] hover:border-[var(--hairline-strong)] hover:text-[var(--accent)] transition-all duration-[150ms]"
        >
          <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.85} />
          <span>
            {tx({
              "zh-CN": "返回运维监控中心",
              "zh-HK": "返回維運監控中心",
              en: "Back to Operations",
            })}
          </span>
        </Link>
      </div>

      {/* Unified Porcelain / Obsidian Page-Header Card */}
      <section className="rounded-card border border-[var(--hairline)] bg-[var(--bg-surface)] shadow-[var(--shadow-card)] p-5 sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="aios-display text-[20px] font-semibold text-[var(--ink-primary)] leading-tight">
                {tx({
                  "zh-CN": "异常单据队列",
                  "zh-HK": "異常單據佇列",
                  en: "Exceptions Queue",
                })}
              </h1>
              {canRunDemoTick && <SourceTag source="synthetic" />}
            </div>
            <p className="mt-1 text-[13px] text-[var(--ink-secondary)]">
              {tx({
                "zh-CN":
                  "集中查看待确认与需人工核查的单据；发起回执核查仅做只读回查，不会重复写入 ERP。",
                "zh-HK":
                  "集中檢視待確認與須人工核查的單據；發起回執核查僅做唯讀回查，不會重複寫入 ERP。",
                en: "Inspect unknown-outcome and operator-escalated proposals. Reconciling performs read-only receipt verification and never replays ERP writes.",
              })}
            </p>
            <p className="mt-1.5 text-[12px] text-[var(--ink-muted)] tabular-nums">
              <span className="font-mono-code">{actor?.tenant ?? "—"}</span>
              <span className="mx-1.5 text-[var(--ink-faint)]">·</span>
              {sortedActorWarehouses.length > 0 ? (
                <span className="font-mono-code">
                  {sortedActorWarehouses.join(" / ")}
                </span>
              ) : (
                <span>{t("shell.noWarehouse")}</span>
              )}
              <span className="mx-1.5 text-[var(--ink-faint)]">·</span>
              <span>
                {tx(
                  {
                    "zh-CN": "已加载 {count} 条{more}",
                    "zh-HK": "已載入 {count} 筆{more}",
                    en: "Loaded {count}{more}",
                  },
                  { count: items.length, more: nextCursor ? "+" : "" },
                )}
              </span>
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {canRunDemoTick && (
              <Button
                size="sm"
                pill
                variant="quiet"
                loading={tickBusy}
                data-testid="exceptions-worker-tick-btn"
                onClick={() => void handleDemoTick()}
              >
                <Play className="h-3.5 w-3.5" strokeWidth={1.85} />
                <span>
                  {tx({
                    "zh-CN": "演示 Worker Tick",
                    "zh-HK": "示範 Worker Tick",
                    en: "Demo Worker Tick",
                  })}
                </span>
              </Button>
            )}
            <Button
              size="sm"
              pill
              variant="secondary"
              loading={loading}
              data-testid="exceptions-refresh-btn"
              onClick={() => void loadExceptions()}
            >
              <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.85} />
              <span>
                {tx({
                  "zh-CN": "刷新队列",
                  "zh-HK": "重新整理佇列",
                  en: "Refresh Queue",
                })}
              </span>
            </Button>
          </div>
        </div>
      </section>

      {/* Compact Live Open Security Alerts Summary Banner */}
      {securitySummary && (
        <div
          data-testid="exceptions-security-banner"
          className={[
            "flex flex-wrap items-center justify-between gap-3 rounded-tile border px-4 py-3 text-[12.5px]",
            securitySummary.total_open > 0
              ? "border-[var(--status-crimson-border)] bg-[var(--status-crimson-wash)] text-[var(--ink-primary)]"
              : "border-[var(--hairline)] bg-[var(--bg-surface)] text-[var(--ink-secondary)] shadow-[var(--shadow-subtle)]",
          ].join(" ")}
        >
          <div className="flex flex-wrap items-center gap-2.5 min-w-0">
            {securitySummary.total_open > 0 ? (
              <ShieldAlert
                className="h-4 w-4 shrink-0 text-[var(--status-crimson)]"
                strokeWidth={1.9}
              />
            ) : (
              <ShieldCheck
                className="h-4 w-4 shrink-0 text-[var(--status-emerald)]"
                strokeWidth={1.9}
              />
            )}
            <span className="font-semibold text-[var(--ink-primary)] tabular-nums">
              {securitySummary.total_open > 0
                ? tx(
                    {
                      "zh-CN": "当前共有 {count} 条待处置安全异常告警",
                      "zh-HK": "目前共有 {count} 則待處置安全異常告警",
                      en: "{count} Open Security Alert(s) Requiring Review",
                    },
                    { count: securitySummary.total_open },
                  )
                : tx({
                    "zh-CN": "当前无未处置安全异常告警",
                    "zh-HK": "目前無未處置安全異常告警",
                    en: "No open security alerts",
                  })}
            </span>
            {securitySummary.total_open > 0 && (
              <span className="font-mono-code text-[11.5px] text-[var(--ink-secondary)] tabular-nums">
                {tx(
                  {
                    "zh-CN": "严重 {crit} · 高风险 {high} · 中风险 {med}",
                    "zh-HK": "嚴重 {crit} · 高風險 {high} · 中風險 {med}",
                    en: "Critical {crit} · High {high} · Medium {med}",
                  },
                  {
                    crit: securitySummary.by_severity.critical,
                    high: securitySummary.by_severity.high,
                    med: securitySummary.by_severity.medium,
                  },
                )}
              </span>
            )}
          </div>

          <Link
            href="/admin?tab=security"
            data-testid="exceptions-security-link"
            className="inline-flex h-8 items-center gap-1 rounded-full bg-[var(--bg-surface)] px-3.5 text-[12px] font-medium text-[var(--accent-ink)] shadow-[var(--shadow-subtle)] hover:bg-[var(--accent-wash)] transition-colors shrink-0"
          >
            <span>
              {tx({
                "zh-CN": "前往安全审计监控",
                "zh-HK": "前往安全稽核監控",
                en: "Open Security Monitor",
              })}
            </span>
            <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.9} />
          </Link>
        </div>
      )}

      {/* Action Feedback Banners */}
      {tickNotice && (
        <div
          role="status"
          data-testid="exceptions-worker-tick-result"
          className="flex items-center gap-2.5 rounded-tile bg-[var(--accent-wash)] px-4 py-3 text-[12.5px] text-[var(--accent-ink)]"
        >
          <CheckCircle2 className="h-4 w-4 shrink-0" strokeWidth={1.85} />
          <span>{tx(tickNotice)}</span>
        </div>
      )}

      {actionNotice && (
        <div
          role="status"
          data-testid="reconcile-feedback"
          className={[
            "flex items-center gap-2.5 rounded-tile px-4 py-3 text-[13px]",
            actionNotice.kind === "success"
              ? "bg-[var(--status-emerald-wash)] text-[var(--status-emerald)]"
              : "bg-[var(--status-amber-wash)] text-[var(--status-amber-ink)]",
          ].join(" ")}
        >
          <CheckCircle2 className="h-4 w-4 shrink-0" strokeWidth={1.85} />
          <span>{tx(actionNotice.text, actionNotice.vars)}</span>
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
          backLabel={tx({
            "zh-CN": "返回运维监控中心",
            "zh-HK": "返回維運監控中心",
            en: "Back to Operations",
          })}
        />
      )}

      {/* Exceptions Sheet */}
      {!loadError && (
        <section className="rounded-card border border-[var(--hairline)] bg-[var(--bg-surface)] shadow-[var(--shadow-card)] overflow-hidden">
          {loading && items.length === 0 ? (
            <div className="px-6 py-14 text-center text-[13px] text-[var(--ink-muted)]">
              {tx({
                "zh-CN": "正在加载异常单据队列…",
                "zh-HK": "正在載入異常單據佇列…",
                en: "Loading exceptions queue…",
              })}
            </div>
          ) : items.length === 0 ? (
            <div
              data-testid="exceptions-empty-state"
              className="flex flex-col items-center gap-2.5 px-6 py-16 text-center"
            >
              <div className="flex h-11 w-11 items-center justify-center rounded-full bg-[var(--status-emerald-wash)] text-[var(--status-emerald)]">
                <CheckCircle2 className="h-5.5 w-5.5" strokeWidth={1.85} />
              </div>
              <div className="text-[15px] font-semibold text-[var(--ink-primary)]">
                {tx({
                  "zh-CN": "当前没有待处置异常单据",
                  "zh-HK": "目前沒有待處置異常單據",
                  en: "No exceptions requiring action",
                })}
              </div>
              <p className="max-w-[440px] text-[13px] text-[var(--ink-muted)] leading-relaxed">
                {tx({
                  "zh-CN":
                    "授权仓库范围内所有已派发提案均运行正常，没有滞留在待确认或人工核查状态的记录。",
                  "zh-HK":
                    "授權倉庫範圍內所有已派發提案均運作正常，沒有滯留於待確認或人工核查狀態的紀錄。",
                  en: "All dispatched proposals in your authorized warehouses are healthy with no stalled or operator-escalated records.",
                })}
              </p>
            </div>
          ) : (
            <>
              {/* Desktop Spacious Table */}
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full border-collapse text-left">
                  <thead>
                    <tr className="aios-micro-label border-b border-[var(--hairline)] bg-[var(--bg-surface-tint)]">
                      <th className="px-5 py-3">
                        {tx({
                          "zh-CN": "提案编号",
                          "zh-HK": "提案編號",
                          en: "Proposal ID",
                        })}
                      </th>
                      <th className="px-3.5 py-3">
                        {tx({
                          "zh-CN": "仓库",
                          "zh-HK": "倉庫",
                          en: "Warehouse",
                        })}
                      </th>
                      <th className="px-3.5 py-3">
                        {tx({
                          "zh-CN": "状态",
                          "zh-HK": "狀態",
                          en: "State",
                        })}
                      </th>
                      <th className="px-3.5 py-3 text-right">
                        {tx({
                          "zh-CN": "核验轮次",
                          "zh-HK": "核驗輪次",
                          en: "Checks",
                        })}
                      </th>
                      <th className="px-3.5 py-3">
                        {tx({
                          "zh-CN": "最近异常说明",
                          "zh-HK": "最近異常說明",
                          en: "Last Event",
                        })}
                      </th>
                      <th className="px-3.5 py-3 text-right">
                        {tx({
                          "zh-CN": "计划时间",
                          "zh-HK": "排程時間",
                          en: "Scheduled",
                        })}
                      </th>
                      <th className="px-5 py-3 text-right">
                        {tx({
                          "zh-CN": "操作",
                          "zh-HK": "操作",
                          en: "Actions",
                        })}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--hairline-subtle)]">
                    {items.map((item) => {
                      const canReconcile = item.state === "NEEDS_OPERATOR";
                      const eventEntry = item.last_event
                        ? LAST_EVENT_LABELS[item.last_event]
                        : undefined;
                      const eventExplanation = eventEntry
                        ? tx(eventEntry)
                        : null;
                      return (
                        <tr
                          key={item.proposal_id}
                          data-testid={`exception-row-${item.proposal_id}`}
                          className="transition-colors duration-[140ms] hover:bg-[var(--bg-surface-tint)]/80"
                        >
                          <td className="px-5 py-3.5">
                            <Link
                              href={`/proposals/${encodeURIComponent(item.proposal_id)}`}
                              className="font-mono-code text-[13px] font-semibold text-[var(--ink-primary)] hover:text-[var(--accent)] hover:underline"
                            >
                              {item.proposal_id}
                            </Link>
                          </td>
                          <td className="px-3.5 py-3.5">
                            <span className="inline-flex rounded-xs border border-[var(--hairline)] bg-[var(--bg-surface-tint)] px-2 py-0.5 font-mono-code text-[11.5px] font-medium text-[var(--ink-secondary)]">
                              {item.warehouse}
                            </span>
                          </td>
                          <td className="px-3.5 py-3.5">
                            <StatusBadge status={item.state} compact />
                          </td>
                          <td className="px-3.5 py-3.5 text-right font-mono-code text-[13px] font-medium text-[var(--ink-primary)] tabular-nums">
                            {item.checks}/3
                          </td>
                          <td className="px-3.5 py-3.5">
                            <div
                              title={item.last_event ?? undefined}
                              className="text-[12.5px] text-[var(--ink-primary)]"
                            >
                              {eventExplanation ?? item.last_event ?? "—"}
                            </div>
                            {eventExplanation && item.last_event && (
                              <div className="mt-0.5 font-mono-code text-[11px] text-[var(--ink-muted)]">
                                {item.last_event}
                              </div>
                            )}
                          </td>
                          <td className="px-3.5 py-3.5 text-right font-mono-code text-[12px] text-[var(--ink-secondary)] tabular-nums whitespace-nowrap">
                            {formatDateTime(item.due, { withSeconds: true })}
                          </td>
                          <td className="px-5 py-3.5">
                            <div className="flex items-center justify-end gap-1.5">
                              <Button
                                size="sm"
                                pill
                                variant="ghost"
                                onClick={(e) =>
                                  openDrawer(
                                    {
                                      kind: "proposal",
                                      id: item.proposal_id,
                                      warehouse: item.warehouse,
                                      title: tx({
                                        "zh-CN": "异常单据核对",
                                        "zh-HK": "異常單據核對",
                                        en: "Exception Inspection",
                                      }),
                                    },
                                    { tab: "current", trigger: e.currentTarget },
                                  )
                                }
                                title={tx({
                                  "zh-CN": "在右侧面板预览提案详情",
                                  "zh-HK": "於右側面板預覽提案詳情",
                                  en: "Preview proposal in inspector drawer",
                                })}
                              >
                                <Eye className="h-3.5 w-3.5" strokeWidth={1.85} />
                                <span>
                                  {tx({
                                    "zh-CN": "面板",
                                    "zh-HK": "面板",
                                    en: "Inspect",
                                  })}
                                </span>
                              </Button>

                              <Link
                                href={`/proposals/${encodeURIComponent(item.proposal_id)}`}
                                data-testid={`exception-view-${item.proposal_id}`}
                                className="inline-flex h-8 items-center gap-1 rounded-full px-2.5 text-[12.5px] font-medium text-[var(--accent-ink)] hover:bg-[var(--accent-wash)] transition-colors"
                              >
                                <span>
                                  {tx({
                                    "zh-CN": "详情",
                                    "zh-HK": "詳情",
                                    en: "Details",
                                  })}
                                </span>
                                <ArrowUpRight
                                  className="h-3.5 w-3.5"
                                  strokeWidth={1.85}
                                />
                              </Link>

                              <Button
                                size="sm"
                                pill
                                variant={canReconcile ? "primary" : "secondary"}
                                disabled={!canReconcile || reconciling}
                                title={
                                  canReconcile
                                    ? tx({
                                        "zh-CN": "发起只读回执核查 (Reconcile)",
                                        "zh-HK": "發起唯讀回執核查 (Reconcile)",
                                        en: "Reopen read-only receipt verification (Reconcile)",
                                      })
                                    : tx({
                                        "zh-CN":
                                          "待确认单据将自动重试回查；仅需人工核查状态可手动重启",
                                        "zh-HK":
                                          "待確認單據將自動重試回查；僅須人工核查狀態可手動重啟",
                                        en: "Unknown-outcome items retry automatically; manual reconcile is enabled only for Needs Operator",
                                      })
                                }
                                data-testid={`reconcile-btn-${item.proposal_id}`}
                                onClick={() => setReconcileTarget(item)}
                              >
                                <RotateCcw
                                  className="h-3.5 w-3.5"
                                  strokeWidth={1.85}
                                />
                                <span>
                                  {tx({
                                    "zh-CN": "发起回执核查",
                                    "zh-HK": "發起回執核查",
                                    en: "Reconcile",
                                  })}
                                </span>
                              </Button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Mobile Stacked Rows */}
              <div className="divide-y divide-[var(--hairline-subtle)] md:hidden">
                {items.map((item) => {
                  const canReconcile = item.state === "NEEDS_OPERATOR";
                  const eventEntry = item.last_event
                    ? LAST_EVENT_LABELS[item.last_event]
                    : undefined;
                  return (
                    <div
                      key={item.proposal_id}
                      data-testid={`exception-mobile-row-${item.proposal_id}`}
                      className="space-y-3 p-4"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <Link
                          href={`/proposals/${encodeURIComponent(item.proposal_id)}`}
                          className="font-mono-code text-[13.5px] font-semibold text-[var(--ink-primary)] hover:text-[var(--accent)]"
                        >
                          {item.proposal_id}
                        </Link>
                        <StatusBadge status={item.state} compact />
                      </div>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-[var(--ink-muted)] tabular-nums">
                        <span>
                          {tx({
                            "zh-CN": "仓库",
                            "zh-HK": "倉庫",
                            en: "Warehouse",
                          })}{" "}
                          <span className="font-mono-code text-[var(--ink-secondary)]">
                            {item.warehouse}
                          </span>
                        </span>
                        <span>
                          {tx(
                            {
                              "zh-CN": "核验 {checks}/3",
                              "zh-HK": "核驗 {checks}/3",
                              en: "Checks {checks}/3",
                            },
                            { checks: item.checks },
                          )}
                        </span>
                        <span>
                          {tx({
                            "zh-CN": "时间",
                            "zh-HK": "時間",
                            en: "Due",
                          })}{" "}
                          <span className="font-mono-code text-[var(--ink-secondary)]">
                            {formatDateTime(item.due, { withSeconds: true })}
                          </span>
                        </span>
                      </div>
                      {item.last_event && (
                        <div className="rounded-sm bg-[var(--bg-surface-tint)] px-3 py-2 text-[12px] text-[var(--ink-secondary)]">
                          <span>
                            {eventEntry ? tx(eventEntry) : item.last_event}
                          </span>
                        </div>
                      )}
                      <div className="flex flex-wrap items-center gap-2 pt-0.5">
                        <Link
                          href={`/proposals/${encodeURIComponent(item.proposal_id)}`}
                          className="inline-flex h-9 items-center gap-1 rounded-full bg-[var(--bg-surface-subtle)] px-3.5 text-[12.5px] font-medium text-[var(--ink-primary)] shadow-[var(--shadow-subtle)] hover:bg-[var(--bg-surface-hover)] transition-colors"
                        >
                          <span>
                            {tx({
                              "zh-CN": "查看单据详情",
                              "zh-HK": "檢視單據詳情",
                              en: "View Proposal",
                            })}
                          </span>
                          <ArrowUpRight className="h-3.5 w-3.5" />
                        </Link>
                        <Button
                          size="md"
                          pill
                          variant={canReconcile ? "primary" : "secondary"}
                          disabled={!canReconcile || reconciling}
                          data-testid={`exception-mobile-reconcile-btn-${item.proposal_id}`}
                          onClick={() => setReconcileTarget(item)}
                        >
                          <RotateCcw
                            className="h-3.5 w-3.5"
                            strokeWidth={1.85}
                          />
                          <span>
                            {tx({
                              "zh-CN": "发起回执核查",
                              "zh-HK": "發起回執核查",
                              en: "Reconcile",
                            })}
                          </span>
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Dual-Value Cursor Pagination Footer */}
              <div className="flex flex-col gap-2.5 border-t border-[var(--hairline-subtle)] bg-[var(--bg-surface-tint)] px-5 py-3.5 sm:flex-row sm:items-center sm:justify-between">
                <span className="text-[12px] text-[var(--ink-muted)] tabular-nums">
                  {nextCursor
                    ? tp(
                        {
                          "zh-CN": "已加载 {count} 条，仍有更多异常单据",
                          "zh-HK": "已載入 {count} 筆，仍有更多異常單據",
                          en: {
                            one: "Loaded {count} exception — more available",
                            other: "Loaded {count} exceptions — more available",
                          },
                        },
                        items.length,
                      )
                    : tp(
                        {
                          "zh-CN": "已加载全部可见异常单据（共 {count} 条）",
                          "zh-HK": "已載入全部可見異常單據（共 {count} 筆）",
                          en: {
                            one: "All visible exceptions loaded ({count} exception)",
                            other:
                              "All visible exceptions loaded ({count} exceptions)",
                          },
                        },
                        items.length,
                      )}
                </span>
                {nextCursor && (
                  <Button
                    size="sm"
                    pill
                    variant="quiet"
                    loading={loadingMore}
                    data-testid="exceptions-load-more"
                    onClick={() => void handleLoadMore()}
                  >
                    {tx({
                      "zh-CN": "加载更多异常",
                      "zh-HK": "載入更多異常",
                      en: "Load More",
                    })}
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
        title={tx({
          "zh-CN": "确认发起回执核查 (Reconcile)",
          "zh-HK": "確認發起回執核查 (Reconcile)",
          en: "Confirm Read-Only Reconciliation",
        })}
        description={tx({
          "zh-CN":
            "系统将仅向 ERP 执行只读回执核查，不会重复发送任何 ERP 写入请求。确认后提案状态将重新进入结果待确认，并将自动核验计数重置为 0。",
          "zh-HK":
            "系統將僅向 ERP 執行唯讀回執核查，不會重複發送任何 ERP 寫入請求。確認後提案狀態將重新進入結果待確認，並將自動核驗計數重設為 0。",
          en: "The platform will perform a read-only receipt check against ERP without replaying any write request. The proposal returns to Outcome Unknown and resets the check counter to 0.",
        })}
        scopeSummary={tx(
          {
            "zh-CN": "租户 {tenant} · 仓库 {warehouse} · 提案 {id}",
            "zh-HK": "租戶 {tenant} · 倉庫 {warehouse} · 提案 {id}",
            en: "Tenant {tenant} · Warehouse {warehouse} · Proposal {id}",
          },
          {
            tenant: actor?.tenant ?? "—",
            warehouse: reconcileTarget?.warehouse ?? "—",
            id: reconcileTarget?.proposal_id ?? "—",
          },
        )}
        metadata={[
          {
            label: tx({
              "zh-CN": "提案编号",
              "zh-HK": "提案編號",
              en: "Proposal ID",
            }),
            value: reconcileTarget?.proposal_id ?? "—",
            mono: true,
          },
          {
            label: tx({
              "zh-CN": "仓库",
              "zh-HK": "倉庫",
              en: "Warehouse",
            }),
            value: reconcileTarget?.warehouse ?? "—",
            mono: true,
          },
          {
            label: tx({
              "zh-CN": "当前状态",
              "zh-HK": "目前狀態",
              en: "Current State",
            }),
            value: reconcileTarget
              ? localizeStatus(reconcileTarget.state)
              : "—",
          },
          {
            label: tx({
              "zh-CN": "当前核验轮次",
              "zh-HK": "目前核驗輪次",
              en: "Current Checks",
            }),
            value:
              reconcileTarget !== null ? `${reconcileTarget.checks}/3` : "—",
          },
          {
            label: tx({
              "zh-CN": "最近异常事件",
              "zh-HK": "最近異常事件",
              en: "Last Event",
            }),
            value: reconcileTarget?.last_event ?? "—",
            mono: true,
          },
        ]}
        confirmLabel={tx({
          "zh-CN": "确认发起回执核查",
          "zh-HK": "確認發起回執核查",
          en: "Confirm Reconcile",
        })}
        cancelLabel={t("common.cancel")}
        dialogTestId="reconcile-confirm-dialog"
        confirmTestId="confirm-dialog-submit"
        onConfirm={handleConfirmReconcile}
      />
    </div>
  );
}
