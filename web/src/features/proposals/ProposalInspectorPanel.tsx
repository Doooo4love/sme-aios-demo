"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  FileSearch,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  UserCheck,
  UserMinus,
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
import { ExecutionTopologyRibbon } from "@/components/kinetic/ExecutionTopologyRibbon";
import {
  StatePulseBeacon,
  proposalStateToBeacon,
} from "@/components/kinetic/StatePulseBeacon";
import { AccessNoticeCard } from "@/components/ui/AccessNoticeCard";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { StatusBadge } from "@/components/ui/StatusBadge";
import {
  NON_TERMINAL_PROPOSAL_STATES,
  type IntakeDetail,
  type Proposal,
  type ProposalState,
} from "@/lib/types";
import {
  approveProposal,
  fetchProposalDetail,
  fetchProposalIntake,
  reconcileProposal,
  reviewProposal,
  triggerDemoWorkerTick,
} from "@/features/proposals/api";
import {
  ProposalDiffView,
  extractSalesOrderBefore,
  summarizePlanChange,
} from "@/features/proposals/ProposalDiffView";

export interface ProposalInspectorPanelProps {
  proposalId: string;
  mode: "page" | "drawer";
  onProposalUpdated?: (proposal: Proposal) => void;
}

const MAX_POLL_CYCLES = 24;
const DEFAULT_POLL_MS = 2500;
const POLLABLE_PROPOSAL_STATES: ReadonlySet<ProposalState> = new Set([
  "QUEUED",
  "SENDING",
  "VERIFYING",
  "CHECKING",
]);

const EVENT_LABELS: Record<
  string,
  { label: string; tone: "neutral" | "emerald" | "amber" | "crimson" }
> = {
  PROPOSED: { label: "已创建提案", tone: "neutral" },
  APPROVED_AND_QUEUED: { label: "独立主管已批准并入队", tone: "neutral" },
  QUEUED: { label: "已进入出站队列", tone: "neutral" },
  SENDING: { label: "正在向 ERP 派发", tone: "neutral" },
  VERIFYING: { label: "正在回查 ERP 回执", tone: "neutral" },
  CHECKING: { label: "执行回执复核", tone: "amber" },
  OUTCOME_UNKNOWN: { label: "传输结果待确认", tone: "amber" },
  VERIFIED: { label: "已核验入账（回执一致）", tone: "emerald" },
  REVIEW_ASSIGNED: { label: "已分派审批人", tone: "neutral" },
  REVIEW_RELEASED: { label: "已释放审批分派", tone: "neutral" },
  REVIEW_RETURNED: { label: "审批退回（终止）", tone: "amber" },
  REVIEW_REJECTED: { label: "审批拒绝（终止）", tone: "crimson" },
  WRITES_PAUSED_BEFORE_SEND: { label: "ERP 写入暂停，保持排队", tone: "amber" },
  LEASE_EXPIRED_VERIFY_ONLY: { label: "租约超时，切换为只读核验", tone: "amber" },
  REOPEN_VERIFICATION: { label: "运维重新发起回执核验", tone: "amber" },
  REJECTED: { label: "已终止", tone: "crimson" },
  NEEDS_OPERATOR: { label: "需运维人工核查", tone: "crimson" },
  ACCESS_SUSPENDED_BEFORE_SEND: { label: "账号已停权，阻断出站", tone: "crimson" },
  APPROVAL_EXPIRED_BEFORE_SEND: { label: "审批已过期，阻断出站", tone: "crimson" },
  MODULE_ACCESS_REVOKED_BEFORE_SEND: {
    label: "模块权限已撤销，阻断出站",
    tone: "crimson",
  },
  ERP_PRE_WRITE_REJECTION: { label: "ERP 写入前拒绝", tone: "crimson" },
  ERP_RECEIPT_MISMATCH: { label: "ERP 回执摘要不一致", tone: "crimson" },
  READBACK_LIMIT_REACHED: { label: "达到回查次数上限", tone: "crimson" },
  INVALID_STORED_PLAN: { label: "提案计划校验失败", tone: "crimson" },
  PLAN_DIGEST_OR_TENANT_MISMATCH: { label: "摘要或租户边界不匹配", tone: "crimson" },
};

const DEMO_APPROVER_SUGGESTIONS: Record<string, string[]> = {
  harbour: ["manager", "admin", "access-admin", "other-manager"],
  island: ["island-manager"],
};

type ActiveDialog =
  | null
  | "approve"
  | "return"
  | "reject"
  | "assign"
  | "release"
  | "reconcile";

interface ConflictHighlight {
  previousDigest: string;
  previousState: string;
  previousAssignedTo: string | null;
  message: string;
}

