"use client";

import React, { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Popover } from "radix-ui";
import { Bell, Check, Lock, RefreshCw } from "lucide-react";
import {
  fetchNoticeDetail,
  fetchNotices,
  isApiError,
  isStaleAuthError,
  markNoticeRead,
} from "@/lib/api-client";
import {
  DEFAULT_LOCALE,
  localizeNoticeKindForLocale,
  useLocale,
  type Locale,
} from "@/lib/i18n";
import { useSession } from "@/lib/session-context";
import { useWorkbench } from "@/lib/workbench-context";
import type { NoticeKind, NoticeSummary } from "@/lib/types";

function noticeKindToLabel(
  kind: NoticeKind,
  locale: Locale = DEFAULT_LOCALE,
): string {
  return localizeNoticeKindForLocale(kind, locale);
}

export function NoticesPopover({
  align = "end",
  side = "bottom",
}: {
  align?: "start" | "center" | "end";
  side?: "top" | "right" | "bottom" | "left";
}) {
  const router = useRouter();
  const { status, authGeneration } = useSession();
  const { unreadNoticesCount, setUnreadNoticesCount } = useWorkbench();
  const { t, formatDateTime } = useLocale();

  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NoticeSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [inlineNotice, setInlineNotice] = useState<string | null>(null);

  const loadNotices = useCallback(async () => {
    if (status !== "authenticated") return;
    setLoading(true);
    setInlineNotice(null);
    try {
      const page = await fetchNotices({ limit: 25 });
      setItems(page.items);
      const unread = page.items.filter((i) => i.read_at === null).length;
      setUnreadNoticesCount(unread);
    } catch (error) {
      if (isStaleAuthError(error)) return;
    } finally {
      setLoading(false);
    }
  }, [status, setUnreadNoticesCount]);

  useEffect(() => {
    setItems([]);
    setInlineNotice(null);
    if (status === "authenticated") {
      void loadNotices();
    }
  }, [status, authGeneration, loadNotices]);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      void loadNotices();
    }
  };

  const handleSelectNotice = async (item: NoticeSummary) => {
    setOpeningId(item.id);
    setInlineNotice(null);
    try {
      const detail = await fetchNoticeDetail(item.id);
      if (item.read_at === null) {
        try {
          const readRes = await markNoticeRead(item.id);
          setItems((prev) => {
            const updated = prev.map((entry) =>
              entry.id === item.id
                ? { ...entry, read_at: readRes.read_at }
                : entry,
            );
            setUnreadNoticesCount(
              updated.filter((e) => e.read_at === null).length,
            );
            return updated;
          });
        } catch {
          // Non-blocking
        }
      }
      setOpen(false);
      if (detail.kind.startsWith("meeting_")) {
        router.push("/calendar");
      } else {
        router.push(`/proposals/${encodeURIComponent(detail.reference)}`);
      }
    } catch (error) {
      if (isStaleAuthError(error)) return;
      if (isApiError(error) && error.status === 404) {
        setInlineNotice(t("notice.recordUnavailable.message"));
      } else {
        setInlineNotice(t("notices.openFailed"));
      }
    } finally {
      setOpeningId(null);
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={
            unreadNoticesCount > 0
              ? t("notices.unreadAria", { count: unreadNoticesCount })
              : t("notices.label")
          }
          title={t("notices.label")}
          className={[
            "relative inline-flex h-8 w-8 items-center justify-center rounded-full",
            "text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--ink-primary)]",
            "transition-colors duration-[140ms] cursor-pointer",
          ].join(" ")}
        >
          <Bell className="h-[17px] w-[17px]" strokeWidth={1.75} />
          {unreadNoticesCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--accent-solid)] px-1 tabular-nums text-[9.5px] font-semibold text-[var(--accent-fg)] ring-2 ring-[var(--bg-header-solid)]">
              {unreadNoticesCount > 99 ? "99+" : unreadNoticesCount}
            </span>
          )}
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          side={side}
          align={align}
          sideOffset={8}
          className={[
            "z-50 w-[332px] overflow-hidden rounded-lg",
            "bg-[var(--bg-surface)] shadow-[var(--shadow-popover)] focus:outline-none",
          ].join(" ")}
        >
          <div className="flex items-center justify-between border-b border-[var(--hairline)] px-4 py-3">
            <span className="text-[13.5px] font-semibold text-[var(--ink-primary)]">
              {t("notices.title")}
            </span>
            <button
              type="button"
              onClick={() => void loadNotices()}
              disabled={loading}
              aria-label={t("notices.refreshAria")}
              className="inline-flex h-7 w-7 items-center justify-center rounded-full text-[var(--ink-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--ink-primary)] transition-colors cursor-pointer"
            >
              <RefreshCw
                className={["h-3.5 w-3.5", loading ? "animate-spin" : ""].join(
                  " ",
                )}
                strokeWidth={1.85}
              />
            </button>
          </div>

          {inlineNotice && (
            <div className="flex items-center gap-2 border-b border-[var(--hairline)] bg-[var(--bg-surface-tint)] px-4 py-2.5 text-[12px] text-[var(--ink-secondary)]">
              <Lock className="h-3.5 w-3.5 shrink-0 text-[var(--ink-muted)]" />
              <span>{inlineNotice}</span>
            </div>
          )}

          <div className="max-h-[340px] overflow-auto p-1.5 space-y-0.5">
            {items.length === 0 ? (
              <div className="px-4 py-10 text-center text-[12.5px] text-[var(--ink-muted)]">
                {loading ? t("notices.loading") : t("notices.empty")}
              </div>
            ) : (
              items.map((item) => {
                const unread = item.read_at === null;
                return (
                  <button
                    key={item.id}
                    type="button"
                    disabled={openingId === item.id}
                    onClick={() => void handleSelectNotice(item)}
                    className={[
                      "flex w-full items-center justify-between gap-2 rounded-sm px-3 py-2.5 text-left transition-colors duration-[140ms] cursor-pointer",
                      unread
                        ? "bg-[var(--accent-wash)] hover:bg-[var(--accent-wash-strong)]"
                        : "hover:bg-[var(--bg-hover)]",
                    ].join(" ")}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono-code text-[12px] font-medium text-[var(--ink-primary)] truncate">
                          {item.id}
                        </span>
                        {unread ? (
                          <span className="rounded-full bg-[var(--accent-solid)] px-1.5 py-0.5 text-[9.5px] font-semibold text-[var(--accent-fg)] leading-none">
                            {t("notices.unreadBadge")}
                          </span>
                        ) : (
                          <Check
                            className="h-3 w-3 text-[var(--ink-faint)]"
                            strokeWidth={2}
                          />
                        )}
                      </div>
                      <div className="mt-0.5 tabular-nums text-[11px] text-[var(--ink-muted)]">
                        {formatDateTime(item.created_at)}
                      </div>
                    </div>
                    <span className="shrink-0 text-[12px] font-medium text-[var(--accent-ink)]">
                      {openingId === item.id
                        ? t("notices.verifying")
                        : t("notices.view")}
                    </span>
                  </button>
                );
              })
            )}
          </div>
          <div className="border-t border-[var(--hairline)] bg-[var(--bg-surface-tint)] px-4 py-2.5 text-[11px] text-[var(--ink-muted)]">
            {t("notices.footer")}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export { noticeKindToLabel };
