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
import { sortWarehouses } from "@/lib/format";
import {
  PERSONA_LOCALIZATIONS,
  localizeContactDepartment,
  localizeContactJobTitle,
  useLocale,
} from "@/lib/i18n";
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
  const { locale, tx, localizePersona, localizeRole, localizeError } =
    useLocale();

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

  const warehouseCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of contacts) {
      for (const wh of c.warehouses) {
        if (wh) counts.set(wh, (counts.get(wh) ?? 0) + 1);
      }
    }
    return sortWarehouses(Array.from(counts.keys())).map((wh) => ({
      wh,
      count: counts.get(wh) ?? 0,
    }));
  }, [contacts]);

  const filteredContacts = useMemo(() => {
    if (selectedWarehouse === "ALL") return contacts;
    return contacts.filter((c) => c.warehouses.includes(selectedWarehouse));
  }, [contacts, selectedWarehouse]);

  const resolveContactDisplay = useCallback(
    (contact: CompanyContact) => {
      const known =
        PERSONA_LOCALIZATIONS[
          contact.subject as keyof typeof PERSONA_LOCALIZATIONS
        ];
      const persona = localizePersona(contact.subject, {
        display_name: contact.display_name,
        label: contact.job_title ?? undefined,
        department: contact.department ?? undefined,
      });
      const isCustomName =
        Boolean(contact.display_name) &&
        contact.display_name !== contact.subject &&
        (!known || contact.display_name !== known["zh-CN"].displayName);
      const jobTitle = contact.job_title
        ? localizeContactJobTitle(contact.job_title, contact.subject, locale)
        : localizeRole(contact.role);
      const department = contact.department
        ? localizeContactDepartment(contact.department, contact.subject, locale)
        : "";
      return {
        displayName: isCustomName ? contact.display_name : persona.displayName,
        roleLabel: known ? persona.label : jobTitle,
        department: known ? persona.department : department,
      };
    },
    [locale, localizePersona, localizeRole],
  );

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
        setStartError(localizeError(err));
      } else {
        setStartError(
          tx({
            "zh-CN": "发起对话失败，请稍后重试。",
            "zh-HK": "發起對話失敗，請稍後重試。",
            en: "Could not start chat. Please try again.",
          }),
        );
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
      title={tx({
        "zh-CN": "全公司联系人目录",
        "zh-HK": "全公司聯絡人目錄",
        en: "Company Directory",
      })}
      subtitle={
        actor
          ? tx(
              {
                "zh-CN": "仅展示当前企业（{tenant}）内同事 · 选择同事即可发起 1:1 对话",
                "zh-HK": "僅顯示目前企業（{tenant}）內同事 · 選擇同事即可發起 1:1 對話",
                en: "Showing colleagues in {tenant} only · Start a 1:1 chat with any colleague",
              },
              { tenant: actor.tenant },
            )
          : tx({
              "zh-CN": "仅展示同企业同事",
              "zh-HK": "僅顯示同企業同事",
              en: "Showing same-organization colleagues only",
            })
      }
      size="md"
    >
      <div data-testid="contacts-directory-modal" className="space-y-4">
        {/* Search Pill — single unified focus-within ring on wrapper */}
        <div className="relative flex items-center rounded-full border border-[var(--hairline-strong)] bg-[var(--bg-surface-subtle)] transition-colors duration-[150ms] focus-within:border-[var(--accent)] focus-within:bg-[var(--bg-surface)] focus-within:ring-2 focus-within:ring-[var(--accent)]/30">
          <Search
            className="pointer-events-none absolute left-3.5 h-4 w-4 text-[var(--ink-muted)]"
            strokeWidth={1.85}
          />
          <input
            type="text"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            data-testid="contacts-modal-search-input"
            placeholder={tx({
              "zh-CN": "搜索姓名、部门、岗位或账号…",
              "zh-HK": "搜尋姓名、部門、職位或帳號…",
              en: "Search name, team, role, or account…",
            })}
            style={{ outline: "none" }}
            className="h-10 w-full rounded-full border-0 bg-transparent pl-10 pr-9 text-[13.5px] text-[var(--ink-primary)] placeholder:text-[var(--ink-faint)] focus:outline-none focus:ring-0"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label={tx({
                "zh-CN": "清空搜索",
                "zh-HK": "清除搜尋",
                en: "Clear search",
              })}
              className="absolute right-2.5 inline-flex h-6 w-6 items-center justify-center rounded-full text-[var(--ink-muted)] hover:bg-[var(--bg-hover)] cursor-pointer"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Warehouse Filter Pills — consistent counts across ALL pills (M-12b, S-3) */}
        {warehouseCounts.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              aria-pressed={selectedWarehouse === "ALL"}
              onClick={() => setSelectedWarehouse("ALL")}
              className={[
                "rounded-full px-3 py-1 text-[12px] font-medium tabular-nums transition-colors cursor-pointer",
                selectedWarehouse === "ALL"
                  ? "bg-[var(--accent-solid)] text-[var(--accent-fg)]"
                  : "bg-[var(--bg-surface-subtle)] text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)]",
              ].join(" ")}
            >
              {tx(
                {
                  "zh-CN": "全部仓库 ({count})",
                  "zh-HK": "全部倉庫 ({count})",
                  en: "All Warehouses ({count})",
                },
                { count: contacts.length },
              )}
            </button>
            {warehouseCounts.map(({ wh, count }) => (
              <button
                key={wh}
                type="button"
                aria-pressed={selectedWarehouse === wh}
                onClick={() => setSelectedWarehouse(wh)}
                className={[
                  "rounded-full px-3 py-1 text-[12px] font-medium tabular-nums transition-colors cursor-pointer",
                  selectedWarehouse === wh
                    ? "bg-[var(--accent-solid)] text-[var(--accent-fg)]"
                    : "bg-[var(--bg-surface-subtle)] text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)]",
                ].join(" ")}
              >
                <span className="font-mono-code">{wh}</span> ({count})
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

        {/* Contacts List — valid semantic rows (no nested interactive div+Button, M-12d) + scroll fade affordance (M-12c) */}
        <div className="relative">
          <div className="max-h-[400px] overflow-y-auto space-y-1 pr-0.5 pb-4">
            {loading && contacts.length === 0 ? (
              <div className="flex items-center justify-center gap-2 py-12 text-[13px] text-[var(--ink-muted)]">
                <Loader2 className="h-4 w-4 animate-spin text-[var(--accent)]" />
                <span>
                  {tx({
                    "zh-CN": "正在检索同公司联系人…",
                    "zh-HK": "正在檢索同公司聯絡人…",
                    en: "Loading company directory…",
                  })}
                </span>
              </div>
            ) : !error && filteredContacts.length === 0 ? (
              <div className="rounded-tile bg-[var(--bg-surface-tint)] px-5 py-12 text-center">
                <Users
                  className="mx-auto h-6 w-6 text-[var(--ink-muted)]"
                  strokeWidth={1.6}
                />
                <p className="mt-2.5 text-[13.5px] font-medium text-[var(--ink-primary)]">
                  {query.trim()
                    ? tx({
                        "zh-CN": "未找到匹配的同公司同事",
                        "zh-HK": "找不到符合條件的同公司同事",
                        en: "No matching colleagues found",
                      })
                    : tx({
                        "zh-CN": "当前企业租户暂无其他活跃同事",
                        "zh-HK": "目前企業租戶暫無其他活躍同事",
                        en: "No other active colleagues in this tenant",
                      })}
                </p>
                <p className="mt-1 text-[12px] text-[var(--ink-muted)]">
                  {tx({
                    "zh-CN": "通讯录严格按企业租户边界隔离，不会检索外部租户账号。",
                    "zh-HK": "聯絡人嚴格按企業租戶邊界隔離，不會檢索外部租戶帳號。",
                    en: "Strictly tenant-isolated — external tenant accounts are never visible.",
                  })}
                </p>
              </div>
            ) : (
              filteredContacts.map((contact) => {
                const isBusy = startingSubject === contact.subject;
                const { displayName, roleLabel, department } =
                  resolveContactDisplay(contact);
                const sortedWh = sortWarehouses(contact.warehouses);
                return (
                  <div
                    key={contact.subject}
                    data-testid={`contact-row-${contact.subject}`}
                    title={contact.subject}
                    className="group flex items-center justify-between gap-3 rounded-tile px-3 py-2.5 hover:bg-[var(--bg-surface-tint)] transition-colors duration-[140ms]"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <Avatar
                        src={contact.avatar_url}
                        name={displayName}
                        fallbackText={contact.subject}
                        size="md"
                      />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="truncate text-[13.5px] font-semibold text-[var(--ink-primary)]">
                            {displayName}
                          </span>
                          <span className="truncate text-[12px] text-[var(--ink-muted)]">
                            · {roleLabel}
                          </span>
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11.5px] text-[var(--ink-muted)]">
                          {department && (
                            <span className="inline-flex items-center gap-1 truncate">
                              <Building2 className="h-3 w-3 shrink-0 text-[var(--ink-muted)]" />
                              <span>{department}</span>
                            </span>
                          )}
                          {sortedWh.length > 0 && (
                            <span className="font-mono-code text-[11px] text-[var(--ink-muted)]">
                              {department ? "· " : ""}
                              {sortedWh.join(" / ")}
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
                      onClick={() => void handleStartChat(contact)}
                    >
                      <MessageSquare
                        className="h-3.5 w-3.5"
                        strokeWidth={1.85}
                      />
                      <span>
                        {isBusy
                          ? tx({
                              "zh-CN": "打开中…",
                              "zh-HK": "開啟中…",
                              en: "Opening…",
                            })
                          : contact.direct_room_id
                            ? tx({
                                "zh-CN": "继续对话",
                                "zh-HK": "繼續對話",
                                en: "Open Chat",
                              })
                            : tx({
                                "zh-CN": "发起对话",
                                "zh-HK": "發起對話",
                                en: "Message",
                              })}
                      </span>
                    </Button>
                  </div>
                );
              })
            )}
          </div>
          {filteredContacts.length > 5 && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute right-0 bottom-0 left-0 h-5 bg-gradient-to-t from-[var(--bg-surface)] to-transparent"
            />
          )}
        </div>
      </div>
    </Modal>
  );
}
