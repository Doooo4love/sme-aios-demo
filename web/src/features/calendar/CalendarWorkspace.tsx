"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  Plus,
  RefreshCw,
} from "lucide-react";
import {
  isApiError,
  isStaleAuthError,
  type ApiError,
} from "@/lib/api-client";
import { formatClockRange } from "@/lib/format";
import { useSession } from "@/lib/session-context";
import { useWorkbench } from "@/lib/workbench-context";
import { AccessNoticeCard } from "@/components/ui/AccessNoticeCard";
import { Button } from "@/components/ui/Button";
import { SourceTag } from "@/components/ui/SourceTag";
import { StatusBadge } from "@/components/ui/StatusBadge";
import {
  fetchCalendarEvents,
  toLocalOffsetIso,
} from "@/features/calendar/api";
import { CalendarEventDrawer } from "@/features/calendar/CalendarEventDrawer";
import { CreateEventModal } from "@/features/calendar/CreateEventModal";
import type { CalendarCursor, CalendarEvent } from "@/lib/types";

type CalendarViewMode = "day" | "week" | "month";

const WEEKDAY_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0);
}

function formatDayKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function computeWindow(
  anchor: Date,
  mode: CalendarViewMode,
): { start: Date; end: Date; label: string } {
  const dayStart = startOfLocalDay(anchor);
  const pad = (n: number) => String(n).padStart(2, "0");

  if (mode === "day") {
    const end = new Date(dayStart.getTime() + 86_400_000);
    return {
      start: dayStart,
      end,
      label: `${formatDayKey(dayStart)} ${WEEKDAY_NAMES[dayStart.getDay()]}`,
    };
  }

  if (mode === "week") {
    // Rolling 7-day window starting from anchor day so upcoming bookings are always immediately visible
    const end = new Date(dayStart.getTime() + 7 * 86_400_000);
    const lastDay = new Date(end.getTime() - 86_400_000);
    return {
      start: dayStart,
      end,
      label: `${formatDayKey(dayStart)} – ${formatDayKey(lastDay)}`,
    };
  }

  // Month-list view (always 28–31 days, strictly <= 93 days backend cap)
  const monthStart = new Date(anchor.getFullYear(), anchor.getMonth(), 1, 0, 0, 0);
  const monthEnd = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1, 0, 0, 0);
  return {
    start: monthStart,
    end: monthEnd,
    label: `${monthStart.getFullYear()} 年 ${pad(monthStart.getMonth() + 1)} 月`,
  };
}

function shiftAnchor(
  anchor: Date,
  mode: CalendarViewMode,
  direction: -1 | 1,
): Date {
  if (mode === "day") {
    return new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + direction);
  }
  if (mode === "week") {
    return new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + direction * 7);
  }
  return new Date(anchor.getFullYear(), anchor.getMonth() + direction, 1);
}

