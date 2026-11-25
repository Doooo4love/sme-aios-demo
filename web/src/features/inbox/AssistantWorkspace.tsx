"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Popover } from "radix-ui";
import {
  ArrowUp,
  ArrowUpRight,
  Bell,
  BookOpen,
  Calendar,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  Clock,
  Compass,
  FilePlus2,
  LayoutGrid,
  Mail,
  Package,
  Plus,
  Receipt,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
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
import { ContactProfileDialog } from "@/components/chat/ContactProfileDialog";
import { ConversationHeader } from "@/components/chat/ConversationHeader";
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
  computeBubbleGroupPos,
  formatBurstTimestamp,
  getBubbleRadiusClass,
  shouldShowBubbleTail,
  shouldShowBurstTimestamp,
} from "@/features/inbox/bubble-group";
import {
  TurnResultCard,
  buildCapabilityPromptOptions,
  type CapabilityDomainId,
} from "@/features/inbox/TurnResultCard";
import {
  SlashCommandPalette,
  type SlashCommandPaletteHandle,
} from "@/features/inbox/SlashCommandPalette";
import { ZoomBookingCard } from "@/features/inbox/ZoomBookingCard";
import type {
  DrawerObjectSelection,
  HistoryCursor,
  HistoryListItem,
  Proposal,
  SlashSkillItem,
  SuggestedAction,
  TurnResult,
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

function summarizeTurnResultForContext(
  result: TurnResult | undefined,
): string | null {
  if (!result) return null;
  if (result.kind === "message") {
    return result.mode === "public_search" ? null : result.reply.slice(0, 360);
  }
  if (result.kind === "refusal") {
    return `[refusal:${result.category}] ${result.message.slice(0, 240)}`;
  }
  if (result.kind === "clarification") return result.question.slice(0, 240);
  if (result.kind === "result") {
    return `[tool:${result.tool}] ${JSON.stringify(result.data).slice(0, 240)}`;
  }
  if (result.kind === "proposal") {
    return `[proposal:${result.proposal.id}] ${result.proposal.plan.action} (${result.proposal.state})`;
  }
  if (result.kind === "approval_preview") {
    return `[approval_preview:${result.proposal.id}] ${result.proposal.plan.action}`;
  }
  return null;
}

function buildConversationContext(
  turns: readonly AssistantTurnEntry[],
  excludeEntryId?: string,
): Array<{ role: "user" | "assistant"; text: string }> {
  const ctx: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (const entry of turns) {
    if (excludeEntryId && entry.id === excludeEntryId) continue;
    if (entry.sourceKind === "proactive_alert") {
      if (entry.proactiveAlert) {
        ctx.push({
          role: "assistant",
          text: `${entry.proactiveAlert.title}: ${entry.proactiveAlert.subtitle}`.slice(
            0,
            240,
          ),
        });
      }
      continue;
    }
    if (entry.userText?.trim()) {
      ctx.push({ role: "user", text: entry.userText.trim().slice(0, 360) });
    }
    const assistantSummary = summarizeTurnResultForContext(entry.result);
    if (assistantSummary) {
      ctx.push({ role: "assistant", text: assistantSummary });
    }
  }
  return ctx.slice(-6);
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
      return Compass;
  }
}

