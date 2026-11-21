"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
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
import { formatUnixTime } from "@/lib/format";
import { useSession } from "@/lib/session-context";
import { useWorkbench } from "@/lib/workbench-context";
import { AccessNoticeCard } from "@/components/ui/AccessNoticeCard";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import {
  fetchRoomMemberProfile,
  fetchRoomMembers,
  fetchRoomMessages,
  getRoomMemberAvatarUrl,
  postRoomMessage,
} from "@/features/chat/api";
import { MeetingDraftModal } from "@/features/chat/MeetingDraftModal";
import { RoomMembersPanel } from "@/features/chat/RoomMembersPanel";
import { fetchChatRooms } from "@/features/inbox/api";
import {
  IMessageBubbleTail,
  computeBubbleGroupPos,
  getBubbleRadiusClass,
  shouldShowBubbleTail,
} from "@/features/inbox/bubble-group";
import type { ChatMessage, ChatRoom, Profile } from "@/lib/types";

interface PendingFailedMessage {
  clientId: string;
  text: string;
  status: "sending" | "failed";
  errorMessage: string | null;
  conflictMismatch?: boolean;
}

const POLL_INTERVAL_MS = 5000;

function cleanRoomTitle(title: string): string {
  const withoutPrefix = title.replace(/^私聊\s*[·•]\s*/, "").trim();
  const withoutAccountSuffix = withoutPrefix
    .replace(/\s*\([A-Za-z0-9._-]+\)\s*$/, "")
    .trim();
  return withoutAccountSuffix || withoutPrefix || title;
}

