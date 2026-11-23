"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowUp,
  CalendarPlus,
  ChevronLeft,
  RefreshCw,
  Users,
} from "lucide-react";
import {
  generateClientId,
  getAuthGeneration,
  isApiError,
  isStaleAuthError,
  type ApiError,
} from "@/lib/api-client";
import {
  PERSONA_LOCALIZATIONS,
  formatChatMessageBody,
  formatChatRoomTitle,
  localizeContactJobTitle,
  useLocale,
} from "@/lib/i18n";
import { useSession } from "@/lib/session-context";
import { useWorkbench } from "@/lib/workbench-context";
import {
  ContactProfileDialog,
  loadDirectoryContactsCached,
  mapContactAvailabilityToAvatarStatus,
  type ContactProfileDialogTarget,
} from "@/components/chat/ContactProfileDialog";
import { ConversationHeader } from "@/components/chat/ConversationHeader";
import { subscribeChatSseEvents } from "@/components/shell/ProactiveAgentNotifier";
import { AccessNoticeCard } from "@/components/ui/AccessNoticeCard";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { MarkdownMessage } from "@/components/ui/MarkdownMessage";
import {
  fetchRoomMemberProfile,
  fetchRoomMembers,
  fetchRoomMessages,
  fetchRoomReceipts,
  getRoomMemberAvatarUrl,
  markRoomRead,
  postRoomMessage,
} from "@/features/chat/api";
import { MeetingDraftModal } from "@/features/chat/MeetingDraftModal";
import { RoomMembersPanel } from "@/features/chat/RoomMembersPanel";
import { fetchChatRooms } from "@/features/inbox/api";
import {
  IMessageBubbleTail,
  computeBubbleGroupPos,
  formatBurstTimestamp,
  getBubbleRadiusClass,
  shouldShowBubbleTail,
  shouldShowBurstTimestamp,
} from "@/features/inbox/bubble-group";
import type {
  ChatMessage,
  ChatReadReceipt,
  ChatRoom,
  CompanyContact,
  Profile,
} from "@/lib/types";

interface PendingFailedMessage {
  clientId: string;
  text: string;
  status: "sending" | "failed";
  errorMessage: string | null;
  conflictMismatch?: boolean;
}

const POLL_INTERVAL_MS = 5000;

/**
 * Preserves intentional Shift+Enter line breaks inside Markdown paragraphs while
 * leaving headings, lists, blockquotes, tables, and fenced code blocks untouched.
 */