export function ProposalInspectorPanel({
  proposalId,
  mode,
  onProposalUpdated,
}: ProposalInspectorPanelProps) {
  const {
    actor,
    capabilities,
    demoConfig,
    authGeneration,
    canAccessAdminOps,
    handleAccessChanged,
  } = useSession();

  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [accessChangedPurged, setAccessChangedPurged] = useState(false);

  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<{
    error?: ApiError;
    variant?:
      | "ACCESS_RESTRICTED"
      | "ACTION_NOT_ALLOWED"
      | "ACCESS_CHANGED"
      | "CONFLICT"
      | "RETRY_LATER";
    title?: string;
    message: string;
  } | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [conflictHighlight, setConflictHighlight] =
    useState<ConflictHighlight | null>(null);

  const [activeDialog, setActiveDialog] = useState<ActiveDialog>(null);
  const [reasonInput, setReasonInput] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [assigneeInput, setAssigneeInput] = useState("");
  const [assigneeError, setAssigneeError] = useState<string | null>(null);

  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [pollCount, setPollCount] = useState(0);
  const [pollExhausted, setPollExhausted] = useState(false);
  const [retryWaitSeconds, setRetryWaitSeconds] = useState<number | null>(null);
  const [workerTickLoading, setWorkerTickLoading] = useState(false);

  // On-demand Intake Evidence expansion
  const [intakeOpen, setIntakeOpen] = useState(false);
  const [intakeDetail, setIntakeDetail] = useState<IntakeDetail | null>(null);
  const [intakeLoading, setIntakeLoading] = useState(false);
  const [intakeError, setIntakeError] = useState<ApiError | null>(null);

  const onProposalUpdatedRef = useRef(onProposalUpdated);
  onProposalUpdatedRef.current = onProposalUpdated;

  const isDrawer = mode === "drawer";

  // Reset all state on proposalId or authGeneration change
  useEffect(() => {
    setProposal(null);
    setLoadError(null);
    setAccessChangedPurged(false);
    setActionError(null);
    setActionSuccess(null);
    setConflictHighlight(null);
    setActiveDialog(null);
    setPollCount(0);
    setPollExhausted(false);
    setRetryWaitSeconds(null);
    setIntakeOpen(false);
    setIntakeDetail(null);
    setIntakeError(null);
  }, [proposalId, authGeneration]);

  const loadProposal = useCallback(
    async (options?: {
      silent?: boolean;
      signal?: AbortSignal;
    }): Promise<{ proposal: Proposal | null; retryAfter: number | null }> => {
      const startGen = getAuthGeneration();
      if (!options?.silent) {
        setLoading(true);
        setLoadError(null);
      }
      try {
        const data = await fetchProposalDetail(proposalId, options?.signal);
        if (startGen !== getAuthGeneration()) {
          return { proposal: null, retryAfter: null };
        }
        setProposal(data);
        setLoadError(null);
        setAccessChangedPurged(false);
        setRetryWaitSeconds(null);
        onProposalUpdatedRef.current?.(data);
        return { proposal: data, retryAfter: null };
      } catch (error) {
        if (isStaleAuthError(error) || startGen !== getAuthGeneration()) {
          return { proposal: null, retryAfter: null };
        }
        if (error instanceof DOMException && error.name === "AbortError") {
          return { proposal: null, retryAfter: null };
        }
        if (isApiError(error)) {
          if (error.code === "ACCESS_CHANGED") {
            setProposal(null);
            setIntakeDetail(null);
            setAccessChangedPurged(true);
            setLoadError(error);
            void handleAccessChanged();
            return { proposal: null, retryAfter: null };
          }
          if (error.status === 404 || error.code === "RECORD_UNAVAILABLE") {
            setProposal(null);
            setIntakeDetail(null);
            setLoadError(error);
            return { proposal: null, retryAfter: null };
          }
          if (
            options?.silent &&
            (error.status === 429 || error.status === 503)
          ) {
            const waitSec = error.retryAfter ?? 5;
            setRetryWaitSeconds(waitSec);
            return { proposal: null, retryAfter: waitSec };
          }
          setLoadError(error);
        }
        return { proposal: null, retryAfter: null };
      } finally {
        if (!options?.silent && startGen === getAuthGeneration()) {
          setLoading(false);
        }
      }
    },
    [proposalId, handleAccessChanged],
  );

  // Always re-authorize on mount / proposalId / authGeneration change
  useEffect(() => {
    const controller = new AbortController();
    void loadProposal({ signal: controller.signal });
    return () => controller.abort();
  }, [loadProposal, authGeneration]);

  // Bounded polling strictly while proposal is in QUEUED | SENDING | VERIFYING | CHECKING
  // Stops automatically on terminal/held states (VERIFIED, REJECTED, OUTCOME_UNKNOWN, NEEDS_OPERATOR),
  // unmount, proposalId change, or authGeneration change.
  const proposalState = proposal?.state ?? null;
  const isPollableState = proposalState
    ? POLLABLE_PROPOSAL_STATES.has(proposalState)
    : false;
  const isNonTerminal = proposalState
    ? NON_TERMINAL_PROPOSAL_STATES.has(proposalState)
    : false;

  useEffect(() => {
    if (!proposalId || !isPollableState || pollExhausted) return;

    let cancelled = false;
    let timerId: number | null = null;
    let activeController: AbortController | null = null;
    let cycles = 0;

    const scheduleNext = (delayMs: number) => {
      if (cancelled) return;
      if (cycles >= MAX_POLL_CYCLES) {
        setPollExhausted(true);
        return;
      }
      timerId = window.setTimeout(async () => {
        if (cancelled) return;
        activeController = new AbortController();
        const res = await loadProposal({
          silent: true,
          signal: activeController.signal,
        });
        if (cancelled) return;
        cycles += 1;
        setPollCount(cycles);

        if (res.proposal && !POLLABLE_PROPOSAL_STATES.has(res.proposal.state)) {
          return;
        }
        if (cycles >= MAX_POLL_CYCLES) {
          setPollExhausted(true);
          return;
        }
        const nextDelay = res.retryAfter
          ? Math.max(res.retryAfter * 1000, DEFAULT_POLL_MS)
          : DEFAULT_POLL_MS;
        scheduleNext(nextDelay);
      }, delayMs);
    };

    scheduleNext(DEFAULT_POLL_MS);

    return () => {
      cancelled = true;
      if (timerId !== null) window.clearTimeout(timerId);
      activeController?.abort();
    };
  }, [proposalId, isPollableState, pollExhausted, authGeneration, loadProposal]);

  const intakeId = useMemo(() => {
    if (!proposal) return null;
    const before = extractSalesOrderBefore(proposal.plan);
    return before?.intake_id || null;
  }, [proposal]);

  const handleToggleIntake = async () => {
    if (!intakeId) return;
    const nextOpen = !intakeOpen;
    setIntakeOpen(nextOpen);
    if (nextOpen && !intakeDetail && !intakeLoading) {
      setIntakeLoading(true);
      setIntakeError(null);
      try {
        const res = await fetchProposalIntake(intakeId);
        setIntakeDetail(res);
      } catch (error) {
        if (isStaleAuthError(error)) return;
        if (isApiError(error)) {
          if (error.code === "ACCESS_CHANGED") {
            setProposal(null);
            setIntakeDetail(null);
            setAccessChangedPurged(true);
            void handleAccessChanged();
          }
          setIntakeError(error);
        }
      } finally {
        setIntakeLoading(false);
      }
    }
  };

  const handleCopy = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      window.setTimeout(() => {
        setCopiedKey((prev) => (prev === key ? null : prev));
      }, 1600);
    } catch {
      // Clipboard may be restricted in headless contexts
    }
  };

  // Strict capability derivation for actions
  const permissions = useMemo(() => {
    if (!proposal || !actor) {
      return {
        canApprove: false,
        canReturnOrReject: false,
        canAssign: false,
        canRelease: false,
        canReconcile: false,
        isSelfRequester: false,
        assignedTo: null as string | null,
        assignedToOther: false,
        hasApprovalScope: false,
      };
    }

    const isApproverRole = actor.role === "manager" || actor.role === "admin";
    const approvalSites =
      capabilities?.approval_warehouses?.[proposal.plan.action] ?? [];
    const hasApprovalScope =
      isApproverRole && approvalSites.includes(proposal.warehouse);
    const isSelfRequester = actor.subject === proposal.requester;
    const assignedTo = proposal.review?.assigned_to ?? null;
    const assignedToOther =
      assignedTo !== null && assignedTo !== actor.subject;
    const isProposed = proposal.state === "PROPOSED";

    const eligibleApprover =
      isProposed && hasApprovalScope && !isSelfRequester && !assignedToOther;

    const canRelease =
      isProposed &&
      hasApprovalScope &&
      !isSelfRequester &&
      assignedTo !== null &&
      (assignedTo === actor.subject || actor.role === "admin");

    const canReconcile =
      proposal.state === "NEEDS_OPERATOR" &&
      canAccessAdminOps &&
      actor.warehouses.includes(proposal.warehouse);

    return {
      canApprove: eligibleApprover,
      canReturnOrReject: eligibleApprover,
      canAssign: eligibleApprover,
      canRelease,
      canReconcile,
      isSelfRequester,
      assignedTo,
      assignedToOther,
      hasApprovalScope,
    };
  }, [proposal, actor, capabilities, canAccessAdminOps]);

  const handleMutationError = useCallback(
    async (error: unknown, priorProposal: Proposal) => {
      if (isStaleAuthError(error)) return;
      if (!isApiError(error)) {
        setActionError({
          message: "操作未能完成，请刷新后重试。",
        });
        return;
      }

      if (error.code === "ACCESS_CHANGED") {
        setProposal(null);
        setIntakeDetail(null);
        setAccessChangedPurged(true);
        setActiveDialog(null);
        void handleAccessChanged();
        return;
      }

      if (error.status === 404 || error.code === "RECORD_UNAVAILABLE") {
        setProposal(null);
        setLoadError(error);
        setActiveDialog(null);
        return;
      }

      if (error.status === 403) {
        const isSelfOrIndependent =
          error.code === "ACTION_NOT_ALLOWED" ||
          actor?.subject === priorProposal.requester ||
          (typeof error.rawDetail === "string" &&
            error.rawDetail.toLowerCase().includes("independent"));
        setActionError({
          error,
          variant: "ACTION_NOT_ALLOWED",
          title: isSelfOrIndependent
            ? "无法审批本人提交的提案"
            : "当前账号无权执行该审批操作",
          message: isSelfOrIndependent
            ? "不能审批本人提交的提案，请由独立主管审批。"
            : error.message,
        });
        setActiveDialog(null);
        return;
      }

      if (error.status === 409) {
        setActiveDialog(null);
        const refreshedRes = await loadProposal({ silent: true });
        const refreshed = refreshedRes.proposal;
        setConflictHighlight({
          previousDigest: priorProposal.digest,
          previousState: priorProposal.state,
          previousAssignedTo: priorProposal.review?.assigned_to ?? null,
          message:
            refreshed && refreshed.digest !== priorProposal.digest
              ? "提案摘要已变更，已加载最新快照，请核对差异后再重新确认。"
              : "提案状态或分派归属已变更，已刷新最新快照，请核对后再操作。",
        });
        setActionError({
          error,
          variant: "CONFLICT",
          title: "乐观锁冲突（409）· 已刷新最新快照",
          message:
            "提案摘要、状态或分派已发生变化，请核对下方最新差异后重新确认提交。",
        });
        return;
      }

      if (error.status === 429 || error.status >= 500) {
        setActionError({
          error,
          variant: "RETRY_LATER",
          message: error.message,
        });
        setActiveDialog(null);
        return;
      }

      setActionError({
        error,
        message: error.message,
      });
      setActiveDialog(null);
    },
    [actor, handleAccessChanged, loadProposal],
  );

  const executeApprove = async () => {
    if (!proposal) return;
    const snapshot = proposal;
    setActionLoading(true);
    setActionError(null);
    setActionSuccess(null);
    setConflictHighlight(null);
    try {
      const updated = await approveProposal(snapshot.id, snapshot.digest);
      setProposal(updated);
      setActiveDialog(null);
      setPollCount(0);
      setPollExhausted(false);
      setActionSuccess("已批准并进入执行队列（QUEUED · 等待执行）。");
      onProposalUpdatedRef.current?.(updated);
    } catch (error) {
      await handleMutationError(error, snapshot);
    } finally {
      setActionLoading(false);
    }
  };

  const executeReview = async (action: "return" | "reject" | "assign" | "release") => {
    if (!proposal) return;
    if (action === "return" || action === "reject") {
      const trimmed = reasonInput.trim();
      if (!trimmed) {
        setReasonError("请填写必填原因（1–240 字符）。");
        return;
      }
      if (trimmed.length > 240) {
        setReasonError("原因不能超过 240 字符。");
        return;
      }
      setReasonError(null);
    }
    if (action === "assign") {
      const trimmed = assigneeInput.trim();
      if (!trimmed || !/^[A-Za-z0-9._:@-]+$/.test(trimmed)) {
        setAssigneeError("请输入有效的同事账号（例如 manager）。");
        return;
      }
      setAssigneeError(null);
    }

    const snapshot = proposal;
    setActionLoading(true);
    setActionError(null);
    setActionSuccess(null);
    setConflictHighlight(null);
    try {
      const updated = await reviewProposal(snapshot.id, {
        digest: snapshot.digest,
        action,
        reason:
          action === "return" || action === "reject"
            ? reasonInput.trim()
            : null,
        assignee: action === "assign" ? assigneeInput.trim() : null,
      });
      setProposal(updated);
      setActiveDialog(null);
      setReasonInput("");
      setAssigneeInput("");
      const successText: Record<typeof action, string> = {
        return: "提案已退回发起人（当前提案已终止，需重新进件）。",
        reject: "提案已正式拒绝（终止）。",
        assign: `提案已分派给 ${updated.review?.assigned_to ?? "指定审批人"}。`,
        release: "已释放当前审批分派，同站点独立主管均可认领。",
      };
      setActionSuccess(successText[action]);
      onProposalUpdatedRef.current?.(updated);
    } catch (error) {
      await handleMutationError(error, snapshot);
    } finally {
      setActionLoading(false);
    }
  };

  const executeReconcile = async () => {
    if (!proposal) return;
    const snapshot = proposal;
    setActionLoading(true);
    setActionError(null);
    setActionSuccess(null);
    try {
      const updated = await reconcileProposal(snapshot.id);
      setProposal(updated);
      setActiveDialog(null);
      setPollCount(0);
      setPollExhausted(false);
      setActionSuccess("已重新发起只读回执核验（OUTCOME_UNKNOWN）。");
      onProposalUpdatedRef.current?.(updated);
    } catch (error) {
      await handleMutationError(error, snapshot);
    } finally {
      setActionLoading(false);
    }
  };

  const executeDemoWorkerTick = async () => {
    if (!proposal) return;
    setWorkerTickLoading(true);
    setActionError(null);
    try {
      const res = await triggerDemoWorkerTick();
      await loadProposal({ silent: true });
      setActionSuccess(
        res.worked
          ? "Worker 已推进 1 步执行，已同步最新提案状态。"
          : "当前无待推进的队列任务，已刷新状态。",
      );
    } catch (error) {
      if (!isStaleAuthError(error) && isApiError(error)) {
        setActionError({ error, message: error.message });
      }
    } finally {
      setWorkerTickLoading(false);
    }
  };

  // --- Access Boundary / Error Views ---
  if (accessChangedPurged) {
    return (
      <div
        className={isDrawer ? "space-y-3" : "mx-auto max-w-[960px] p-4 lg:p-6"}
        data-testid="access-notice-access-changed"
      >
        <AccessNoticeCard
          variant="ACCESS_CHANGED"
          backHref={isDrawer ? undefined : "/work"}
          onRetry={() => void loadProposal()}
        />
      </div>
    );
  }

  if (loading && !proposal) {
    return (
      <div
        className={
          isDrawer
            ? "py-10 text-center text-[12.5px] text-[var(--ink-muted)]"
            : "mx-auto max-w-[1120px] p-6"
        }
        data-testid="proposal-loading"
      >
        <div className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-sheet)] p-6 text-center text-[13px] text-[var(--ink-muted)]">
          正在实时校验权限并加载提案详情…
        </div>
      </div>
    );
  }

  if (loadError && !proposal) {
    const isUnavailable =
      loadError.status === 404 || loadError.code === "RECORD_UNAVAILABLE";
    return (
      <div
        className={isDrawer ? "space-y-3" : "mx-auto max-w-[760px] p-4 lg:p-8"}
        data-testid={
          isUnavailable
            ? "access-notice-record-unavailable"
            : "proposal-load-error"
        }
      >
        <AccessNoticeCard
          error={loadError}
          backHref={isDrawer ? undefined : "/work"}
          onRetry={isUnavailable ? undefined : () => void loadProposal()}
        />
      </div>
    );
  }

  if (!proposal) return null;

  const beaconState = proposalStateToBeacon(proposal.state);
  const expiryInfo = formatRelativeCountdown(proposal.expires);
  const changeSummary = summarizePlanChange(proposal.plan);
  const canDemoTick =
    Boolean(demoConfig?.enabled) &&
    actor?.role === "admin" &&
    canAccessAdminOps &&
    isNonTerminal;

  const confirmMetadata = [
    { label: "提案编号", value: proposal.id, mono: true },
    { label: "仓库站点", value: proposal.warehouse, mono: true },
    { label: "动作类型", value: formatProposalAction(proposal.plan.action) },
    { label: "目标对象", value: proposal.plan.target, mono: true },
    { label: "拟变更内容", value: changeSummary },
    { label: "摘要锁 (Digest)", value: proposal.digest, mono: true },
  ];

  const approverSuggestions =
    (actor?.tenant ? DEMO_APPROVER_SUGGESTIONS[actor.tenant] : []) ?? [];

  return (
    <div
      className={
        isDrawer
          ? "space-y-3"
          : "mx-auto max-w-[1120px] space-y-4 p-4 lg:p-6 pb-16"
      }
      data-testid={
        isDrawer ? "proposal-drawer-inspector" : "proposal-detail-page"
      }
    >
      {/* Header Strip */}
      <div className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-sheet)] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              {!isDrawer && (
                <Link
                  href="/work"
                  className="inline-flex h-7 items-center gap-1 rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-subtle)] px-2 text-[12px] font-medium text-[var(--ink-secondary)] hover:bg-[var(--bg-plane)] hover:text-[var(--ink-primary)]"
                >
                  <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} />
                  <span>工作台</span>
                </Link>
              )}
              <span
                className="font-mono-code text-[14px] font-semibold text-[var(--ink-primary)] break-all"
                data-testid="proposal-id-value"
              >
                {proposal.id}
              </span>
              <button
                type="button"
                onClick={() => void handleCopy("id", proposal.id)}
                title="复制提案编号"
                aria-label="复制提案编号"
                className="inline-flex h-6 w-6 items-center justify-center rounded-[4px] border border-[var(--hairline)] text-[var(--ink-muted)] hover:bg-[var(--bg-subtle)] hover:text-[var(--ink-primary)] cursor-pointer"
              >
                {copiedKey === "id" ? (
                  <Check className="h-3 w-3 text-[var(--status-emerald)]" />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
              </button>
              <span className="rounded-[2px] border border-[var(--hairline-strong)] bg-[var(--bg-subtle)] px-1.5 py-0.5 font-mono-code text-[11px] font-medium text-[var(--ink-secondary)]">
                {proposal.warehouse}
              </span>
              <StatusBadge
                status={
                  proposal.state === "REJECTED" &&
                  proposal.review?.decision === "returned"
                    ? "returned"
                    : proposal.state
                }
                compact={isDrawer}
              />
            </div>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-[var(--ink-secondary)]">
              <span className="font-medium text-[var(--ink-primary)]">
                {formatProposalAction(proposal.plan.action)}
              </span>
              <span className="text-[var(--ink-faint)]">·</span>
              <span className="font-mono-code text-[12px]">
                {proposal.plan.target}
              </span>
              {beaconState && (
                <>
                  <span className="text-[var(--ink-faint)]">·</span>
                  <StatePulseBeacon
                    state={beaconState}
                    detail={
                      proposal.checks > 0
                        ? `核验 ${proposal.checks}/3`
                        : retryWaitSeconds
                          ? `Retry-After ${retryWaitSeconds}s`
                          : undefined
                    }
                  />
                </>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setPollCount(0);
                setPollExhausted(false);
                void loadProposal();
              }}
              data-testid="proposal-refresh-btn"
            >
              <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} />
              <span>刷新</span>
            </Button>

            {isDrawer && (
              <Link
                href={`/proposals/${encodeURIComponent(proposal.id)}`}
                data-testid="drawer-open-proposal-page-link"
                className="inline-flex h-7 items-center gap-1 rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-2.5 text-[12px] font-medium text-[var(--ink-primary)] hover:bg-[var(--bg-subtle)]"
              >
                <span>打开独立页面</span>
                <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.75} />
              </Link>
            )}

            {canDemoTick && (
              <Button
                size="sm"
                variant="secondary"
                loading={workerTickLoading}
                onClick={() => void executeDemoWorkerTick()}
                data-testid="proposal-worker-tick-btn"
              >
                <Play className="h-3.5 w-3.5" strokeWidth={1.75} />
                <span>推进 Worker</span>
              </Button>
            )}
          </div>
        </div>

        {/* Bounded Polling Notice when active or cap reached */}
        {isPollableState && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--hairline-subtle)] pt-2.5 text-[11.5px] text-[var(--ink-muted)]">
            <span>
              {pollExhausted
                ? "已达到自动轮询上限，可点击右上角「刷新」手动获取最新状态。"
                : "正在对当前执行中单据进行有界状态轮询，进入终态或离开页面后自动停止。"}
            </span>
            <span className="font-mono-code tabular-nums">
              轮询 {pollCount}/{MAX_POLL_CYCLES}
            </span>
          </div>
        )}

        {/* Formal Action Bar */}
        {(permissions.canApprove ||
          permissions.canRelease ||
          permissions.canReconcile) && (
          <div
            className="mt-3 flex flex-wrap items-center gap-2 border-t border-[var(--hairline)] pt-3"
            data-testid="proposal-actions-bar"
          >
            {permissions.canApprove && (
              <Button
                variant="primary"
                size={isDrawer ? "sm" : "md"}
                onClick={() => {
                  setActionError(null);
                  setActiveDialog("approve");
                }}
                data-testid="proposal-approve-btn"
              >
                <ShieldCheck className="h-4 w-4" strokeWidth={1.75} />
                <span>批准并入队</span>
              </Button>
            )}

            {permissions.canReturnOrReject && (
              <>
                <Button
                  variant="secondary"
                  size={isDrawer ? "sm" : "md"}
                  onClick={() => {
                    setReasonInput("");
                    setReasonError(null);
                    setActiveDialog("return");
                  }}
                  data-testid="proposal-return-btn"
                >
                  <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.75} />
                  <span>退回</span>
                </Button>

                <Button
                  variant="danger"
                  size={isDrawer ? "sm" : "md"}
                  onClick={() => {
                    setReasonInput("");
                    setReasonError(null);
                    setActiveDialog("reject");
                  }}
                  data-testid="proposal-reject-btn"
                >
                  <XCircle className="h-3.5 w-3.5" strokeWidth={1.75} />
                  <span>拒绝</span>
                </Button>
              </>
            )}

            {permissions.canAssign && (
              <Button
                variant="secondary"
                size={isDrawer ? "sm" : "md"}
                onClick={() => {
                  setAssigneeInput(proposal.review?.assigned_to ?? "");
                  setAssigneeError(null);
                  setActiveDialog("assign");
                }}
                data-testid="proposal-assign-btn"
              >
                <UserCheck className="h-3.5 w-3.5" strokeWidth={1.75} />
                <span>分派审批人</span>
              </Button>
            )}

            {permissions.canRelease && (
              <Button
                variant="secondary"
                size={isDrawer ? "sm" : "md"}
                onClick={() => setActiveDialog("release")}
                data-testid="proposal-release-btn"
              >
                <UserMinus className="h-3.5 w-3.5" strokeWidth={1.75} />
                <span>释放分派</span>
              </Button>
            )}

            {permissions.canReconcile && (
              <Button
                variant="primary"
                size={isDrawer ? "sm" : "md"}
                onClick={() => setActiveDialog("reconcile")}
                data-testid="proposal-reconcile-btn"
              >
                <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} />
                <span>重新核验 ERP 回执</span>
              </Button>
            )}
          </div>
        )}

        {/* Self-approval & assignment guardrails (read-only view preserved) */}
        {proposal.state === "PROPOSED" && permissions.isSelfRequester && (
          <div
            role="status"
            data-testid="proposal-self-approval-notice"
            className="mt-3 flex items-start gap-2.5 rounded-[4px] border border-[var(--status-amber-border)] bg-[var(--status-amber-wash)] px-3 py-2.5 text-[12.5px] text-[var(--status-amber-ink)]"
          >
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.75} />
            <div>
              <span className="font-semibold">只读核对模式：</span>
              不能审批本人提交的提案，请由独立主管审批。
            </div>
          </div>
        )}

        {proposal.state === "PROPOSED" &&
          !permissions.isSelfRequester &&
          permissions.assignedToOther && (
            <div
              role="status"
              data-testid="proposal-assigned-other-notice"
              className="mt-3 flex items-start gap-2.5 rounded-[4px] border border-[var(--status-amber-border)] bg-[var(--status-amber-wash)] px-3 py-2.5 text-[12.5px] text-[var(--status-amber-ink)]"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.75} />
              <div>
                该提案当前已分派给{" "}
                <span className="font-mono-code font-semibold">
                  {permissions.assignedTo}
                </span>{" "}
                审批。
                {actor?.role === "admin"
                  ? "管理员可使用「释放分派」解除锁定。"
                  : "如需接手，请由原分派人或管理员释放分派。"}
              </div>
            </div>
          )}
      </div>

      {/* Feedback Banners */}
      {actionSuccess && (
        <div
          role="status"
          data-testid="proposal-action-success"
          className="flex items-center gap-2 rounded-[4px] border border-[var(--status-emerald-border)] bg-[var(--status-emerald-wash)] px-3.5 py-2.5 text-[12.5px] font-medium text-[var(--status-emerald)]"
        >
          <CheckCircle2 className="h-4 w-4 shrink-0" strokeWidth={1.75} />
          <span>{actionSuccess}</span>
        </div>
      )}

      {conflictHighlight && (
        <div
          role="alert"
          data-testid="proposal-conflict-banner"
          className="rounded-[4px] border border-[var(--status-amber-border)] bg-[var(--status-amber-wash)] p-3.5 text-[12.5px] text-[var(--status-amber-ink)] space-y-1.5"
        >
          <div className="flex items-center gap-2 font-semibold">
            <AlertTriangle className="h-4 w-4 shrink-0" strokeWidth={1.75} />
            <span>{conflictHighlight.message}</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 font-mono-code text-[11.5px]">
            <div>
              原状态：{conflictHighlight.previousState} → 当前：{proposal.state}
            </div>
            <div>
              原摘要：{formatShortDigest(conflictHighlight.previousDigest)} →
              当前：{formatShortDigest(proposal.digest)}
            </div>
          </div>
        </div>
      )}

      {actionError && (
        <div data-testid="proposal-action-error">
          <AccessNoticeCard
            error={actionError.error}
            variant={actionError.variant}
            title={actionError.title}
            message={actionError.message}
            onRetry={
              actionError.variant === "CONFLICT" ||
              actionError.variant === "RETRY_LATER"
                ? () => void loadProposal()
                : undefined
            }
          />
        </div>
      )}

      {/* Execution Topology Ribbon */}
      <ExecutionTopologyRibbon
        state={proposal.state}
        checks={proposal.checks}
        events={proposal.events}
        variant={isDrawer ? "vertical-rail" : "auto"}
      />

      {/* Main Content Layout: 2-Column on Desktop Page, Stacked in Drawer */}
      <div
        className={
          isDrawer
            ? "space-y-3"
            : "grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]"
        }
      >
        {/* Left Column: Diff, Digest Metadata & Intake Evidence */}
        <div className="space-y-3 min-w-0">
          <ProposalDiffView
            plan={proposal.plan}
            proposalId={proposal.id}
            compact={isDrawer}
          />

          {/* Digest & Ownership Metadata Card */}
          <div className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-sheet)]">
            <div className="border-b border-[var(--hairline)] bg-[var(--bg-plane)] px-3 py-2 font-mono-code text-[11px] uppercase tracking-[0.04em] text-[var(--ink-secondary)]">
              DIGEST & GOVERNANCE · 摘要锁与责任人
            </div>
            <dl className="divide-y divide-[var(--hairline-subtle)] text-[12px]">
              <div className="flex items-start justify-between gap-3 px-3 py-2">
                <dt className="shrink-0 text-[var(--ink-muted)]">
                  SHA-256 摘要锁
                </dt>
                <dd className="min-w-0 flex items-center gap-1.5 text-right">
                  <span
                    className="font-mono-code tabular-nums text-[11.5px] text-[var(--ink-primary)] break-all"
                    data-testid="proposal-digest-value"
                  >
                    {isDrawer
                      ? formatShortDigest(proposal.digest, 10, 8)
                      : proposal.digest}
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleCopy("digest", proposal.digest)}
                    title="复制完整 Digest"
                    aria-label="复制完整摘要"
                    className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[2px] border border-[var(--hairline)] text-[var(--ink-muted)] hover:bg-[var(--bg-subtle)] cursor-pointer"
                  >
                    {copiedKey === "digest" ? (
                      <Check className="h-3 w-3 text-[var(--status-emerald)]" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                  </button>
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3 px-3 py-2">
                <dt className="text-[var(--ink-muted)]">发起人 (Requester)</dt>
                <dd className="font-mono-code text-[var(--ink-primary)]">
                  {proposal.requester}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3 px-3 py-2">
                <dt className="text-[var(--ink-muted)]">批准人 (Approver)</dt>
                <dd className="font-mono-code text-[var(--ink-primary)]">
                  {proposal.approver ?? "待独立审批"}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3 px-3 py-2">
                <dt className="text-[var(--ink-muted)]">审核分派</dt>
                <dd className="font-mono-code text-[var(--ink-primary)]">
                  {proposal.review?.assigned_to ?? "未指定（站点主管池）"}
                </dd>
              </div>
              {proposal.review?.decision && (
                <div className="px-3 py-2 space-y-1 bg-[var(--bg-subtle)]">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[var(--ink-muted)]">审核结论</span>
                    <span className="font-mono-code text-[var(--ink-primary)]">
                      {proposal.review.decision === "returned"
                        ? "退回（终态）"
                        : "拒绝（终态）"}{" "}
                      · {proposal.review.decided_by}
                    </span>
                  </div>
                  {proposal.review.reason && (
                    <p className="text-[12px] text-[var(--ink-secondary)] break-words">
                      理由：{proposal.review.reason}
                    </p>
                  )}
                </div>
              )}
              <div className="flex items-center justify-between gap-3 px-3 py-2">
                <dt className="text-[var(--ink-muted)]">计划执行 / 到期时间</dt>
                <dd className="flex items-center gap-2 font-mono-code">
                  <span className="text-[var(--ink-primary)]">
                    {formatUnixTime(proposal.due, { withSeconds: true })}
                  </span>
                  {proposal.state === "PROPOSED" && (
                    <span
                      className={
                        expiryInfo.dueSoon || expiryInfo.expired
                          ? "text-[var(--status-amber-ink)] font-semibold"
                          : "text-[var(--ink-muted)]"
                      }
                    >
                      ({expiryInfo.label})
                    </span>
                  )}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3 px-3 py-2">
                <dt className="text-[var(--ink-muted)]">租户 · 纪元 / 核验轮次</dt>
                <dd className="font-mono-code text-[var(--ink-primary)]">
                  {proposal.tenant} · epoch {proposal.epoch} · checks{" "}
                  {proposal.checks}
                </dd>
              </div>
            </dl>
          </div>

          {/* Clickable Intake Evidence Panel (for sales_order.create_draft) */}
          {intakeId && (
            <div
              className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-sheet)]"
              data-testid="proposal-intake-evidence-panel"
            >
              <button
                type="button"
                onClick={() => void handleToggleIntake()}
                aria-expanded={intakeOpen}
                data-testid="proposal-intake-evidence-toggle"
                className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left hover:bg-[var(--bg-subtle)] transition-colors duration-[120ms] cursor-pointer"
              >
                <div className="flex items-center gap-2 min-w-0">
                  {intakeOpen ? (
                    <ChevronDown className="h-4 w-4 shrink-0 text-[var(--ink-muted)]" />
                  ) : (
                    <ChevronRight className="h-4 w-4 shrink-0 text-[var(--ink-muted)]" />
                  )}
                  <FileSearch
                    className="h-4 w-4 shrink-0 text-[var(--accent)]"
                    strokeWidth={1.75}
                  />
                  <span className="text-[12.5px] font-semibold text-[var(--ink-primary)]">
                    来源进件证据
                  </span>
                  <span className="font-mono-code text-[11.5px] text-[var(--ink-muted)] truncate">
                    {intakeId}
                  </span>
                </div>
                <span className="text-[11.5px] text-[var(--accent)] shrink-0">
                  {intakeOpen ? "收起" : "点击展开核验"}
                </span>
              </button>

              {intakeOpen && (
                <div className="border-t border-[var(--hairline)] p-3 space-y-2.5">
                  {intakeLoading && (
                    <p className="text-[12px] text-[var(--ink-muted)]">
                      正在读取进件证据…
                    </p>
                  )}
                  {intakeError && <AccessNoticeCard error={intakeError} />}
                  {!intakeLoading && !intakeError && intakeDetail && (
                    <div className="space-y-2 text-[12px]">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-mono-code text-[11px] uppercase text-[var(--ink-muted)]">
                          KIND: {intakeDetail.evidence.kind} ·{" "}
                          {intakeDetail.warehouse}
                        </span>
                        <span className="font-mono-code text-[11px] text-[var(--ink-muted)]">
                          SHA-256{" "}
                          {formatShortDigest(
                            intakeDetail.evidence.artifact_sha256,
                          )}
                        </span>
                      </div>

                      {intakeDetail.evidence.kind === "structured" ? (
                        <div className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] p-2.5 space-y-1.5">
                          <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono-code text-[11.5px]">
                            <span>PO: {intakeDetail.evidence.order.po}</span>
                            <span>
                              买方: {intakeDetail.evidence.order.buyer}
                            </span>
                            <span>
                              交期: {intakeDetail.evidence.order.delivery}
                            </span>
                            <span className="font-semibold text-[var(--ink-primary)]">
                              {intakeDetail.evidence.order.currency}{" "}
                              {intakeDetail.evidence.order.total}
                            </span>
                          </div>
                          <div className="divide-y divide-[var(--hairline-subtle)] border-t border-[var(--hairline-subtle)] pt-1">
                            {intakeDetail.evidence.order.lines.map(
                              (line, i) => (
                                <div
                                  key={`${line.sku}-${i}`}
                                  className="flex items-center justify-between py-1 font-mono-code text-[11.5px]"
                                >
                                  <span>
                                    {line.sku} · {line.quantity} {line.unit} @{" "}
                                    {line.unit_price}
                                  </span>
                                  <span className="font-medium text-[var(--ink-primary)]">
                                    {line.amount}
                                  </span>
                                </div>
                              ),
                            )}
                          </div>
                        </div>
                      ) : (
                        <div className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] p-2.5 space-y-1.5">
                          <div className="font-mono-code text-[11px] text-[var(--ink-muted)]">
                            {intakeDetail.evidence.reader_mode} ·{" "}
                            {intakeDetail.evidence.image_width}×
                            {intakeDetail.evidence.image_height}px ·{" "}
                            {Object.keys(intakeDetail.evidence.fields).length}{" "}
                            提取字段
                          </div>
                          <div className="max-h-44 overflow-auto divide-y divide-[var(--hairline-subtle)]">
                            {Object.entries(intakeDetail.evidence.fields).map(
                              ([k, f]) => (
                                <div
                                  key={k}
                                  className="flex items-center justify-between gap-2 py-1 font-mono-code text-[11.5px]"
                                >
                                  <span className="text-[var(--ink-muted)]">
                                    {k}
                                  </span>
                                  <span className="text-[var(--ink-primary)]">
                                    {f.confirmed ?? f.ocr?.value ?? "—"}
                                  </span>
                                </div>
                              ),
                            )}
                          </div>
                        </div>
                      )}

                      <Link
                        href={`/orders/new?intake=${encodeURIComponent(intakeId)}`}
                        className="inline-flex items-center gap-1 text-[12px] font-medium text-[var(--accent)] hover:underline"
                      >
                        <span>在订单进件页查看完整证据</span>
                        <ArrowUpRight className="h-3.5 w-3.5" />
                      </Link>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right Column: ERP Receipt & Audit Event Timeline */}
        <div className="space-y-3 min-w-0">
          {/* Verified ERP Receipt or Outcome Unknown / Operator Needed Guidance */}
          {proposal.receipt && (
            <div
              data-testid="proposal-receipt-card"
              className="rounded-[4px] border border-[var(--status-emerald-border)] bg-[var(--status-emerald-wash)] p-3.5 space-y-2.5"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-[13px] font-semibold text-[var(--status-emerald)]">
                  <CheckCircle2 className="h-4 w-4 shrink-0" strokeWidth={1.75} />
                  <span>已写入 · 已核对 ERP 回执</span>
                </div>
                <span className="font-mono-code text-[11px] font-medium text-[var(--status-emerald)]">
                  RECEIPT VERIFIED
                </span>
              </div>

              <dl className="divide-y divide-[var(--status-emerald-border)]/40 rounded-[4px] border border-[var(--status-emerald-border)]/60 bg-[var(--bg-sheet)] text-[12px]">
                <div className="flex items-center justify-between gap-2 px-3 py-1.5">
                  <dt className="text-[var(--ink-muted)]">ERP 远端单号</dt>
                  <dd
                    className="font-mono-code font-semibold text-[var(--ink-primary)]"
                    data-testid="proposal-receipt-remote-id"
                  >
                    {proposal.receipt.remote_id}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-2 px-3 py-1.5">
                  <dt className="text-[var(--ink-muted)]">操作流水号</dt>
                  <dd className="font-mono-code text-[var(--ink-primary)]">
                    {proposal.receipt.operation_id}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-2 px-3 py-1.5">
                  <dt className="text-[var(--ink-muted)]">业务目标</dt>
                  <dd className="font-mono-code text-[var(--ink-primary)]">
                    {proposal.receipt.target}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-2 px-3 py-1.5">
                  <dt className="text-[var(--ink-muted)]">回执摘要比对</dt>
                  <dd className="font-mono-code text-[var(--status-emerald)]">
                    {proposal.receipt.plan_digest === proposal.digest
                      ? `完全一致 (${formatShortDigest(proposal.receipt.plan_digest)})`
                      : formatShortDigest(proposal.receipt.plan_digest)}
                  </dd>
                </div>
              </dl>
            </div>
          )}

          {!proposal.receipt &&
            (proposal.state === "OUTCOME_UNKNOWN" ||
              proposal.state === "NEEDS_OPERATOR") && (
              <div
                data-testid="proposal-outcome-guidance"
                className={[
                  "rounded-[4px] border p-3.5 space-y-2 text-[12.5px]",
                  proposal.state === "OUTCOME_UNKNOWN"
                    ? "border-[var(--status-amber-border)] bg-[var(--status-amber-wash)] text-[var(--status-amber-ink)]"
                    : "border-[var(--status-crimson-border)] bg-[var(--status-crimson-wash)] text-[var(--status-crimson)]",
                ].join(" ")}
              >
                <div className="flex items-center gap-2 font-semibold">
                  <AlertTriangle className="h-4 w-4 shrink-0" strokeWidth={1.75} />
                  <span>
                    {proposal.state === "OUTCOME_UNKNOWN"
                      ? "ERP 写入结果待确认（自动只读回查中）"
                      : "达到核验上限 · 需人工核查回执"}
                  </span>
                </div>
                <p className="leading-relaxed text-[var(--ink-secondary)]">
                  {proposal.state === "OUTCOME_UNKNOWN"
                    ? `系统正在按指数退避策略执行只读回执核查（当前轮次 ${proposal.checks}/3），请勿重复创建相同业务单据。`
                    : "请运维或仓库主管核对 ERP 侧是否已生成对应单据后，点击「重新核验 ERP 回执」触发只读回查（不会重复写入 ERP）。"}
                </p>
              </div>
            )}

          {/* Ordered Audit Event Timeline */}
          <div
            className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-sheet)]"
            data-testid="proposal-events-timeline"
          >
            <div className="flex items-center justify-between border-b border-[var(--hairline)] bg-[var(--bg-plane)] px-3 py-2">
              <span className="font-mono-code text-[11px] uppercase tracking-[0.04em] text-[var(--ink-secondary)]">
                AUDIT TIMELINE · 审计事件时间线
              </span>
              <span className="font-mono-code text-[11px] text-[var(--ink-muted)]">
                {proposal.events.length} 条记录
              </span>
            </div>

            {proposal.events.length === 0 ? (
              <div className="px-3 py-6 text-center text-[12px] text-[var(--ink-muted)]">
                暂无审计事件明细
              </div>
            ) : (
              <ol className="divide-y divide-[var(--hairline-subtle)]">
                {proposal.events.map((ev, idx) => {
                  const meta = EVENT_LABELS[ev.event] ?? {
                    label: ev.event,
                    tone: "neutral" as const,
                  };
                  const dotTone =
                    meta.tone === "emerald"
                      ? "bg-[var(--status-emerald)]"
                      : meta.tone === "amber"
                        ? "bg-[var(--status-amber)]"
                        : meta.tone === "crimson"
                          ? "bg-[var(--status-crimson)]"
                          : "bg-[var(--ink-muted)]";
                  const textTone =
                    meta.tone === "emerald"
                      ? "text-[var(--status-emerald)]"
                      : meta.tone === "amber"
                        ? "text-[var(--status-amber-ink)]"
                        : meta.tone === "crimson"
                          ? "text-[var(--status-crimson)]"
                          : "text-[var(--ink-primary)]";
                  return (
                    <li
                      key={`${ev.event}-${ev.at}-${idx}`}
                      className="flex items-start justify-between gap-3 px-3 py-2 text-[12px]"
                    >
                      <div className="flex items-start gap-2 min-w-0">
                        <span
                          aria-hidden="true"
                          className={`mt-1.5 h-2 w-2 shrink-0 rounded-[2px] ${dotTone}`}
                        />
                        <div className="min-w-0">
                          <div className={`font-medium ${textTone}`}>
                            {meta.label}
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 font-mono-code text-[11px] text-[var(--ink-muted)]">
                            <span>{ev.event}</span>
                            <span>·</span>
                            <span>{ev.subject}</span>
                          </div>
                        </div>
                      </div>
                      <span className="shrink-0 font-mono-code text-[11px] text-[var(--ink-muted)]">
                        {formatUnixTime(ev.at, { withSeconds: true })}
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        </div>
      </div>

      {/* Explicit Confirmation Dialogs */}
      <ConfirmDialog
        open={activeDialog === "approve"}
        onOpenChange={(open) => !open && setActiveDialog(null)}
        title="确认批准并进入 ERP 执行队列"
        description="批准后将锁定当前提案摘要（Digest），并由后台可靠队列向 ERP 执行幂等写入与回执核验。重复提交不会造成重复入账。"
        scopeSummary={`${proposal.warehouse} · ${changeSummary}`}
        metadata={confirmMetadata}
        confirmLabel="确认批准并入队"
        loading={actionLoading}
        onConfirm={executeApprove}
      >
        <div
          data-testid="proposal-approve-dialog"
          className="text-[11.5px] text-[var(--ink-muted)]"
        >
          请确认数量、单位换算及总额无误后再执行批准。
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={activeDialog === "return"}
        onOpenChange={(open) => !open && setActiveDialog(null)}
        title="确认退回提案"
        description="退回后本条提案将进入终态（REJECTED / returned），发起人需根据退回理由重新提交新的进件或改期提案。"
        scopeSummary={`${proposal.id} · ${proposal.warehouse}`}
        metadata={[
          { label: "提案编号", value: proposal.id, mono: true },
          { label: "摘要锁", value: formatShortDigest(proposal.digest), mono: true },
        ]}
        confirmLabel="确认退回"
        destructive
        loading={actionLoading}
        onConfirm={() => executeReview("return")}
      >
        <div className="space-y-1.5" data-testid="proposal-return-dialog">
          <label
            htmlFor={`return-reason-${proposal.id}`}
            className="block text-[12px] font-medium text-[var(--ink-primary)]"
          >
            退回理由（必填）
          </label>
          <textarea
            id={`return-reason-${proposal.id}`}
            rows={3}
            maxLength={240}
            value={reasonInput}
            onChange={(e) => {
              setReasonInput(e.target.value);
              setReasonError(null);
            }}
            aria-invalid={reasonError ? "true" : undefined}
            placeholder="例如：交付日期需与客户重新确认，请更新后重新提交"
            data-testid="proposal-review-reason-input"
            className="w-full rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-2.5 py-2 text-[13px] text-[var(--ink-primary)] focus:border-[var(--accent)] focus:outline-none"
          />
          {reasonError && (
            <p className="text-[12px] text-[var(--status-crimson)]">
              {reasonError}
            </p>
          )}
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={activeDialog === "reject"}
        onOpenChange={(open) => !open && setActiveDialog(null)}
        title="确认拒绝该提案"
        description="拒绝后本条提案将永久终止（REJECTED），不可再进入执行队列。"
        scopeSummary={`${proposal.id} · ${proposal.warehouse}`}
        metadata={[
          { label: "提案编号", value: proposal.id, mono: true },
          { label: "摘要锁", value: formatShortDigest(proposal.digest), mono: true },
        ]}
        confirmLabel="确认拒绝"
        destructive
        loading={actionLoading}
        onConfirm={() => executeReview("reject")}
      >
        <div className="space-y-1.5" data-testid="proposal-reject-dialog">
          <label
            htmlFor={`reject-reason-${proposal.id}`}
            className="block text-[12px] font-medium text-[var(--ink-primary)]"
          >
            拒绝理由（必填）
          </label>
          <textarea
            id={`reject-reason-${proposal.id}`}
            rows={3}
            maxLength={240}
            value={reasonInput}
            onChange={(e) => {
              setReasonInput(e.target.value);
              setReasonError(null);
            }}
            aria-invalid={reasonError ? "true" : undefined}
            placeholder="例如：超出站点额度或客户单据已作废"
            data-testid="proposal-review-reason-input"
            className="w-full rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-2.5 py-2 text-[13px] text-[var(--ink-primary)] focus:border-[var(--accent)] focus:outline-none"
          />
          {reasonError && (
            <p className="text-[12px] text-[var(--status-crimson)]">
              {reasonError}
            </p>
          )}
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={activeDialog === "assign"}
        onOpenChange={(open) => !open && setActiveDialog(null)}
        title="分派审批人"
        description="将本提案明确指派给同租户内具备该站点审批权限的独立主管，系统将同步发送站内通知。"
        scopeSummary={`${proposal.id} · ${proposal.warehouse}`}
        confirmLabel="确认分派"
        loading={actionLoading}
        onConfirm={() => executeReview("assign")}
      >
        <div className="space-y-2" data-testid="proposal-assign-dialog">
          <label
            htmlFor={`assign-subject-${proposal.id}`}
            className="block text-[12px] font-medium text-[var(--ink-primary)]"
          >
            审批人账号 (Subject)
          </label>
          <input
            id={`assign-subject-${proposal.id}`}
            type="text"
            value={assigneeInput}
            onChange={(e) => {
              setAssigneeInput(e.target.value);
              setAssigneeError(null);
            }}
            aria-invalid={assigneeError ? "true" : undefined}
            placeholder="例如 manager"
            data-testid="proposal-assign-input"
            className="h-9 w-full rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-2.5 font-mono-code text-[13px] text-[var(--ink-primary)] focus:border-[var(--accent)] focus:outline-none"
          />
          {demoConfig?.enabled && approverSuggestions.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-[var(--ink-muted)]">
                常用候选：
              </span>
              {approverSuggestions
                .filter((s) => s !== proposal.requester)
                .map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => {
                      setAssigneeInput(s);
                      setAssigneeError(null);
                    }}
                    className="rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-subtle)] px-2 py-0.5 font-mono-code text-[11px] text-[var(--ink-secondary)] hover:bg-[var(--bg-plane)] cursor-pointer"
                  >
                    {s}
                  </button>
                ))}
            </div>
          )}
          {assigneeError && (
            <p className="text-[12px] text-[var(--status-crimson)]">
              {assigneeError}
            </p>
          )}
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={activeDialog === "release"}
        onOpenChange={(open) => !open && setActiveDialog(null)}
        title="确认释放审批分派"
        description="释放后该提案将回到站点待审批池，任何具备该仓库审批权限的独立主管均可认领或审批。"
        scopeSummary={`${proposal.id} · 当前指派人：${proposal.review?.assigned_to ?? "—"}`}
        confirmLabel="确认释放"
        loading={actionLoading}
        onConfirm={() => executeReview("release")}
      />

      <ConfirmDialog
        open={activeDialog === "reconcile"}
        onOpenChange={(open) => !open && setActiveDialog(null)}
        title="重新核验 ERP 回执（只读回查）"
        description="该操作将把单据状态重置为 OUTCOME_UNKNOWN 并清零核验计数，由后台 Worker 执行只读回执查询，不会向 ERP 重复写入新记录。"
        scopeSummary={`${proposal.id} · ${proposal.warehouse} · ${proposal.plan.target}`}
        confirmLabel="发起只读核验"
        loading={actionLoading}
        onConfirm={executeReconcile}
      />
    </div>
  );
}
