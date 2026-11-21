"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  CalendarDays,
  ChevronDown,
  ChevronUp,
  ClipboardList,
  Clock,
  RefreshCw,
  Send,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import {
  callWorkbenchTool,
  generateClientId,
  generateIdempotencyKey,
  getAuthGeneration,
  isApiError,
  isStaleAuthError,
  submitWorkbenchTurn,
  type ApiError,
} from "@/lib/api-client";
import { formatProposalAction, formatUnixTime } from "@/lib/format";
import { useSession } from "@/lib/session-context";
import { useWorkbench } from "@/lib/workbench-context";
import { StatePulseBeacon } from "@/components/kinetic/StatePulseBeacon";
import { AccessNoticeCard } from "@/components/ui/AccessNoticeCard";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { StatusBadge } from "@/components/ui/StatusBadge";
import {
  fetchHistoryEntry,
  fetchHistoryPage,
  fetchWorkbenchBriefForRange,
} from "@/features/inbox/api";
import {
  getAssistantMemory,
  setAssistantExpandedHistory,
  setAssistantTurns,
  subscribeAssistantMemory,
  type AssistantTurnEntry,
  type ExpandedHistoryRecord,
} from "@/features/inbox/assistant-store";
import {
  AssistantBriefDrawer,
  AssistantProposalDrawer,
  AssistantResultDrawer,
} from "@/features/inbox/AssistantDrawerPanels";
import {
  TurnResultCard,
  buildCapabilityPromptOptions,
} from "@/features/inbox/TurnResultCard";
import type {
  BriefResponse,
  DrawerObjectSelection,
  HistoryCursor,
  HistoryListItem,
  Proposal,
  WorkbenchToolCall,
} from "@/lib/types";

const MAX_IN_PROGRESS_POLLS = 8;