export function CalendarWorkspace() {
  const { status, actor, authGeneration, handleAccessChanged } = useSession();
  const {
    selectedObject,
    openDrawer,
    clearSelectedObject,
    setCustomDrawerContent,
  } = useWorkbench();

  const [viewMode, setViewMode] = useState<CalendarViewMode>("week");
  const [anchorDate, setAnchorDate] = useState<Date>(() =>
    startOfLocalDay(new Date()),
  );
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<CalendarCursor | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [createModalOpen, setCreateModalOpen] = useState(false);

  const range = useMemo(
    () => computeWindow(anchorDate, viewMode),
    [anchorDate, viewMode],
  );

  const loadEvents = useCallback(
    async (cursor?: CalendarCursor | null) => {
      if (status !== "authenticated") return;
      if (cursor) {
        setLoadingMore(true);
      } else {
        setLoading(true);
      }
      setError(null);
      try {
        const res = await fetchCalendarEvents({
          start: toLocalOffsetIso(range.start),
          end: toLocalOffsetIso(range.end),
          limit: 50,
          after_start: cursor?.after_start,
          after_id: cursor?.after_id,
        });
        setEvents((prev) => {
          if (!cursor) return res.items;
          const byId = new Map<string, CalendarEvent>();
          for (const item of prev) byId.set(item.id, item);
          for (const item of res.items) byId.set(item.id, item);
          return Array.from(byId.values()).sort(
            (a, b) => a.starts_at - b.starts_at || a.id.localeCompare(b.id),
          );
        });
        setNextCursor(res.next);
      } catch (err) {
        if (isStaleAuthError(err)) return;
        if (isApiError(err)) {
          if (err.code === "ACCESS_CHANGED") {
            setEvents([]);
            setNextCursor(null);
            clearSelectedObject();
            void handleAccessChanged();
          }
          setError(err);
        }
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [status, range.start, range.end, clearSelectedObject, handleAccessChanged],
  );

  useEffect(() => {
    setEvents([]);
    setNextCursor(null);
    setError(null);
    setCreateModalOpen(false);
    if (status === "authenticated") {
      void loadEvents(null);
    }
  }, [status, authGeneration, range.start, range.end, loadEvents]);

  const handleEventUpdated = useCallback((updated: CalendarEvent) => {
    setEvents((prev) => {
      const exists = prev.some((e) => e.id === updated.id);
      const next = exists
        ? prev.map((e) => (e.id === updated.id ? updated : e))
        : [...prev, updated];
      return next.sort(
        (a, b) => a.starts_at - b.starts_at || a.id.localeCompare(b.id),
      );
    });
  }, []);

  // Bind calendar event inspector into Right Workbench Drawer
  useEffect(() => {
    if (selectedObject?.kind === "calendar") {
      setCustomDrawerContent(
        <CalendarEventDrawer
          eventId={selectedObject.id}
          onEventUpdated={handleEventUpdated}
        />,
      );
      return;
    }
    setCustomDrawerContent(null);
  }, [selectedObject, setCustomDrawerContent, handleEventUpdated]);

  useEffect(() => {
    return () => {
      setCustomDrawerContent(null);
    };
  }, [setCustomDrawerContent]);

  // Group events cleanly by local calendar day
  const groupedByDay = useMemo(() => {
    const map = new Map<string, { label: string; items: CalendarEvent[] }>();
    for (const ev of events) {
      const d = new Date(ev.starts_at * 1000);
      const key = formatDayKey(d);
      const existing = map.get(key);
      if (existing) {
        existing.items.push(ev);
      } else {
        map.set(key, {
          label: `${key} ${WEEKDAY_NAMES[d.getDay()]}`,
          items: [ev],
        });
      }
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [events]);

  return (
    <div
      data-testid="calendar-workspace"
      className="flex h-full min-h-0 flex-col bg-[var(--bg-canvas)]"
    >
      {/* Top Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-[var(--hairline)] bg-[var(--bg-sheet)] px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-center gap-2">
          {/* View Mode Segmented Switcher */}
          <div
            role="tablist"
            aria-label="日历视图切换"
            className="inline-flex rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-plane)] p-0.5"
          >
            {(
              [
                { id: "day", label: "日" },
                { id: "week", label: "周" },
                { id: "month", label: "月列表" },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={viewMode === tab.id}
                data-testid={`calendar-view-${tab.id}`}
                onClick={() => setViewMode(tab.id)}
                className={[
                  "rounded-[3px] px-3 py-1 text-[12px] font-medium transition-colors duration-[120ms] cursor-pointer",
                  viewMode === tab.id
                    ? "bg-[var(--bg-sheet)] text-[var(--ink-primary)] border border-[var(--hairline-strong)]"
                    : "text-[var(--ink-muted)] hover:text-[var(--ink-primary)] border border-transparent",
                ].join(" ")}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Date Range Navigation */}
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="上一周期"
              onClick={() =>
                setAnchorDate((d) => shiftAnchor(d, viewMode, -1))
              }
              className="inline-flex h-8 w-8 items-center justify-center rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] text-[var(--ink-secondary)] hover:bg-[var(--bg-subtle)] cursor-pointer"
            >
              <ChevronLeft className="h-4 w-4" strokeWidth={1.75} />
            </button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setAnchorDate(startOfLocalDay(new Date()))}
              className="h-8"
            >
              今天
            </Button>
            <button
              type="button"
              aria-label="下一周期"
              onClick={() =>
                setAnchorDate((d) => shiftAnchor(d, viewMode, 1))
              }
              className="inline-flex h-8 w-8 items-center justify-center rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] text-[var(--ink-secondary)] hover:bg-[var(--bg-subtle)] cursor-pointer"
            >
              <ChevronRight className="h-4 w-4" strokeWidth={1.75} />
            </button>
          </div>

          <span
            data-testid="calendar-range-label"
            className="font-mono-code text-[13px] font-semibold text-[var(--ink-primary)] ml-1"
          >
            {range.label}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void loadEvents(null)}
            disabled={loading}
          >
            <RefreshCw
              className={["h-3.5 w-3.5", loading ? "animate-spin" : ""].join(
                " ",
              )}
              strokeWidth={1.75}
            />
            <span>刷新</span>
          </Button>
          <Button
            size="sm"
            variant="primary"
            data-testid="calendar-create-btn"
            onClick={() => setCreateModalOpen(true)}
            className="h-8"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
            <span>新建日程</span>
          </Button>
        </div>
      </div>

      {/* Main Chronological Timeline */}
      <div className="min-h-0 flex-1 overflow-auto px-4 py-5 sm:px-6">
        <div className="mx-auto max-w-[920px] space-y-4">
          {error && (
            <AccessNoticeCard error={error} onRetry={() => void loadEvents(null)} />
          )}

          {loading && events.length === 0 ? (
            <div className="rounded-[6px] border border-[var(--hairline)] bg-[var(--bg-sheet)] py-16 text-center text-[13px] text-[var(--ink-muted)]">
              正在加载站内日程…
            </div>
          ) : !error && groupedByDay.length === 0 ? (
            <div
              data-testid="calendar-empty-state"
              className="rounded-[6px] border border-[var(--hairline)] bg-[var(--bg-sheet)] px-6 py-14 text-center"
            >
              <CalendarIcon
                className="mx-auto h-6 w-6 text-[var(--ink-faint)]"
                strokeWidth={1.5}
              />
              <h3 className="mt-2.5 text-[14.5px] font-semibold text-[var(--ink-primary)]">
                当前时间窗口内暂无日程
              </h3>
              <p className="mt-1 text-[12.5px] text-[var(--ink-muted)]">
                可点击右上角“新建日程”创建个人事项，或在协作房间内预约多人房间会议。
              </p>
              <Button
                size="sm"
                variant="secondary"
                className="mt-4"
                onClick={() => setCreateModalOpen(true)}
              >
                <Plus className="h-3.5 w-3.5" />
                <span>新建站内日程</span>
              </Button>
            </div>
          ) : (
            <div className="space-y-4" data-testid="calendar-event-list">
              {groupedByDay.map(([dayKey, group]) => (
                <section
                  key={dayKey}
                  className="overflow-hidden rounded-[6px] border border-[var(--hairline)] bg-[var(--bg-sheet)]"
                >
                  <header className="flex items-center justify-between border-b border-[var(--hairline)] bg-[var(--bg-plane)] px-4 py-2">
                    <h3 className="font-mono-code text-[12.5px] font-semibold text-[var(--ink-primary)]">
                      {group.label}
                    </h3>
                    <span className="font-mono-code text-[11px] text-[var(--ink-muted)]">
                      {group.items.length} 项日程
                    </span>
                  </header>

                  <div className="divide-y divide-[var(--hairline)]">
                    {group.items.map((ev) => {
                      const isSelected =
                        selectedObject?.kind === "calendar" &&
                        selectedObject.id === ev.id;
                      const isOrganizer = actor?.subject === ev.organizer;
                      return (
                        <button
                          key={ev.id}
                          type="button"
                          data-testid={`calendar-event-row-${ev.id}`}
                          onClick={(e) =>
                            openDrawer(
                              {
                                kind: "calendar",
                                id: ev.id,
                                title: ev.title,
                              },
                              { tab: "current", trigger: e.currentTarget },
                            )
                          }
                          className={[
                            "flex w-full flex-col gap-1.5 px-4 py-3 text-left transition-colors duration-[120ms] cursor-pointer sm:flex-row sm:items-center sm:justify-between",
                            isSelected
                              ? "bg-[var(--accent-wash)]"
                              : "hover:bg-[var(--bg-subtle)]",
                          ].join(" ")}
                        >
                          <div className="flex min-w-0 items-start gap-4">
                            <span className="w-[104px] shrink-0 font-mono-code text-[12.5px] font-semibold text-[var(--ink-primary)] pt-0.5">
                              {formatClockRange(ev.starts_at, ev.ends_at)}
                            </span>
                            <div className="min-w-0">
                              <div
                                className={[
                                  "text-[13.5px] font-medium text-[var(--ink-primary)] break-words",
                                  ev.cancelled
                                    ? "line-through text-[var(--ink-muted)]"
                                    : "",
                                ].join(" ")}
                              >
                                {ev.title}
                              </div>
                              <div className="mt-0.5 flex flex-wrap items-center gap-2 font-mono-code text-[11px] text-[var(--ink-muted)]">
                                <span>组织人: {ev.organizer}</span>
                                {isOrganizer && (
                                  <span className="text-[var(--accent)]">
                                    · 我发起的
                                  </span>
                                )}
                                <span>· r{ev.revision}</span>
                              </div>
                            </div>
                          </div>

                          <div className="flex shrink-0 items-center gap-2 pl-[120px] sm:pl-0">
                            {ev.cancelled && (
                              <StatusBadge status="cancelled" compact />
                            )}
                            <SourceTag source={ev.source} />
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </section>
              ))}

              {nextCursor && (
                <div className="pt-1">
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={loadingMore}
                    data-testid="calendar-load-more"
                    onClick={() => void loadEvents(nextCursor)}
                    className="w-full"
                  >
                    {loadingMore ? "加载中…" : "加载更多日程"}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Create Event Modal */}
      <CreateEventModal
        open={createModalOpen}
        onOpenChange={setCreateModalOpen}
        onCreated={(created) => {
          handleEventUpdated(created);
          // Also reload window cleanly if the new event falls inside current range
          void loadEvents(null);
          openDrawer(
            {
              kind: "calendar",
              id: created.id,
              title: created.title,
            },
            { tab: "current" },
          );
        }}
      />
    </div>
  );
}
