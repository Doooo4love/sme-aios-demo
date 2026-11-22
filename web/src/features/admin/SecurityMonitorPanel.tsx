"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  Filter,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  UserX,
} from "lucide-react";
import { isApiError, isStaleAuthError, type ApiError } from "@/lib/api-client";
import { useLocale } from "@/lib/i18n";
import { useSession } from "@/lib/session-context";
import { AccessNoticeCard, Button, Modal } from "@/components/ui";
import {
  fetchSecurityEvents,
  fetchSecurityEventsSummary,
  updateSecurityEventStatus,
} from "@/features/admin/api";
import type {
  HistoryCursor,
  SecurityEventItem,
  SecurityEventSeverity,
  SecurityEventStatus,
  SecurityEventsSummary,
} from "@/lib/types";

const PAGE_LIMIT = 40;

const KNOWN_CATEGORIES: readonly string[] = [
  "SKILL_TAMPER_ATTEMPT",
  "DESTRUCTIVE_ACTION_ATTEMPT",
  "FILESYSTEM_ESCAPE_ATTEMPT",
  "PROMPT_INJECTION_ATTEMPT",
  "SECRET_EXFILTRATION_ATTEMPT",
  "PRIVILEGE_ESCALATION_ATTEMPT",
  "CROSS_SCOPE_ACCESS_ATTEMPT",
  "UNAUTHORIZED_MODULE_QUERY",
  "EMAIL_POLICY_VIOLATION",
];

function getSeverityBadgeClass(severity: SecurityEventSeverity): string {
  switch (severity) {
    case "critical":
      return "border border-[var(--status-crimson-border)] bg-[var(--status-crimson-wash)] text-[var(--status-crimson)] font-semibold";
    case "high":
      return "border border-[var(--status-crimson-border)] bg-[var(--status-crimson-wash)] text-[var(--status-crimson)]";
    case "medium":
      return "border border-[var(--status-amber-border)] bg-[var(--status-amber-wash)] text-[var(--status-amber-ink)]";
    case "info":
    default:
      return "border border-[var(--hairline)] bg-[var(--status-neutral-wash)] text-[var(--status-neutral)]";
  }
}

function getStatusBadgeClass(status: SecurityEventStatus): string {
  switch (status) {
    case "open":
      return "border border-[var(--status-crimson-border)] bg-[var(--status-crimson-wash)] text-[var(--status-crimson)]";
    case "acknowledged":
      return "border border-[var(--status-amber-border)] bg-[var(--status-amber-wash)] text-[var(--status-amber-ink)]";
    case "resolved":
      return "border border-[var(--status-emerald-border)] bg-[var(--status-emerald-wash)] text-[var(--status-emerald)]";
  }
}

export interface SecurityMonitorPanelProps {
  onSuspendSubject?: (subject: string) => void;
}

