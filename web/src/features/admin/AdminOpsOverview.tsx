"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  Copy,
  Database,
  Layers,
  PauseCircle,
  Play,
  PlayCircle,
  RefreshCw,
  Server,
  ShieldAlert,
  ShieldCheck,
  UserCheck,
  UserX,
  Users,
} from "lucide-react";
import { isApiError, isStaleAuthError, type ApiError } from "@/lib/api-client";
import { formatShortDigest, sortWarehouses } from "@/lib/format";
import {
  useLocale,
  type LocaleVars,
  type TrilingualText,
} from "@/lib/i18n";
import { useSession } from "@/lib/session-context";
import {
  AccessNoticeCard,
  Button,
  SourceTag,
  StatusBadge,
} from "@/components/ui";
import {
  ExecutionTopologyRibbon,
  Interactive3DCard,
} from "@/components/kinetic";
import { ActionConfirmDialog } from "@/features/admin/ActionConfirmDialog";
import {
  fetchAssuranceAuditCheckpoint,
  fetchHealthz,
  fetchOperationsExceptions,
  fetchOperationsSummary,
  fetchReadyz,
  runDemoWorkerTick,
  updateSubjectSuspension,
  updateWriteControl,
  type HealthProbeResult,
} from "@/features/admin/api";
import type {
  AssuranceCheckpoint,
  ExceptionItem,
  OperationsSummary,
  ProposalState,
} from "@/lib/types";

const CANONICAL_PROPOSAL_STATES: readonly ProposalState[] = [
  "PROPOSED",
  "QUEUED",
  "SENDING",
  "VERIFYING",
  "CHECKING",
  "OUTCOME_UNKNOWN",
  "NEEDS_OPERATOR",
  "VERIFIED",
  "REJECTED",
];

const STATE_DOT_TONE: Record<ProposalState, string> = {
  PROPOSED: "bg-[var(--status-amber)]",
  QUEUED: "bg-[var(--accent)]",
  SENDING: "bg-[var(--accent)]",
  VERIFYING: "bg-[var(--accent)]",
  CHECKING: "bg-[var(--status-amber)]",
  OUTCOME_UNKNOWN: "bg-[var(--status-amber)]",
  NEEDS_OPERATOR: "bg-[var(--status-crimson)]",
  VERIFIED: "bg-[var(--status-emerald)]",
  REJECTED: "bg-[var(--status-crimson)]",
};

function inferDominantTopologyState(
  counts: Record<string, number>,
): ProposalState {
  const priority: readonly ProposalState[] = [
    "NEEDS_OPERATOR",
    "OUTCOME_UNKNOWN",
    "CHECKING",
    "VERIFYING",
    "SENDING",
    "QUEUED",
    "PROPOSED",
    "VERIFIED",
    "REJECTED",
  ];
  for (const state of priority) {
    if ((counts[state] ?? 0) > 0) return state;
  }
  return "PROPOSED";
}

function inferActivePipelineState(
  counts: Record<string, number>,
): ProposalState {
  const order: readonly ProposalState[] = [
    "CHECKING",
    "VERIFYING",
    "SENDING",
    "QUEUED",
  ];
  for (const state of order) {
    if ((counts[state] ?? 0) > 0) return state;
  }
  return "QUEUED";
}

interface InlineFeedback {
  kind: "success" | "warning" | "error";
  text?: TrilingualText;
  vars?: LocaleVars;
  apiError?: ApiError;
  requestId?: string | null;
}

interface CheckpointUnavailableState {
  text?: TrilingualText;
  apiError?: ApiError;
}