export function ChatRoomWorkspace({ roomId }: { roomId: string }) {
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

  const [roomMeta, setRoomMeta] = useState<ChatRoom | null>(null);
  const [members, setMembers] = useState<string[]>([]);
  const [memberProfiles, setMemberProfiles] = useState<Record<string, Profile>>(
    {},
  );
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pendingOutbound, setPendingOutbound] = useState<
    PendingFailedMessage[]
  >([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const [accessError, setAccessError] = useState<ApiError | null>(null);
  const [meetingModalOpen, setMeetingModalOpen] = useState(false);

  const draftKey = `room:${roomId}`;
  const [composerText, setComposerText] = useState<string>(() =>
    getDraft(draftKey),
  );

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const lastSeqRef = useRef<number>(0);
  const fetchedSubjectsRef = useRef<Set<string>>(new Set());
  const pollTimerRef = useRef<number | null>(null);
  const pollStoppedRef = useRef(false);
  const feedEndRef = useRef<HTMLDivElement | null>(null);

  const chatAvailable = Boolean(capabilities?.chat_available);

  const autoResizeTextarea = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(150, Math.max(26, el.scrollHeight))}px`;
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
    fetchedSubjectsRef.current.clear();
    setRoomMeta(null);
    setMembers([]);
    setMemberProfiles({});
    setMessages([]);
    setPendingOutbound([]);
    setMeetingModalOpen(false);
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
      if (res.items.length > 0) {
        const authors = new Set<string>();
        setMessages((prev) => {
          const seen = new Set(prev.map((m) => m.seq));
          const merged = [...prev];
          for (const item of res.items) {
            authors.add(item.author);
            if (!seen.has(item.seq)) {
              seen.add(item.seq);
              merged.push(item);
            }
            if (item.seq > lastSeqRef.current) {
              lastSeqRef.current = item.seq;
            }
          }
          merged.sort((a, b) => a.seq - b.seq);
          return merged;
        });
        void hydrateProfiles(Array.from(authors), startGen);
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
  }, [roomId, hydrateProfiles, stopPolling, handleFatalRoomError]);

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

        let allMessages = [...messagesRes.items];
        let nextSeq = messagesRes.next;
        let safetyPages = 0;
        while (nextSeq !== null && safetyPages < 5) {
          const more = await fetchRoomMessages(roomId, {
            limit: 100,
            after: nextSeq,
          });
          if (cancelled || startGen !== getAuthGeneration()) return;
          allMessages = [...allMessages, ...more.items];
          nextSeq = more.next;
          safetyPages += 1;
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
  ]);

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
                    errorMessage: err.message,
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
                  errorMessage: "网络异常，消息未送达，请点击重试。",
                }
              : p,
          ),
        );
      }
    },
    [roomId, handleFatalRoomError],
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

  // Derive peer avatar when room is a 1:1 DM
  const otherPeer = useMemo(() => {
    if (!actor || members.length !== 2) return null;
    const other = members.find((m) => m !== actor.subject);
    if (!other) return null;
    const prof = memberProfiles[other];
    return {
      subject: other,
      name: prof?.display_name || other,
      avatarSrc: prof?.has_avatar
        ? getRoomMemberAvatarUrl(roomId, other, prof.version, authGeneration)
        : null,
    };
  }, [actor, members, memberProfiles, roomId, authGeneration]);

  if (capabilities && !chatAvailable) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--bg-app)] p-6">
        <div className="w-full max-w-[460px]">
          <AccessNoticeCard
            variant="ACCESS_RESTRICTED"
            title="协作会话未启用"
            message="当前账号未获授员工协作会话权限，无法访问此会话。"
            backHref="/inbox/assistant"
            backLabel="返回个人业务助手"
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
            backLabel="返回会话列表"
          />
        </div>
      </div>
    );
  }

  const displayRoomTitle = roomMeta?.title
    ? cleanRoomTitle(roomMeta.title)
    : `协作会话 ${roomId.slice(0, 8)}`;

  return (
    <div
      data-testid="chat-room-workspace"
      data-room-id={roomId}
      className="flex h-full min-h-0 flex-col bg-[var(--bg-surface)]"
    >
      {/* 60px Frosted macOS Messages Header */}
      <header className="aios-topbar-glass sticky top-0 z-20 flex h-[var(--header-h)] shrink-0 items-center justify-between gap-3 border-b border-[var(--hairline)] px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-2.5">
          <Link
            href="/inbox"
            aria-label="返回会话列表"
            data-testid="room-mobile-back"
            className="inline-flex h-8 items-center gap-0.5 rounded-full pr-2.5 pl-1.5 text-[13.5px] font-medium text-[var(--accent)] hover:bg-[var(--accent-wash)] transition-colors lg:hidden"
          >
            <ChevronLeft className="h-4 w-4" strokeWidth={2.2} />
            <span>返回</span>
          </Link>

          <Avatar
            src={otherPeer?.avatarSrc ?? null}
            name={otherPeer?.name || displayRoomTitle}
            fallbackText={otherPeer?.subject || roomMeta?.owner || "RM"}
            size="md"
          />

          <div className="min-w-0">
            <h2
              data-testid="room-header-title"
              className="truncate text-[15px] font-semibold tracking-[-0.015em] text-[var(--ink-primary)]"
            >
              {displayRoomTitle}
            </h2>
            <p className="truncate text-[11.5px] text-[var(--ink-muted)]">
              {otherPeer ? "1:1 同事会话" : `${members.length} 位成员`} · 租户内隔离协作
            </p>
          </div>
        </div>

        {/* Subtle Zoom / Calendar Meeting & Members Controls */}
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            data-testid="room-schedule-meeting-btn"
            disabled={initialLoading}
            onClick={() => setMeetingModalOpen(true)}
            title="预约 Zoom / 房间会议"
            className="inline-flex h-9 items-center gap-1.5 rounded-full bg-[var(--bg-surface)] px-3.5 text-[12.5px] font-medium text-[var(--ink-primary)] shadow-[var(--shadow-subtle)] hover:shadow-[var(--shadow-card)] hover:text-[var(--accent)] transition-all duration-[150ms] cursor-pointer disabled:opacity-50"
          >
            <CalendarPlus
              className="h-3.5 w-3.5 text-[var(--accent)]"
              strokeWidth={1.9}
            />
            <span className="hidden sm:inline">Zoom / 日历预约</span>
          </button>

          <button
            type="button"
            data-testid="room-members-btn"
            onClick={(e) =>
              openDrawer(
                {
                  kind: "room-members",
                  id: roomId,
                  title: "会话成员管理",
                },
                { tab: "current", trigger: e.currentTarget },
              )
            }
            title="查看或管理成员"
            className="inline-flex h-9 items-center gap-1.5 rounded-full bg-[var(--bg-surface-subtle)] px-3 text-[12.5px] font-medium text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--ink-primary)] transition-colors cursor-pointer"
          >
            <Users className="h-3.5 w-3.5" strokeWidth={1.85} />
            <span className="font-mono-code tabular-nums">{members.length}</span>
          </button>
        </div>
      </header>

      {/* Fluid iMessage Stream */}
      <div
        data-testid="room-message-feed"
        className="min-h-0 flex-1 overflow-y-auto bg-[var(--bg-surface)] px-4 py-6 sm:px-8"
      >
        <div className="mx-auto max-w-[740px]">
          {initialLoading ? (
            <div className="py-16 text-center text-[13px] text-[var(--ink-muted)]">
              正在加载会话消息…
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
                className="shadow-[var(--shadow-card)]"
              />
              <h3 className="mt-4 text-[17px] font-semibold text-[var(--ink-primary)]">
                {displayRoomTitle}
              </h3>
              <p className="mt-1.5 max-w-[380px] text-[13px] text-[var(--ink-muted)] leading-relaxed">
                发送第一条协作消息，或点击右上角“Zoom / 日历预约”直接发起会议日程。
              </p>
            </div>
          ) : (
            <div>
              {messages.map((msg, idx) => {
                const isSelf = actor?.subject === msg.author;
                const prof = isSelf ? selfProfile : memberProfiles[msg.author];
                const displayName = prof?.display_name || msg.author;
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

                const pos = computeBubbleGroupPos(groupItems, idx);
                const isGroupStart = pos === "single" || pos === "first";
                const showTail = shouldShowBubbleTail(pos);
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

                return (
                  <article
                    key={msg.seq}
                    data-testid={`room-message-${msg.seq}`}
                    className={[
                      "flex items-end gap-2",
                      isSelf ? "justify-end pr-1.5" : "justify-start pl-1",
                      idx === 0
                        ? ""
                        : isGroupStart
                          ? "mt-3.5"
                          : "mt-[3px]",
                    ].join(" ")}
                  >
                    {/* Left Colleague Avatar (only visible at group end, spacer preserves alignment) */}
                    {!isSelf && (
                      <div className="w-8 shrink-0">
                        {showTail && (
                          <Avatar
                            src={avatarSrc}
                            name={displayName}
                            fallbackText={msg.author}
                            size="sm"
                          />
                        )}
                      </div>
                    )}

                    <div
                      className={[
                        "min-w-0 max-w-[78%] flex flex-col",
                        isSelf ? "items-end" : "items-start",
                      ].join(" ")}
                    >
                      {isGroupStart && !isSelf && (
                        <div className="mb-1 ml-1 flex items-center gap-2 text-[11.5px] text-[var(--ink-muted)]">
                          <span className="font-medium text-[var(--ink-secondary)]">
                            {displayName}
                          </span>
                          <span className="font-mono-code text-[10.5px] tabular-nums">
                            {formatUnixTime(msg.created_at)}
                          </span>
                        </div>
                      )}

                      <div
                        className={[
                          "relative px-4 py-2.5 text-[14.5px] leading-[1.45] whitespace-pre-wrap break-words",
                          radiusClass,
                          animateClass,
                          isSelf
                            ? "bg-[var(--accent)] text-white"
                            : "bg-[var(--agent-bubble-bg)] text-[var(--ink-primary)]",
                        ].join(" ")}
                      >
                        {msg.text}
                        {showTail && (
                          <IMessageBubbleTail
                            side={isSelf ? "sent" : "received"}
                          />
                        )}
                      </div>

                      {showTail && isSelf && (
                        <span className="mt-1 mr-1 font-mono-code text-[10.5px] text-[var(--ink-faint)] tabular-nums">
                          {formatUnixTime(msg.created_at)}
                        </span>
                      )}
                    </div>
                  </article>
                );
              })}

              {/* Pending / Failed Outbound Messages with Idempotent client_id Retry */}
              {pendingOutbound.map((item) => (
                <div
                  key={item.clientId}
                  data-testid={`room-pending-message-${item.clientId}`}
                  className="mt-3 flex flex-col items-end gap-1.5 pr-1.5"
                >
                  <div className="imessage-bubble-sent relative max-w-[78%] rounded-lg bg-[var(--accent)]/75 px-4 py-2.5 text-[14.5px] leading-[1.45] text-white whitespace-pre-wrap break-words">
                    {item.text}
                  </div>
                  {item.status === "sending" ? (
                    <span className="font-mono-code text-[11px] text-[var(--ink-muted)]">
                      正在发送…
                    </span>
                  ) : (
                    <div className="flex flex-wrap items-center justify-end gap-2 rounded-sm bg-[var(--status-amber-wash)] px-3 py-2 text-[12px] text-[var(--status-amber-ink)]">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                      <span>{item.errorMessage || "发送失败"}</span>
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
                          以新消息重发
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
                          <span>重试发送</span>
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

      {/* Minimal Floating Capsule Composer */}
      <footer className="shrink-0 bg-gradient-to-t from-[var(--bg-surface)] via-[var(--bg-surface)] to-transparent px-4 pt-2 pb-4 sm:px-8 sm:pb-5">
        <div className="mx-auto max-w-[740px]">
          <div className="flex items-end gap-2 rounded-xl bg-[var(--bg-surface)] py-2 pl-4 pr-2.5 shadow-[var(--shadow-composer)] focus-within:shadow-[var(--shadow-composer-focus)] transition-shadow duration-[200ms]">
            <textarea
              ref={textareaRef}
              data-composer-input
              data-testid="room-composer-input"
              rows={1}
              maxLength={4000}
              value={composerText}
              onChange={(e) => updateComposer(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={`向 ${displayRoomTitle} 发送消息…`}
              className="my-1 block max-h-[150px] min-h-[26px] flex-1 resize-none bg-transparent text-[14.5px] leading-[1.45] text-[var(--ink-primary)] placeholder:text-[var(--ink-faint)] focus:outline-none"
            />
            <button
              type="button"
              data-testid="room-send-btn"
              aria-label="发送消息"
              disabled={composerText.trim().length === 0}
              onClick={handleSend}
              className={[
                "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-all duration-[150ms]",
                composerText.trim().length > 0
                  ? "bg-[var(--accent)] text-white shadow-[0_2px_6px_rgba(22,104,227,0.28)] hover:bg-[var(--accent-hover)] active:scale-[0.92] cursor-pointer"
                  : "bg-[var(--bg-surface-subtle)] text-[var(--ink-faint)] cursor-not-allowed",
              ].join(" ")}
            >
              <ArrowUp className="h-4 w-4" strokeWidth={2.3} />
            </button>
          </div>
        </div>
      </footer>

      {/* Upgraded Draft-Then-Confirm Room Meeting Modal (with optional Zoom & MCP Sync + .ics) */}
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