export function SecurityMonitorPanel({
  onSuspendSubject,
}: SecurityMonitorPanelProps) {
  const { actor, canAccessAdminOps, authGeneration, handleAccessChanged } =
    useSession();
  const { t, tx, formatDateTime, localizeRole, localizeError } = useLocale();

  const isAdmin = actor?.role === "admin";

  const [summary, setSummary] = useState<SecurityEventsSummary | null>(null);
  const [events, setEvents] = useState<SecurityEventItem[]>([]);
  const [nextCursor, setNextCursor] = useState<HistoryCursor | null>(null);

  const [statusFilter, setStatusFilter] = useState<SecurityEventStatus | "all">(
    "all",
  );
  const [severityFilter, setSeverityFilter] = useState<
    SecurityEventSeverity | "all"
  >("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("");
  const [subjectFilter, setSubjectFilter] = useState<string>("");

  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<ApiError | null>(null);

  // Resolution modal state
  const [modalTarget, setModalTarget] = useState<{
    event: SecurityEventItem;
    nextStatus: "acknowledged" | "resolved";
  } | null>(null);
  const [resolutionNote, setResolutionNote] = useState("");
  const [updating, setUpdating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const loadData = useCallback(
    async (signal?: AbortSignal) => {
      if (!canAccessAdminOps) return;
      setLoading(true);
      setLoadError(null);
      try {
        const [sumRes, pageRes] = await Promise.all([
          fetchSecurityEventsSummary(signal),
          fetchSecurityEvents(
            {
              status: statusFilter === "all" ? undefined : statusFilter,
              severity: severityFilter === "all" ? undefined : severityFilter,
              category: categoryFilter.trim() || undefined,
              subject: subjectFilter.trim() || undefined,
              limit: PAGE_LIMIT,
            },
            signal,
          ),
        ]);
        if (signal?.aborted) return;
        setSummary(sumRes);
        setEvents(pageRes.items);
        setNextCursor(pageRes.next);
      } catch (err) {
        if (isStaleAuthError(err)) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (isApiError(err)) {
          if (err.code === "ACCESS_CHANGED") {
            void handleAccessChanged();
          }
          setLoadError(err);
        }
      } finally {
        setLoading(false);
      }
    },
    [
      canAccessAdminOps,
      statusFilter,
      severityFilter,
      categoryFilter,
      subjectFilter,
      handleAccessChanged,
    ],
  );

  useEffect(() => {
    setEvents([]);
    setNextCursor(null);
    setLoadError(null);
    if (!canAccessAdminOps) return;
    const controller = new AbortController();
    void loadData(controller.signal);
    return () => {
      controller.abort();
    };
  }, [authGeneration, canAccessAdminOps, loadData]);

  const handleLoadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const pageRes = await fetchSecurityEvents({
        status: statusFilter === "all" ? undefined : statusFilter,
        severity: severityFilter === "all" ? undefined : severityFilter,
        category: categoryFilter.trim() || undefined,
        subject: subjectFilter.trim() || undefined,
        limit: PAGE_LIMIT,
        before_at: nextCursor.before_at,
        before_id: nextCursor.before_id,
      });
      setEvents((prev) => {
        const seen = new Set(prev.map((e) => e.id));
        const merged = [...prev];
        for (const item of pageRes.items) {
          if (!seen.has(item.id)) {
            seen.add(item.id);
            merged.push(item);
          }
        }
        return merged;
      });
      setNextCursor(pageRes.next);
    } catch (err) {
      if (isStaleAuthError(err)) return;
      if (isApiError(err)) {
        setLoadError(err);
      }
    } finally {
      setLoadingMore(false);
    }
  };

  const openResolutionModal = (
    event: SecurityEventItem,
    nextStatus: "acknowledged" | "resolved",
  ) => {
    setModalTarget({ event, nextStatus });
    setResolutionNote(event.resolution_note ?? "");
    setActionError(null);
  };

  const handleSubmitStatusUpdate = async () => {
    if (!modalTarget || updating || !isAdmin) return;
    setUpdating(true);
    setActionError(null);
    try {
      const updated = await updateSecurityEventStatus(modalTarget.event.id, {
        status: modalTarget.nextStatus,
        resolution_note: resolutionNote.trim() || null,
      });
      setEvents((prev) =>
        prev.map((item) => (item.id === updated.id ? updated : item)),
      );
      setModalTarget(null);
      const freshSummary = await fetchSecurityEventsSummary().catch(() => null);
      if (freshSummary) setSummary(freshSummary);
    } catch (err) {
      if (isStaleAuthError(err)) return;
      if (isApiError(err)) {
        setActionError(localizeError(err));
      } else {
        setActionError(
          tx({
            "zh-CN": "更新告警状态失败，请重试。",
            "zh-HK": "更新告警狀態失敗，請重試。",
            en: "Failed to update security event status.",
          }),
        );
      }
    } finally {
      setUpdating(false);
    }
  };

  const localizeSeverity = (sev: SecurityEventSeverity) => {
    switch (sev) {
      case "critical":
        return tx({ "zh-CN": "严重", "zh-HK": "嚴重", en: "Critical" });
      case "high":
        return tx({ "zh-CN": "高风险", "zh-HK": "高風險", en: "High" });
      case "medium":
        return tx({ "zh-CN": "中风险", "zh-HK": "中風險", en: "Medium" });
      case "info":
      default:
        return tx({ "zh-CN": "提示", "zh-HK": "提示", en: "Info" });
    }
  };

  const localizeEventStatus = (st: SecurityEventStatus) => {
    switch (st) {
      case "open":
        return tx({ "zh-CN": "待处置", "zh-HK": "待處置", en: "Open" });
      case "acknowledged":
        return tx({ "zh-CN": "已确认", "zh-HK": "已確認", en: "Acknowledged" });
      case "resolved":
        return tx({ "zh-CN": "已解决", "zh-HK": "已解決", en: "Resolved" });
    }
  };

  const localizeDecision = (dec: SecurityEventItem["decision"]) => {
    switch (dec) {
      case "blocked":
        return tx({ "zh-CN": "已阻断", "zh-HK": "已阻斷", en: "Blocked" });
      case "denied":
        return tx({ "zh-CN": "已拒绝", "zh-HK": "已拒絕", en: "Denied" });
      case "flagged":
        return tx({ "zh-CN": "已标记", "zh-HK": "已標記", en: "Flagged" });
      case "escalated":
        return tx({ "zh-CN": "已升级", "zh-HK": "已升級", en: "Escalated" });
    }
  };

  return (
    <div className="space-y-5" data-testid="security-monitor-panel">
      {/* Live Anomaly KPI Strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-tile border border-[var(--hairline)] bg-[var(--bg-surface)] p-4 shadow-[var(--shadow-card)]">
          <div className="aios-micro-label">
            {tx({
              "zh-CN": "未处置严重告警",
              "zh-HK": "未處置嚴重告警",
              en: "Open Critical",
            })}
          </div>
          <div
            data-testid="security-kpi-critical"
            className={[
              "aios-kpi mt-2 text-[26px] font-semibold leading-none",
              (summary?.by_severity.critical ?? 0) > 0
                ? "text-[var(--status-crimson)]"
                : "text-[var(--ink-muted)]",
            ].join(" ")}
          >
            {summary?.by_severity.critical ?? 0}
          </div>
        </div>

        <div className="rounded-tile border border-[var(--hairline)] bg-[var(--bg-surface)] p-4 shadow-[var(--shadow-card)]">
          <div className="aios-micro-label">
            {tx({
              "zh-CN": "未处置高风险",
              "zh-HK": "未處置高風險",
              en: "Open High",
            })}
          </div>
          <div
            data-testid="security-kpi-high"
            className={[
              "aios-kpi mt-2 text-[26px] font-semibold leading-none",
              (summary?.by_severity.high ?? 0) > 0
                ? "text-[var(--status-crimson)]"
                : "text-[var(--ink-muted)]",
            ].join(" ")}
          >
            {summary?.by_severity.high ?? 0}
          </div>
        </div>

        <div className="rounded-tile border border-[var(--hairline)] bg-[var(--bg-surface)] p-4 shadow-[var(--shadow-card)]">
          <div className="aios-micro-label">
            {tx({
              "zh-CN": "未处置中风险",
              "zh-HK": "未處置中風險",
              en: "Open Medium",
            })}
          </div>
          <div
            data-testid="security-kpi-medium"
            className={[
              "aios-kpi mt-2 text-[26px] font-semibold leading-none",
              (summary?.by_severity.medium ?? 0) > 0
                ? "text-[var(--status-amber-ink)]"
                : "text-[var(--ink-muted)]",
            ].join(" ")}
          >
            {summary?.by_severity.medium ?? 0}
          </div>
        </div>

        <div className="rounded-tile border border-[var(--hairline)] bg-[var(--bg-surface)] p-4 shadow-[var(--shadow-card)]">
          <div className="aios-micro-label">
            {tx({
              "zh-CN": "近 24 小时拦截总数",
              "zh-HK": "近 24 小時攔截總數",
              en: "24h Blocked & Audited",
            })}
          </div>
          <div
            data-testid="security-kpi-24h"
            className="aios-kpi mt-2 text-[26px] font-semibold leading-none text-[var(--ink-primary)]"
          >
            {summary?.last_24h_total ?? 0}
          </div>
        </div>
      </div>

      {/* Filter Bar */}
      <section className="rounded-card border border-[var(--hairline)] bg-[var(--bg-surface)] p-4 shadow-[var(--shadow-card)]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="aios-micro-label inline-flex items-center gap-1.5">
              <Filter className="h-3.5 w-3.5" />
              <span>
                {tx({ "zh-CN": "状态", "zh-HK": "狀態", en: "Status" })}
              </span>
            </span>
            <div className="inline-flex rounded-sm border border-[var(--hairline)] bg-[var(--bg-inset)] p-0.5">
              {(["all", "open", "acknowledged", "resolved"] as const).map(
                (st) => (
                  <button
                    key={st}
                    type="button"
                    onClick={() => setStatusFilter(st)}
                    className={[
                      "rounded-xs px-2.5 py-1 text-[11.5px] font-medium transition-colors cursor-pointer",
                      statusFilter === st
                        ? "bg-[var(--bg-surface)] text-[var(--ink-primary)] shadow-[var(--shadow-subtle)]"
                        : "text-[var(--ink-muted)] hover:text-[var(--ink-primary)]",
                    ].join(" ")}
                  >
                    {st === "all"
                      ? tx({ "zh-CN": "全部", "zh-HK": "全部", en: "All" })
                      : localizeEventStatus(st)}
                  </button>
                ),
              )}
            </div>

            <select
              value={severityFilter}
              onChange={(e) =>
                setSeverityFilter(
                  e.target.value as SecurityEventSeverity | "all",
                )
              }
              aria-label={tx({
                "zh-CN": "按风险等级筛选",
                "zh-HK": "按風險等級篩選",
                en: "Filter by severity",
              })}
              className="h-8 rounded-sm border border-[var(--hairline-strong)] bg-[var(--bg-surface-tint)] px-2.5 text-[12px] text-[var(--ink-primary)] focus:border-[var(--accent)] focus:bg-[var(--bg-surface)] focus:outline-none"
            >
              <option value="all">
                {tx({
                  "zh-CN": "全部级别",
                  "zh-HK": "全部級別",
                  en: "All Severities",
                })}
              </option>
              <option value="critical">{localizeSeverity("critical")}</option>
              <option value="high">{localizeSeverity("high")}</option>
              <option value="medium">{localizeSeverity("medium")}</option>
              <option value="info">{localizeSeverity("info")}</option>
            </select>

            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              aria-label={tx({
                "zh-CN": "按事件分类筛选",
                "zh-HK": "按事件分類篩選",
                en: "Filter by category",
              })}
              className="h-8 max-w-full rounded-sm border border-[var(--hairline-strong)] bg-[var(--bg-surface-tint)] px-2.5 font-mono-code text-[11.5px] text-[var(--ink-primary)] focus:border-[var(--accent)] focus:bg-[var(--bg-surface)] focus:outline-none"
            >
              <option value="">
                {tx({
                  "zh-CN": "全部分类",
                  "zh-HK": "全部分類",
                  en: "All Categories",
                })}
              </option>
              {KNOWN_CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>

            <input
              type="text"
              value={subjectFilter}
              onChange={(e) => setSubjectFilter(e.target.value)}
              placeholder={tx({
                "zh-CN": "按员工主体筛选…",
                "zh-HK": "按員工主體篩選…",
                en: "Subject filter…",
              })}
              className="h-8 w-full sm:w-40 rounded-sm border border-[var(--hairline-strong)] bg-[var(--bg-surface-tint)] px-2.5 font-mono-code text-[12px] text-[var(--ink-primary)] placeholder:font-sans placeholder:text-[var(--ink-faint)] focus:border-[var(--accent)] focus:bg-[var(--bg-surface)] focus:outline-none"
            />
          </div>

          <Button
            size="sm"
            variant="secondary"
            loading={loading}
            onClick={() => void loadData()}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>{t("common.refresh")}</span>
          </Button>
        </div>
      </section>

      {loadError && (
        <AccessNoticeCard
          error={loadError}
          onRetry={() => void loadData()}
        />
      )}

      {/* Incident Feed / Table */}
      {!loadError && (
        <section className="overflow-hidden rounded-card border border-[var(--hairline)] bg-[var(--bg-surface)] shadow-[var(--shadow-card)]">
          {loading && events.length === 0 ? (
            <div className="px-6 py-14 text-center text-[13px] text-[var(--ink-muted)]">
              {tx({
                "zh-CN": "正在加载安全告警事件…",
                "zh-HK": "正在載入安全告警事件…",
                en: "Loading security events…",
              })}
            </div>
          ) : events.length === 0 ? (
            <div
              data-testid="security-events-empty"
              className="flex flex-col items-center gap-2 px-6 py-14 text-center"
            >
              <span className="flex h-10 w-10 items-center justify-center rounded-sm border border-[var(--status-emerald-border)] bg-[var(--status-emerald-wash)] text-[var(--status-emerald)]">
                <ShieldCheck className="h-5 w-5" />
              </span>
              <div className="text-[14.5px] font-semibold text-[var(--ink-primary)]">
                {tx({
                  "zh-CN": "当前筛选条件下无安全异常事件",
                  "zh-HK": "目前篩選條件下無安全異常事件",
                  en: "No security anomaly events match the filter",
                })}
              </div>
              <p className="max-w-[420px] text-[12.5px] text-[var(--ink-muted)]">
                {tx({
                  "zh-CN":
                    "所有提示词越权试探、跨仓访问与越界操作均会实时脱敏记入此处。",
                  "zh-HK":
                    "所有提示詞越權試探、跨倉存取與越界操作均會即時脫敏記入此處。",
                  en: "All prompt boundary probes, cross-scope attempts, and policy blocks are scrubbed and recorded here in real time.",
                })}
              </p>
            </div>
          ) : (
            <>
              <div className="divide-y divide-[var(--hairline-subtle)]">
                {events.map((ev) => {
                  const repeatedBurst = ev.metadata?.repeated_burst === true;
                  const canSuspendTarget =
                    isAdmin && actor?.subject !== ev.subject;

                  return (
                    <div
                      key={ev.id}
                      data-testid={`security-event-row-${ev.id}`}
                      className="p-4 sm:px-5 transition-colors hover:bg-[var(--bg-surface-tint)]/70 space-y-2.5"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span
                            className={[
                              "inline-flex items-center gap-1.5 rounded-xs px-2 py-0.5 font-mono-code text-[10.5px] font-semibold",
                              getSeverityBadgeClass(ev.severity),
                            ].join(" ")}
                          >
                            {ev.severity === "critical" && (
                              <span
                                aria-hidden="true"
                                className="h-1.5 w-1.5 rounded-full bg-[var(--status-crimson)]"
                              />
                            )}
                            <span>{localizeSeverity(ev.severity)}</span>
                          </span>
                          <span className="font-mono-code text-[12.5px] font-semibold text-[var(--ink-primary)]">
                            {ev.category}
                          </span>
                          <span className="rounded-xs border border-[var(--hairline)] bg-[var(--bg-surface-subtle)] px-2 py-0.5 font-mono-code text-[10.5px] font-medium text-[var(--ink-secondary)]">
                            {localizeDecision(ev.decision)}
                          </span>
                          {repeatedBurst && (
                            <span className="inline-flex items-center gap-1 rounded-xs border border-[var(--status-crimson-border)] bg-[var(--status-crimson-wash)] px-2 py-0.5 text-[10.5px] font-semibold text-[var(--status-crimson)]">
                              <AlertTriangle className="h-3 w-3" />
                              <span>
                                {tx({
                                  "zh-CN": "高频突发",
                                  "zh-HK": "高頻突發",
                                  en: "Repeated Burst",
                                })}
                              </span>
                            </span>
                          )}
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={[
                              "rounded-xs px-2 py-0.5 font-mono-code text-[10.5px] font-semibold",
                              getStatusBadgeClass(ev.status),
                            ].join(" ")}
                          >
                            {localizeEventStatus(ev.status)}
                          </span>
                          <span className="font-mono-code text-[11px] text-[var(--ink-muted)] tabular-nums">
                            {formatDateTime(ev.created_at, { withSeconds: true })}
                          </span>
                        </div>
                      </div>

                      <p className="text-[13px] leading-relaxed text-[var(--ink-primary)] break-words">
                        {ev.summary}
                      </p>

                      <div className="flex flex-wrap items-center justify-between gap-3 text-[11.5px] text-[var(--ink-muted)]">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          <span>
                            {tx({
                              "zh-CN": "主体：",
                              "zh-HK": "主體：",
                              en: "Subject: ",
                            })}
                            <span className="font-mono-code font-medium text-[var(--ink-primary)]">
                              {ev.subject}
                            </span>{" "}
                            <span>({localizeRole(ev.role)})</span>
                          </span>
                          {ev.module && (
                            <span>
                              {tx({
                                "zh-CN": "模块：",
                                "zh-HK": "模組：",
                                en: "Module: ",
                              })}
                              <span className="font-mono-code text-[var(--ink-secondary)]">
                                {ev.module}
                              </span>
                            </span>
                          )}
                          <span>
                            SHA-256:{" "}
                            <span className="font-mono-code text-[var(--ink-secondary)] tabular-nums">
                              {ev.input_sha256.slice(0, 12)}
                            </span>
                          </span>
                        </div>

                        <div className="flex flex-wrap items-center gap-1.5">
                          {isAdmin && ev.status === "open" && (
                            <Button
                              size="sm"
                              variant="quiet"
                              data-testid={`security-ack-${ev.id}`}
                              onClick={() =>
                                openResolutionModal(ev, "acknowledged")
                              }
                            >
                              <Eye className="h-3.5 w-3.5" />
                              <span>
                                {tx({
                                  "zh-CN": "确认知悉",
                                  "zh-HK": "確認知悉",
                                  en: "Acknowledge",
                                })}
                              </span>
                            </Button>
                          )}

                          {isAdmin && ev.status !== "resolved" && (
                            <Button
                              size="sm"
                              variant="secondary"
                              data-testid={`security-resolve-${ev.id}`}
                              onClick={() =>
                                openResolutionModal(ev, "resolved")
                              }
                            >
                              <CheckCircle2 className="h-3.5 w-3.5 text-[var(--status-emerald)]" />
                              <span>
                                {tx({
                                  "zh-CN": "标记已处置",
                                  "zh-HK": "標記已處置",
                                  en: "Resolve",
                                })}
                              </span>
                            </Button>
                          )}

                          {canSuspendTarget && onSuspendSubject && (
                            <Button
                              size="sm"
                              variant="danger"
                              data-testid={`security-suspend-${ev.id}`}
                              onClick={() => onSuspendSubject(ev.subject)}
                            >
                              <UserX className="h-3.5 w-3.5" />
                              <span>
                                {tx({
                                  "zh-CN": "停权处置",
                                  "zh-HK": "停權處置",
                                  en: "Suspend Subject",
                                })}
                              </span>
                            </Button>
                          )}
                        </div>
                      </div>

                      {ev.resolution_note && (
                        <div className="rounded-sm border border-[var(--hairline)] bg-[var(--bg-surface-tint)] px-3 py-2 text-[12px] text-[var(--ink-secondary)]">
                          <span className="font-medium text-[var(--ink-primary)]">
                            {tx({
                              "zh-CN": "处置备注：",
                              "zh-HK": "處置備註：",
                              en: "Resolution note: ",
                            })}
                          </span>
                          <span>{ev.resolution_note}</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {nextCursor && (
                <div className="border-t border-[var(--hairline-subtle)] bg-[var(--bg-surface-tint)] px-5 py-3 flex justify-end">
                  <Button
                    size="sm"
                    variant="quiet"
                    loading={loadingMore}
                    onClick={() => void handleLoadMore()}
                  >
                    {tx({
                      "zh-CN": "加载更多事件",
                      "zh-HK": "載入更多事件",
                      en: "Load More",
                    })}
                  </Button>
                </div>
              )}
            </>
          )}
        </section>
      )}

      {/* Acknowledge / Resolve Modal */}
      <Modal
        open={modalTarget !== null}
        onOpenChange={(open) => {
          if (!open && !updating) setModalTarget(null);
        }}
        title={
          modalTarget?.nextStatus === "acknowledged"
            ? tx({
                "zh-CN": "确认安全告警事件",
                "zh-HK": "確認安全告警事件",
                en: "Acknowledge Security Event",
              })
            : tx({
                "zh-CN": "标记安全事件已处置",
                "zh-HK": "標記安全事件已處置",
                en: "Resolve Security Event",
              })
        }
        subtitle={
          modalTarget
            ? `${modalTarget.event.category} · ${modalTarget.event.subject}`
            : undefined
        }
        size="sm"
        footer={
          <>
            <Button
              variant="ghost"
              disabled={updating}
              onClick={() => setModalTarget(null)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              loading={updating}
              data-testid="security-modal-submit"
              onClick={() => void handleSubmitStatusUpdate()}
            >
              {tx({
                "zh-CN": "确认提交",
                "zh-HK": "確認提交",
                en: "Confirm",
              })}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {modalTarget && (
            <div className="rounded-tile bg-[var(--bg-surface-tint)] p-3 text-[12px] text-[var(--ink-secondary)]">
              <div className="flex items-center gap-1.5 font-medium text-[var(--ink-primary)]">
                <ShieldAlert className="h-3.5 w-3.5 text-[var(--accent)]" />
                <span className="font-mono-code">
                  {modalTarget.event.category}
                </span>
              </div>
              <p className="mt-1 leading-relaxed">
                {modalTarget.event.summary}
              </p>
            </div>
          )}

          <div>
            <label
              htmlFor="security-resolution-note"
              className="block text-[12px] font-medium text-[var(--ink-secondary)]"
            >
              {tx({
                "zh-CN": "处置说明备注（可选，最多 400 字）",
                "zh-HK": "處置說明備註（可選，最多 400 字）",
                en: "Resolution Note (optional, max 400 chars)",
              })}
            </label>
            <textarea
              id="security-resolution-note"
              rows={3}
              maxLength={400}
              value={resolutionNote}
              onChange={(e) => setResolutionNote(e.target.value)}
              placeholder={tx({
                "zh-CN": "例如：已核实为正常员工误触未授权模块，已补充权限说明。",
                "zh-HK": "例如：已核實為正常員工誤觸未授權模組，已補充權限說明。",
                en: "e.g. Verified employee probed an unassigned module; access boundary explained.",
              })}
              className="mt-1.5 w-full rounded-sm border border-[var(--hairline-strong)] bg-[var(--bg-surface-tint)] p-2.5 text-[12.5px] text-[var(--ink-primary)] focus:border-[var(--accent)] focus:bg-[var(--bg-surface)] focus:ring-2 focus:ring-[var(--accent-ring)] focus:outline-none"
            />
          </div>

          {actionError && (
            <div
              role="alert"
              className="rounded-tile bg-[var(--status-crimson-wash)] px-3 py-2 text-[12px] text-[var(--status-crimson)]"
            >
              {actionError}
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
