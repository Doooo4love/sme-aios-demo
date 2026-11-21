"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  Download,
  Plus,
  RefreshCw,
  Sparkles,
  Video,
} from "lucide-react";
import {
  getCalendarIcsUrl,
  isApiError,
  isStaleAuthError,
  parseNaturalLanguageZoomBooking,
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
import { McpCalendarConnectorsPanel } from "@/features/calendar/McpCalendarConnectorsPanel";
import { ZoomBookingCard } from "@/features/inbox/ZoomBookingCard";
import type {
  CalendarCursor,
  CalendarEvent,
  ZoomBookingConfirmResponse,
  ZoomBookingPreviewResponse,
} from "@/lib/types";

type CalendarViewMode = "day" | "week" | "month";

const WEEKDAY_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

const NL_ZOOM_EXAMPLES = [
  "明天下午3点和manager用Zoom开HK01订单评审会",
  "后天上午10点和finance开INV-100对账会",
] as const;

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
    const end = new Date(dayStart.getTime() + 7 * 86_400_000);
    const lastDay = new Date(end.getTime() - 86_400_000);
    return {
      start: dayStart,
      end,
      label: `${formatDayKey(dayStart)} – ${formatDayKey(lastDay)}`,
    };
  }

  const monthStart = new Date(
    anchor.getFullYear(),
    anchor.getMonth(),
    1,
    0,
    0,
    0,
  );
  const monthEnd = new Date(
    anchor.getFullYear(),
    anchor.getMonth() + 1,
    1,
    0,
    0,
    0,
  );
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
    return new Date(
      anchor.getFullYear(),
      anchor.getMonth(),
      anchor.getDate() + direction,
    );
  }
  if (mode === "week") {
    return new Date(
      anchor.getFullYear(),
      anchor.getMonth(),
      anchor.getDate() + direction * 7,
    );
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

  const [nlUtterance, setNlUtterance] = useState("");
  const [nlParsing, setNlParsing] = useState(false);
  const [nlParseError, setNlParseError] = useState<string | null>(null);
  const [nlPreview, setNlPreview] = useState<ZoomBookingPreviewResponse | null>(
    null,
  );
  const [nlConfirmed, setNlConfirmed] =
    useState<ZoomBookingConfirmResponse | null>(null);
  const nlInputRef = useRef<HTMLInputElement | null>(null);

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
    setNlPreview(null);
    setNlConfirmed(null);
    setNlParseError(null);
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

  const handleNlZoomParse = async (utteranceOverride?: string) => {
    const query = (utteranceOverride ?? nlUtterance).trim();
    if (!query || nlParsing) return;
    if (utteranceOverride) {
      setNlUtterance(query);
    }
    setNlParsing(true);
    setNlParseError(null);
    setNlPreview(null);
    setNlConfirmed(null);
    try {
      const timezone =
        Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
      const tzOffsetMinutes = -new Date().getTimezoneOffset();
      const preview = await parseNaturalLanguageZoomBooking({
        utterance: query,
        timezone,
        tz_offset_minutes: tzOffsetMinutes,
      });
      setNlPreview(preview);
    } catch (err) {
      if (isStaleAuthError(err)) return;
      setNlParseError(
        isApiError(err)
          ? err.message
          : "未能解析会议内容，请检查时间或同事名称后重试。",
      );
    } finally {
      setNlParsing(false);
    }
  };

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
      className="min-h-full bg-[var(--bg-app)] px-4 py-6 sm:px-6 lg:px-8"
    >
      <div className="mx-auto max-w-[1080px] space-y-6">
        {/* Page Header Card & Natural-Language Zoom Meeting Bar */}
        <section className="rounded-card bg-[var(--bg-surface)] p-5 shadow-[var(--shadow-card)] space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-[20px] font-semibold tracking-[-0.02em] text-[var(--ink-primary)]">
                日历与会议协作中心
              </h1>
              <p className="mt-1 text-[13px] text-[var(--ink-muted)]">
                用自然语言直接预约同租户 Zoom 会议，并同步 Google Calendar、Apple iCloud、Outlook / M365。
              </p>
            </div>
            <Button
              size="sm"
              variant="primary"
              pill
              data-testid="calendar-create-btn"
              onClick={() => setCreateModalOpen(true)}
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={2} />
              <span>新建日程</span>
            </Button>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleNlZoomParse();
            }}
            className="flex flex-wrap items-center gap-2 rounded-tile bg-[var(--bg-surface-tint)] p-2 pl-3.5 ring-1 ring-[var(--hairline-strong)] focus-within:bg-[var(--bg-surface)] focus-within:ring-2 focus-within:ring-[var(--accent)] transition-all"
          >
            <Video
              className="h-4 w-4 shrink-0 text-[var(--accent)]"
              strokeWidth={1.9}
            />
            <input
              ref={nlInputRef}
              type="text"
              value={nlUtterance}
              onChange={(e) => setNlUtterance(e.target.value)}
              data-testid="zoom-nl-input"
              placeholder="输入自然语言预定 Zoom 会议，如：明天下午3点和 manager 开 HK01 评审会"
              className="min-w-[220px] flex-1 bg-transparent py-1 text-[13.5px] text-[var(--ink-primary)] placeholder:text-[var(--ink-faint)] focus:outline-none"
            />
            <Button
              type="submit"
              size="sm"
              variant="primary"
              pill
              loading={nlParsing}
              disabled={!nlUtterance.trim() || nlParsing}
            >
              <Sparkles className="h-3.5 w-3.5" strokeWidth={1.9} />
              <span>{nlParsing ? "解析中…" : "解析预约预览"}</span>
            </Button>
          </form>

          <div className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
            <span className="text-[var(--ink-muted)]">试试：</span>
            {NL_ZOOM_EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => void handleNlZoomParse(example)}
                className="rounded-full bg-[var(--bg-surface-subtle)] px-3 py-1 text-[var(--ink-secondary)] hover:bg-[var(--accent-wash)] hover:text-[var(--accent)] transition-colors cursor-pointer"
              >
                {example}
              </button>
            ))}
          </div>

          {(nlParsing || nlParseError || nlPreview || nlConfirmed) && (
            <div className="pt-1">
              <ZoomBookingCard
                parsing={nlParsing}
                parseError={nlParseError}
                preview={nlPreview}
                confirmed={nlConfirmed}
                onConfirmed={(res) => {
                  setNlConfirmed(res);
                  setNlPreview(null);
                  setNlUtterance("");
                  const ev = res.internal_event || res.event;
                  handleEventUpdated(ev);
                  void loadEvents(null);
                }}
                onDismiss={() => {
                  setNlPreview(null);
                  setNlParseError(null);
                }}
              />
            </div>
          )}
        </section>

        {/* External Calendar & Video Connectors Strip */}
        <McpCalendarConnectorsPanel
          onQuickZoomBook={() => {
            nlInputRef.current?.focus();
            if (!nlUtterance.trim()) {
              setNlUtterance(NL_ZOOM_EXAMPLES[0]);
            }
          }}
        />

        {/* Calendar Controls & Chronological Schedule */}
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-card bg-[var(--bg-surface)] px-4 py-3 shadow-[var(--shadow-card)]">
            <div className="flex flex-wrap items-center gap-2.5">
              <div
                role="tablist"
                aria-label="日历视图切换"
                className="inline-flex rounded-full bg-[var(--bg-surface-subtle)] p-0.5"
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
                      "rounded-full px-3.5 py-1 text-[12.5px] font-medium transition-all duration-[140ms] cursor-pointer",
                      viewMode === tab.id
                        ? "bg-[var(--bg-surface)] text-[var(--accent)] shadow-[var(--shadow-subtle)] font-semibold"
                        : "text-[var(--ink-muted)] hover:text-[var(--ink-primary)]",
                    ].join(" ")}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-1">
                <button
                  type="button"
                  aria-label="上一周期"
                  onClick={() =>
                    setAnchorDate((d) => shiftAnchor(d, viewMode, -1))
                  }
                  className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-[var(--bg-surface-subtle)] text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--ink-primary)] transition-colors cursor-pointer"
                >
                  <ChevronLeft className="h-4 w-4" strokeWidth={1.85} />
                </button>
                <Button
                  size="sm"
                  variant="secondary"
                  pill
                  onClick={() => setAnchorDate(startOfLocalDay(new Date()))}
                >
                  今天
                </Button>
                <button
                  type="button"
                  aria-label="下一周期"
                  onClick={() =>
                    setAnchorDate((d) => shiftAnchor(d, viewMode, 1))
                  }
                  className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-[var(--bg-surface-subtle)] text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--ink-primary)] transition-colors cursor-pointer"
                >
                  <ChevronRight className="h-4 w-4" strokeWidth={1.85} />
                </button>
              </div>

              <span
                data-testid="calendar-range-label"
                className="font-mono-code text-[13.5px] font-semibold text-[var(--ink-primary)] tabular-nums ml-1"
              >
                {range.label}
              </span>
            </div>

            <div className="flex items-center gap-2">
              {/* Single crisp .ics export CTA — hidden while confirmation card renders its own .ics button */}
              {!nlConfirmed && (
                <a
                  href={getCalendarIcsUrl()}
                  download
                  data-testid="calendar-ics-download-btn"
                  className="inline-flex h-8 items-center gap-1.5 rounded-full bg-[var(--bg-surface-subtle)] px-3 text-[12px] font-medium text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--ink-primary)] transition-colors"
                >
                  <Download className="h-3.5 w-3.5 text-[var(--accent)]" strokeWidth={1.85} />
                  <span>导出 .ics</span>
                </a>
              )}
              <Button
                size="sm"
                variant="ghost"
                pill
                onClick={() => void loadEvents(null)}
                disabled={loading}
              >
                <RefreshCw
                  className={[
                    "h-3.5 w-3.5",
                    loading ? "animate-spin" : "",
                  ].join(" ")}
                  strokeWidth={1.85}
                />
                <span>刷新日程</span>
              </Button>
            </div>
          </div>

          {error && (
            <AccessNoticeCard
              error={error}
              onRetry={() => void loadEvents(null)}
            />
          )}

          {loading && events.length === 0 ? (
            <div className="rounded-card bg-[var(--bg-surface)] py-16 text-center text-[13px] text-[var(--ink-muted)] shadow-[var(--shadow-card)]">
              正在加载站内日程…
            </div>
          ) : !error && groupedByDay.length === 0 ? (
            <div
              data-testid="calendar-empty-state"
              className="rounded-card bg-[var(--bg-surface)] px-6 py-14 text-center shadow-[var(--shadow-card)]"
            >
              <span className="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-full bg-[var(--bg-surface-subtle)] text-[var(--ink-faint)]">
                <CalendarIcon className="h-5 w-5" strokeWidth={1.7} />
              </span>
              <h3 className="mt-3 text-[15px] font-semibold text-[var(--ink-primary)]">
                当前时间窗口内暂无日程
              </h3>
              <p className="mt-1 text-[13px] text-[var(--ink-muted)]">
                可在上方用自然语言预定 Zoom 会议，或点击“新建日程”创建站内安排。
              </p>
              <Button
                size="sm"
                variant="secondary"
                pill
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
                  className="overflow-hidden rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)]"
                >
                  <header className="flex items-center justify-between bg-[var(--bg-surface-tint)] px-5 py-2.5 border-b border-[var(--hairline-subtle)]">
                    <h3 className="font-mono-code text-[13px] font-semibold text-[var(--ink-primary)] tabular-nums">
                      {group.label}
                    </h3>
                    <span className="rounded-full bg-[var(--bg-surface)] px-2.5 py-0.5 font-mono-code text-[11px] text-[var(--ink-muted)] shadow-[var(--shadow-subtle)] tabular-nums">
                      {group.items.length} 项日程
                    </span>
                  </header>

                  <div className="divide-y divide-[var(--hairline-subtle)]">
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
                            "flex w-full flex-col gap-2 px-5 py-3.5 text-left transition-colors duration-[140ms] cursor-pointer sm:flex-row sm:items-center sm:justify-between",
                            isSelected
                              ? "bg-[var(--accent-wash)]"
                              : "hover:bg-[var(--bg-surface-tint)]",
                          ].join(" ")}
                        >
                          <div className="flex min-w-0 items-start gap-4">
                            <span className="w-[108px] shrink-0 font-mono-code text-[13px] font-semibold text-[var(--accent)] tabular-nums pt-0.5">
                              {formatClockRange(ev.starts_at, ev.ends_at)}
                            </span>
                            <div className="min-w-0">
                              <div
                                className={[
                                  "text-[14px] font-medium text-[var(--ink-primary)] break-words",
                                  ev.cancelled
                                    ? "line-through text-[var(--ink-muted)]"
                                    : "",
                                ].join(" ")}
                              >
                                {ev.title}
                              </div>
                              <div className="mt-0.5 flex flex-wrap items-center gap-2 font-mono-code text-[11.5px] text-[var(--ink-muted)]">
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

                          <div className="flex shrink-0 items-center gap-2 pl-[124px] sm:pl-0">
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
                    pill
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
        </section>
      </div>

      <CreateEventModal
        open={createModalOpen}
        onOpenChange={setCreateModalOpen}
        onCreated={(created) => {
          handleEventUpdated(created);
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
