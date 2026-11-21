"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Popover } from "radix-ui";
import {
  BookUser,
  Bot,
  Briefcase,
  CalendarDays,
  ChevronRight,
  LayoutGrid,
  Loader2,
  LogOut,
  MessageSquare,
  MessageSquareOff,
  Search,
  SquarePen,
  User,
  X,
} from "lucide-react";
import {
  fetchCompanyContacts,
  generateClientId,
  getAuthGeneration,
  isApiError,
  isStaleAuthError,
  openOrCreateDirectRoom,
  type ApiError,
} from "@/lib/api-client";
import { formatRoleLabel, getTenantMark } from "@/lib/format";
import { useSession } from "@/lib/session-context";
import { useWorkbench } from "@/lib/workbench-context";
import { Interactive3DCard } from "@/components/kinetic";
import { DemoPersonaSwitcher } from "@/components/shell/DemoPersonaSwitcher";
import { NoticesPopover } from "@/components/shell/NoticesPopover";
import { AccessNoticeCard } from "@/components/ui/AccessNoticeCard";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { fetchRoomMessages } from "@/features/chat/api";
import { createChatRoom, fetchChatRooms } from "@/features/inbox/api";
import {
  getAssistantMemory,
  subscribeAssistantMemory,
} from "@/features/inbox/assistant-store";
import { ContactsDirectoryModal } from "@/features/inbox/ContactsDirectoryModal";
import type { ChatRoom, CompanyContact } from "@/lib/types";

export interface InboxShellProps {
  /**
   * "list" is used by /inbox: shows full-width thread list on mobile (<1024px)
   * and Left Sidebar + Right Conversation Canvas on desktop (>=1024px).
   * "thread" is used by /inbox/assistant and /inbox/[roomId]: shows Left Sidebar
   * on desktop (>=1024px) and full-width Right Conversation Canvas on mobile (<1024px).
   */
  mode: "list" | "thread";
  activeThread: "assistant" | string;
  children: React.ReactNode;
}

interface RoomPreviewMeta {
  text: string;
  createdAt: number;
}

function getRoomDisplayLabel(title: string): string {
  const withoutPrefix = title.replace(/^私聊\s*[·•]\s*/, "").trim();
  const withoutAccountSuffix = withoutPrefix
    .replace(/\s*\([A-Za-z0-9._-]+\)\s*$/, "")
    .trim();
  return withoutAccountSuffix || withoutPrefix || title;
}

function formatCompactThreadTime(unixSeconds: number): string {
  if (!unixSeconds || !Number.isFinite(unixSeconds)) return "";
  const d = new Date(unixSeconds * 1000);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");

  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const startOfMsgDay = new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
  ).getTime();
  const dayDiff = Math.round((startOfToday - startOfMsgDay) / 86_400_000);

  if (dayDiff === 0) {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  if (dayDiff === 1) {
    return "昨天";
  }
  if (d.getFullYear() === now.getFullYear()) {
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }
  return `${d.getFullYear()}/${d.getMonth() + 1}`;
}