export function AdminOpsOverview() {
  const {
    actor,
    demoConfig,
    canAccessAdminOps,
    canManagePeople,
    authGeneration,
    handleAccessChanged,
  } = useSession();
  const {
    t,
    tx,
    formatTimeOnly,
    localizeStatus,
    localizeRole,
    localizeError,
  } = useLocale();

  const [healthz, setHealthz] = useState<HealthProbeResult | null>(null);
  const [readyz, setReadyz] = useState<HealthProbeResult | null>(null);
  const [summary, setSummary] = useState<OperationsSummary | null>(null);
  const [exceptionPreview, setExceptionPreview] = useState<ExceptionItem[]>([]);
  const [hasMoreExceptions, setHasMoreExceptions] = useState(false);

  const [checkpoint, setCheckpoint] = useState<AssuranceCheckpoint | null>(
    null,
  );
  const [checkpointUnavailable, setCheckpointUnavailable] =
    useState<CheckpointUnavailableState | null>(null);

  const [loading, setLoading] = useState(false);
  const [opsError, setOpsError] = useState<ApiError | null>(null);

  // Selected state for topology schematic inspection
  const [manualTopologyState, setManualTopologyState] =
    useState<ProposalState | null>(null);

  // Write control confirmation state
  const [writeConfirmTarget, setWriteConfirmTarget] = useState<boolean | null>(
    null,
  );
  const [writeControlBusy, setWriteControlBusy] = useState(false);
  const [writeControlFeedback, setWriteControlFeedback] =
    useState<InlineFeedback | null>(null);

  // Demo worker tick state
  const [workerTickBusy, setWorkerTickBusy] = useState(false);
  const [workerTickFeedback, setWorkerTickFeedback] = useState<{
    worked: boolean;
    at: number;
  } | null>(null);
  const [workerTickError, setWorkerTickError] = useState<ApiError | null>(null);

  // Subject suspension state
  const [suspendSubjectInput, setSuspendSubjectInput] = useState("");
  const [suspendConfirm, setSuspendConfirm] = useState<{
    subject: string;
    suspended: boolean;
  } | null>(null);
  const [suspendBusy, setSuspendBusy] = useState(false);
  const [suspendFeedback, setSuspendFeedback] =
    useState<InlineFeedback | null>(null);

  // Copy feedback for checkpoint digest
  const [copiedHash, setCopiedHash] = useState(false);

  const isAdmin = actor?.role === "admin";
  const canRunDemoTick = Boolean(
    demoConfig?.enabled &&
      actor?.role === "admin" &&
      actor?.grants.includes("operations.manage"),
  );
  const hasAuditGrant = Boolean(actor?.grants.includes("assurance.audit"));

  const loadAllOpsData = useCallback(
    async (signal?: AbortSignal) => {
      if (!canAccessAdminOps) return;
      setLoading(true);
      setOpsError(null);
      setCheckpointUnavailable(null);
      try {
        // Always populate real /healthz & /readyz probes even if DB/ops endpoints fail (e.g. 503)
        const [hz, rz] = await Promise.all([
          fetchHealthz(signal),
          fetchReadyz(signal),
        ]);
        if (signal?.aborted) return;
        setHealthz(hz);
        setReadyz(rz);

        const [summaryRes, exceptionsRes] = await Promise.all([
          fetchOperationsSummary(signal),
          fetchOperationsExceptions({ limit: 5 }, signal),
        ]);
        if (signal?.aborted) return;
        setSummary(summaryRes);
        setExceptionPreview(exceptionsRes.items);
        setHasMoreExceptions(exceptionsRes.next !== null);

        if (hasAuditGrant) {
          try {
            const cp = await fetchAssuranceAuditCheckpoint(signal);
            if (!signal?.aborted) setCheckpoint(cp);
          } catch (cpErr) {
            if (isStaleAuthError(cpErr)) return;
            if (cpErr instanceof DOMException && cpErr.name === "AbortError") {
              return;
            }
            setCheckpoint(null);
            if (isApiError(cpErr)) {
              setCheckpointUnavailable(
                cpErr.status === 503
                  ? {
                      text: {
                        "zh-CN":
                          "受控预审连接器当前未启用，暂不生成审计检查点。",
                        "zh-HK":
                          "受控預審連接器目前未啟用，暫不產生稽核檢查點。",
                        en: "Assurance review connector is currently disabled; no audit checkpoint is generated.",
                      },
                    }
                  : { apiError: cpErr },
              );
            }
          }
        } else {
          setCheckpoint(null);
        }
      } catch (err) {
        if (isStaleAuthError(err)) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (isApiError(err)) {
          if (err.code === "ACCESS_CHANGED") {
            setSummary(null);
            setExceptionPreview([]);
            setCheckpoint(null);
            void handleAccessChanged();
          }
          setOpsError(err);
        }
      } finally {
        setLoading(false);
      }
    },
    [canAccessAdminOps, hasAuditGrant, handleAccessChanged],
  );

  useEffect(() => {
    setHealthz(null);
    setReadyz(null);
    setSummary(null);
    setExceptionPreview([]);
    setHasMoreExceptions(false);
    setCheckpoint(null);
    setCheckpointUnavailable(null);
    setOpsError(null);
    setManualTopologyState(null);
    setWriteConfirmTarget(null);
    setWriteControlFeedback(null);
    setWorkerTickFeedback(null);
    setWorkerTickError(null);
    setSuspendSubjectInput("");
    setSuspendConfirm(null);
    setSuspendFeedback(null);

    if (!canAccessAdminOps) return;

    const controller = new AbortController();
    void loadAllOpsData(controller.signal);
    return () => {
      controller.abort();
    };
  }, [authGeneration, canAccessAdminOps, loadAllOpsData]);

  const totalProposals = useMemo(() => {
    if (!summary) return 0;
    return Object.values(summary.proposals_by_state).reduce(
      (acc, count) => acc + count,
      0,
    );
  }, [summary]);

  const proposedCount = summary?.proposals_by_state.PROPOSED ?? 0;

  const inFlightCount = useMemo(() => {
    if (!summary) return 0;
    return (
      (summary.proposals_by_state.QUEUED ?? 0) +
      (summary.proposals_by_state.SENDING ?? 0) +
      (summary.proposals_by_state.VERIFYING ?? 0) +
      (summary.proposals_by_state.CHECKING ?? 0)
    );
  }, [summary]);

  const exceptionCount = useMemo(() => {
    if (!summary) return 0;
    return (
      (summary.proposals_by_state.NEEDS_OPERATOR ?? 0) +
      (summary.proposals_by_state.OUTCOME_UNKNOWN ?? 0)
    );
  }, [summary]);

  const inFlightSummaryLine = useMemo(() => {
    if (!summary || inFlightCount === 0) {
      return tx({
        "zh-CN": "当前无在途单据",
        "zh-HK": "目前無在途單據",
        en: "No proposals in flight",
      });
    }
    const parts: string[] = [];
    if ((summary.proposals_by_state.QUEUED ?? 0) > 0) {
      parts.push(
        tx(
          {
            "zh-CN": "待派发 {count}",
            "zh-HK": "待派發 {count}",
            en: "Queued {count}",
          },
          { count: summary.proposals_by_state.QUEUED ?? 0 },
        ),
      );
    }
    if ((summary.proposals_by_state.SENDING ?? 0) > 0) {
      parts.push(
        tx(
          {
            "zh-CN": "写入中 {count}",
            "zh-HK": "寫入中 {count}",
            en: "Sending {count}",
          },
          { count: summary.proposals_by_state.SENDING ?? 0 },
        ),
      );
    }
    const verifying =
      (summary.proposals_by_state.VERIFYING ?? 0) +
      (summary.proposals_by_state.CHECKING ?? 0);
    if (verifying > 0) {
      parts.push(
        tx(
          {
            "zh-CN": "核验中 {count}",
            "zh-HK": "核驗中 {count}",
            en: "Verifying {count}",
          },
          { count: verifying },
        ),
      );
    }
    return parts.join(" · ");
  }, [summary, inFlightCount, tx]);

  const activeTopologyState = useMemo<ProposalState>(() => {
    if (manualTopologyState) return manualTopologyState;
    if (!summary) return "PROPOSED";
    return inferDominantTopologyState(summary.proposals_by_state);
  }, [manualTopologyState, summary]);

  const formatProbeError = useCallback(
    (probe: HealthProbeResult, endpoint: string): string | null => {
      if (probe.ok) return null;
      if (probe.apiError) return localizeError(probe.apiError);
      if (probe.unreachable) {
        return tx(
          {
            "zh-CN": "无法连接到 {endpoint} 探针。",
            "zh-HK": "無法連線至 {endpoint} 探針。",
            en: "Unable to reach the {endpoint} probe.",
          },
          { endpoint },
        );
      }
      return probe.message ?? null;
    },
    [localizeError, tx],
  );

  const renderInlineFeedbackMessage = useCallback(
    (fb: InlineFeedback): string => {
      if (fb.apiError) return localizeError(fb.apiError);
      if (fb.text) return tx(fb.text, fb.vars);
      return "";
    },
    [localizeError, tx],
  );

  const handleConfirmWriteControl = useCallback(async () => {
    if (writeConfirmTarget === null || writeControlBusy) return;
    setWriteControlBusy(true);
    setWriteControlFeedback(null);
    try {
      await updateWriteControl(writeConfirmTarget);
      // Immediately re-read /v1/operations/summary to verify authoritative state
      const verifiedSummary = await fetchOperationsSummary();
      setSummary(verifiedSummary);
      setWriteConfirmTarget(null);
      setWriteControlFeedback({
        kind: verifiedSummary.writes_paused ? "warning" : "success",
        text: verifiedSummary.writes_paused
          ? {
              "zh-CN": "已确认租户 ERP 出站写入处于「已暂停」状态。",
              "zh-HK": "已確認租戶 ERP 出站寫入處於「已暫停」狀態。",
              en: "Confirmed: tenant ERP outbound writes are now Paused.",
            }
          : {
              "zh-CN": "已确认租户 ERP 出站写入处于「正常运行」状态。",
              "zh-HK": "已確認租戶 ERP 出站寫入處於「正常運作」狀態。",
              en: "Confirmed: tenant ERP outbound writes are now Active.",
            },
      });
    } catch (err) {
      if (isStaleAuthError(err)) return;
      setWriteConfirmTarget(null);
      if (isApiError(err)) {
        if (err.code === "ACCESS_CHANGED") {
          void handleAccessChanged();
        }
        setWriteControlFeedback({
          kind: "error",
          apiError: err,
          requestId: err.requestId,
        });
      }
    } finally {
      setWriteControlBusy(false);
    }
  }, [writeConfirmTarget, writeControlBusy, handleAccessChanged]);

  const handleRunWorkerTick = useCallback(async () => {
    if (!canRunDemoTick || workerTickBusy) return;
    setWorkerTickBusy(true);
    setWorkerTickError(null);
    try {
      const res = await runDemoWorkerTick();
      setWorkerTickFeedback({
        worked: Boolean(res.worked),
        at: Math.floor(Date.now() / 1000),
      });
      // Refresh both summary and exceptions preview immediately
      const [freshSummary, freshExceptions] = await Promise.all([
        fetchOperationsSummary(),
        fetchOperationsExceptions({ limit: 5 }),
      ]);
      setSummary(freshSummary);
      setExceptionPreview(freshExceptions.items);
      setHasMoreExceptions(freshExceptions.next !== null);
    } catch (err) {
      if (isStaleAuthError(err)) return;
      if (isApiError(err)) {
        if (err.code === "ACCESS_CHANGED") {
          void handleAccessChanged();
        }
        setWorkerTickError(err);
      }
    } finally {
      setWorkerTickBusy(false);
    }
  }, [canRunDemoTick, workerTickBusy, handleAccessChanged]);

  const trimmedSuspendSubject = suspendSubjectInput.trim();
  const isSelfSuspensionTarget =
    trimmedSuspendSubject.length > 0 &&
    actor?.subject === trimmedSuspendSubject;

  const handleRequestSuspension = useCallback(
    (suspended: boolean) => {
      if (!isAdmin) return;
      if (!trimmedSuspendSubject) {
        setSuspendFeedback({
          kind: "error",
          text: {
            "zh-CN": "请输入需要变更停权状态的员工主体标识（subject）。",
            "zh-HK": "請輸入需要變更停權狀態的員工主體識別碼（subject）。",
            en: "Enter an employee account identifier (subject) to update suspension status.",
          },
        });
        return;
      }
      if (trimmedSuspendSubject.length > 150) {
        setSuspendFeedback({
          kind: "error",
          text: {
            "zh-CN": "主体标识长度不得超过 150 个字符。",
            "zh-HK": "主體識別碼長度不得超過 150 個字元。",
            en: "Subject identifier must be 150 characters or fewer.",
          },
        });
        return;
      }
      if (actor?.subject === trimmedSuspendSubject) {
        setSuspendFeedback({
          kind: "error",
          text: {
            "zh-CN": "管理员不可停用或修改本人的访问停权状态。",
            "zh-HK": "管理員不可停用或修改本人的存取停權狀態。",
            en: "Administrators cannot suspend or alter their own account access.",
          },
        });
        return;
      }
      setSuspendFeedback(null);
      setSuspendConfirm({ subject: trimmedSuspendSubject, suspended });
    },
    [isAdmin, trimmedSuspendSubject, actor?.subject],
  );

  const handleConfirmSuspension = useCallback(async () => {
    if (!suspendConfirm || suspendBusy) return;
    setSuspendBusy(true);
    setSuspendFeedback(null);
    try {
      const res = await updateSubjectSuspension(
        suspendConfirm.subject,
        suspendConfirm.suspended,
      );
      setSuspendFeedback({
        kind: res.suspended ? "warning" : "success",
        text: res.suspended
          ? {
              "zh-CN": "已停用主体 {subject} 在租户 {tenant} 的访问权限。",
              "zh-HK": "已停用主體 {subject} 於租戶 {tenant} 的存取權限。",
              en: "Suspended access for {subject} in tenant {tenant}.",
            }
          : {
              "zh-CN": "已恢复主体 {subject} 在租户 {tenant} 的访问权限。",
              "zh-HK": "已恢復主體 {subject} 於租戶 {tenant} 的存取權限。",
              en: "Restored access for {subject} in tenant {tenant}.",
            },
        vars: {
          subject: suspendConfirm.subject,
          tenant: actor?.tenant ?? "",
        },
      });
      setSuspendConfirm(null);
    } catch (err) {
      if (isStaleAuthError(err)) return;
      setSuspendConfirm(null);
      if (isApiError(err)) {
        if (err.code === "ACCESS_CHANGED") {
          void handleAccessChanged();
        }
        setSuspendFeedback({
          kind: "error",
          apiError: err,
          requestId: err.requestId,
        });
      }
    } finally {
      setSuspendBusy(false);
    }
  }, [suspendConfirm, suspendBusy, actor?.tenant, handleAccessChanged]);

  const handleCopyHash = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedHash(true);
      window.setTimeout(() => setCopiedHash(false), 1800);
    } catch {
      // ignore clipboard errors in restricted environments
    }
  }, []);

  // Strict capability gate: never fetch ops endpoints for unauthorized roles
  if (!canAccessAdminOps) {
    return (
      <div
        className="mx-auto max-w-[820px] px-4 py-8 sm:px-6"
        data-testid="admin-ops-access-denied"
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
              "此控制台仅限具备 operations.manage 权限的主管（manager）或管理员（admin）访问。当前账号无权查看运维统计、异常队列或执行写入控制。",
            "zh-HK":
              "此主控台僅限具備 operations.manage 權限的主管（manager）或管理員（admin）存取。目前帳號無權檢視維運統計、異常佇列或執行寫入控制。",
            en: "This console is restricted to managers or administrators with operations.manage. Your account cannot view operational telemetry, the exceptions queue, or write controls.",
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
  const healthzErrorText = healthz ? formatProbeError(healthz, "/healthz") : null;
  const readyzErrorText = readyz ? formatProbeError(readyz, "/readyz") : null;

  return (
    <div
      className="mx-auto max-w-[1160px] space-y-5 px-4 py-6 sm:px-6 lg:py-7 pb-16"
      data-testid="admin-ops-page"
    >
      {/* Unified Porcelain / Obsidian Page-Header Card (matches /work & /calendar) */}
      <section className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] p-5 sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-[20px] font-semibold tracking-[-0.02em] text-[var(--ink-primary)] leading-tight">
              {tx({
                "zh-CN": "运维监控中心",
                "zh-HK": "維運監控中心",
                en: "Operations Console",
              })}
            </h1>
            <p className="mt-1 text-[13px] text-[var(--ink-secondary)]">
              {tx({
                "zh-CN":
                  "实时核验核心服务健康、提案流转分布与 ERP 出站写入控制。",
                "zh-HK":
                  "即時核驗核心服務健康、提案流轉分佈與 ERP 出站寫入控制。",
                en: "Monitor core service health, proposal pipeline distribution, and ERP outbound write controls.",
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
              <span>{actor ? localizeRole(actor.role) : "—"}</span>
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <Link
              href="/admin/exceptions"
              data-testid="ops-exceptions-link"
              className={[
                "inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[12.5px] font-medium transition-all duration-[150ms]",
                exceptionCount > 0
                  ? "bg-[var(--status-amber-wash)] text-[var(--status-amber-ink)] hover:opacity-90"
                  : "bg-[var(--bg-surface-subtle)] text-[var(--ink-primary)] hover:bg-[var(--bg-hover)]",
              ].join(" ")}
            >
              <AlertTriangle className="h-3.5 w-3.5" strokeWidth={1.85} />
              <span>
                {tx({
                  "zh-CN": "异常单据队列",
                  "zh-HK": "異常單據佇列",
                  en: "Exceptions Queue",
                })}
              </span>
              <span
                className={[
                  "inline-flex min-w-[1.25rem] items-center justify-center rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums leading-none",
                  exceptionCount > 0
                    ? "bg-[var(--status-amber)]/15 text-[var(--status-amber-ink)]"
                    : "bg-[var(--bg-surface)] text-[var(--ink-secondary)] shadow-[var(--shadow-subtle)]",
                ].join(" ")}
              >
                {exceptionCount}
              </span>
              <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.85} />
            </Link>

            {canManagePeople && (
              <Link
                href="/admin/people"
                className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium text-[var(--accent-ink)] hover:bg-[var(--accent-wash)] transition-colors duration-[150ms]"
              >
                <Users className="h-3.5 w-3.5" strokeWidth={1.85} />
                <span>{t("shell.nav.people")}</span>
              </Link>
            )}

            <Button
              size="sm"
              pill
              variant="secondary"
              loading={loading}
              data-testid="ops-refresh-btn"
              onClick={() => void loadAllOpsData()}
            >
              <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.85} />
              <span>
                {tx({
                  "zh-CN": "刷新快照",
                  "zh-HK": "重新整理快照",
                  en: "Refresh Snapshot",
                })}
              </span>
            </Button>
          </div>
        </div>
      </section>

      {opsError && (
        <AccessNoticeCard
          error={opsError}
          onRetry={() => void loadAllOpsData()}
          backHref="/inbox"
        />
      )}

      {/* Section 1: Core Service Health Probes (/healthz & /readyz) — Sheen-Only Tiles */}
      <section data-testid="ops-health-panel" className="space-y-2.5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {/* /healthz */}
          <Interactive3DCard
            interactive={false}
            sheenIntensity="subtle"
            data-testid="probe-healthz"
            className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] p-5"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <div
                  className={[
                    "flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
                    healthz?.ok
                      ? "bg-[var(--status-emerald-wash)] text-[var(--status-emerald)]"
                      : healthz
                        ? "bg-[var(--status-amber-wash)] text-[var(--status-amber)]"
                        : "bg-[var(--bg-surface-subtle)] text-[var(--ink-secondary)]",
                  ].join(" ")}
                >
                  <Server className="h-4 w-4" strokeWidth={1.85} />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="text-[14.5px] font-semibold text-[var(--ink-primary)]">
                      {tx({
                        "zh-CN": "API 进程存活",
                        "zh-HK": "API 服務存活",
                        en: "API Liveness",
                      })}
                    </h2>
                    <span className="font-mono-code text-[11px] text-[var(--ink-muted)]">
                      /healthz
                    </span>
                  </div>
                  <p className="mt-1 text-[11.5px] text-[var(--ink-muted)] tabular-nums">
                    {healthz ? (
                      <span className="font-mono-code">
                        {`HTTP ${healthz.httpStatus || "ERR"} · ${healthz.status} · ${formatTimeOnly(healthz.checkedAt, { withSeconds: true })}`}
                      </span>
                    ) : (
                      tx({
                        "zh-CN": "正在探测服务存活…",
                        "zh-HK": "正在探測服務存活…",
                        en: "Probing API liveness…",
                      })
                    )}
                  </p>
                </div>
              </div>

              {healthz ? (
                <StatusBadge
                  status={healthz.ok ? "healthy" : "unavailable"}
                  label={
                    healthz.ok
                      ? tx({ "zh-CN": "正常", "zh-HK": "正常", en: "Healthy" })
                      : tx({
                          "zh-CN": "异常",
                          "zh-HK": "異常",
                          en: "Unhealthy",
                        })
                  }
                />
              ) : (
                <StatusBadge
                  status="PROPOSED"
                  label={tx({
                    "zh-CN": "探测中",
                    "zh-HK": "探測中",
                    en: "Probing",
                  })}
                  compact
                />
              )}
            </div>

            {healthzErrorText && (
              <p className="mt-2.5 rounded-sm bg-[var(--status-amber-wash)] px-3 py-1.5 text-[12px] text-[var(--status-amber-ink)]">
                {healthzErrorText}
              </p>
            )}
          </Interactive3DCard>

          {/* /readyz */}
          <Interactive3DCard
            interactive={false}
            sheenIntensity="subtle"
            data-testid="probe-readyz"
            className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] p-5"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <div
                  className={[
                    "flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
                    readyz?.ok
                      ? "bg-[var(--status-emerald-wash)] text-[var(--status-emerald)]"
                      : readyz
                        ? "bg-[var(--status-amber-wash)] text-[var(--status-amber)]"
                        : "bg-[var(--bg-surface-subtle)] text-[var(--ink-secondary)]",
                  ].join(" ")}
                >
                  <Database className="h-4 w-4" strokeWidth={1.85} />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="text-[14.5px] font-semibold text-[var(--ink-primary)]">
                      {tx({
                        "zh-CN": "数据库就绪状态",
                        "zh-HK": "資料庫就緒狀態",
                        en: "Database Readiness",
                      })}
                    </h2>
                    <span className="font-mono-code text-[11px] text-[var(--ink-muted)]">
                      /readyz
                    </span>
                  </div>
                  <p className="mt-1 text-[11.5px] text-[var(--ink-muted)] tabular-nums">
                    {readyz ? (
                      <span className="font-mono-code">
                        {`HTTP ${readyz.httpStatus || "ERR"} · ${readyz.status} · ${formatTimeOnly(readyz.checkedAt, { withSeconds: true })}`}
                      </span>
                    ) : (
                      tx({
                        "zh-CN": "正在探测数据库就绪…",
                        "zh-HK": "正在探測資料庫就緒…",
                        en: "Probing database readiness…",
                      })
                    )}
                  </p>
                </div>
              </div>

              {readyz ? (
                <StatusBadge
                  status={readyz.ok ? "healthy" : "unavailable"}
                  label={
                    readyz.ok
                      ? tx({ "zh-CN": "正常", "zh-HK": "正常", en: "Ready" })
                      : tx(
                          {
                            "zh-CN": "未就绪 ({code})",
                            "zh-HK": "未就緒 ({code})",
                            en: "Not Ready ({code})",
                          },
                          { code: readyz.httpStatus || "ERR" },
                        )
                  }
                />
              ) : (
                <StatusBadge
                  status="PROPOSED"
                  label={tx({
                    "zh-CN": "探测中",
                    "zh-HK": "探測中",
                    en: "Probing",
                  })}
                  compact
                />
              )}
            </div>

            {readyzErrorText && (
              <p className="mt-2.5 rounded-sm bg-[var(--status-amber-wash)] px-3 py-1.5 text-[12px] text-[var(--status-amber-ink)]">
                {readyzErrorText}
              </p>
            )}
          </Interactive3DCard>
        </div>

        <p className="px-1 text-[11.5px] text-[var(--ink-muted)]">
          {tx({
            "zh-CN":
              "上述探针仅检测平台 API 服务与主数据库连接状态，不代表外部 ERP 或上游连接器连通性；查阅具体单据时系统仍会实时复核对应业务模块权限。",
            "zh-HK":
              "上述探針僅檢測平台 API 服務與主資料庫連線狀態，不代表外部 ERP 或上游連接器連通性；查閱具體單據時系統仍會即時覆核對應業務模組權限。",
            en: "These probes check only the platform API service and primary database connection—not external ERP or upstream connectors. Opening any record re-verifies live module permissions.",
          })}
        </p>
      </section>

      {/* Section 2: ERP Write Control + 3-Hero Proposal State Overview + 9-State Compact Legend + Topology */}
      {summary && (
        <section className="space-y-5">
          {/* Write Control Hero Card (Sheen-Only Porcelain / Obsidian) */}
          <Interactive3DCard
            interactive={false}
            sheenIntensity="subtle"
            data-testid="write-control-card"
            className={[
              "rounded-card p-5 sm:p-6 shadow-[var(--shadow-card)]",
              summary.writes_paused
                ? "bg-[linear-gradient(135deg,var(--bg-surface)_0%,var(--status-crimson-wash)_100%)] ring-1 ring-[var(--status-crimson-border)]"
                : "bg-[var(--bg-surface)]",
            ].join(" ")}
          >
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3.5 min-w-0">
                <div
                  className={[
                    "mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full",
                    summary.writes_paused
                      ? "bg-[var(--status-crimson-wash)] text-[var(--status-crimson)]"
                      : "bg-[var(--status-emerald-wash)] text-[var(--status-emerald)]",
                  ].join(" ")}
                >
                  {summary.writes_paused ? (
                    <PauseCircle className="h-5 w-5" strokeWidth={1.85} />
                  ) : (
                    <ShieldCheck className="h-5 w-5" strokeWidth={1.85} />
                  )}
                </div>

                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <h2 className="text-[15.5px] font-semibold tracking-[-0.015em] text-[var(--ink-primary)]">
                      {summary.writes_paused
                        ? tx(
                            {
                              "zh-CN": "租户 {tenant} 的 ERP 出站写入已暂停",
                              "zh-HK": "租戶 {tenant} 的 ERP 出站寫入已暫停",
                              en: "ERP outbound writes paused for tenant {tenant}",
                            },
                            { tenant: actor?.tenant ?? "" },
                          )
                        : tx(
                            {
                              "zh-CN": "租户 {tenant} 的 ERP 出站写入通道已开启",
                              "zh-HK": "租戶 {tenant} 的 ERP 出站寫入通道已開啟",
                              en: "ERP outbound writes active for tenant {tenant}",
                            },
                            { tenant: actor?.tenant ?? "" },
                          )}
                    </h2>
                    <StatusBadge
                      status={summary.writes_paused ? "paused" : "healthy"}
                      label={
                        summary.writes_paused
                          ? tx({
                              "zh-CN": "已暂停",
                              "zh-HK": "已暫停",
                              en: "Paused",
                            })
                          : tx({
                              "zh-CN": "正常运行",
                              "zh-HK": "正常運作",
                              en: "Active",
                            })
                      }
                      compact
                    />
                  </div>
                  <p className="mt-1 text-[13px] text-[var(--ink-secondary)] leading-relaxed">
                    {summary.writes_paused
                      ? tx({
                          "zh-CN":
                            "所有已批准待派发提案将暂缓发往 ERP，直至管理员手动恢复；已发出单据的回执核验不受影响。",
                          "zh-HK":
                            "所有已批准待派發提案將暫緩發往 ERP，直至管理員手動恢復；已發出單據的回執核驗不受影響。",
                          en: "All approved queued proposals are held from dispatching to ERP until manually resumed by an administrator. Read-only receipt verification continues unaffected.",
                        })
                      : tx({
                          "zh-CN":
                            "已批准提案将由 Worker 正常派发至 ERP 并自动核验回执。",
                          "zh-HK":
                            "已批准提案將由 Worker 正常派發至 ERP 並自動核驗回執。",
                          en: "Approved proposals are dispatched to ERP by the outbox worker with automatic receipt verification.",
                        })}
                  </p>
                </div>
              </div>

              <div className="shrink-0">
                {isAdmin ? (
                  <Button
                    size="md"
                    pill
                    variant={summary.writes_paused ? "primary" : "danger"}
                    loading={writeControlBusy}
                    data-testid="write-control-toggle"
                    onClick={() => setWriteConfirmTarget(!summary.writes_paused)}
                  >
                    {summary.writes_paused ? (
                      <>
                        <PlayCircle className="h-4 w-4" strokeWidth={1.85} />
                        <span>{t("admin.ops.resumeWrites")}</span>
                      </>
                    ) : (
                      <>
                        <PauseCircle className="h-4 w-4" strokeWidth={1.85} />
                        <span>{t("admin.ops.pauseWrites")}</span>
                      </>
                    )}
                  </Button>
                ) : (
                  <span className="inline-flex items-center rounded-full bg-[var(--bg-surface-subtle)] px-3.5 py-1.5 text-[12px] text-[var(--ink-muted)]">
                    {tx({
                      "zh-CN": "仅管理员可切换写入开关",
                      "zh-HK": "僅管理員可切換寫入開關",
                      en: "Admin only",
                    })}
                  </span>
                )}
              </div>
            </div>

            {writeControlFeedback && (
              <div
                role="status"
                data-testid="write-control-feedback"
                className={[
                  "mt-4 flex items-center gap-2.5 rounded-tile px-3.5 py-2.5 text-[12.5px]",
                  writeControlFeedback.kind === "success"
                    ? "bg-[var(--status-emerald-wash)] text-[var(--status-emerald)]"
                    : writeControlFeedback.kind === "warning"
                      ? "bg-[var(--status-amber-wash)] text-[var(--status-amber-ink)]"
                      : "bg-[var(--status-crimson-wash)] text-[var(--status-crimson)]",
                ].join(" ")}
              >
                {writeControlFeedback.kind === "success" ? (
                  <CheckCircle2
                    className="h-4 w-4 shrink-0"
                    strokeWidth={1.85}
                  />
                ) : (
                  <AlertTriangle
                    className="h-4 w-4 shrink-0"
                    strokeWidth={1.85}
                  />
                )}
                <span>{renderInlineFeedbackMessage(writeControlFeedback)}</span>
                {writeControlFeedback.requestId && (
                  <span className="text-[11px] opacity-85">
                    {t("common.requestId")}:{" "}
                    <span className="font-mono-code">
                      {writeControlFeedback.requestId}
                    </span>
                  </span>
                )}
              </div>
            )}
          </Interactive3DCard>

          {/* Proposal State Overview: 3 Prominent Actionable Tiles + Calm 9-State Legend */}
          <div className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] p-5 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <h2 className="text-[15.5px] font-semibold tracking-[-0.01em] text-[var(--ink-primary)]">
                  {tx({
                    "zh-CN": "提案状态分布",
                    "zh-HK": "提案狀態分佈",
                    en: "Proposal Pipeline States",
                  })}
                </h2>
                <span className="text-[12px] text-[var(--ink-muted)] tabular-nums">
                  {tx(
                    {
                      "zh-CN": "共 {count} 条",
                      "zh-HK": "共 {count} 筆",
                      en: "{count} total",
                    },
                    { count: totalProposals },
                  )}
                </span>
              </div>
              <span className="text-[12px] text-[var(--ink-muted)]">
                {tx({
                  "zh-CN": "选择任一状态可在下方流转拓扑中聚焦查看",
                  "zh-HK": "選擇任一狀態可於下方流轉拓撲中聚焦檢視",
                  en: "Select any state to inspect its position in the execution topology below",
                })}
              </span>
            </div>

            {/* 3 Prominent Actionable Metric Tiles */}
            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
              {/* 1. Pending Approval */}
              <button
                type="button"
                onClick={() => setManualTopologyState("PROPOSED")}
                className={[
                  "group rounded-tile p-4 text-left transition-all duration-[160ms] cursor-pointer",
                  activeTopologyState === "PROPOSED"
                    ? "bg-[var(--bg-surface)] shadow-[var(--shadow-subtle)] ring-1 ring-[var(--accent-border)]"
                    : "bg-[var(--bg-surface-tint)] hover:bg-[var(--bg-surface-hover)] hover:shadow-[var(--shadow-subtle)]",
                ].join(" ")}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13px] font-medium text-[var(--ink-secondary)]">
                    {localizeStatus("PROPOSED")}
                  </span>
                  <span
                    className={[
                      "flex h-7 w-7 items-center justify-center rounded-full",
                      proposedCount > 0
                        ? "bg-[var(--status-amber-wash)] text-[var(--status-amber)]"
                        : "bg-[var(--bg-surface)] text-[var(--ink-muted)]",
                    ].join(" ")}
                  >
                    <Clock className="h-3.5 w-3.5" strokeWidth={1.85} />
                  </span>
                </div>
                <div
                  className={[
                    "mt-2 text-[28px] font-semibold tracking-[-0.03em] leading-none tabular-nums",
                    proposedCount > 0
                      ? "text-[var(--status-amber-ink)]"
                      : "text-[var(--ink-muted)]",
                  ].join(" ")}
                >
                  {proposedCount}
                </div>
                <div className="mt-1.5 text-[12px] text-[var(--ink-muted)]">
                  {proposedCount > 0
                    ? tx({
                        "zh-CN": "等待独立主管确认批准",
                        "zh-HK": "等待獨立主管確認批准",
                        en: "Awaiting independent manager approval",
                      })
                    : tx({
                        "zh-CN": "当前无待审批提案",
                        "zh-HK": "目前無待審批提案",
                        en: "No pending approvals",
                      })}
                </div>
              </button>

              {/* 2. Queued & In-Flight */}
              <button
                type="button"
                onClick={() =>
                  setManualTopologyState(
                    inferActivePipelineState(summary.proposals_by_state),
                  )
                }
                className={[
                  "group rounded-tile p-4 text-left transition-all duration-[160ms] cursor-pointer",
                  activeTopologyState === "QUEUED" ||
                  activeTopologyState === "SENDING" ||
                  activeTopologyState === "VERIFYING" ||
                  activeTopologyState === "CHECKING"
                    ? "bg-[var(--bg-surface)] shadow-[var(--shadow-subtle)] ring-1 ring-[var(--accent-border)]"
                    : "bg-[var(--bg-surface-tint)] hover:bg-[var(--bg-surface-hover)] hover:shadow-[var(--shadow-subtle)]",
                ].join(" ")}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13px] font-medium text-[var(--ink-secondary)]">
                    {tx({
                      "zh-CN": "待派发与执行中",
                      "zh-HK": "待派發與執行中",
                      en: "Queued & In-Flight",
                    })}
                  </span>
                  <span
                    className={[
                      "flex h-7 w-7 items-center justify-center rounded-full",
                      inFlightCount > 0
                        ? "bg-[var(--accent-wash)] text-[var(--accent-ink)]"
                        : "bg-[var(--bg-surface)] text-[var(--ink-muted)]",
                    ].join(" ")}
                  >
                    <Layers className="h-3.5 w-3.5" strokeWidth={1.85} />
                  </span>
                </div>
                <div
                  className={[
                    "mt-2 text-[28px] font-semibold tracking-[-0.03em] leading-none tabular-nums",
                    inFlightCount > 0
                      ? "text-[var(--accent)]"
                      : "text-[var(--ink-muted)]",
                  ].join(" ")}
                >
                  {inFlightCount}
                </div>
                <div className="mt-1.5 text-[12px] text-[var(--ink-muted)] truncate">
                  {inFlightSummaryLine}
                </div>
              </button>

              {/* 3. Exceptions Requiring Attention */}
              <Link
                href="/admin/exceptions"
                className={[
                  "group block rounded-tile p-4 transition-all duration-[160ms]",
                  exceptionCount > 0
                    ? "bg-[var(--status-crimson-wash)] ring-1 ring-[var(--status-crimson-border)] hover:brightness-[1.03]"
                    : "bg-[var(--bg-surface-tint)] hover:bg-[var(--bg-surface-hover)] hover:shadow-[var(--shadow-subtle)]",
                ].join(" ")}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13px] font-medium text-[var(--ink-secondary)]">
                    {tx({
                      "zh-CN": "需关注异常",
                      "zh-HK": "須關注異常",
                      en: "Needs Attention",
                    })}
                  </span>
                  <span
                    className={[
                      "flex h-7 w-7 items-center justify-center rounded-full",
                      exceptionCount > 0
                        ? "bg-[var(--bg-surface)] text-[var(--status-crimson)]"
                        : "bg-[var(--bg-surface)] text-[var(--ink-muted)]",
                    ].join(" ")}
                  >
                    <AlertTriangle className="h-3.5 w-3.5" strokeWidth={1.85} />
                  </span>
                </div>
                <div
                  className={[
                    "mt-2 text-[28px] font-semibold tracking-[-0.03em] leading-none tabular-nums",
                    exceptionCount > 0
                      ? "text-[var(--status-crimson)]"
                      : "text-[var(--ink-muted)]",
                  ].join(" ")}
                >
                  {exceptionCount}
                </div>
                <div className="mt-1.5 flex items-center justify-between text-[12px] text-[var(--ink-muted)]">
                  <span>
                    {exceptionCount > 0
                      ? tx({
                          "zh-CN": "含待确认或需人工核查",
                          "zh-HK": "含待確認或須人工核查",
                          en: "Unknown outcomes or operator review",
                        })
                      : tx({
                          "zh-CN": "无滞留异常单据",
                          "zh-HK": "無滯留異常單據",
                          en: "No stalled exceptions",
                        })}
                  </span>
                  <span className="inline-flex items-center gap-0.5 font-medium text-[var(--accent)] group-hover:translate-x-0.5 transition-transform">
                    <span>
                      {tx({
                        "zh-CN": "队列",
                        "zh-HK": "佇列",
                        en: "Queue",
                      })}
                    </span>
                    <ArrowRight className="h-3 w-3" strokeWidth={2} />
                  </span>
                </div>
              </Link>
            </div>

            {/* Calm Compact 9-State Breakdown Legend (AA-legible zeros, crimson REJECTED, all state-count-* testids preserved) */}
            <div
              data-testid="proposals-state-grid"
              className="mt-4 grid grid-cols-3 gap-1 rounded-tile bg-[var(--bg-surface-tint)] p-1.5 sm:grid-cols-5 lg:grid-cols-9"
            >
              {CANONICAL_PROPOSAL_STATES.map((stateKey) => {
                const count = summary.proposals_by_state[stateKey] ?? 0;
                const isExceptionState =
                  stateKey === "OUTCOME_UNKNOWN" ||
                  stateKey === "NEEDS_OPERATOR";
                const isSelected = activeTopologyState === stateKey;
                const tooltip = `${localizeStatus(stateKey)} (${stateKey})`;

                const itemClasses = [
                  "flex flex-col items-center justify-center rounded-sm px-2 py-2.5 text-center transition-all duration-[150ms]",
                  isSelected
                    ? "bg-[var(--bg-surface)] shadow-[var(--shadow-subtle)] ring-1 ring-[var(--accent-border)]"
                    : "hover:bg-[var(--bg-surface-hover)]",
                ].join(" ");

                const inner = (
                  <>
                    <div className="flex items-center justify-center gap-1.5">
                      <span
                        aria-hidden="true"
                        className={[
                          "h-1.5 w-1.5 shrink-0 rounded-full",
                          count > 0
                            ? STATE_DOT_TONE[stateKey]
                            : "bg-[var(--hairline-strong)]",
                        ].join(" ")}
                      />
                      <span
                        className={[
                          "text-[11.5px] whitespace-nowrap",
                          count > 0 || isSelected
                            ? "font-medium text-[var(--ink-primary)]"
                            : "text-[var(--ink-muted)]",
                        ].join(" ")}
                      >
                        {localizeStatus(stateKey, { compact: true })}
                      </span>
                    </div>
                    <span
                      data-testid={`state-count-${stateKey}`}
                      className={[
                        "mt-1 text-[15px] font-semibold leading-none tabular-nums",
                        count === 0
                          ? "text-[var(--ink-muted)]"
                          : stateKey === "NEEDS_OPERATOR" ||
                              stateKey === "REJECTED"
                            ? "text-[var(--status-crimson)]"
                            : stateKey === "OUTCOME_UNKNOWN" ||
                                stateKey === "PROPOSED"
                              ? "text-[var(--status-amber-ink)]"
                              : stateKey === "VERIFIED"
                                ? "text-[var(--status-emerald)]"
                                : "text-[var(--ink-primary)]",
                      ].join(" ")}
                    >
                      {count}
                    </span>
                  </>
                );

                if (isExceptionState) {
                  return (
                    <Link
                      key={stateKey}
                      href="/admin/exceptions"
                      title={tooltip}
                      className={itemClasses}
                    >
                      {inner}
                    </Link>
                  );
                }

                return (
                  <button
                    key={stateKey}
                    type="button"
                    title={tooltip}
                    onClick={() => setManualTopologyState(stateKey)}
                    className={`cursor-pointer ${itemClasses}`}
                  >
                    {inner}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Standalone ExecutionTopologyRibbon with Integrated headerRight Focus Control */}
          <ExecutionTopologyRibbon
            state={activeTopologyState}
            variant="auto"
            headerRight={
              <div className="flex flex-wrap items-center gap-2 text-[12px]">
                <span
                  title={activeTopologyState}
                  className="text-[var(--ink-muted)]"
                >
                  {tx({
                    "zh-CN": "当前聚焦：",
                    "zh-HK": "目前聚焦：",
                    en: "Focused: ",
                  })}
                  <strong className="font-medium text-[var(--ink-primary)]">
                    {localizeStatus(activeTopologyState)}
                  </strong>
                </span>
                {manualTopologyState && (
                  <Button
                    size="sm"
                    pill
                    variant="quiet"
                    onClick={() => setManualTopologyState(null)}
                    className="!h-6 !px-2 !text-[11.5px]"
                  >
                    {tx({
                      "zh-CN": "恢复自动聚焦",
                      "zh-HK": "恢復自動聚焦",
                      en: "Auto-focus",
                    })}
                  </Button>
                )}
              </div>
            }
          />
        </section>
      )}

      {/* Section 3: Local Demo Worker Tick (STRICTLY Demo + admin + operations.manage) */}
      {canRunDemoTick && (
        <section
          data-testid="demo-worker-panel"
          className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] p-5 sm:p-6"
        >
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2
                  title={tx({
                    "zh-CN": "本地演示队列步进触发器",
                    "zh-HK": "本地示範佇列步進觸發器",
                    en: "Local demo outbox worker trigger",
                  })}
                  className="text-[15.5px] font-semibold tracking-[-0.01em] text-[var(--ink-primary)]"
                >
                  {tx({
                    "zh-CN": "手动步进本地 Outbox Worker",
                    "zh-HK": "手動步進本地 Outbox Worker",
                    en: "Manual Local Outbox Worker Tick",
                  })}
                </h2>
                <SourceTag source="synthetic" />
              </div>
              <p className="mt-1 text-[13px] text-[var(--ink-secondary)] leading-relaxed">
                {tx({
                  "zh-CN":
                    "仅在本地演示环境下向管理员开放。每次点击推进一轮队列派发或回执核验，完成后自动刷新状态分布与异常队列。",
                  "zh-HK":
                    "僅於本地示範環境向管理員開放。每次點擊推進一輪佇列派發或回執核驗，完成後自動重新整理狀態分佈與異常佇列。",
                  en: "Available to administrators in local demo environments only. Each click advances one outbox dispatch or receipt check cycle and refreshes telemetry.",
                })}
              </p>
            </div>

            <div className="shrink-0">
              <Button
                size="md"
                pill
                variant="primary"
                loading={workerTickBusy}
                data-testid="worker-tick-btn"
                onClick={() => void handleRunWorkerTick()}
              >
                <Play className="h-3.5 w-3.5" strokeWidth={2} />
                <span>
                  {tx({
                    "zh-CN": "执行一次 Worker Tick",
                    "zh-HK": "執行一次 Worker Tick",
                    en: "Run Worker Tick",
                  })}
                </span>
              </Button>
            </div>
          </div>

          {workerTickFeedback && (
            <div
              role="status"
              data-testid="worker-tick-result"
              data-worked={String(workerTickFeedback.worked)}
              className={[
                "mt-4 flex flex-wrap items-center justify-between gap-2 rounded-tile px-3.5 py-2.5 text-[12.5px]",
                workerTickFeedback.worked
                  ? "bg-[var(--status-emerald-wash)] text-[var(--status-emerald)]"
                  : "bg-[var(--bg-surface-tint)] text-[var(--ink-secondary)]",
              ].join(" ")}
            >
              <div className="flex items-center gap-2">
                <CheckCircle2
                  className="h-4 w-4 shrink-0"
                  strokeWidth={1.85}
                />
                <span>
                  {workerTickFeedback.worked
                    ? tx({
                        "zh-CN":
                          "已推进 1 条队列任务，状态分布与异常预览已同步刷新。",
                        "zh-HK":
                          "已推進 1 筆佇列任務，狀態分佈與異常預覽已同步重新整理。",
                        en: "Advanced 1 queued job. Pipeline counts and exception preview refreshed.",
                      })
                    : tx({
                        "zh-CN":
                          "当前无待执行的队列任务（或租户 ERP 写入已暂停）。",
                        "zh-HK":
                          "目前無待執行的佇列任務（或租戶 ERP 寫入已暫停）。",
                        en: "No pending worker jobs right now (or tenant ERP writes are paused).",
                      })}
                </span>
              </div>
              <span className="font-mono-code text-[11.5px] opacity-85 tabular-nums">
                {formatTimeOnly(workerTickFeedback.at, { withSeconds: true })}
              </span>
            </div>
          )}

          {workerTickError && (
            <div className="mt-4">
              <AccessNoticeCard error={workerTickError} />
            </div>
          )}
        </section>
      )}

      {/* Section 4: Exceptions Quick Preview + Subject Suspension (2-Column Split) */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        {/* Recent Exceptions Preview */}
        <section className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] p-5 sm:p-6 lg:col-span-7 flex flex-col">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-[15.5px] font-semibold tracking-[-0.01em] text-[var(--ink-primary)]">
              {tx({
                "zh-CN": "待关注异常单据预览",
                "zh-HK": "待關注異常單據預覽",
                en: "Exceptions Queue Preview",
              })}
            </h2>
            <Link
              href="/admin/exceptions"
              className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12.5px] font-medium text-[var(--accent-ink)] hover:bg-[var(--accent-wash)] transition-colors"
            >
              <span>
                {tx({
                  "zh-CN": "完整队列",
                  "zh-HK": "完整佇列",
                  en: "Full Queue",
                })}
              </span>
              <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.85} />
            </Link>
          </div>

          {exceptionPreview.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 py-10 text-center">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--status-emerald-wash)] text-[var(--status-emerald)]">
                <CheckCircle2 className="h-5 w-5" strokeWidth={1.85} />
              </div>
              <div className="text-[13.5px] font-medium text-[var(--ink-primary)]">
                {tx({
                  "zh-CN": "一切平稳，暂无滞留异常",
                  "zh-HK": "一切平穩，暫無滯留異常",
                  en: "All clear — no stalled exceptions",
                })}
              </div>
              <p className="text-[12.5px] text-[var(--ink-muted)]">
                {tx({
                  "zh-CN": "授权仓库内没有待确认或需人工核查的单据。",
                  "zh-HK": "授權倉庫內沒有待確認或須人工核查的單據。",
                  en: "No unknown-outcome or operator-escalated proposals in your authorized warehouses.",
                })}
              </p>
            </div>
          ) : (
            <div className="mt-4 space-y-2">
              {exceptionPreview.map((item) => (
                <div
                  key={item.proposal_id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-tile bg-[var(--bg-surface-tint)] px-3.5 py-3 hover:bg-[var(--bg-surface-hover)] transition-colors duration-[140ms]"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Link
                        href={`/proposals/${encodeURIComponent(item.proposal_id)}`}
                        className="font-mono-code text-[13px] font-semibold text-[var(--ink-primary)] hover:text-[var(--accent)] hover:underline"
                      >
                        {item.proposal_id}
                      </Link>
                      <span className="rounded-full bg-[var(--bg-surface)] px-2 py-0.5 font-mono-code text-[11px] text-[var(--ink-secondary)] shadow-[var(--shadow-subtle)]">
                        {item.warehouse}
                      </span>
                    </div>
                    <div className="mt-1 text-[11.5px] text-[var(--ink-muted)] tabular-nums">
                      <span>
                        {tx(
                          {
                            "zh-CN": "核验轮次 {checks}/3",
                            "zh-HK": "核驗輪次 {checks}/3",
                            en: "Check {checks}/3",
                          },
                          { checks: item.checks },
                        )}
                      </span>
                      <span className="mx-1.5 text-[var(--ink-faint)]">·</span>
                      <span className="font-mono-code">
                        {item.last_event ?? "—"}
                      </span>
                    </div>
                  </div>
                  <StatusBadge status={item.state} compact />
                </div>
              ))}
              {hasMoreExceptions && (
                <div className="pt-2 text-right text-[12px] text-[var(--ink-muted)]">
                  {tx({
                    "zh-CN": "仅展示前 5 条，请前往异常队列翻页处理。",
                    "zh-HK": "僅顯示前 5 筆，請前往異常佇列翻頁處理。",
                    en: "Showing the first 5 items. Open the full queue to paginate and reconcile.",
                  })}
                </div>
              )}
            </div>
          )}
        </section>

        {/* Subject Suspension Card (admin only — no 3D tilt because it contains text input) */}
        <section
          data-testid="subject-suspension-panel"
          className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] p-5 sm:p-6 lg:col-span-5"
        >
          <h2 className="text-[15.5px] font-semibold tracking-[-0.01em] text-[var(--ink-primary)]">
            {tx({
              "zh-CN": "主体紧急停权控制",
              "zh-HK": "主體緊急停權控制",
              en: "Account Suspension Control",
            })}
          </h2>

          <div className="mt-3">
            {isAdmin ? (
              <div className="space-y-3.5">
                <p className="text-[12.5px] text-[var(--ink-secondary)] leading-relaxed">
                  {tx({
                    "zh-CN":
                      "按员工账号标识在本租户内立即停用或恢复访问权限，停权后将阻断全部请求及待派发提案；不可对本人操作。",
                    "zh-HK":
                      "按員工帳號識別碼於本租戶內立即停用或恢復存取權限，停權後將阻斷全部請求及待派發提案；不可對本人操作。",
                    en: "Immediately suspend or restore an employee's access within this tenant. Suspended accounts are blocked from API requests and pending proposal dispatches; self-suspension is prohibited.",
                  })}
                </p>

                <div>
                  <label
                    htmlFor="suspension-subject-input"
                    className="block text-[12.5px] font-medium text-[var(--ink-secondary)]"
                  >
                    {tx({
                      "zh-CN": "目标员工标识",
                      "zh-HK": "目標員工識別碼",
                      en: "Target Employee Subject",
                    })}
                  </label>
                  <input
                    id="suspension-subject-input"
                    type="text"
                    value={suspendSubjectInput}
                    onChange={(e) => {
                      setSuspendSubjectInput(e.target.value);
                      setSuspendFeedback(null);
                    }}
                    placeholder={tx({
                      "zh-CN": "例如 operator 或 viewer",
                      "zh-HK": "例如 operator 或 viewer",
                      en: "e.g. operator or viewer",
                    })}
                    aria-invalid={isSelfSuspensionTarget || undefined}
                    data-testid="suspension-subject-input"
                    className="mt-1.5 h-10 w-full rounded-sm border border-[var(--hairline-strong)] bg-[var(--bg-surface-tint)] px-3.5 font-mono-code text-[13px] text-[var(--ink-primary)] placeholder:font-sans placeholder:text-[var(--ink-faint)] focus:bg-[var(--bg-surface)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-ring)] focus:outline-none transition-all"
                  />
                  {isSelfSuspensionTarget && (
                    <p className="mt-1.5 text-[12px] text-[var(--status-crimson)]">
                      {tx({
                        "zh-CN": "管理员不可对当前登录的本人账号执行停权。",
                        "zh-HK": "管理員不可對目前登入的本人帳號執行停權。",
                        en: "Administrators cannot suspend their own signed-in account.",
                      })}
                    </p>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2 pt-0.5">
                  <Button
                    size="sm"
                    pill
                    variant="danger"
                    disabled={
                      !trimmedSuspendSubject ||
                      isSelfSuspensionTarget ||
                      suspendBusy
                    }
                    data-testid="suspension-suspend-btn"
                    onClick={() => handleRequestSuspension(true)}
                  >
                    <UserX className="h-3.5 w-3.5" strokeWidth={1.85} />
                    <span>
                      {tx({
                        "zh-CN": "停用访问",
                        "zh-HK": "停用存取",
                        en: "Suspend Access",
                      })}
                    </span>
                  </Button>
                  <Button
                    size="sm"
                    pill
                    variant="quiet"
                    disabled={
                      !trimmedSuspendSubject ||
                      isSelfSuspensionTarget ||
                      suspendBusy
                    }
                    data-testid="suspension-restore-btn"
                    onClick={() => handleRequestSuspension(false)}
                  >
                    <UserCheck className="h-3.5 w-3.5" strokeWidth={1.85} />
                    <span>
                      {tx({
                        "zh-CN": "恢复访问",
                        "zh-HK": "恢復存取",
                        en: "Restore Access",
                      })}
                    </span>
                  </Button>
                </div>

                {suspendFeedback && (
                  <div
                    role="status"
                    data-testid="suspension-feedback"
                    className={[
                      "rounded-tile px-3.5 py-2.5 text-[12.5px] leading-relaxed",
                      suspendFeedback.kind === "success"
                        ? "bg-[var(--status-emerald-wash)] text-[var(--status-emerald)]"
                        : suspendFeedback.kind === "warning"
                          ? "bg-[var(--status-amber-wash)] text-[var(--status-amber-ink)]"
                          : "bg-[var(--status-crimson-wash)] text-[var(--status-crimson)]",
                    ].join(" ")}
                  >
                    <span>{renderInlineFeedbackMessage(suspendFeedback)}</span>
                    {suspendFeedback.requestId && (
                      <span className="ml-2 text-[11px] opacity-85">
                        {t("common.requestId")}:{" "}
                        <span className="font-mono-code">
                          {suspendFeedback.requestId}
                        </span>
                      </span>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="flex items-start gap-2.5 rounded-tile bg-[var(--bg-surface-tint)] p-3.5 text-[12.5px] text-[var(--ink-secondary)] leading-relaxed">
                <ShieldAlert
                  className="mt-0.5 h-4 w-4 shrink-0 text-[var(--ink-muted)]"
                  strokeWidth={1.85}
                />
                <span>
                  {tx({
                    "zh-CN":
                      "主体停权操作仅限租户管理员执行；主管可查看运维监控与处置异常单据。",
                    "zh-HK":
                      "主體停權操作僅限租戶管理員執行；主管可檢視維運監控與處置異常單據。",
                    en: "Account suspension is restricted to tenant administrators. Managers may inspect operations telemetry and reconcile exceptions.",
                  })}
                </span>
              </div>
            )}
          </div>
        </section>
      </div>

      {/* Section 5: Assurance Audit Checkpoint (ONLY when actor holds assurance.audit) */}
      {hasAuditGrant && (
        <section
          data-testid="audit-checkpoint-panel"
          className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] p-5 sm:p-6"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--accent-wash)] text-[var(--accent-ink)]">
                <ShieldCheck className="h-4 w-4" strokeWidth={1.85} />
              </div>
              <h2 className="text-[15.5px] font-semibold tracking-[-0.01em] text-[var(--ink-primary)]">
                {tx({
                  "zh-CN": "受控预审审计签名检查点",
                  "zh-HK": "受控預審稽核簽章檢查點",
                  en: "Assurance Signed Audit Checkpoint",
                })}
              </h2>
            </div>
            <span className="text-[12px] text-[var(--ink-muted)]">
              {tx({
                "zh-CN": "只读审计元数据",
                "zh-HK": "唯讀稽核中繼資料",
                en: "Read-only audit metadata",
              })}
            </span>
          </div>

          <div className="mt-4">
            {checkpoint ? (
              <dl className="grid grid-cols-1 gap-3 text-[12.5px] sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-tile bg-[var(--bg-surface-tint)] p-3.5">
                  <dt className="text-[11.5px] text-[var(--ink-muted)]">
                    {tx({
                      "zh-CN": "检查点序号",
                      "zh-HK": "檢查點序號",
                      en: "Checkpoint Seq",
                    })}
                  </dt>
                  <dd className="mt-1.5 font-mono-code text-[16px] font-semibold text-[var(--ink-primary)] tabular-nums">
                    #{checkpoint.seq}
                  </dd>
                </div>
                <div className="rounded-tile bg-[var(--bg-surface-tint)] p-3.5">
                  <dt className="text-[11.5px] text-[var(--ink-muted)]">
                    {tx({
                      "zh-CN": "检查点类型",
                      "zh-HK": "檢查點類型",
                      en: "Checkpoint Type",
                    })}
                  </dt>
                  <dd className="mt-1.5 font-mono-code text-[12.5px] font-medium text-[var(--ink-primary)] break-all">
                    {checkpoint.type}
                  </dd>
                </div>
                <div className="rounded-tile bg-[var(--bg-surface-tint)] p-3.5">
                  <dt className="flex items-center justify-between text-[11.5px] text-[var(--ink-muted)]">
                    <span>
                      {tx({
                        "zh-CN": "链表摘要",
                        "zh-HK": "鏈表摘要",
                        en: "Chain Digest",
                      })}
                    </span>
                    <button
                      type="button"
                      onClick={() => void handleCopyHash(checkpoint.hash)}
                      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium text-[var(--accent-ink)] hover:bg-[var(--accent-wash)] transition-colors cursor-pointer"
                    >
                      <Copy className="h-3 w-3" />
                      <span>
                        {copiedHash ? t("common.copied") : t("common.copy")}
                      </span>
                    </button>
                  </dt>
                  <dd
                    title={checkpoint.hash}
                    className="mt-1.5 font-mono-code text-[12.5px] font-medium text-[var(--ink-primary)]"
                  >
                    {formatShortDigest(checkpoint.hash, 12, 8)}
                  </dd>
                </div>
                <div className="rounded-tile bg-[var(--bg-surface-tint)] p-3.5">
                  <dt className="text-[11.5px] text-[var(--ink-muted)]">
                    {tx({
                      "zh-CN": "密钥标识",
                      "zh-HK": "金鑰識別碼",
                      en: "Signing Key ID",
                    })}
                  </dt>
                  <dd
                    title={checkpoint.key_id}
                    className="mt-1.5 font-mono-code text-[12.5px] font-medium text-[var(--ink-primary)]"
                  >
                    {formatShortDigest(checkpoint.key_id, 10, 8)}
                  </dd>
                </div>
              </dl>
            ) : (
              <div className="rounded-tile bg-[var(--bg-surface-tint)] px-4 py-3 text-[13px] text-[var(--ink-muted)]">
                {checkpointUnavailable
                  ? checkpointUnavailable.apiError
                    ? localizeError(checkpointUnavailable.apiError)
                    : checkpointUnavailable.text
                      ? tx(checkpointUnavailable.text)
                      : ""
                  : tx({
                      "zh-CN": "正在获取审计签名检查点…",
                      "zh-HK": "正在取得稽核簽章檢查點…",
                      en: "Loading signed audit checkpoint…",
                    })}
              </div>
            )}
          </div>
        </section>
      )}

      {/* Write Control Confirmation Dialog */}
      <ActionConfirmDialog
        open={writeConfirmTarget !== null}
        onOpenChange={(open) => {
          if (!open && !writeControlBusy) setWriteConfirmTarget(null);
        }}
        destructive={writeConfirmTarget === true}
        loading={writeControlBusy}
        title={
          writeConfirmTarget
            ? tx({
                "zh-CN": "确认暂停租户 ERP 出站写入",
                "zh-HK": "確認暫停租戶 ERP 出站寫入",
                en: "Confirm Pause of ERP Outbound Writes",
              })
            : tx({
                "zh-CN": "确认恢复租户 ERP 出站写入",
                "zh-HK": "確認恢復租戶 ERP 出站寫入",
                en: "Confirm Resume of ERP Outbound Writes",
              })
        }
        description={
          writeConfirmTarget
            ? tx({
                "zh-CN":
                  "暂停后将阻断本租户所有已批准待派发提案向 ERP 发起出站写入，直至管理员再次手动恢复；已发送单据的只读回执核验不受影响。",
                "zh-HK":
                  "暫停後將阻斷本租戶所有已批准待派發提案向 ERP 發起出站寫入，直至管理員再次手動恢復；已發送單據的唯讀回執核驗不受影響。",
                en: "Pausing blocks all approved queued proposals in this tenant from dispatching outbound writes to ERP until manually resumed. Read-only receipt verification for already-sent items continues unaffected.",
              })
            : tx({
                "zh-CN":
                  "恢复后将允许本租户所有待派发提案按 Worker 调度继续写入 ERP，请确认当前上游 ERP 环境状态正常。",
                "zh-HK":
                  "恢復後將允許本租戶所有待派發提案按 Worker 排程繼續寫入 ERP，請確認目前上游 ERP 環境狀態正常。",
                en: "Resuming allows queued proposals in this tenant to dispatch to ERP on the worker schedule. Confirm upstream ERP health before continuing.",
              })
        }
        scopeSummary={tx(
          {
            "zh-CN": "租户 {tenant}（全部仓库）· 操作人可见仓库 {warehouses}",
            "zh-HK": "租戶 {tenant}（全部倉庫）· 操作人可見倉庫 {warehouses}",
            en: "Tenant {tenant} (all warehouses) · Operator warehouses {warehouses}",
          },
          {
            tenant: actor?.tenant ?? "—",
            warehouses:
              sortedActorWarehouses.length > 0
                ? sortedActorWarehouses.join(", ")
                : "—",
          },
        )}
        metadata={[
          {
            label: tx({
              "zh-CN": "目标租户",
              "zh-HK": "目標租戶",
              en: "Target Tenant",
            }),
            value: actor?.tenant ?? "—",
            mono: true,
          },
          {
            label: tx({
              "zh-CN": "当前写入状态",
              "zh-HK": "目前寫入狀態",
              en: "Current State",
            }),
            value: summary?.writes_paused
              ? tx({ "zh-CN": "已暂停", "zh-HK": "已暫停", en: "Paused" })
              : tx({ "zh-CN": "正常运行", "zh-HK": "正常運作", en: "Active" }),
          },
          {
            label: tx({
              "zh-CN": "变更后状态",
              "zh-HK": "變更後狀態",
              en: "Target State",
            }),
            value: writeConfirmTarget
              ? tx({ "zh-CN": "已暂停", "zh-HK": "已暫停", en: "Paused" })
              : tx({ "zh-CN": "正常运行", "zh-HK": "正常運作", en: "Active" }),
          },
          {
            label: tx({
              "zh-CN": "当前待派发数量",
              "zh-HK": "目前待派發數量",
              en: "Queued Proposals",
            }),
            value: String(summary?.proposals_by_state.QUEUED ?? 0),
          },
        ]}
        confirmLabel={
          writeConfirmTarget
            ? tx({
                "zh-CN": "确认暂停 ERP 写入",
                "zh-HK": "確認暫停 ERP 寫入",
                en: "Confirm Pause Writes",
              })
            : tx({
                "zh-CN": "确认恢复 ERP 写入",
                "zh-HK": "確認恢復 ERP 寫入",
                en: "Confirm Resume Writes",
              })
        }
        cancelLabel={t("common.cancel")}
        dialogTestId="write-control-confirm-dialog"
        confirmTestId="confirm-dialog-submit"
        onConfirm={handleConfirmWriteControl}
      />

      {/* Subject Suspension Confirmation Dialog */}
      <ActionConfirmDialog
        open={suspendConfirm !== null}
        onOpenChange={(open) => {
          if (!open && !suspendBusy) setSuspendConfirm(null);
        }}
        destructive={suspendConfirm?.suspended === true}
        loading={suspendBusy}
        title={
          suspendConfirm?.suspended
            ? tx(
                {
                  "zh-CN": "确认停用主体「{subject}」访问",
                  "zh-HK": "確認停用主體「{subject}」存取",
                  en: "Confirm Access Suspension for “{subject}”",
                },
                { subject: suspendConfirm.subject },
              )
            : tx(
                {
                  "zh-CN": "确认恢复主体「{subject}」访问",
                  "zh-HK": "確認恢復主體「{subject}」存取",
                  en: "Confirm Access Restoration for “{subject}”",
                },
                { subject: suspendConfirm?.subject ?? "" },
              )
        }
        description={
          suspendConfirm?.suspended
            ? tx({
                "zh-CN":
                  "停权生效后，该账号在本租户内的所有接口请求将被立即拦截，其发起的尚未派发提案在出站前也将被阻断。",
                "zh-HK":
                  "停權生效後，該帳號於本租戶內的所有介面請求將被立即攔截，其發起的尚未派發提案於出站前亦將被阻斷。",
                en: "Once suspended, all API requests from this account in this tenant are immediately blocked, and its pending proposals will be halted before outbound dispatch.",
              })
            : tx({
                "zh-CN":
                  "恢复后，该账号将重新按其身份声明与已配置的模块授权规则访问本租户工作台。",
                "zh-HK":
                  "恢復後，該帳號將重新按其身份聲明與已設定的模組授權規則存取本租戶工作台。",
                en: "Once restored, this account can access the tenant workbench again according to its identity claims and configured module grants.",
              })
        }
        scopeSummary={tx(
          {
            "zh-CN": "租户 {tenant} · 目标账号 {subject}",
            "zh-HK": "租戶 {tenant} · 目標帳號 {subject}",
            en: "Tenant {tenant} · Target account {subject}",
          },
          {
            tenant: actor?.tenant ?? "—",
            subject: suspendConfirm?.subject ?? "—",
          },
        )}
        metadata={[
          {
            label: tx({ "zh-CN": "租户", "zh-HK": "租戶", en: "Tenant" }),
            value: actor?.tenant ?? "—",
            mono: true,
          },
          {
            label: tx({
              "zh-CN": "目标账号",
              "zh-HK": "目標帳號",
              en: "Target Account",
            }),
            value: suspendConfirm?.subject ?? "—",
            mono: true,
          },
          {
            label: tx({
              "zh-CN": "提交操作",
              "zh-HK": "提交操作",
              en: "Action",
            }),
            value: suspendConfirm?.suspended
              ? tx({
                  "zh-CN": "停用访问",
                  "zh-HK": "停用存取",
                  en: "Suspend Access",
                })
              : tx({
                  "zh-CN": "恢复访问",
                  "zh-HK": "恢復存取",
                  en: "Restore Access",
                }),
          },
        ]}
        confirmLabel={
          suspendConfirm?.suspended
            ? tx({
                "zh-CN": "确认停用访问",
                "zh-HK": "確認停用存取",
                en: "Confirm Suspend",
              })
            : tx({
                "zh-CN": "确认恢复访问",
                "zh-HK": "確認恢復存取",
                en: "Confirm Restore",
              })
        }
        cancelLabel={t("common.cancel")}
        dialogTestId="suspension-confirm-dialog"
        confirmTestId="confirm-dialog-submit"
        onConfirm={handleConfirmSuspension}
      />
    </div>
  );
}
