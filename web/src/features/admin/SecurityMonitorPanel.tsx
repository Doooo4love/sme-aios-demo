"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Cpu,
  Eye,
  EyeOff,
  Filter,
  Lock,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  UserX,
  X,
} from "lucide-react";
import { isApiError, isStaleAuthError, type ApiError } from "@/lib/api-client";
import { useLocale, type TrilingualText } from "@/lib/i18n";
import { useSession } from "@/lib/session-context";
import { AccessNoticeCard, Button, Modal } from "@/components/ui";
import {
  fetchLlmTelemetry,
  fetchOffTopicPolicy,
  fetchQuotaPolicies,
  fetchSecurityEvents,
  fetchSecurityEventsSummary,
  fetchSystemHealth,
  updateOffTopicPolicy,
  updateQuotaPolicy,
  updateSecurityEventStatus,
} from "@/features/admin/api";
import type {
  HistoryCursor,
  LlmRoutingTier,
  LlmTelemetryBreakdownValue,
  LlmTelemetrySummary,
  OffTopicPolicy,
  ProviderCircuitSnapshot,
  QuotaPolicyItem,
  SecurityEventItem,
  SecurityEventSeverity,
  SecurityEventStatus,
  SecurityEventsSummary,
  SystemHealthSnapshot,
} from "@/lib/types";

const PAGE_LIMIT = 40;

const KNOWN_CATEGORIES: readonly string[] = [
  "SKILL_TAMPER_ATTEMPT",
  "PROMPT_TAMPER_ATTEMPT",
  "DESTRUCTIVE_ACTION_ATTEMPT",
  "FILESYSTEM_ESCAPE_ATTEMPT",
  "PROMPT_INJECTION_ATTEMPT",
  "SECRET_EXFILTRATION_ATTEMPT",
  "PRIVILEGE_ESCALATION_ATTEMPT",
  "CROSS_SCOPE_ACCESS_ATTEMPT",
  "UNAUTHORIZED_MODULE_QUERY",
  "EMAIL_POLICY_VIOLATION",
  "OFF_TOPIC_PERSONAL_CHAT",
  "OFF_TOPIC_LOCAL_AUTOMATION",
];

const CATEGORY_LABELS: Record<string, TrilingualText> = {
  SKILL_TAMPER_ATTEMPT: {
    "zh-CN": "技能定义篡改",
    "zh-HK": "技能定義篡改",
    en: "Skill Tamper",
  },
  PROMPT_TAMPER_ATTEMPT: {
    "zh-CN": "密封策略篡改",
    "zh-HK": "密封策略篡改",
    en: "Policy Tamper",
  },
  DESTRUCTIVE_ACTION_ATTEMPT: {
    "zh-CN": "高危破坏性操作",
    "zh-HK": "高危破壞性操作",
    en: "Destructive Action",
  },
  FILESYSTEM_ESCAPE_ATTEMPT: {
    "zh-CN": "文件系统逃逸",
    "zh-HK": "檔案系統逃逸",
    en: "Filesystem Escape",
  },
  PROMPT_INJECTION_ATTEMPT: {
    "zh-CN": "提示词注入试探",
    "zh-HK": "提示詞注入試探",
    en: "Prompt Injection",
  },
  SECRET_EXFILTRATION_ATTEMPT: {
    "zh-CN": "密钥凭据外泄",
    "zh-HK": "密鑰憑證外洩",
    en: "Secret Exfiltration",
  },
  PRIVILEGE_ESCALATION_ATTEMPT: {
    "zh-CN": "越权提权试探",
    "zh-HK": "越權提權試探",
    en: "Privilege Escalation",
  },
  CROSS_SCOPE_ACCESS_ATTEMPT: {
    "zh-CN": "跨仓越界访问",
    "zh-HK": "跨倉越界存取",
    en: "Cross-Scope Access",
  },
  UNAUTHORIZED_MODULE_QUERY: {
    "zh-CN": "未授权模块查询",
    "zh-HK": "未授權模組查詢",
    en: "Unauthorized Module",
  },
  EMAIL_POLICY_VIOLATION: {
    "zh-CN": "外发邮件违规",
    "zh-HK": "外發郵件違規",
    en: "Email Policy",
  },
  OFF_TOPIC_PERSONAL_CHAT: {
    "zh-CN": "非工作私人对话",
    "zh-HK": "非工作私人對話",
    en: "Off-Topic Personal Chat",
  },
  OFF_TOPIC_LOCAL_AUTOMATION: {
    "zh-CN": "非工作本地自动化",
    "zh-HK": "非工作本地自動化",
    en: "Off-Topic Local Automation",
  },
};

const TIER_ORDER: readonly LlmRoutingTier[] = ["T0", "T1", "T2", "T3"];

const TIER_META: Record<
  LlmRoutingTier,
  { barClass: string; dotClass: string; label: TrilingualText }
> = {
  T0: {
    barClass: "bg-[var(--status-emerald)]",
    dotClass: "bg-[var(--status-emerald)]",
    label: {
      "zh-CN": "规则拦截/指令",
      "zh-HK": "規則攔截/指令",
      en: "Deterministic",
    },
  },
  T1: {
    barClass: "bg-[var(--accent)]",
    dotClass: "bg-[var(--accent)]",
    label: {
      "zh-CN": "极速直答",
      "zh-HK": "極速直答",
      en: "Fast Direct",
    },
  },
  T2: {
    barClass: "bg-[var(--status-amber)]",
    dotClass: "bg-[var(--status-amber)]",
    label: {
      "zh-CN": "标准推理",
      "zh-HK": "標準推理",
      en: "Standard",
    },
  },
  T3: {
    barClass: "bg-[var(--ink-primary)]",
    dotClass: "bg-[var(--ink-primary)]",
    label: {
      "zh-CN": "深度/升级",
      "zh-HK": "深度/升級",
      en: "Deep / Escalated",
    },
  },
};

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

function formatCompactCount(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

function formatCachePercent(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return "0.0%";
  const pct = ratio > 1 ? Math.min(ratio, 100) : ratio * 100;
  return `${pct.toFixed(1)}%`;
}

function formatEstimatedUsd(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return "$0.0000";
  return amount >= 1 ? `$${amount.toFixed(2)}` : `$${amount.toFixed(4)}`;
}

function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0s";
  const rounded = Math.floor(seconds);
  if (rounded < 60) return `${rounded}s`;
  const mins = Math.floor(rounded / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

function getCircuitDotClass(state: ProviderCircuitSnapshot["state"]): string {
  switch (state) {
    case "open":
      return "bg-[var(--status-crimson)]";
    case "half_open":
      return "bg-[var(--status-amber)]";
    case "closed":
    default:
      return "bg-[var(--status-emerald)]";
  }
}

function extractBreakdownCalls(value: LlmTelemetryBreakdownValue): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  return typeof value.calls === "number" && Number.isFinite(value.calls)
    ? value.calls
    : 0;
}

function clampThreshold(raw: string, fallback: number, max = 500): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(parsed, max));
}

function areStringArraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, idx) => item === b[idx]);
}

interface PolicyDraftState {
  daily_remind_threshold: number;
  daily_escalate_threshold: number;
  seven_day_escalate_threshold: number;
  daily_local_auto_escalate_threshold: number;
  app_allowlist: string[];
}

