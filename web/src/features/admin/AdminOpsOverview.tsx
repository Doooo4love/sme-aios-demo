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
import {
  formatProposalStateLabel,
  formatRoleLabel,
  formatShortDigest,
  formatUnixTime,
} from "@/lib/format";
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

const COMPACT_STATE_LABELS: Record<ProposalState, string> = {
  PROPOSED: "待审批",
  QUEUED: "已批准",
  SENDING: "写入中",
  VERIFYING: "核验中",
  CHECKING: "复核中",
  OUTCOME_UNKNOWN: "待确认",
  NEEDS_OPERATOR: "需人工",
  VERIFIED: "已入账",
  REJECTED: "已拒绝",
};

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
  message: string;
  requestId?: string | null;
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

  const [healthz, setHealthz] = useState<HealthProbeResult | null>(null);
  const [readyz, setReadyz] = useState<HealthProbeResult | null>(null);
  const [summary, setSummary] = useState<OperationsSummary | null>(null);
  const [exceptionPreview, setExceptionPreview] = useState<ExceptionItem[]>([]);
  const [hasMoreExceptions, setHasMoreExceptions] = useState(false);

  const [checkpoint, setCheckpoint] = useState<AssuranceCheckpoint | null>(
    null,
  );
  const [checkpointUnavailableMsg, setCheckpointUnavailableMsg] = useState<
    string | null
  >(null);

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
      setCheckpointUnavailableMsg(null);
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
              setCheckpointUnavailableMsg(
                cpErr.status === 503
                  ? "受控预审连接器当前未启用，暂不生成审计检查点。"
                  : cpErr.message,
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
    setCheckpointUnavailableMsg(null);
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
    if (!summary || inFlightCount === 0) return "当前无在途单据";
    const parts: string[] = [];
    if ((summary.proposals_by_state.QUEUED ?? 0) > 0) {
      parts.push(`待派发 ${summary.proposals_by_state.QUEUED}`);
    }
    if ((summary.proposals_by_state.SENDING ?? 0) > 0) {
      parts.push(`写入中 ${summary.proposals_by_state.SENDING}`);
    }
    const verifying =
      (summary.proposals_by_state.VERIFYING ?? 0) +
      (summary.proposals_by_state.CHECKING ?? 0);
    if (verifying > 0) {
      parts.push(`核验中 ${verifying}`);
    }
    return parts.join(" · ");
  }, [summary, inFlightCount]);

  const activeTopologyState = useMemo<ProposalState>(() => {
    if (manualTopologyState) return manualTopologyState;
    if (!summary) return "PROPOSED";
    return inferDominantTopologyState(summary.proposals_by_state);
  }, [manualTopologyState, summary]);

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
        message: verifiedSummary.writes_paused
          ? "已确认租户 ERP 出站写入处于「已暂停」状态。"
          : "已确认租户 ERP 出站写入处于「正常运行」状态。",
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
          message: err.message,
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
          message: "请输入需要变更停权状态的员工主体标识（subject）。",
        });
        return;
      }
      if (trimmedSuspendSubject.length > 150) {
        setSuspendFeedback({
          kind: "error",
          message: "主体标识长度不得超过 150 个字符。",
        });
        return;
      }
      if (actor?.subject === trimmedSuspendSubject) {
        setSuspendFeedback({
          kind: "error",
          message: "管理员不可停用或修改本人的访问停权状态。",
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
        message: res.suspended
          ? `已停用主体 ${suspendConfirm.subject} 在租户 ${actor?.tenant ?? ""} 的访问权限。`
          : `已恢复主体 ${suspendConfirm.subject} 在租户 ${actor?.tenant ?? ""} 的访问权限。`,
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
          message: err.message,
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
          title="需要运维管理权限 (operations.manage)"
          message="此控制台仅限具备 operations.manage 权限的主管（manager）或管理员（admin）访问。当前账号无权查看运维统计、异常队列或执行写入控制。"
          backHref="/inbox"
          backLabel="返回工作台"
        />
      </div>
    );
  }

  return (
    <div
      className="mx-auto max-w-[1160px] space-y-5 px-4 py-6 sm:px-6 lg:py-7 pb-16"
      data-testid="admin-ops-page"
    >
      {/* Unified Porcelain Page-Header Card (matches /work & /calendar) */}
      <section className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] p-5 sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-[20px] font-semibold tracking-[-0.02em] text-[var(--ink-primary)] leading-tight">
              运维监控中心
            </h1>
            <p className="mt-1 text-[13px] text-[var(--ink-secondary)]">
              实时核验核心服务健康、提案流转分布与 ERP 出站写入控制。
            </p>
            <p className="mt-1.5 text-[12px] text-[var(--ink-muted)] tabular-nums">
              <span className="font-mono-code">{actor?.tenant ?? "—"}</span>
              <span className="mx-1.5 text-[var(--ink-faint)]">·</span>
              <span className="font-mono-code">
                {actor?.warehouses.join(" / ") || "无站点"}
              </span>
              <span className="mx-1.5 text-[var(--ink-faint)]">·</span>
              <span>{actor ? formatRoleLabel(actor.role) : "—"}</span>
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
              <span>异常单据队列</span>
              <span className="font-mono-code text-[11.5px] font-semibold tabular-nums">
                ({exceptionCount})
              </span>
              <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.85} />
            </Link>

            {canManagePeople && (
              <Link
                href="/admin/people"
                className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium text-[var(--accent)] hover:bg-[var(--accent-wash)] transition-colors duration-[150ms]"
              >
                <Users className="h-3.5 w-3.5" strokeWidth={1.85} />
                <span>员工权限</span>
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
              <span>刷新快照</span>
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

      {/* Section 1: Core Service Health Probes (/healthz & /readyz) — Sheen-Only Porcelain Tiles */}
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
                      API 进程存活
                    </h2>
                    <span className="font-mono-code text-[11px] text-[var(--ink-muted)]">
                      /healthz
                    </span>
                  </div>
                  <p className="mt-1 font-mono-code text-[11.5px] text-[var(--ink-muted)] tabular-nums">
                    {healthz
                      ? `HTTP ${healthz.httpStatus || "ERR"} · status="${healthz.status}" · ${formatUnixTime(healthz.checkedAt, { withSeconds: true }).slice(11)}`
                      : "正在探测服务存活…"}
                  </p>
                </div>
              </div>

              {healthz ? (
                <StatusBadge
                  status={healthz.ok ? "healthy" : "unavailable"}
                  label={healthz.ok ? "正常" : "异常"}
                />
              ) : (
                <StatusBadge status="PROPOSED" label="探测中" compact />
              )}
            </div>
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
                      数据库就绪状态
                    </h2>
                    <span className="font-mono-code text-[11px] text-[var(--ink-muted)]">
                      /readyz
                    </span>
                  </div>
                  <p className="mt-1 font-mono-code text-[11.5px] text-[var(--ink-muted)] tabular-nums">
                    {readyz
                      ? `HTTP ${readyz.httpStatus || "ERR"} · status="${readyz.status}" · ${formatUnixTime(readyz.checkedAt, { withSeconds: true }).slice(11)}`
                      : "正在探测数据库就绪…"}
                  </p>
                </div>
              </div>

              {readyz ? (
                <StatusBadge
                  status={readyz.ok ? "healthy" : "unavailable"}
                  label={
                    readyz.ok
                      ? "正常"
                      : `未就绪 (${readyz.httpStatus || "ERR"})`
                  }
                />
              ) : (
                <StatusBadge status="PROPOSED" label="探测中" compact />
              )}
            </div>

            {readyz && !readyz.ok && readyz.message && (
              <p className="mt-2.5 rounded-sm bg-[var(--status-amber-wash)] px-3 py-1.5 text-[12px] text-[var(--status-amber-ink)]">
                {readyz.message}
              </p>
            )}
          </Interactive3DCard>
        </div>

        <p className="px-1 text-[11.5px] text-[var(--ink-muted)]">
          上述探针仅检测平台 API 服务与主数据库连接状态，不代表外部 ERP 或上游连接器连通性；查阅具体单据时系统仍会实时复核对应业务模块权限。
        </p>
      </section>

      {/* Section 2: ERP Write Control + 3-Hero Proposal State Overview + 9-State Compact Legend + Topology */}
      {summary && (
        <section className="space-y-5">
          {/* Write Control Hero Card (Sheen-Only Porcelain) */}
          <Interactive3DCard
            interactive={false}
            sheenIntensity="subtle"
            data-testid="write-control-card"
            className={[
              "rounded-card p-5 sm:p-6 shadow-[var(--shadow-card)]",
              summary.writes_paused
                ? "bg-[linear-gradient(135deg,#FFFFFF_0%,rgba(201,42,55,0.06)_100%)] ring-1 ring-[var(--status-crimson-border)]"
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
                        ? `租户 ${actor?.tenant ?? ""} 的 ERP 出站写入已暂停`
                        : `租户 ${actor?.tenant ?? ""} 的 ERP 出站写入通道已开启`}
                    </h2>
                    <StatusBadge
                      status={summary.writes_paused ? "paused" : "healthy"}
                      label={summary.writes_paused ? "已暂停" : "正常运行"}
                      compact
                    />
                  </div>
                  <p className="mt-1 text-[13px] text-[var(--ink-secondary)] leading-relaxed">
                    {summary.writes_paused
                      ? "所有已批准待派发提案将暂缓发往 ERP，直至管理员手动恢复；已发出单据的回执核验不受影响。"
                      : "已批准提案将由 Worker 正常派发至 ERP 并自动核验回执。"}
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
                        <span>恢复 ERP 写入</span>
                      </>
                    ) : (
                      <>
                        <PauseCircle className="h-4 w-4" strokeWidth={1.85} />
                        <span>暂停 ERP 写入</span>
                      </>
                    )}
                  </Button>
                ) : (
                  <span className="inline-flex items-center rounded-full bg-[var(--bg-surface-subtle)] px-3.5 py-1.5 text-[12px] text-[var(--ink-muted)]">
                    仅管理员可切换写入开关
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
                <span>{writeControlFeedback.message}</span>
                {writeControlFeedback.requestId && (
                  <span className="font-mono-code text-[11px] opacity-80">
                    跟踪编号: {writeControlFeedback.requestId}
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
                  提案状态分布
                </h2>
                <span className="font-mono-code text-[12px] text-[var(--ink-muted)] tabular-nums">
                  共 {totalProposals} 条
                </span>
              </div>
              <span className="text-[12px] text-[var(--ink-muted)]">
                选择任一状态可在下方流转拓扑中聚焦查看
              </span>
            </div>

            {/* 3 Prominent Actionable Metric Tiles */}
            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
              {/* 1. 待审批 */}
              <button
                type="button"
                onClick={() => setManualTopologyState("PROPOSED")}
                className={[
                  "group rounded-tile p-4 text-left transition-all duration-[160ms] cursor-pointer",
                  activeTopologyState === "PROPOSED"
                    ? "bg-[var(--bg-surface)] shadow-[var(--shadow-subtle)] ring-1 ring-[var(--accent-border)]"
                    : "bg-[var(--bg-surface-tint)] hover:bg-[var(--bg-surface)] hover:shadow-[var(--shadow-subtle)]",
                ].join(" ")}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13px] font-medium text-[var(--ink-secondary)]">
                    待审批
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
                    "mt-2 font-mono-code text-[28px] font-semibold tracking-[-0.03em] leading-none tabular-nums",
                    proposedCount > 0
                      ? "text-[var(--status-amber-ink)]"
                      : "text-[var(--ink-faint)] opacity-55",
                  ].join(" ")}
                >
                  {proposedCount}
                </div>
                <div className="mt-1.5 text-[12px] text-[var(--ink-muted)]">
                  {proposedCount > 0 ? "等待独立主管确认批准" : "当前无待审批提案"}
                </div>
              </button>

              {/* 2. 待派发 / 执行中 */}
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
                    : "bg-[var(--bg-surface-tint)] hover:bg-[var(--bg-surface)] hover:shadow-[var(--shadow-subtle)]",
                ].join(" ")}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13px] font-medium text-[var(--ink-secondary)]">
                    待派发与执行中
                  </span>
                  <span
                    className={[
                      "flex h-7 w-7 items-center justify-center rounded-full",
                      inFlightCount > 0
                        ? "bg-[var(--accent-wash)] text-[var(--accent)]"
                        : "bg-[var(--bg-surface)] text-[var(--ink-muted)]",
                    ].join(" ")}
                  >
                    <Layers className="h-3.5 w-3.5" strokeWidth={1.85} />
                  </span>
                </div>
                <div
                  className={[
                    "mt-2 font-mono-code text-[28px] font-semibold tracking-[-0.03em] leading-none tabular-nums",
                    inFlightCount > 0
                      ? "text-[var(--accent)]"
                      : "text-[var(--ink-faint)] opacity-55",
                  ].join(" ")}
                >
                  {inFlightCount}
                </div>
                <div className="mt-1.5 text-[12px] text-[var(--ink-muted)] truncate">
                  {inFlightSummaryLine}
                </div>
              </button>

              {/* 3. 需关注异常 */}
              <Link
                href="/admin/exceptions"
                className={[
                  "group block rounded-tile p-4 transition-all duration-[160ms]",
                  exceptionCount > 0
                    ? "bg-[var(--status-crimson-wash)]/75 hover:bg-[var(--status-crimson-wash)]"
                    : "bg-[var(--bg-surface-tint)] hover:bg-[var(--bg-surface)] hover:shadow-[var(--shadow-subtle)]",
                ].join(" ")}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13px] font-medium text-[var(--ink-secondary)]">
                    需关注异常
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
                    "mt-2 font-mono-code text-[28px] font-semibold tracking-[-0.03em] leading-none tabular-nums",
                    exceptionCount > 0
                      ? "text-[var(--status-crimson)]"
                      : "text-[var(--ink-faint)] opacity-55",
                  ].join(" ")}
                >
                  {exceptionCount}
                </div>
                <div className="mt-1.5 flex items-center justify-between text-[12px] text-[var(--ink-muted)]">
                  <span>
                    {exceptionCount > 0 ? "含待确认或需人工核查" : "无滞留异常单据"}
                  </span>
                  <span className="inline-flex items-center gap-0.5 font-medium text-[var(--accent)] group-hover:translate-x-0.5 transition-transform">
                    <span>队列</span>
                    <ArrowRight className="h-3 w-3" strokeWidth={2} />
                  </span>
                </div>
              </Link>
            </div>

            {/* Calm Compact 9-State Breakdown Legend (zeros faint, enums in tooltips, all state-count-* testids preserved) */}
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
                const tooltip = `${formatProposalStateLabel(stateKey)} (${stateKey})`;

                const itemClasses = [
                  "flex flex-col items-center justify-center rounded-sm px-2 py-2.5 text-center transition-all duration-[150ms]",
                  isSelected
                    ? "bg-[var(--bg-surface)] shadow-[var(--shadow-subtle)]"
                    : "hover:bg-[var(--bg-surface)]/70",
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
                            : "bg-[var(--ink-faint)] opacity-40",
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
                        {COMPACT_STATE_LABELS[stateKey]}
                      </span>
                    </div>
                    <span
                      data-testid={`state-count-${stateKey}`}
                      className={[
                        "mt-1 font-mono-code text-[15px] font-semibold leading-none tabular-nums",
                        count === 0
                          ? "text-[var(--ink-faint)] opacity-45"
                          : stateKey === "NEEDS_OPERATOR"
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

          {/* Standalone Porcelain ExecutionTopologyRibbon with Integrated headerRight Focus Control */}
          <ExecutionTopologyRibbon
            state={activeTopologyState}
            variant="auto"
            headerRight={
              <div className="flex flex-wrap items-center gap-2 text-[12px]">
                <span
                  title={activeTopologyState}
                  className="text-[var(--ink-muted)]"
                >
                  当前聚焦：
                  <strong className="font-medium text-[var(--ink-primary)]">
                    {formatProposalStateLabel(activeTopologyState)}
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
                    恢复自动聚焦
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
                  title="POST /v1/demo/worker-tick"
                  className="text-[15.5px] font-semibold tracking-[-0.01em] text-[var(--ink-primary)]"
                >
                  手动步进本地 Outbox Worker
                </h2>
                <SourceTag source="synthetic" />
              </div>
              <p className="mt-1 text-[13px] text-[var(--ink-secondary)] leading-relaxed">
                仅在本地演示环境下向管理员开放。每次点击推进一轮队列派发或回执核验，完成后自动刷新状态分布与异常队列。
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
                <span>执行一次 Worker Tick</span>
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
                    ? "已推进 1 条队列任务，状态分布与异常预览已同步刷新。"
                    : "当前无待执行的队列任务（或租户 ERP 写入已暂停）。"}
                </span>
              </div>
              <span className="font-mono-code text-[11.5px] opacity-80 tabular-nums">
                {formatUnixTime(workerTickFeedback.at, {
                  withSeconds: true,
                }).slice(11)}
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

      {/* Section 4: Exceptions Quick Preview + Subject Suspension (2-Column Porcelain Split) */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        {/* Recent Exceptions Preview */}
        <section className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] p-5 sm:p-6 lg:col-span-7 flex flex-col">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-[15.5px] font-semibold tracking-[-0.01em] text-[var(--ink-primary)]">
              待关注异常单据预览
            </h2>
            <Link
              href="/admin/exceptions"
              className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12.5px] font-medium text-[var(--accent)] hover:bg-[var(--accent-wash)] transition-colors"
            >
              <span>完整队列</span>
              <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.85} />
            </Link>
          </div>

          {exceptionPreview.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 py-10 text-center">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--status-emerald-wash)] text-[var(--status-emerald)]">
                <CheckCircle2 className="h-5 w-5" strokeWidth={1.85} />
              </div>
              <div className="text-[13.5px] font-medium text-[var(--ink-primary)]">
                一切平稳，暂无滞留异常
              </div>
              <p className="text-[12.5px] text-[var(--ink-muted)]">
                授权仓库内没有待确认或需人工核查的单据。
              </p>
            </div>
          ) : (
            <div className="mt-4 space-y-2">
              {exceptionPreview.map((item) => (
                <div
                  key={item.proposal_id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-tile bg-[var(--bg-surface-tint)] px-3.5 py-3 hover:bg-[var(--bg-surface-subtle)] transition-colors duration-[140ms]"
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
                    <div className="mt-1 font-mono-code text-[11.5px] text-[var(--ink-muted)] tabular-nums">
                      核验轮次 {item.checks}/3 · {item.last_event ?? "—"}
                    </div>
                  </div>
                  <StatusBadge status={item.state} compact />
                </div>
              ))}
              {hasMoreExceptions && (
                <div className="pt-2 text-right text-[12px] text-[var(--ink-muted)]">
                  仅展示前 5 条，请前往异常队列翻页处理。
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
            主体紧急停权控制
          </h2>

          <div className="mt-3">
            {isAdmin ? (
              <div className="space-y-3.5">
                <p className="text-[12.5px] text-[var(--ink-secondary)] leading-relaxed">
                  按员工账号标识在本租户内立即停用或恢复访问权限，停权后将阻断全部请求及待派发提案；不可对本人操作。
                </p>

                <div>
                  <label
                    htmlFor="suspension-subject-input"
                    className="block text-[12.5px] font-medium text-[var(--ink-secondary)]"
                  >
                    目标员工标识
                  </label>
                  <input
                    id="suspension-subject-input"
                    type="text"
                    value={suspendSubjectInput}
                    onChange={(e) => {
                      setSuspendSubjectInput(e.target.value);
                      setSuspendFeedback(null);
                    }}
                    placeholder="例如 operator 或 viewer"
                    aria-invalid={isSelfSuspensionTarget || undefined}
                    data-testid="suspension-subject-input"
                    className="mt-1.5 h-10 w-full rounded-sm border border-[var(--hairline-strong)] bg-[var(--bg-surface-tint)] px-3.5 font-mono-code text-[13px] text-[var(--ink-primary)] placeholder:font-sans placeholder:text-[var(--ink-faint)] focus:bg-[var(--bg-surface)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-ring)] focus:outline-none transition-all"
                  />
                  {isSelfSuspensionTarget && (
                    <p className="mt-1.5 text-[12px] text-[var(--status-crimson)]">
                      管理员不可对当前登录的本人账号执行停权。
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
                    <span>停用访问</span>
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
                    <span>恢复访问</span>
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
                    <span>{suspendFeedback.message}</span>
                    {suspendFeedback.requestId && (
                      <span className="ml-2 font-mono-code text-[11px] opacity-80">
                        跟踪编号: {suspendFeedback.requestId}
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
                  主体停权操作仅限租户管理员执行；主管可查看运维监控与处置异常单据。
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
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--accent-wash)] text-[var(--accent)]">
                <ShieldCheck className="h-4 w-4" strokeWidth={1.85} />
              </div>
              <h2 className="text-[15.5px] font-semibold tracking-[-0.01em] text-[var(--ink-primary)]">
                受控预审审计签名检查点
              </h2>
            </div>
            <span className="text-[12px] text-[var(--ink-muted)]">
              只读审计元数据
            </span>
          </div>

          <div className="mt-4">
            {checkpoint ? (
              <dl className="grid grid-cols-1 gap-3 text-[12.5px] sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-tile bg-[var(--bg-surface-tint)] p-3.5">
                  <dt className="text-[11.5px] text-[var(--ink-muted)]">
                    检查点序号
                  </dt>
                  <dd className="mt-1.5 font-mono-code text-[16px] font-semibold text-[var(--ink-primary)] tabular-nums">
                    #{checkpoint.seq}
                  </dd>
                </div>
                <div className="rounded-tile bg-[var(--bg-surface-tint)] p-3.5">
                  <dt className="text-[11.5px] text-[var(--ink-muted)]">
                    检查点类型
                  </dt>
                  <dd className="mt-1.5 font-mono-code text-[12.5px] font-medium text-[var(--ink-primary)] break-all">
                    {checkpoint.type}
                  </dd>
                </div>
                <div className="rounded-tile bg-[var(--bg-surface-tint)] p-3.5">
                  <dt className="flex items-center justify-between text-[11.5px] text-[var(--ink-muted)]">
                    <span>链表摘要</span>
                    <button
                      type="button"
                      onClick={() => void handleCopyHash(checkpoint.hash)}
                      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium text-[var(--accent)] hover:bg-[var(--accent-wash)] transition-colors cursor-pointer"
                    >
                      <Copy className="h-3 w-3" />
                      <span>{copiedHash ? "已复制" : "复制"}</span>
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
                    密钥标识
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
                {checkpointUnavailableMsg ?? "正在获取审计签名检查点…"}
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
            ? "确认暂停租户 ERP 出站写入"
            : "确认恢复租户 ERP 出站写入"
        }
        description={
          writeConfirmTarget
            ? "暂停后将阻断本租户所有已批准待派发提案向 ERP 发起出站写入，直至管理员再次手动恢复；已发送单据的只读回执核验不受影响。"
            : "恢复后将允许本租户所有待派发提案按 Worker 调度继续写入 ERP，请确认当前上游 ERP 环境状态正常。"
        }
        scopeSummary={`租户 ${actor?.tenant ?? "—"}（全部站点）· 操作人可见站点 ${actor?.warehouses.join(", ") || "—"}`}
        metadata={[
          { label: "目标租户", value: actor?.tenant ?? "—", mono: true },
          {
            label: "当前写入状态",
            value: summary?.writes_paused ? "已暂停" : "正常运行",
          },
          {
            label: "变更后状态",
            value: writeConfirmTarget ? "已暂停" : "正常运行",
          },
          {
            label: "当前待派发数量",
            value: String(summary?.proposals_by_state.QUEUED ?? 0),
            mono: true,
          },
        ]}
        confirmLabel={
          writeConfirmTarget ? "确认暂停 ERP 写入" : "确认恢复 ERP 写入"
        }
        cancelLabel="取消"
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
            ? `确认停用主体「${suspendConfirm.subject}」访问`
            : `确认恢复主体「${suspendConfirm?.subject ?? ""}」访问`
        }
        description={
          suspendConfirm?.suspended
            ? "停权生效后，该账号在本租户内的所有接口请求将被立即拦截，其发起的尚未派发提案在出站前也将被阻断。"
            : "恢复后，该账号将重新按其身份声明与已配置的模块授权规则访问本租户工作台。"
        }
        scopeSummary={`租户 ${actor?.tenant ?? "—"} · 目标账号 ${suspendConfirm?.subject ?? "—"}`}
        metadata={[
          { label: "租户", value: actor?.tenant ?? "—", mono: true },
          {
            label: "目标账号",
            value: suspendConfirm?.subject ?? "—",
            mono: true,
          },
          {
            label: "提交操作",
            value: suspendConfirm?.suspended ? "停用访问" : "恢复访问",
          },
        ]}
        confirmLabel={
          suspendConfirm?.suspended ? "确认停用访问" : "确认恢复访问"
        }
        cancelLabel="取消"
        dialogTestId="suspension-confirm-dialog"
        confirmTestId="confirm-dialog-submit"
        onConfirm={handleConfirmSuspension}
      />
    </div>
  );
}
