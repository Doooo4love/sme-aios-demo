"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Popover } from "radix-ui";
import {
  ArrowUp,
  ArrowUpRight,
  Calendar,
  CalendarDays,
  ChevronLeft,
  Clock,
  FilePlus2,
  LayoutGrid,
  Mail,
  Package,
  Plus,
  Receipt,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Video,
  Warehouse,
  X,
} from "lucide-react";
import {
  callWorkbenchTool,
  generateClientId,
  generateIdempotencyKey,
  getAuthGeneration,
  isApiError,
  isStaleAuthError,
  parseNaturalLanguageZoomBooking,
  submitWorkbenchTurn,
  type ApiError,
} from "@/lib/api-client";
import { formatProposalAction, formatUnixTime } from "@/lib/format";
import { useSession } from "@/lib/session-context";
import { useWorkbench } from "@/lib/workbench-context";
import { BriefProgressChain, Interactive3DCard } from "@/components/kinetic";
import { AccessNoticeCard } from "@/components/ui/AccessNoticeCard";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
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
import { IMessageBubbleTail } from "@/features/inbox/bubble-group";
import {
  TurnResultCard,
  buildCapabilityPromptOptions,
} from "@/features/inbox/TurnResultCard";
import { ZoomBookingCard } from "@/features/inbox/ZoomBookingCard";
import type {
  DrawerObjectSelection,
  HistoryCursor,
  HistoryListItem,
  Proposal,
  WorkbenchToolCall,
} from "@/lib/types";

const MAX_IN_PROGRESS_POLLS = 8;

function isZoomMeetingIntent(input: string): boolean {
  const text = input.trim();
  if (!text) return false;
  if (/\bzoom\b/i.test(text)) return true;
  if (
    /(?:预约|预定|订一个|订个|安排|约个|约一个|发起|约会|订会|开一个|开个).{0,18}(?:会议|会|评审会|对齐会|碰头会|同步会|讨论会|电话会)/.test(
      text,
    )
  ) {
    return true;
  }
  if (
    /(?:明天|后天|今天|下周|周[一二三四五六日天]|星期[一二三四五六日天]|\d{1,2}点).{0,24}(?:开会|评审会|对齐会|会议)/.test(
      text,
    )
  ) {
    return true;
  }
  if (
    /\b(?:book|schedule|set\s+up|arrange)\b.{0,28}\b(?:meeting|call|sync|review|zoom)\b/i.test(
      text,
    )
  ) {
    return true;
  }
  return false;
}

function getBrowserTimezone(): { timezone: string; tzOffsetMinutes: number } {
  try {
    const timezone =
      Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
    const tzOffsetMinutes = -new Date().getTimezoneOffset();
    return { timezone, tzOffsetMinutes };
  } catch {
    return { timezone: "Asia/Shanghai", tzOffsetMinutes: 480 };
  }
}

function getSuggestionIcon(domain: string) {
  switch (domain) {
    case "财务":
      return Receipt;
    case "运单":
      return Package;
    case "经营":
      return Warehouse;
    case "邮箱":
      return Mail;
    default:
      return Sparkles;
  }
}