function draftFromPolicy(policy: OffTopicPolicy): PolicyDraftState {
  return {
    daily_remind_threshold: policy.daily_remind_threshold,
    daily_escalate_threshold: policy.daily_escalate_threshold,
    seven_day_escalate_threshold: policy.seven_day_escalate_threshold,
    daily_local_auto_escalate_threshold:
      policy.daily_local_auto_escalate_threshold,
    app_allowlist: [...policy.app_allowlist],
  };
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

  // Telemetry, System Health & Quota state (degrades gracefully if unavailable)
  const [telemetryHours, setTelemetryHours] = useState<24 | 168>(24);
  const [telemetry, setTelemetry] = useState<LlmTelemetrySummary | null>(null);
  const [telemetryLoading, setTelemetryLoading] = useState(false);
  const [telemetryUnavailable, setTelemetryUnavailable] = useState(false);
  const [systemHealth, setSystemHealth] = useState<SystemHealthSnapshot | null>(
    null,
  );
  const [systemHealthLoading, setSystemHealthLoading] = useState(false);
  const [quotaAvailable, setQuotaAvailable] = useState(false);
  const [quotaPolicies, setQuotaPolicies] = useState<QuotaPolicyItem[]>([]);
  const [quotaEditUsd, setQuotaEditUsd] = useState<string>("");
  const [quotaEditTokens, setQuotaEditTokens] = useState<string>("");
  const [quotaSaving, setQuotaSaving] = useState(false);
  const [quotaFeedback, setQuotaFeedback] = useState<{
    kind: "success" | "error";
    message: string;
  } | null>(null);

  // Off-topic boundary & role escalation policy state
  const [offTopicPolicy, setOffTopicPolicy] = useState<OffTopicPolicy | null>(
    null,
  );
  const [policyDraft, setPolicyDraft] = useState<PolicyDraftState | null>(null);
  const [policyLoading, setPolicyLoading] = useState(false);
  const [policyUnavailable, setPolicyUnavailable] = useState(false);
  const [newAllowAppInput, setNewAllowAppInput] = useState("");
  const [policySaving, setPolicySaving] = useState(false);
  const [policyFeedback, setPolicyFeedback] = useState<{
    kind: "success" | "error";
    message: string;
  } | null>(null);

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

  const loadTelemetryAndQuotas = useCallback(
    async (hours: number, signal?: AbortSignal) => {
      if (!canAccessAdminOps) return;
      setTelemetryLoading(true);
      setTelemetryUnavailable(false);
      if (isAdmin) {
        setSystemHealthLoading(true);
      }
      try {
        const [telRes, quotaRes, healthRes] = await Promise.allSettled([
          fetchLlmTelemetry(hours, signal),
          fetchQuotaPolicies(signal),
          isAdmin ? fetchSystemHealth(signal) : Promise.resolve(null),
        ]);
        if (signal?.aborted) return;

        if (telRes.status === "fulfilled") {
          setTelemetry(telRes.value);
          setTelemetryUnavailable(false);
        } else {
          const err = telRes.reason;
          if (isStaleAuthError(err)) return;
          if (err instanceof DOMException && err.name === "AbortError") return;
          setTelemetry(null);
          setTelemetryUnavailable(true);
        }

        if (quotaRes.status === "fulfilled") {
          const items = quotaRes.value.items;
          setQuotaAvailable(true);
          setQuotaPolicies(items);
          const tenantPolicy = items.find((q) => q.scope_type === "tenant");
          if (tenantPolicy) {
            setQuotaEditUsd(
              tenantPolicy.daily_usd_limit !== null
                ? String(tenantPolicy.daily_usd_limit)
                : "",
            );
            setQuotaEditTokens(
              tenantPolicy.daily_token_limit !== null
                ? String(tenantPolicy.daily_token_limit)
                : "",
            );
          }
        } else {
          setQuotaAvailable(false);
          setQuotaPolicies([]);
        }

        if (!isAdmin) {
          setSystemHealth(null);
        } else if (healthRes.status === "fulfilled") {
          setSystemHealth(healthRes.value);
        } else {
          const err = healthRes.reason;
          if (isStaleAuthError(err)) return;
          if (err instanceof DOMException && err.name === "AbortError") return;
          // Ignore non-fatal 403/503/network health probe failures gracefully
          setSystemHealth(null);
        }
      } finally {
        if (!signal?.aborted) {
          setTelemetryLoading(false);
          setSystemHealthLoading(false);
        }
      }
    },
    [canAccessAdminOps, isAdmin],
  );

  const loadOffTopicPolicy = useCallback(
    async (signal?: AbortSignal) => {
      if (!canAccessAdminOps) return;
      setPolicyLoading(true);
      setPolicyUnavailable(false);
      try {
        const policy = await fetchOffTopicPolicy(signal);
        if (signal?.aborted) return;
        setOffTopicPolicy(policy);
        setPolicyDraft(draftFromPolicy(policy));
        setPolicyUnavailable(false);
      } catch (err) {
        if (isStaleAuthError(err)) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        setOffTopicPolicy(null);
        setPolicyDraft(null);
        setPolicyUnavailable(true);
      } finally {
        if (!signal?.aborted) {
          setPolicyLoading(false);
        }
      }
    },
    [canAccessAdminOps],
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

  useEffect(() => {
    setTelemetry(null);
    setTelemetryUnavailable(false);
    setSystemHealth(null);
    setQuotaAvailable(false);
    setQuotaPolicies([]);
    setQuotaFeedback(null);
    if (!canAccessAdminOps) return;
    const controller = new AbortController();
    void loadTelemetryAndQuotas(telemetryHours, controller.signal);
    return () => {
      controller.abort();
    };
  }, [authGeneration, canAccessAdminOps, telemetryHours, loadTelemetryAndQuotas]);

  useEffect(() => {
    setOffTopicPolicy(null);
    setPolicyDraft(null);
    setPolicyUnavailable(false);
    setPolicyFeedback(null);
    setNewAllowAppInput("");
    if (!canAccessAdminOps) return;
    const controller = new AbortController();
    void loadOffTopicPolicy(controller.signal);
    return () => {
      controller.abort();
    };
  }, [authGeneration, canAccessAdminOps, loadOffTopicPolicy]);

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

  const isPolicyDirty = useMemo(() => {
    if (!offTopicPolicy || !policyDraft) return false;
    return (
      policyDraft.daily_remind_threshold !==
        offTopicPolicy.daily_remind_threshold ||
      policyDraft.daily_escalate_threshold !==
        offTopicPolicy.daily_escalate_threshold ||
      policyDraft.seven_day_escalate_threshold !==
        offTopicPolicy.seven_day_escalate_threshold ||
      policyDraft.daily_local_auto_escalate_threshold !==
        offTopicPolicy.daily_local_auto_escalate_threshold ||
      !areStringArraysEqual(
        policyDraft.app_allowlist,
        offTopicPolicy.app_allowlist,
      )
    );
  }, [offTopicPolicy, policyDraft]);

  const handleAddAllowlistApp = () => {
    if (!isAdmin || !policyDraft) return;
    const candidate = newAllowAppInput.trim();
    if (!candidate) return;
    const normalizedLower = candidate.toLowerCase();
    if (
      policyDraft.app_allowlist.some(
        (existing) => existing.toLowerCase() === normalizedLower,
      )
    ) {
      setNewAllowAppInput("");
      return;
    }
    setPolicyDraft({
      ...policyDraft,
      app_allowlist: [...policyDraft.app_allowlist, candidate],
    });
    setNewAllowAppInput("");
    setPolicyFeedback(null);
  };

  const handleRemoveAllowlistApp = (target: string) => {
    if (!isAdmin || !policyDraft) return;
    setPolicyDraft({
      ...policyDraft,
      app_allowlist: policyDraft.app_allowlist.filter((item) => item !== target),
    });
    setPolicyFeedback(null);
  };

  const handleSaveOffTopicPolicy = async () => {
    if (!isAdmin || !policyDraft || policySaving) return;
    setPolicySaving(true);
    setPolicyFeedback(null);
    try {
      const saved = await updateOffTopicPolicy({
        daily_remind_threshold: policyDraft.daily_remind_threshold,
        daily_escalate_threshold: policyDraft.daily_escalate_threshold,
        seven_day_escalate_threshold: policyDraft.seven_day_escalate_threshold,
        daily_local_auto_escalate_threshold:
          policyDraft.daily_local_auto_escalate_threshold,
        app_allowlist: policyDraft.app_allowlist,
      });
      setOffTopicPolicy(saved);
      setPolicyDraft(draftFromPolicy(saved));
      setPolicyFeedback({
        kind: "success",
        message: tx({
          "zh-CN": "边界阈值与工作应用白名单已更新并立即生效。",
          "zh-HK": "邊界閾值與工作應用白名單已更新並即時生效。",
          en: "Boundary thresholds and work app allowlist updated.",
        }),
      });
    } catch (err) {
      if (isStaleAuthError(err)) return;
      setPolicyFeedback({
        kind: "error",
        message: isApiError(err)
          ? localizeError(err)
          : tx({
              "zh-CN": "保存策略配置失败，请检查阈值设置后重试。",
              "zh-HK": "儲存策略設定失敗，請檢查閾值設定後重試。",
              en: "Failed to save off-topic boundary policy.",
            }),
      });
    } finally {
      setPolicySaving(false);
    }
  };

  const handleSaveTenantQuota = async () => {
    if (!isAdmin || quotaSaving || !actor?.tenant) return;
    const parsedUsd = quotaEditUsd.trim()
      ? Number.parseFloat(quotaEditUsd.trim())
      : null;
    const parsedTokens = quotaEditTokens.trim()
      ? Number.parseInt(quotaEditTokens.trim(), 10)
      : null;
    if (
      (parsedUsd !== null && (!Number.isFinite(parsedUsd) || parsedUsd <= 0)) ||
      (parsedTokens !== null &&
        (!Number.isFinite(parsedTokens) || parsedTokens <= 0))
    ) {
      setQuotaFeedback({
        kind: "error",
        message: tx({
          "zh-CN": "配额上限必须为正数。",
          "zh-HK": "配額上限必須為正數。",
          en: "Quota limits must be positive numbers.",
        }),
      });
      return;
    }
    setQuotaSaving(true);
    setQuotaFeedback(null);
    try {
      const updated = await updateQuotaPolicy({
        scope_type: "tenant",
        scope_key: actor.tenant,
        daily_usd_limit: parsedUsd,
        daily_token_limit: parsedTokens,
      });
      setQuotaPolicies((prev) => {
        const rest = prev.filter(
          (item) =>
            !(item.scope_type === "tenant" && item.scope_key === actor.tenant),
        );
        return [updated, ...rest];
      });
      setQuotaFeedback({
        kind: "success",
        message: tx({
          "zh-CN": "租户每日算力配额已保存。",
          "zh-HK": "租戶每日算力配額已儲存。",
          en: "Tenant daily quota saved.",
        }),
      });
    } catch (err) {
      if (isStaleAuthError(err)) return;
      setQuotaFeedback({
        kind: "error",
        message: isApiError(err)
          ? localizeError(err)
          : tx({
              "zh-CN": "更新算力配额失败。",
              "zh-HK": "更新算力配額失敗。",
              en: "Failed to update quota policy.",
            }),
      });
    } finally {
      setQuotaSaving(false);
    }
  };

  const localizeCategory = (cat: string) => {
    const entry = CATEGORY_LABELS[cat];
    return entry ? tx(entry) : cat;
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

  const tierTotal = useMemo(() => {
    if (!telemetry) return 0;
    return TIER_ORDER.reduce(
      (sum, tier) => sum + (telemetry.by_tier[tier] ?? 0),
      0,
    );
  }, [telemetry]);

  const providerEntries = useMemo(() => {
    if (!telemetry) return [];
    return Object.entries(telemetry.by_provider)
      .map(([name, val]) => ({ name, calls: extractBreakdownCalls(val) }))
      .filter((entry) => entry.calls > 0)
      .sort((a, b) => b.calls - a.calls);
  }, [telemetry]);

  const routingRuleEntries = useMemo(() => {
    if (!offTopicPolicy?.routing_rules) return [];
    return Object.entries(offTopicPolicy.routing_rules);
  }, [offTopicPolicy]);

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

      {/* Sub-Cards Grid: Smart Routing Telemetry + Non-Work Boundary Policy */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Card 1: Smart Routing & KV Cache Telemetry */}
        <section
          data-testid="admin-llm-telemetry-card"
          className="flex flex-col justify-between rounded-card border border-[var(--hairline)] bg-[var(--bg-surface)] p-5 shadow-[var(--shadow-card)] space-y-4"
        >
          <div className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="flex items-start gap-2.5 min-w-0">
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border border-[var(--hairline)] bg-[var(--bg-surface-tint)] text-[var(--accent-ink)]">
                  <Cpu className="h-4 w-4" strokeWidth={1.85} />
                </span>
                <div className="min-w-0">
                  <h2 className="aios-display text-[15px] font-semibold text-[var(--ink-primary)]">
                    {tx({
                      "zh-CN": "智能路由与 KV 缓存遥测",
                      "zh-HK": "智能路由與 KV 快取遙測",
                      en: "Smart Routing & KV Cache Telemetry",
                    })}
                  </h2>
                  <p className="mt-0.5 text-[12px] text-[var(--ink-muted)]">
                    {tx({
                      "zh-CN": "T0-T3 分级调度、前缀缓存命中率与算力成本监控",
                      "zh-HK": "T0-T3 分級調度、前綴快取命中率與算力成本監控",
                      en: "T0-T3 effort tiering, prefix cache hit ratio, and token cost telemetry.",
                    })}
                  </p>
                </div>
              </div>

              <div className="inline-flex shrink-0 rounded-sm border border-[var(--hairline)] bg-[var(--bg-inset)] p-0.5">
                {([24, 168] as const).map((hrs) => (
                  <button
                    key={hrs}
                    type="button"
                    onClick={() => setTelemetryHours(hrs)}
                    className={[
                      "rounded-xs px-2 py-0.5 font-mono-code text-[11px] font-medium transition-colors cursor-pointer",
                      telemetryHours === hrs
                        ? "bg-[var(--bg-surface)] text-[var(--ink-primary)] shadow-[var(--shadow-subtle)]"
                        : "text-[var(--ink-muted)] hover:text-[var(--ink-primary)]",
                    ].join(" ")}
                  >
                    {hrs === 24 ? "24h" : "7d"}
                  </button>
                ))}
              </div>
            </div>

            {telemetryLoading && !telemetry ? (
              <div className="rounded-tile border border-[var(--hairline)] bg-[var(--bg-surface-tint)] px-4 py-8 text-center text-[12.5px] text-[var(--ink-muted)]">
                {tx({
                  "zh-CN": "正在加载路由遥测数据…",
                  "zh-HK": "正在載入路由遙測數據…",
                  en: "Loading routing telemetry…",
                })}
              </div>
            ) : telemetryUnavailable || !telemetry ? (
              <div
                data-testid="admin-llm-telemetry-empty"
                className="rounded-tile border border-[var(--hairline)] bg-[var(--bg-surface-tint)] px-4 py-5 text-[12.5px] text-[var(--ink-secondary)]"
              >
                {tx({
                  "zh-CN":
                    "模型路由遥测暂未激活或当前环境尚无统计样本，安全审计功能不受影响。",
                  "zh-HK":
                    "模型路由遙測暫未啟用或目前環境尚無統計樣本，安全稽核功能不受影響。",
                  en: "Routing telemetry is currently unavailable or awaiting initial traffic; security auditing remains active.",
                })}
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                  <div className="rounded-tile border border-[var(--hairline)] bg-[var(--bg-surface-tint)] p-3">
                    <div className="aios-micro-label">
                      {tx({
                        "zh-CN": "KV 缓存命中",
                        "zh-HK": "KV 快取命中",
                        en: "Cache Hit Ratio",
                      })}
                    </div>
                    <div
                      data-testid="telemetry-cache-hit-ratio"
                      className="mt-1.5 font-mono-code text-[20px] font-semibold leading-none text-[var(--status-emerald)] tabular-nums"
                    >
                      {formatCachePercent(telemetry.cache_hit_ratio)}
                    </div>
                    <div className="mt-1.5 font-mono-code text-[10.5px] text-[var(--ink-muted)] tabular-nums">
                      {formatCompactCount(telemetry.total_cache_hit_tokens)} /{" "}
                      {formatCompactCount(telemetry.total_prompt_tokens)} tok
                    </div>
                  </div>

                  <div className="rounded-tile border border-[var(--hairline)] bg-[var(--bg-surface-tint)] p-3">
                    <div className="aios-micro-label">
                      {tx({
                        "zh-CN": "估算算力成本",
                        "zh-HK": "估算算力成本",
                        en: "Estimated Cost",
                      })}
                    </div>
                    <div
                      data-testid="telemetry-estimated-usd"
                      className="mt-1.5 font-mono-code text-[20px] font-semibold leading-none text-[var(--ink-primary)] tabular-nums"
                    >
                      {formatEstimatedUsd(telemetry.total_estimated_usd)}
                    </div>
                    <div className="mt-1.5 font-mono-code text-[10.5px] text-[var(--ink-muted)] tabular-nums">
                      {telemetry.total_calls}{" "}
                      {tx({
                        "zh-CN": "次调用",
                        "zh-HK": "次呼叫",
                        en: "calls",
                      })}
                    </div>
                  </div>

                  <div className="rounded-tile border border-[var(--hairline)] bg-[var(--bg-surface-tint)] p-3">
                    <div className="aios-micro-label">
                      {tx({
                        "zh-CN": "平均响应时延",
                        "zh-HK": "平均回應時延",
                        en: "Avg Latency",
                      })}
                    </div>
                    <div
                      data-testid="telemetry-avg-latency"
                      className="mt-1.5 font-mono-code text-[20px] font-semibold leading-none text-[var(--ink-primary)] tabular-nums"
                    >
                      {Math.round(telemetry.avg_latency_ms)}{" "}
                      <span className="text-[12px] font-normal text-[var(--ink-muted)]">
                        ms
                      </span>
                    </div>
                    <div className="mt-1.5 font-mono-code text-[10.5px] text-[var(--ink-muted)] tabular-nums">
                      {formatCompactCount(telemetry.total_completion_tokens)} out
                    </div>
                  </div>
                </div>

                {/* Latency Percentiles & Cache FinOps Summary Pills */}
                <div className="flex flex-wrap items-center gap-1.5">
                  <span
                    data-testid="telemetry-latency-percentiles"
                    className="inline-flex items-center gap-1.5 rounded-xs border border-[var(--hairline)] bg-[var(--bg-surface-tint)] px-2 py-0.5 font-mono-code text-[11px] text-[var(--ink-secondary)] tabular-nums"
                  >
                    <span className="text-[var(--ink-muted)]">
                      {tx({
                        "zh-CN": "时延分位",
                        "zh-HK": "時延分位",
                        en: "Latency",
                      })}
                    </span>
                    <span className="font-medium text-[var(--ink-primary)]">
                      P50{" "}
                      {typeof telemetry.p50_latency_ms === "number" &&
                      Number.isFinite(telemetry.p50_latency_ms)
                        ? `${Math.round(telemetry.p50_latency_ms)}ms`
                        : "—"}
                      {" · "}
                      P95{" "}
                      {typeof telemetry.p95_latency_ms === "number" &&
                      Number.isFinite(telemetry.p95_latency_ms)
                        ? `${Math.round(telemetry.p95_latency_ms)}ms`
                        : "—"}
                    </span>
                  </span>

                  <span
                    data-testid="telemetry-cache-savings"
                    className="inline-flex items-center gap-1.5 rounded-xs border border-[var(--hairline)] bg-[var(--bg-surface-tint)] px-2 py-0.5 font-mono-code text-[11px] text-[var(--ink-secondary)] tabular-nums"
                  >
                    <span className="text-[var(--ink-muted)]">
                      {tx({
                        "zh-CN": "缓存节省",
                        "zh-HK": "快取節省",
                        en: "Est. Cache Saved",
                      })}
                    </span>
                    <span
                      className={
                        (telemetry.estimated_cache_savings_usd ?? 0) > 0
                          ? "font-medium text-[var(--status-emerald)]"
                          : "font-medium text-[var(--ink-primary)]"
                      }
                    >
                      {formatEstimatedUsd(
                        telemetry.estimated_cache_savings_usd ?? 0,
                      )}
                    </span>
                  </span>

                  {typeof telemetry.error_rate === "number" &&
                    Number.isFinite(telemetry.error_rate) && (
                      <span className="inline-flex items-center gap-1.5 rounded-xs border border-[var(--hairline)] bg-[var(--bg-surface-tint)] px-2 py-0.5 font-mono-code text-[11px] text-[var(--ink-secondary)] tabular-nums">
                        <span className="text-[var(--ink-muted)]">
                          {tx({
                            "zh-CN": "异常率",
                            "zh-HK": "異常率",
                            en: "Error Rate",
                          })}
                        </span>
                        <span
                          className={
                            telemetry.error_rate > 0
                              ? "font-medium text-[var(--status-amber-ink)]"
                              : "font-medium text-[var(--ink-primary)]"
                          }
                        >
                          {formatCachePercent(telemetry.error_rate)}
                        </span>
                      </span>
                    )}

                  {typeof telemetry.failover_count === "number" &&
                    Number.isFinite(telemetry.failover_count) && (
                      <span className="inline-flex items-center gap-1.5 rounded-xs border border-[var(--hairline)] bg-[var(--bg-surface-tint)] px-2 py-0.5 font-mono-code text-[11px] text-[var(--ink-secondary)] tabular-nums">
                        <span className="text-[var(--ink-muted)]">
                          {tx({
                            "zh-CN": "故障切换",
                            "zh-HK": "故障切換",
                            en: "Failovers",
                          })}
                        </span>
                        <span
                          className={
                            telemetry.failover_count > 0
                              ? "font-medium text-[var(--status-amber-ink)]"
                              : "font-medium text-[var(--ink-primary)]"
                          }
                        >
                          {telemetry.failover_count}
                        </span>
                      </span>
                    )}
                </div>

                {/* T0 / T1 / T2 / T3 Distribution */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-[11.5px]">
                    <span className="aios-micro-label">
                      {tx({
                        "zh-CN": "分级路由分布 (T0–T3)",
                        "zh-HK": "分級路由分佈 (T0–T3)",
                        en: "Tier Distribution (T0–T3)",
                      })}
                    </span>
                    <span className="font-mono-code text-[11px] text-[var(--ink-muted)] tabular-nums">
                      {tierTotal}{" "}
                      {tx({ "zh-CN": "次", "zh-HK": "次", en: "total" })}
                    </span>
                  </div>

                  <div
                    className="flex h-2 w-full overflow-hidden rounded-full bg-[var(--bg-inset)] ring-1 ring-[var(--hairline)]"
                    aria-label={tx({
                      "zh-CN": "T0 到 T3 路由比例条",
                      "zh-HK": "T0 到 T3 路由比例條",
                      en: "T0 to T3 tier distribution bar",
                    })}
                  >
                    {tierTotal === 0 ? (
                      <div className="h-full w-full bg-[var(--bg-inset)]" />
                    ) : (
                      TIER_ORDER.map((tier) => {
                        const count = telemetry.by_tier[tier] ?? 0;
                        if (count <= 0) return null;
                        const pct = (count / tierTotal) * 100;
                        return (
                          <div
                            key={tier}
                            style={{ width: `${pct}%` }}
                            title={`${tier}: ${count} (${pct.toFixed(1)}%)`}
                            className={`h-full transition-[width] duration-300 ${TIER_META[tier].barClass}`}
                          />
                        );
                      })
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {TIER_ORDER.map((tier) => {
                      const count = telemetry.by_tier[tier] ?? 0;
                      const share =
                        tierTotal > 0 ? Math.round((count / tierTotal) * 100) : 0;
                      return (
                        <div
                          key={tier}
                          data-testid={`telemetry-tier-${tier}`}
                          className="rounded-sm border border-[var(--hairline)] bg-[var(--bg-surface-tint)] px-2.5 py-1.5"
                        >
                          <div className="flex items-center justify-between gap-1">
                            <span className="inline-flex items-center gap-1.5 font-mono-code text-[11px] font-semibold text-[var(--ink-primary)]">
                              <span
                                aria-hidden="true"
                                className={`h-1.5 w-1.5 rounded-full ${TIER_META[tier].dotClass}`}
                              />
                              {tier}
                            </span>
                            <span className="font-mono-code text-[11px] font-medium text-[var(--ink-secondary)] tabular-nums">
                              {count}
                            </span>
                          </div>
                          <div className="mt-0.5 flex items-center justify-between gap-1 text-[10px] text-[var(--ink-muted)]">
                            <span className="truncate">
                              {tx(TIER_META[tier].label)}
                            </span>
                            <span className="font-mono-code tabular-nums">
                              {share}%
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {providerEntries.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                    <span className="text-[11px] text-[var(--ink-muted)] mr-1">
                      {tx({
                        "zh-CN": "引擎分布：",
                        "zh-HK": "引擎分佈：",
                        en: "Adapters:",
                      })}
                    </span>
                    {providerEntries.map((entry) => (
                      <span
                        key={entry.name}
                        className="rounded-xs border border-[var(--hairline)] bg-[var(--bg-surface-tint)] px-2 py-0.5 font-mono-code text-[10.5px] text-[var(--ink-secondary)] tabular-nums"
                      >
                        {entry.name}: {entry.calls}
                      </span>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Compact Quota Policy Bar (shown when quota endpoint active) */}
          {quotaAvailable && !telemetryUnavailable && (
            <div className="border-t border-[var(--hairline-subtle)] pt-3 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2 text-[11.5px]">
                <span className="font-medium text-[var(--ink-secondary)]">
                  {tx({
                    "zh-CN": "租户每日算力配额护栏",
                    "zh-HK": "租戶每日算力配額護欄",
                    en: "Tenant Daily Quota Guardrail",
                  })}
                </span>
                {quotaPolicies.length > 0 && (
                  <span className="font-mono-code text-[11px] text-[var(--ink-muted)] tabular-nums">
                    {quotaPolicies
                      .slice(0, 2)
                      .map(
                        (q) =>
                          `${q.scope_type}:${q.scope_key} ($${q.daily_usd_limit ?? "—"} / ${q.daily_token_limit ? formatCompactCount(q.daily_token_limit) : "—"} tok)`,
                      )
                      .join(" · ")}
                  </span>
                )}
              </div>

              {isAdmin && (
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="number"
                    min="0.1"
                    step="0.5"
                    value={quotaEditUsd}
                    onChange={(e) => {
                      setQuotaEditUsd(e.target.value);
                      setQuotaFeedback(null);
                    }}
                    placeholder={tx({
                      "zh-CN": "日上限 USD",
                      "zh-HK": "日上限 USD",
                      en: "Daily USD cap",
                    })}
                    aria-label={tx({
                      "zh-CN": "租户每日算力金额上限（美元）",
                      "zh-HK": "租戶每日算力金額上限（美元）",
                      en: "Tenant daily USD cap",
                    })}
                    className="aios-input h-8 w-28 px-2 font-mono-code text-[11.5px] tabular-nums"
                  />
                  <input
                    type="number"
                    min="1000"
                    step="10000"
                    value={quotaEditTokens}
                    onChange={(e) => {
                      setQuotaEditTokens(e.target.value);
                      setQuotaFeedback(null);
                    }}
                    placeholder={tx({
                      "zh-CN": "日上限 Tokens",
                      "zh-HK": "日上限 Tokens",
                      en: "Daily token cap",
                    })}
                    aria-label={tx({
                      "zh-CN": "租户每日 Token 上限",
                      "zh-HK": "租戶每日 Token 上限",
                      en: "Tenant daily token cap",
                    })}
                    className="aios-input h-8 w-32 px-2 font-mono-code text-[11.5px] tabular-nums"
                  />
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={quotaSaving}
                    onClick={() => void handleSaveTenantQuota()}
                    className="h-8 px-2.5 text-[11.5px]"
                  >
                    <span>
                      {tx({
                        "zh-CN": "更新配额",
                        "zh-HK": "更新配額",
                        en: "Set Quota",
                      })}
                    </span>
                  </Button>
                </div>
              )}

              {quotaFeedback && (
                <p
                  className={[
                    "text-[11.5px]",
                    quotaFeedback.kind === "success"
                      ? "text-[var(--status-emerald)]"
                      : "text-[var(--status-crimson)]",
                  ].join(" ")}
                >
                  {quotaFeedback.message}
                </p>
              )}
            </div>
          )}
        </section>

        {/* Card 2: Non-Work Boundary & Role Escalation Policy */}
        <section
          data-testid="admin-offtopic-policy-card"
          className="flex flex-col justify-between rounded-card border border-[var(--hairline)] bg-[var(--bg-surface)] p-5 shadow-[var(--shadow-card)] space-y-4"
        >
          <div className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="flex items-start gap-2.5 min-w-0">
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border border-[var(--hairline)] bg-[var(--bg-surface-tint)] text-[var(--accent-ink)]">
                  <SlidersHorizontal className="h-4 w-4" strokeWidth={1.85} />
                </span>
                <div className="min-w-0">
                  <h2 className="aios-display text-[15px] font-semibold text-[var(--ink-primary)]">
                    {tx({
                      "zh-CN": "非工作行为边界与职级升级策略",
                      "zh-HK": "非工作行為邊界與職級升級策略",
                      en: "Non-Work Boundary & Role Escalation Policy",
                    })}
                  </h2>
                  <p className="mt-0.5 text-[12px] text-[var(--ink-muted)]">
                    {tx({
                      "zh-CN":
                        "L1 温和提醒 · L2 阻断记录 · L3 按汇报链脱敏上报（不留存私人原文）",
                      "zh-HK":
                        "L1 溫和提醒 · L2 阻斷記錄 · L3 按匯報鏈脫敏上報（不留存私人原文）",
                      en: "L1 gentle nudge, L2 block, and L3 privacy-redacted reporting-line escalation.",
                    })}
                  </p>
                </div>
              </div>

              {!isAdmin && (
                <span className="inline-flex items-center gap-1 rounded-xs border border-[var(--hairline)] bg-[var(--bg-surface-tint)] px-2 py-0.5 text-[10.5px] font-medium text-[var(--ink-muted)]">
                  <Lock className="h-3 w-3" />
                  <span>
                    {tx({
                      "zh-CN": "只读视图",
                      "zh-HK": "唯讀檢視",
                      en: "Read-only",
                    })}
                  </span>
                </span>
              )}
            </div>

            {policyLoading && !policyDraft ? (
              <div className="rounded-tile border border-[var(--hairline)] bg-[var(--bg-surface-tint)] px-4 py-8 text-center text-[12.5px] text-[var(--ink-muted)]">
                {tx({
                  "zh-CN": "正在加载边界治理策略…",
                  "zh-HK": "正在載入邊界治理策略…",
                  en: "Loading boundary policy…",
                })}
              </div>
            ) : policyUnavailable || !policyDraft || !offTopicPolicy ? (
              <div
                data-testid="admin-offtopic-policy-empty"
                className="rounded-tile border border-[var(--hairline)] bg-[var(--bg-surface-tint)] px-4 py-5 text-[12.5px] text-[var(--ink-secondary)]"
              >
                {tx({
                  "zh-CN":
                    "非工作行为策略接口暂未激活，系统当前沿用默认安全护栏。",
                  "zh-HK":
                    "非工作行為策略介面暫未啟用，系統目前沿用預設安全護欄。",
                  en: "Boundary policy configuration endpoint is unavailable; default guardrails remain enforced.",
                })}
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2.5">
                  <label className="rounded-tile border border-[var(--hairline)] bg-[var(--bg-surface-tint)] p-2.5 space-y-1">
                    <span className="block text-[11px] font-medium text-[var(--ink-secondary)]">
                      {tx({
                        "zh-CN": "日 L1 提醒阈值",
                        "zh-HK": "日 L1 提醒閾值",
                        en: "Daily L1 Remind",
                      })}
                    </span>
                    {isAdmin ? (
                      <input
                        type="number"
                        min={1}
                        max={100}
                        data-testid="offtopic-threshold-daily-remind"
                        value={policyDraft.daily_remind_threshold}
                        onChange={(e) => {
                          setPolicyDraft({
                            ...policyDraft,
                            daily_remind_threshold: clampThreshold(
                              e.target.value,
                              policyDraft.daily_remind_threshold,
                            ),
                          });
                          setPolicyFeedback(null);
                        }}
                        className="aios-input h-8 w-full px-2.5 font-mono-code text-[13px] font-semibold tabular-nums"
                      />
                    ) : (
                      <div className="font-mono-code text-[16px] font-semibold text-[var(--ink-primary)] tabular-nums">
                        {policyDraft.daily_remind_threshold}
                      </div>
                    )}
                  </label>

                  <label className="rounded-tile border border-[var(--hairline)] bg-[var(--bg-surface-tint)] p-2.5 space-y-1">
                    <span className="block text-[11px] font-medium text-[var(--ink-secondary)]">
                      {tx({
                        "zh-CN": "日 L3 上报阈值",
                        "zh-HK": "日 L3 上報閾值",
                        en: "Daily L3 Escalate",
                      })}
                    </span>
                    {isAdmin ? (
                      <input
                        type="number"
                        min={1}
                        max={100}
                        data-testid="offtopic-threshold-daily-escalate"
                        value={policyDraft.daily_escalate_threshold}
                        onChange={(e) => {
                          setPolicyDraft({
                            ...policyDraft,
                            daily_escalate_threshold: clampThreshold(
                              e.target.value,
                              policyDraft.daily_escalate_threshold,
                            ),
                          });
                          setPolicyFeedback(null);
                        }}
                        className="aios-input h-8 w-full px-2.5 font-mono-code text-[13px] font-semibold tabular-nums"
                      />
                    ) : (
                      <div className="font-mono-code text-[16px] font-semibold text-[var(--ink-primary)] tabular-nums">
                        {policyDraft.daily_escalate_threshold}
                      </div>
                    )}
                  </label>

                  <label className="rounded-tile border border-[var(--hairline)] bg-[var(--bg-surface-tint)] p-2.5 space-y-1">
                    <span className="block text-[11px] font-medium text-[var(--ink-secondary)]">
                      {tx({
                        "zh-CN": "7 日累计上报阈值",
                        "zh-HK": "7 日累計上報閾值",
                        en: "7-Day L3 Escalate",
                      })}
                    </span>
                    {isAdmin ? (
                      <input
                        type="number"
                        min={1}
                        max={500}
                        data-testid="offtopic-threshold-seven-day"
                        value={policyDraft.seven_day_escalate_threshold}
                        onChange={(e) => {
                          setPolicyDraft({
                            ...policyDraft,
                            seven_day_escalate_threshold: clampThreshold(
                              e.target.value,
                              policyDraft.seven_day_escalate_threshold,
                              500,
                            ),
                          });
                          setPolicyFeedback(null);
                        }}
                        className="aios-input h-8 w-full px-2.5 font-mono-code text-[13px] font-semibold tabular-nums"
                      />
                    ) : (
                      <div className="font-mono-code text-[16px] font-semibold text-[var(--ink-primary)] tabular-nums">
                        {policyDraft.seven_day_escalate_threshold}
                      </div>
                    )}
                  </label>

                  <label className="rounded-tile border border-[var(--hairline)] bg-[var(--bg-surface-tint)] p-2.5 space-y-1">
                    <span className="block text-[11px] font-medium text-[var(--ink-secondary)]">
                      {tx({
                        "zh-CN": "日桌面越界上报阈值",
                        "zh-HK": "日桌面越界上報閾值",
                        en: "Daily Local Auto Escalate",
                      })}
                    </span>
                    {isAdmin ? (
                      <input
                        type="number"
                        min={1}
                        max={100}
                        data-testid="offtopic-threshold-local-auto"
                        value={policyDraft.daily_local_auto_escalate_threshold}
                        onChange={(e) => {
                          setPolicyDraft({
                            ...policyDraft,
                            daily_local_auto_escalate_threshold: clampThreshold(
                              e.target.value,
                              policyDraft.daily_local_auto_escalate_threshold,
                            ),
                          });
                          setPolicyFeedback(null);
                        }}
                        className="aios-input h-8 w-full px-2.5 font-mono-code text-[13px] font-semibold tabular-nums"
                      />
                    ) : (
                      <div className="font-mono-code text-[16px] font-semibold text-[var(--ink-primary)] tabular-nums">
                        {policyDraft.daily_local_auto_escalate_threshold}
                      </div>
                    )}
                  </label>
                </div>

                {/* Work App Allowlist */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="aios-micro-label">
                      {tx({
                        "zh-CN": "桌面办公应用白名单",
                        "zh-HK": "桌面辦公應用白名單",
                        en: "Work App Allowlist",
                      })}
                    </span>
                    <span className="font-mono-code text-[10.5px] text-[var(--ink-muted)] tabular-nums">
                      {policyDraft.app_allowlist.length}
                    </span>
                  </div>

                  <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto rounded-tile border border-[var(--hairline)] bg-[var(--bg-surface-tint)] p-2">
                    {policyDraft.app_allowlist.length === 0 ? (
                      <span className="text-[11.5px] text-[var(--ink-muted)]">
                        {tx({
                          "zh-CN": "尚未配置允许的桌面应用。",
                          "zh-HK": "尚未配置允許的桌面應用。",
                          en: "No work applications allowlisted.",
                        })}
                      </span>
                    ) : (
                      policyDraft.app_allowlist.map((appName) => (
                        <span
                          key={appName}
                          className="inline-flex items-center gap-1 rounded-xs border border-[var(--hairline-strong)] bg-[var(--bg-surface)] px-2 py-0.5 font-mono-code text-[11px] text-[var(--ink-primary)]"
                        >
                          <span>{appName}</span>
                          {isAdmin && (
                            <button
                              type="button"
                              onClick={() => handleRemoveAllowlistApp(appName)}
                              aria-label={tx(
                                {
                                  "zh-CN": "移除允许应用 {app}",
                                  "zh-HK": "移除允許應用 {app}",
                                  en: "Remove allowlisted app {app}",
                                },
                                { app: appName },
                              )}
                              className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full text-[var(--ink-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--status-crimson)] cursor-pointer"
                            >
                              <X className="h-2.5 w-2.5" />
                            </button>
                          )}
                        </span>
                      ))
                    )}
                  </div>

                  {isAdmin && (
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={newAllowAppInput}
                        data-testid="offtopic-allowlist-input"
                        onChange={(e) => setNewAllowAppInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            handleAddAllowlistApp();
                          }
                        }}
                        placeholder={tx({
                          "zh-CN": "添加应用名称或 Bundle ID（如 Excel）…",
                          "zh-HK": "新增應用名稱或 Bundle ID（如 Excel）…",
                          en: "Add work app or bundle ID (e.g. Excel)…",
                        })}
                        className="aios-input h-8 min-w-0 flex-1 px-2.5 font-mono-code text-[11.5px] placeholder:font-sans"
                      />
                      <Button
                        size="sm"
                        variant="secondary"
                        data-testid="offtopic-allowlist-add"
                        disabled={!newAllowAppInput.trim()}
                        onClick={handleAddAllowlistApp}
                      >
                        <Plus className="h-3.5 w-3.5" />
                        <span>
                          {tx({
                            "zh-CN": "添加",
                            "zh-HK": "新增",
                            en: "Add",
                          })}
                        </span>
                      </Button>
                    </div>
                  )}
                </div>

                {/* Role-to-Role Escalation Routing Summary */}
                {routingRuleEntries.length > 0 && (
                  <div className="space-y-1.5">
                    <div className="aios-micro-label">
                      {tx({
                        "zh-CN": "职级升级汇报链",
                        "zh-HK": "職級升級匯報鏈",
                        en: "Role Escalation Routing",
                      })}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {routingRuleEntries.slice(0, 6).map(([fromRole, targets]) => (
                        <span
                          key={fromRole}
                          className="rounded-xs border border-[var(--hairline)] bg-[var(--bg-surface-tint)] px-2 py-0.5 font-mono-code text-[10.5px] text-[var(--ink-secondary)]"
                        >
                          {fromRole} → {targets.join(", ")}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {!policyUnavailable && offTopicPolicy && policyDraft && (
            <div className="border-t border-[var(--hairline-subtle)] pt-3 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-[11px] text-[var(--ink-muted)] font-mono-code tabular-nums">
                  {offTopicPolicy.updated_by
                    ? `${offTopicPolicy.updated_by}${
                        offTopicPolicy.updated_at
                          ? ` · ${formatDateTime(offTopicPolicy.updated_at)}`
                          : ""
                      }`
                    : tx({
                        "zh-CN": "系统默认合规基线",
                        "zh-HK": "系統預設合規基線",
                        en: "System default policy",
                      })}
                </div>

                {isAdmin && (
                  <div className="flex items-center gap-1.5">
                    {isPolicyDirty && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={policySaving}
                        onClick={() => {
                          setPolicyDraft(draftFromPolicy(offTopicPolicy));
                          setPolicyFeedback(null);
                        }}
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        <span>
                          {tx({
                            "zh-CN": "重置",
                            "zh-HK": "重設",
                            en: "Reset",
                          })}
                        </span>
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="primary"
                      loading={policySaving}
                      disabled={!isPolicyDirty && !policySaving}
                      data-testid="offtopic-policy-save-btn"
                      onClick={() => void handleSaveOffTopicPolicy()}
                    >
                      <Save className="h-3.5 w-3.5" />
                      <span>
                        {tx({
                          "zh-CN": "保存策略",
                          "zh-HK": "儲存策略",
                          en: "Save Policy",
                        })}
                      </span>
                    </Button>
                  </div>
                )}
              </div>

              {policyFeedback && (
                <div
                  role={policyFeedback.kind === "error" ? "alert" : "status"}
                  data-testid="offtopic-policy-feedback"
                  className={[
                    "rounded-sm px-2.5 py-1.5 text-[11.5px]",
                    policyFeedback.kind === "success"
                      ? "border border-[var(--status-emerald-border)] bg-[var(--status-emerald-wash)] text-[var(--status-emerald)]"
                      : "border border-[var(--status-crimson-border)] bg-[var(--status-crimson-wash)] text-[var(--status-crimson)]",
                  ].join(" ")}
                >
                  {policyFeedback.message}
                </div>
              )}
            </div>
          )}
        </section>
      </div>

      {/* System Resilience & Engine Health Bar (Admin-only, degrades silently if unavailable) */}
      {isAdmin && (systemHealth || systemHealthLoading) && (
        <section
          data-testid="admin-system-resilience-card"
          className="rounded-card border border-[var(--hairline)] bg-[var(--bg-surface)] p-4 sm:p-5 shadow-[var(--shadow-card)] space-y-3.5"
        >
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm border border-[var(--hairline)] bg-[var(--bg-surface-tint)] text-[var(--accent-ink)]">
                <Activity className="h-3.5 w-3.5" strokeWidth={1.85} />
              </span>
              <div className="min-w-0">
                <h2 className="aios-display text-[14.5px] font-semibold text-[var(--ink-primary)]">
                  {tx({
                    "zh-CN": "系统韧性与引擎健康",
                    "zh-HK": "系統韌性與引擎健康",
                    en: "System Resilience & Engine Health",
                  })}
                </h2>
                <p className="text-[11.5px] text-[var(--ink-muted)]">
                  {tx({
                    "zh-CN":
                      "存储连接池、模型熔断保护、L1 响应缓存与实时事件通道状态",
                    "zh-HK":
                      "儲存連線池、模型熔斷保護、L1 回應快取與即時事件通道狀態",
                    en: "Storage pool mode, provider circuit breakers, L1 response cache, and live stream telemetry.",
                  })}
                </p>
              </div>
            </div>

            {systemHealth ? (
              <div className="flex flex-wrap items-center gap-2">
                <span
                  data-testid="system-health-status-badge"
                  className={[
                    "inline-flex items-center gap-1.5 rounded-xs border px-2 py-0.5 text-[11px] font-medium",
                    systemHealth.status === "ok" && systemHealth.storage_ok
                      ? "border-[var(--status-emerald-border)] bg-[var(--status-emerald-wash)] text-[var(--status-emerald)]"
                      : "border-[var(--status-amber-border)] bg-[var(--status-amber-wash)] text-[var(--status-amber-ink)]",
                  ].join(" ")}
                >
                  <span
                    aria-hidden="true"
                    className={[
                      "h-1.5 w-1.5 rounded-full",
                      systemHealth.status === "ok" && systemHealth.storage_ok
                        ? "bg-[var(--status-emerald)]"
                        : "bg-[var(--status-amber)]",
                    ].join(" ")}
                  />
                  <span>
                    {systemHealth.status === "ok" && systemHealth.storage_ok
                      ? tx({
                          "zh-CN": "运行正常",
                          "zh-HK": "運行正常",
                          en: "Healthy",
                        })
                      : tx({
                          "zh-CN": "降级运行",
                          "zh-HK": "降級運行",
                          en: "Degraded",
                        })}
                  </span>
                </span>
                <span className="font-mono-code text-[11px] text-[var(--ink-muted)] tabular-nums">
                  {systemHealth.db_engine_mode} ·{" "}
                  {formatUptime(systemHealth.uptime_seconds)}
                </span>
              </div>
            ) : (
              <span className="text-[11.5px] text-[var(--ink-muted)]">
                {tx({
                  "zh-CN": "正在检查引擎健康状态…",
                  "zh-HK": "正在檢查引擎健康狀態…",
                  en: "Checking engine health…",
                })}
              </span>
            )}
          </div>

          {systemHealth && (
            <>
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
                <div className="rounded-tile border border-[var(--hairline)] bg-[var(--bg-surface-tint)] p-3">
                  <div className="aios-micro-label">
                    {tx({
                      "zh-CN": "存储引擎",
                      "zh-HK": "儲存引擎",
                      en: "Storage Engine",
                    })}
                  </div>
                  <div
                    data-testid="system-health-db-mode"
                    className="mt-1.5 truncate font-mono-code text-[12.5px] font-semibold text-[var(--ink-primary)]"
                    title={systemHealth.db_engine_mode}
                  >
                    {systemHealth.db_engine_mode}
                  </div>
                  <div className="mt-1.5 inline-flex items-center gap-1.5 text-[10.5px] text-[var(--ink-muted)]">
                    <span
                      aria-hidden="true"
                      className={[
                        "h-1.5 w-1.5 rounded-full",
                        systemHealth.storage_ok
                          ? "bg-[var(--status-emerald)]"
                          : "bg-[var(--status-crimson)]",
                      ].join(" ")}
                    />
                    <span>
                      {systemHealth.storage_ok
                        ? tx({
                            "zh-CN": "读写就绪",
                            "zh-HK": "讀寫就緒",
                            en: "Storage OK",
                          })
                        : tx({
                            "zh-CN": "存储异常",
                            "zh-HK": "儲存異常",
                            en: "Storage Fault",
                          })}
                    </span>
                  </div>
                </div>

                <div className="rounded-tile border border-[var(--hairline)] bg-[var(--bg-surface-tint)] p-3">
                  <div className="aios-micro-label">
                    {tx({
                      "zh-CN": "L1 响应缓存",
                      "zh-HK": "L1 回應快取",
                      en: "L1 Response Cache",
                    })}
                  </div>
                  <div
                    data-testid="system-health-l1-cache"
                    className="aios-kpi mt-1.5 text-[17px] font-semibold leading-none text-[var(--status-emerald)]"
                  >
                    {formatCachePercent(systemHealth.l1_cache.hit_ratio)}
                  </div>
                  <div className="mt-1.5 font-mono-code text-[10.5px] text-[var(--ink-muted)] tabular-nums">
                    {formatCompactCount(systemHealth.l1_cache.tokens_saved)} tok
                    {" · "}
                    {systemHealth.l1_cache.entries}/
                    {systemHealth.l1_cache.max_entries}
                  </div>
                </div>

                <div className="rounded-tile border border-[var(--hairline)] bg-[var(--bg-surface-tint)] p-3">
                  <div className="aios-micro-label">
                    {tx({
                      "zh-CN": "实时 SSE 订阅",
                      "zh-HK": "即時 SSE 訂閱",
                      en: "Active SSE Streams",
                    })}
                  </div>
                  <div
                    data-testid="system-health-sse-count"
                    className="aios-kpi mt-1.5 text-[17px] font-semibold leading-none text-[var(--ink-primary)]"
                  >
                    {systemHealth.active_sse_subscribers}
                  </div>
                  <div className="mt-1.5 font-mono-code text-[10.5px] text-[var(--ink-muted)] tabular-nums">
                    {tx({
                      "zh-CN": "限流拦截",
                      "zh-HK": "限流攔截",
                      en: "Rate-limited",
                    })}
                    : {systemHealth.rate_limit_rejections}
                  </div>
                </div>

                <div className="rounded-tile border border-[var(--hairline)] bg-[var(--bg-surface-tint)] p-3">
                  <div className="aios-micro-label">
                    {tx({
                      "zh-CN": "OTel GenAI 追踪",
                      "zh-HK": "OTel GenAI 追蹤",
                      en: "OTel GenAI",
                    })}
                  </div>
                  <div
                    data-testid="system-health-otel-status"
                    className="mt-1.5 inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-[var(--ink-primary)]"
                  >
                    <span
                      aria-hidden="true"
                      className={[
                        "h-1.5 w-1.5 rounded-full",
                        systemHealth.otel_genai_enabled
                          ? "bg-[var(--status-emerald)]"
                          : "bg-[var(--ink-muted)]",
                      ].join(" ")}
                    />
                    <span>
                      {systemHealth.otel_genai_enabled
                        ? tx({
                            "zh-CN": "已启用",
                            "zh-HK": "已啟用",
                            en: "Active",
                          })
                        : tx({
                            "zh-CN": "结构化日志",
                            "zh-HK": "結構化日誌",
                            en: "Log Fallback",
                          })}
                    </span>
                  </div>
                  <div className="mt-1.5 font-mono-code text-[10.5px] text-[var(--ink-muted)] tabular-nums">
                    {tx({
                      "zh-CN": "运行时长",
                      "zh-HK": "運行時長",
                      en: "Uptime",
                    })}
                    : {formatUptime(systemHealth.uptime_seconds)}
                  </div>
                </div>

                <div className="col-span-2 sm:col-span-1 rounded-tile border border-[var(--hairline)] bg-[var(--bg-surface-tint)] p-3">
                  <div className="aios-micro-label">
                    {tx({
                      "zh-CN": "多引擎容灾备援",
                      "zh-HK": "多引擎容災備援",
                      en: "Fallback Standby",
                    })}
                  </div>
                  <div
                    data-testid="system-health-fallback-status"
                    className="mt-1.5 inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-[var(--ink-primary)]"
                  >
                    <span
                      aria-hidden="true"
                      className={[
                        "h-1.5 w-1.5 rounded-full",
                        systemHealth.fallback_configured
                          ? "bg-[var(--status-emerald)]"
                          : "bg-[var(--ink-faint)]",
                      ].join(" ")}
                    />
                    <span>
                      {systemHealth.fallback_configured
                        ? tx({
                            "zh-CN": "备援就绪",
                            "zh-HK": "備援就緒",
                            en: "Fallback Ready",
                          })
                        : tx({
                            "zh-CN": "单引擎模式",
                            "zh-HK": "單引擎模式",
                            en: "Primary Only",
                          })}
                    </span>
                  </div>
                  <div className="mt-1.5 font-mono-code text-[10.5px] text-[var(--ink-muted)] tabular-nums">
                    {tx({
                      "zh-CN": "L1 节省",
                      "zh-HK": "L1 節省",
                      en: "L1 Saved",
                    })}
                    :{" "}
                    {formatEstimatedUsd(
                      systemHealth.l1_cache.estimated_usd_saved,
                    )}
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-1.5 border-t border-[var(--hairline-subtle)] pt-2.5">
                <span className="aios-micro-label mr-1">
                  {tx({
                    "zh-CN": "模型熔断器",
                    "zh-HK": "模型熔斷器",
                    en: "Provider Circuits",
                  })}
                </span>
                {systemHealth.provider_circuits.length === 0 ? (
                  <span className="inline-flex items-center gap-1.5 rounded-xs border border-[var(--hairline)] bg-[var(--bg-surface-tint)] px-2 py-0.5 text-[11px] text-[var(--ink-muted)]">
                    <span
                      aria-hidden="true"
                      className="h-1.5 w-1.5 rounded-full bg-[var(--status-emerald)]"
                    />
                    <span>
                      {tx({
                        "zh-CN": "所有主备模型通道闭合正常",
                        "zh-HK": "所有主備模型通道閉合正常",
                        en: "All provider circuits closed",
                      })}
                    </span>
                  </span>
                ) : (
                  systemHealth.provider_circuits.map((circuit) => {
                    const stateLabel =
                      circuit.state === "open"
                        ? tx({
                            "zh-CN": "已熔断",
                            "zh-HK": "已熔斷",
                            en: "Open",
                          })
                        : circuit.state === "half_open"
                          ? tx({
                              "zh-CN": "半开探测",
                              "zh-HK": "半開探測",
                              en: "Half-Open",
                            })
                          : tx({
                              "zh-CN": "闭合",
                              "zh-HK": "閉合",
                              en: "Closed",
                            });
                    return (
                      <span
                        key={circuit.provider}
                        data-testid={`circuit-pill-${circuit.provider}`}
                        className="inline-flex items-center gap-1.5 rounded-xs border border-[var(--hairline)] bg-[var(--bg-surface-tint)] px-2 py-0.5 font-mono-code text-[11px] text-[var(--ink-secondary)] tabular-nums"
                      >
                        <span
                          aria-hidden="true"
                          className={`h-1.5 w-1.5 rounded-full ${getCircuitDotClass(circuit.state)}`}
                        />
                        <span className="font-medium text-[var(--ink-primary)]">
                          {circuit.provider}
                        </span>
                        <span className="text-[var(--ink-muted)]">
                          {stateLabel}
                        </span>
                        {(circuit.failures > 0 ||
                          circuit.retry_in_seconds > 0) && (
                          <span className="text-[10.5px] text-[var(--status-amber-ink)]">
                            {circuit.failures} err
                            {circuit.retry_in_seconds > 0
                              ? ` · ${Math.ceil(circuit.retry_in_seconds)}s`
                              : ""}
                          </span>
                        )}
                      </span>
                    );
                  })
                )}
              </div>
            </>
          )}
        </section>
      )}

      {/* Filter Bar */}
      <section className="rounded-card border border-[var(--hairline)] bg-[var(--bg-surface)] p-4 shadow-[var(--shadow-card)]">
        <div className="flex flex-wrap items-center justify-between gap-3 min-w-0">
          <div className="flex min-w-0 w-full sm:w-auto flex-1 flex-wrap items-center gap-2">
            <span className="aios-micro-label inline-flex items-center gap-1.5">
              <Filter className="h-3.5 w-3.5" />
              <span>
                {tx({ "zh-CN": "状态", "zh-HK": "狀態", en: "Status" })}
              </span>
            </span>
            <div className="inline-flex max-w-full flex-wrap rounded-sm border border-[var(--hairline)] bg-[var(--bg-inset)] p-0.5">
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

            <div className="relative min-w-0 max-w-full w-full sm:w-auto">
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
                className="aios-select h-8 min-w-0 max-w-full w-full sm:w-auto px-2.5 pr-7 truncate"
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
              <ChevronDown
                className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--ink-muted)]"
                strokeWidth={1.85}
                aria-hidden="true"
              />
            </div>

            <div className="relative w-full min-w-0 max-w-full sm:w-auto sm:max-w-[260px]">
              <select
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
                aria-label={tx({
                  "zh-CN": "按事件分类筛选",
                  "zh-HK": "按事件分類篩選",
                  en: "Filter by category",
                })}
                className="aios-select h-8 w-full min-w-0 max-w-full sm:w-auto sm:max-w-[260px] truncate px-2.5 pr-7"
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
                    {localizeCategory(cat)} ({cat})
                  </option>
                ))}
              </select>
              <ChevronDown
                className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--ink-muted)]"
                strokeWidth={1.85}
                aria-hidden="true"
              />
            </div>

            <input
              type="text"
              value={subjectFilter}
              onChange={(e) => setSubjectFilter(e.target.value)}
              placeholder={tx({
                "zh-CN": "按员工主体筛选…",
                "zh-HK": "按員工主體篩選…",
                en: "Subject filter…",
              })}
              className="aios-input h-8 w-full min-w-0 sm:w-40 px-2.5 font-mono-code text-[12px] placeholder:font-sans"
            />
          </div>

          <Button
            size="sm"
            variant="secondary"
            loading={loading}
            onClick={() => {
              void loadData();
              void loadTelemetryAndQuotas(telemetryHours);
              void loadOffTopicPolicy();
            }}
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
                    "所有提示词越权试探、跨仓访问、非工作越界与越界操作均会实时脱敏记入此处。",
                  "zh-HK":
                    "所有提示詞越權試探、跨倉存取、非工作越界與越界操作均會即時脫敏記入此處。",
                  en: "All prompt boundary probes, cross-scope attempts, non-work escalations, and policy blocks are scrubbed and recorded here in real time.",
                })}
              </p>
            </div>
          ) : (
            <>
              <div className="divide-y divide-[var(--hairline-subtle)]">
                {events.map((ev) => {
                  const repeatedBurst = ev.metadata?.repeated_burst === true;
                  const rawPreview =
                    typeof ev.metadata?.preview === "string"
                      ? ev.metadata.preview
                      : null;
                  const isPrivacyRedacted =
                    ev.metadata?.privacy_redacted === true ||
                    rawPreview === "[REDACTED_PRIVACY_POLICY]";
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
                          <span
                            title={ev.category}
                            className="text-[13px] font-semibold text-[var(--ink-primary)]"
                          >
                            {localizeCategory(ev.category)}
                          </span>
                          <span className="rounded-xs border border-[var(--hairline)] bg-[var(--bg-surface-subtle)] px-2 py-0.5 font-mono-code text-[10.5px] font-medium text-[var(--ink-secondary)]">
                            {localizeDecision(ev.decision)}
                          </span>
                          {isPrivacyRedacted && (
                            <span
                              data-testid={`security-privacy-badge-${ev.id}`}
                              title={tx({
                                "zh-CN":
                                  "依据 PDPO/GDPR 隐私合规规则，已省略员工私人对话原文。",
                                "zh-HK":
                                  "依據 PDPO/GDPR 私隱合規規則，已省略員工私人對話原文。",
                                en: "Raw private chat text omitted per PDPO/GDPR compliance.",
                              })}
                              className="inline-flex items-center gap-1 rounded-xs border border-[var(--status-emerald-border)] bg-[var(--status-emerald-wash)] px-2 py-0.5 text-[10.5px] font-medium text-[var(--status-emerald)]"
                            >
                              <EyeOff className="h-3 w-3" />
                              <span>
                                {tx({
                                  "zh-CN": "PDPO/GDPR 隐私脱敏",
                                  "zh-HK": "PDPO/GDPR 私隱脫敏",
                                  en: "PDPO/GDPR Redacted",
                                })}
                              </span>
                            </span>
                          )}
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

                      {isPrivacyRedacted && (
                        <div
                          data-testid={`security-privacy-note-${ev.id}`}
                          className="flex items-start gap-2 rounded-sm border border-[var(--hairline)] bg-[var(--bg-surface-tint)] px-3 py-2 text-[11.5px] text-[var(--ink-secondary)]"
                        >
                          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--status-emerald)]" />
                          <span>
                            {tx({
                              "zh-CN":
                                "依据 PDPO/GDPR 隐私合规原则，原始私人内容已省略（[REDACTED_PRIVACY_POLICY]），仅保留行为分类与合规计数供主管审阅。",
                              "zh-HK":
                                "依據 PDPO/GDPR 私隱合規原則，原始私人內容已省略（[REDACTED_PRIVACY_POLICY]），僅保留行為分類與合規計數供主管審閱。",
                              en: "Raw private content is omitted ([REDACTED_PRIVACY_POLICY]) per PDPO/GDPR compliance; only category and aggregate counts are retained.",
                            })}
                          </span>
                        </div>
                      )}

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
