"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  CalendarPlus,
  Hash,
  RefreshCw,
  Send,
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
import type { ChatMessage, ChatRoom, Profile } from "@/lib/types";

interface PendingFailedMessage {
  clientId: string;
  text: string;
  status: "sending" | "failed";
  errorMessage: string | null;
  conflictMismatch?: boolean;
}

const POLL_INTERVAL_MS = 5000;

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

  const lastSeqRef = useRef<number>(0);
  const fetchedSubjectsRef = useRef<Set<string>>(new Set());
  const pollTimerRef = useRef<number | null>(null);
  const pollStoppedRef = useRef(false);
  const feedEndRef = useRef<HTMLDivElement | null>(null);

  const chatAvailable = Boolean(capabilities?.chat_available);

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

  // Sync draft when switching room or authGeneration
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

  // Load room member profiles on demand (never re-fetch already cached subjects in this authGeneration)
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
    if (typeof document !== "undefined" && document.visibilityState !== "visible") {
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

  // Initial room load + conservative active-only polling
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
        // Fetch members & messages in parallel; also fetch room list for title/owner
        const [membersRes, messagesRes, roomsRes] = await Promise.all([
          fetchRoomMembers(roomId, { limit: 100 }),
          fetchRoomMessages(roomId, { limit: 100, after: 0 }),
          fetchChatRooms({ limit: 100 }).catch(() => ({ items: [], next: null })),
        ]);

        if (cancelled || startGen !== getAuthGeneration()) return;

        const matchedRoom =
          roomsRes.items.find((r) => r.id === roomId) ?? null;
        setRoomMeta(matchedRoom);
        setMembers(membersRes.items);

        // Drain any remaining pages if >100 messages
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

        // Deduplicate strictly by seq
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

        // Start conservative incremental polling strictly while active
        if (!cancelled && !pollStoppedRef.current) {
          pollTimerRef.current = window.setInterval(() => {
            void pollIncrementalMessages();
          }, POLL_INTERVAL_MS);
        }
      } catch (err) {
        if (cancelled || isStaleAuthError(err) || startGen !== getAuthGeneration()) {
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

  // Mount RoomMembersPanel into the Right Workbench Drawer when room-members is selected
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

  // Unauthorized or chat disabled view
  if (capabilities && !chatAvailable) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--bg-canvas)] p-6">
        <div className="w-full max-w-[460px]">
          <AccessNoticeCard
            variant="ACCESS_RESTRICTED"
            title="协作房间未启用"
            message="当前账号未获授员工协作房间权限，无法访问此房间。"
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
        className="flex h-full items-center justify-center bg-[var(--bg-canvas)] p-6"
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

  const displayRoomTitle = roomMeta?.title || `协作房间 ${roomId.slice(0, 10)}`;

  return (
    <div
      data-testid="chat-room-workspace"
      data-room-id={roomId}
      className="flex h-full min-h-0 flex-col bg-[var(--bg-sheet)]"
    >
      {/* Room Header */}
      <header className="flex min-h-[52px] shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[var(--hairline)] bg-[var(--bg-sheet)] px-3.5 py-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <Link
            href="/inbox"
            aria-label="返回会话列表"
            data-testid="room-mobile-back"
            className="inline-flex h-8 w-8 items-center justify-center rounded-[4px] border border-[var(--hairline-strong)] text-[var(--ink-secondary)] hover:bg-[var(--bg-subtle)] lg:hidden"
          >
            <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
          </Link>

          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-subtle)] text-[var(--ink-secondary)]">
            <Hash className="h-4 w-4" strokeWidth={1.75} />
          </span>

          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2
                data-testid="room-header-title"
                className="truncate text-[14.5px] font-semibold text-[var(--ink-primary)]"
              >
                {displayRoomTitle}
              </h2>
              <span className="shrink-0 font-mono-code text-[11px] text-[var(--ink-muted)]">
                {members.length} 人
              </span>
            </div>
            <p className="truncate text-[11.5px] text-[var(--ink-muted)]">
              租户内员工协作房间 · 与个人 Agent 上下文完全隔离
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            data-testid="room-schedule-meeting-btn"
            disabled={initialLoading}
            onClick={() => setMeetingModalOpen(true)}
          >
            <CalendarPlus className="h-3.5 w-3.5 text-[var(--accent)]" strokeWidth={1.75} />
            <span>预约房间会议</span>
          </Button>

          <Button
            size="sm"
            variant="secondary"
            data-testid="room-members-btn"
            onClick={(e) =>
              openDrawer(
                {
                  kind: "room-members",
                  id: roomId,
                  title: "房间成员管理",
                },
                { tab: "current", trigger: e.currentTarget },
              )
            }
          >
            <Users className="h-3.5 w-3.5" strokeWidth={1.75} />
            <span>成员 ({members.length})</span>
          </Button>
        </div>
      </header>

      {/* Message Stream */}
      <div
        data-testid="room-message-feed"
        className="min-h-0 flex-1 overflow-auto bg-[var(--bg-canvas)] px-4 py-4 sm:px-6"
      >
        <div className="mx-auto max-w-[780px] space-y-3">
          {initialLoading ? (
            <div className="py-12 text-center text-[13px] text-[var(--ink-muted)]">
              正在加载房间消息与成员资料…
            </div>
          ) : messages.length === 0 && pendingOutbound.length === 0 ? (
            <div
              data-testid="room-empty-state"
              className="rounded-[6px] border border-[var(--hairline)] bg-[var(--bg-sheet)] p-6 text-center"
            >
              <p className="text-[13.5px] font-medium text-[var(--ink-primary)]">
                房间内暂无可见消息
              </p>
              <p className="mt-1 text-[12px] text-[var(--ink-muted)]">
                发送第一条协作消息，或点击右上角“预约房间会议”发起站内日程草稿。
              </p>
            </div>
          ) : (
            <>
              {messages.map((msg) => {
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

                return (
                  <article
                    key={msg.seq}
                    data-testid={`room-message-${msg.seq}`}
                    className={[
                      "flex items-start gap-2.5",
                      isSelf ? "flex-row-reverse" : "",
                    ].join(" ")}
                  >
                    <Avatar
                      src={avatarSrc}
                      name={displayName}
                      fallbackText={msg.author}
                      size="sm"
                      className="mt-0.5"
                    />

                    <div
                      className={[
                        "min-w-0 max-w-[80%]",
                        isSelf ? "items-end text-right" : "",
                      ].join(" ")}
                    >
                      <div
                        className={[
                          "flex items-center gap-2 text-[11.5px] text-[var(--ink-muted)]",
                          isSelf ? "justify-end" : "",
                        ].join(" ")}
                      >
                        <span className="font-medium text-[var(--ink-secondary)]">
                          {displayName}
                        </span>
                        <span className="font-mono-code text-[10.5px]">
                          #{msg.seq}
                        </span>
                        <span className="font-mono-code text-[10.5px]">
                          {formatUnixTime(msg.created_at)}
                        </span>
                      </div>

                      <div
                        className={[
                          "mt-1 inline-block rounded-[4px] border px-3 py-2 text-left text-[13.5px] leading-relaxed whitespace-pre-wrap break-words",
                          isSelf
                            ? "border-[var(--accent-border)] bg-[var(--accent-wash)] text-[var(--ink-primary)]"
                            : "border-[var(--hairline-strong)] bg-[var(--bg-sheet)] text-[var(--ink-primary)]",
                        ].join(" ")}
                      >
                        {msg.text}
                      </div>
                    </div>
                  </article>
                );
              })}

              {/* Pending / Failed Outbound Messages with Idempotent Retry */}
              {pendingOutbound.map((item) => (
                <div
                  key={item.clientId}
                  data-testid={`room-pending-message-${item.clientId}`}
                  className="flex flex-col items-end gap-1"
                >
                  <div className="max-w-[80%] rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-plane)] px-3 py-2 text-[13.5px] text-[var(--ink-secondary)] whitespace-pre-wrap break-words opacity-85">
                    {item.text}
                  </div>
                  {item.status === "sending" ? (
                    <span className="font-mono-code text-[11px] text-[var(--ink-muted)]">
                      正在发送…
                    </span>
                  ) : (
                    <div className="flex flex-wrap items-center justify-end gap-2 rounded-[4px] border border-[var(--status-amber-border)] bg-[var(--status-amber-wash)] px-2.5 py-1.5 text-[11.5px] text-[var(--status-amber-ink)]">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                      <span>{item.errorMessage || "发送失败"}</span>
                      {item.conflictMismatch ? (
                        <Button
                          size="sm"
                          variant="secondary"
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
            </>
          )}

          <div ref={feedEndRef} />
        </div>
      </div>

      {/* Room Composer */}
      <footer className="shrink-0 border-t border-[var(--hairline)] bg-[var(--bg-sheet)] px-4 py-3">
        <div className="mx-auto max-w-[780px]">
          <div className="flex items-end gap-2">
            <textarea
              data-composer-input
              data-testid="room-composer-input"
              rows={2}
              maxLength={4000}
              value={composerText}
              onChange={(e) => updateComposer(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={`在 ${displayRoomTitle} 发送纯文本协作消息（Enter 发送，Shift+Enter 换行）`}
              className="min-h-[44px] max-h-[140px] flex-1 resize-y rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-3 py-2 text-[13.5px] leading-relaxed text-[var(--ink-primary)] placeholder:text-[var(--ink-faint)] focus:border-[var(--accent)] focus:outline-none"
            />
            <Button
              type="button"
              variant="primary"
              size="md"
              data-testid="room-send-btn"
              disabled={composerText.trim().length === 0}
              onClick={handleSend}
              className="h-[44px] shrink-0 px-4"
            >
              <Send className="h-4 w-4" strokeWidth={1.75} />
              <span>发送</span>
            </Button>
          </div>
          <div className="mt-1.5 flex items-center justify-between text-[11px] text-[var(--ink-muted)]">
            <span>发送失败可原地重试并自动复用幂等 client_id，不会重复写入。</span>
            <span className="font-mono-code tabular-nums">
              {composerText.length}/4000
            </span>
          </div>
        </div>
      </footer>

      {/* Draft-Then-Confirm Room Meeting Modal */}
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
