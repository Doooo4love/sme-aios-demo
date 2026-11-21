"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Copy,
  Database,
  Info,
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
import { ExecutionTopologyRibbon } from "@/components/kinetic";
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

  const exceptionCount = useMemo(() => {
    if (!summary) return 0;
    return (
      (summary.proposals_by_state.NEEDS_OPERATOR ?? 0) +
      (summary.proposals_by_state.OUTCOME_UNKNOWN ?? 0)
    );
  }, [summary]);

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
          ? "已验证租户 ERP 出站写入处于「已暂停」状态（已重新核对 /v1/operations/summary）。"
          : "已验证租户 ERP 出站写入处于「正常运行」状态（已重新核对 /v1/operations/summary）。",
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
        className="mx-auto max-w-[820px] p-4 sm:p-6"
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
      className="mx-auto max-w-[1160px] space-y-4 p-4 sm:p-6"
      data-testid="admin-ops-page"
    >
      {/* Top Overview Header */}
      <section className="rounded-[6px] border border-[var(--hairline)] bg-[var(--bg-sheet)] p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="font-mono-code text-[11px] uppercase tracking-[0.04em] text-[var(--ink-muted)]">
              OPERATIONS CONTROL CENTER · 运维监控与出站控制
            </p>
            <h2 className="mt-1 text-[20px] font-semibold tracking-[-0.02em] text-[var(--ink-primary)]">
              运维监控中心
            </h2>
            <p className="mt-1 text-[13px] text-[var(--ink-muted)]">
              实时核验核心服务健康探针、租户提案流转分布、ERP 出站写入熔断与异常单据处置入口。
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <Link
              href="/admin/exceptions"
              data-testid="ops-exceptions-link"
              className={[
                "inline-flex h-8 items-center gap-1.5 rounded-[4px] border px-3 text-[12px] font-medium transition-colors duration-[120ms]",
                exceptionCount > 0
                  ? "border-[var(--status-amber-border)] bg-[var(--status-amber-wash)] text-[var(--status-amber-ink)] hover:opacity-90"
                  : "border-[var(--hairline-strong)] bg-[var(--bg-subtle)] text-[var(--ink-primary)] hover:bg-[var(--bg-plane)]",
              ].join(" ")}
            >
              <AlertTriangle className="h-3.5 w-3.5" strokeWidth={1.75} />
              <span>异常单据队列</span>
              <span className="font-mono-code text-[11px] font-semibold tabular-nums">
                ({exceptionCount})
              </span>
              <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.75} />
            </Link>

            {canManagePeople && (
              <Link
                href="/admin/people"
                className="inline-flex h-8 items-center gap-1.5 rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-subtle)] px-3 text-[12px] font-medium text-[var(--ink-primary)] hover:bg-[var(--bg-plane)] transition-colors duration-[120ms]"
              >
                <Users className="h-3.5 w-3.5 text-[var(--ink-muted)]" strokeWidth={1.75} />
                <span>员工模块权限</span>
              </Link>
            )}

            <Button
              size="sm"
              variant="secondary"
              loading={loading}
              data-testid="ops-refresh-btn"
              onClick={() => void loadAllOpsData()}
            >
              <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} />
              <span>刷新快照</span>
            </Button>
          </div>
        </div>

        {/* Scope & Metadata Boundary Notice */}
        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t border-[var(--hairline)] pt-3 text-[12px] text-[var(--ink-secondary)]">
          <span>
            当前租户：
            <strong className="font-mono-code font-semibold text-[var(--ink-primary)]">
              {actor?.tenant ?? "—"}
            </strong>
          </span>
          <span>
            统计覆盖仓库：
            <strong className="font-mono-code font-semibold text-[var(--ink-primary)]">
              {actor?.warehouses.join(", ") || "无"}
            </strong>
          </span>
          <span>
            当前角色：
            <strong className="font-mono-code font-semibold text-[var(--ink-primary)]">
              {actor?.role ?? "—"}
            </strong>
          </span>
        </div>

        <div className="mt-3 flex items-start gap-2 rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] px-3 py-2 text-[12px] text-[var(--ink-secondary)] leading-relaxed">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--ink-muted)]" strokeWidth={1.75} />
          <span>
            权限边界说明：运维管理员在本页面仅查看已授权仓库范围内的提案状态统计与运维元数据；点开单据详情或发起业务查阅时，系统仍会按对应业务模块的读取授权进行实时复核。
          </span>
        </div>
      </section>

      {opsError && (
        <AccessNoticeCard
          error={opsError}
          onRetry={() => void loadAllOpsData()}
          backHref="/inbox"
        />
      )}

      {/* Section 1: Service Health Probes (/healthz & /readyz) */}
      <section
        data-testid="ops-health-panel"
        className="rounded-[6px] border border-[var(--hairline)] bg-[var(--bg-sheet)] overflow-hidden"
      >
        <div className="flex items-center justify-between border-b border-[var(--hairline)] bg-[var(--bg-plane)] px-4 py-2.5">
          <div className="flex items-center gap-2">
            <Activity className="h-3.5 w-3.5 text-[var(--ink-secondary)]" strokeWidth={1.75} />
            <h3 className="text-[12.5px] font-semibold text-[var(--ink-primary)]">
              核心服务健康探针（API / 数据库）
            </h3>
          </div>
          <span className="font-mono-code text-[11px] text-[var(--ink-muted)]">
            GET /healthz · GET /readyz
          </span>
        </div>

        <div className="grid grid-cols-1 divide-y divide-[var(--hairline)] sm:grid-cols-2 sm:divide-x sm:divide-y-0">
          {/* /healthz */}
          <div className="flex items-center justify-between gap-3 p-4" data-testid="probe-healthz">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Server className="h-4 w-4 text-[var(--ink-secondary)]" strokeWidth={1.75} />
                <span className="text-[13.5px] font-semibold text-[var(--ink-primary)]">
                  API 进程存活
                </span>
                <code className="font-mono-code text-[11px] text-[var(--ink-muted)]">
                  /healthz
                </code>
              </div>
              <p className="mt-1 font-mono-code text-[11.5px] text-[var(--ink-muted)] tabular-nums">
                {healthz
                  ? `HTTP ${healthz.httpStatus || "ERR"} · status="${healthz.status}" · 核验于 ${formatUnixTime(healthz.checkedAt, { withSeconds: true }).slice(11)}`
                  : "正在探测…"}
              </p>
            </div>
            {healthz ? (
              <StatusBadge
                status={healthz.ok ? "healthy" : "unavailable"}
                label={healthz.ok ? "API 存活 (up)" : "API 异常"}
              />
            ) : (
              <StatusBadge status="PROPOSED" label="探测中" compact />
            )}
          </div>

          {/* /readyz */}
          <div className="flex items-center justify-between gap-3 p-4" data-testid="probe-readyz">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Database className="h-4 w-4 text-[var(--ink-secondary)]" strokeWidth={1.75} />
                <span className="text-[13.5px] font-semibold text-[var(--ink-primary)]">
                  数据库就绪状态
                </span>
                <code className="font-mono-code text-[11px] text-[var(--ink-muted)]">
                  /readyz
                </code>
              </div>
              <p className="mt-1 font-mono-code text-[11.5px] text-[var(--ink-muted)] tabular-nums">
                {readyz
                  ? `HTTP ${readyz.httpStatus || "ERR"} · status="${readyz.status}" · 核验于 ${formatUnixTime(readyz.checkedAt, { withSeconds: true }).slice(11)}`
                  : "正在探测…"}
              </p>
              {readyz && !readyz.ok && readyz.message && (
                <p className="mt-1 text-[11.5px] text-[var(--status-amber-ink)]">
                  {readyz.message}
                </p>
              )}
            </div>
            {readyz ? (
              <StatusBadge
                status={readyz.ok ? "healthy" : "unavailable"}
                label={readyz.ok ? "数据库就绪 (ready)" : `未就绪 (${readyz.httpStatus || "ERR"})`}
              />
            ) : (
              <StatusBadge status="PROPOSED" label="探测中" compact />
            )}
          </div>
        </div>

        <div className="border-t border-[var(--hairline)] bg-[var(--bg-subtle)] px-4 py-2 text-[11.5px] text-[var(--ink-muted)]">
          说明：上述探针仅检测平台 API 服务进程存活与本地/主数据库连接就绪状态，不代表外部 ERP、OIDC 或上游连接器的实时连通性。
        </div>
      </section>

      {/* Section 2: ERP Write Control + Proposal State Distribution */}
      {summary && (
        <section className="space-y-4">
          {/* Write Control Banner */}
          <div
            data-testid="write-control-card"
            className={[
              "rounded-[6px] border p-4 sm:p-5",
              summary.writes_paused
                ? "border-[var(--status-crimson-border)] bg-[var(--status-crimson-wash)]"
                : "border-[var(--hairline)] bg-[var(--bg-sheet)]",
            ].join(" ")}
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className="font-mono-code text-[11px] uppercase tracking-[0.04em] text-[var(--ink-muted)]">
                    ERP WRITE CIRCUIT BREAKER
                  </span>
                  <StatusBadge
                    status={summary.writes_paused ? "paused" : "healthy"}
                    label={
                      summary.writes_paused
                        ? "ERP 写入已暂停"
                        : "ERP 写入正常运行"
                    }
                  />
                </div>
                <h3 className="mt-1.5 text-[15px] font-semibold text-[var(--ink-primary)]">
                  {summary.writes_paused
                    ? `租户 ${actor?.tenant ?? ""} 的 ERP 出站写入已暂停`
                    : `租户 ${actor?.tenant ?? ""} 的 ERP 出站写入通道已开启`}
                </h3>
                <p className="mt-1 text-[12.5px] text-[var(--ink-secondary)]">
                  {summary.writes_paused
                    ? "当前所有已批准待派发（QUEUED）提案将暂缓发往 ERP，直至管理员手动恢复；已完成写入的回执核验不受影响。"
                    : "已批准进入 QUEUED 的提案可由 Worker 正常派发至 ERP 并执行回执核验。"}
                </p>
              </div>

              <div className="shrink-0">
                {isAdmin ? (
                  <Button
                    size="md"
                    variant={summary.writes_paused ? "primary" : "danger"}
                    loading={writeControlBusy}
                    data-testid="write-control-toggle"
                    onClick={() => setWriteConfirmTarget(!summary.writes_paused)}
                  >
                    {summary.writes_paused ? (
                      <>
                        <PlayCircle className="h-4 w-4" strokeWidth={1.75} />
                        <span>恢复 ERP 写入</span>
                      </>
                    ) : (
                      <>
                        <PauseCircle className="h-4 w-4" strokeWidth={1.75} />
                        <span>暂停 ERP 写入</span>
                      </>
                    )}
                  </Button>
                ) : (
                  <span className="inline-flex items-center rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-subtle)] px-3 py-1.5 text-[12px] text-[var(--ink-muted)]">
                    仅管理员 (admin) 可切换写入开关
                  </span>
                )}
              </div>
            </div>

            {writeControlFeedback && (
              <div
                role="status"
                data-testid="write-control-feedback"
                className={[
                  "mt-3 flex items-center gap-2 rounded-[4px] border px-3 py-2 text-[12.5px]",
                  writeControlFeedback.kind === "success"
                    ? "border-[var(--status-emerald-border)] bg-[var(--bg-sheet)] text-[var(--status-emerald)]"
                    : writeControlFeedback.kind === "warning"
                      ? "border-[var(--status-amber-border)] bg-[var(--bg-sheet)] text-[var(--status-amber-ink)]"
                      : "border-[var(--status-crimson-border)] bg-[var(--bg-sheet)] text-[var(--status-crimson)]",
                ].join(" ")}
              >
                {writeControlFeedback.kind === "success" ? (
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
                ) : (
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
                )}
                <span>{writeControlFeedback.message}</span>
                {writeControlFeedback.requestId && (
                  <span className="font-mono-code text-[11px] opacity-80">
                    跟踪编号: {writeControlFeedback.requestId}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Proposals by State Architectural Grid + ExecutionTopologyRibbon */}
          <div className="rounded-[6px] border border-[var(--hairline)] bg-[var(--bg-sheet)] overflow-hidden">
            <div className="flex flex-col gap-2 border-b border-[var(--hairline)] bg-[var(--bg-plane)] px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2">
                <h3 className="text-[12.5px] font-semibold text-[var(--ink-primary)]">
                  提案状态分布（proposals_by_state）
                </h3>
                <span className="font-mono-code text-[11px] text-[var(--ink-muted)] tabular-nums">
                  合计 {totalProposals} 条
                </span>
              </div>
              <span className="font-mono-code text-[11px] text-[var(--ink-muted)]">
                GET /v1/operations/summary
              </span>
            </div>

            <div
              data-testid="proposals-state-grid"
              className="grid grid-cols-1 divide-y divide-[var(--hairline)] sm:grid-cols-3 sm:divide-y-0"
            >
              {CANONICAL_PROPOSAL_STATES.map((stateKey, index) => {
                const count = summary.proposals_by_state[stateKey] ?? 0;
                const isExceptionState =
                  stateKey === "OUTCOME_UNKNOWN" ||
                  stateKey === "NEEDS_OPERATOR";
                const isSelected = activeTopologyState === stateKey;

                const cellContent = (
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <StatusBadge status={stateKey} compact />
                      <div className="mt-1.5 font-mono-code text-[11px] text-[var(--ink-muted)]">
                        {stateKey}
                      </div>
                    </div>
                    <div className="text-right">
                      <div
                        data-testid={`state-count-${stateKey}`}
                        className={[
                          "font-mono-code text-[22px] font-semibold leading-none tabular-nums",
                          isExceptionState && count > 0
                            ? stateKey === "NEEDS_OPERATOR"
                              ? "text-[var(--status-crimson)]"
                              : "text-[var(--status-amber-ink)]"
                            : "text-[var(--ink-primary)]",
                        ].join(" ")}
                      >
                        {count}
                      </div>
                      {isExceptionState && (
                        <div className="mt-1 text-[11px] text-[var(--accent)]">
                          查看异常队列 →
                        </div>
                      )}
                    </div>
                  </div>
                );

                const cellBorder = [
                  "p-4 transition-colors duration-[120ms]",
                  index >= 3 ? "sm:border-t sm:border-[var(--hairline)]" : "",
                  index % 3 !== 0 ? "sm:border-l sm:border-[var(--hairline)]" : "",
                  isSelected ? "bg-[var(--accent-wash)]" : "hover:bg-[var(--bg-subtle)]",
                ].join(" ");

                if (isExceptionState) {
                  return (
                    <Link
                      key={stateKey}
                      href="/admin/exceptions"
                      className={`block ${cellBorder}`}
                    >
                      {cellContent}
                    </Link>
                  );
                }

                return (
                  <button
                    key={stateKey}
                    type="button"
                    onClick={() => setManualTopologyState(stateKey)}
                    className={`w-full text-left cursor-pointer ${cellBorder}`}
                  >
                    {cellContent}
                  </button>
                );
              })}
            </div>

            {/* ExecutionTopologyRibbon Overview */}
            <div className="border-t border-[var(--hairline)] bg-[var(--bg-subtle)] p-4">
              <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2 text-[12px]">
                <span className="text-[var(--ink-secondary)]">
                  执行状态机拓扑示意 · 当前高亮阶段：
                  <strong className="ml-1 font-mono-code text-[var(--ink-primary)]">
                    {activeTopologyState}
                  </strong>
                  <span className="ml-1.5 text-[var(--ink-muted)]">
                    ({formatProposalStateLabel(activeTopologyState)})
                  </span>
                </span>
                {manualTopologyState && (
                  <button
                    type="button"
                    onClick={() => setManualTopologyState(null)}
                    className="text-[11.5px] text-[var(--accent)] hover:underline cursor-pointer"
                  >
                    恢复自动聚焦最高优先级状态
                  </button>
                )}
              </div>
              <ExecutionTopologyRibbon
                state={activeTopologyState}
                variant="auto"
              />
            </div>
          </div>
        </section>
      )}

      {/* Section 3: Local Demo Worker Tick (STRICTLY Demo + admin + operations.manage) */}
      {canRunDemoTick && (
        <section
          data-testid="demo-worker-panel"
          className="rounded-[6px] border border-[var(--hairline)] bg-[var(--bg-sheet)] p-4 sm:p-5"
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono-code text-[11px] uppercase tracking-[0.04em] text-[var(--ink-muted)]">
                  本地演示 Worker 推进
                </span>
                <SourceTag source="synthetic" />
                <code className="font-mono-code text-[11px] text-[var(--ink-muted)]">
                  POST /v1/demo/worker-tick
                </code>
              </div>
              <h3 className="mt-1.5 text-[15px] font-semibold text-[var(--ink-primary)]">
                手动步进本地 Outbox Worker
              </h3>
              <p className="mt-1 text-[12.5px] text-[var(--ink-muted)]">
                仅在本地演示模式下向具备{" "}
                <code className="font-mono-code text-[11.5px]">
                  admin + operations.manage
                </code>{" "}
                的账号开放。每次点击推进一轮队列派发或回执复核（如{" "}
                <code className="font-mono-code text-[11.5px]">
                  QUEUED → VERIFIED
                </code>
                ），完成后自动刷新汇总与异常队列。
              </p>
            </div>

            <div className="shrink-0">
              <Button
                size="md"
                variant="primary"
                loading={workerTickBusy}
                data-testid="worker-tick-btn"
                onClick={() => void handleRunWorkerTick()}
              >
                <Play className="h-3.5 w-3.5" strokeWidth={1.75} />
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
                "mt-3 flex flex-wrap items-center justify-between gap-2 rounded-[4px] border px-3 py-2 text-[12.5px]",
                workerTickFeedback.worked
                  ? "border-[var(--status-emerald-border)] bg-[var(--status-emerald-wash)] text-[var(--status-emerald)]"
                  : "border-[var(--hairline-strong)] bg-[var(--bg-subtle)] text-[var(--ink-secondary)]",
              ].join(" ")}
            >
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
                <span>
                  <code className="font-mono-code font-semibold">
                    {`{"worked": ${workerTickFeedback.worked}}`}
                  </code>{" "}
                  —{" "}
                  {workerTickFeedback.worked
                    ? "已推进 1 条队列任务，运维统计与异常预览已同步刷新。"
                    : "当前无待执行的队列任务（或租户 ERP 写入已暂停）。"}
                </span>
              </div>
              <span className="font-mono-code text-[11px] opacity-80 tabular-nums">
                {formatUnixTime(workerTickFeedback.at, { withSeconds: true }).slice(11)}
              </span>
            </div>
          )}

          {workerTickError && (
            <div className="mt-3">
              <AccessNoticeCard error={workerTickError} />
            </div>
          )}
        </section>
      )}

      {/* Section 4: Exceptions Quick Preview + Subject Suspension (2-Column Balanced Split) */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        {/* Recent Exceptions Preview */}
        <section className="rounded-[6px] border border-[var(--hairline)] bg-[var(--bg-sheet)] overflow-hidden lg:col-span-7">
          <div className="flex items-center justify-between border-b border-[var(--hairline)] bg-[var(--bg-plane)] px-4 py-2.5">
            <h3 className="text-[12.5px] font-semibold text-[var(--ink-primary)]">
              待关注异常单据预览
            </h3>
            <Link
              href="/admin/exceptions"
              className="inline-flex items-center gap-1 text-[12px] font-medium text-[var(--accent)] hover:underline"
            >
              <span>进入完整异常队列</span>
              <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.75} />
            </Link>
          </div>

          {exceptionPreview.length === 0 ? (
            <div className="flex flex-col items-center gap-1.5 px-4 py-8 text-center text-[12.5px] text-[var(--ink-muted)]">
              <CheckCircle2
                className="h-5 w-5 text-[var(--status-emerald)]"
                strokeWidth={1.75}
              />
              <span>当前授权仓库内暂无 NEEDS_OPERATOR 或 OUTCOME_UNKNOWN 单据。</span>
            </div>
          ) : (
            <div className="divide-y divide-[var(--hairline)]">
              {exceptionPreview.map((item) => (
                <div
                  key={item.proposal_id}
                  className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 hover:bg-[var(--bg-subtle)] transition-colors duration-[120ms]"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Link
                        href={`/proposals/${encodeURIComponent(item.proposal_id)}`}
                        className="font-mono-code text-[12.5px] font-semibold text-[var(--ink-primary)] hover:text-[var(--accent)] hover:underline"
                      >
                        {item.proposal_id}
                      </Link>
                      <span className="rounded-[2px] border border-[var(--hairline)] bg-[var(--bg-subtle)] px-1.5 py-0.5 font-mono-code text-[10.5px] text-[var(--ink-secondary)]">
                        {item.warehouse}
                      </span>
                    </div>
                    <div className="mt-0.5 font-mono-code text-[11px] text-[var(--ink-muted)] tabular-nums">
                      核验轮次 {item.checks} · 事件 {item.last_event ?? "—"}
                    </div>
                  </div>
                  <StatusBadge status={item.state} compact />
                </div>
              ))}
              {hasMoreExceptions && (
                <div className="bg-[var(--bg-subtle)] px-4 py-2 text-right text-[11.5px] text-[var(--ink-muted)]">
                  仅展示前 5 条，请前往异常单据队列翻页处理全部记录。
                </div>
              )}
            </div>
          )}
        </section>

        {/* Subject Suspension Card (admin only) */}
        <section
          data-testid="subject-suspension-panel"
          className="rounded-[6px] border border-[var(--hairline)] bg-[var(--bg-sheet)] overflow-hidden lg:col-span-5"
        >
          <div className="flex items-center justify-between border-b border-[var(--hairline)] bg-[var(--bg-plane)] px-4 py-2.5">
            <h3 className="text-[12.5px] font-semibold text-[var(--ink-primary)]">
              主体紧急停权控制
            </h3>
            <code className="font-mono-code text-[10.5px] text-[var(--ink-muted)]">
              /subjects/…/suspension
            </code>
          </div>

          <div className="p-4">
            {isAdmin ? (
              <div className="space-y-3">
                <p className="text-[12px] text-[var(--ink-muted)] leading-relaxed">
                  按主体标识（subject）在本租户内立即停用或恢复员工的全部 API 访问（停权将返回{" "}
                  <code className="font-mono-code text-[11px]">403</code>{" "}
                  并阻断其待派发提案）。管理员不可停用本人账号。
                </p>
                <div>
                  <label
                    htmlFor="suspension-subject-input"
                    className="block text-[12px] font-medium text-[var(--ink-secondary)]"
                  >
                    目标主体标识 (subject)
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
                    className="mt-1 h-9 w-full rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-2.5 font-mono-code text-[12.5px] text-[var(--ink-primary)] placeholder:font-sans placeholder:text-[var(--ink-faint)] focus:border-[var(--accent)] focus:outline-none"
                  />
                  {isSelfSuspensionTarget && (
                    <p className="mt-1 text-[11.5px] text-[var(--status-crimson)]">
                      管理员不可对当前登录的本人主体执行停权。
                    </p>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={
                      !trimmedSuspendSubject ||
                      isSelfSuspensionTarget ||
                      suspendBusy
                    }
                    data-testid="suspension-suspend-btn"
                    onClick={() => handleRequestSuspension(true)}
                  >
                    <UserX className="h-3.5 w-3.5" strokeWidth={1.75} />
                    <span>停用访问</span>
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={
                      !trimmedSuspendSubject ||
                      isSelfSuspensionTarget ||
                      suspendBusy
                    }
                    data-testid="suspension-restore-btn"
                    onClick={() => handleRequestSuspension(false)}
                  >
                    <UserCheck className="h-3.5 w-3.5" strokeWidth={1.75} />
                    <span>恢复访问</span>
                  </Button>
                </div>

                {suspendFeedback && (
                  <div
                    role="status"
                    data-testid="suspension-feedback"
                    className={[
                      "rounded-[4px] border px-3 py-2 text-[12px]",
                      suspendFeedback.kind === "success"
                        ? "border-[var(--status-emerald-border)] bg-[var(--status-emerald-wash)] text-[var(--status-emerald)]"
                        : suspendFeedback.kind === "warning"
                          ? "border-[var(--status-amber-border)] bg-[var(--status-amber-wash)] text-[var(--status-amber-ink)]"
                          : "border-[var(--status-crimson-border)] bg-[var(--status-crimson-wash)] text-[var(--status-crimson)]",
                    ].join(" ")}
                  >
                    <span>{suspendFeedback.message}</span>
                    {suspendFeedback.requestId && (
                      <span className="ml-2 font-mono-code text-[11px]">
                        跟踪编号: {suspendFeedback.requestId}
                      </span>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="flex items-start gap-2 text-[12.5px] text-[var(--ink-muted)]">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.75} />
                <span>
                  主体停权操作仅限租户管理员（<code className="font-mono-code">admin</code>）执行；主管（manager）可查看运维监控与处置异常单据。
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
          className="rounded-[6px] border border-[var(--hairline)] bg-[var(--bg-sheet)] overflow-hidden"
        >
          <div className="flex items-center justify-between border-b border-[var(--hairline)] bg-[var(--bg-plane)] px-4 py-2.5">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-3.5 w-3.5 text-[var(--ink-secondary)]" strokeWidth={1.75} />
              <h3 className="text-[12.5px] font-semibold text-[var(--ink-primary)]">
                受控预审审计签名检查点（只读元数据）
              </h3>
            </div>
            <code className="font-mono-code text-[11px] text-[var(--ink-muted)]">
              GET /v1/assurance/audit/checkpoint
            </code>
          </div>

          <div className="p-4">
            {checkpoint ? (
              <dl className="grid grid-cols-1 gap-3 text-[12px] sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] p-2.5">
                  <dt className="text-[11px] text-[var(--ink-muted)]">检查点序号 (seq)</dt>
                  <dd className="mt-1 font-mono-code text-[14px] font-semibold text-[var(--ink-primary)] tabular-nums">
                    #{checkpoint.seq}
                  </dd>
                </div>
                <div className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] p-2.5">
                  <dt className="text-[11px] text-[var(--ink-muted)]">检查点类型</dt>
                  <dd className="mt-1 font-mono-code text-[12px] text-[var(--ink-primary)] break-all">
                    {checkpoint.type}
                  </dd>
                </div>
                <div className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] p-2.5">
                  <dt className="flex items-center justify-between text-[11px] text-[var(--ink-muted)]">
                    <span>链表摘要 (hash)</span>
                    <button
                      type="button"
                      onClick={() => void handleCopyHash(checkpoint.hash)}
                      className="inline-flex items-center gap-1 text-[10.5px] text-[var(--accent)] hover:underline cursor-pointer"
                    >
                      <Copy className="h-3 w-3" />
                      <span>{copiedHash ? "已复制" : "复制"}</span>
                    </button>
                  </dt>
                  <dd
                    title={checkpoint.hash}
                    className="mt-1 font-mono-code text-[12px] text-[var(--ink-primary)]"
                  >
                    {formatShortDigest(checkpoint.hash, 12, 8)}
                  </dd>
                </div>
                <div className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] p-2.5">
                  <dt className="text-[11px] text-[var(--ink-muted)]">密钥标识 (key_id)</dt>
                  <dd
                    title={checkpoint.key_id}
                    className="mt-1 font-mono-code text-[12px] text-[var(--ink-primary)]"
                  >
                    {formatShortDigest(checkpoint.key_id, 10, 8)}
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="text-[12.5px] text-[var(--ink-muted)]">
                {checkpointUnavailableMsg ?? "正在获取审计签名检查点…"}
              </p>
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
            ? "暂停后将阻断本租户所有已批准待派发（QUEUED）提案向 ERP 发起出站写入，直至管理员再次手动恢复；已发送单据的只读回执核验不受影响。"
            : "恢复后将允许本租户所有待派发（QUEUED）提案按 Worker 调度继续写入 ERP，请确认当前上游 ERP 环境状态正常。"
        }
        scopeSummary={`租户 ${actor?.tenant ?? "—"}（全部站点）· 操作人可见站点 ${actor?.warehouses.join(", ") || "—"}`}
        metadata={[
          { label: "目标租户", value: actor?.tenant ?? "—", mono: true },
          {
            label: "当前写入状态",
            value: summary?.writes_paused ? "paused (已暂停)" : "active (正常运行)",
            mono: true,
          },
          {
            label: "变更后状态",
            value: writeConfirmTarget ? "paused (已暂停)" : "active (正常运行)",
            mono: true,
          },
          {
            label: "当前 QUEUED 数量",
            value: String(summary?.proposals_by_state.QUEUED ?? 0),
            mono: true,
          },
        ]}
        confirmLabel={writeConfirmTarget ? "确认暂停 ERP 写入" : "确认恢复 ERP 写入"}
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
            ? "停权生效后，该主体在本租户内的所有接口请求将被立即拦截（403），其发起的尚未派发提案在出站前也将被阻断。"
            : "恢复后，该主体将重新按其身份声明与已配置的模块授权规则访问本租户工作台。"
        }
        scopeSummary={`租户 ${actor?.tenant ?? "—"} · 目标主体 ${suspendConfirm?.subject ?? "—"}`}
        metadata={[
          { label: "租户", value: actor?.tenant ?? "—", mono: true },
          {
            label: "目标主体 (subject)",
            value: suspendConfirm?.subject ?? "—",
            mono: true,
          },
          {
            label: "提交操作",
            value: suspendConfirm?.suspended
              ? "suspended: true (停用)"
              : "suspended: false (恢复)",
            mono: true,
          },
        ]}
        confirmLabel={suspendConfirm?.suspended ? "确认停用访问" : "确认恢复访问"}
        cancelLabel="取消"
        dialogTestId="suspension-confirm-dialog"
        confirmTestId="confirm-dialog-submit"
        onConfirm={handleConfirmSuspension}
      />
    </div>
  );
}
