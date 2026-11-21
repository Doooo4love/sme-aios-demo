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
import { formatShortDigest } from "@/lib/format";
import { useLocale } from "@/lib/i18n";
import { useSession } from "@/lib/session-context";
import {
  BriefProgressChain,
  type BriefProgressStep,
} from "@/components/kinetic/BriefProgressChain";
import { ExecutionTopologyRibbon } from "@/components/kinetic/ExecutionTopologyRibbon";
import { Interactive3DCard } from "@/components/kinetic/Interactive3DCard";
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
  extractSalesOrderAfter,
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

const DEMO_APPROVER_SUGGESTIONS: Record<string, string[]> = {
  harbour: ["manager", "admin", "access-admin", "other-manager"],
  island: ["island-manager"],
};

const KNOWN_SUBJECT_ROLES: Readonly<Record<string, string>> = {
  operator: "operator",
  manager: "manager",
  finance: "operator",
  "access-admin": "admin",
  admin: "admin",
  quality: "operator",
  legal: "operator",
  executive: "viewer",
  viewer: "viewer",
  "other-manager": "manager",
  "island-manager": "manager",
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
    locale,
    t,
    tx,
    tp,
    formatDateTime,
    formatCountdown,
    localizeAction,
    localizeStatus,
    localizeTimelineEvent,
    localizePersona,
    localizeRole,
    localizeError,
  } = useLocale();
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
            (error.status === 429 || error.status >= 500)
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

  const formatAuditActor = useCallback(
    (subject: string): string => {
      const normalized = subject.trim().toLowerCase();
      if (normalized === "worker") {
        return tx({
          "zh-CN": "系统执行器",
          "zh-HK": "系統執行器",
          en: "System worker",
        });
      }
      if (normalized === "system") {
        return tx({
          "zh-CN": "系统",
          "zh-HK": "系統",
          en: "System",
        });
      }
      const meta = demoConfig?.personas.find((p) => p.subject === subject);
      const info = localizePersona(subject, meta);
      const roleKey = meta?.role ?? KNOWN_SUBJECT_ROLES[subject];
      if (roleKey) {
        return `${info.displayName} · ${localizeRole(roleKey)}`;
      }
      return info.displayName;
    },
    [demoConfig, localizePersona, localizeRole, tx],
  );

  const intakeId = useMemo(() => {
    if (!proposal) return null;
    const before = extractSalesOrderBefore(proposal.plan);
    return before?.intake_id || null;
  }, [proposal]);

  // Real-state truthful checkpoints folded inline into ExecutionTopologyRibbon headerRight
  const progressChain = useMemo<{
    phase: "done" | "error";
    summary: string;
    steps: BriefProgressStep[];
  } | null>(() => {
    if (!proposal) return null;
    const isRejected = proposal.state === "REJECTED";
    const isNeedsOp = proposal.state === "NEEDS_OPERATOR";
    const isVerified = proposal.state === "VERIFIED";

    const approvalStatus: BriefProgressStep["status"] = proposal.approver
      ? "done"
      : isRejected
        ? "error"
        : "waiting";

    const executionStatus: BriefProgressStep["status"] = isVerified
      ? "done"
      : isNeedsOp || isRejected
        ? "error"
        : "waiting";

    const steps: BriefProgressStep[] = [
      {
        id: "propose-lock",
        label: tx(
          {
            "zh-CN": "提案已由 {requester} 发起并锁定摘要（{wh}）",
            "zh-HK": "提案已由 {requester} 發起並鎖定摘要（{wh}）",
            en: "Proposed by {requester} with digest lock ({wh})",
          },
          { requester: proposal.requester, wh: proposal.warehouse },
        ),
        status: "done",
        meta: formatShortDigest(proposal.digest),
      },
      {
        id: "independent-approval",
        label: proposal.approver
          ? tx(
              {
                "zh-CN": "独立主管 {approver} 已批准并进入出站队列",
                "zh-HK": "獨立主管 {approver} 已批准並進入出站佇列",
                en: "Approved & queued by independent manager {approver}",
              },
              { approver: proposal.approver },
            )
          : isRejected
            ? proposal.review?.decision === "returned"
              ? tx(
                  {
                    "zh-CN": "提案已由 {actor} 退回修改",
                    "zh-HK": "提案已由 {actor} 退回修改",
                    en: "Returned for revision by {actor}",
                  },
                  {
                    actor:
                      proposal.review.decided_by ??
                      tx({
                        "zh-CN": "主管",
                        "zh-HK": "主管",
                        en: "manager",
                      }),
                  },
                )
              : tx({
                  "zh-CN": "提案已被拒绝并终止",
                  "zh-HK": "提案已被拒絕並終止",
                  en: "Proposal rejected & terminated",
                })
            : proposal.review?.assigned_to
              ? tx(
                  {
                    "zh-CN": "等待指定主管 {assignee} 确认",
                    "zh-HK": "等待指定主管 {assignee} 確認",
                    en: "Awaiting assigned manager {assignee}",
                  },
                  { assignee: proposal.review.assigned_to },
                )
              : tx({
                  "zh-CN": "等待授权仓库独立主管审批",
                  "zh-HK": "等待授權倉庫獨立主管審批",
                  en: "Awaiting independent warehouse manager approval",
                }),
        status: approvalStatus,
        meta:
          proposal.approver ??
          proposal.review?.assigned_to ??
          tx({
            "zh-CN": "待独立审批",
            "zh-HK": "待獨立審批",
            en: "Pending",
          }),
      },
      {
        id: "erp-verify",
        label: isVerified
          ? tx({
              "zh-CN": "ERP 已完成幂等写入且回执摘要一致",
              "zh-HK": "ERP 已完成冪等寫入且回執摘要一致",
              en: "Idempotent ERP write completed with matching receipt digest",
            })
          : isNeedsOp
            ? tx(
                {
                  "zh-CN": "已达回查上限（{checks}/3），需运维核查回执",
                  "zh-HK": "已達回查上限（{checks}/3），須維運核查回執",
                  en: "Readback limit reached ({checks}/3); operator check needed",
                },
                { checks: proposal.checks },
              )
            : isRejected
              ? tx({
                  "zh-CN": "未执行 ERP 写入（提案已终止）",
                  "zh-HK": "未執行 ERP 寫入（提案已終止）",
                  en: "No ERP write performed (proposal terminated)",
                })
              : tx(
                  {
                    "zh-CN": "当前流转阶段：{state}",
                    "zh-HK": "目前流轉階段：{state}",
                    en: "Current stage: {state}",
                  },
                  { state: localizeStatus(proposal.state) },
                ),
        status: executionStatus,
        meta:
          proposal.receipt?.remote_id ??
          (proposal.checks > 0
            ? tx(
                {
                  "zh-CN": "核验 {checks}/3",
                  "zh-HK": "核驗 {checks}/3",
                  en: "Check {checks}/3",
                },
                { checks: proposal.checks },
              )
            : localizeStatus(proposal.state, { compact: true })),
      },
    ];

    const summary = isNeedsOp
      ? tx({
          "zh-CN": "异常核验明细",
          "zh-HK": "異常核驗明細",
          en: "Exception Details",
        })
      : isRejected
        ? tx({
            "zh-CN": "终止记录明细",
            "zh-HK": "終止紀錄明細",
            en: "Termination Details",
          })
        : tx({
            "zh-CN": "核验明细",
            "zh-HK": "核驗明細",
            en: "Verification Details",
          });

    return {
      phase: isNeedsOp || isRejected ? "error" : "done",
      summary,
      steps,
    };
  }, [proposal, tx, localizeStatus]);

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
          message: tx({
            "zh-CN": "操作未能完成，请刷新后重试。",
            "zh-HK": "操作未能完成，請重新整理後重試。",
            en: "Action could not be completed. Refresh and try again.",
          }),
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
            ? tx({
                "zh-CN": "无法审批本人提交的提案",
                "zh-HK": "無法審批本人提交的提案",
                en: "Self-Approval Blocked",
              })
            : tx({
                "zh-CN": "当前账号无权执行该审批操作",
                "zh-HK": "目前帳號無權執行該審批操作",
                en: "Approval Action Not Permitted",
              }),
          message: isSelfOrIndependent
            ? tx({
                "zh-CN": "不能审批本人提交的提案，请由独立主管审批。",
                "zh-HK": "不能審批本人提交的提案，請由獨立主管審批。",
                en: "You cannot approve your own proposal. An independent manager must approve it.",
              })
            : localizeError(error),
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
              ? tx({
                  "zh-CN":
                    "提案摘要已变更，已加载最新快照，请核对差异后再重新确认。",
                  "zh-HK":
                    "提案摘要已變更，已載入最新快照，請核對差異後再重新確認。",
                  en: "Proposal digest changed. Latest snapshot loaded — review the diff before confirming again.",
                })
              : tx({
                  "zh-CN":
                    "提案状态或分派归属已变更，已刷新最新快照，请核对后再操作。",
                  "zh-HK":
                    "提案狀態或分派歸屬已變更，已重新整理最新快照，請核對後再操作。",
                  en: "Proposal state or assignment changed. Reloaded the latest snapshot for review.",
                }),
        });
        setActionError({
          error,
          variant: "CONFLICT",
          title: tx({
            "zh-CN": "乐观锁冲突（409）· 已刷新最新快照",
            "zh-HK": "樂觀鎖衝突（409）· 已重新整理最新快照",
            en: "Optimistic Lock Conflict (409) · Reloaded",
          }),
          message: tx({
            "zh-CN":
              "提案摘要、状态或分派已发生变化，请核对下方最新差异后重新确认提交。",
            "zh-HK":
              "提案摘要、狀態或分派已發生變化，請核對下方最新差異後重新確認提交。",
            en: "The proposal digest, state, or assignment changed. Verify the updated diff below before retrying.",
          }),
        });
        return;
      }

      if (error.status === 429 || error.status >= 500) {
        setActionError({
          error,
          variant: "RETRY_LATER",
          message: localizeError(error),
        });
        setActiveDialog(null);
        return;
      }

      setActionError({
        error,
        message: localizeError(error),
      });
      setActiveDialog(null);
    },
    [actor, handleAccessChanged, loadProposal, tx, localizeError],
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
      setActionSuccess(
        tx({
          "zh-CN": "已批准并进入执行队列，等待派发执行。",
          "zh-HK": "已批准並進入執行佇列，等待派發執行。",
          en: "Approved and queued for ERP dispatch.",
        }),
      );
      onProposalUpdatedRef.current?.(updated);
    } catch (error) {
      await handleMutationError(error, snapshot);
    } finally {
      setActionLoading(false);
    }
  };

  const executeReview = async (
    action: "return" | "reject" | "assign" | "release",
  ) => {
    if (!proposal) return;
    if (action === "return" || action === "reject") {
      const trimmed = reasonInput.trim();
      if (!trimmed) {
        setReasonError(
          tx({
            "zh-CN": "请填写必填原因（1–240 字符）。",
            "zh-HK": "請填寫必填原因（1–240 字元）。",
            en: "Please enter a required reason (1–240 characters).",
          }),
        );
        return;
      }
      if (trimmed.length > 240) {
        setReasonError(
          tx({
            "zh-CN": "原因不能超过 240 字符。",
            "zh-HK": "原因不可超過 240 字元。",
            en: "Reason cannot exceed 240 characters.",
          }),
        );
        return;
      }
      setReasonError(null);
    }
    if (action === "assign") {
      const trimmed = assigneeInput.trim();
      if (!trimmed || !/^[A-Za-z0-9._:@-]+$/.test(trimmed)) {
        setAssigneeError(
          tx({
            "zh-CN": "请输入有效的同事账号（例如 manager）。",
            "zh-HK": "請輸入有效的同事帳號（例如 manager）。",
            en: "Enter a valid colleague subject ID (e.g. manager).",
          }),
        );
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
        return: tx({
          "zh-CN": "提案已退回发起人（当前提案已终止，需重新进件）。",
          "zh-HK": "提案已退回發起人（目前提案已終止，須重新進件）。",
          en: "Proposal returned to requester (this proposal is now closed; a fresh intake is required).",
        }),
        reject: tx({
          "zh-CN": "提案已正式拒绝（终止）。",
          "zh-HK": "提案已正式拒絕（終止）。",
          en: "Proposal permanently rejected.",
        }),
        assign: tx(
          {
            "zh-CN": "提案已分派给 {assignee}。",
            "zh-HK": "提案已分派予 {assignee}。",
            en: "Proposal assigned to {assignee}.",
          },
          {
            assignee:
              updated.review?.assigned_to ??
              tx({
                "zh-CN": "指定审批人",
                "zh-HK": "指定審批人",
                en: "designated approver",
              }),
          },
        ),
        release: tx({
          "zh-CN": "已释放当前审批分派，同仓库独立主管均可认领。",
          "zh-HK": "已釋放目前審批分派，同倉庫獨立主管均可認領。",
          en: "Assignment released; any independent warehouse manager may now claim or approve.",
        }),
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
      setActionSuccess(
        tx({
          "zh-CN": "已重新发起只读回执核验（结果待确认）。",
          "zh-HK": "已重新發起唯讀回執核驗（結果待確認）。",
          en: "Reopened read-only ERP receipt verification.",
        }),
      );
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
          ? tx({
              "zh-CN": "Worker 已推进 1 步执行，已同步最新提案状态。",
              "zh-HK": "Worker 已推進 1 步執行，已同步最新提案狀態。",
              en: "Worker advanced 1 step and synced the latest proposal state.",
            })
          : tx({
              "zh-CN": "当前无待推进的队列任务，已刷新状态。",
              "zh-HK": "目前無待推進的佇列任務，已重新整理狀態。",
              en: "No queued jobs ready to advance; state refreshed.",
            }),
      );
    } catch (error) {
      if (!isStaleAuthError(error) && isApiError(error)) {
        setActionError({ error, message: localizeError(error) });
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
            : "mx-auto max-w-[1140px] p-6"
        }
        data-testid="proposal-loading"
      >
        <div className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] p-8 text-center text-[13px] text-[var(--ink-muted)]">
          {tx({
            "zh-CN": "正在实时校验权限并加载提案详情…",
            "zh-HK": "正在即時校驗權限並載入提案詳情…",
            en: "Verifying permissions and loading proposal…",
          })}
        </div>
      </div>
    );
  }

  if (loadError && !proposal) {
    const isUnavailable =
      loadError.status === 404 || loadError.code === "RECORD_UNAVAILABLE";
    return (
      <div
        className={isDrawer ? "space-y-3" : "mx-auto max-w-[780px] p-4 lg:p-8"}
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

  const beaconState = isPollableState
    ? proposalStateToBeacon(proposal.state)
    : null;
  const expiryInfo = formatCountdown(proposal.expires);
  const changeSummary = summarizePlanChange(proposal.plan, locale);
  const actionLabel = localizeAction(proposal.plan.action);
  const proposalHeading = (() => {
    if (proposal.plan.action === "sales_order.create_draft") {
      const after = extractSalesOrderAfter(proposal.plan);
      if (after?.po && after.po !== "—") {
        return `${actionLabel} · ${after.po}`;
      }
    }
    if (proposal.plan.target) {
      return `${actionLabel} · ${proposal.plan.target}`;
    }
    return actionLabel;
  })();

  const canDemoTick =
    Boolean(demoConfig?.enabled) &&
    actor?.role === "admin" &&
    canAccessAdminOps &&
    isNonTerminal;

  const confirmMetadata = [
    {
      label: tx({
        "zh-CN": "提案编号",
        "zh-HK": "提案編號",
        en: "Proposal ID",
      }),
      value: proposal.id,
      mono: true,
    },
    {
      label: tx({
        "zh-CN": "仓库",
        "zh-HK": "倉庫",
        en: "Warehouse",
      }),
      value: proposal.warehouse,
      mono: true,
    },
    {
      label: tx({
        "zh-CN": "动作类型",
        "zh-HK": "動作類型",
        en: "Action",
      }),
      value: actionLabel,
    },
    {
      label: tx({
        "zh-CN": "目标对象",
        "zh-HK": "目標物件",
        en: "Target",
      }),
      value: proposal.plan.target,
      mono: true,
    },
    {
      label: tx({
        "zh-CN": "拟变更内容",
        "zh-HK": "擬變更內容",
        en: "Proposed Change",
      }),
      value: changeSummary,
    },
    {
      label: tx({
        "zh-CN": "摘要锁",
        "zh-HK": "摘要鎖",
        en: "Digest Lock",
      }),
      value: formatShortDigest(proposal.digest),
      mono: true,
    },
  ];

  const approverSuggestions =
    (actor?.tenant ? DEMO_APPROVER_SUGGESTIONS[actor.tenant] : []) ?? [];

  return (
    <div
      className={
        isDrawer
          ? "space-y-3.5"
          : "mx-auto max-w-[1160px] space-y-5 p-4 sm:p-6 pb-20"
      }
      data-testid={
        isDrawer ? "proposal-drawer-inspector" : "proposal-detail-page"
      }
    >
      {/* Header Porcelain Card — Human Business Title First + Compact Short ID Pill */}
      <div className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2.5">
              {!isDrawer && (
                <Link
                  href="/work"
                  className="inline-flex h-8 items-center gap-1 rounded-full bg-[var(--bg-surface-subtle)] px-3 text-[12px] font-medium text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--ink-primary)] transition-colors"
                >
                  <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.85} />
                  <span>
                    {tx({
                      "zh-CN": "工作台",
                      "zh-HK": "工作台",
                      en: "Workbench",
                    })}
                  </span>
                </Link>
              )}
              <h1
                className={[
                  "font-semibold tracking-[-0.02em] text-[var(--ink-primary)]",
                  isDrawer ? "text-[15.5px]" : "text-[18px]",
                ].join(" ")}
              >
                {proposalHeading}
              </h1>
              <span className="rounded-full bg-[var(--bg-surface-subtle)] px-2.5 py-0.5 font-mono-code text-[11px] font-medium text-[var(--ink-secondary)]">
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

            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12.5px] text-[var(--ink-muted)]">
              <span className="inline-flex items-center gap-1 rounded-full bg-[var(--bg-surface-tint)] pl-2.5 pr-1 py-0.5">
                <span className="text-[11px] text-[var(--ink-muted)]">
                  {tx({ "zh-CN": "单号", "zh-HK": "單號", en: "ID" })}
                </span>
                <span
                  title={proposal.id}
                  data-testid="proposal-id-value"
                  className="inline-block max-w-[118px] truncate align-bottom font-mono-code tabular-nums text-[11.5px] text-[var(--ink-secondary)]"
                >
                  {proposal.id}
                </span>
                <button
                  type="button"
                  onClick={() => void handleCopy("id", proposal.id)}
                  title={tx(
                    {
                      "zh-CN": "复制完整提案编号 {id}",
                      "zh-HK": "複製完整提案編號 {id}",
                      en: "Copy full proposal ID {id}",
                    },
                    { id: proposal.id },
                  )}
                  aria-label={tx({
                    "zh-CN": "复制提案编号",
                    "zh-HK": "複製提案編號",
                    en: "Copy proposal ID",
                  })}
                  className="inline-flex h-5 w-5 items-center justify-center rounded-full text-[var(--ink-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--ink-primary)] transition-colors cursor-pointer"
                >
                  {copiedKey === "id" ? (
                    <Check className="h-3 w-3 text-[var(--status-emerald)]" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                </button>
              </span>

              {beaconState && (
                <>
                  <span className="text-[var(--ink-faint)]">·</span>
                  <StatePulseBeacon
                    state={beaconState}
                    detail={
                      retryWaitSeconds
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
              pill
              variant="secondary"
              onClick={() => {
                setPollCount(0);
                setPollExhausted(false);
                void loadProposal();
              }}
              data-testid="proposal-refresh-btn"
            >
              <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.85} />
              <span>{t("common.refresh")}</span>
            </Button>

            {isDrawer && (
              <Link
                href={`/proposals/${encodeURIComponent(proposal.id)}`}
                data-testid="drawer-open-proposal-page-link"
                className="inline-flex h-8 items-center gap-1 rounded-full bg-[var(--bg-surface-subtle)] px-3 text-[12px] font-medium text-[var(--ink-primary)] hover:bg-[var(--bg-hover)] hover:text-[var(--accent)] transition-colors"
              >
                <span>
                  {tx({
                    "zh-CN": "打开独立页面",
                    "zh-HK": "開啟獨立頁面",
                    en: "Open Full Page",
                  })}
                </span>
                <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.85} />
              </Link>
            )}

            {canDemoTick && (
              <Button
                size="sm"
                pill
                variant="secondary"
                loading={workerTickLoading}
                onClick={() => void executeDemoWorkerTick()}
                data-testid="proposal-worker-tick-btn"
              >
                <Play className="h-3.5 w-3.5" strokeWidth={1.85} />
                <span>
                  {tx({
                    "zh-CN": "推进 Worker",
                    "zh-HK": "推進 Worker",
                    en: "Tick Worker",
                  })}
                </span>
              </Button>
            )}
          </div>
        </div>

        {/* Bounded Polling Notice when active or cap reached */}
        {isPollableState && (
          <div className="mt-3.5 flex flex-wrap items-center justify-between gap-2 rounded-sm bg-[var(--bg-surface-tint)] px-3.5 py-2 text-[12px] text-[var(--ink-muted)]">
            <span>
              {pollExhausted
                ? tx({
                    "zh-CN":
                      "已达到自动轮询上限，可点击右上角「刷新」手动获取最新状态。",
                    "zh-HK":
                      "已達到自動輪詢上限，可點擊右上角「重新整理」手動取得最新狀態。",
                    en: "Automatic polling cap reached. Click Refresh above to check the latest state.",
                  })
                : tx({
                    "zh-CN":
                      "正在对当前执行中单据进行有界状态轮询，进入终态或离开页面后自动停止。",
                    "zh-HK":
                      "正在對目前執行中單據進行有界狀態輪詢，進入終態或離開頁面後自動停止。",
                    en: "Bounded live polling active; stops automatically upon reaching a terminal state or leaving.",
                  })}
            </span>
            <span className="tabular-nums">
              {tx(
                {
                  "zh-CN": "轮询 {count}/{max}",
                  "zh-HK": "輪詢 {count}/{max}",
                  en: "Poll {count}/{max}",
                },
                { count: pollCount, max: MAX_POLL_CYCLES },
              )}
            </span>
          </div>
        )}

        {/* Formal Action Bar */}
        {(permissions.canApprove ||
          permissions.canRelease ||
          permissions.canReconcile) && (
          <div
            className="mt-4 flex flex-wrap items-center gap-2 border-t border-[var(--hairline-subtle)] pt-3.5"
            data-testid="proposal-actions-bar"
          >
            {permissions.canApprove && (
              <Button
                variant="primary"
                pill
                size={isDrawer ? "sm" : "md"}
                onClick={() => {
                  setActionError(null);
                  setActiveDialog("approve");
                }}
                data-testid="proposal-approve-btn"
              >
                <ShieldCheck className="h-4 w-4" strokeWidth={1.85} />
                <span>
                  {tx({
                    "zh-CN": "批准并入队",
                    "zh-HK": "批准並入隊",
                    en: "Approve & Queue",
                  })}
                </span>
              </Button>
            )}

            {permissions.canReturnOrReject && (
              <>
                <Button
                  variant="secondary"
                  pill
                  size={isDrawer ? "sm" : "md"}
                  onClick={() => {
                    setReasonInput("");
                    setReasonError(null);
                    setActiveDialog("return");
                  }}
                  data-testid="proposal-return-btn"
                >
                  <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.85} />
                  <span>
                    {tx({ "zh-CN": "退回", "zh-HK": "退回", en: "Return" })}
                  </span>
                </Button>

                <Button
                  variant="danger"
                  pill
                  size={isDrawer ? "sm" : "md"}
                  onClick={() => {
                    setReasonInput("");
                    setReasonError(null);
                    setActiveDialog("reject");
                  }}
                  data-testid="proposal-reject-btn"
                >
                  <XCircle className="h-3.5 w-3.5" strokeWidth={1.85} />
                  <span>
                    {tx({ "zh-CN": "拒绝", "zh-HK": "拒絕", en: "Reject" })}
                  </span>
                </Button>
              </>
            )}

            {permissions.canAssign && (
              <Button
                variant="secondary"
                pill
                size={isDrawer ? "sm" : "md"}
                onClick={() => {
                  setAssigneeInput(proposal.review?.assigned_to ?? "");
                  setAssigneeError(null);
                  setActiveDialog("assign");
                }}
                data-testid="proposal-assign-btn"
              >
                <UserCheck className="h-3.5 w-3.5" strokeWidth={1.85} />
                <span>
                  {tx({
                    "zh-CN": "分派审批人",
                    "zh-HK": "分派審批人",
                    en: "Assign Approver",
                  })}
                </span>
              </Button>
            )}

            {permissions.canRelease && (
              <Button
                variant="secondary"
                pill
                size={isDrawer ? "sm" : "md"}
                onClick={() => setActiveDialog("release")}
                data-testid="proposal-release-btn"
              >
                <UserMinus className="h-3.5 w-3.5" strokeWidth={1.85} />
                <span>
                  {tx({
                    "zh-CN": "释放分派",
                    "zh-HK": "釋放分派",
                    en: "Release Assignment",
                  })}
                </span>
              </Button>
            )}

            {permissions.canReconcile && (
              <Button
                variant="primary"
                pill
                size={isDrawer ? "sm" : "md"}
                onClick={() => setActiveDialog("reconcile")}
                data-testid="proposal-reconcile-btn"
              >
                <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.85} />
                <span>
                  {tx({
                    "zh-CN": "重新核验 ERP 回执",
                    "zh-HK": "重新核驗 ERP 回執",
                    en: "Re-Verify ERP Receipt",
                  })}
                </span>
              </Button>
            )}
          </div>
        )}

        {/* Self-approval & assignment guardrails (read-only view preserved) */}
        {proposal.state === "PROPOSED" && permissions.isSelfRequester && (
          <div
            role="status"
            data-testid="proposal-self-approval-notice"
            className="mt-3.5 flex items-start gap-2.5 rounded-tile bg-[var(--status-amber-wash)] px-4 py-3 text-[12.5px] text-[var(--status-amber-ink)]"
          >
            <ShieldAlert
              className="mt-0.5 h-4 w-4 shrink-0"
              strokeWidth={1.85}
            />
            <div>
              <span className="font-semibold">
                {tx({
                  "zh-CN": "只读核对模式：",
                  "zh-HK": "唯讀核對模式：",
                  en: "Read-only inspection: ",
                })}
              </span>
              {tx({
                "zh-CN": "不能审批本人提交的提案，请由独立主管审批。",
                "zh-HK": "不能審批本人提交的提案，請由獨立主管審批。",
                en: "You cannot approve a proposal you submitted. An independent manager must approve it.",
              })}
            </div>
          </div>
        )}

        {proposal.state === "PROPOSED" &&
          !permissions.isSelfRequester &&
          permissions.assignedToOther && (
            <div
              role="status"
              data-testid="proposal-assigned-other-notice"
              className="mt-3.5 flex items-start gap-2.5 rounded-tile bg-[var(--status-amber-wash)] px-4 py-3 text-[12.5px] text-[var(--status-amber-ink)]"
            >
              <AlertTriangle
                className="mt-0.5 h-4 w-4 shrink-0"
                strokeWidth={1.85}
              />
              <div>
                {tx({
                  "zh-CN": "该提案当前已分派给 ",
                  "zh-HK": "該提案目前已分派予 ",
                  en: "This proposal is currently assigned to ",
                })}
                <span className="font-mono-code font-semibold">
                  {permissions.assignedTo}
                </span>
                {tx({
                  "zh-CN": " 审批。",
                  "zh-HK": " 審批。",
                  en: ". ",
                })}
                {actor?.role === "admin"
                  ? tx({
                      "zh-CN": "管理员可使用「释放分派」解除锁定。",
                      "zh-HK": "管理員可使用「釋放分派」解除鎖定。",
                      en: "As an admin, you can click Release Assignment to unlock it.",
                    })
                  : tx({
                      "zh-CN": "如需接手，请由原分派人或管理员释放分派。",
                      "zh-HK": "如需接手，請由原分派人或管理員釋放分派。",
                      en: "Ask the current assignee or an admin to release it before taking over.",
                    })}
              </div>
            </div>
          )}
      </div>

      {/* Feedback Banners */}
      {actionSuccess && (
        <div
          role="status"
          data-testid="proposal-action-success"
          className="flex items-center gap-2 rounded-tile bg-[var(--status-emerald-wash)] px-4 py-3 text-[13px] font-medium text-[var(--status-emerald)]"
        >
          <CheckCircle2 className="h-4 w-4 shrink-0" strokeWidth={1.85} />
          <span>{actionSuccess}</span>
        </div>
      )}

      {conflictHighlight && (
        <div
          role="alert"
          data-testid="proposal-conflict-banner"
          className="rounded-tile bg-[var(--status-amber-wash)] p-4 text-[12.5px] text-[var(--status-amber-ink)] space-y-2"
        >
          <div className="flex items-center gap-2 font-semibold">
            <AlertTriangle className="h-4 w-4 shrink-0" strokeWidth={1.85} />
            <span>{conflictHighlight.message}</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-[11.5px]">
            <div>
              {tx(
                {
                  "zh-CN": "原状态：{prev} → 当前：{curr}",
                  "zh-HK": "原狀態：{prev} → 目前：{curr}",
                  en: "Before: {prev} → Now: {curr}",
                },
                {
                  prev: localizeStatus(conflictHighlight.previousState),
                  curr: localizeStatus(proposal.state),
                },
              )}
            </div>
            <div>
              {tx({
                "zh-CN": "摘要：",
                "zh-HK": "摘要：",
                en: "Digest: ",
              })}
              <span className="font-mono-code">
                {formatShortDigest(conflictHighlight.previousDigest)} →{" "}
                {formatShortDigest(proposal.digest)}
              </span>
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

      {/* Execution Topology Ribbon with inline BriefProgressChain folded into headerRight */}
      <ExecutionTopologyRibbon
        state={proposal.state}
        checks={proposal.checks}
        events={proposal.events}
        variant={isDrawer ? "vertical-rail" : "auto"}
        headerRight={
          progressChain ? (
            <BriefProgressChain
              variant="inline"
              phase={progressChain.phase}
              steps={progressChain.steps}
              summaryLabel={progressChain.summary}
              defaultExpanded={false}
            />
          ) : undefined
        }
      />

      {/* Main Content Layout: 2-Column on Desktop Page, Stacked in Drawer */}
      <div
        className={
          isDrawer
            ? "space-y-3.5"
            : "grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]"
        }
      >
        {/* Left Column: Diff, Digest Metadata & Intake Evidence */}
        <div className="space-y-4 min-w-0">
          <ProposalDiffView
            plan={proposal.plan}
            proposalId={proposal.id}
            compact={isDrawer}
          />

          {/* Digest & Ownership Metadata Card */}
          <div className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] overflow-hidden">
            <div className="border-b border-[var(--hairline)] px-4.5 py-3">
              <h3 className="text-[13.5px] font-semibold text-[var(--ink-primary)]">
                {tx({
                  "zh-CN": "摘要锁与审批责任",
                  "zh-HK": "摘要鎖與審批責任",
                  en: "Digest Lock & Governance",
                })}
              </h3>
            </div>
            <dl className="divide-y divide-[var(--hairline-subtle)] text-[12.5px]">
              <div className="flex items-center justify-between gap-3 px-4.5 py-3">
                <dt className="shrink-0 text-[var(--ink-muted)]">
                  {tx({
                    "zh-CN": "摘要锁",
                    "zh-HK": "摘要鎖",
                    en: "Digest Lock",
                  })}
                </dt>
                <dd className="min-w-0 flex items-center gap-1.5 text-right">
                  <span
                    title={proposal.digest}
                    className="inline-block max-w-[172px] truncate font-mono-code tabular-nums text-[12px] text-[var(--ink-primary)]"
                    data-testid="proposal-digest-value"
                  >
                    {proposal.digest}
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleCopy("digest", proposal.digest)}
                    title={tx(
                      {
                        "zh-CN": "复制完整摘要 {digest}",
                        "zh-HK": "複製完整摘要 {digest}",
                        en: "Copy full digest {digest}",
                      },
                      { digest: proposal.digest },
                    )}
                    aria-label={tx({
                      "zh-CN": "复制完整摘要",
                      "zh-HK": "複製完整摘要",
                      en: "Copy full digest",
                    })}
                    className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--bg-surface-subtle)] text-[var(--ink-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--ink-primary)] transition-colors cursor-pointer"
                  >
                    {copiedKey === "digest" ? (
                      <Check className="h-3 w-3 text-[var(--status-emerald)]" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                  </button>
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3 px-4.5 py-2.5">
                <dt className="text-[var(--ink-muted)]">
                  {tx({
                    "zh-CN": "发起人",
                    "zh-HK": "發起人",
                    en: "Requester",
                  })}
                </dt>
                <dd className="font-mono-code text-[var(--ink-primary)]">
                  {proposal.requester}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3 px-4.5 py-2.5">
                <dt className="text-[var(--ink-muted)]">
                  {tx({
                    "zh-CN": "独立批准人",
                    "zh-HK": "獨立批准人",
                    en: "Independent Approver",
                  })}
                </dt>
                <dd
                  className={
                    proposal.approver
                      ? "font-mono-code text-[var(--ink-primary)]"
                      : "text-[var(--ink-muted)]"
                  }
                >
                  {proposal.approver ??
                    tx({
                      "zh-CN": "待独立审批",
                      "zh-HK": "待獨立審批",
                      en: "Pending approval",
                    })}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3 px-4.5 py-2.5">
                <dt className="text-[var(--ink-muted)]">
                  {tx({
                    "zh-CN": "审核分派",
                    "zh-HK": "審核分派",
                    en: "Assigned Reviewer",
                  })}
                </dt>
                <dd
                  className={
                    proposal.review?.assigned_to
                      ? "font-mono-code text-[var(--ink-primary)]"
                      : "text-[var(--ink-muted)]"
                  }
                >
                  {proposal.review?.assigned_to ??
                    tx({
                      "zh-CN": "未指定（仓库主管池）",
                      "zh-HK": "未指定（倉庫主管池）",
                      en: "Unassigned (warehouse manager pool)",
                    })}
                </dd>
              </div>
              {proposal.review?.decision && (
                <div className="px-4.5 py-3 space-y-1 bg-[var(--bg-surface-tint)]">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[var(--ink-muted)]">
                      {tx({
                        "zh-CN": "审核结论",
                        "zh-HK": "審核結論",
                        en: "Review Decision",
                      })}
                    </span>
                    <span className="text-[var(--ink-primary)]">
                      {proposal.review.decision === "returned"
                        ? tx({
                            "zh-CN": "退回（终态）",
                            "zh-HK": "退回（終態）",
                            en: "Returned (Final)",
                          })
                        : tx({
                            "zh-CN": "拒绝（终态）",
                            "zh-HK": "拒絕（終態）",
                            en: "Rejected (Final)",
                          })}{" "}
                      ·{" "}
                      <span className="font-mono-code">
                        {proposal.review.decided_by}
                      </span>
                    </span>
                  </div>
                  {proposal.review.reason && (
                    <p className="text-[12px] text-[var(--ink-secondary)] break-words">
                      {tx(
                        {
                          "zh-CN": "理由：{reason}",
                          "zh-HK": "理由：{reason}",
                          en: "Reason: {reason}",
                        },
                        { reason: proposal.review.reason },
                      )}
                    </p>
                  )}
                </div>
              )}
              <div className="flex items-center justify-between gap-3 px-4.5 py-2.5">
                <dt className="text-[var(--ink-muted)]">
                  {tx({
                    "zh-CN": "计划执行 / 到期时间",
                    "zh-HK": "計劃執行 / 到期時間",
                    en: "Scheduled / Expires",
                  })}
                </dt>
                <dd className="flex items-center gap-2 tabular-nums">
                  <span className="font-mono-code text-[var(--ink-primary)]">
                    {formatDateTime(proposal.due, { withSeconds: true })}
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
              <div className="flex items-center justify-between gap-3 px-4.5 py-2.5">
                <dt className="text-[var(--ink-muted)]">
                  {tx({
                    "zh-CN": "归属租户",
                    "zh-HK": "歸屬租戶",
                    en: "Tenant",
                  })}
                </dt>
                <dd className="font-mono-code text-[var(--ink-primary)]">
                  {proposal.tenant}
                </dd>
              </div>
            </dl>
          </div>

          {/* Clickable Intake Evidence Panel (for sales_order.create_draft) */}
          {intakeId && (
            <div
              className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] overflow-hidden"
              data-testid="proposal-intake-evidence-panel"
            >
              <button
                type="button"
                onClick={() => void handleToggleIntake()}
                aria-expanded={intakeOpen}
                data-testid="proposal-intake-evidence-toggle"
                className="flex w-full items-center justify-between gap-2 px-4.5 py-3.5 text-left hover:bg-[var(--bg-surface-tint)] transition-colors duration-[150ms] cursor-pointer"
              >
                <div className="flex items-center gap-2 min-w-0">
                  {intakeOpen ? (
                    <ChevronDown className="h-4 w-4 shrink-0 text-[var(--ink-muted)]" />
                  ) : (
                    <ChevronRight className="h-4 w-4 shrink-0 text-[var(--ink-muted)]" />
                  )}
                  <FileSearch
                    className="h-4 w-4 shrink-0 text-[var(--accent)]"
                    strokeWidth={1.85}
                  />
                  <span className="text-[13.5px] font-semibold text-[var(--ink-primary)]">
                    {tx({
                      "zh-CN": "来源进件证据",
                      "zh-HK": "來源進件憑證",
                      en: "Source Intake Evidence",
                    })}
                  </span>
                  <span
                    title={intakeId}
                    className="font-mono-code text-[11.5px] text-[var(--ink-muted)] truncate"
                  >
                    {formatShortDigest(intakeId, 6, 4)}
                  </span>
                </div>
                <span className="rounded-full bg-[var(--accent-wash)] px-2.5 py-0.5 text-[11.5px] font-medium text-[var(--accent-ink)] shrink-0">
                  {intakeOpen
                    ? tx({
                        "zh-CN": "收起",
                        "zh-HK": "收合",
                        en: "Collapse",
                      })
                    : tx({
                        "zh-CN": "点击展开核验",
                        "zh-HK": "點擊展開核驗",
                        en: "Expand Evidence",
                      })}
                </span>
              </button>

              {intakeOpen && (
                <div className="border-t border-[var(--hairline-subtle)] p-4.5 space-y-3">
                  {intakeLoading && (
                    <p className="text-[12.5px] text-[var(--ink-muted)]">
                      {tx({
                        "zh-CN": "正在读取进件证据…",
                        "zh-HK": "正在讀取進件憑證…",
                        en: "Loading intake evidence…",
                      })}
                    </p>
                  )}
                  {intakeError && <AccessNoticeCard error={intakeError} />}
                  {!intakeLoading && !intakeError && intakeDetail && (
                    <div className="space-y-2.5 text-[12px]">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="rounded-full bg-[var(--bg-surface-subtle)] px-2.5 py-0.5 text-[11px] text-[var(--ink-secondary)]">
                          {intakeDetail.evidence.kind === "structured"
                            ? tx({
                                "zh-CN": "结构化进件",
                                "zh-HK": "結構化進件",
                                en: "Structured PO",
                              })
                            : tx({
                                "zh-CN": "图片 OCR 进件",
                                "zh-HK": "圖片 OCR 進件",
                                en: "Image OCR",
                              })}{" "}
                          ·{" "}
                          <span className="font-mono-code">
                            {intakeDetail.warehouse}
                          </span>
                        </span>
                        <span className="text-[11px] text-[var(--ink-muted)]">
                          {tx({
                            "zh-CN": "摘要 ",
                            "zh-HK": "摘要 ",
                            en: "SHA ",
                          })}
                          <span className="font-mono-code text-[var(--ink-secondary)]">
                            {formatShortDigest(
                              intakeDetail.evidence.artifact_sha256,
                            )}
                          </span>
                        </span>
                      </div>

                      {intakeDetail.evidence.kind === "structured" ? (
                        <div className="rounded-tile bg-[var(--bg-surface-tint)] p-3.5 space-y-2">
                          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11.5px]">
                            <span>
                              PO:{" "}
                              <span className="font-mono-code">
                                {intakeDetail.evidence.order.po}
                              </span>
                            </span>
                            <span>
                              {tx({
                                "zh-CN": "买方：",
                                "zh-HK": "買方：",
                                en: "Buyer: ",
                              })}
                              <span className="font-mono-code">
                                {intakeDetail.evidence.order.buyer}
                              </span>
                            </span>
                            <span>
                              {tx({
                                "zh-CN": "交期：",
                                "zh-HK": "交期：",
                                en: "Delivery: ",
                              })}
                              <span className="font-mono-code tabular-nums">
                                {intakeDetail.evidence.order.delivery}
                              </span>
                            </span>
                            <span className="font-mono-code tabular-nums font-semibold text-[var(--ink-primary)]">
                              {intakeDetail.evidence.order.currency}{" "}
                              {intakeDetail.evidence.order.total}
                            </span>
                          </div>
                          <div className="divide-y divide-[var(--hairline-subtle)] border-t border-[var(--hairline-subtle)] pt-1.5">
                            {intakeDetail.evidence.order.lines.map(
                              (line, i) => (
                                <div
                                  key={`${line.sku}-${i}`}
                                  className="flex items-center justify-between py-1.5 font-mono-code text-[11.5px]"
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
                        <div className="rounded-tile bg-[var(--bg-surface-tint)] p-3.5 space-y-2">
                          <div className="text-[11px] tabular-nums text-[var(--ink-muted)]">
                            <span className="font-mono-code">
                              {intakeDetail.evidence.reader_mode}
                            </span>
                            {" · "}
                            <span className="font-mono-code">
                              {intakeDetail.evidence.image_width}×
                              {intakeDetail.evidence.image_height}px
                            </span>
                            {" · "}
                            {tp(
                              {
                                "zh-CN": "{count} 提取字段",
                                "zh-HK": "{count} 擷取欄位",
                                en: {
                                  one: "{count} extracted field",
                                  other: "{count} extracted fields",
                                },
                              },
                              Object.keys(intakeDetail.evidence.fields).length,
                            )}
                          </div>
                          <div className="max-h-44 overflow-auto divide-y divide-[var(--hairline-subtle)]">
                            {Object.entries(intakeDetail.evidence.fields).map(
                              ([k, f]) => (
                                <div
                                  key={k}
                                  className="flex items-center justify-between gap-2 py-1.5 font-mono-code text-[11.5px]"
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
                        className="inline-flex items-center gap-1 text-[12.5px] font-medium text-[var(--accent)] hover:underline"
                      >
                        <span>
                          {tx({
                            "zh-CN": "在订单进件页查看完整证据",
                            "zh-HK": "在訂單進件頁檢視完整憑證",
                            en: "View Full Evidence in Order Intake",
                          })}
                        </span>
                        <ArrowUpRight className="h-3.5 w-3.5" />
                      </Link>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right Column: Crisp Verified ERP Receipt Hero Card & Audit Event Timeline */}
        <div className="space-y-4 min-w-0">
          {/* Verified ERP Receipt Hero Card */}
          {proposal.receipt && (
            <Interactive3DCard
              maxTilt={2}
              hoverLiftPx={-1}
              sheenIntensity="subtle"
              data-testid="proposal-receipt-card"
              className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] overflow-hidden"
            >
              <div className="flex items-center gap-2 bg-[var(--status-emerald-wash)] px-4.5 py-3.5 text-[13.5px] font-semibold text-[var(--status-emerald)]">
                <CheckCircle2
                  className="h-4.5 w-4.5 shrink-0"
                  strokeWidth={1.9}
                />
                <span>
                  {tx({
                    "zh-CN": "已写入 · 已核对 ERP 回执",
                    "zh-HK": "已寫入 · 已核對 ERP 回執",
                    en: "Written · Verified ERP Receipt",
                  })}
                </span>
              </div>

              <dl className="divide-y divide-[var(--hairline-subtle)] text-[12.5px]">
                <div className="flex items-center justify-between gap-3 px-4.5 py-3">
                  <dt className="shrink-0 text-[var(--ink-muted)]">
                    {tx({
                      "zh-CN": "ERP 远端单号",
                      "zh-HK": "ERP 遠端單號",
                      en: "ERP Remote ID",
                    })}
                  </dt>
                  <dd
                    className="font-mono-code font-semibold text-[var(--ink-primary)] text-right break-all"
                    data-testid="proposal-receipt-remote-id"
                  >
                    {proposal.receipt.remote_id}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3 px-4.5 py-2.5">
                  <dt className="shrink-0 text-[var(--ink-muted)]">
                    {tx({
                      "zh-CN": "操作流水号",
                      "zh-HK": "操作流水號",
                      en: "Operation ID",
                    })}
                  </dt>
                  <dd
                    title={proposal.receipt.operation_id}
                    className="font-mono-code text-[var(--ink-primary)] text-right truncate"
                  >
                    {formatShortDigest(proposal.receipt.operation_id, 10, 6)}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3 px-4.5 py-2.5">
                  <dt className="shrink-0 text-[var(--ink-muted)]">
                    {tx({
                      "zh-CN": "回执摘要比对",
                      "zh-HK": "回執摘要比對",
                      en: "Receipt Digest",
                    })}
                  </dt>
                  <dd className="font-medium text-[var(--status-emerald)] text-right">
                    {proposal.receipt.plan_digest === proposal.digest ? (
                      <>
                        {tx({
                          "zh-CN": "一致 ",
                          "zh-HK": "一致 ",
                          en: "Matched ",
                        })}
                        <span className="font-mono-code">
                          (
                          {formatShortDigest(
                            proposal.receipt.plan_digest,
                            6,
                            4,
                          )}
                          )
                        </span>
                      </>
                    ) : (
                      <span className="font-mono-code">
                        {formatShortDigest(proposal.receipt.plan_digest, 6, 4)}
                      </span>
                    )}
                  </dd>
                </div>
              </dl>
            </Interactive3DCard>
          )}

          {!proposal.receipt &&
            (proposal.state === "OUTCOME_UNKNOWN" ||
              proposal.state === "NEEDS_OPERATOR") && (
              <div
                data-testid="proposal-outcome-guidance"
                className={[
                  "rounded-card p-4.5 space-y-2 text-[13px]",
                  proposal.state === "OUTCOME_UNKNOWN"
                    ? "bg-[var(--status-amber-wash)] text-[var(--status-amber-ink)]"
                    : "bg-[var(--status-crimson-wash)] text-[var(--status-crimson)]",
                ].join(" ")}
              >
                <div className="flex items-center gap-2 font-semibold">
                  <AlertTriangle
                    className="h-4 w-4 shrink-0"
                    strokeWidth={1.85}
                  />
                  <span>
                    {proposal.state === "OUTCOME_UNKNOWN"
                      ? tx({
                          "zh-CN": "ERP 写入结果待确认（自动只读回查中）",
                          "zh-HK": "ERP 寫入結果待確認（自動唯讀回查中）",
                          en: "ERP Write Outcome Pending (Auto Readback Active)",
                        })
                      : tx({
                          "zh-CN": "达到核验上限 · 需人工核查回执",
                          "zh-HK": "達到核驗上限 · 須人工核查回執",
                          en: "Verification Cap Reached · Operator Review Needed",
                        })}
                  </span>
                </div>
                <p className="text-[12.5px] leading-relaxed text-[var(--ink-secondary)]">
                  {proposal.state === "OUTCOME_UNKNOWN"
                    ? tx(
                        {
                          "zh-CN":
                            "系统正在按指数退避策略执行只读回执核查（当前轮次 {checks}/3），请勿重复创建相同业务单据。",
                          "zh-HK":
                            "系統正在按指數退避策略執行唯讀回執核查（目前輪次 {checks}/3），請勿重複建立相同業務單據。",
                          en: "Read-only receipt readback is retrying with backoff (attempt {checks}/3). Do not create a duplicate order.",
                        },
                        { checks: proposal.checks },
                      )
                    : tx({
                        "zh-CN":
                          "请运维或仓库主管核对 ERP 侧是否已生成对应单据后，点击「重新核验 ERP 回执」触发只读回查（不会重复写入 ERP）。",
                        "zh-HK":
                          "請維運或倉庫主管核對 ERP 側是否已產生對應單據後，點擊「重新核驗 ERP 回執」觸發唯讀回查（不會重複寫入 ERP）。",
                        en: "Verify in ERP whether the document exists, then click Re-Verify ERP Receipt to run a read-only check (no duplicate write).",
                      })}
                </p>
              </div>
            )}

          {/* Ordered Audit Event Timeline with Localized Labels & 1px Vertical Rail */}
          <div
            className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] overflow-hidden"
            data-testid="proposal-events-timeline"
          >
            <div className="flex items-center justify-between border-b border-[var(--hairline)] px-4.5 py-3">
              <h3 className="text-[13.5px] font-semibold text-[var(--ink-primary)]">
                {t("proposal.timeline.title")}
              </h3>
              <span className="rounded-full bg-[var(--bg-surface-subtle)] px-2.5 py-0.5 tabular-nums text-[11px] text-[var(--ink-muted)]">
                {tp(
                  {
                    "zh-CN": "{count} 条记录",
                    "zh-HK": "{count} 筆紀錄",
                    en: { one: "{count} event", other: "{count} events" },
                  },
                  proposal.events.length,
                )}
              </span>
            </div>

            {proposal.events.length === 0 ? (
              <div className="px-4 py-8 text-center text-[12.5px] text-[var(--ink-muted)]">
                {tx({
                  "zh-CN": "暂无审计事件明细",
                  "zh-HK": "暫無稽核事件明細",
                  en: "No audit events recorded yet",
                })}
              </div>
            ) : (
              <ol className="relative px-4.5 py-3 space-y-3">
                {proposal.events.length > 1 && (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute left-[21.5px] top-6 bottom-6 w-px bg-[var(--hairline-strong)]"
                  />
                )}
                {proposal.events.map((ev, idx) => {
                  const meta = localizeTimelineEvent(ev.event);
                  const actorDisplay = formatAuditActor(ev.subject);
                  const dotTone =
                    meta.tone === "emerald"
                      ? "bg-[var(--status-emerald)] ring-4 ring-[var(--bg-surface)]"
                      : meta.tone === "amber"
                        ? "bg-[var(--status-amber)] ring-4 ring-[var(--bg-surface)]"
                        : meta.tone === "crimson"
                          ? "bg-[var(--status-crimson)] ring-4 ring-[var(--bg-surface)]"
                          : "bg-[var(--ink-muted)] ring-4 ring-[var(--bg-surface)]";
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
                      title={`${ev.event} · ${ev.subject}`}
                      className="relative z-10 flex items-start justify-between gap-3 text-[12.5px]"
                    >
                      <div className="flex items-start gap-3 min-w-0">
                        <span
                          aria-hidden="true"
                          className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dotTone}`}
                        />
                        <div className="min-w-0">
                          <div className={`font-medium ${textTone}`}>
                            {meta.label}
                          </div>
                          <div className="mt-0.5 text-[11.5px] text-[var(--ink-muted)]">
                            {actorDisplay}
                          </div>
                        </div>
                      </div>
                      <span className="shrink-0 font-mono-code tabular-nums text-[11px] text-[var(--ink-muted)]">
                        {formatDateTime(ev.at, { withSeconds: true })}
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
        title={tx({
          "zh-CN": "确认批准并进入 ERP 执行队列",
          "zh-HK": "確認批准並進入 ERP 執行佇列",
          en: "Confirm Approval & Queue for ERP",
        })}
        description={tx({
          "zh-CN":
            "批准后将锁定当前提案摘要，并由后台可靠队列向 ERP 执行幂等写入与回执核验。重复提交不会造成重复入账。",
          "zh-HK":
            "批准後將鎖定目前提案摘要，並由背景可靠佇列向 ERP 執行冪等寫入與回執核驗。重複提交不會造成重複入帳。",
          en: "Approving locks the current digest and queues an idempotent ERP write with receipt verification. Retries will never duplicate postings.",
        })}
        scopeSummary={`${proposal.warehouse} · ${changeSummary}`}
        metadata={confirmMetadata}
        confirmLabel={tx({
          "zh-CN": "确认批准并入队",
          "zh-HK": "確認批准並入隊",
          en: "Confirm Approve & Queue",
        })}
        loading={actionLoading}
        onConfirm={executeApprove}
      >
        <div
          data-testid="proposal-approve-dialog"
          className="text-[12px] text-[var(--ink-muted)]"
        >
          {tx({
            "zh-CN": "请确认数量、单位换算及总额无误后再执行批准。",
            "zh-HK": "請確認數量、單位換算及總額無誤後再執行批准。",
            en: "Verify quantities, UOM conversions, and totals before confirming.",
          })}
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={activeDialog === "return"}
        onOpenChange={(open) => !open && setActiveDialog(null)}
        title={tx({
          "zh-CN": "确认退回提案",
          "zh-HK": "確認退回提案",
          en: "Return Proposal for Revision",
        })}
        description={tx({
          "zh-CN":
            "退回后本条提案将进入终态，发起人需根据退回理由重新提交新的进件或改期提案。",
          "zh-HK":
            "退回後本筆提案將進入終態，發起人須根據退回理由重新提交新的進件或改期提案。",
          en: "Returning closes this proposal permanently; the requester must submit a new intake or reschedule with your feedback.",
        })}
        scopeSummary={`${formatShortDigest(proposal.id, 6, 4)} · ${proposal.warehouse}`}
        metadata={[
          {
            label: tx({
              "zh-CN": "提案编号",
              "zh-HK": "提案編號",
              en: "Proposal ID",
            }),
            value: proposal.id,
            mono: true,
          },
          {
            label: tx({
              "zh-CN": "摘要锁",
              "zh-HK": "摘要鎖",
              en: "Digest Lock",
            }),
            value: formatShortDigest(proposal.digest),
            mono: true,
          },
        ]}
        confirmLabel={tx({
          "zh-CN": "确认退回",
          "zh-HK": "確認退回",
          en: "Confirm Return",
        })}
        destructive
        loading={actionLoading}
        onConfirm={() => executeReview("return")}
      >
        <div className="space-y-1.5" data-testid="proposal-return-dialog">
          <label
            htmlFor={`return-reason-${proposal.id}`}
            className="block text-[12px] font-medium text-[var(--ink-primary)]"
          >
            {tx({
              "zh-CN": "退回理由（必填）",
              "zh-HK": "退回理由（必填）",
              en: "Return Reason (Required)",
            })}
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
            placeholder={tx({
              "zh-CN": "例如：交付日期需与客户重新确认，请更新后重新提交",
              "zh-HK": "例如：交付日期須與客戶重新確認，請更新後重新提交",
              en: "e.g. Please reconfirm the delivery date with the buyer and resubmit",
            })}
            data-testid="proposal-review-reason-input"
            className="w-full rounded-sm border border-[var(--hairline-strong)] bg-[var(--bg-surface-tint)] px-3 py-2 text-[13px] text-[var(--ink-primary)] focus:bg-[var(--bg-surface)] focus:border-[var(--accent)] focus:ring-3 focus:ring-[var(--accent-ring)] focus:outline-none transition-all duration-[150ms]"
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
        title={tx({
          "zh-CN": "确认拒绝该提案",
          "zh-HK": "確認拒絕該提案",
          en: "Confirm Proposal Rejection",
        })}
        description={tx({
          "zh-CN": "拒绝后本条提案将永久终止，不可再进入执行队列。",
          "zh-HK": "拒絕後本筆提案將永久終止，不可再進入執行佇列。",
          en: "Rejecting permanently terminates this proposal so it can never enter the ERP execution queue.",
        })}
        scopeSummary={`${formatShortDigest(proposal.id, 6, 4)} · ${proposal.warehouse}`}
        metadata={[
          {
            label: tx({
              "zh-CN": "提案编号",
              "zh-HK": "提案編號",
              en: "Proposal ID",
            }),
            value: proposal.id,
            mono: true,
          },
          {
            label: tx({
              "zh-CN": "摘要锁",
              "zh-HK": "摘要鎖",
              en: "Digest Lock",
            }),
            value: formatShortDigest(proposal.digest),
            mono: true,
          },
        ]}
        confirmLabel={tx({
          "zh-CN": "确认拒绝",
          "zh-HK": "確認拒絕",
          en: "Confirm Reject",
        })}
        destructive
        loading={actionLoading}
        onConfirm={() => executeReview("reject")}
      >
        <div className="space-y-1.5" data-testid="proposal-reject-dialog">
          <label
            htmlFor={`reject-reason-${proposal.id}`}
            className="block text-[12px] font-medium text-[var(--ink-primary)]"
          >
            {tx({
              "zh-CN": "拒绝理由（必填）",
              "zh-HK": "拒絕理由（必填）",
              en: "Rejection Reason (Required)",
            })}
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
            placeholder={tx({
              "zh-CN": "例如：超出仓库额度或客户单据已作废",
              "zh-HK": "例如：超出倉庫額度或客戶單據已作廢",
              en: "e.g. Exceeds warehouse limit or buyer PO has been voided",
            })}
            data-testid="proposal-review-reason-input"
            className="w-full rounded-sm border border-[var(--hairline-strong)] bg-[var(--bg-surface-tint)] px-3 py-2 text-[13px] text-[var(--ink-primary)] focus:bg-[var(--bg-surface)] focus:border-[var(--accent)] focus:ring-3 focus:ring-[var(--accent-ring)] focus:outline-none transition-all duration-[150ms]"
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
        title={tx({
          "zh-CN": "分派审批人",
          "zh-HK": "分派審批人",
          en: "Assign Approver",
        })}
        description={tx({
          "zh-CN":
            "将本提案明确指派给同租户内具备该仓库审批权限的独立主管，系统将同步发送站内通知。",
          "zh-HK":
            "將本提案明確指派予同租戶內具備該倉庫審批權限的獨立主管，系統將同步發送站內通知。",
          en: "Assign this proposal to an independent manager authorized for this warehouse. An in-app notice will be sent.",
        })}
        scopeSummary={`${formatShortDigest(proposal.id, 6, 4)} · ${proposal.warehouse}`}
        confirmLabel={tx({
          "zh-CN": "确认分派",
          "zh-HK": "確認分派",
          en: "Confirm Assignment",
        })}
        loading={actionLoading}
        onConfirm={() => executeReview("assign")}
      >
        <div className="space-y-2.5" data-testid="proposal-assign-dialog">
          <label
            htmlFor={`assign-subject-${proposal.id}`}
            className="block text-[12px] font-medium text-[var(--ink-primary)]"
          >
            {tx({
              "zh-CN": "审批人账号",
              "zh-HK": "審批人帳號",
              en: "Approver Subject ID",
            })}
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
            placeholder={tx({
              "zh-CN": "例如 manager",
              "zh-HK": "例如 manager",
              en: "e.g. manager",
            })}
            data-testid="proposal-assign-input"
            className="h-9 w-full rounded-sm border border-[var(--hairline-strong)] bg-[var(--bg-surface-tint)] px-3 font-mono-code text-[13px] text-[var(--ink-primary)] focus:bg-[var(--bg-surface)] focus:border-[var(--accent)] focus:ring-3 focus:ring-[var(--accent-ring)] focus:outline-none transition-all duration-[150ms]"
          />
          {demoConfig?.enabled && approverSuggestions.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11.5px] text-[var(--ink-muted)]">
                {tx({
                  "zh-CN": "常用候选：",
                  "zh-HK": "常用候選：",
                  en: "Suggested:",
                })}
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
                    className="rounded-full bg-[var(--bg-surface-subtle)] px-2.5 py-1 font-mono-code text-[11px] text-[var(--ink-secondary)] hover:bg-[var(--accent-wash)] hover:text-[var(--accent-ink)] transition-colors cursor-pointer"
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
        title={tx({
          "zh-CN": "确认释放审批分派",
          "zh-HK": "確認釋放審批分派",
          en: "Release Approval Assignment",
        })}
        description={tx({
          "zh-CN":
            "释放后该提案将回到仓库待审批池，任何具备该仓库审批权限的独立主管均可认领或审批。",
          "zh-HK":
            "釋放後該提案將回到倉庫待審批池，任何具備該倉庫審批權限的獨立主管均可認領或審批。",
          en: "Releasing returns this proposal to the warehouse approval pool so any authorized independent manager can approve it.",
        })}
        scopeSummary={tx(
          {
            "zh-CN": "{id} · 当前指派人：{assignee}",
            "zh-HK": "{id} · 目前指派人：{assignee}",
            en: "{id} · Currently assigned to: {assignee}",
          },
          {
            id: formatShortDigest(proposal.id, 6, 4),
            assignee: proposal.review?.assigned_to ?? "—",
          },
        )}
        confirmLabel={tx({
          "zh-CN": "确认释放",
          "zh-HK": "確認釋放",
          en: "Confirm Release",
        })}
        loading={actionLoading}
        onConfirm={() => executeReview("release")}
      />

      <ConfirmDialog
        open={activeDialog === "reconcile"}
        onOpenChange={(open) => !open && setActiveDialog(null)}
        title={tx({
          "zh-CN": "重新核验 ERP 回执（只读回查）",
          "zh-HK": "重新核驗 ERP 回執（唯讀回查）",
          en: "Re-Verify ERP Receipt (Read-Only)",
        })}
        description={tx({
          "zh-CN":
            "该操作将把单据状态重置为结果待确认并清零核验计数，由后台执行器执行只读回执查询，不会向 ERP 重复写入新记录。",
          "zh-HK":
            "該操作將把單據狀態重設為結果待確認並清零核驗計數，由背景執行器執行唯讀回執查詢，不會向 ERP 重複寫入新紀錄。",
          en: "Resets state to Outcome Unknown with check count 0 so the background worker runs read-only receipt checks without duplicating ERP writes.",
        })}
        scopeSummary={`${formatShortDigest(proposal.id, 6, 4)} · ${proposal.warehouse} · ${proposal.plan.target}`}
        confirmLabel={tx({
          "zh-CN": "发起只读核验",
          "zh-HK": "發起唯讀核驗",
          en: "Start Read-Only Check",
        })}
        loading={actionLoading}
        onConfirm={executeReconcile}
      />
    </div>
  );
}