function prepareChatMarkdown(raw: string): string {
  const lines = raw.split("\n");
  const out: string[] = [];
  let inFence = false;
  const isBlockLine = (line: string) =>
    /^\s*(?:#{1,6}\s|[-*+]\s|\d+\.\s|>\s|\||```|~~~|(?:---+|\*\*\*+)\s*$)/.test(
      line,
    ) || line.trim() === "";

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    const next = i < lines.length - 1 ? lines[i + 1]! : null;
    if (
      !inFence &&
      next !== null &&
      !isBlockLine(line) &&
      !isBlockLine(next) &&
      !line.endsWith("  ")
    ) {
      out.push(`${line}  `);
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
}

export function ChatRoomWorkspace({ roomId }: { roomId: string }) {
  const router = useRouter();
  const {
    status,
    actor,
    capabilities,
    profile: selfProfile,
    avatarVersion,
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
  } = useWorkbench();
  const {
    locale,
    tp,
    tx,
    formatTimeOnly,
    localizePersona,
    localizeError,
  } = useLocale();

  const [roomMeta, setRoomMeta] = useState<ChatRoom | null>(null);
  const [members, setMembers] = useState<string[]>([]);
  const [memberProfiles, setMemberProfiles] = useState<Record<string, Profile>>(
    {},
  );
  const [directoryContacts, setDirectoryContacts] = useState<
    Record<string, CompanyContact>
  >({});
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [readReceipts, setReadReceipts] = useState<
    Record<string, ChatReadReceipt>
  >({});
  const [pendingOutbound, setPendingOutbound] = useState<
    PendingFailedMessage[]
  >([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const [accessError, setAccessError] = useState<ApiError | null>(null);
  const [meetingModalOpen, setMeetingModalOpen] = useState(false);
  const [profileDialogTarget, setProfileDialogTarget] =
    useState<ContactProfileDialogTarget | null>(null);

  const draftKey = `room:${roomId}`;
  const [composerText, setComposerText] = useState<string>(() =>
    getDraft(draftKey),
  );

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const lastSeqRef = useRef<number>(0);
  const lastMarkedReadSeqRef = useRef<number>(0);
  const fetchedSubjectsRef = useRef<Set<string>>(new Set());
  const pollTimerRef = useRef<number | null>(null);
  const pollStoppedRef = useRef(false);
  const feedEndRef = useRef<HTMLDivElement | null>(null);

  const chatAvailable = Boolean(capabilities?.chat_available);

  const resolveMemberDisplayName = useCallback(
    (subject: string, prof?: Profile | null) => {
      const raw = prof?.display_name?.trim();
      const known =
        PERSONA_LOCALIZATIONS[subject as keyof typeof PERSONA_LOCALIZATIONS];
      if (
        raw &&
        (!known ||
          (raw !== known["zh-CN"].displayName &&
            raw !== known["zh-HK"].displayName &&
            raw !== known.en.displayName))
      ) {
        return raw;
      }
      if (known) {
        return localizePersona(subject).displayName;
      }
      return raw || subject;
    },
    [localizePersona],
  );

  const mergeReadReceipts = useCallback(
    (incoming?: ChatReadReceipt[]) => {
      if (!incoming || incoming.length === 0) return;
      setReadReceipts((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const item of incoming) {
          if (!item || !item.subject) continue;
          const existing = next[item.subject];
          if (
            !existing ||
            item.last_read_seq > existing.last_read_seq ||
            (item.last_read_seq === existing.last_read_seq &&
              item.read_at > existing.read_at)
          ) {
            next[item.subject] = item;
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    },
    [],
  );

  const markLatestVisibleRead = useCallback(
    (latestSeq: number) => {
      if (latestSeq <= 0 || latestSeq <= lastMarkedReadSeqRef.current) return;
      if (
        typeof document !== "undefined" &&
        document.visibilityState !== "visible"
      ) {
        return;
      }
      const startGen = getAuthGeneration();
      lastMarkedReadSeqRef.current = latestSeq;
      void markRoomRead(roomId, latestSeq)
        .then((res) => {
          if (startGen !== getAuthGeneration()) return;
          if (res && res.subject) {
            mergeReadReceipts([
              {
                subject: res.subject,
                last_read_seq: res.last_read_seq,
                read_at: res.read_at,
              },
            ]);
          }
        })
        .catch(() => {
          // Non-fatal: revert optimistic watermark so next poll retries cleanly
          if (lastMarkedReadSeqRef.current === latestSeq) {
            lastMarkedReadSeqRef.current = Math.max(0, latestSeq - 1);
          }
        });
    },
    [roomId, mergeReadReceipts],
  );

  const autoResizeTextarea = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(150, Math.max(32, el.scrollHeight))}px`;
  }, []);

  useEffect(() => {
    autoResizeTextarea(textareaRef.current);
  }, [composerText, autoResizeTextarea]);

  const stopPolling = useCallback(() => {
    pollStoppedRef.current = true;
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const purgeRoomState = useCallback(() => {
    stopPolling();
    lastSeqRef.current = 0;
    lastMarkedReadSeqRef.current = 0;
    fetchedSubjectsRef.current.clear();
    setRoomMeta(null);
    setMembers([]);
    setMemberProfiles({});
    setMessages([]);
    setReadReceipts({});
    setPendingOutbound([]);
    setMeetingModalOpen(false);
    setProfileDialogTarget(null);
  }, [stopPolling]);

  useEffect(() => {
    setComposerText(getDraft(draftKey));
  }, [draftKey, authGeneration, getDraft]);

  const updateComposer = useCallback(
    (next: string) => {
      setComposerText(next);
      setDraft(draftKey, next);
    },
    [draftKey, setDraft],
  );

  const hydrateProfiles = useCallback(
    async (subjects: string[], startGen: number) => {
      const toFetch = subjects.filter(
        (sub) =>
          sub &&
          sub !== actor?.subject &&
          !fetchedSubjectsRef.current.has(sub),
      );
      if (toFetch.length === 0) return;

      for (const sub of toFetch) {
        fetchedSubjectsRef.current.add(sub);
      }

      const settled = await Promise.allSettled(
        toFetch.map(async (sub) => {
          const prof = await fetchRoomMemberProfile(roomId, sub);
          return { sub, prof };
        }),
      );
      if (startGen !== getAuthGeneration()) return;

      setMemberProfiles((prev) => {
        const next = { ...prev };
        for (const res of settled) {
          if (res.status === "fulfilled") {
            next[res.value.sub] = res.value.prof;
          }
        }
        return next;
      });
    },
    [roomId, actor?.subject],
  );

  const handleFatalRoomError = useCallback(
    (err: ApiError) => {
      purgeRoomState();
      clearSelectedObject();
      if (err.code === "ACCESS_CHANGED") {
        void handleAccessChanged();
      }
      setAccessError(err);
    },
    [purgeRoomState, clearSelectedObject, handleAccessChanged],
  );

  const loadMembersOnly = useCallback(
    async (removedSubject?: string) => {
      const startGen = getAuthGeneration();
      if (removedSubject) {
        fetchedSubjectsRef.current.delete(removedSubject);
        setMemberProfiles((prev) => {
          const next = { ...prev };
          delete next[removedSubject];
          return next;
        });
      }
      try {
        const memberRes = await fetchRoomMembers(roomId, { limit: 100 });
        if (startGen !== getAuthGeneration()) return;
        setMembers(memberRes.items);
        void hydrateProfiles(memberRes.items, startGen);
      } catch (err) {
        if (isStaleAuthError(err)) return;
        if (
          isApiError(err) &&
          (err.status === 401 || err.status === 403 || err.status === 404)
        ) {
          handleFatalRoomError(err);
        }
      }
    },
    [roomId, hydrateProfiles, handleFatalRoomError],
  );

  const pollIncrementalMessages = useCallback(async () => {
    if (pollStoppedRef.current) return;
    if (
      typeof document !== "undefined" &&
      document.visibilityState !== "visible"
    ) {
      return;
    }
    const startGen = getAuthGeneration();
    try {
      const res = await fetchRoomMessages(roomId, {
        limit: 50,
        after: lastSeqRef.current,
      });
      if (startGen !== getAuthGeneration() || pollStoppedRef.current) return;
      mergeReadReceipts(res.read_receipts);
      if (res.items.length > 0) {
        const authors = new Set<string>();
        let newestSeq = lastSeqRef.current;
        setMessages((prev) => {
          const seen = new Set(prev.map((m) => m.seq));
          const merged = [...prev];
          for (const item of res.items) {
            authors.add(item.author);
            if (!seen.has(item.seq)) {
              seen.add(item.seq);
              merged.push(item);
            }
            if (item.seq > newestSeq) {
              newestSeq = item.seq;
            }
          }
          lastSeqRef.current = newestSeq;
          merged.sort((a, b) => a.seq - b.seq);
          return merged;
        });
        void hydrateProfiles(Array.from(authors), startGen);
        if (newestSeq > lastMarkedReadSeqRef.current) {
          markLatestVisibleRead(newestSeq);
        }
      }
    } catch (err) {
      if (isStaleAuthError(err)) {
        stopPolling();
        return;
      }
      if (isApiError(err)) {
        if (err.status === 401 || err.status === 403 || err.status === 404) {
          handleFatalRoomError(err);
        }
      }
    }
  }, [
    roomId,
    hydrateProfiles,
    stopPolling,
    handleFatalRoomError,
    mergeReadReceipts,
    markLatestVisibleRead,
  ]);

  // Load cached tenant directory metadata for subtitle & availability indicator
  useEffect(() => {
    if (status !== "authenticated" || !chatAvailable) {
      setDirectoryContacts({});
      return;
    }
    let cancelled = false;
    const expectedGen = authGeneration;
    void loadDirectoryContactsCached(expectedGen).then((items) => {
      if (cancelled || expectedGen !== getAuthGeneration()) return;
      const map: Record<string, CompanyContact> = {};
      for (const item of items) {
        map[item.subject] = item;
      }
      setDirectoryContacts(map);
    });
    return () => {
      cancelled = true;
    };
  }, [status, chatAvailable, authGeneration]);

  useEffect(() => {
    purgeRoomState();
    setAccessError(null);

    if (status !== "authenticated") return;
    if (capabilities && !chatAvailable) {
      setInitialLoading(false);
      return;
    }

    let cancelled = false;
    const startGen = getAuthGeneration();
    pollStoppedRef.current = false;
    setInitialLoading(true);

    (async () => {
      try {
        const [membersRes, messagesRes, roomsRes] = await Promise.all([
          fetchRoomMembers(roomId, { limit: 100 }),
          fetchRoomMessages(roomId, { limit: 100, after: 0 }),
          fetchChatRooms({ limit: 100 }).catch(() => ({
            items: [],
            next: null,
          })),
        ]);

        if (cancelled || startGen !== getAuthGeneration()) return;

        const matchedRoom =
          roomsRes.items.find((r) => r.id === roomId) ?? null;
        setRoomMeta(matchedRoom);
        setMembers(membersRes.items);

        if (messagesRes.read_receipts) {
          mergeReadReceipts(messagesRes.read_receipts);
        }

        let allMessages = [...messagesRes.items];
        let nextSeq = messagesRes.next;
        let safetyPages = 0;
        while (nextSeq !== null && safetyPages < 5) {
          const more = await fetchRoomMessages(roomId, {
            limit: 100,
            after: nextSeq,
          });
          if (cancelled || startGen !== getAuthGeneration()) return;
          if (more.read_receipts) {
            mergeReadReceipts(more.read_receipts);
          }
          allMessages = [...allMessages, ...more.items];
          nextSeq = more.next;
          safetyPages += 1;
        }

        if (!messagesRes.read_receipts) {
          fetchRoomReceipts(roomId)
            .then((rcpt) => {
              if (!cancelled && startGen === getAuthGeneration()) {
                mergeReadReceipts(rcpt.items);
              }
            })
            .catch(() => {
              // Non-blocking if receipts endpoint unavailable
            });
        }

        const bySeq = new Map<number, ChatMessage>();
        const authorSet = new Set<string>(membersRes.items);
        for (const msg of allMessages) {
          bySeq.set(msg.seq, msg);
          authorSet.add(msg.author);
          if (msg.seq > lastSeqRef.current) {
            lastSeqRef.current = msg.seq;
          }
        }
        const sorted = Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);
        setMessages(sorted);
        setInitialLoading(false);

        if (lastSeqRef.current > 0) {
          markLatestVisibleRead(lastSeqRef.current);
        }

        void hydrateProfiles(Array.from(authorSet), startGen);

        requestAnimationFrame(() => {
          feedEndRef.current?.scrollIntoView({ behavior: "auto" });
        });

        if (!cancelled && !pollStoppedRef.current) {
          pollTimerRef.current = window.setInterval(() => {
            void pollIncrementalMessages();
          }, POLL_INTERVAL_MS);
        }
      } catch (err) {
        if (
          cancelled ||
          isStaleAuthError(err) ||
          startGen !== getAuthGeneration()
        ) {
          return;
        }
        setInitialLoading(false);
        if (isApiError(err)) {
          handleFatalRoomError(err);
        }
      }
    })();

    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [
    roomId,
    status,
    authGeneration,
    capabilities,
    chatAvailable,
    purgeRoomState,
    hydrateProfiles,
    handleFatalRoomError,
    pollIncrementalMessages,
    stopPolling,
    mergeReadReceipts,
    markLatestVisibleRead,
  ]);

  // Subscribe to live SSE chat_read & chat_message broadcasts from ProactiveAgentNotifier
  useEffect(() => {
    if (status !== "authenticated" || !chatAvailable) return;
    return subscribeChatSseEvents(authGeneration, (ev) => {
      if (ev.roomId !== roomId) return;
      if (ev.kind === "chat_read") {
        if (ev.subject !== actor?.subject) {
          mergeReadReceipts([
            {
              subject: ev.subject,
              last_read_seq: ev.lastReadSeq,
              read_at: ev.readAt,
            },
          ]);
        }
      } else if (ev.kind === "chat_message") {
        void pollIncrementalMessages();
      }
    });
  }, [
    status,
    chatAvailable,
    authGeneration,
    roomId,
    actor?.subject,
    mergeReadReceipts,
    pollIncrementalMessages,
  ]);

  // Mark visible messages read when user returns to tab
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible" && lastSeqRef.current > 0) {
        markLatestVisibleRead(lastSeqRef.current);
        void pollIncrementalMessages();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [markLatestVisibleRead, pollIncrementalMessages]);

  useEffect(() => {
    if (
      selectedObject?.kind === "room-members" &&
      selectedObject.id === roomId &&
      !accessError
    ) {
      setCustomDrawerContent(
        <RoomMembersPanel
          roomId={roomId}
          roomOwner={roomMeta?.owner ?? null}
          members={members}
          memberProfiles={memberProfiles}
          onMembersChanged={(removed) => void loadMembersOnly(removed)}
        />,
      );
      return;
    }
    if (selectedObject?.kind === "room-members") {
      setCustomDrawerContent(null);
    }
  }, [
    selectedObject,
    roomId,
    roomMeta?.owner,
    members,
    memberProfiles,
    accessError,
    loadMembersOnly,
    setCustomDrawerContent,
  ]);

  useEffect(() => {
    return () => {
      setCustomDrawerContent(null);
    };
  }, [setCustomDrawerContent]);

  useEffect(() => {
    const latest = messages[messages.length - 1];
    if (!latest) return;
    window.dispatchEvent(
      new CustomEvent("aios:room-preview", {
        detail: {
          roomId,
          text: latest.text,
          createdAt: latest.created_at,
        },
      }),
    );
  }, [roomId, messages]);

  const sendWithClientId = useCallback(
    async (text: string, clientId: string, isRetry: boolean) => {
      const startGen = getAuthGeneration();
      if (isRetry) {
        setPendingOutbound((prev) =>
          prev.map((p) =>
            p.clientId === clientId
              ? {
                  ...p,
                  status: "sending",
                  errorMessage: null,
                  conflictMismatch: false,
                }
              : p,
          ),
        );
      } else {
        setPendingOutbound((prev) => [
          ...prev,
          { clientId, text, status: "sending", errorMessage: null },
        ]);
        requestAnimationFrame(() => {
          feedEndRef.current?.scrollIntoView({ behavior: "smooth" });
        });
      }

      try {
        const posted = await postRoomMessage(roomId, {
          client_id: clientId,
          text,
        });
        if (startGen !== getAuthGeneration()) return;

        setPendingOutbound((prev) =>
          prev.filter((p) => p.clientId !== clientId),
        );
        setMessages((prev) => {
          if (prev.some((m) => m.seq === posted.seq)) return prev;
          const next = [...prev, posted].sort((a, b) => a.seq - b.seq);
          if (posted.seq > lastSeqRef.current) {
            lastSeqRef.current = posted.seq;
          }
          return next;
        });
        markLatestVisibleRead(posted.seq);
        requestAnimationFrame(() => {
          feedEndRef.current?.scrollIntoView({ behavior: "smooth" });
        });
      } catch (err) {
        if (isStaleAuthError(err) || startGen !== getAuthGeneration()) return;
        if (isApiError(err)) {
          if (err.status === 403 || err.status === 404) {
            handleFatalRoomError(err);
            return;
          }
          setPendingOutbound((prev) =>
            prev.map((p) =>
              p.clientId === clientId
                ? {
                    ...p,
                    status: "failed",
                    errorMessage: localizeError(err),
                    conflictMismatch: err.status === 409,
                  }
                : p,
            ),
          );
          return;
        }
        setPendingOutbound((prev) =>
          prev.map((p) =>
            p.clientId === clientId
              ? {
                  ...p,
                  status: "failed",
                  errorMessage: tx({
                    "zh-CN": "网络异常，消息未送达，请点击重试。",
                    "zh-HK": "網路異常，訊息未送達，請點擊重試。",
                    en: "Network error. Message not delivered — tap retry.",
                  }),
                }
              : p,
          ),
        );
      }
    },
    [roomId, handleFatalRoomError, localizeError, markLatestVisibleRead, tx],
  );

  const handleSend = () => {
    const trimmed = composerText.trim();
    if (!trimmed) return;
    const clientId = generateClientId("msg");
    clearDraft(draftKey);
    setComposerText("");
    void sendWithClientId(trimmed, clientId, false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  };

  const groupItems = useMemo(
    () => messages.map((m) => ({ sender: m.author, createdAt: m.created_at })),
    [messages],
  );

  const hasSendingPending = useMemo(
    () => pendingOutbound.some((p) => p.status === "sending"),
    [pendingOutbound],
  );

  const lastSelfMsgIndex = useMemo(() => {
    if (!actor?.subject) return -1;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]!.author === actor.subject) return i;
    }
    return -1;
  }, [messages, actor?.subject]);

  // Derive peer avatar & job title when room is a 1:1 DM
  const otherPeer = useMemo(() => {
    if (!actor || members.length !== 2) return null;
    const other = members.find((m) => m !== actor.subject);
    if (!other) return null;
    const prof = memberProfiles[other];
    const dir = directoryContacts[other];
    const known =
      PERSONA_LOCALIZATIONS[other as keyof typeof PERSONA_LOCALIZATIONS];
    const jobTitle = dir?.job_title
      ? localizeContactJobTitle(dir.job_title, other, locale)
      : known
        ? localizePersona(other).label
        : null;
    return {
      subject: other,
      name: resolveMemberDisplayName(other, prof),
      jobTitle,
      availability: mapContactAvailabilityToAvatarStatus(dir?.availability),
      avatarSrc: prof?.has_avatar
        ? getRoomMemberAvatarUrl(roomId, other, prof.version, authGeneration)
        : null,
    };
  }, [
    actor,
    members,
    memberProfiles,
    directoryContacts,
    roomId,
    authGeneration,
    locale,
    localizePersona,
    resolveMemberDisplayName,
  ]);

  if (capabilities && !chatAvailable) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--bg-app)] p-6">
        <div className="w-full max-w-[460px]">
          <AccessNoticeCard
            variant="ACCESS_RESTRICTED"
            title={tx({
              "zh-CN": "协作会话未启用",
              "zh-HK": "協作對話未啟用",
              en: "Team Chat Disabled",
            })}
            message={tx({
              "zh-CN": "当前账号未获授员工协作会话权限，无法访问此会话。",
              "zh-HK": "目前帳號未獲授員工協作對話權限，無法存取此對話。",
              en: "Your account does not have permission to access team chat rooms.",
            })}
            backHref="/inbox/assistant"
            backLabel={tx({
              "zh-CN": "返回个人业务助手",
              "zh-HK": "返回個人業務助手",
              en: "Back to Personal Agent",
            })}
          />
        </div>
      </div>
    );
  }

  if (accessError) {
    return (
      <div
        data-testid="room-access-error"
        className="flex h-full items-center justify-center bg-[var(--bg-app)] p-6"
      >
        <div className="w-full max-w-[460px]">
          <AccessNoticeCard
            error={accessError}
            backHref="/inbox"
            backLabel={tx({
              "zh-CN": "返回会话列表",
              "zh-HK": "返回對話清單",
              en: "Back to Messages",
            })}
          />
        </div>
      </div>
    );
  }

  const displayRoomTitle = roomMeta?.title
    ? formatChatRoomTitle(roomMeta.title, locale)
    : tx(
        {
          "zh-CN": "协作会话 {id}",
          "zh-HK": "協作對話 {id}",
          en: "Team Chat {id}",
        },
        { id: roomId.slice(0, 8) },
      );

  const isMultiMemberGroup = members.length > 2;

  const headerSubtitle = otherPeer
    ? otherPeer.jobTitle
    : tp(
        {
          "zh-CN": "{count} 位成员",
          "zh-HK": "{count} 位成員",
          en: {
            one: "{count} member",
            other: "{count} members",
          },
        },
        members.length,
      );

  const openCenterProfile = () => {
    if (otherPeer) {
      setProfileDialogTarget({
        kind: "colleague",
        subject: otherPeer.subject,
        displayName: otherPeer.name,
        avatarSrc: otherPeer.avatarSrc,
      });
    } else {
      setProfileDialogTarget({
        kind: "group",
        roomId,
        roomTitle: displayRoomTitle,
        roomOwner: roomMeta?.owner ?? null,
        members,
        memberProfiles,
      });
    }
  };

  const openMembersDrawer = () => {
    openDrawer(
      {
        kind: "room-members",
        id: roomId,
        title: tx({
          "zh-CN": "会话成员管理",
          "zh-HK": "對話成員管理",
          en: "Room Members",
        }),
      },
      { tab: "current" },
    );
  };

  return (
    <div
      data-testid="chat-room-workspace"
      data-room-id={roomId}
      className="flex h-full min-h-0 flex-col bg-[var(--bg-sheet)]"
    >
      {/* Fluid iMessage Stream with Borderless Floating Header Overlay */}
      <div
        data-testid="room-message-feed"
        className="min-h-0 flex-1 overflow-y-auto bg-[var(--bg-sheet)]"
      >
        <ConversationHeader
          leftSlot={
            <Link
              href="/inbox"
              aria-label={tx({
                "zh-CN": "返回会话列表",
                "zh-HK": "返回對話清單",
                en: "Back to conversations",
              })}
              data-testid="room-mobile-back"
              className="inline-flex h-8 items-center gap-0.5 rounded-full pr-2.5 pl-1.5 text-[13.5px] font-medium text-[var(--accent)] hover:bg-[var(--accent-wash)] transition-colors lg:hidden"
            >
              <ChevronLeft className="h-4 w-4" strokeWidth={2.2} />
              <span>
                {tx({ "zh-CN": "返回", "zh-HK": "返回", en: "Back" })}
              </span>
            </Link>
          }
          avatarSrc={otherPeer?.avatarSrc ?? null}
          avatarName={otherPeer?.name || displayRoomTitle}
          avatarFallbackText={otherPeer?.subject || roomMeta?.owner || "RM"}
          avatarStatus={otherPeer?.availability}
          title={displayRoomTitle}
          titleTestId="room-header-title"
          subtitle={headerSubtitle}
          onOpenProfile={openCenterProfile}
          profileAriaLabel={tx(
            {
              "zh-CN": "查看 {name} 资料",
              "zh-HK": "檢視 {name} 資料",
              en: "View {name} details",
            },
            { name: displayRoomTitle },
          )}
          rightSlot={
            <>
              <button
                type="button"
                data-testid="room-schedule-meeting-btn"
                disabled={initialLoading}
                onClick={() => setMeetingModalOpen(true)}
                title={tx({
                  "zh-CN": "预约 Zoom / 房间会议",
                  "zh-HK": "預約 Zoom / 對話會議",
                  en: "Schedule Zoom or room meeting",
                })}
                className="inline-flex h-8 sm:h-9 shrink-0 items-center gap-1.5 rounded-full bg-[var(--bg-surface)]/90 backdrop-blur-md border border-[var(--hairline)] px-2.5 md:px-3 text-[12px] md:text-[12.5px] font-medium text-[var(--ink-primary)] shadow-[var(--shadow-subtle)] hover:shadow-[var(--shadow-card)] hover:text-[var(--accent)] transition-all duration-[150ms] cursor-pointer disabled:opacity-50"
              >
                <CalendarPlus
                  className="h-3.5 w-3.5 text-[var(--accent)]"
                  strokeWidth={1.9}
                />
                <span className="hidden md:inline whitespace-nowrap">
                  {tx({
                    "zh-CN": "Zoom / 日历预约",
                    "zh-HK": "Zoom / 日曆預約",
                    en: "Zoom / Schedule",
                  })}
                </span>
              </button>

              <button
                type="button"
                data-testid="room-members-btn"
                onClick={(e) =>
                  openDrawer(
                    {
                      kind: "room-members",
                      id: roomId,
                      title: tx({
                        "zh-CN": "会话成员管理",
                        "zh-HK": "對話成員管理",
                        en: "Room Members",
                      }),
                    },
                    { tab: "current", trigger: e.currentTarget },
                  )
                }
                title={tx({
                  "zh-CN": "查看或管理成员",
                  "zh-HK": "檢視或管理成員",
                  en: "View or manage members",
                })}
                className="inline-flex h-8 sm:h-9 shrink-0 items-center gap-1.5 rounded-full bg-[var(--bg-surface-subtle)]/90 backdrop-blur-md border border-[var(--hairline)] px-2.5 md:px-3 text-[12px] md:text-[12.5px] font-medium text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--ink-primary)] transition-colors cursor-pointer"
              >
                <Users className="h-3.5 w-3.5" strokeWidth={1.85} />
                <span className="tabular-nums">{members.length}</span>
              </button>
            </>
          }
        />

        <div className="mx-auto max-w-[740px] px-4 pt-[96px] pb-6 sm:px-8">
          {initialLoading ? (
            <div className="py-16 text-center text-[13px] text-[var(--ink-muted)]">
              {tx({
                "zh-CN": "正在加载会话消息…",
                "zh-HK": "正在載入對話訊息…",
                en: "Loading messages…",
              })}
            </div>
          ) : messages.length === 0 && pendingOutbound.length === 0 ? (
            <div
              data-testid="room-empty-state"
              className="flex flex-col items-center justify-center pt-[12vh] pb-6 text-center"
            >
              <Avatar
                src={otherPeer?.avatarSrc ?? null}
                name={otherPeer?.name || displayRoomTitle}
                fallbackText={otherPeer?.subject || roomMeta?.owner || "RM"}
                size="xl"
                status={otherPeer?.availability}
                className="shadow-[var(--shadow-card)]"
              />
              <h3 className="mt-4 text-[17px] font-semibold text-[var(--ink-primary)]">
                {displayRoomTitle}
              </h3>
              <p className="mt-1.5 max-w-[420px] text-[13px] text-[var(--ink-muted)] leading-relaxed text-balance">
                {tx({
                  "zh-CN":
                    "发送第一条协作消息，或点击右上角“Zoom / 日历预约”直接发起会议日程。",
                  "zh-HK":
                    "傳送第一則協作訊息，或點擊右上角「Zoom / 日曆預約」直接發起會議行程。",
                  en: "Send the first message, or click Zoom / Schedule above to book a room meeting.",
                })}
              </p>
            </div>
          ) : (
            <div>
              {messages.map((msg, idx) => {
                const isSelf = actor?.subject === msg.author;
                const prof = isSelf ? selfProfile : memberProfiles[msg.author];
                const dir = directoryContacts[msg.author];
                const displayName = resolveMemberDisplayName(msg.author, prof);
                const avatarSrc = isSelf
                  ? selfProfile?.has_avatar
                    ? `/v1/profile/avatar?v=${avatarVersion}`
                    : null
                  : prof?.has_avatar
                    ? getRoomMemberAvatarUrl(
                        roomId,
                        msg.author,
                        prof.version,
                        authGeneration,
                      )
                    : null;

                const pos = computeBubbleGroupPos(groupItems, idx, 300);
                const isGroupStart = pos === "single" || pos === "first";
                const showTail = shouldShowBubbleTail(pos);
                const prevCreatedAt =
                  idx > 0 ? messages[idx - 1]!.created_at : null;
                const showBurstTs = shouldShowBurstTimestamp(
                  prevCreatedAt,
                  msg.created_at,
                );
                const radiusClass = getBubbleRadiusClass(
                  isSelf ? "sent" : "received",
                  pos,
                );
                const animateClass =
                  idx >= messages.length - 6
                    ? isSelf
                      ? "imessage-bubble-sent"
                      : "imessage-bubble-received"
                    : "";

                const isBottomMostSelf =
                  !hasSendingPending && idx === lastSelfMsgIndex;
                let deliveryLabel: string | null = null;
                if (isBottomMostSelf) {
                  const peerReceipts = Object.values(readReceipts).filter(
                    (r) =>
                      r.subject !== actor?.subject &&
                      r.last_read_seq >= msg.seq,
                  );
                  if (peerReceipts.length > 0) {
                    const latestReadAt = Math.max(
                      ...peerReceipts.map((r) => r.read_at),
                    );
                    const hhmm = formatTimeOnly(latestReadAt);
                    deliveryLabel = tx(
                      {
                        "zh-CN": "{time} 已读",
                        "zh-HK": "{time} 已讀",
                        en: "Read {time}",
                      },
                      { time: hhmm },
                    );
                  } else {
                    deliveryLabel = tx({
                      "zh-CN": "已送达",
                      "zh-HK": "已送達",
                      en: "Delivered",
                    });
                  }
                }

                const compiledBody = prepareChatMarkdown(
                  formatChatMessageBody(msg.text, locale),
                );

                return (
                  <React.Fragment key={msg.seq}>
                    {showBurstTs && (
                      <div
                        data-testid={`room-burst-ts-${msg.seq}`}
                        className={[
                          "mb-3 flex justify-center",
                          idx === 0 ? "mt-0" : "mt-5",
                        ].join(" ")}
                      >
                        <span className="rounded-full bg-[var(--bg-surface-subtle)]/80 px-2.5 py-0.5 text-[11px] font-medium text-[var(--ink-muted)] tabular-nums">
                          {formatBurstTimestamp(msg.created_at, locale)}
                        </span>
                      </div>
                    )}

                    <article
                      data-testid={`room-message-${msg.seq}`}
                      className={[
                        "flex items-end gap-2",
                        isSelf ? "justify-end pr-1.5" : "justify-start pl-1.5",
                        idx === 0 || showBurstTs
                          ? ""
                          : isGroupStart
                            ? "mt-3.5"
                            : "mt-[3px]",
                      ].join(" ")}
                    >
                      {/* Left Colleague Avatar (multi-member group chats only; 1:1 keeps peer avatar centered in header) */}
                      {!isSelf && isMultiMemberGroup && (
                        <div className="w-8 shrink-0">
                          {showTail && (
                            <button
                              type="button"
                              onClick={() =>
                                setProfileDialogTarget({
                                  kind: "colleague",
                                  subject: msg.author,
                                  displayName,
                                  avatarSrc,
                                })
                              }
                              aria-label={tx(
                                {
                                  "zh-CN": "查看 {name} 名片",
                                  "zh-HK": "檢視 {name} 名片",
                                  en: "View {name} profile",
                                },
                                { name: displayName },
                              )}
                              className="block rounded-full cursor-pointer transition-transform duration-[140ms] hover:scale-[1.05]"
                            >
                              <Avatar
                                src={avatarSrc}
                                name={displayName}
                                fallbackText={msg.author}
                                size="sm"
                                status={mapContactAvailabilityToAvatarStatus(
                                  dir?.availability,
                                )}
                              />
                            </button>
                          )}
                        </div>
                      )}

                      <div
                        className={[
                          "min-w-0 max-w-[78%] flex flex-col",
                          isSelf ? "items-end" : "items-start",
                        ].join(" ")}
                      >
                        {/* Author name strictly for multi-member group chats */}
                        {isGroupStart && !isSelf && isMultiMemberGroup && (
                          <div className="mb-1 ml-1 text-[11.5px] font-medium text-[var(--ink-secondary)]">
                            {displayName}
                          </div>
                        )}

                        <div
                          className={[
                            "relative max-w-full px-4 py-[9px] text-[14.5px] leading-[1.5] break-words",
                            radiusClass,
                            animateClass,
                            isSelf
                              ? "bg-[var(--bubble-sent-bg)] text-[var(--bubble-sent-ink)]"
                              : "bg-[var(--bubble-received-bg)] text-[var(--bubble-received-ink)]",
                          ].join(" ")}
                        >
                          <MarkdownMessage
                            tone={isSelf ? "sent" : "received"}
                            content={compiledBody}
                          />
                          {showTail && (
                            <IMessageBubbleTail
                              side={isSelf ? "sent" : "received"}
                            />
                          )}
                        </div>

                        {deliveryLabel && (
                          <span
                            data-testid="room-delivery-status"
                            className="mt-1 mr-1 text-[11px] font-medium text-[var(--ink-muted)] tabular-nums"
                          >
                            {deliveryLabel}
                          </span>
                        )}
                      </div>
                    </article>
                  </React.Fragment>
                );
              })}

              {/* Pending / Failed Outbound Messages with Idempotent client_id Retry */}
              {pendingOutbound.map((item) => (
                <div
                  key={item.clientId}
                  data-testid={`room-pending-message-${item.clientId}`}
                  className="mt-3 flex flex-col items-end gap-1 pr-1.5"
                >
                  <div
                    className={[
                      "imessage-bubble-sent relative max-w-[78%] bg-[var(--bubble-sent-bg)] opacity-85 px-4 py-[9px] text-[14.5px] leading-[1.5] text-[var(--bubble-sent-ink)] whitespace-pre-wrap break-words",
                      getBubbleRadiusClass("sent", "single"),
                    ].join(" ")}
                  >
                    {item.text}
                    <IMessageBubbleTail side="sent" />
                  </div>
                  {item.status === "sending" ? (
                    <span
                      data-testid="room-delivery-status"
                      className="mr-1 text-[11px] font-medium text-[var(--ink-muted)] tabular-nums"
                    >
                      {tx({
                        "zh-CN": "发送中…",
                        "zh-HK": "傳送中…",
                        en: "Sending…",
                      })}
                    </span>
                  ) : (
                    <div className="flex flex-wrap items-center justify-end gap-2 rounded-sm bg-[var(--status-amber-wash)] px-3 py-2 text-[12px] text-[var(--status-amber-ink)]">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                      <span>
                        {item.errorMessage ||
                          tx({
                            "zh-CN": "发送失败",
                            "zh-HK": "傳送失敗",
                            en: "Failed to send",
                          })}
                      </span>
                      {item.conflictMismatch ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          pill
                          onClick={() => {
                            const freshId = generateClientId("msg");
                            setPendingOutbound((prev) =>
                              prev.filter((p) => p.clientId !== item.clientId),
                            );
                            void sendWithClientId(item.text, freshId, false);
                          }}
                        >
                          {tx({
                            "zh-CN": "以新消息重发",
                            "zh-HK": "以新訊息重送",
                            en: "Send as New",
                          })}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="secondary"
                          pill
                          data-testid="room-message-retry-btn"
                          onClick={() =>
                            void sendWithClientId(
                              item.text,
                              item.clientId,
                              true,
                            )
                          }
                        >
                          <RefreshCw className="h-3 w-3" />
                          <span>
                            {tx({
                              "zh-CN": "重试发送",
                              "zh-HK": "重試傳送",
                              en: "Retry",
                            })}
                          </span>
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <div ref={feedEndRef} />
        </div>
      </div>

      {/* Organic 24px Rounded Capsule Composer */}
      <footer className="shrink-0 bg-gradient-to-t from-[var(--bg-sheet)] via-[var(--bg-sheet)] to-transparent px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-8 sm:pb-5">
        <div className="mx-auto max-w-[740px]">
          <div className="flex items-end gap-2 rounded-[var(--radius-composer)] border border-[var(--hairline)] bg-[var(--bg-surface)] py-2 pl-4 pr-2 shadow-[var(--shadow-composer)] focus-within:border-[var(--accent)] focus-within:shadow-[var(--shadow-composer-focus)] transition-all duration-[200ms]">
            <textarea
              ref={textareaRef}
              data-composer-input
              data-testid="room-composer-input"
              rows={1}
              maxLength={4000}
              value={composerText}
              onChange={(e) => updateComposer(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={tx(
                {
                  "zh-CN": "向 {room} 发送消息…",
                  "zh-HK": "向 {room} 傳送訊息…",
                  en: "Message {room}…",
                },
                { room: displayRoomTitle },
              )}
              style={{ outline: "none" }}
              className="my-0 block max-h-[150px] min-h-[32px] flex-1 resize-none border-0 bg-transparent py-[5px] text-[14.5px] leading-[22px] text-[var(--ink-primary)] placeholder:text-[var(--ink-faint)] focus:outline-none focus:ring-0"
            />
            <button
              type="button"
              data-testid="room-send-btn"
              aria-label={tx({
                "zh-CN": "发送消息",
                "zh-HK": "傳送訊息",
                en: "Send message",
              })}
              disabled={composerText.trim().length === 0}
              onClick={handleSend}
              className={[
                "inline-flex h-[32px] w-[32px] shrink-0 items-center justify-center rounded-full transition-all duration-[150ms]",
                composerText.trim().length > 0
                  ? "bg-[var(--accent-solid)] text-[var(--accent-fg)] shadow-[var(--shadow-subtle)] hover:bg-[var(--accent-solid-hover)] active:scale-[0.92] cursor-pointer"
                  : "bg-[var(--bg-surface-subtle)] text-[var(--ink-faint)] cursor-not-allowed",
              ].join(" ")}
            >
              <ArrowUp className="h-4 w-4" strokeWidth={2.3} />
            </button>
          </div>
        </div>
      </footer>

      {/* Colleague / Group Contact Profile Card Modal */}
      <ContactProfileDialog
        open={profileDialogTarget !== null}
        onOpenChange={(open) => {
          if (!open) setProfileDialogTarget(null);
        }}
        target={profileDialogTarget}
        onSendEmail={({ email, subject }) => {
          setDraft("assistant", `/email ${email || subject}: `);
          router.push("/inbox/assistant");
        }}
        onScheduleMeeting={() => setMeetingModalOpen(true)}
        onViewMembers={openMembersDrawer}
      />

      {/* Draft-Then-Confirm Room Meeting Modal (with optional Zoom & MCP Sync + .ics) */}
      <MeetingDraftModal
        open={meetingModalOpen}
        onOpenChange={setMeetingModalOpen}
        roomId={roomId}
        roomTitle={displayRoomTitle}
        members={members}
        memberProfiles={memberProfiles}
      />
    </div>
  );
}