export function AssistantWorkspace() {
  const {
    status,
    actor,
    capabilities,
    agentProfile,
    agentAvatarVersion,
    authGeneration,
    handleAccessChanged,
  } = useSession();
  const {
    selectedObject,
    openDrawer,
    clearSelectedObject,
    setCustomDrawerContent,
    getDraft,
    setDraft,
    clearDraft,
    assignedCount,
  } = useWorkbench();

  // In-memory store synced across /inbox <-> /inbox/assistant within same authGeneration
  const [memoryTick, setMemoryTick] = useState(0);
  useEffect(() => subscribeAssistantMemory(() => setMemoryTick((t) => t + 1)), []);

  const { turns, expandedHistory } = useMemo(() => {
    void memoryTick;
    return getAssistantMemory(authGeneration);
  }, [authGeneration, memoryTick]);

  // Composer draft synced with workbench-context (purges automatically on auth reset)
  const [composerText, setComposerText] = useState<string>(() =>
    getDraft("assistant"),
  );
  useEffect(() => {
    setComposerText(getDraft("assistant"));
  }, [authGeneration, getDraft]);

  const updateComposer = useCallback(
    (next: string) => {
      setComposerText(next);
      setDraft("assistant", next);
    },
    [setDraft],
  );

  // Paginated Agent History (safe ID + timestamp + category only)
  const [historyItems, setHistoryItems] = useState<HistoryListItem[]>([]);
  const [historyNext, setHistoryNext] = useState<HistoryCursor | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyToggledByUserRef = useRef(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
  const [historyError, setHistoryError] = useState<ApiError | null>(null);

  // Collapsible inline Today Brief panel
  const [briefPanelOpen, setBriefPanelOpen] = useState(false);
  const [briefData, setBriefData] = useState<BriefResponse | null>(null);
  const [briefLoading, setBriefLoading] = useState(false);
  const [briefError, setBriefError] = useState<ApiError | null>(null);

  // Optional deterministic Structured Call Bar (/v1/workbench/calls)
  const [structuredOpen, setStructuredOpen] = useState(false);
  const [selectedToolId, setSelectedToolId] = useState<string>("");
  const [toolWarehouse, setToolWarehouse] = useState<string>("");
  const [toolRefId, setToolRefId] = useState<string>("");
  const [toolDeliveryDate, setToolDeliveryDate] = useState<string>("");
  const [toolSubmitting, setToolSubmitting] = useState(false);

  const feedEndRef = useRef<HTMLDivElement | null>(null);
  const pollTimersRef = useRef<Set<number>>(new Set());

  const clearAllPollTimers = useCallback(() => {
    for (const id of pollTimersRef.current) {
      window.clearTimeout(id);
    }
    pollTimersRef.current.clear();
  }, []);

  // Strict auth reset hygiene: clear timers, history, inline brief, structured inputs
  useEffect(() => {
    clearAllPollTimers();
    historyToggledByUserRef.current = false;
    setHistoryOpen(false);
    setHistoryItems([]);
    setHistoryNext(null);
    setHistoryError(null);
    setBriefPanelOpen(false);
    setBriefData(null);
    setBriefError(null);
    setStructuredOpen(false);
    setToolRefId("");
    setToolDeliveryDate("");
  }, [authGeneration, clearAllPollTimers]);

  useEffect(() => {
    return () => {
      clearAllPollTimers();
    };
  }, [clearAllPollTimers]);

  const availableTools = useMemo(
    () => (capabilities?.tools ?? []).filter((t) => t.available),
    [capabilities],
  );

  // Initialize structured tool selector defaults when capabilities change
  useEffect(() => {
    if (availableTools.length === 0) {
      setSelectedToolId("");
      setToolWarehouse("");
      return;
    }
    const current = availableTools.find((t) => t.id === selectedToolId);
    const chosen = current ?? availableTools[0]!;
    if (!current) {
      setSelectedToolId(chosen.id);
    }
    if (
      chosen.warehouses.length > 0 &&
      !chosen.warehouses.includes(toolWarehouse)
    ) {
      setToolWarehouse(chosen.warehouses[0]!);
    }
  }, [availableTools, selectedToolId, toolWarehouse]);

  const loadHistory = useCallback(
    async (cursor?: HistoryCursor | null) => {
      if (status !== "authenticated") return;
      if (cursor) {
        setHistoryLoadingMore(true);
      } else {
        setHistoryLoading(true);
      }
      setHistoryError(null);
      try {
        const res = await fetchHistoryPage({
          limit: 20,
          before_at: cursor?.before_at,
          before_id: cursor?.before_id,
        });
        setHistoryItems((prev) => {
          if (!cursor) return res.items;
          const seen = new Set(prev.map((i) => i.id));
          const merged = [...prev];
          for (const item of res.items) {
            if (!seen.has(item.id)) {
              seen.add(item.id);
              merged.push(item);
            }
          }
          return merged;
        });
        if (!cursor && res.items.length > 0 && !historyToggledByUserRef.current) {
          setHistoryOpen(true);
        }
        setHistoryNext(res.next);
      } catch (err) {
        if (isStaleAuthError(err)) return;
        if (isApiError(err)) {
          if (err.code === "ACCESS_CHANGED") {
            setHistoryItems([]);
            setHistoryNext(null);
            void handleAccessChanged();
          }
          setHistoryError(err);
        }
      } finally {
        setHistoryLoading(false);
        setHistoryLoadingMore(false);
      }
    },
    [status, handleAccessChanged],
  );

  useEffect(() => {
    if (status === "authenticated") {
      void loadHistory(null);
    }
  }, [status, authGeneration, loadHistory]);

  const handleInspectObject = useCallback(
    (selection: DrawerObjectSelection, trigger: HTMLElement | null) => {
      openDrawer(selection, { tab: "current", trigger });
    },
    [openDrawer],
  );

  const handleDrawerProposalCreated = useCallback(
    (proposal: Proposal) => {
      const gen = getAuthGeneration();
      setAssistantTurns(gen, (prev) => [
        ...prev,
        {
          id: `call_${proposal.id}_${Date.now()}`,
          clientId: proposal.id,
          userText: `发起运单改期提案 (${proposal.plan.target} · ${proposal.warehouse})`,
          createdAt: Math.floor(Date.now() / 1000),
          status: "done",
          result: {
            kind: "proposal",
            tool: "shipment.reschedule",
            proposal,
          },
          sourceKind: "tool_call",
        },
      ]);
      openDrawer(
        {
          kind: "proposal",
          id: proposal.id,
          warehouse: proposal.warehouse,
          title: formatProposalAction(proposal.plan.action),
        },
        { tab: "current" },
      );
    },
    [openDrawer],
  );

  // Sync rich custom drawer content keyed strictly to selectedObject; always clean up on unmount
  useEffect(() => {
    if (!selectedObject) {
      setCustomDrawerContent(null);
      return;
    }
    if (selectedObject.kind === "brief") {
      setCustomDrawerContent(<AssistantBriefDrawer />);
      return;
    }
    if (selectedObject.kind === "proposal") {
      setCustomDrawerContent(
        <AssistantProposalDrawer proposalId={selectedObject.id} />,
      );
      return;
    }
    if (
      selectedObject.kind === "shipment" ||
      selectedObject.kind === "invoice" ||
      selectedObject.kind === "summary"
    ) {
      setCustomDrawerContent(
        <AssistantResultDrawer
          selection={selectedObject}
          capabilities={capabilities}
          onProposalCreated={handleDrawerProposalCreated}
        />,
      );
      return;
    }
    setCustomDrawerContent(null);
  }, [
    selectedObject,
    capabilities,
    setCustomDrawerContent,
    handleDrawerProposalCreated,
  ]);

  useEffect(() => {
    return () => {
      setCustomDrawerContent(null);
    };
  }, [setCustomDrawerContent]);

  // Bounded polling helper for 409 TURN_IN_PROGRESS respecting Retry-After
  const scheduleInProgressPoll = useCallback(
    (
      entryId: string,
      clientId: string,
      startGen: number,
      waitSeconds: number,
      attempt: number,
    ) => {
      const delayMs = Math.max(1, waitSeconds) * 1000;
      const timerId = window.setTimeout(async () => {
        pollTimersRef.current.delete(timerId);
        if (startGen !== getAuthGeneration()) return;

        try {
          const result = await fetchHistoryEntry(clientId);
          if (startGen !== getAuthGeneration()) return;
          setAssistantTurns(startGen, (prev) =>
            prev.map((item) =>
              item.id === entryId
                ? {
                    ...item,
                    status: "done",
                    result,
                    error: undefined,
                    waitingRetryAfter: null,
                  }
                : item,
            ),
          );
          void loadHistory(null);
        } catch (err) {
          if (isStaleAuthError(err) || startGen !== getAuthGeneration()) return;
          if (isApiError(err)) {
            if (
              err.status === 409 &&
              err.code === "TURN_IN_PROGRESS" &&
              attempt < MAX_IN_PROGRESS_POLLS
            ) {
              const nextWait = err.retryAfter ?? 2;
              setAssistantTurns(startGen, (prev) =>
                prev.map((item) =>
                  item.id === entryId
                    ? { ...item, status: "pending", waitingRetryAfter: nextWait }
                    : item,
                ),
              );
              scheduleInProgressPoll(
                entryId,
                clientId,
                startGen,
                nextWait,
                attempt + 1,
              );
              return;
            }
            if (err.code === "ACCESS_CHANGED") {
              void handleAccessChanged();
            }
            setAssistantTurns(startGen, (prev) =>
              prev.map((item) =>
                item.id === entryId
                  ? { ...item, status: "error", error: err, waitingRetryAfter: null }
                  : item,
              ),
            );
          }
        }
      }, delayMs);
      pollTimersRef.current.add(timerId);
    },
    [handleAccessChanged, loadHistory],
  );

  const executeTurn = useCallback(
    async (text: string, existingEntry?: { id: string; clientId: string }) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const startGen = getAuthGeneration();
      const clientId = existingEntry?.clientId ?? generateClientId("turn");
      const entryId = existingEntry?.id ?? clientId;

      if (existingEntry) {
        setAssistantTurns(startGen, (prev) =>
          prev.map((item) =>
            item.id === entryId
              ? {
                  ...item,
                  status: "pending",
                  error: undefined,
                  waitingRetryAfter: null,
                }
              : item,
          ),
        );
      } else {
        const newEntry: AssistantTurnEntry = {
          id: entryId,
          clientId,
          userText: trimmed,
          createdAt: Math.floor(Date.now() / 1000),
          status: "pending",
          sourceKind: "turn",
        };
        setAssistantTurns(startGen, (prev) => [...prev, newEntry]);
        requestAnimationFrame(() => {
          feedEndRef.current?.scrollIntoView({ behavior: "smooth" });
        });
      }

      try {
        // NEVER sends Idempotency-Key header when client_id is passed (enforced here and in apiFetch)
        const result = await submitWorkbenchTurn(trimmed, clientId);
        if (startGen !== getAuthGeneration()) return;
        setAssistantTurns(startGen, (prev) =>
          prev.map((item) =>
            item.id === entryId
              ? {
                  ...item,
                  status: "done",
                  result,
                  error: undefined,
                  waitingRetryAfter: null,
                }
              : item,
          ),
        );
        void loadHistory(null);
      } catch (err) {
        if (isStaleAuthError(err) || startGen !== getAuthGeneration()) return;
        if (isApiError(err)) {
          if (err.status === 409 && err.code === "TURN_IN_PROGRESS") {
            const retrySec = err.retryAfter ?? 2;
            setAssistantTurns(startGen, (prev) =>
              prev.map((item) =>
                item.id === entryId
                  ? { ...item, status: "pending", waitingRetryAfter: retrySec }
                  : item,
              ),
            );
            scheduleInProgressPoll(entryId, clientId, startGen, retrySec, 1);
            return;
          }
          if (err.code === "ACCESS_CHANGED") {
            // Immediately scrub all previously displayed projections across history, live turns & drawer
            setAssistantExpandedHistory(startGen, () => ({}));
            clearSelectedObject();
            void handleAccessChanged();
          }
          setAssistantTurns(startGen, (prev) =>
            prev.map((item) => {
              if (item.id === entryId) {
                return {
                  ...item,
                  status: "error",
                  result: undefined,
                  error: err,
                  waitingRetryAfter: null,
                };
              }
              if (err.code === "ACCESS_CHANGED" && item.result?.kind === "result") {
                return {
                  ...item,
                  status: "error",
                  result: undefined,
                  error: err,
                  waitingRetryAfter: null,
                };
              }
              return item;
            }),
          );
        } else {
          // Network/transport failure: synthesize recoverable 503 so user can retry with same client_id
          const fallbackErr = new (await import("@/lib/api-client")).ApiError({
            status: 503,
            code: "UPSTREAM_UNAVAILABLE",
            message: "网络连接异常或上游暂不可用，请点击重试。",
            requestId: null,
            retryAfter: 2,
            fieldErrors: [],
            nextStep: null,
            viewProposalId: null,
            allowedActions: [],
            warehouses: [],
            runId: null,
          });
          setAssistantTurns(startGen, (prev) =>
            prev.map((item) =>
              item.id === entryId
                ? {
                    ...item,
                    status: "error",
                    result: undefined,
                    error: fallbackErr,
                    waitingRetryAfter: null,
                  }
                : item,
            ),
          );
        }
      }
    },
    [clearSelectedObject, handleAccessChanged, loadHistory, scheduleInProgressPoll],
  );

  const handleSendComposer = () => {
    const trimmed = composerText.trim();
    if (!trimmed) return;
    clearDraft("assistant");
    setComposerText("");
    void executeTurn(trimmed);
  };

  const handleComposerKeyDown = (
    e: React.KeyboardEvent<HTMLTextAreaElement>,
  ) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSendComposer();
    }
  };

  const handleExpandHistory = async (historyId: string) => {
    const startGen = getAuthGeneration();
    // Clear any previously displayed result fields BEFORE re-verifying so stale data never lingers
    setAssistantExpandedHistory(startGen, (prev) => ({
      ...prev,
      [historyId]: { loading: true },
    }));

    try {
      const result = await fetchHistoryEntry(historyId);
      if (startGen !== getAuthGeneration()) return;
      setAssistantExpandedHistory(startGen, (prev) => ({
        ...prev,
        [historyId]: {
          loading: false,
          result,
          verifiedAt: Math.floor(Date.now() / 1000),
        },
      }));
    } catch (err) {
      if (isStaleAuthError(err) || startGen !== getAuthGeneration()) return;
      if (isApiError(err)) {
        const isAccessRevoked =
          err.status === 403 &&
          (err.code === "ACCESS_CHANGED" || err.code === "ACCESS_RESTRICTED");
        if (isAccessRevoked) {
          clearSelectedObject();
          if (err.code === "ACCESS_CHANGED") {
            setAssistantTurns(startGen, (prev) =>
              prev.map((item) =>
                item.result?.kind === "result"
                  ? { ...item, status: "error", result: undefined, error: err }
                  : item,
              ),
            );
          }
          void handleAccessChanged();
        }
        // Immediately replace with cleared projection + honest AccessNoticeCard
        const clearedRecord: ExpandedHistoryRecord = {
          loading: false,
          result: undefined,
          error: err,
        };
        setAssistantExpandedHistory(startGen, (prev) => ({
          ...prev,
          [historyId]: clearedRecord,
        }));
      }
    }
  };

  const handleToggleTodayBrief = async (trigger: HTMLElement | null) => {
    if (typeof window !== "undefined" && window.innerWidth >= 1280) {
      openDrawer(
        {
          kind: "brief",
          id: `brief-today-${Date.now()}`,
          title: "今日工作简报",
        },
        { tab: "current", trigger },
      );
      return;
    }

    const nextOpen = !briefPanelOpen;
    setBriefPanelOpen(nextOpen);
    if (!nextOpen) return;

    setBriefLoading(true);
    setBriefError(null);
    try {
      const data = await fetchWorkbenchBriefForRange(1);
      setBriefData(data);
    } catch (err) {
      if (isStaleAuthError(err)) return;
      if (isApiError(err)) {
        if (err.code === "ACCESS_CHANGED") {
          setBriefData(null);
          void handleAccessChanged();
        }
        setBriefError(err);
      }
    } finally {
      setBriefLoading(false);
    }
  };

  const handleStructuredSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (toolSubmitting || !selectedToolId) return;

    const chosen = availableTools.find((t) => t.id === selectedToolId);
    if (!chosen) return;

    let payload: WorkbenchToolCall;
    let labelText = "";

    if (chosen.id === "mail.inbox.read") {
      payload = { tool: "mail.inbox.read", limit: 10 };
      labelText = "结构化直达 · 查看我的收件箱";
    } else if (chosen.id === "decision.warehouse.summary") {
      if (!toolWarehouse) return;
      payload = { tool: "decision.warehouse.summary", warehouse: toolWarehouse };
      labelText = `结构化直达 · 仓库汇总 ${toolWarehouse}`;
    } else if (chosen.id === "finance.invoice.read") {
      if (!toolWarehouse || !toolRefId.trim()) return;
      payload = {
        tool: "finance.invoice.read",
        warehouse: toolWarehouse,
        invoice_id: toolRefId.trim(),
      };
      labelText = `结构化直达 · 查看发票 ${toolRefId.trim()} (${toolWarehouse})`;
    } else if (chosen.id === "shipment.read") {
      if (!toolWarehouse || !toolRefId.trim()) return;
      payload = {
        tool: "shipment.read",
        warehouse: toolWarehouse,
        shipment_id: toolRefId.trim(),
      };
      labelText = `结构化直达 · 查看运单 ${toolRefId.trim()} (${toolWarehouse})`;
    } else if (chosen.id === "shipment.reschedule") {
      if (!toolWarehouse || !toolRefId.trim() || !toolDeliveryDate) return;
      payload = {
        tool: "shipment.reschedule",
        warehouse: toolWarehouse,
        shipment_id: toolRefId.trim(),
        delivery_date: toolDeliveryDate,
      };
      labelText = `结构化直达 · 运单改期 ${toolRefId.trim()} -> ${toolDeliveryDate}`;
    } else if (chosen.id === "order.draft.prepare") {
      if (!toolWarehouse || !toolRefId.trim()) return;
      payload = {
        tool: "order.draft.prepare",
        warehouse: toolWarehouse,
        intake_id: toolRefId.trim(),
      };
      labelText = `结构化直达 · 准备订单草稿 ${toolRefId.trim()} (${toolWarehouse})`;
    } else {
      return;
    }

    const startGen = getAuthGeneration();
    const entryId = generateClientId("call");
    const idempotencyKey =
      chosen.mode === "proposal" ? generateIdempotencyKey("call") : undefined;

    setToolSubmitting(true);
    setAssistantTurns(startGen, (prev) => [
      ...prev,
      {
        id: entryId,
        clientId: entryId,
        userText: labelText,
        createdAt: Math.floor(Date.now() / 1000),
        status: "pending",
        sourceKind: "tool_call",
      },
    ]);

    try {
      const result = await callWorkbenchTool(payload, { idempotencyKey });
      if (startGen !== getAuthGeneration()) return;
      setAssistantTurns(startGen, (prev) =>
        prev.map((item) =>
          item.id === entryId ? { ...item, status: "done", result } : item,
        ),
      );
    } catch (err) {
      if (isStaleAuthError(err) || startGen !== getAuthGeneration()) return;
      if (isApiError(err)) {
        if (err.code === "ACCESS_CHANGED") {
          setAssistantExpandedHistory(startGen, () => ({}));
          clearSelectedObject();
          void handleAccessChanged();
        }
        setAssistantTurns(startGen, (prev) =>
          prev.map((item) =>
            item.id === entryId ? { ...item, status: "error", error: err } : item,
          ),
        );
      }
    } finally {
      setToolSubmitting(false);
    }
  };

  const agentDisplayName = agentProfile?.display_name || "个人业务助手";
  const agentAvatarSrc = agentProfile?.has_avatar
    ? `/v1/agent-profile/avatar?v=${agentAvatarVersion}`
    : null;
  const quickPromptOptions = useMemo(
    () => buildCapabilityPromptOptions(capabilities),
    [capabilities],
  );
  const selectedToolMeta = availableTools.find((t) => t.id === selectedToolId);
  const hasPendingTurn = turns.some((t) => t.status === "pending");

  return (
    <div
      data-testid="assistant-workspace"
      className="flex h-full min-h-0 flex-col bg-[var(--bg-sheet)]"
    >
      {/* Thread Header (48px) */}
      <header className="flex min-h-[52px] shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[var(--hairline)] bg-[var(--bg-sheet)] px-3.5 py-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <Link
            href="/inbox"
            aria-label="返回会话列表"
            data-testid="assistant-mobile-back"
            className="inline-flex h-8 w-8 items-center justify-center rounded-[4px] border border-[var(--hairline-strong)] text-[var(--ink-secondary)] hover:bg-[var(--bg-subtle)] lg:hidden"
          >
            <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
          </Link>
          <Avatar
            src={agentAvatarSrc}
            name={agentDisplayName}
            fallbackText="AG"
            size="md"
            kind="agent"
          />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <h2
                data-testid="assistant-header-name"
                className="truncate text-[14.5px] font-semibold text-[var(--ink-primary)]"
              >
                {agentDisplayName}
              </h2>
              <span className="shrink-0 rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-subtle)] px-1.5 py-0.5 font-mono-code text-[10px] font-medium uppercase tracking-[0.04em] text-[var(--ink-secondary)] leading-none">
                Agent
              </span>
            </div>
            <p className="truncate text-[11.5px] text-[var(--ink-muted)]">
              独立业务上下文 · 权限实时校验
              {actor ? ` · ${actor.tenant} (${actor.warehouses.join("/") || "无站点"})` : ""}
            </p>
          </div>
        </div>

        {/* Quick Actions Header */}
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            data-testid="assistant-quick-assigned"
            onClick={(e) =>
              openDrawer(null, { tab: "assigned", trigger: e.currentTarget })
            }
          >
            <ClipboardList className="h-3.5 w-3.5" strokeWidth={1.75} />
            <span>待我处理</span>
            {assignedCount > 0 && (
              <span className="font-mono-code text-[11px] text-[var(--accent)]">
                ({assignedCount})
              </span>
            )}
          </Button>

          <Button
            size="sm"
            variant="secondary"
            data-testid="assistant-quick-brief"
            onClick={(e) => void handleToggleTodayBrief(e.currentTarget)}
          >
            <CalendarDays className="h-3.5 w-3.5" strokeWidth={1.75} />
            <span>今日简报</span>
          </Button>

          {availableTools.length > 0 && (
            <Button
              size="sm"
              variant={structuredOpen ? "primary" : "secondary"}
              data-testid="assistant-toggle-structured"
              onClick={() => setStructuredOpen((v) => !v)}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" strokeWidth={1.75} />
              <span className="hidden sm:inline">结构化直达</span>
            </Button>
          )}
        </div>
      </header>

      {/* Collapsible Inline Today Brief Panel (primarily for narrow viewports) */}
      {briefPanelOpen && (
        <div
          data-testid="assistant-inline-brief"
          className="shrink-0 border-b border-[var(--hairline)] bg-[var(--bg-subtle)] px-4 py-3"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-[12.5px] font-semibold text-[var(--ink-primary)]">
              今日简报（本地时区）
            </span>
            <button
              type="button"
              onClick={() => setBriefPanelOpen(false)}
              className="text-[11.5px] text-[var(--ink-muted)] hover:text-[var(--ink-primary)] cursor-pointer"
            >
              收起
            </button>
          </div>
          {briefLoading && (
            <div className="mt-2 text-[12px] text-[var(--ink-muted)]">
              正在汇总今日简报…
            </div>
          )}
          {briefError && <AccessNoticeCard error={briefError} className="mt-2" />}
          {briefData && !briefLoading && (
            <div className="mt-2 flex flex-wrap items-center gap-4 text-[12.5px]">
              <div>
                <span className="text-[var(--ink-muted)]">待我审批：</span>
                <span className="font-mono-code font-semibold text-[var(--ink-primary)]">
                  {briefData.pending_approvals}
                  {briefData.pending_approvals_capped ? "+" : ""}
                </span>
              </div>
              <div>
                <span className="text-[var(--ink-muted)]">今日会议：</span>
                <span className="font-mono-code font-semibold text-[var(--ink-primary)]">
                  {briefData.meetings}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                {Object.entries(briefData.submitted_current_states).map(
                  ([k, count]) => (
                    <span
                      key={k}
                      className="inline-flex items-center gap-1 font-mono-code text-[11.5px]"
                    >
                      <StatusBadge status={k} compact />
                      <span>{count}</span>
                    </span>
                  ),
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Role-Separated Quick-Prompt Chips Bar */}
      {quickPromptOptions.length > 0 && (
        <div
          data-testid="assistant-quick-prompts"
          className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-[var(--hairline)] bg-[var(--bg-subtle)] px-4 py-2"
        >
          <span className="shrink-0 font-mono-code text-[10.5px] uppercase tracking-[0.04em] text-[var(--ink-muted)] mr-1">
            快捷指令
          </span>
          {quickPromptOptions.map((opt) => (
            <button
              key={opt.prompt}
              type="button"
              disabled={hasPendingTurn}
              data-testid={`quick-prompt-${opt.domain}`}
              onClick={() => void executeTurn(opt.prompt)}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-2.5 py-1 text-[12px] text-[var(--ink-primary)] hover:border-[var(--accent-border)] hover:bg-[var(--accent-wash)] transition-colors duration-[120ms] cursor-pointer disabled:opacity-50"
            >
              <span className="font-mono-code text-[10px] text-[var(--accent)]">
                {opt.domain}
              </span>
              <span>{opt.label}</span>
            </button>
          ))}
        </div>
      )}

      {/* Main Scrollable Stream: History + Live Conversation */}
      <div
        data-testid="assistant-feed"
        className="min-h-0 flex-1 overflow-auto bg-[var(--bg-canvas)] px-4 py-4 sm:px-6"
      >
        <div className="mx-auto max-w-[780px] space-y-4">
          {/* Paginated Agent History Section (ID + Timestamp + On-Demand Re-auth Expand) */}
          <section
            data-testid="assistant-history-section"
            className="rounded-[6px] border border-[var(--hairline)] bg-[var(--bg-sheet)]"
          >
            <button
              type="button"
              data-testid="assistant-history-toggle"
              onClick={() => {
                historyToggledByUserRef.current = true;
                setHistoryOpen((v) => !v);
              }}
              aria-expanded={historyOpen}
              className="flex w-full items-center justify-between px-3.5 py-2.5 text-left hover:bg-[var(--bg-subtle)] transition-colors duration-[120ms] cursor-pointer"
            >
              <div className="flex items-center gap-2">
                <Clock className="h-3.5 w-3.5 text-[var(--ink-muted)]" strokeWidth={1.75} />
                <span className="text-[12.5px] font-medium text-[var(--ink-primary)]">
                  历史活动记录
                </span>
                <span className="font-mono-code text-[11px] text-[var(--ink-muted)]">
                  ({historyItems.length}
                  {historyNext ? "+" : ""})
                </span>
                <span className="hidden sm:inline text-[11.5px] text-[var(--ink-muted)]">
                  · 仅保留安全索引，展开时实时核验当前权限
                </span>
              </div>
              {historyOpen ? (
                <ChevronUp className="h-4 w-4 text-[var(--ink-muted)]" />
              ) : (
                <ChevronDown className="h-4 w-4 text-[var(--ink-muted)]" />
              )}
            </button>

            {historyOpen && (
              <div className="border-t border-[var(--hairline)] px-3.5 py-3 space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-[11.5px] text-[var(--ink-muted)]">
                    若权限已被撤销，重新核验将立即清除已展示字段。
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void loadHistory(null)}
                    disabled={historyLoading}
                  >
                    <RefreshCw
                      className={[
                        "h-3 w-3",
                        historyLoading ? "animate-spin" : "",
                      ].join(" ")}
                    />
                    <span>刷新索引</span>
                  </Button>
                </div>

                {historyError && (
                  <AccessNoticeCard
                    error={historyError}
                    onRetry={() => void loadHistory(null)}
                  />
                )}

                {!historyLoading && !historyError && historyItems.length === 0 && (
                  <div className="py-4 text-center text-[12px] text-[var(--ink-muted)]">
                    当前账号暂无持久化的历史活动记录。
                  </div>
                )}

                {historyItems.length > 0 && (
                  <div className="max-h-[300px] overflow-auto divide-y divide-[var(--hairline)] rounded-[4px] border border-[var(--hairline)]">
                    {historyItems.map((item) => {
                      const expanded = expandedHistory[item.id];
                      return (
                        <div
                          key={item.id}
                          data-testid={`history-item-${item.id}`}
                          className="p-3 space-y-2.5"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="min-w-0 flex flex-wrap items-center gap-2">
                              <span className="font-mono-code text-[12px] font-semibold text-[var(--ink-primary)]">
                                {item.id}
                              </span>
                              <span className="rounded-[2px] border border-[var(--hairline)] bg-[var(--bg-subtle)] px-1.5 py-0.5 font-mono-code text-[10.5px] text-[var(--ink-muted)]">
                                WORKBENCH_TURN
                              </span>
                              <span className="font-mono-code text-[11px] text-[var(--ink-muted)]">
                                {formatUnixTime(item.started_at)}
                              </span>
                            </div>

                            <Button
                              size="sm"
                              variant="secondary"
                              loading={Boolean(expanded?.loading)}
                              data-testid={`history-expand-${item.id}`}
                              onClick={() => void handleExpandHistory(item.id)}
                            >
                              <ShieldCheck className="h-3.5 w-3.5" strokeWidth={1.75} />
                              <span>
                                {expanded?.result || expanded?.error
                                  ? "重新核验"
                                  : "重新核验并展开"}
                              </span>
                            </Button>
                          </div>

                          {expanded && !expanded.loading && expanded.error && (
                            <AccessNoticeCard
                              error={expanded.error}
                              variant={
                                expanded.error.status === 404
                                  ? "RECORD_UNAVAILABLE"
                                  : expanded.error.code === "ACCESS_CHANGED"
                                    ? "ACCESS_CHANGED"
                                    : undefined
                              }
                            />
                          )}

                          {expanded && !expanded.loading && expanded.result && (
                            <TurnResultCard
                              result={expanded.result}
                              capabilities={capabilities}
                              timestamp={item.started_at}
                              onSelectClarification={(prompt) =>
                                void executeTurn(prompt)
                              }
                              onInspectObject={handleInspectObject}
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {historyNext && (
                  <div className="pt-1">
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={historyLoadingMore}
                      data-testid="history-load-more"
                      onClick={() => void loadHistory(historyNext)}
                      className="w-full"
                    >
                      {historyLoadingMore ? "加载中…" : "加载更多历史记录"}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </section>

          {/* Empty State Onboarding when no active session turns yet */}
          {turns.length === 0 && (
            <div className="rounded-[6px] border border-[var(--hairline)] bg-[var(--bg-sheet)] p-5">
              <div className="font-mono-code text-[11px] uppercase tracking-[0.04em] text-[var(--ink-muted)]">
                PERSONAL WORKBENCH AGENT
              </div>
              <h3 className="mt-1 text-[15px] font-semibold text-[var(--ink-primary)]">
                向 {agentDisplayName} 发起受控业务查询或草稿准备
              </h3>
              <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--ink-muted)]">
                所有指令均在服务端按您当前的租户、仓库与模块授权实时执行；涉及写入的动作仅生成待审批提案，不会绕过独立审批流程。
              </p>
              {quickPromptOptions.length === 0 && (
                <p className="mt-2 text-[12.5px] text-[var(--status-amber-ink)]">
                  当前账号暂未配置可用的工作台工具，请联系权限管理员开通模块访问范围。
                </p>
              )}
            </div>
          )}

          {/* Active Session Turn Feed */}
          {turns.map((turn) => (
            <div
              key={turn.id}
              data-testid={`assistant-turn-${turn.clientId}`}
              className="space-y-2.5"
            >
              {/* User Request Bubble */}
              <div className="flex justify-end">
                <div className="max-w-[85%] rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-plane)] px-3.5 py-2 text-[13.5px] text-[var(--ink-primary)] whitespace-pre-wrap break-words">
                  {turn.userText}
                </div>
              </div>

              {/* Assistant Response Row */}
              <div className="max-w-[96%]">
                {turn.status === "pending" && (
                  <div
                    data-testid="assistant-turn-pending"
                    className="inline-flex items-center rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-sheet)] px-3.5 py-2.5"
                  >
                    <StatePulseBeacon
                      state="processing_turn"
                      detail={
                        turn.waitingRetryAfter
                          ? `Retry-After ${turn.waitingRetryAfter}s`
                          : undefined
                      }
                    />
                  </div>
                )}

                {turn.status === "done" && turn.result && (
                  <TurnResultCard
                    result={turn.result}
                    capabilities={capabilities}
                    timestamp={turn.createdAt}
                    onSelectClarification={(prompt) => void executeTurn(prompt)}
                    onInspectObject={handleInspectObject}
                  />
                )}

                {turn.status === "error" && turn.error && (
                  <div data-testid="assistant-turn-error">
                    <AccessNoticeCard
                      error={turn.error}
                      authorizedWarehouses={
                        turn.error.status === 403
                          ? actor?.warehouses
                          : undefined
                      }
                    />
                    {turn.sourceKind === "turn" &&
                      (turn.error.status >= 429 ||
                        turn.error.status === 409 ||
                        turn.error.code === "TURN_IN_PROGRESS") && (
                        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--ink-muted)]">
                          <span className="font-mono-code">
                            重试将复用同一 client_id: {turn.clientId}
                          </span>
                          <Button
                            size="sm"
                            variant="secondary"
                            data-testid="turn-retry-btn"
                            onClick={() =>
                              void executeTurn(turn.userText, {
                                id: turn.id,
                                clientId: turn.clientId,
                              })
                            }
                          >
                            重新提交该请求
                          </Button>
                        </div>
                      )}
                  </div>
                )}
              </div>
            </div>
          ))}

          <div ref={feedEndRef} />
        </div>
      </div>

      {/* Collapsible Structured Tool Call Bar (/v1/workbench/calls) */}
      {structuredOpen && availableTools.length > 0 && (
        <form
          onSubmit={(e) => void handleStructuredSubmit(e)}
          data-testid="assistant-structured-bar"
          className="shrink-0 border-t border-[var(--hairline)] bg-[var(--bg-subtle)] px-4 py-3"
        >
          <div className="mx-auto flex max-w-[780px] flex-wrap items-end gap-2.5">
            <div className="min-w-[160px] flex-1">
              <label className="block text-[11px] font-medium text-[var(--ink-muted)]">
                已授权业务工具
              </label>
              <select
                value={selectedToolId}
                onChange={(e) => setSelectedToolId(e.target.value)}
                className="mt-1 h-8 w-full rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-2 text-[12.5px] text-[var(--ink-primary)]"
              >
                {availableTools.map((tool) => (
                  <option key={tool.id} value={tool.id}>
                    {tool.id} ({tool.mode === "proposal" ? "提案" : "只读"})
                  </option>
                ))}
              </select>
            </div>

            {selectedToolMeta && selectedToolMeta.warehouses.length > 0 && (
              <div className="w-[104px]">
                <label className="block text-[11px] font-medium text-[var(--ink-muted)]">
                  仓库站点
                </label>
                <select
                  value={toolWarehouse}
                  onChange={(e) => setToolWarehouse(e.target.value)}
                  className="mt-1 h-8 w-full rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-2 font-mono-code text-[12.5px] text-[var(--ink-primary)]"
                >
                  {selectedToolMeta.warehouses.map((wh) => (
                    <option key={wh} value={wh}>
                      {wh}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {(selectedToolId === "shipment.read" ||
              selectedToolId === "shipment.reschedule" ||
              selectedToolId === "finance.invoice.read" ||
              selectedToolId === "order.draft.prepare") && (
              <div className="min-w-[150px] flex-1">
                <label className="block text-[11px] font-medium text-[var(--ink-muted)]">
                  {selectedToolId === "finance.invoice.read"
                    ? "发票编号"
                    : selectedToolId === "order.draft.prepare"
                      ? "进件编号 (intake_id)"
                      : "运单编号"}
                </label>
                <input
                  type="text"
                  value={toolRefId}
                  onChange={(e) => setToolRefId(e.target.value)}
                  placeholder={
                    selectedToolId === "finance.invoice.read"
                      ? "INV-100"
                      : selectedToolId === "order.draft.prepare"
                        ? "输入进件 ID"
                        : toolWarehouse === "HK02"
                          ? "SHP-2001"
                          : "SHP-1001"
                  }
                  className="mt-1 h-8 w-full rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-2.5 font-mono-code text-[12.5px] text-[var(--ink-primary)]"
                />
              </div>
            )}

            {selectedToolId === "shipment.reschedule" && (
              <div className="w-[150px]">
                <label className="block text-[11px] font-medium text-[var(--ink-muted)]">
                  目标交付日期
                </label>
                <input
                  type="date"
                  value={toolDeliveryDate}
                  onChange={(e) => setToolDeliveryDate(e.target.value)}
                  className="mt-1 h-8 w-full rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-2 font-mono-code text-[12.5px] text-[var(--ink-primary)]"
                />
              </div>
            )}

            <Button
              type="submit"
              size="sm"
              variant="primary"
              loading={toolSubmitting}
              className="h-8"
            >
              执行调用
            </Button>
          </div>
        </form>
      )}

      {/* Bottom Composer */}
      <footer className="shrink-0 border-t border-[var(--hairline)] bg-[var(--bg-sheet)] px-4 py-3">
        <div className="mx-auto max-w-[780px]">
          <div className="flex items-end gap-2">
            <textarea
              data-composer-input
              data-testid="assistant-composer-input"
              rows={2}
              maxLength={500}
              value={composerText}
              onChange={(e) => updateComposer(e.target.value)}
              onKeyDown={handleComposerKeyDown}
              placeholder="输入业务指令，例如：查看运单 SHP-1001 仓库 HK01 / 查看发票 INV-100 仓库 HK01（Enter 发送，Shift+Enter 换行）"
              className="min-h-[44px] max-h-[140px] flex-1 resize-y rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-3 py-2 text-[13.5px] leading-relaxed text-[var(--ink-primary)] placeholder:text-[var(--ink-faint)] focus:border-[var(--accent)] focus:outline-none"
            />
            <Button
              type="button"
              variant="primary"
              size="md"
              data-testid="assistant-send-btn"
              disabled={hasPendingTurn || composerText.trim().length === 0}
              onClick={handleSendComposer}
              className="h-[44px] shrink-0 px-4"
            >
              <Send className="h-4 w-4" strokeWidth={1.75} />
              <span>发送</span>
            </Button>
          </div>
          <div className="mt-1.5 flex items-center justify-between text-[11px] text-[var(--ink-muted)]">
            <span>
              个人 Agent 对话与员工房间严格隔离；草稿仅保留于当前会话内存。
            </span>
            <span className="font-mono-code tabular-nums">
              {composerText.length}/500
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