export function AssistantWorkspace() {
  const router = useRouter();
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
    formatTimeOnly,
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
  const paletteRef = useRef<SlashCommandPaletteHandle | null>(null);
  const [headerScrolled, setHeaderScrolled] = useState(false);
  const [dismissedSlashQuery, setDismissedSlashQuery] = useState<string | null>(
    null,
  );
  const autoResizeTextarea = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(160, Math.max(24, el.scrollHeight))}px`;
  }, []);

  useEffect(() => {
    autoResizeTextarea(textareaRef.current);
  }, [composerText, autoResizeTextarea]);

  const updateComposer = useCallback(
    (next: string) => {
      setComposerText(next);
      setDraft("assistant", next);
      if (!next.startsWith("/") || next !== dismissedSlashQuery) {
        setDismissedSlashQuery(null);
      }
    },
    [setDraft, dismissedSlashQuery],
  );

  const slashPaletteOpen =
    /^\/([^\s\n]*)$/.test(composerText) &&
    dismissedSlashQuery !== composerText;
  const memorySlashHintOpen =
    !slashPaletteOpen && /^\/memory(?:\s|$)/i.test(composerText);

  // + Add Context Popover & Modals
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [historyModalOpen, setHistoryModalOpen] = useState(false);
  const [structuredModalOpen, setStructuredModalOpen] = useState(false);
  const [zoomBarOpen, setZoomBarOpen] = useState(false);
  const [zoomNlText, setZoomNlText] = useState("");
  const [agentProfileDialogOpen, setAgentProfileDialogOpen] = useState(false);

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
    setAgentProfileDialogOpen(false);
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
          answeredAt: Math.floor(Date.now() / 1000),
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
          const nowSec = Math.floor(Date.now() / 1000);
          setAssistantTurns(startGen, (prev) =>
            prev.map((item) =>
              item.id === entryId
                ? {
                    ...item,
                    status: "done",
                    answeredAt: nowSec,
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
        const nowSec = Math.floor(Date.now() / 1000);
        setAssistantTurns(startGen, (prev) =>
          prev.map((item) =>
            item.id === entryId
              ? {
                  ...item,
                  status: "done",
                  answeredAt: nowSec,
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

      if (!existingEntry) {
        if (/^\/memory\s+(?:edit|open|settings)\s*$/i.test(trimmed)) {
          router.push("/settings/memory");
          return;
        }
        const meetingSlashMatch = /^\/meeting(?:\s+(.*))?$/i.exec(trimmed);
        if (meetingSlashMatch && meetingSlashMatch[1]?.trim()) {
          await executeZoomBookingParse(meetingSlashMatch[1].trim());
          return;
        }
        if (isZoomMeetingIntent(trimmed)) {
          await executeZoomBookingParse(trimmed);
          return;
        }
      }

      const startGen = getAuthGeneration();
      const clientId = existingEntry?.clientId ?? generateClientId("turn");
      const entryId = existingEntry?.id ?? clientId;
      const conversationContext = buildConversationContext(
        getAssistantMemory(startGen).turns,
        entryId,
      );

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
        const result = await submitWorkbenchTurn(trimmed, clientId, {
          locale,
          conversationContext,
        });
        if (startGen !== getAuthGeneration()) return;
        const nowSec = Math.floor(Date.now() / 1000);
        setAssistantTurns(startGen, (prev) =>
          prev.map((item) =>
            item.id === entryId
              ? {
                  ...item,
                  status: "done",
                  answeredAt: nowSec,
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
      locale,
      router,
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
      const nowSec = Math.floor(Date.now() / 1000);
      setAssistantTurns(startGen, (prev) =>
        prev.map((item) =>
          item.id === entryId
            ? { ...item, status: "done", answeredAt: nowSec, brief: data }
            : item,
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
    setDismissedSlashQuery(null);
    void executeTurn(trimmed);
  };

  const handleComposerKeyDown = (
    e: React.KeyboardEvent<HTMLTextAreaElement>,
  ) => {
    if (
      composerText.trim() === "/memory" &&
      e.key === "Enter" &&
      !e.shiftKey &&
      !e.nativeEvent.isComposing
    ) {
      e.preventDefault();
      handleSendComposer();
      return;
    }
    if (paletteRef.current?.handleKeyDown(e)) {
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSendComposer();
    }
  };

  const handleSelectSlashSkill = useCallback(
    (skill: SlashSkillItem) => {
      if (skill.requires_args || skill.command === "/memory") {
        setDismissedSlashQuery(null);
        updateComposer(`${skill.command} `);
        requestAnimationFrame(() => {
          const el = textareaRef.current;
          if (el) {
            el.focus();
            const len = el.value.length;
            el.setSelectionRange(len, len);
          }
        });
        return;
      }

      clearDraft("assistant");
      setComposerText("");
      setDismissedSlashQuery(null);

      if (skill.command === "/exceptions") {
        router.push("/admin/exceptions");
        return;
      }
      if (skill.command === "/assurance") {
        router.push("/work");
        return;
      }
      void executeTurn(skill.command);
    },
    [clearDraft, executeTurn, router, updateComposer],
  );

  const handleSelectSuggestedAction = useCallback(
    (action: SuggestedAction) => {
      if (action.kind === "navigate") {
        router.push(action.href || "/work");
        return;
      }
      const cmd = action.command?.trim();
      if (!cmd) return;
      if (action.kind === "email" && /^\/email$/i.test(cmd)) {
        updateComposer("/email ");
        requestAnimationFrame(() => {
          textareaRef.current?.focus();
        });
        return;
      }
      void executeTurn(cmd);
    },
    [executeTurn, router, updateComposer],
  );

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
      const nowSec = Math.floor(Date.now() / 1000);
      setAssistantTurns(startGen, (prev) =>
        prev.map((item) =>
          item.id === entryId
            ? { ...item, status: "done", answeredAt: nowSec, result }
            : item,
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

  const streamItems = useMemo(() => {
    const items: Array<{
      kind: "user" | "agent";
      key: string;
      sender: "user" | "agent";
      createdAt: number;
      turn: AssistantTurnEntry;
    }> = [];
    for (const turn of turns) {
      if (turn.sourceKind !== "proactive_alert" && turn.userText) {
        items.push({
          kind: "user",
          key: `${turn.id}:user`,
          sender: "user",
          createdAt: turn.createdAt,
          turn,
        });
      }
      items.push({
        kind: "agent",
        key: `${turn.id}:agent`,
        sender: "agent",
        createdAt: turn.answeredAt ?? turn.createdAt,
        turn,
      });
    }
    return items;
  }, [turns]);

  const lastUserItemIdx = useMemo(() => {
    for (let i = streamItems.length - 1; i >= 0; i -= 1) {
      if (streamItems[i]!.kind === "user") return i;
    }
    return -1;
  }, [streamItems]);

  const agentSubtitle = actor?.warehouses.length
    ? sortWarehouses(actor.warehouses).join(" / ")
    : tx({
        "zh-CN": "智能业务助手",
        "zh-HK": "智能業務助手",
        en: "Business Agent",
      });

  return (
    <div
      data-testid="assistant-workspace"
      className="flex h-full min-h-0 flex-col bg-[var(--bg-sheet)]"
    >
      {/* Main Breathable Conversation Stream with Borderless Floating Header Overlay */}
      <div
        data-testid="assistant-feed"
        onScroll={(e) => setHeaderScrolled(e.currentTarget.scrollTop > 8)}
        className="min-h-0 flex-1 overflow-y-auto bg-[var(--bg-sheet)]"
      >
        <ConversationHeader
          scrolled={headerScrolled}
          leftSlot={
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
          }
          avatarSrc={agentAvatarSrc}
          avatarName={agentDisplayName}
          avatarFallbackText="AG"
          avatarKind="agent"
          avatarStatus="online"
          title={agentDisplayName}
          titleTestId="assistant-header-name"
          subtitle={agentSubtitle}
          onOpenProfile={() => setAgentProfileDialogOpen(true)}
          profileAriaLabel={tx(
            {
              "zh-CN": "查看 {name} 详情",
              "zh-HK": "檢視 {name} 詳情",
              en: "View {name} profile",
            },
            { name: agentDisplayName },
          )}
          rightSlot={
            <Link
              href="/work"
              data-testid="agent-open-workbench-btn"
              className="inline-flex h-8 sm:h-9 shrink-0 items-center gap-1.5 sm:gap-2 rounded-full bg-[var(--bg-surface)]/90 backdrop-blur-md border border-[var(--hairline)] px-2.5 sm:px-3.5 text-[12px] sm:text-[13px] font-medium text-[var(--ink-primary)] shadow-[var(--shadow-subtle)] hover:shadow-[var(--shadow-card)] hover:-translate-y-[0.5px] active:scale-[0.98] transition-all duration-[150ms]"
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
          }
        />

        <div className="mx-auto max-w-[740px] px-4 pt-[112px] pb-6 sm:px-8">
          {/* Whisper-Quiet Centered History Pill */}
          {historyItems.length > 0 && (
            <div className="mb-4 flex justify-center">
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
            <div className="flex flex-col items-center justify-center pt-[6vh] pb-6 text-center">
              <Avatar
                src={agentAvatarSrc}
                name={agentDisplayName}
                fallbackText="AG"
                size="xl"
                kind="agent"
                className="shadow-[var(--shadow-card)]"
              />
              <h3 className="aios-display mt-5 text-[22px] font-semibold text-[var(--ink-primary)] text-balance">
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

          {/* Active Conversation Stream (Burst-Grouped 5m Window + Centered Timestamp + Bottom-Most Delivery Receipt) */}
          {streamItems.map((item, idx) => {
            const { turn } = item;
            const pos = computeBubbleGroupPos(streamItems, idx, 300);
            const isGroupStart = pos === "single" || pos === "first";
            const showTail = shouldShowBubbleTail(pos);
            const prevCreatedAt =
              idx > 0 ? streamItems[idx - 1]!.createdAt : null;
            const showBurstTs = shouldShowBurstTimestamp(
              prevCreatedAt,
              item.createdAt,
            );

            const burstBanner = showBurstTs ? (
              <div
                className={[
                  "mb-3 flex justify-center",
                  idx === 0 ? "mt-0" : "mt-5",
                ].join(" ")}
              >
                <span className="rounded-full bg-[var(--bg-surface-subtle)]/80 px-2.5 py-0.5 text-[11px] font-medium text-[var(--ink-muted)] tabular-nums">
                  {formatBurstTimestamp(item.createdAt, locale)}
                </span>
              </div>
            ) : null;

            if (item.kind === "user") {
              const isBottomMostUser =
                idx === lastUserItemIdx && turn.status !== "error";
              let deliveryLabel: string | null = null;
              if (isBottomMostUser) {
                if (turn.status === "pending" && turn.waitingRetryAfter == null) {
                  deliveryLabel = tx({
                    "zh-CN": "发送中…",
                    "zh-HK": "傳送中…",
                    en: "Sending…",
                  });
                } else if (turn.status === "done" && turn.answeredAt) {
                  deliveryLabel = tx(
                    {
                      "zh-CN": "{time} 已读",
                      "zh-HK": "{time} 已讀",
                      en: "Read {time}",
                    },
                    { time: formatTimeOnly(turn.answeredAt) },
                  );
                } else {
                  deliveryLabel = tx({
                    "zh-CN": "已送达",
                    "zh-HK": "已送達",
                    en: "Delivered",
                  });
                }
              }

              return (
                <React.Fragment key={item.key}>
                  {burstBanner}
                  <div
                    className={[
                      "flex flex-col items-end pr-1.5",
                      idx === 0 || showBurstTs
                        ? ""
                        : isGroupStart
                          ? "mt-3.5"
                          : "mt-[3px]",
                    ].join(" ")}
                  >
                    <div
                      className={[
                        "imessage-bubble-sent relative max-w-[82%] bg-[var(--bubble-sent-bg)] px-4 py-[9px] text-[14.5px] leading-[1.5] text-[var(--bubble-sent-ink)] whitespace-pre-wrap break-words",
                        getBubbleRadiusClass("sent", pos),
                      ].join(" ")}
                    >
                      {turn.userText}
                      {showTail && <IMessageBubbleTail side="sent" />}
                    </div>

                    {deliveryLabel && (
                      <span
                        data-testid="assistant-delivery-status"
                        className="mt-1 mr-1 text-[11px] font-medium text-[var(--ink-muted)] tabular-nums"
                      >
                        {deliveryLabel}
                      </span>
                    )}
                  </div>
                </React.Fragment>
              );
            }

            const usesOwnBubbleAnimation =
              (turn.sourceKind === "proactive_alert" &&
                Boolean(turn.proactiveAlert)) ||
              (turn.status === "done" &&
                (turn.result?.kind === "message" ||
                  turn.result?.kind === "clarification"));

            return (
              <React.Fragment key={item.key}>
                {burstBanner}
                <div
                  data-testid={`assistant-turn-${turn.clientId}`}
                  className={[
                    usesOwnBubbleAnimation
                      ? "flex flex-col items-start pl-1.5"
                      : "aios-row-in flex flex-col items-start pl-1.5",
                    idx === 0 || showBurstTs
                      ? ""
                      : isGroupStart
                        ? "mt-3.5"
                        : "mt-[3px]",
                  ].join(" ")}
                >
                  <div className="w-full max-w-[92%] space-y-1.5">
                    {turn.sourceKind === "proactive_alert" &&
                      turn.proactiveAlert &&
                      (() => {
                        const alert = turn.proactiveAlert;
                        const isSecurityOrHigh =
                          alert.kind === "security_alert" ||
                          alert.severity === "critical" ||
                          alert.severity === "high";
                        return (
                          <div
                            data-testid={`proactive-alert-${alert.id}`}
                            className="flex w-full flex-col items-start gap-2"
                          >
                            <div
                              className={[
                                "imessage-bubble-received relative inline-block max-w-[90%] sm:max-w-[85%] bg-[var(--bubble-received-bg)] px-4 py-[9px] text-[var(--bubble-received-ink)]",
                                isSecurityOrHigh
                                  ? "border border-[var(--status-crimson-border)]"
                                  : "",
                                getBubbleRadiusClass("received", pos),
                              ]
                                .filter(Boolean)
                                .join(" ")}
                            >
                              <div className="flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.01em]">
                                {isSecurityOrHigh ? (
                                  <ShieldAlert
                                    className="h-3.5 w-3.5 shrink-0 text-[var(--status-crimson)]"
                                    strokeWidth={1.9}
                                  />
                                ) : (
                                  <Bell
                                    className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]"
                                    strokeWidth={1.9}
                                  />
                                )}
                                <span
                                  className={
                                    isSecurityOrHigh
                                      ? "text-[var(--status-crimson)]"
                                      : "text-[var(--accent-ink)]"
                                  }
                                >
                                  {alert.kind === "security_alert"
                                    ? tx({
                                        "zh-CN": "安全实时告警",
                                        "zh-HK": "安全即時告警",
                                        en: "Security Alert",
                                      })
                                    : tx({
                                        "zh-CN": "工作提醒",
                                        "zh-HK": "工作提醒",
                                        en: "Work Reminder",
                                      })}
                                </span>
                              </div>

                              <div className="mt-1 text-[14.5px] font-medium leading-[1.45] text-[var(--bubble-received-ink)]">
                                {alert.title}
                              </div>
                              {alert.subtitle && (
                                <p className="mt-1 text-[13.5px] leading-[1.48] text-[var(--ink-secondary)]">
                                  {alert.subtitle}
                                </p>
                              )}
                              {showTail && (
                                <IMessageBubbleTail side="received" />
                              )}
                            </div>

                            <div className="flex max-w-[90%] sm:max-w-[85%] flex-wrap items-center gap-2">
                              {alert.reference && (
                                <span className="rounded-full border border-[var(--hairline)] bg-[var(--bg-surface)]/85 px-2.5 py-0.5 font-mono-code text-[11px] tabular-nums text-[var(--ink-muted)]">
                                  {alert.reference}
                                </span>
                              )}
                              <Link
                                href={alert.href || "/work"}
                                className="inline-flex items-center gap-1 rounded-full bg-[var(--accent-solid)] px-3 py-1 text-[12px] font-medium text-[var(--accent-fg)] hover:bg-[var(--accent-solid-hover)] transition-colors"
                              >
                                <span>
                                  {tx({
                                    "zh-CN": "查看处理",
                                    "zh-HK": "檢視處理",
                                    en: "View & Handle",
                                  })}
                                </span>
                                <ArrowUpRight className="h-3 w-3" />
                              </Link>
                            </div>
                          </div>
                        );
                      })()}
                    {turn.sourceKind === "zoom_booking" && turn.zoomBooking && (
                      <ZoomBookingCard
                        parsing={turn.zoomBooking.phase === "parsing"}
                        parseError={turn.zoomBooking.errorMessage}
                        preview={turn.zoomBooking.preview}
                        confirmed={turn.zoomBooking.confirmed}
                        onConfirmed={(confirmed) => {
                          const gen = getAuthGeneration();
                          const nowSec = Math.floor(Date.now() / 1000);
                          setAssistantTurns(gen, (prev) =>
                            prev.map((itemEntry) =>
                              itemEntry.id === turn.id
                                ? {
                                    ...itemEntry,
                                    status: "done",
                                    answeredAt: nowSec,
                                    zoomBooking: {
                                      ...itemEntry.zoomBooking,
                                      phase: "confirmed",
                                      confirmed,
                                    },
                                  }
                                : itemEntry,
                            ),
                          );
                        }}
                        onDismiss={() => {
                          const gen = getAuthGeneration();
                          setAssistantTurns(gen, (prev) =>
                            prev.filter((itemEntry) => itemEntry.id !== turn.id),
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
                              className="overflow-hidden rounded-[var(--radius-chat-card)] border border-[var(--hairline)] bg-[var(--bg-surface)] shadow-[var(--shadow-card)]"
                            >
                              <div className="flex items-center justify-between bg-[var(--bg-surface-tint)] px-4 py-2.5 border-b border-[var(--hairline)]">
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
                                  <div className="rounded-tile border border-[var(--hairline)] bg-[var(--bg-surface-tint)] p-3">
                                    <div className="aios-micro-label">
                                      {t("assistant.brief.pendingApprovals")}
                                    </div>
                                    <div className="aios-kpi mt-1 text-[22px] font-semibold text-[var(--ink-primary)]">
                                      {turn.brief.pending_approvals}
                                      {turn.brief.pending_approvals_capped ? "+" : ""}
                                    </div>
                                  </div>
                                  <div className="rounded-tile border border-[var(--hairline)] bg-[var(--bg-surface-tint)] p-3">
                                    <div className="aios-micro-label">
                                      {tx({
                                        "zh-CN": "今日会议",
                                        "zh-HK": "今日會議",
                                        en: "Meetings Today",
                                      })}
                                    </div>
                                    <div className="aios-kpi mt-1 text-[22px] font-semibold text-[var(--ink-primary)]">
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
                            {turn.result.kind !== "message" &&
                              turn.result.kind !== "clarification" &&
                              turn.result.kind !== "refusal" && (
                                <BriefProgressChain
                                  phase="done"
                                  actor={actor}
                                  result={turn.result}
                                />
                              )}
                            <TurnResultCard
                              result={turn.result}
                              capabilities={capabilities}
                              timestamp={turn.createdAt}
                              bubbleTail={showTail}
                              bubbleRadiusClass={getBubbleRadiusClass(
                                "received",
                                pos,
                              )}
                              initialEmailSent={turn.emailSent}
                              onEmailSent={(sentRes) => {
                                const gen = getAuthGeneration();
                                setAssistantTurns(gen, (prev) =>
                                  prev.map((itemEntry) =>
                                    itemEntry.id === turn.id
                                      ? { ...itemEntry, emailSent: sentRes }
                                      : itemEntry,
                                  ),
                                );
                              }}
                              onSelectClarification={(prompt) =>
                                void executeTurn(prompt)
                              }
                              onSelectSuggestedAction={handleSelectSuggestedAction}
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
              </React.Fragment>
            );
          })}

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
              className="flex flex-wrap items-center gap-2 rounded-[var(--radius-chat-card)] bg-[var(--bg-surface)] p-2.5 pl-3.5 shadow-[var(--shadow-card)] ring-1 ring-[var(--accent-border)]"
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

          {/* Floating Slash Command Palette directly above Composer */}
          <SlashCommandPalette
            ref={paletteRef}
            composerText={composerText}
            open={slashPaletteOpen}
            onSelectSkill={handleSelectSlashSkill}
            onDismiss={() => setDismissedSlashQuery(composerText)}
          />

          {memorySlashHintOpen && (
            <div
              data-testid="memory-slash-helper"
              className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-[var(--hairline)] bg-[var(--bg-surface)] px-3 py-2 text-[12px] shadow-[var(--shadow-subtle)]"
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="inline-flex items-center gap-1.5 pr-1 font-medium text-[var(--ink-secondary)]">
                  <BookOpen
                    className="h-3.5 w-3.5 text-[var(--accent)]"
                    strokeWidth={1.85}
                  />
                  <span className="font-mono-code text-[11.5px] text-[var(--ink-primary)]">
                    /memory
                  </span>
                </span>
                <button
                  type="button"
                  disabled={hasPendingTurn}
                  onClick={() => {
                    clearDraft("assistant");
                    setComposerText("");
                    setDismissedSlashQuery(null);
                    void executeTurn("/memory view");
                  }}
                  className="rounded-full bg-[var(--bg-surface-subtle)] px-2.5 py-1 font-mono-code text-[11px] text-[var(--ink-secondary)] hover:bg-[var(--accent-wash)] hover:text-[var(--accent-ink)] transition-colors cursor-pointer disabled:opacity-50"
                >
                  view
                </button>
                <button
                  type="button"
                  onClick={() => {
                    updateComposer("/memory add ");
                    requestAnimationFrame(() => textareaRef.current?.focus());
                  }}
                  className="rounded-full bg-[var(--bg-surface-subtle)] px-2.5 py-1 font-mono-code text-[11px] text-[var(--ink-secondary)] hover:bg-[var(--accent-wash)] hover:text-[var(--accent-ink)] transition-colors cursor-pointer"
                >
                  add &lt;fact&gt;
                </button>
                <button
                  type="button"
                  onClick={() => {
                    updateComposer("/memory forget ");
                    requestAnimationFrame(() => textareaRef.current?.focus());
                  }}
                  className="rounded-full bg-[var(--bg-surface-subtle)] px-2.5 py-1 font-mono-code text-[11px] text-[var(--ink-secondary)] hover:bg-[var(--accent-wash)] hover:text-[var(--accent-ink)] transition-colors cursor-pointer"
                >
                  forget &lt;query&gt;
                </button>
                <button
                  type="button"
                  disabled={hasPendingTurn}
                  onClick={() => {
                    clearDraft("assistant");
                    setComposerText("");
                    setDismissedSlashQuery(null);
                    void executeTurn("/memory tidy");
                  }}
                  className="rounded-full bg-[var(--bg-surface-subtle)] px-2.5 py-1 font-mono-code text-[11px] text-[var(--ink-secondary)] hover:bg-[var(--accent-wash)] hover:text-[var(--accent-ink)] transition-colors cursor-pointer disabled:opacity-50"
                >
                  tidy
                </button>
              </div>
              <Link
                href="/settings/memory"
                data-testid="memory-slash-open-editor"
                className="inline-flex items-center gap-1 rounded-full border border-[var(--hairline)] bg-[var(--bg-surface-subtle)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--ink-primary)] hover:border-[var(--accent-border)] hover:text-[var(--accent-ink)] transition-colors"
              >
                <span>
                  {tx({
                    "zh-CN": "打开 MEMORY.md",
                    "zh-HK": "開啟 MEMORY.md",
                    en: "Edit MEMORY.md",
                  })}
                </span>
                <ArrowUpRight className="h-3 w-3" strokeWidth={1.85} />
              </Link>
            </div>
          )}

          {/* Muse Floating Capsule Composer (24px Organic Pill Radius — STRICTLY TWO CONTROLS: + 添加上下文 & ↑ Send) */}
          <div className="rounded-[var(--radius-composer)] border border-[var(--hairline)] bg-[var(--bg-surface)] shadow-[var(--shadow-composer)] focus-within:border-[var(--accent)] focus-within:shadow-[var(--shadow-composer-focus)] transition-all duration-[200ms]">
            <div className="px-4 pt-2.5 pb-1">
              <textarea
                ref={textareaRef}
                data-composer-input
                data-testid="assistant-composer-input"
                rows={1}
                maxLength={2000}
                value={composerText}
                onChange={(e) => updateComposer(e.target.value)}
                onKeyDown={handleComposerKeyDown}
                placeholder={tx(
                  {
                    "zh-CN": "给{name}发消息，或输入 / 唤醒技能…",
                    "zh-HK": "傳訊息給{name}，或輸入 / 喚醒技能…",
                    en: "Message {name}, or type / for skills…",
                  },
                  { name: agentDisplayName },
                )}
                style={{ outline: "none" }}
                className="block max-h-[160px] min-h-[24px] w-full resize-none border-0 bg-transparent text-[14.5px] leading-[24px] text-[var(--ink-primary)] placeholder:text-[var(--ink-faint)] focus:outline-none focus:ring-0"
              />
            </div>

            <div className="flex items-center justify-between gap-2 px-3 pb-2 pt-0.5">
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
                    className="aios-popover-content z-50 w-[296px] rounded-card border border-[var(--hairline-strong)] bg-[var(--bg-surface)] p-2 shadow-[var(--shadow-popover)] focus:outline-none"
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

                      <Link
                        href="/settings/memory"
                        data-testid="context-menu-memory"
                        onClick={() => setContextMenuOpen(false)}
                        className="flex items-center justify-between gap-2 rounded-sm px-3 py-2 text-[13px] text-[var(--ink-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                      >
                        <span className="flex min-w-0 items-center gap-2.5">
                          <BookOpen
                            className="h-4 w-4 shrink-0 text-[var(--ink-muted)]"
                            strokeWidth={1.85}
                          />
                          <span className="min-w-0">
                            <span className="block truncate font-medium leading-tight">
                              {tx({
                                "zh-CN": "长期记忆 MEMORY.md",
                                "zh-HK": "長期記憶 MEMORY.md",
                                en: "Long-Term Memory",
                              })}
                            </span>
                            <span className="mt-0.5 block truncate text-[11px] font-normal text-[var(--ink-muted)]">
                              {tx({
                                "zh-CN": "查看与编辑跨会话偏好",
                                "zh-HK": "檢視與編輯跨會話偏好",
                                en: "View & edit cross-session preferences",
                              })}
                            </span>
                          </span>
                        </span>
                        <ArrowUpRight
                          className="h-3.5 w-3.5 shrink-0 text-[var(--ink-faint)]"
                          strokeWidth={1.85}
                        />
                      </Link>
                    </div>

                    {quickPromptOptions.length > 0 && (
                      <div className="mt-2 border-t border-[var(--hairline)] pt-2">
                        <div className="aios-micro-label px-3 pb-1.5">
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
                {composerText.length > 1700 && (
                  <span className="font-mono-code text-[11px] text-[var(--ink-muted)] tabular-nums">
                    {composerText.length}/2000
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
            <div className="relative mt-1.5">
              <select
                value={selectedToolId}
                onChange={(e) => setSelectedToolId(e.target.value)}
                className="aios-select h-10 w-full text-[13px]"
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
              <ChevronDown
                className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--ink-muted)]"
                strokeWidth={1.85}
                aria-hidden="true"
              />
            </div>
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
              <div className="relative mt-1.5">
                <select
                  value={toolWarehouse}
                  onChange={(e) => setToolWarehouse(e.target.value)}
                  className="aios-select h-10 w-full font-mono-code text-[13px]"
                >
                  {sortWarehouses(selectedToolMeta.warehouses).map((wh) => (
                    <option key={wh} value={wh}>
                      {wh}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--ink-muted)]"
                  strokeWidth={1.85}
                  aria-hidden="true"
                />
              </div>
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

      {/* Personal Agent Profile & Sealed Policy Integrity Dialog */}
      <ContactProfileDialog
        open={agentProfileDialogOpen}
        onOpenChange={setAgentProfileDialogOpen}
        target={{
          kind: "agent",
          displayName: agentDisplayName,
          avatarSrc: agentAvatarSrc,
        }}
      />
    </div>
  );
}
