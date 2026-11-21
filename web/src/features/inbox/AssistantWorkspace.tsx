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
import { sortWarehouses } from "@/lib/format";
import { LOCALE_META, useLocale } from "@/lib/i18n";
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
import {
  IMessageBubbleTail,
  getBubbleRadiusClass,
} from "@/features/inbox/bubble-group";
import {
  TurnResultCard,
  buildCapabilityPromptOptions,
  type CapabilityDomainId,
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
const DEFAULT_AGENT_NAMES = new Set([
  "个人业务助手",
  "個人業務助手",
  "Personal Agent",
]);

function isZoomMeetingIntent(input: string): boolean {
  const text = input.trim();
  if (!text) return false;
  if (/\bzoom\b/i.test(text)) return true;
  if (
    /(?:预约|预定|預約|預訂|订一个|訂一個|订个|訂個|安排|约个|約個|约一个|約一個|发起|發起|约会|約會|订会|訂會|开一个|開一個|开个|開個).{0,18}(?:会议|會議|会|會|评审会|評審會|对齐会|對齊會|碰头会|碰頭會|同步会|同步會|讨论会|討論會|电话会|電話會)/.test(
      text,
    )
  ) {
    return true;
  }
  if (
    /(?:明天|后天|後天|今天|下周|下週|[周週][一二三四五六日天]|星期[一二三四五六日天]|\d{1,2}[点點]).{0,24}(?:开会|開會|评审会|評審會|对齐会|對齊會|会议|會議)/.test(
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

function getSuggestionIcon(domainId: CapabilityDomainId) {
  switch (domainId) {
    case "finance":
      return Receipt;
    case "shipment":
      return Package;
    case "insights":
      return Warehouse;
    case "mail":
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
  const {
    locale,
    t,
    tp,
    tx,
    formatDateTime,
    localizeAction,
    localizeTool,
    localizeError,
  } = useLocale();

  const [memoryTick, setMemoryTick] = useState(0);
  useEffect(
    () => subscribeAssistantMemory(() => setMemoryTick((tick) => tick + 1)),
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
    () => (capabilities?.tools ?? []).filter((tool) => tool.available),
    [capabilities],
  );

  useEffect(() => {
    if (availableTools.length === 0) {
      setSelectedToolId("");
      setToolWarehouse("");
      return;
    }
    const current = availableTools.find((tool) => tool.id === selectedToolId);
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
          userText: tx(
            {
              "zh-CN": "发起运单改期提案 ({target} · {wh})",
              "zh-HK": "發起運單改期提案 ({target} · {wh})",
              en: "Propose shipment reschedule ({target} · {wh})",
            },
            { target: proposal.plan.target, wh: proposal.warehouse },
          ),
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
          title: localizeAction(proposal.plan.action),
        },
        { tab: "current" },
      );
    },
    [openDrawer, localizeAction, tx],
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

  const executeZoomBookingParse = useCallback(
    async (utterance: string) => {
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
          ? localizeError(err)
          : tx({
              "zh-CN": "解析自然语言会议请求失败，请检查时间或参会同事描述后重试。",
              "zh-HK": "解析自然語言會議請求失敗，請檢查時間或與會同事描述後重試。",
              en: "Could not parse the meeting request. Please verify the time and attendee details.",
            });
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
    },
    [localizeError, tx],
  );

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
            message: tx({
              "zh-CN": "网络连接异常或上游暂不可用，请点击重试。",
              "zh-HK": "網路連線異常或上游暫時無法使用，請點擊重試。",
              en: "Network or upstream service unavailable. Please retry.",
            }),
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
      tx,
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
        userText: tx({
          "zh-CN": "汇总今日工作简报",
          "zh-HK": "彙整今日工作簡報",
          en: "Summarize today's operations brief",
        }),
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
  }, [handleAccessChanged, tx]);

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

    const chosen = availableTools.find((tool) => tool.id === selectedToolId);
    if (!chosen) return;

    let payload: WorkbenchToolCall;
    let labelText = "";

    if (chosen.id === "mail.inbox.read") {
      payload = { tool: "mail.inbox.read", limit: 10 };
      labelText = tx({
        "zh-CN": "查看我的收件箱",
        "zh-HK": "檢視我的收件箱",
        en: "Check my inbox",
      });
    } else if (chosen.id === "decision.warehouse.summary") {
      if (!toolWarehouse) return;
      payload = { tool: "decision.warehouse.summary", warehouse: toolWarehouse };
      labelText = tx(
        {
          "zh-CN": "仓库汇总 {wh}",
          "zh-HK": "倉庫摘要 {wh}",
          en: "Warehouse summary {wh}",
        },
        { wh: toolWarehouse },
      );
    } else if (chosen.id === "finance.invoice.read") {
      if (!toolWarehouse || !toolRefId.trim()) return;
      payload = {
        tool: "finance.invoice.read",
        warehouse: toolWarehouse,
        invoice_id: toolRefId.trim(),
      };
      labelText = tx(
        {
          "zh-CN": "查看发票 {ref} ({wh})",
          "zh-HK": "檢視發票 {ref} ({wh})",
          en: "Check invoice {ref} ({wh})",
        },
        { ref: toolRefId.trim(), wh: toolWarehouse },
      );
    } else if (chosen.id === "shipment.read") {
      if (!toolWarehouse || !toolRefId.trim()) return;
      payload = {
        tool: "shipment.read",
        warehouse: toolWarehouse,
        shipment_id: toolRefId.trim(),
      };
      labelText = tx(
        {
          "zh-CN": "查看运单 {ref} ({wh})",
          "zh-HK": "檢視運單 {ref} ({wh})",
          en: "Check shipment {ref} ({wh})",
        },
        { ref: toolRefId.trim(), wh: toolWarehouse },
      );
    } else if (chosen.id === "shipment.reschedule") {
      if (!toolWarehouse || !toolRefId.trim() || !toolDeliveryDate) return;
      payload = {
        tool: "shipment.reschedule",
        warehouse: toolWarehouse,
        shipment_id: toolRefId.trim(),
        delivery_date: toolDeliveryDate,
      };
      labelText = tx(
        {
          "zh-CN": "运单改期 {ref} -> {date}",
          "zh-HK": "運單改期 {ref} -> {date}",
          en: "Reschedule shipment {ref} -> {date}",
        },
        { ref: toolRefId.trim(), date: toolDeliveryDate },
      );
    } else if (chosen.id === "order.draft.prepare") {
      if (!toolWarehouse || !toolRefId.trim()) return;
      payload = {
        tool: "order.draft.prepare",
        warehouse: toolWarehouse,
        intake_id: toolRefId.trim(),
      };
      labelText = tx(
        {
          "zh-CN": "准备订单草稿 {ref} ({wh})",
          "zh-HK": "準備訂單草稿 {ref} ({wh})",
          en: "Prepare order draft {ref} ({wh})",
        },
        { ref: toolRefId.trim(), wh: toolWarehouse },
      );
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

  const trimmedAgentName = agentProfile?.display_name?.trim();
  const agentDisplayName =
    trimmedAgentName && !DEFAULT_AGENT_NAMES.has(trimmedAgentName)
      ? trimmedAgentName
      : t("brand.defaultAgentName");
  const agentAvatarSrc = agentProfile?.has_avatar
    ? `/v1/agent-profile/avatar?v=${agentAvatarVersion}`
    : null;
  const quickPromptOptions = useMemo(
    () => buildCapabilityPromptOptions(capabilities, locale),
    [capabilities, locale],
  );
  // Strict max 3 consistent suggestion chips on empty state (2 capability + 1 Zoom)
  const emptySuggestions = useMemo(
    () => quickPromptOptions.slice(0, 2),
    [quickPromptOptions],
  );
  const selectedToolMeta = availableTools.find(
    (tool) => tool.id === selectedToolId,
  );
  const hasPendingTurn = turns.some((turn) => turn.status === "pending");

  const defaultZoomSample = tx({
    "zh-CN": "明天下午 3 点和 manager 用 Zoom 开 HK01 订单评审会",
    "zh-HK": "明天下午 3 點和 manager 用 Zoom 開 HK01 訂單評審會",
    en: "Book a Zoom meeting with manager tomorrow at 3pm for HK01 order review",
  });

  return (
    <div
      data-testid="assistant-workspace"
      className="flex h-full min-h-0 flex-col bg-[var(--bg-sheet)]"
    >
      {/* Pure 60px Frosted Top Header: Agent Avatar + Name (left) & ONLY "工作台" / "Workbench" pill (right) */}
      <header className="aios-topbar-glass sticky top-0 z-20 flex h-[var(--header-h)] shrink-0 items-center justify-between gap-3 border-b border-[var(--hairline)] px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-2.5">
          <Link
            href="/inbox"
            aria-label={tx({
              "zh-CN": "返回会话列表",
              "zh-HK": "返回對話清單",
              en: "Back to conversations",
            })}
            data-testid="assistant-mobile-back"
            className="inline-flex h-8 items-center gap-0.5 rounded-full pr-2.5 pl-1.5 text-[13.5px] font-medium text-[var(--accent)] hover:bg-[var(--accent-wash)] transition-colors lg:hidden"
          >
            <ChevronLeft className="h-4 w-4" strokeWidth={2.2} />
            <span>
              {tx({ "zh-CN": "返回", "zh-HK": "返回", en: "Back" })}
            </span>
          </Link>

          <Link
            href="/settings/agent"
            title={tx(
              {
                "zh-CN": "配置 {name}",
                "zh-HK": "設定 {name}",
                en: "Configure {name}",
              },
              { name: agentDisplayName },
            )}
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
                {tx({
                  "zh-CN": "随时为你查询与起草",
                  "zh-HK": "隨時為你查詢與起草",
                  en: "Lookups, drafts & scheduling",
                })}
                {actor?.warehouses.length
                  ? ` · ${sortWarehouses(actor.warehouses).join(" / ")}`
                  : ""}
              </p>
            </div>
          </Link>
        </div>

        {/* Top-Right ONLY: Sleek "工作台" / "Workbench" Pill */}
        <Link
          href="/work"
          data-testid="agent-open-workbench-btn"
          className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full bg-[var(--bg-surface)] px-4 text-[13px] font-medium text-[var(--ink-primary)] shadow-[var(--shadow-subtle)] hover:shadow-[var(--shadow-card)] hover:-translate-y-[0.5px] active:scale-[0.98] transition-all duration-[150ms]"
        >
          <LayoutGrid
            className="h-3.5 w-3.5 text-[var(--accent)]"
            strokeWidth={1.9}
          />
          <span>
            {tx({
              "zh-CN": "工作台",
              "zh-HK": "工作台",
              en: "Workbench",
            })}
          </span>
          {assignedCount > 0 && (
            <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[var(--accent-solid)] px-1.5 font-mono-code text-[10.5px] font-semibold text-[var(--accent-fg)]">
              {assignedCount > 99 ? "99+" : assignedCount}
            </span>
          )}
        </Link>
      </header>

      {/* Main Breathable Conversation Stream */}
      <div
        data-testid="assistant-feed"
        className="min-h-0 flex-1 overflow-y-auto bg-[var(--bg-sheet)] px-4 py-6 sm:px-8"
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
                  {historyNext
                    ? tx(
                        {
                          "zh-CN": "历史活动记录 · {count}+ 条",
                          "zh-HK": "歷史活動紀錄 · {count}+ 則",
                          en: "Activity History · {count}+ items",
                        },
                        { count: historyItems.length },
                      )
                    : tp(
                        {
                          "zh-CN": "历史活动记录 · {count} 条",
                          "zh-HK": "歷史活動紀錄 · {count} 則",
                          en: {
                            one: "Activity History · {count} item",
                            other: "Activity History · {count} items",
                          },
                        },
                        historyItems.length,
                      )}
                </span>
              </button>
            </div>
          )}

          {/* Serene Unboxed Muse Empty State — Opus Nit #2: text-balance & crisp max-w-[520px] (zero widow chars) */}
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
              <h3 className="mt-5 text-[22px] font-semibold tracking-[-0.025em] text-[var(--ink-primary)] text-balance">
                {tx({
                  "zh-CN": "你好，今天想推进哪项业务？",
                  "zh-HK": "你好，今天想推進哪項業務？",
                  en: "What would you like to work on today?",
                })}
              </h3>
              <p className="mt-2 max-w-[520px] text-[13.5px] leading-relaxed text-[var(--ink-muted)] text-balance">
                {tx({
                  "zh-CN": "查询运单与发票、起草业务提案，或直接预约 Zoom 会议。",
                  "zh-HK": "查詢運單與發票、起草業務提案，或直接預約 Zoom 會議。",
                  en: "Query shipments & invoices, draft proposals, or book Zoom calls.",
                })}
              </p>

              <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
                {emptySuggestions.map((opt) => {
                  const Icon = getSuggestionIcon(opt.domainId);
                  return (
                    <button
                      key={opt.prompt}
                      type="button"
                      disabled={hasPendingTurn}
                      onClick={() => void executeTurn(opt.prompt)}
                      className="inline-flex items-center gap-1.5 rounded-full bg-[var(--bg-surface-subtle)] px-4 py-2 text-[13px] font-medium text-[var(--ink-secondary)] hover:bg-[var(--accent-wash)] hover:text-[var(--accent-ink)] transition-colors duration-[150ms] cursor-pointer disabled:opacity-50"
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
                    setZoomNlText(defaultZoomSample);
                  }}
                  className="inline-flex items-center gap-1.5 rounded-full bg-[var(--bg-surface-subtle)] px-4 py-2 text-[13px] font-medium text-[var(--ink-secondary)] hover:bg-[var(--accent-wash)] hover:text-[var(--accent-ink)] transition-colors duration-[150ms] cursor-pointer disabled:opacity-50"
                >
                  <Video
                    className="h-3.5 w-3.5 text-[var(--accent)]"
                    strokeWidth={1.85}
                  />
                  <span>{t("assistant.action.bookZoom")}</span>
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
              {/* Outgoing User Bubble — seamless native bubble-sent-bg + matching SVG tail */}
              <div className="flex justify-end pr-1.5">
                <div
                  className={[
                    "imessage-bubble-sent relative max-w-[82%] bg-[var(--bubble-sent-bg)] px-4 py-2.5 text-[14.5px] leading-[1.45] text-[var(--bubble-sent-ink)] whitespace-pre-wrap break-words",
                    getBubbleRadiusClass("sent", "single"),
                  ].join(" ")}
                >
                  {turn.userText}
                  <IMessageBubbleTail side="sent" />
                </div>
              </div>

              {/* Incoming Agent Turn Row — translate-only .aios-row-in */}
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
                            summaryLabel={tx({
                              "zh-CN": "已汇总今日工作简报 · 2 步核验",
                              "zh-HK": "已彙整今日工作簡報 · 2 步核驗",
                              en: "Today's brief ready · 2 steps verified",
                            })}
                            steps={[
                              {
                                id: "brief-scope",
                                label: tx(
                                  {
                                    "zh-CN": "已按当前账号权限统计待审单据与会议（{tenant}）",
                                    "zh-HK": "已按目前帳號權限統計待審單據與會議（{tenant}）",
                                    en: "Aggregated approvals & meetings within scope ({tenant})",
                                  },
                                  {
                                    tenant:
                                      actor?.tenant ||
                                      t("kinetic.currentTenant"),
                                  },
                                ),
                                status: "done",
                              },
                              {
                                id: "brief-ts",
                                label: tx({
                                  "zh-CN": "已生成本地时区实时快照",
                                  "zh-HK": "已產生本地時區即時快照",
                                  en: "Live local-timezone snapshot captured",
                                }),
                                status: "done",
                                meta: formatDateTime(turn.brief.as_of),
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
                                <span>
                                  {tx({
                                    "zh-CN": "今日工作简报",
                                    "zh-HK": "今日工作簡報",
                                    en: "Today's Brief",
                                  })}
                                </span>
                              </span>
                              <span className="font-mono-code text-[11px] text-[var(--ink-muted)] tabular-nums">
                                {formatDateTime(turn.brief.as_of)}
                              </span>
                            </div>
                            <div className="p-4 space-y-3">
                              <div className="grid grid-cols-2 gap-2.5">
                                <div className="rounded-tile bg-[var(--bg-surface-tint)] p-3">
                                  <div className="text-[11.5px] text-[var(--ink-muted)]">
                                    {t("assistant.brief.pendingApprovals")}
                                  </div>
                                  <div className="mt-0.5 text-[22px] font-semibold tracking-[-0.02em] text-[var(--ink-primary)] tabular-nums">
                                    {turn.brief.pending_approvals}
                                    {turn.brief.pending_approvals_capped ? "+" : ""}
                                  </div>
                                </div>
                                <div className="rounded-tile bg-[var(--bg-surface-tint)] p-3">
                                  <div className="text-[11.5px] text-[var(--ink-muted)]">
                                    {tx({
                                      "zh-CN": "今日会议",
                                      "zh-HK": "今日會議",
                                      en: "Meetings Today",
                                    })}
                                  </div>
                                  <div className="mt-0.5 text-[22px] font-semibold tracking-[-0.02em] text-[var(--ink-primary)] tabular-nums">
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
                                  <span>
                                    {tx({
                                      "zh-CN": "打开日历",
                                      "zh-HK": "開啟日曆",
                                      en: "Calendar",
                                    })}
                                  </span>
                                </Link>
                                <Link
                                  href="/work"
                                  className="inline-flex h-8 items-center gap-1 rounded-full bg-[var(--accent-solid)] px-3.5 text-[12px] font-medium text-[var(--accent-fg)] hover:bg-[var(--accent-solid-hover)]"
                                >
                                  <span>{t("inbox.enterWorkbench")}</span>
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
                              turn.error.status === 403 && actor
                                ? sortWarehouses(actor.warehouses)
                                : undefined
                            }
                          />
                          {turn.sourceKind === "turn" &&
                            (turn.error.status >= 429 ||
                              turn.error.status === 409 ||
                              turn.error.code === "TURN_IN_PROGRESS") && (
                              <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-[11.5px] text-[var(--ink-muted)]">
                                <span>
                                  {tx({
                                    "zh-CN": "重试将复用幂等键 ",
                                    "zh-HK": "重試將沿用冪等鍵 ",
                                    en: "Retry reuses idempotency key ",
                                  })}
                                  <span className="font-mono-code">
                                    {turn.clientId}
                                  </span>
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
                                  {tx({
                                    "zh-CN": "重新提交",
                                    "zh-HK": "重新提交",
                                    en: "Resubmit",
                                  })}
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
      <footer className="shrink-0 bg-gradient-to-t from-[var(--bg-sheet)] via-[var(--bg-sheet)] to-transparent px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-8 sm:pb-5">
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
                placeholder={tx({
                  "zh-CN": "例如：明天下午 3 点和 manager 用 Zoom 开 HK01 订单评审会",
                  "zh-HK": "例如：明天下午 3 點和 manager 用 Zoom 開 HK01 訂單評審會",
                  en: "e.g. Book a Zoom call with manager tomorrow at 3pm for HK01 review",
                })}
                style={{ outline: "none" }}
                className="min-w-[200px] flex-1 border-0 bg-transparent text-[13.5px] text-[var(--ink-primary)] placeholder:text-[var(--ink-faint)] focus:outline-none focus:ring-0"
              />
              <Button
                type="submit"
                size="sm"
                variant="primary"
                pill
                disabled={!zoomNlText.trim()}
              >
                {tx({
                  "zh-CN": "解析预览",
                  "zh-HK": "解析預覽",
                  en: "Parse Draft",
                })}
              </Button>
              <button
                type="button"
                onClick={() => setZoomBarOpen(false)}
                aria-label={tx({
                  "zh-CN": "关闭 Zoom 预约栏",
                  "zh-HK": "關閉 Zoom 預約列",
                  en: "Close Zoom booking bar",
                })}
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
                placeholder={tx(
                  {
                    "zh-CN": "给{name}发消息…",
                    "zh-HK": "傳訊息給{name}…",
                    en: "Message {name}…",
                  },
                  { name: agentDisplayName },
                )}
                style={{ outline: "none" }}
                className="block max-h-[160px] min-h-[28px] w-full resize-none border-0 bg-transparent text-[14.5px] leading-[1.5] text-[var(--ink-primary)] placeholder:text-[var(--ink-faint)] focus:outline-none focus:ring-0"
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
                    aria-label={tx({
                      "zh-CN": "添加上下文",
                      "zh-HK": "加入上下文",
                      en: "Add context",
                    })}
                    className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--ink-primary)] transition-colors duration-[140ms] cursor-pointer"
                  >
                    <Plus className="h-4 w-4" strokeWidth={2} />
                    <span>
                      {tx({
                        "zh-CN": "添加上下文",
                        "zh-HK": "加入上下文",
                        en: "Add Context",
                      })}
                    </span>
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
                          <span>
                            {tx({
                              "zh-CN": "新建订单 / 上传单据",
                              "zh-HK": "新增訂單 / 上傳單據",
                              en: "New Order / Upload Document",
                            })}
                          </span>
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
                        <span>
                          {tx({
                            "zh-CN": "插入今日简报",
                            "zh-HK": "插入今日簡報",
                            en: "Insert Daily Brief",
                          })}
                        </span>
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
                        <span>
                          {tx({
                            "zh-CN": "历史活动记录",
                            "zh-HK": "歷史活動紀錄",
                            en: "Activity History",
                          })}
                        </span>
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
                        <span>{t("assistant.action.bookZoom")}</span>
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
                          <span>
                            {tx({
                              "zh-CN": "按表单查询",
                              "zh-HK": "按表單查詢",
                              en: "Structured Tool Form",
                            })}
                          </span>
                        </button>
                      )}
                    </div>

                    {quickPromptOptions.length > 0 && (
                      <div className="mt-2 border-t border-[var(--hairline)] pt-2">
                        <div className="px-3 pb-1.5 text-[11px] font-medium text-[var(--ink-muted)]">
                          {tx({
                            "zh-CN": "常用",
                            "zh-HK": "常用",
                            en: "Quick Prompts",
                          })}
                        </div>
                        <div className="space-y-0.5">
                          {quickPromptOptions.map((opt) => {
                            const Icon = getSuggestionIcon(opt.domainId);
                            return (
                              <button
                                key={opt.prompt}
                                type="button"
                                disabled={hasPendingTurn}
                                onClick={() => {
                                  setContextMenuOpen(false);
                                  void executeTurn(opt.prompt);
                                }}
                                className="flex w-full items-center justify-between gap-2 rounded-sm px-3 py-1.5 text-left text-[12.5px] text-[var(--ink-secondary)] hover:bg-[var(--accent-wash)] hover:text-[var(--accent-ink)] transition-colors cursor-pointer disabled:opacity-50"
                              >
                                <span className="flex min-w-0 items-center gap-2.5">
                                  <Icon
                                    className="h-4 w-4 shrink-0 text-[var(--accent)]"
                                    strokeWidth={1.85}
                                  />
                                  <span className="truncate">{opt.label}</span>
                                </span>
                                <span className="shrink-0 text-[11px] text-[var(--ink-muted)]">
                                  {opt.domainLabel}
                                </span>
                              </button>
                            );
                          })}
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
                  aria-label={t("assistant.sendAria")}
                  disabled={hasPendingTurn || composerText.trim().length === 0}
                  onClick={handleSendComposer}
                  className={[
                    "inline-flex h-8 w-8 items-center justify-center rounded-full transition-all duration-[150ms]",
                    !hasPendingTurn && composerText.trim().length > 0
                      ? "bg-[var(--accent-solid)] text-[var(--accent-fg)] hover:bg-[var(--accent-solid-hover)] active:scale-[0.92] cursor-pointer"
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
        title={tx({
          "zh-CN": "历史活动记录",
          "zh-HK": "歷史活動紀錄",
          en: "Activity History",
        })}
        subtitle={tx({
          "zh-CN": "仅保留安全索引，展开单条记录时按您当前实时权限重新核验。",
          "zh-HK": "僅保留安全索引，展開單筆紀錄時按您目前即時權限重新核驗。",
          en: "Only safe indices are stored; expanding any record re-verifies your live permissions.",
        })}
        size="lg"
      >
        <div className="space-y-3.5" data-testid="assistant-history-section">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[12px] text-[var(--ink-muted)]">
              {tx({
                "zh-CN": "若某项权限已被撤销，重新核验将立即清除已展示内容。",
                "zh-HK": "若某項權限已被撤銷，重新核驗將立即清除已顯示內容。",
                en: "If a permission was revoked, re-verification immediately clears restricted data.",
              })}
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
              <span>
                {tx({
                  "zh-CN": "刷新索引",
                  "zh-HK": "重新整理索引",
                  en: "Refresh",
                })}
              </span>
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
              {tx({
                "zh-CN": "当前账号暂无历史活动记录。",
                "zh-HK": "目前帳號暫無歷史活動紀錄。",
                en: "No activity history for this account yet.",
              })}
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
                          {formatDateTime(item.started_at)}
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
                            ? tx({
                                "zh-CN": "重新核验",
                                "zh-HK": "重新核驗",
                                en: "Re-verify",
                              })
                            : tx({
                                "zh-CN": "重新核验并展开",
                                "zh-HK": "重新核驗並展開",
                                en: "Verify & Expand",
                              })}
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
                {historyLoadingMore
                  ? t("common.loading")
                  : tx({
                      "zh-CN": "加载更多历史记录",
                      "zh-HK": "載入更多歷史紀錄",
                      en: "Load More History",
                    })}
              </Button>
            </div>
          )}
        </div>
      </Modal>

      {/* Form-based Query Modal (/v1/workbench/calls) */}
      <Modal
        open={structuredModalOpen}
        onOpenChange={setStructuredModalOpen}
        title={tx({
          "zh-CN": "按表单查询",
          "zh-HK": "按表單查詢",
          en: "Structured Tool Query",
        })}
        subtitle={tx({
          "zh-CN": "选择当前已授权的业务查询项与仓库直接执行。",
          "zh-HK": "選擇目前已授權的業務查詢項目與倉庫直接執行。",
          en: "Run an authorized typed business tool directly within your warehouse scope.",
        })}
        size="md"
        footer={
          <>
            <Button
              variant="ghost"
              pill
              disabled={toolSubmitting}
              onClick={() => setStructuredModalOpen(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              pill
              loading={toolSubmitting}
              onClick={(e) => void handleStructuredSubmit(e)}
            >
              {tx({
                "zh-CN": "立即执行",
                "zh-HK": "立即執行",
                en: "Run Tool",
              })}
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
              {tx({
                "zh-CN": "业务项目",
                "zh-HK": "業務項目",
                en: "Tool",
              })}
            </label>
            <select
              value={selectedToolId}
              onChange={(e) => setSelectedToolId(e.target.value)}
              className="mt-1.5 h-10 w-full rounded-sm bg-[var(--bg-surface-tint)] px-3 text-[13px] text-[var(--ink-primary)] ring-1 ring-[var(--hairline-strong)] focus:bg-[var(--bg-surface)] focus:ring-2 focus:ring-[var(--accent)] focus:outline-none"
            >
              {availableTools.map((tool) => (
                <option key={tool.id} value={tool.id}>
                  {localizeTool(tool.id)} · {tool.id} (
                  {tool.mode === "proposal"
                    ? tx({
                        "zh-CN": "提案",
                        "zh-HK": "提案",
                        en: "Proposal",
                      })
                    : tx({
                        "zh-CN": "只读",
                        "zh-HK": "唯讀",
                        en: "Read",
                      })}
                  )
                </option>
              ))}
            </select>
          </div>

          {selectedToolMeta && selectedToolMeta.warehouses.length > 0 && (
            <div>
              <label className="block text-[12px] font-medium text-[var(--ink-secondary)]">
                {tx({
                  "zh-CN": "仓库",
                  "zh-HK": "倉庫",
                  en: "Warehouse",
                })}
              </label>
              <select
                value={toolWarehouse}
                onChange={(e) => setToolWarehouse(e.target.value)}
                className="mt-1.5 h-10 w-full rounded-sm bg-[var(--bg-surface-tint)] px-3 font-mono-code text-[13px] text-[var(--ink-primary)] ring-1 ring-[var(--hairline-strong)] focus:bg-[var(--bg-surface)] focus:ring-2 focus:ring-[var(--accent)] focus:outline-none"
              >
                {sortWarehouses(selectedToolMeta.warehouses).map((wh) => (
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
                  ? tx({
                      "zh-CN": "发票编号",
                      "zh-HK": "發票編號",
                      en: "Invoice ID",
                    })
                  : selectedToolId === "order.draft.prepare"
                    ? tx({
                        "zh-CN": "进件编号",
                        "zh-HK": "進件編號",
                        en: "Intake ID",
                      })
                    : tx({
                        "zh-CN": "运单编号",
                        "zh-HK": "運單編號",
                        en: "Shipment ID",
                      })}
              </label>
              <input
                type="text"
                value={toolRefId}
                onChange={(e) => setToolRefId(e.target.value)}
                placeholder={
                  selectedToolId === "finance.invoice.read"
                    ? "INV-100"
                    : selectedToolId === "order.draft.prepare"
                      ? tx({
                          "zh-CN": "输入进件编号",
                          "zh-HK": "輸入進件編號",
                          en: "Enter intake ID",
                        })
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
                {tx({
                  "zh-CN": "目标交付日期",
                  "zh-HK": "目標交付日期",
                  en: "Target Delivery Date",
                })}
              </label>
              <input
                type="date"
                lang={LOCALE_META[locale].htmlLang}
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