export function InboxShell({ mode, activeThread, children }: InboxShellProps) {
  const router = useRouter();
  const pathname = usePathname() || "/inbox";
  const {
    status,
    actor,
    capabilities,
    profile,
    agentProfile,
    avatarVersion,
    agentAvatarVersion,
    demoConfig,
    authGeneration,
    handleAccessChanged,
    logout,
  } = useSession();
  const { assignedCount } = useWorkbench();

  // Live last turn snippet for Pinned Personal Agent row
  const [assistantMemoryTick, setAssistantMemoryTick] = useState(0);
  useEffect(
    () => subscribeAssistantMemory(() => setAssistantMemoryTick((t) => t + 1)),
    [],
  );
  const lastAssistantSnippet = useMemo(() => {
    void assistantMemoryTick;
    const { turns } = getAssistantMemory(authGeneration);
    const latest = turns[turns.length - 1];
    return latest?.userText?.trim() || null;
  }, [authGeneration, assistantMemoryTick]);

  const [rooms, setRooms] = useState<ChatRoom[]>([]);
  const [roomsNext, setRoomsNext] = useState<string | null>(null);
  const [roomsLoading, setRoomsLoading] = useState(false);
  const [roomsLoadingMore, setRoomsLoadingMore] = useState(false);
  const [roomsError, setRoomsError] = useState<ApiError | null>(null);
  const [roomPreviews, setRoomPreviews] = useState<
    Record<string, RoomPreviewMeta>
  >({});

  // Account Popover state
  const [accountOpen, setAccountOpen] = useState(false);

  // Unified search (filters existing rooms + live tenant-scoped company contacts)
  const [searchQuery, setSearchQuery] = useState("");
  const [contactHits, setContactHits] = useState<CompanyContact[]>([]);
  const [contactsSearching, setContactsSearching] = useState(false);
  const [startingContactSubject, setStartingContactSubject] = useState<
    string | null
  >(null);
  const [contactsModalOpen, setContactsModalOpen] = useState(false);

  // Create room modal state
  const [createOpen, setCreateOpen] = useState(false);
  const [roomTitle, setRoomTitle] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const createClientIdRef = useRef<string>(generateClientId("room"));
  const creatingRef = useRef(false);
  const startingContactRef = useRef(false);
  const fetchedPreviewsRef = useRef<Set<string>>(new Set());
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const chatAvailable = Boolean(capabilities?.chat_available);

  // Bounded lightweight hydration of latest message preview + timestamp per room
  const hydrateRoomPreviews = useCallback(
    async (roomList: ChatRoom[], startGen: number) => {
      const candidates = roomList
        .filter((r) => !fetchedPreviewsRef.current.has(r.id))
        .slice(0, 12);
      if (candidates.length === 0) return;

      for (const r of candidates) {
        fetchedPreviewsRef.current.add(r.id);
      }

      const settled = await Promise.allSettled(
        candidates.map(async (room) => {
          const res = await fetchRoomMessages(room.id, { limit: 100, after: 0 });
          const last =
            res.items.length > 0 ? res.items[res.items.length - 1] : null;
          return { roomId: room.id, last };
        }),
      );
      if (startGen !== getAuthGeneration()) return;

      setRoomPreviews((prev) => {
        const next = { ...prev };
        for (const item of settled) {
          if (item.status === "fulfilled" && item.value.last) {
            next[item.value.roomId] = {
              text: item.value.last.text,
              createdAt: item.value.last.created_at,
            };
          }
        }
        return next;
      });
    },
    [],
  );

  const loadRooms = useCallback(
    async (after?: string | null) => {
      if (status !== "authenticated" || !chatAvailable) {
        setRooms([]);
        setRoomsNext(null);
        setRoomsError(null);
        return;
      }
      const startGen = getAuthGeneration();
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
        if (startGen !== getAuthGeneration()) return;
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
        void hydrateRoomPreviews(res.items, startGen);
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
    [status, chatAvailable, handleAccessChanged, hydrateRoomPreviews],
  );

  useEffect(() => {
    fetchedPreviewsRef.current.clear();
    setRooms([]);
    setRoomsNext(null);
    setRoomsError(null);
    setRoomPreviews({});
    setAccountOpen(false);
    setSearchQuery("");
    setContactHits([]);
    setContactsModalOpen(false);
    setCreateOpen(false);
    setRoomTitle("");
    setCreateError(null);
    createClientIdRef.current = generateClientId("room");
    if (status === "authenticated" && chatAvailable) {
      void loadRooms(null);
    }
  }, [authGeneration, status, chatAvailable, loadRooms]);

  // Synchronize newly created rooms & live message previews from ChatRoomWorkspace
  useEffect(() => {
    const onRoomCreated = (event: Event) => {
      const custom = event as CustomEvent<ChatRoom>;
      if (!custom.detail?.id) return;
      setRooms((prev) => {
        if (prev.some((r) => r.id === custom.detail.id)) return prev;
        return [custom.detail, ...prev];
      });
    };
    const onRoomPreview = (event: Event) => {
      const custom = event as CustomEvent<{
        roomId: string;
        text: string;
        createdAt: number;
      }>;
      if (!custom.detail?.roomId) return;
      setRoomPreviews((prev) => ({
        ...prev,
        [custom.detail.roomId]: {
          text: custom.detail.text,
          createdAt: custom.detail.createdAt,
        },
      }));
    };
    window.addEventListener("aios:room-created", onRoomCreated);
    window.addEventListener("aios:room-preview", onRoomPreview);
    return () => {
      window.removeEventListener("aios:room-created", onRoomCreated);
      window.removeEventListener("aios:room-preview", onRoomPreview);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const trimmed = searchQuery.trim();
    if (!trimmed || status !== "authenticated" || !chatAvailable) {
      setContactHits([]);
      setContactsSearching(false);
      return;
    }

    let cancelled = false;
    setContactsSearching(true);
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetchCompanyContacts(trimmed, { limit: 15 });
        if (!cancelled) setContactHits(res.items);
      } catch (err) {
        if (!cancelled && !isStaleAuthError(err)) {
          setContactHits([]);
        }
      } finally {
        if (!cancelled) setContactsSearching(false);
      }
    }, 180);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [searchQuery, status, chatAvailable]);

  const filteredRooms = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return rooms;
    return rooms.filter(
      (room) =>
        room.title.toLowerCase().includes(q) ||
        room.owner.toLowerCase().includes(q),
    );
  }, [rooms, searchQuery]);

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
      setCreateError("请输入群聊或房间名称（1–100 个字符）。");
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

  const handleQuickStartDirectChat = async (contact: CompanyContact) => {
    if (startingContactRef.current) return;
    startingContactRef.current = true;
    setStartingContactSubject(contact.subject);
    try {
      const { room, created } = await openOrCreateDirectRoom(
        contact.subject,
        contact.display_name,
        contact.direct_room_id,
      );
      if (created) {
        setRooms((prev) =>
          prev.some((r) => r.id === room.id) ? prev : [room, ...prev],
        );
        window.dispatchEvent(
          new CustomEvent<ChatRoom>("aios:room-created", { detail: room }),
        );
      }
      setSearchQuery("");
      router.push(`/inbox/${encodeURIComponent(room.id)}`);
    } catch (err) {
      if (isStaleAuthError(err)) return;
      if (isApiError(err) && err.code === "ACCESS_CHANGED") {
        void handleAccessChanged();
      }
    } finally {
      startingContactRef.current = false;
      setStartingContactSubject(null);
    }
  };

  const handleLogout = async () => {
    setAccountOpen(false);
    await logout();
    router.replace("/login");
  };

  const userDisplayName = profile?.display_name || actor?.subject || "员工";
  const userAvatarSrc = profile?.has_avatar
    ? `/v1/profile/avatar?v=${avatarVersion}`
    : null;
  const agentDisplayName = agentProfile?.display_name || "个人业务助手";
  const agentAvatarSrc = agentProfile?.has_avatar
    ? `/v1/agent-profile/avatar?v=${agentAvatarVersion}`
    : null;

  const isAgentActive =
    activeThread === "assistant" ||
    pathname === "/inbox/assistant" ||
    (pathname === "/inbox" && mode === "list");

  const isSearching = searchQuery.trim().length > 0;

  return (
    <div
      data-testid="inbox-shell"
      className="flex h-full min-h-0 w-full overflow-hidden bg-[var(--bg-app)]"
    >
      {/* Left Frosted macOS Sequoia Sidebar (300px on desktop, full width on mobile /inbox) */}
      <aside
        aria-label="会话列表"
        data-testid="inbox-thread-list"
        className={[
          "aios-sidebar-glass flex h-full min-h-0 flex-col border-r border-[var(--hairline)]",
          mode === "list"
            ? "w-full lg:w-[var(--sidebar-w)] lg:shrink-0"
            : "hidden lg:flex lg:w-[var(--sidebar-w)] lg:shrink-0",
        ].join(" ")}
      >
        {/* Top Sidebar Header: Tenant Monogram + Title + Contacts Directory & New Group */}
        <div className="flex shrink-0 items-center justify-between gap-2 px-3.5 pt-3.5 pb-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--bg-surface)] font-mono-code text-[11px] font-semibold text-[var(--accent)] shadow-[var(--shadow-subtle)]">
              {actor ? getTenantMark(actor.tenant) : "AI"}
            </span>
            <h1 className="truncate text-[16px] font-semibold tracking-[-0.02em] text-[var(--ink-primary)]">
              消息
            </h1>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {chatAvailable && (
              <>
                <button
                  type="button"
                  data-testid="contacts-directory-btn"
                  onClick={() => setContactsModalOpen(true)}
                  aria-label="打开全公司联系人目录"
                  title="通讯录 · 搜索同公司同事"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-full text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--accent)] transition-colors duration-[140ms] cursor-pointer"
                >
                  <BookUser className="h-[17px] w-[17px]" strokeWidth={1.8} />
                </button>
                <button
                  type="button"
                  data-testid="inbox-create-room-btn"
                  onClick={openCreateModal}
                  aria-label="新建群聊"
                  title="新建群聊"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-full text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--accent)] transition-colors duration-[140ms] cursor-pointer"
                >
                  <SquarePen className="h-[17px] w-[17px]" strokeWidth={1.8} />
                </button>
              </>
            )}
          </div>
        </div>

        {/* Unified Pill Search Bar */}
        <div className="shrink-0 px-3 pb-2.5">
          <div className="relative flex items-center">
            <Search
              className="pointer-events-none absolute left-3 h-3.5 w-3.5 text-[var(--ink-faint)]"
              strokeWidth={1.9}
            />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              data-testid="contacts-search-input"
              placeholder="搜索同事或会话…"
              aria-label="搜索同事或会话"
              className="h-9 w-full rounded-full bg-[var(--bg-surface)]/80 pl-8.5 pr-8 text-[13px] text-[var(--ink-primary)] placeholder:text-[var(--ink-faint)] shadow-[var(--shadow-subtle)] focus:bg-[var(--bg-surface)] focus:ring-[1.5px] focus:ring-[var(--accent)] focus:outline-none transition-all duration-[150ms]"
            />
            {searchQuery ? (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                aria-label="清空搜索"
                className="absolute right-2 inline-flex h-5 w-5 items-center justify-center rounded-full text-[var(--ink-muted)] hover:bg-[var(--bg-hover)] cursor-pointer"
              >
                <X className="h-3 w-3" />
              </button>
            ) : (
              <kbd className="pointer-events-none absolute right-2.5 hidden sm:inline-block rounded-xs bg-[var(--bg-surface-subtle)] px-1.5 py-0.5 font-mono-code text-[10px] text-[var(--ink-faint)]">
                ⌘K
              </kbd>
            )}
          </div>
        </div>

        {/* Pinned #1 Personal Agent Hero Tile (borderless Agent micro-label + live snippet) */}
        <div className="shrink-0 px-2.5 pb-2.5">
          <Interactive3DCard
            maxTilt={2}
            hoverLiftPx={-1}
            sheenIntensity="subtle"
            className={[
              "rounded-tile transition-all duration-[160ms]",
              isAgentActive
                ? "bg-[var(--bg-surface)] shadow-[var(--shadow-card)] ring-1 ring-[var(--accent-border)]"
                : "bg-[var(--bg-surface)]/70 shadow-[var(--shadow-subtle)] hover:bg-[var(--bg-surface)] hover:shadow-[var(--shadow-card)]",
            ].join(" ")}
          >
            <Link
              href="/inbox/assistant"
              data-testid="inbox-pinned-agent"
              aria-current={isAgentActive ? "page" : undefined}
              className="relative z-[3] flex items-center gap-3 px-3 py-2.5"
            >
              <span className="relative inline-flex shrink-0">
                <Avatar
                  src={agentAvatarSrc}
                  name={agentDisplayName}
                  fallbackText="AG"
                  size="md"
                  kind="agent"
                />
                <span
                  aria-hidden="true"
                  className="absolute right-0 bottom-0 h-2.5 w-2.5 rounded-full bg-[var(--accent)] ring-2 ring-white"
                />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-1.5 min-w-0">
                  <span
                    data-testid="inbox-pinned-agent-name"
                    className="truncate text-[13.5px] font-semibold text-[var(--ink-primary)]"
                  >
                    {agentDisplayName}
                  </span>
                  <span className="shrink-0 text-[11px] font-normal text-[var(--ink-faint)]">
                    Agent
                  </span>
                </div>
                <p className="mt-0.5 truncate text-[12px] text-[var(--ink-muted)]">
                  {lastAssistantSnippet || "随时为你查询与起草"}
                </p>
              </div>
              {assignedCount > 0 && (
                <span
                  title={`${assignedCount} 项待审批`}
                  className="h-2 w-2 shrink-0 rounded-full bg-[var(--accent)]"
                />
              )}
            </Link>
          </Interactive3DCard>
        </div>

        {/* Scrollable Colleagues & Rooms Thread List (or Live Search Results) */}
        <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3 space-y-3">
          {!chatAvailable ? (
            <div
              data-testid="inbox-chat-unavailable"
              className="px-2 py-4 text-[12px] text-[var(--ink-muted)]"
            >
              <div className="flex items-center gap-1.5 font-medium text-[var(--ink-secondary)]">
                <MessageSquareOff className="h-3.5 w-3.5" strokeWidth={1.8} />
                <span>同事协作聊天未启用</span>
              </div>
              <p className="mt-1 leading-relaxed">
                当前账号未开通同事会话权限，可继续使用上方个人业务助手。
              </p>
            </div>
          ) : isSearching ? (
            <div className="space-y-3" data-testid="inbox-search-results">
              {/* Live Company Colleagues Search Results */}
              <div>
                <div className="flex items-center justify-between px-2 pb-1 text-[11px] font-medium text-[var(--ink-muted)]">
                  <span>同公司同事</span>
                  {contactsSearching && (
                    <Loader2 className="h-3 w-3 animate-spin text-[var(--accent)]" />
                  )}
                </div>
                {!contactsSearching && contactHits.length === 0 ? (
                  <div className="px-2 py-2 text-[12px] text-[var(--ink-muted)]">
                    未匹配到相关同事
                  </div>
                ) : (
                  <div className="space-y-0.5">
                    {contactHits.map((contact) => {
                      const isBusy =
                        startingContactSubject === contact.subject;
                      return (
                        <button
                          key={contact.subject}
                          type="button"
                          disabled={startingContactSubject !== null}
                          data-testid={`sidebar-contact-start-chat-${contact.subject}`}
                          onClick={() => void handleQuickStartDirectChat(contact)}
                          className="flex w-full items-center gap-2.5 rounded-sm px-2.5 py-2 text-left hover:bg-[var(--bg-surface)] hover:shadow-[var(--shadow-subtle)] transition-all duration-[140ms] cursor-pointer disabled:opacity-60"
                        >
                          <Avatar
                            src={contact.avatar_url}
                            name={contact.display_name}
                            fallbackText={contact.subject}
                            size="md"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-1.5">
                              <span className="truncate text-[13px] font-semibold text-[var(--ink-primary)]">
                                {contact.display_name}
                              </span>
                              <span className="shrink-0 text-[11.5px] font-medium text-[var(--accent)]">
                                {isBusy ? "打开中…" : "发消息"}
                              </span>
                            </div>
                            <div className="mt-0.5 truncate text-[11.5px] text-[var(--ink-muted)]">
                              {contact.job_title || formatRoleLabel(contact.role)}
                              {contact.warehouses.length > 0
                                ? ` · ${contact.warehouses.join("/")}`
                                : ""}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Matching Existing Rooms */}
              <div>
                <div className="px-2 pb-1 text-[11px] font-medium text-[var(--ink-muted)]">
                  会话与群聊 ({filteredRooms.length})
                </div>
                {filteredRooms.length === 0 ? (
                  <div className="px-2 py-2 text-[12px] text-[var(--ink-muted)]">
                    无匹配的已有会话
                  </div>
                ) : (
                  <div className="space-y-0.5">
                    {filteredRooms.map((room) => {
                      const isActive =
                        activeThread === room.id ||
                        pathname === `/inbox/${encodeURIComponent(room.id)}` ||
                        pathname === `/inbox/${room.id}`;
                      const label = getRoomDisplayLabel(room.title);
                      const preview = roomPreviews[room.id];
                      return (
                        <Link
                          key={room.id}
                          href={`/inbox/${encodeURIComponent(room.id)}`}
                          onClick={() => setSearchQuery("")}
                          className={[
                            "flex items-center gap-2.5 rounded-sm px-2.5 py-2 transition-colors duration-[140ms]",
                            isActive
                              ? "bg-[var(--accent-wash-strong)] text-[var(--ink-primary)]"
                              : "hover:bg-[var(--bg-hover)] text-[var(--ink-primary)]",
                          ].join(" ")}
                        >
                          <Avatar
                            name={label}
                            fallbackText={room.owner}
                            size="sm"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[13px] font-medium text-[var(--ink-primary)]">
                              {label}
                            </div>
                            <div className="truncate text-[11.5px] text-[var(--ink-muted)]">
                              {preview?.text || room.owner}
                            </div>
                          </div>
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div>
              <div className="flex items-center justify-between px-2 pb-1.5">
                <span className="text-[11.5px] font-medium text-[var(--ink-muted)]">
                  同事与群聊
                </span>
              </div>

              {roomsError ? (
                <AccessNoticeCard
                  error={roomsError}
                  onRetry={() => void loadRooms(null)}
                />
              ) : roomsLoading && rooms.length === 0 ? (
                <div className="px-2 py-8 text-center text-[12px] text-[var(--ink-muted)]">
                  正在同步会话…
                </div>
              ) : rooms.length === 0 ? (
                /* Unboxed serene empty state — plain centered copy + single quiet link */
                <div
                  data-testid="inbox-rooms-empty"
                  className="px-3 py-8 text-center"
                >
                  <p className="text-[12.5px] text-[var(--ink-muted)]">
                    暂无同事会话
                  </p>
                  <Button
                    size="sm"
                    variant="quiet"
                    pill
                    onClick={() => setContactsModalOpen(true)}
                    className="mt-1.5"
                  >
                    打开通讯录
                  </Button>
                </div>
              ) : (
                <div className="space-y-0.5" data-testid="inbox-room-list">
                  {rooms.map((room) => {
                    const isActive =
                      activeThread === room.id ||
                      pathname === `/inbox/${encodeURIComponent(room.id)}` ||
                      pathname === `/inbox/${room.id}`;
                    const label = getRoomDisplayLabel(room.title);
                    const isDirect = room.title.startsWith("私聊");
                    const isOwner = Boolean(actor && room.owner === actor.subject);
                    const preview = roomPreviews[room.id];
                    const timeLabel = preview
                      ? formatCompactThreadTime(preview.createdAt)
                      : "";
                    const tooltipText = isDirect
                      ? `${label} · 1:1 私聊`
                      : `${label}${isOwner ? " · 我是群主" : ` · 创建人 ${room.owner}`}`;

                    return (
                      <Link
                        key={room.id}
                        href={`/inbox/${encodeURIComponent(room.id)}`}
                        data-testid={`inbox-room-item-${room.id}`}
                        aria-current={isActive ? "page" : undefined}
                        title={tooltipText}
                        className={[
                          "flex min-h-[54px] items-center gap-2.5 rounded-sm px-2.5 py-2 transition-colors duration-[140ms]",
                          isActive
                            ? "bg-[var(--accent-wash-strong)] text-[var(--ink-primary)]"
                            : "hover:bg-[var(--bg-hover)] text-[var(--ink-primary)]",
                        ].join(" ")}
                      >
                        <Avatar
                          name={label}
                          fallbackText={room.owner}
                          size="md"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="truncate text-[13.5px] font-medium text-[var(--ink-primary)]">
                              {label}
                            </span>
                            {timeLabel && (
                              <span className="shrink-0 font-mono-code text-[11px] text-[var(--ink-muted)] tabular-nums">
                                {timeLabel}
                              </span>
                            )}
                          </div>
                          <p className="mt-0.5 truncate text-[12px] text-[var(--ink-muted)]">
                            {preview?.text ||
                              (isDirect ? "开始 1:1 对话" : "暂无消息")}
                          </p>
                        </div>
                      </Link>
                    );
                  })}

                  {roomsNext && (
                    <div className="pt-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        pill
                        loading={roomsLoadingMore}
                        onClick={() => void loadRooms(roomsNext)}
                        className="w-full"
                      >
                        {roomsLoadingMore ? "加载中…" : "加载更多会话"}
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Serene Single-Row Bottom Sidebar Dock (Demo switcher folded inside account popover) */}
        <div className="shrink-0 border-t border-[var(--hairline)] px-3 py-2.5">
          <div className="flex items-center justify-between gap-2">
            {/* User Avatar + Account Popover Menu */}
            <Popover.Root open={accountOpen} onOpenChange={setAccountOpen}>
              <Popover.Trigger asChild>
                <button
                  type="button"
                  aria-label="账号与资料菜单"
                  title={`${userDisplayName} · 账号与设置`}
                  className="flex min-w-0 flex-1 items-center gap-2.5 rounded-full py-1 pl-1 pr-2.5 text-left hover:bg-[var(--bg-hover)] transition-colors duration-[140ms] cursor-pointer"
                >
                  <Avatar
                    src={userAvatarSrc}
                    name={userDisplayName}
                    fallbackText={actor?.subject || "U"}
                    size="sm"
                    status="online"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-semibold text-[var(--ink-primary)] leading-tight">
                      {userDisplayName}
                    </div>
                    <div className="mt-0.5 truncate font-mono-code text-[10.5px] text-[var(--ink-muted)] leading-tight">
                      {actor
                        ? `${formatRoleLabel(actor.role)} · ${actor.warehouses.join("/") || actor.tenant}`
                        : ""}
                    </div>
                  </div>
                </button>
              </Popover.Trigger>

              <Popover.Portal>
                <Popover.Content
                  side="top"
                  align="start"
                  sideOffset={10}
                  className="z-50 w-[268px] rounded-card bg-[var(--bg-surface)] p-1.5 shadow-[var(--shadow-popover)] focus:outline-none"
                >
                  <div className="border-b border-[var(--hairline)] px-3 py-2.5">
                    <div className="truncate text-[13.5px] font-semibold text-[var(--ink-primary)]">
                      {userDisplayName}
                    </div>
                    {actor && (
                      <div className="mt-0.5 font-mono-code text-[11px] text-[var(--ink-muted)]">
                        {actor.subject} · {actor.tenant} ·{" "}
                        {actor.warehouses.join(", ") || "无站点"}
                      </div>
                    )}
                  </div>

                  <div className="py-1 space-y-0.5">
                    <Link
                      href="/settings/profile"
                      onClick={() => setAccountOpen(false)}
                      className="flex items-center justify-between gap-2 rounded-sm px-3 py-2 text-[12.5px] text-[var(--ink-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                    >
                      <span className="flex items-center gap-2.5">
                        <User className="h-3.5 w-3.5 text-[var(--ink-muted)]" />
                        <span>个人资料</span>
                      </span>
                      <ChevronRight className="h-3.5 w-3.5 text-[var(--ink-faint)]" />
                    </Link>

                    <Link
                      href="/settings/agent"
                      onClick={() => setAccountOpen(false)}
                      title={`个人 Agent 资料：${agentDisplayName}`}
                      className="flex items-center justify-between gap-2 rounded-sm px-3 py-2 text-[12.5px] text-[var(--ink-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                    >
                      <span className="flex min-w-0 items-center gap-2.5">
                        <Bot className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
                        <span className="truncate">
                          助手设定（{agentDisplayName}）
                        </span>
                      </span>
                      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--ink-faint)]" />
                    </Link>

                    <Link
                      href="/calendar"
                      onClick={() => setAccountOpen(false)}
                      className="flex items-center justify-between gap-2 rounded-sm px-3 py-2 text-[12.5px] text-[var(--ink-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                    >
                      <span className="flex items-center gap-2.5">
                        <CalendarDays className="h-3.5 w-3.5 text-[var(--ink-muted)]" />
                        <span>日历与同步</span>
                      </span>
                      <ChevronRight className="h-3.5 w-3.5 text-[var(--ink-faint)]" />
                    </Link>

                    <Link
                      href="/work"
                      onClick={() => setAccountOpen(false)}
                      className="flex items-center justify-between gap-2 rounded-sm px-3 py-2 text-[12.5px] text-[var(--ink-primary)] hover:bg-[var(--bg-hover)] transition-colors"
                    >
                      <span className="flex items-center gap-2.5">
                        <Briefcase className="h-3.5 w-3.5 text-[var(--ink-muted)]" />
                        <span>工作台</span>
                      </span>
                      {assignedCount > 0 ? (
                        <span className="rounded-full bg-[var(--accent)] px-1.5 py-0.5 font-mono-code text-[10px] font-semibold text-white">
                          {assignedCount}
                        </span>
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5 text-[var(--ink-faint)]" />
                      )}
                    </Link>
                  </div>

                  {/* Controlled Demo Persona Switcher folded cleanly inside account menu */}
                  {demoConfig?.enabled && (
                    <div className="border-t border-[var(--hairline)] px-3 py-2.5 space-y-1.5">
                      <div className="text-[11px] font-medium text-[var(--ink-muted)]">
                        演示角色
                      </div>
                      <DemoPersonaSwitcher side="right" align="end" />
                    </div>
                  )}

                  <div className="border-t border-[var(--hairline)] pt-1">
                    <button
                      type="button"
                      onClick={() => void handleLogout()}
                      className="flex w-full cursor-pointer items-center gap-2.5 rounded-sm px-3 py-2 text-left text-[12.5px] text-[var(--status-crimson)] hover:bg-[var(--status-crimson-wash)] transition-colors"
                    >
                      <LogOut className="h-3.5 w-3.5" />
                      <span>退出登录</span>
                    </button>
                  </div>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>

            {/* Quiet Utility Icons */}
            <div className="flex items-center gap-0.5 shrink-0">
              <Link
                href="/work"
                aria-label="进入工作台"
                title="工作台"
                className="relative inline-flex h-8 w-8 items-center justify-center rounded-full text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--accent)] transition-colors lg:hidden"
              >
                <LayoutGrid className="h-[17px] w-[17px]" strokeWidth={1.8} />
                {assignedCount > 0 && (
                  <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-[var(--accent)]" />
                )}
              </Link>
              <Link
                href="/calendar"
                aria-label="日历与同步"
                title="日历与同步"
                className="inline-flex h-8 w-8 items-center justify-center rounded-full text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--accent)] transition-colors"
              >
                <CalendarDays className="h-[17px] w-[17px]" strokeWidth={1.8} />
              </Link>
              <NoticesPopover side="top" align="end" />
            </div>
          </div>
        </div>
      </aside>

      {/* Right Active Conversation Canvas */}
      <section
        className={[
          "aios-thread-pane min-w-0 flex-1 flex-col bg-[var(--bg-surface)] overflow-hidden",
          mode === "list" ? "hidden lg:flex" : "flex",
        ].join(" ")}
      >
        {children}
      </section>

      {/* Company Contacts Directory Modal */}
      <ContactsDirectoryModal
        open={contactsModalOpen}
        onOpenChange={setContactsModalOpen}
        onRoomOpened={(room, created) => {
          if (created) {
            setRooms((prev) =>
              prev.some((r) => r.id === room.id) ? prev : [room, ...prev],
            );
          }
        }}
      />

      {/* Create Group Chat Modal */}
      <Modal
        open={createOpen}
        onOpenChange={(open) => {
          if (!creating) setCreateOpen(open);
        }}
        title="新建员工群聊"
        subtitle="仅限同企业租户同事加入，上下文与个人业务助手严格隔离。"
        size="sm"
        footer={
          <>
            <Button
              variant="ghost"
              pill
              disabled={creating}
              onClick={() => setCreateOpen(false)}
            >
              取消
            </Button>
            <Button
              variant="primary"
              pill
              loading={creating}
              data-testid="create-room-submit"
              onClick={(e) => void handleCreateRoom(e)}
            >
              {creating ? "创建中…" : "创建群聊"}
            </Button>
          </>
        }
      >
        <form onSubmit={(e) => void handleCreateRoom(e)} className="space-y-3.5">
          <div>
            <label
              htmlFor="new-room-title"
              className="block text-[12.5px] font-medium text-[var(--ink-secondary)]"
            >
              群聊名称
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
              className="mt-1.5 h-10 w-full rounded-sm bg-[var(--bg-surface-tint)] px-3.5 text-[13.5px] text-[var(--ink-primary)] placeholder:text-[var(--ink-faint)] ring-1 ring-[var(--hairline-strong)] focus:bg-[var(--bg-surface)] focus:ring-2 focus:ring-[var(--accent)] focus:outline-none transition-all"
            />
            <div className="mt-1.5 flex items-center justify-between text-[11.5px] text-[var(--ink-muted)]">
              <span className="flex items-center gap-1">
                <MessageSquare className="h-3 w-3" />
                <span>创建后可邀请同租户同事并预约会议</span>
              </span>
              <span className="font-mono-code tabular-nums">
                {roomTitle.trim().length}/100
              </span>
            </div>
          </div>

          {createError && (
            <div
              role="alert"
              className="rounded-tile bg-[var(--status-crimson-wash)] px-3.5 py-2.5 text-[12.5px] text-[var(--status-crimson)]"
            >
              {createError}
            </div>
          )}
        </form>
      </Modal>
    </div>
  );
}
