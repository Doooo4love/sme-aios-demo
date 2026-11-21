"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Briefcase,
  CalendarDays,
  Hash,
  MessageSquareOff,
  Plus,
  RefreshCw,
} from "lucide-react";
import {
  generateClientId,
  isApiError,
  isStaleAuthError,
  type ApiError,
} from "@/lib/api-client";
import { useSession } from "@/lib/session-context";
import { useWorkbench } from "@/lib/workbench-context";
import { AccessNoticeCard } from "@/components/ui/AccessNoticeCard";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { createChatRoom, fetchChatRooms } from "@/features/inbox/api";
import type { ChatRoom } from "@/lib/types";

export interface InboxShellProps {
  /**
   * "list" is used by /inbox: shows full-width thread list on mobile (<1024px)
   * and Left ThreadList + Center children (AssistantWorkspace) on desktop (>=1024px).
   * "thread" is used by /inbox/assistant and /inbox/[roomId]: shows Left ThreadList
   * on desktop (>=1024px) and full-width Center children on mobile (<1024px).
   */
  mode: "list" | "thread";
  activeThread: "assistant" | string;
  children: React.ReactNode;
}

export function InboxShell({ mode, activeThread, children }: InboxShellProps) {
  const router = useRouter();
  const pathname = usePathname() || "/inbox";
  const {
    status,
    actor,
    capabilities,
    agentProfile,
    agentAvatarVersion,
    authGeneration,
    handleAccessChanged,
  } = useSession();
  const { assignedCount, openDrawer, setCustomDrawerContent } = useWorkbench();

  const [rooms, setRooms] = useState<ChatRoom[]>([]);
  const [roomsNext, setRoomsNext] = useState<string | null>(null);
  const [roomsLoading, setRoomsLoading] = useState(false);
  const [roomsLoadingMore, setRoomsLoadingMore] = useState(false);
  const [roomsError, setRoomsError] = useState<ApiError | null>(null);

  // Create room modal state
  const [createOpen, setCreateOpen] = useState(false);
  const [roomTitle, setRoomTitle] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const createClientIdRef = useRef<string>(generateClientId("room"));
  const creatingRef = useRef(false);

  const chatAvailable = Boolean(capabilities?.chat_available);

  const loadRooms = useCallback(
    async (after?: string | null) => {
      if (status !== "authenticated" || !chatAvailable) {
        setRooms([]);
        setRoomsNext(null);
        setRoomsError(null);
        return;
      }
      if (after) {
        setRoomsLoadingMore(true);
      } else {
        setRoomsLoading(true);
      }
      setRoomsError(null);
      try {
        const res = await fetchChatRooms({
          limit: 30,
          after: after || undefined,
        });
        setRooms((prev) => {
          if (!after) return res.items;
          const seen = new Set(prev.map((r) => r.id));
          const merged = [...prev];
          for (const item of res.items) {
            if (!seen.has(item.id)) {
              seen.add(item.id);
              merged.push(item);
            }
          }
          return merged;
        });
        setRoomsNext(res.next);
      } catch (error) {
        if (isStaleAuthError(error)) return;
        if (isApiError(error)) {
          if (error.code === "ACCESS_CHANGED") {
            setRooms([]);
            setRoomsNext(null);
            void handleAccessChanged();
          }
          setRoomsError(error);
        }
      } finally {
        setRoomsLoading(false);
        setRoomsLoadingMore(false);
      }
    },
    [status, chatAvailable, handleAccessChanged],
  );

  // Reset & reload rooms whenever authGeneration or chatAvailable changes
  useEffect(() => {
    setRooms([]);
    setRoomsNext(null);
    setRoomsError(null);
    setCreateOpen(false);
    setRoomTitle("");
    setCreateError(null);
    createClientIdRef.current = generateClientId("room");
    if (status === "authenticated" && chatAvailable) {
      void loadRooms(null);
    }
  }, [authGeneration, status, chatAvailable, loadRooms]);

  // Keep room list synchronized when rooms are created elsewhere in same session
  useEffect(() => {
    const onRoomCreated = (event: Event) => {
      const custom = event as CustomEvent<ChatRoom>;
      if (!custom.detail?.id) return;
      setRooms((prev) => {
        if (prev.some((r) => r.id === custom.detail.id)) return prev;
        return [custom.detail, ...prev];
      });
    };
    window.addEventListener("aios:room-created", onRoomCreated);
    return () => window.removeEventListener("aios:room-created", onRoomCreated);
  }, []);

  const openCreateModal = () => {
    createClientIdRef.current = generateClientId("room");
    setRoomTitle("");
    setCreateError(null);
    setCreateOpen(true);
  };

  const handleCreateRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (creatingRef.current) return;
    const trimmed = roomTitle.trim();
    if (!trimmed) {
      setCreateError("请输入房间名称（1–100 个字符）。");
      return;
    }
    if (trimmed.length > 100) {
      setCreateError("房间名称不能超过 100 个字符。");
      return;
    }
    creatingRef.current = true;
    setCreating(true);
    setCreateError(null);
    try {
      const created = await createChatRoom({
        client_id: createClientIdRef.current,
        title: trimmed,
      });
      setRooms((prev) =>
        prev.some((r) => r.id === created.id) ? prev : [created, ...prev],
      );
      window.dispatchEvent(
        new CustomEvent<ChatRoom>("aios:room-created", { detail: created }),
      );
      setCreateOpen(false);
      setRoomTitle("");
      router.push(`/inbox/${encodeURIComponent(created.id)}`);
    } catch (error) {
      if (isStaleAuthError(error)) return;
      if (isApiError(error)) {
        if (error.code === "ACCESS_CHANGED") {
          void handleAccessChanged();
        }
        if (error.status === 409) {
          createClientIdRef.current = generateClientId("room");
        }
        setCreateError(error.message);
      } else {
        setCreateError("创建房间失败，请稍后重试。");
      }
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  const agentDisplayName = agentProfile?.display_name || "个人业务助手";
  const agentAvatarSrc = agentProfile?.has_avatar
    ? `/v1/agent-profile/avatar?v=${agentAvatarVersion}`
    : null;
  const isAgentActive =
    activeThread === "assistant" ||
    pathname === "/inbox/assistant" ||
    (pathname === "/inbox" && mode === "list");

  const handleOpenBriefFromRail = (trigger: HTMLElement | null) => {
    setCustomDrawerContent(null);
    openDrawer(
      {
        kind: "brief",
        id: `brief-${Date.now()}`,
        title: "今日与近期工作简报",
      },
      { tab: "current", trigger },
    );
  };

  return (
    <div
      data-testid="inbox-shell"
      className="flex h-full min-h-0 w-full overflow-hidden bg-[var(--bg-canvas)]"
    >
      {/* Left Thread List Pane (280px on desktop, full width on mobile /inbox, hidden on mobile thread) */}
      <aside
        aria-label="会话列表"
        data-testid="inbox-thread-list"
        className={[
          "flex h-full min-h-0 flex-col border-r border-[var(--hairline)] bg-[var(--bg-plane)]",
          mode === "list"
            ? "w-full lg:w-[var(--thread-list-w)] lg:shrink-0"
            : "hidden lg:flex lg:w-[var(--thread-list-w)] lg:shrink-0",
        ].join(" ")}
      >
        {/* Pinned Personal Agent Row — ALWAYS #1 at top */}
        <div className="shrink-0 border-b border-[var(--hairline)] p-2.5">
          <div className="mb-1.5 flex items-center justify-between px-1">
            <span className="font-mono-code text-[10.5px] uppercase tracking-[0.04em] text-[var(--ink-muted)]">
              PINNED · 个人工作台助手
            </span>
            <Link
              href="/settings/agent"
              className="text-[11px] text-[var(--ink-muted)] hover:text-[var(--accent)]"
            >
              资料
            </Link>
          </div>

          <Link
            href="/inbox/assistant"
            data-testid="inbox-pinned-agent"
            aria-current={isAgentActive ? "page" : undefined}
            className={[
              "flex min-h-[52px] items-center gap-2.5 rounded-[4px] border px-2.5 py-2 transition-colors duration-[120ms]",
              isAgentActive
                ? "border-[var(--accent-border)] bg-[var(--accent-wash)] text-[var(--ink-primary)]"
                : "border-transparent bg-[var(--bg-sheet)] text-[var(--ink-primary)] hover:border-[var(--hairline-strong)]",
            ].join(" ")}
          >
            <Avatar
              src={agentAvatarSrc}
              name={agentDisplayName}
              fallbackText="AG"
              size="md"
              kind="agent"
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span
                  data-testid="inbox-pinned-agent-name"
                  className="truncate text-[13.5px] font-semibold text-[var(--ink-primary)]"
                >
                  {agentDisplayName}
                </span>
                <span className="shrink-0 rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-1.5 py-0.5 font-mono-code text-[10px] font-medium uppercase tracking-[0.04em] text-[var(--ink-secondary)] leading-none">
                  Agent
                </span>
              </div>
              <p className="mt-0.5 truncate text-[11.5px] text-[var(--ink-muted)]">
                自然语言指令 · 业务查询与草稿
              </p>
            </div>
          </Link>
        </div>

        {/* Quick Entry Links (Counter badges only — never hijacks active document) */}
        <div className="shrink-0 border-b border-[var(--hairline)] px-2.5 py-2 space-y-1">
          <button
            type="button"
            data-testid="inbox-rail-brief-btn"
            onClick={(e) => handleOpenBriefFromRail(e.currentTarget)}
            className="flex w-full items-center justify-between rounded-[4px] px-2.5 py-1.5 text-[12.5px] text-[var(--ink-secondary)] hover:bg-[var(--bg-plane-hover)] hover:text-[var(--ink-primary)] transition-colors duration-[120ms] cursor-pointer"
          >
            <span className="flex items-center gap-2">
              <CalendarDays className="h-3.5 w-3.5 text-[var(--accent)]" strokeWidth={1.75} />
              <span>今日简报</span>
            </span>
            <span className="font-mono-code text-[10.5px] text-[var(--ink-muted)]">
              BRIEF
            </span>
          </button>

          <Link
            href="/work"
            data-testid="inbox-rail-work-link"
            className="flex w-full items-center justify-between rounded-[4px] px-2.5 py-1.5 text-[12.5px] text-[var(--ink-secondary)] hover:bg-[var(--bg-plane-hover)] hover:text-[var(--ink-primary)] transition-colors duration-[120ms]"
          >
            <span className="flex items-center gap-2">
              <Briefcase className="h-3.5 w-3.5 text-[var(--ink-muted)]" strokeWidth={1.75} />
              <span>待办与审批</span>
            </span>
            {assignedCount > 0 && (
              <span
                data-testid="inbox-rail-assigned-badge"
                className="rounded-[2px] border border-[var(--accent-border)] bg-[var(--accent-wash)] px-1.5 py-0.5 font-mono-code text-[10.5px] font-semibold text-[var(--accent)] leading-none"
              >
                {assignedCount > 99 ? "99+" : assignedCount}
              </span>
            )}
          </Link>
        </div>

        {/* Authorized Human Collaboration Rooms */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex shrink-0 items-center justify-between px-3.5 pt-3 pb-2">
            <span className="font-mono-code text-[11px] uppercase tracking-[0.04em] text-[var(--ink-muted)]">
              协作房间
            </span>
            <div className="flex items-center gap-1">
              {chatAvailable && (
                <>
                  <button
                    type="button"
                    onClick={() => void loadRooms(null)}
                    aria-label="刷新房间列表"
                    title="刷新房间列表"
                    className="inline-flex h-7 w-7 items-center justify-center rounded-[4px] text-[var(--ink-muted)] hover:bg-[var(--bg-plane-hover)] hover:text-[var(--ink-primary)] cursor-pointer"
                  >
                    <RefreshCw
                      className={[
                        "h-3.5 w-3.5",
                        roomsLoading ? "animate-spin" : "",
                      ].join(" ")}
                      strokeWidth={1.75}
                    />
                  </button>
                  <button
                    type="button"
                    data-testid="inbox-create-room-btn"
                    onClick={openCreateModal}
                    aria-label="新建房间"
                    title="新建房间"
                    className="inline-flex h-7 items-center gap-1 rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-2 text-[11.5px] font-medium text-[var(--ink-primary)] hover:border-[var(--accent-border)] hover:text-[var(--accent)] cursor-pointer"
                  >
                    <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
                    <span>新建房间</span>
                  </button>
                </>
              )}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto px-2.5 pb-3">
            {!chatAvailable ? (
              <div
                data-testid="inbox-chat-unavailable"
                className="mt-1 rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] px-3 py-3 text-[12px] text-[var(--ink-muted)]"
              >
                <div className="flex items-center gap-1.5 font-medium text-[var(--ink-secondary)]">
                  <MessageSquareOff className="h-3.5 w-3.5" strokeWidth={1.75} />
                  <span>员工协作房间未启用</span>
                </div>
                <p className="mt-1 leading-relaxed">
                  当前账号未授予协作聊天权限或目录服务未开启，仍可正常使用上方个人业务助手。
                </p>
              </div>
            ) : roomsError ? (
              <AccessNoticeCard
                error={roomsError}
                onRetry={() => void loadRooms(null)}
                className="mt-1"
              />
            ) : roomsLoading && rooms.length === 0 ? (
              <div className="px-2 py-6 text-center text-[12px] text-[var(--ink-muted)]">
                正在加载授权房间…
              </div>
            ) : rooms.length === 0 ? (
              <div
                data-testid="inbox-rooms-empty"
                className="mt-1 rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] px-3 py-4 text-center"
              >
                <p className="text-[12px] text-[var(--ink-muted)]">
                  暂无已加入的协作房间
                </p>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={openCreateModal}
                  className="mt-2.5"
                >
                  <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
                  <span>新建协作房间</span>
                </Button>
              </div>
            ) : (
              <div className="space-y-1" data-testid="inbox-room-list">
                {rooms.map((room) => {
                  const isActive =
                    activeThread === room.id ||
                    pathname === `/inbox/${encodeURIComponent(room.id)}` ||
                    pathname === `/inbox/${room.id}`;
                  return (
                    <Link
                      key={room.id}
                      href={`/inbox/${encodeURIComponent(room.id)}`}
                      data-testid={`inbox-room-item-${room.id}`}
                      aria-current={isActive ? "page" : undefined}
                      className={[
                        "flex min-h-[46px] items-center gap-2.5 rounded-[4px] border px-2.5 py-2 transition-colors duration-[120ms]",
                        isActive
                          ? "border-[var(--accent-border)] bg-[var(--accent-wash)] text-[var(--ink-primary)]"
                          : "border-transparent hover:bg-[var(--bg-plane-hover)] text-[var(--ink-primary)]",
                      ].join(" ")}
                    >
                      <span
                        className={[
                          "flex h-7 w-7 shrink-0 items-center justify-center rounded-[4px] border",
                          isActive
                            ? "border-[var(--accent-border)] bg-[var(--bg-sheet)] text-[var(--accent)]"
                            : "border-[var(--hairline-strong)] bg-[var(--bg-sheet)] text-[var(--ink-muted)]",
                        ].join(" ")}
                      >
                        <Hash className="h-3.5 w-3.5" strokeWidth={1.75} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-medium text-[var(--ink-primary)]">
                          {room.title}
                        </div>
                        <div className="mt-0.5 flex items-center gap-1.5 font-mono-code text-[10.5px] text-[var(--ink-muted)]">
                          <span className="truncate">
                            创建人: {room.owner}
                          </span>
                          {actor && room.owner === actor.subject && (
                            <span className="shrink-0 text-[var(--accent)]">
                              · 群主
                            </span>
                          )}
                        </div>
                      </div>
                    </Link>
                  );
                })}

                {roomsNext && (
                  <div className="pt-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={roomsLoadingMore}
                      onClick={() => void loadRooms(roomsNext)}
                      className="w-full"
                    >
                      {roomsLoadingMore ? "加载中…" : "加载更多房间"}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </aside>

      {/* Center Active Conversation Pane */}
      <section
        className={[
          "min-w-0 flex-1 flex-col bg-[var(--bg-sheet)] overflow-hidden",
          mode === "list" ? "hidden lg:flex" : "flex",
        ].join(" ")}
      >
        {children}
      </section>

      {/* Create Room Modal */}
      <Modal
        open={createOpen}
        onOpenChange={(open) => {
          if (!creating) setCreateOpen(open);
        }}
        title="新建员工协作房间"
        subtitle="房间仅限当前租户成员加入，上下文与个人业务助手严格隔离。"
        size="sm"
        footer={
          <>
            <Button
              variant="secondary"
              disabled={creating}
              onClick={() => setCreateOpen(false)}
            >
              取消
            </Button>
            <Button
              variant="primary"
              loading={creating}
              data-testid="create-room-submit"
              onClick={(e) => void handleCreateRoom(e)}
            >
              {creating ? "创建中…" : "创建房间"}
            </Button>
          </>
        }
      >
        <form onSubmit={(e) => void handleCreateRoom(e)} className="space-y-3">
          <div>
            <label
              htmlFor="new-room-title"
              className="block text-[12.5px] font-medium text-[var(--ink-secondary)]"
            >
              房间名称
            </label>
            <input
              id="new-room-title"
              data-testid="create-room-title-input"
              type="text"
              maxLength={100}
              autoFocus
              value={roomTitle}
              onChange={(e) => {
                setRoomTitle(e.target.value);
                if (createError) setCreateError(null);
              }}
              placeholder="例如：HK01 排期协作组"
              aria-invalid={Boolean(createError)}
              className="mt-1.5 h-9 w-full rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-3 text-[13.5px] text-[var(--ink-primary)] placeholder:text-[var(--ink-faint)] focus:border-[var(--accent)] focus:outline-none"
            />
            <div className="mt-1 flex items-center justify-between text-[11px] text-[var(--ink-muted)]">
              <span>创建后可邀请同租户同事并预约房间会议</span>
              <span className="font-mono-code tabular-nums">
                {roomTitle.trim().length}/100
              </span>
            </div>
          </div>

          {createError && (
            <div
              role="alert"
              className="rounded-[4px] border border-[var(--status-crimson-border)] bg-[var(--status-crimson-wash)] px-3 py-2 text-[12.5px] text-[var(--status-crimson)]"
            >
              {createError}
            </div>
          )}
        </form>
      </Modal>
    </div>
  );
}
