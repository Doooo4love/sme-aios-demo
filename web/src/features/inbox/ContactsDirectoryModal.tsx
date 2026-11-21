"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Building2,
  Loader2,
  MessageSquare,
  Search,
  Users,
  X,
} from "lucide-react";
import {
  fetchCompanyContacts,
  isApiError,
  isStaleAuthError,
  openOrCreateDirectRoom,
  type ApiError,
} from "@/lib/api-client";
import { formatRoleLabel } from "@/lib/format";
import { useSession } from "@/lib/session-context";
import { AccessNoticeCard } from "@/components/ui/AccessNoticeCard";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import type { ChatRoom, CompanyContact } from "@/lib/types";

export interface ContactsDirectoryModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRoomOpened?: (room: ChatRoom, created: boolean) => void;
}

export function ContactsDirectoryModal({
  open,
  onOpenChange,
  onRoomOpened,
}: ContactsDirectoryModalProps) {
  const router = useRouter();
  const { actor, authGeneration, handleAccessChanged } = useSession();

  const [query, setQuery] = useState("");
  const [selectedWarehouse, setSelectedWarehouse] = useState<string>("ALL");
  const [contacts, setContacts] = useState<CompanyContact[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [startingSubject, setStartingSubject] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

  const debounceRef = useRef<number | null>(null);
  const startingRef = useRef(false);

  const loadContacts = useCallback(
    async (searchText: string) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetchCompanyContacts(searchText || undefined, {
          limit: 50,
        });
        setContacts(res.items);
      } catch (err) {
        if (isStaleAuthError(err)) return;
        if (isApiError(err)) {
          if (err.code === "ACCESS_CHANGED") {
            void handleAccessChanged();
          }
          setError(err);
        }
      } finally {
        setLoading(false);
      }
    },
    [handleAccessChanged],
  );

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelectedWarehouse("ALL");
    setStartError(null);
    setStartingSubject(null);
    startingRef.current = false;
    void loadContacts("");
  }, [open, authGeneration, loadContacts]);

  useEffect(() => {
    if (!open) return;
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
    }
    debounceRef.current = window.setTimeout(() => {
      void loadContacts(query);
    }, 180);
    return () => {
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
      }
    };
  }, [open, query, loadContacts]);

  const availableWarehouses = useMemo(() => {
    const set = new Set<string>();
    for (const c of contacts) {
      for (const wh of c.warehouses) {
        if (wh) set.add(wh);
      }
    }
    return Array.from(set).sort();
  }, [contacts]);

  const filteredContacts = useMemo(() => {
    if (selectedWarehouse === "ALL") return contacts;
    return contacts.filter((c) => c.warehouses.includes(selectedWarehouse));
  }, [contacts, selectedWarehouse]);

  const handleStartChat = async (contact: CompanyContact) => {
    if (startingRef.current) return;
    startingRef.current = true;
    setStartingSubject(contact.subject);
    setStartError(null);

    try {
      const { room, created } = await openOrCreateDirectRoom(
        contact.subject,
        contact.display_name,
        contact.direct_room_id,
      );
      if (created) {
        window.dispatchEvent(
          new CustomEvent<ChatRoom>("aios:room-created", { detail: room }),
        );
      }
      onRoomOpened?.(room, created);
      onOpenChange(false);
      router.push(`/inbox/${encodeURIComponent(room.id)}`);
    } catch (err) {
      if (isStaleAuthError(err)) return;
      if (isApiError(err)) {
        if (err.code === "ACCESS_CHANGED") {
          void handleAccessChanged();
        }
        setStartError(err.message);
      } else {
        setStartError("发起对话失败，请稍后重试。");
      }
    } finally {
      startingRef.current = false;
      setStartingSubject(null);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!startingSubject) onOpenChange(next);
      }}
      title="全公司联系人目录"
      subtitle={
        actor
          ? `仅展示当前企业（${actor.tenant}）内同事 · 点击即可发起 1:1 对话`
          : "仅展示同企业同事"
      }
      size="md"
    >
      <div data-testid="contacts-directory-modal" className="space-y-4">
        {/* Search Pill — calm single 1.5px ring, no heavy glow halo */}
        <div className="relative flex items-center">
          <Search
            className="pointer-events-none absolute left-3.5 h-4 w-4 text-[var(--ink-faint)]"
            strokeWidth={1.85}
          />
          <input
            type="text"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            data-testid="contacts-modal-search-input"
            placeholder="搜索姓名、部门、岗位或账号…"
            className="h-10 w-full rounded-full bg-[var(--bg-surface-subtle)] pl-10 pr-9 text-[13.5px] text-[var(--ink-primary)] placeholder:text-[var(--ink-faint)] ring-1 ring-transparent focus:bg-[var(--bg-surface)] focus:ring-[1.5px] focus:ring-[var(--accent)] focus:outline-none transition-colors duration-[150ms]"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="清空搜索"
              className="absolute right-2.5 inline-flex h-6 w-6 items-center justify-center rounded-full text-[var(--ink-muted)] hover:bg-[var(--bg-hover)] cursor-pointer"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Warehouse Filter Pills */}
        {availableWarehouses.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => setSelectedWarehouse("ALL")}
              className={[
                "rounded-full px-3 py-1 text-[12px] font-medium transition-colors cursor-pointer",
                selectedWarehouse === "ALL"
                  ? "bg-[var(--accent)] text-white"
                  : "bg-[var(--bg-surface-subtle)] text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)]",
              ].join(" ")}
            >
              全部站点 ({contacts.length})
            </button>
            {availableWarehouses.map((wh) => (
              <button
                key={wh}
                type="button"
                onClick={() => setSelectedWarehouse(wh)}
                className={[
                  "rounded-full px-3 py-1 font-mono-code text-[12px] font-medium transition-colors cursor-pointer",
                  selectedWarehouse === wh
                    ? "bg-[var(--accent)] text-white"
                    : "bg-[var(--bg-surface-subtle)] text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)]",
                ].join(" ")}
              >
                {wh}
              </button>
            ))}
          </div>
        )}

        {startError && (
          <div
            role="alert"
            className="rounded-tile bg-[var(--status-crimson-wash)] px-3.5 py-2.5 text-[12.5px] text-[var(--status-crimson)]"
          >
            {startError}
          </div>
        )}

        {error && (
          <AccessNoticeCard
            error={error}
            onRetry={() => void loadContacts(query)}
          />
        )}

        {/* Contacts List — clickable rows with quiet accent CTAs */}
        <div className="max-h-[400px] overflow-y-auto space-y-1 pr-0.5">
          {loading && contacts.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-12 text-[13px] text-[var(--ink-muted)]">
              <Loader2 className="h-4 w-4 animate-spin text-[var(--accent)]" />
              <span>正在检索同公司联系人…</span>
            </div>
          ) : !error && filteredContacts.length === 0 ? (
            <div className="rounded-tile bg-[var(--bg-surface-tint)] px-5 py-12 text-center">
              <Users
                className="mx-auto h-6 w-6 text-[var(--ink-faint)]"
                strokeWidth={1.6}
              />
              <p className="mt-2.5 text-[13.5px] font-medium text-[var(--ink-primary)]">
                {query.trim()
                  ? "未找到匹配的同公司同事"
                  : "当前企业租户暂无其他活跃同事"}
              </p>
              <p className="mt-1 text-[12px] text-[var(--ink-muted)]">
                通讯录严格按企业租户边界隔离，不会检索外部租户账号。
              </p>
            </div>
          ) : (
            filteredContacts.map((contact) => {
              const isBusy = startingSubject === contact.subject;
              const roleLabel =
                contact.job_title || formatRoleLabel(contact.role);
              return (
                <div
                  key={contact.subject}
                  data-testid={`contact-row-${contact.subject}`}
                  onClick={() => void handleStartChat(contact)}
                  className="group flex items-center justify-between gap-3 rounded-tile px-3 py-2.5 hover:bg-[var(--bg-surface-tint)] transition-colors duration-[140ms] cursor-pointer"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <Avatar
                      src={contact.avatar_url}
                      name={contact.display_name}
                      fallbackText={contact.subject}
                      size="md"
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="truncate text-[13.5px] font-semibold text-[var(--ink-primary)]">
                          {contact.display_name}
                        </span>
                        <span className="truncate text-[12px] text-[var(--ink-muted)]">
                          · {roleLabel}
                        </span>
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11.5px] text-[var(--ink-muted)]">
                        {contact.department && (
                          <span className="inline-flex items-center gap-1 truncate">
                            <Building2 className="h-3 w-3 shrink-0 text-[var(--ink-faint)]" />
                            <span>{contact.department}</span>
                          </span>
                        )}
                        <span className="font-mono-code text-[11px] text-[var(--ink-faint)]">
                          {contact.subject}
                        </span>
                        {contact.warehouses.length > 0 && (
                          <span className="font-mono-code text-[10.5px] text-[var(--ink-muted)]">
                            · {contact.warehouses.join(" / ")}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  <Button
                    size="sm"
                    variant="quiet"
                    pill
                    loading={isBusy}
                    disabled={startingSubject !== null}
                    data-testid={`contact-start-chat-${contact.subject}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleStartChat(contact);
                    }}
                  >
                    <MessageSquare className="h-3.5 w-3.5" strokeWidth={1.85} />
                    <span>
                      {isBusy
                        ? "打开中…"
                        : contact.direct_room_id
                          ? "继续对话"
                          : "发起对话"}
                    </span>
                  </Button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </Modal>
  );
}