export function AssistantWorkspace() {
  const {
    status,
    actor,
    capabilities,
    agentProfile,
    agentAvatarVersion,
    authGeneration,
    canCreateOrder,
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

  const [memoryTick, setMemoryTick] = useState(0);
  useEffect(
    () => subscribeAssistantMemory(() => setMemoryTick((t) => t + 1)),
    [],
  );

  const { turns, expandedHistory } = useMemo(() => {
    void memoryTick;
    return getAssistantMemory(authGeneration);
  }, [authGeneration, memoryTick]);

  const [composerText, setComposerText] = useState<string>(() =>
    getDraft("assistant"),
  );
  useEffect(() => {
    setComposerText(getDraft("assistant"));
  }, [authGeneration, getDraft]);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const autoResizeTextarea = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(160, Math.max(28, el.scrollHeight))}px`;
  }, []);

  useEffect(() => {
    autoResizeTextarea(textareaRef.current);
  }, [composerText, autoResizeTextarea]);

  const updateComposer = useCallback(
    (next: string) => {
      setComposerText(next);
      setDraft("assistant", next);
    },
    [setDraft],
  );

  // + Add Context Popover & Modals
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [historyModalOpen, setHistoryModalOpen] = useState(false);
  const [structuredModalOpen, setStructuredModalOpen] = useState(false);
  const [zoomBarOpen, setZoomBarOpen] = useState(false);
  const [zoomNlText, setZoomNlText] = useState("");

  // Paginated Agent History
  const [historyItems, setHistoryItems] = useState<HistoryListItem[]>([]);
  const [historyNext, setHistoryNext] = useState<HistoryCursor | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
  const [historyError, setHistoryError] = useState<ApiError | null>(null);

  // Form-based deterministic tool modal (/v1/workbench/calls)
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

  useEffect(() => {
    clearAllPollTimers();
    setContextMenuOpen(false);
    setHistoryModalOpen(false);
    setStructuredModalOpen(false);
    setZoomBarOpen(false);
    setZoomNlText("");
    setHistoryItems([]);
    setHistoryNext(null);
    setHistoryError(null);
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

  const executeZoomBookingParse = useCallback(async (utterance: string) => {
    const trimmed = utterance.trim();
    if (!trimmed) return;
    const startGen = getAuthGeneration();
    const entryId = generateClientId("zmturn");

    const newEntry: AssistantTurnEntry = {
      id: entryId,
      clientId: entryId,
      userText: trimmed,
      createdAt: Math.floor(Date.now() / 1000),
      status: "pending",
      sourceKind: "zoom_booking",
      zoomBooking: { phase: "parsing" },
    };
    setAssistantTurns(startGen, (prev) => [...prev, newEntry]);
    requestAnimationFrame(() => {
      feedEndRef.current?.scrollIntoView({ behavior: "smooth" });
    });

    try {
      const { timezone, tzOffsetMinutes } = getBrowserTimezone();
      const preview = await parseNaturalLanguageZoomBooking({
        utterance: trimmed,
        timezone,
        tz_offset_minutes: tzOffsetMinutes,
      });
      if (startGen !== getAuthGeneration()) return;
      setAssistantTurns(startGen, (prev) =>
        prev.map((item) =>
          item.id === entryId
            ? {
                ...item,
                status: "done",
                zoomBooking: { phase: "preview", preview },
              }
            : item,
        ),
      );
      requestAnimationFrame(() => {
        feedEndRef.current?.scrollIntoView({ behavior: "smooth" });
      });
    } catch (err) {
      if (isStaleAuthError(err) || startGen !== getAuthGeneration()) return;
      const msg = isApiError(err)
        ? err.message
        : "解析自然语言会议请求失败，请检查时间或参会同事描述后重试。";
      setAssistantTurns(startGen, (prev) =>
        prev.map((item) =>
          item.id === entryId
            ? {
                ...item,
                status: "error",
                zoomBooking: { phase: "error", errorMessage: msg },
              }
            : item,
        ),
      );
    }
  }, []);

  const executeTurn = useCallback(
    async (text: string, existingEntry?: { id: string; clientId: string }) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      if (!existingEntry && isZoomMeetingIntent(trimmed)) {
        await executeZoomBookingParse(trimmed);
        return;
      }

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
    [
      clearSelectedObject,
      executeZoomBookingParse,
      handleAccessChanged,
      loadHistory,
      scheduleInProgressPoll,
    ],
  );

  const handleInsertTodayBrief = useCallback(async () => {
    setContextMenuOpen(false);
    const startGen = getAuthGeneration();
    const entryId = generateClientId("brief");

    setAssistantTurns(startGen, (prev) => [
      ...prev,
      {
        id: entryId,
        clientId: entryId,
        userText: "汇总今日工作简报",
        createdAt: Math.floor(Date.now() / 1000),
        status: "pending",
        sourceKind: "brief_card",
      },
    ]);
    requestAnimationFrame(() => {
      feedEndRef.current?.scrollIntoView({ behavior: "smooth" });
    });

    try {
      const data = await fetchWorkbenchBriefForRange(1);
      if (startGen !== getAuthGeneration()) return;
      setAssistantTurns(startGen, (prev) =>
        prev.map((item) =>
          item.id === entryId ? { ...item, status: "done", brief: data } : item,
        ),
      );
    } catch (err) {
      if (isStaleAuthError(err) || startGen !== getAuthGeneration()) return;
      if (isApiError(err)) {
        if (err.code === "ACCESS_CHANGED") {
          void handleAccessChanged();
        }
        setAssistantTurns(startGen, (prev) =>
          prev.map((item) =>
            item.id === entryId ? { ...item, status: "error", error: err } : item,
          ),
        );
      }
    }
  }, [handleAccessChanged]);

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

  const handleStructuredSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (toolSubmitting || !selectedToolId) return;

    const chosen = availableTools.find((t) => t.id === selectedToolId);
    if (!chosen) return;

    let payload: WorkbenchToolCall;
    let labelText = "";

    if (chosen.id === "mail.inbox.read") {
      payload = { tool: "mail.inbox.read", limit: 10 };
      labelText = "查看我的收件箱";
    } else if (chosen.id === "decision.warehouse.summary") {
      if (!toolWarehouse) return;
      payload = { tool: "decision.warehouse.summary", warehouse: toolWarehouse };
      labelText = `仓库汇总 ${toolWarehouse}`;
    } else if (chosen.id === "finance.invoice.read") {
      if (!toolWarehouse || !toolRefId.trim()) return;
      payload = {
        tool: "finance.invoice.read",
        warehouse: toolWarehouse,
        invoice_id: toolRefId.trim(),
      };
      labelText = `查看发票 ${toolRefId.trim()} (${toolWarehouse})`;
    } else if (chosen.id === "shipment.read") {
      if (!toolWarehouse || !toolRefId.trim()) return;
      payload = {
        tool: "shipment.read",
        warehouse: toolWarehouse,
        shipment_id: toolRefId.trim(),
      };
      labelText = `查看运单 ${toolRefId.trim()} (${toolWarehouse})`;
    } else if (chosen.id === "shipment.reschedule") {
      if (!toolWarehouse || !toolRefId.trim() || !toolDeliveryDate) return;
      payload = {
        tool: "shipment.reschedule",
        warehouse: toolWarehouse,
        shipment_id: toolRefId.trim(),
        delivery_date: toolDeliveryDate,
      };
      labelText = `运单改期 ${toolRefId.trim()} -> ${toolDeliveryDate}`;
    } else if (chosen.id === "order.draft.prepare") {
      if (!toolWarehouse || !toolRefId.trim()) return;
      payload = {
        tool: "order.draft.prepare",
        warehouse: toolWarehouse,
        intake_id: toolRefId.trim(),
      };
      labelText = `准备订单草稿 ${toolRefId.trim()} (${toolWarehouse})`;
    } else {
      return;
    }

    const startGen = getAuthGeneration();
    const entryId = generateClientId("call");
    const idempotencyKey =
      chosen.mode === "proposal" ? generateIdempotencyKey("call") : undefined;

    setToolSubmitting(true);
    setStructuredModalOpen(false);
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
  // Strict max 3 consistent suggestion chips on empty state (2 capability + 1 Zoom)
  const emptySuggestions = useMemo(
    () => quickPromptOptions.slice(0, 2),
    [quickPromptOptions],
  );
  const selectedToolMeta = availableTools.find((t) => t.id === selectedToolId);
  const hasPendingTurn = turns.some((t) => t.status === "pending");

  return (
    <div
      data-testid="assistant-workspace"
      className="flex h-full min-h-0 flex-col bg-[var(--bg-surface)]"
    >
      {/* Pure 60px Frosted Top Header: Agent Avatar + Name (left) & ONLY "工作台" pill (right) */}
      <header className="aios-topbar-glass sticky top-0 z-20 flex h-[var(--header-h)] shrink-0 items-center justify-between gap-3 border-b border-[var(--hairline)] px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-2.5">
          <Link
            href="/inbox"
            aria-label="返回会话列表"
            data-testid="assistant-mobile-back"
            className="inline-flex h-8 items-center gap-0.5 rounded-full pr-2.5 pl-1.5 text-[13.5px] font-medium text-[var(--accent)] hover:bg-[var(--accent-wash)] transition-colors lg:hidden"
          >
            <ChevronLeft className="h-4 w-4" strokeWidth={2.2} />
            <span>返回</span>
          </Link>

          <Link
            href="/settings/agent"
            title={`配置 ${agentDisplayName}`}
            className="group flex min-w-0 items-center gap-2.5 rounded-full py-1 pr-2 hover:bg-[var(--bg-hover)] transition-colors"
          >
            <Avatar
              src={agentAvatarSrc}
              name={agentDisplayName}
              fallbackText="AG"
              size="md"
              kind="agent"
              status="online"
            />
            <div className="min-w-0">
              <h2
                data-testid="assistant-header-name"
                className="truncate text-[15px] font-semibold tracking-[-0.015em] text-[var(--ink-primary)] group-hover:text-[var(--accent)] transition-colors"
              >
                {agentDisplayName}
              </h2>
              <p className="truncate text-[11.5px] text-[var(--ink-muted)]">
                个人工作助手
                {actor?.warehouses.length
                  ? ` · ${actor.warehouses.join(" / ")}`
                  : ""}
              </p>
            </div>
          </Link>
        </div>

        {/* Top-Right ONLY: Sleek "工作台" Pill */}
        <Link
          href="/work"
          data-testid="agent-open-workbench-btn"
          className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full bg-[var(--bg-surface)] px-4 text-[13px] font-medium text-[var(--ink-primary)] shadow-[var(--shadow-subtle)] hover:shadow-[var(--shadow-card)] hover:-translate-y-[0.5px] active:scale-[0.98] transition-all duration-[150ms]"
        >
          <LayoutGrid
            className="h-3.5 w-3.5 text-[var(--accent)]"
            strokeWidth={1.9}
          />
          <span>工作台</span>
          {assignedCount > 0 && (
            <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[var(--accent)] px-1.5 font-mono-code text-[10.5px] font-semibold text-white">
              {assignedCount > 99 ? "99+" : assignedCount}
            </span>
          )}
        </Link>
      </header>

      {/* Main Breathable Conversation Stream */}
      <div
        data-testid="assistant-feed"
        className="min-h-0 flex-1 overflow-y-auto bg-[var(--bg-surface)] px-4 py-6 sm:px-8"
      >
        <div className="mx-auto max-w-[740px] space-y-5">
          {/* Whisper-Quiet Centered History Pill */}
          {historyItems.length > 0 && (
            <div className="flex justify-center">
              <button
                type="button"
                data-testid="assistant-history-toggle"
                onClick={() => {
                  setHistoryModalOpen(true);
                  void loadHistory(null);
                }}
                className="inline-flex items-center gap-1.5 rounded-full bg-[var(--bg-surface-subtle)] px-3.5 py-1.5 text-[12px] font-medium text-[var(--ink-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--ink-primary)] transition-colors cursor-pointer"
              >
                <Clock className="h-3.5 w-3.5" strokeWidth={1.8} />
                <span>
                  历史活动记录 · {historyItems.length}
                  {historyNext ? "+" : ""} 条
                </span>
              </button>
            </div>
          )}

          {/* Serene Unboxed Muse Empty State (max 3 uniform icon chips) */}
          {turns.length === 0 && (
            <div className="flex flex-col items-center justify-center pt-[10vh] pb-6 text-center">
              <Avatar
                src={agentAvatarSrc}
                name={agentDisplayName}
                fallbackText="AG"
                size="xl"
                kind="agent"
                className="shadow-[var(--shadow-card)]"
              />
              <h3 className="mt-5 text-[22px] font-semibold tracking-[-0.025em] text-[var(--ink-primary)]">
                你好，今天想推进哪项业务？
              </h3>
              <p className="mt-2 max-w-[420px] text-[13.5px] leading-relaxed text-[var(--ink-muted)]">
                查询运单与发票、起草业务提案，或用自然语言直接预约 Zoom 会议。
              </p>

              <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
                {emptySuggestions.map((opt) => {
                  const Icon = getSuggestionIcon(opt.domain);
                  return (
                    <button
                      key={opt.prompt}
                      type="button"
                      disabled={hasPendingTurn}
                      onClick={() => void executeTurn(opt.prompt)}
                      className="inline-flex items-center gap-1.5 rounded-full bg-[var(--bg-surface-subtle)] px-4 py-2 text-[13px] font-medium text-[var(--ink-secondary)] hover:bg-[var(--accent-wash)] hover:text-[var(--accent)] transition-colors duration-[150ms] cursor-pointer disabled:opacity-50"
                    >
                      <Icon
                        className="h-3.5 w-3.5 text-[var(--accent)]"
                        strokeWidth={1.85}
                      />
                      <span>{opt.label}</span>
                    </button>
                  );
                })}
                <button
                  type="button"
                  disabled={hasPendingTurn}
                  onClick={() => {
                    setZoomBarOpen(true);
                    setZoomNlText("明天下午3点和manager用Zoom开HK01订单评审会");
                  }}
                  className="inline-flex items-center gap-1.5 rounded-full bg-[var(--bg-surface-subtle)] px-4 py-2 text-[13px] font-medium text-[var(--ink-secondary)] hover:bg-[var(--accent-wash)] hover:text-[var(--accent)] transition-colors duration-[150ms] cursor-pointer disabled:opacity-50"
                >
                  <Video
                    className="h-3.5 w-3.5 text-[var(--accent)]"
                    strokeWidth={1.85}
                  />
                  <span>预约 Zoom 会议</span>
                </button>
              </div>
            </div>
          )}

          {/* Active Conversation Stream */}
          {turns.map((turn) => (
            <div
              key={turn.id}
              data-testid={`assistant-turn-${turn.clientId}`}
              className="space-y-3"
            >
              {/* Outgoing User Bubble — seamless native Cobalt + SVG tail (no corner double-pinch, no shadow seam) */}
              <div className="flex justify-end pr-1.5">
                <div className="imessage-bubble-sent relative max-w-[82%] rounded-lg bg-[var(--accent)] px-4 py-2.5 text-[14.5px] leading-[1.45] text-white whitespace-pre-wrap break-words">
                  {turn.userText}
                  <IMessageBubbleTail side="sent" />
                </div>
              </div>

              {/* Incoming Agent Turn Row — translate-only .aios-row-in (zero rubbery scale) */}
              <div className="aios-row-in flex items-start gap-2.5 max-w-[96%]">
                <Avatar
                  src={agentAvatarSrc}
                  name={agentDisplayName}
                  fallbackText="AG"
                  size="sm"
                  kind="agent"
                  className="mt-0.5 shrink-0"
                />

                <div className="min-w-0 flex-1 space-y-1.5">
                  {turn.sourceKind === "zoom_booking" && turn.zoomBooking && (
                    <ZoomBookingCard
                      parsing={turn.zoomBooking.phase === "parsing"}
                      parseError={turn.zoomBooking.errorMessage}
                      preview={turn.zoomBooking.preview}
                      confirmed={turn.zoomBooking.confirmed}
                      onConfirmed={(confirmed) => {
                        const gen = getAuthGeneration();
                        setAssistantTurns(gen, (prev) =>
                          prev.map((item) =>
                            item.id === turn.id
                              ? {
                                  ...item,
                                  status: "done",
                                  zoomBooking: {
                                    ...item.zoomBooking,
                                    phase: "confirmed",
                                    confirmed,
                                  },
                                }
                              : item,
                          ),
                        );
                      }}
                      onDismiss={() => {
                        const gen = getAuthGeneration();
                        setAssistantTurns(gen, (prev) =>
                          prev.filter((item) => item.id !== turn.id),
                        );
                      }}
                    />
                  )}

                  {turn.sourceKind === "brief_card" && (
                    <>
                      {turn.status === "pending" && (
                        <BriefProgressChain phase="pending" />
                      )}
                      {turn.status === "done" && turn.brief && (
                        <div className="space-y-1.5">
                          <BriefProgressChain
                            phase="done"
                            summaryLabel="已汇总今日工作简报 · 2 步核验"
                            steps={[
                              {
                                id: "brief-scope",
                                label: `已按当前账号权限统计待审单据与会议（${actor?.tenant || "当前租户"}）`,
                                status: "done",
                              },
                              {
                                id: "brief-ts",
                                label: "已生成本地时区实时快照",
                                status: "done",
                                meta: formatUnixTime(turn.brief.as_of),
                              },
                            ]}
                          />
                          <Interactive3DCard
                            maxTilt={2.5}
                            hoverLiftPx={-1}
                            sheenIntensity="subtle"
                            data-testid="assistant-inline-brief"
                            className="overflow-hidden rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)]"
                          >
                            <div className="flex items-center justify-between bg-[var(--bg-surface-tint)] px-4 py-2.5 border-b border-[var(--hairline-subtle)]">
                              <span className="flex items-center gap-2 text-[13px] font-semibold text-[var(--ink-primary)]">
                                <CalendarDays className="h-4 w-4 text-[var(--accent)]" />
                                <span>今日工作简报</span>
                              </span>
                              <span className="font-mono-code text-[11px] text-[var(--ink-muted)] tabular-nums">
                                {formatUnixTime(turn.brief.as_of)}
                              </span>
                            </div>
                            <div className="p-4 space-y-3">
                              <div className="grid grid-cols-2 gap-2.5">
                                <div className="rounded-tile bg-[var(--bg-surface-tint)] p-3">
                                  <div className="text-[11.5px] text-[var(--ink-muted)]">
                                    待我审批
                                  </div>
                                  <div className="mt-0.5 font-mono-code text-[22px] font-semibold text-[var(--ink-primary)] tabular-nums">
                                    {turn.brief.pending_approvals}
                                    {turn.brief.pending_approvals_capped ? "+" : ""}
                                  </div>
                                </div>
                                <div className="rounded-tile bg-[var(--bg-surface-tint)] p-3">
                                  <div className="text-[11.5px] text-[var(--ink-muted)]">
                                    今日会议
                                  </div>
                                  <div className="mt-0.5 font-mono-code text-[22px] font-semibold text-[var(--ink-primary)] tabular-nums">
                                    {turn.brief.meetings}
                                  </div>
                                </div>
                              </div>

                              {Object.keys(turn.brief.submitted_current_states)
                                .length > 0 && (
                                <div className="flex flex-wrap items-center gap-1.5">
                                  {Object.entries(
                                    turn.brief.submitted_current_states,
                                  ).map(([k, count]) => (
                                    <span
                                      key={k}
                                      className="inline-flex items-center gap-1.5 rounded-full bg-[var(--bg-surface-tint)] px-2.5 py-1 text-[11.5px]"
                                    >
                                      <StatusBadge status={k} compact />
                                      <span className="font-mono-code font-semibold text-[var(--ink-primary)] tabular-nums">
                                        {count}
                                      </span>
                                    </span>
                                  ))}
                                </div>
                              )}

                              <div className="flex items-center justify-end gap-2 border-t border-[var(--hairline-subtle)] pt-3">
                                <Link
                                  href="/calendar"
                                  className="inline-flex h-8 items-center gap-1 rounded-full bg-[var(--bg-surface-subtle)] px-3 text-[12px] font-medium text-[var(--ink-primary)] hover:bg-[var(--bg-hover)]"
                                >
                                  <Calendar className="h-3.5 w-3.5 text-[var(--accent)]" />
                                  <span>打开日历</span>
                                </Link>
                                <Link
                                  href="/work"
                                  className="inline-flex h-8 items-center gap-1 rounded-full bg-[var(--accent)] px-3.5 text-[12px] font-medium text-white hover:bg-[var(--accent-hover)]"
                                >
                                  <span>进入工作台</span>
                                  <ArrowUpRight className="h-3.5 w-3.5" />
                                </Link>
                              </div>
                            </div>
                          </Interactive3DCard>
                        </div>
                      )}
                      {turn.status === "error" && turn.error && (
                        <AccessNoticeCard error={turn.error} />
                      )}
                    </>
                  )}

                  {(turn.sourceKind === "turn" ||
                    turn.sourceKind === "tool_call") && (
                    <>
                      {turn.status === "pending" && (
                        <BriefProgressChain
                          phase="pending"
                          retryAfter={turn.waitingRetryAfter}
                        />
                      )}

                      {turn.status === "done" && turn.result && (
                        <>
                          <BriefProgressChain
                            phase="done"
                            actor={actor}
                            result={turn.result}
                          />
                          <TurnResultCard
                            result={turn.result}
                            capabilities={capabilities}
                            timestamp={turn.createdAt}
                            onSelectClarification={(prompt) =>
                              void executeTurn(prompt)
                            }
                            onInspectObject={handleInspectObject}
                          />
                        </>
                      )}

                      {turn.status === "error" && turn.error && (
                        <div
                          data-testid="assistant-turn-error"
                          className="space-y-1.5"
                        >
                          <BriefProgressChain
                            phase="error"
                            actor={actor}
                            error={turn.error}
                          />
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
                              <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-[11.5px] text-[var(--ink-muted)]">
                                <span className="font-mono-code">
                                  重试将复用幂等键 {turn.clientId}
                                </span>
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  pill
                                  data-testid="turn-retry-btn"
                                  onClick={() =>
                                    void executeTurn(turn.userText, {
                                      id: turn.id,
                                      clientId: turn.clientId,
                                    })
                                  }
                                >
                                  重新提交
                                </Button>
                              </div>
                            )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}

          <div ref={feedEndRef} />
        </div>
      </div>

      {/* Muse-Exact Floating Bottom Composer Area */}
      <footer className="shrink-0 bg-gradient-to-t from-[var(--bg-surface)] via-[var(--bg-surface)] to-transparent px-4 pt-2 pb-4 sm:px-8 sm:pb-5">
        <div className="mx-auto max-w-[740px] space-y-2.5">
          {zoomBarOpen && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const q = zoomNlText.trim();
                if (!q) return;
                setZoomBarOpen(false);
                setZoomNlText("");
                void executeZoomBookingParse(q);
              }}
              className="flex flex-wrap items-center gap-2 rounded-card bg-[var(--bg-surface)] p-2.5 pl-3.5 shadow-[var(--shadow-card)] ring-1 ring-[var(--accent-border)]"
            >
              <Video
                className="h-4 w-4 shrink-0 text-[var(--accent)]"
                strokeWidth={1.9}
              />
              <input
                type="text"
                autoFocus
                value={zoomNlText}
                onChange={(e) => setZoomNlText(e.target.value)}
                data-testid="zoom-nl-input"
                placeholder="例如：明天下午3点和manager用Zoom开HK01订单评审会"
                className="min-w-[200px] flex-1 bg-transparent text-[13.5px] text-[var(--ink-primary)] placeholder:text-[var(--ink-faint)] focus:outline-none"
              />
              <Button
                type="submit"
                size="sm"
                variant="primary"
                pill
                disabled={!zoomNlText.trim()}
              >
                解析预览
              </Button>
              <button
                type="button"
                onClick={() => setZoomBarOpen(false)}
                aria-label="关闭 Zoom 预约栏"
                className="inline-flex h-7 w-7 items-center justify-center rounded-full text-[var(--ink-muted)] hover:bg-[var(--bg-hover)] cursor-pointer"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </form>
          )}

          {/* Muse Floating Capsule Composer (STRICTLY TWO CONTROLS: + 添加上下文 & ↑ Send) */}
          <div className="rounded-xl bg-[var(--bg-surface)] shadow-[var(--shadow-composer)] focus-within:shadow-[var(--shadow-composer-focus)] transition-shadow duration-[200ms]">
            <div className="px-4 pt-3.5 pb-1.5">
              <textarea
                ref={textareaRef}
                data-composer-input
                data-testid="assistant-composer-input"
                rows={1}
                maxLength={500}
                value={composerText}
                onChange={(e) => updateComposer(e.target.value)}
                onKeyDown={handleComposerKeyDown}
                placeholder={`给 ${agentDisplayName} 发消息…`}
                className="block max-h-[160px] min-h-[28px] w-full resize-none bg-transparent text-[14.5px] leading-[1.5] text-[var(--ink-primary)] placeholder:text-[var(--ink-faint)] focus:outline-none"
              />
            </div>

            <div className="flex items-center justify-between gap-2 px-3 pb-2.5 pt-1">
              <Popover.Root
                open={contextMenuOpen}
                onOpenChange={setContextMenuOpen}
              >
                <Popover.Trigger asChild>
                  <button
                    type="button"
                    data-testid="assistant-add-context-btn"
                    aria-label="添加上下文"
                    className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--ink-primary)] transition-colors duration-[140ms] cursor-pointer"
                  >
                    <Plus className="h-4 w-4" strokeWidth={2} />
                    <span>添加上下文</span>
                  </button>
                </Popover.Trigger>

                <Popover.Portal>
                  <Popover.Content
                    side="top"
                    align="start"
                    sideOffset={10}
                    className="z-50 w-[296px] rounded-card bg-[var(--bg-surface)] p-2 shadow-[var(--shadow-popover)] focus:outline-none"
                  >
                    <div className="space-y-0.5">
                      {canCreateOrder && (
                        <Link
                          href="/orders/new"
                          onClick={() => setContextMenuOpen(false)}
                          className="flex items-center gap-2.5 rounded-sm px-3 py-2 text-[13px] font-medium text-[var(--ink-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                        >
                          <FilePlus2
                            className="h-4 w-4 text-[var(--accent)]"
                            strokeWidth={1.85}
                          />
                          <span>新建订单 / 上传单据</span>
                        </Link>
                      )}

                      <button
                        type="button"
                        data-testid="context-menu-brief"
                        onClick={() => void handleInsertTodayBrief()}
                        className="flex w-full items-center gap-2.5 rounded-sm px-3 py-2 text-left text-[13px] font-medium text-[var(--ink-primary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
                      >
                        <CalendarDays
                          className="h-4 w-4 text-[var(--accent)]"
                          strokeWidth={1.85}
                        />
                        <span>插入今日简报</span>
                      </button>

                      <button
                        type="button"
                        data-testid="context-menu-history"
                        onClick={() => {
                          setContextMenuOpen(false);
                          setHistoryModalOpen(true);
                          void loadHistory(null);
                        }}
                        className="flex w-full items-center gap-2.5 rounded-sm px-3 py-2 text-left text-[13px] font-medium text-[var(--ink-primary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
                      >
                        <Clock
                          className="h-4 w-4 text-[var(--ink-muted)]"
                          strokeWidth={1.85}
                        />
                        <span>历史活动记录</span>
                      </button>

                      <button
                        type="button"
                        data-testid="context-menu-zoom"
                        onClick={() => {
                          setContextMenuOpen(false);
                          setZoomBarOpen(true);
                        }}
                        className="flex w-full items-center gap-2.5 rounded-sm px-3 py-2 text-left text-[13px] font-medium text-[var(--ink-primary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
                      >
                        <Video
                          className="h-4 w-4 text-[var(--accent)]"
                          strokeWidth={1.85}
                        />
                        <span>预约 Zoom 会议</span>
                      </button>

                      {availableTools.length > 0 && (
                        <button
                          type="button"
                          onClick={() => {
                            setContextMenuOpen(false);
                            setStructuredModalOpen(true);
                          }}
                          className="flex w-full items-center gap-2.5 rounded-sm px-3 py-2 text-left text-[13px] font-medium text-[var(--ink-primary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
                        >
                          <SlidersHorizontal
                            className="h-4 w-4 text-[var(--ink-muted)]"
                            strokeWidth={1.85}
                          />
                          <span>按表单查询</span>
                        </button>
                      )}
                    </div>

                    {quickPromptOptions.length > 0 && (
                      <div className="mt-2 border-t border-[var(--hairline)] pt-2">
                        <div className="px-3 pb-1.5 text-[11px] font-medium text-[var(--ink-muted)]">
                          常用
                        </div>
                        <div className="space-y-0.5">
                          {quickPromptOptions.map((opt) => (
                            <button
                              key={opt.prompt}
                              type="button"
                              disabled={hasPendingTurn}
                              onClick={() => {
                                setContextMenuOpen(false);
                                void executeTurn(opt.prompt);
                              }}
                              className="flex w-full items-center justify-between gap-2 rounded-sm px-3 py-1.5 text-left text-[12.5px] text-[var(--ink-secondary)] hover:bg-[var(--accent-wash)] hover:text-[var(--accent)] transition-colors cursor-pointer disabled:opacity-50"
                            >
                              <span className="truncate">{opt.label}</span>
                              <span className="shrink-0 text-[11px] text-[var(--ink-faint)]">
                                {opt.domain}
                              </span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </Popover.Content>
                </Popover.Portal>
              </Popover.Root>

              <div className="flex items-center gap-2">
                {composerText.length > 420 && (
                  <span className="font-mono-code text-[11px] text-[var(--ink-muted)] tabular-nums">
                    {composerText.length}/500
                  </span>
                )}
                <button
                  type="button"
                  data-testid="assistant-send-btn"
                  aria-label="发送消息"
                  disabled={hasPendingTurn || composerText.trim().length === 0}
                  onClick={handleSendComposer}
                  className={[
                    "inline-flex h-8 w-8 items-center justify-center rounded-full transition-all duration-[150ms]",
                    !hasPendingTurn && composerText.trim().length > 0
                      ? "bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] active:scale-[0.92] cursor-pointer"
                      : "bg-[var(--bg-surface-subtle)] text-[var(--ink-faint)] cursor-not-allowed",
                  ].join(" ")}
                >
                  <ArrowUp className="h-4 w-4" strokeWidth={2.3} />
                </button>
              </div>
            </div>
          </div>
        </div>
      </footer>

      {/* Frosted History Verification Modal */}
      <Modal
        open={historyModalOpen}
        onOpenChange={setHistoryModalOpen}
        title="历史活动记录"
        subtitle="仅保留安全索引，展开单条记录时按您当前实时权限重新核验。"
        size="lg"
      >
        <div className="space-y-3.5" data-testid="assistant-history-section">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[12px] text-[var(--ink-muted)]">
              若某项权限已被撤销，重新核验将立即清除已展示内容。
            </span>
            <Button
              size="sm"
              variant="ghost"
              pill
              onClick={() => void loadHistory(null)}
              disabled={historyLoading}
            >
              <RefreshCw
                className={[
                  "h-3.5 w-3.5",
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
            <div className="rounded-tile bg-[var(--bg-surface-tint)] py-10 text-center text-[13px] text-[var(--ink-muted)]">
              当前账号暂无历史活动记录。
            </div>
          )}

          {historyItems.length > 0 && (
            <div className="space-y-2.5">
              {historyItems.map((item) => {
                const expanded = expandedHistory[item.id];
                return (
                  <div
                    key={item.id}
                    data-testid={`history-item-${item.id}`}
                    className="rounded-tile bg-[var(--bg-surface-tint)] p-3.5 space-y-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0 flex flex-wrap items-center gap-2">
                        <span className="font-mono-code text-[12.5px] font-semibold text-[var(--ink-primary)]">
                          {item.id}
                        </span>
                        <span className="font-mono-code text-[11.5px] text-[var(--ink-muted)] tabular-nums">
                          {formatUnixTime(item.started_at)}
                        </span>
                      </div>

                      <Button
                        size="sm"
                        variant="secondary"
                        pill
                        loading={Boolean(expanded?.loading)}
                        data-testid={`history-expand-${item.id}`}
                        onClick={() => void handleExpandHistory(item.id)}
                      >
                        <ShieldCheck className="h-3.5 w-3.5 text-[var(--accent)]" />
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
                        onSelectClarification={(prompt) => {
                          setHistoryModalOpen(false);
                          void executeTurn(prompt);
                        }}
                        onInspectObject={(sel, trig) => {
                          setHistoryModalOpen(false);
                          handleInspectObject(sel, trig);
                        }}
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
                pill
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
      </Modal>

      {/* Form-based Query Modal (/v1/workbench/calls) */}
      <Modal
        open={structuredModalOpen}
        onOpenChange={setStructuredModalOpen}
        title="按表单查询"
        subtitle="选择当前已授权的业务查询项与仓库站点直接执行。"
        size="md"
        footer={
          <>
            <Button
              variant="ghost"
              pill
              disabled={toolSubmitting}
              onClick={() => setStructuredModalOpen(false)}
            >
              取消
            </Button>
            <Button
              variant="primary"
              pill
              loading={toolSubmitting}
              onClick={(e) => void handleStructuredSubmit(e)}
            >
              立即执行
            </Button>
          </>
        }
      >
        <form
          onSubmit={(e) => void handleStructuredSubmit(e)}
          data-testid="assistant-structured-bar"
          className="space-y-4"
        >
          <div>
            <label className="block text-[12px] font-medium text-[var(--ink-secondary)]">
              业务项目
            </label>
            <select
              value={selectedToolId}
              onChange={(e) => setSelectedToolId(e.target.value)}
              className="mt-1.5 h-10 w-full rounded-sm bg-[var(--bg-surface-tint)] px-3 text-[13px] text-[var(--ink-primary)] ring-1 ring-[var(--hairline-strong)] focus:bg-[var(--bg-surface)] focus:ring-2 focus:ring-[var(--accent)] focus:outline-none"
            >
              {availableTools.map((tool) => (
                <option key={tool.id} value={tool.id}>
                  {tool.id} ({tool.mode === "proposal" ? "提案" : "只读"})
                </option>
              ))}
            </select>
          </div>

          {selectedToolMeta && selectedToolMeta.warehouses.length > 0 && (
            <div>
              <label className="block text-[12px] font-medium text-[var(--ink-secondary)]">
                仓库站点
              </label>
              <select
                value={toolWarehouse}
                onChange={(e) => setToolWarehouse(e.target.value)}
                className="mt-1.5 h-10 w-full rounded-sm bg-[var(--bg-surface-tint)] px-3 font-mono-code text-[13px] text-[var(--ink-primary)] ring-1 ring-[var(--hairline-strong)] focus:bg-[var(--bg-surface)] focus:ring-2 focus:ring-[var(--accent)] focus:outline-none"
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
            <div>
              <label className="block text-[12px] font-medium text-[var(--ink-secondary)]">
                {selectedToolId === "finance.invoice.read"
                  ? "发票编号"
                  : selectedToolId === "order.draft.prepare"
                    ? "进件编号"
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
                      ? "输入进件编号"
                      : toolWarehouse === "HK02"
                        ? "SHP-2001"
                        : "SHP-1001"
                }
                className="mt-1.5 h-10 w-full rounded-sm bg-[var(--bg-surface-tint)] px-3 font-mono-code text-[13px] text-[var(--ink-primary)] ring-1 ring-[var(--hairline-strong)] focus:bg-[var(--bg-surface)] focus:ring-2 focus:ring-[var(--accent)] focus:outline-none"
              />
            </div>
          )}

          {selectedToolId === "shipment.reschedule" && (
            <div>
              <label className="block text-[12px] font-medium text-[var(--ink-secondary)]">
                目标交付日期
              </label>
              <input
                type="date"
                value={toolDeliveryDate}
                onChange={(e) => setToolDeliveryDate(e.target.value)}
                className="mt-1.5 h-10 w-full rounded-sm bg-[var(--bg-surface-tint)] px-3 font-mono-code text-[13px] text-[var(--ink-primary)] ring-1 ring-[var(--hairline-strong)] focus:bg-[var(--bg-surface)] focus:ring-2 focus:ring-[var(--accent)] focus:outline-none"
              />
            </div>
          )}
        </form>
      </Modal>
    </div>
  );
}
