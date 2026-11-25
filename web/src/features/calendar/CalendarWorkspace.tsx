"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Calendar as CalendarIcon,
  CalendarPlus,
  ChevronLeft,
  ChevronRight,
  Download,
  Plus,
  RefreshCw,
  Video,
} from "lucide-react";
import {
  getCalendarIcsUrl,
  isApiError,
  isStaleAuthError,
  parseNaturalLanguageZoomBooking,
  type ApiError,
} from "@/lib/api-client";
import { formatClockRange, formatLocalIsoDate } from "@/lib/format";
import { useLocale, type Locale } from "@/lib/i18n";
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

const WEEKDAY_NAMES_BY_LOCALE: Readonly<Record<Locale, readonly string[]>> = {
  "zh-CN": ["周日", "周一", "周二", "周三", "周四", "周五", "周六"],
  "zh-HK": ["週日", "週一", "週二", "週三", "週四", "週五", "週六"],
  en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
};

const NL_ZOOM_EXAMPLES_BY_LOCALE: Readonly<Record<Locale, readonly string[]>> = {
  "zh-CN": [
    "明天下午 3 点和 manager 用 Zoom 开 HK01 订单评审会",
    "后天上午 10 点和 finance 开 INV-100 对账会",
  ],
  "zh-HK": [
    "明天下午 3 點和 manager 用 Zoom 開 HK01 訂單評審會",
    "後天上午 10 點和 finance 開 INV-100 對帳會",
  ],
  en: [
    "Book a Zoom meeting with manager tomorrow at 3pm for HK01 order review",
    "Schedule a Zoom call with finance Friday at 10am for INV-100 review",
  ],
};

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0);
}

function computeWindow(
  anchor: Date,
  mode: CalendarViewMode,
  locale: Locale,
): { start: Date; end: Date; label: string } {
  const dayStart = startOfLocalDay(anchor);
  const weekdays = WEEKDAY_NAMES_BY_LOCALE[locale];

  if (mode === "day") {
    const end = new Date(dayStart.getTime() + 86_400_000);
    return {
      start: dayStart,
      end,
      label: `${formatLocalIsoDate(dayStart)} ${weekdays[dayStart.getDay()]}`,
    };
  }

  if (mode === "week") {
    const end = new Date(dayStart.getTime() + 7 * 86_400_000);
    const lastDay = new Date(end.getTime() - 86_400_000);
    return {
      start: dayStart,
      end,
      label: `${formatLocalIsoDate(dayStart)} – ${formatLocalIsoDate(lastDay)}`,
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
  const monthLabel =
    locale === "en"
      ? new Intl.DateTimeFormat("en-US", {
          month: "short",
          year: "numeric",
        }).format(monthStart)
      : `${monthStart.getFullYear()} 年 ${monthStart.getMonth() + 1} 月`;
  return {
    start: monthStart,
    end: monthEnd,
    label: monthLabel,
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
  const { locale, t, tp, tx, localizePersona, localizeError } = useLocale();

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
    () => computeWindow(anchorDate, viewMode, locale),
    [anchorDate, viewMode, locale],
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
          ? localizeError(err)
          : tx({
              "zh-CN": "未能解析会议内容，请检查时间或同事名称后重试。",
              "zh-HK": "未能解析會議內容，請檢查時間或同事名稱後重試。",
              en: "Could not parse the meeting details. Check time or colleague name and retry.",
            }),
      );
    } finally {
      setNlParsing(false);
    }
  };

  const groupedByDay = useMemo(() => {
    const weekdays = WEEKDAY_NAMES_BY_LOCALE[locale];
    const map = new Map<string, { label: string; items: CalendarEvent[] }>();
    for (const ev of events) {
      const d = new Date(ev.starts_at * 1000);
      const key = formatLocalIsoDate(d);
      const existing = map.get(key);
      if (existing) {
        existing.items.push(ev);
      } else {
        map.set(key, {
          label: `${key} ${weekdays[d.getDay()]}`,
          items: [ev],
        });
      }
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [events, locale]);

  const nlExamples = NL_ZOOM_EXAMPLES_BY_LOCALE[locale];

  return (
    <div
      data-testid="calendar-workspace"
      className="min-h-full bg-[var(--bg-app)] px-4 py-6 sm:px-6 lg:px-8"
    >
      <div className="mx-auto max-w-[1080px] space-y-6">
        {/* Page Header Card & Natural-Language Zoom Meeting Bar */}
        <section className="rounded-card border border-[var(--hairline)] bg-[var(--bg-surface)] p-5 shadow-[var(--shadow-card)] space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="aios-display text-[20px] font-semibold text-[var(--ink-primary)]">
                {tx({
                  "zh-CN": "日历与会议协作中心",
                  "zh-HK": "日曆與會議協作中心",
                  en: "Calendar & Meetings",
                })}
              </h1>
              <p className="mt-1 text-[13px] text-[var(--ink-muted)]">
                {tx({
                  "zh-CN": "用自然语言直接预约同租户 Zoom 会议，并同步 Google 日历、Apple iCloud、Outlook / M365。",
                  "zh-HK": "以自然語言直接預約同租戶 Zoom 會議，並同步 Google 日曆、Apple iCloud、Outlook / M365。",
                  en: "Book tenant Zoom calls in natural language and sync with Google, Apple iCloud, and Outlook / M365.",
                })}
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
              <span>{t("calendar.newEvent")}</span>
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
              placeholder={tx({
                "zh-CN": "输入自然语言预定 Zoom 会议，如：明天下午 3 点和 manager 开 HK01 评审会",
                "zh-HK": "輸入自然語言預訂 Zoom 會議，如：明天下午 3 點和 manager 開 HK01 評審會",
                en: "Book a Zoom meeting in natural language, e.g. Tomorrow 3pm with manager for HK01 review",
              })}
              style={{ outline: "none" }}
              className="min-w-[220px] flex-1 border-0 bg-transparent py-1 text-[13.5px] text-[var(--ink-primary)] placeholder:text-[var(--ink-faint)] focus:outline-none focus:ring-0"
            />
            <Button
              type="submit"
              size="sm"
              variant="primary"
              pill
              loading={nlParsing}
              disabled={!nlUtterance.trim() || nlParsing}
            >
              <CalendarPlus className="h-3.5 w-3.5" strokeWidth={1.9} />
              <span>
                {nlParsing
                  ? tx({
                      "zh-CN": "解析中…",
                      "zh-HK": "解析中…",
                      en: "Parsing…",
                    })
                  : tx({
                      "zh-CN": "解析预约预览",
                      "zh-HK": "解析預約預覽",
                      en: "Parse Draft",
                    })}
              </span>
            </Button>
          </form>

          <div className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
            <span className="text-[var(--ink-muted)]">
              {tx({ "zh-CN": "试试：", "zh-HK": "試試：", en: "Try:" })}
            </span>
            {nlExamples.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => void handleNlZoomParse(example)}
                className="rounded-full bg-[var(--bg-surface-subtle)] px-3 py-1 text-[var(--ink-secondary)] hover:bg-[var(--accent-wash)] hover:text-[var(--accent-ink)] transition-colors cursor-pointer"
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
              setNlUtterance(nlExamples[0]!);
            }
          }}
        />

        {/* Calendar Controls & Chronological Schedule */}
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-[var(--hairline)] bg-[var(--bg-surface)] px-4 py-3 shadow-[var(--shadow-card)]">
            <div className="flex flex-wrap items-center gap-2.5">
              <div
                role="tablist"
                aria-label={tx({
                  "zh-CN": "日历视图切换",
                  "zh-HK": "日曆檢視切換",
                  en: "Calendar view switcher",
                })}
                className="inline-flex rounded-full border border-[var(--hairline)] bg-[var(--bg-inset)] p-0.5"
              >
                {(
                  [
                    {
                      id: "day",
                      label: tx({ "zh-CN": "日", "zh-HK": "日", en: "Day" }),
                    },
                    {
                      id: "week",
                      label: tx({ "zh-CN": "周", "zh-HK": "週", en: "Week" }),
                    },
                    {
                      id: "month",
                      label: tx({
                        "zh-CN": "月",
                        "zh-HK": "月",
                        en: "Month",
                      }),
                    },
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
                        ? "bg-[var(--bg-surface)] text-[var(--accent-ink)] shadow-[var(--shadow-subtle)] font-semibold"
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
                  aria-label={tx({
                    "zh-CN": "上一周期",
                    "zh-HK": "上一週期",
                    en: "Previous period",
                  })}
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
                  {t("calendar.view.today")}
                </Button>
                <button
                  type="button"
                  aria-label={tx({
                    "zh-CN": "下一周期",
                    "zh-HK": "下一週期",
                    en: "Next period",
                  })}
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
                className="font-mono-code text-[13px] font-semibold text-[var(--ink-primary)] tabular-nums ml-1"
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
                  className="inline-flex h-8 items-center gap-1.5 rounded-sm border border-[var(--hairline)] bg-[var(--bg-surface-tint)] px-3 text-[12px] font-medium text-[var(--ink-secondary)] hover:border-[var(--hairline-strong)] hover:bg-[var(--bg-hover)] hover:text-[var(--ink-primary)] transition-colors"
                >
                  <Download
                    className="h-3.5 w-3.5 text-[var(--accent)]"
                    strokeWidth={1.85}
                  />
                  <span>{t("calendar.exportIcs")}</span>
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
                <span>
                  {tx({
                    "zh-CN": "刷新日程",
                    "zh-HK": "重新整理行程",
                    en: "Refresh",
                  })}
                </span>
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
            <div className="rounded-card border border-[var(--hairline)] bg-[var(--bg-surface)] py-16 text-center text-[13px] text-[var(--ink-muted)] shadow-[var(--shadow-card)]">
              {tx({
                "zh-CN": "正在加载站内日程…",
                "zh-HK": "正在載入站內行程…",
                en: "Loading calendar events…",
              })}
            </div>
          ) : !error && groupedByDay.length === 0 ? (
            <div
              data-testid="calendar-empty-state"
              className="rounded-card border border-[var(--hairline)] bg-[var(--bg-surface)] px-6 py-14 text-center shadow-[var(--shadow-card)]"
            >
              <span className="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-full bg-[var(--bg-surface-subtle)] text-[var(--ink-faint)]">
                <CalendarIcon className="h-5 w-5" strokeWidth={1.7} />
              </span>
              <h3 className="mt-3 text-[15px] font-semibold text-[var(--ink-primary)]">
                {tx({
                  "zh-CN": "当前时间窗口内暂无日程",
                  "zh-HK": "目前時間範圍內暫無行程",
                  en: "No events in this time range",
                })}
              </h3>
              <p className="mt-1 text-[13px] text-[var(--ink-muted)]">
                {tx({
                  "zh-CN": "可在上方用自然语言预定 Zoom 会议，或点击“新建日程”创建站内安排。",
                  "zh-HK": "可於上方以自然語言預訂 Zoom 會議，或點擊「新增行程」建立站內安排。",
                  en: "Book a Zoom call above in natural language, or click New Event to create one.",
                })}
              </p>
              <Button
                size="sm"
                variant="secondary"
                pill
                className="mt-4"
                onClick={() => setCreateModalOpen(true)}
              >
                <Plus className="h-3.5 w-3.5" />
                <span>
                  {tx({
                    "zh-CN": "新建站内日程",
                    "zh-HK": "新增站內行程",
                    en: "New Calendar Event",
                  })}
                </span>
              </Button>
            </div>
          ) : (
            <div className="space-y-4" data-testid="calendar-event-list">
              {groupedByDay.map(([dayKey, group]) => (
                <section
                  key={dayKey}
                  className="overflow-hidden rounded-card border border-[var(--hairline)] bg-[var(--bg-surface)] shadow-[var(--shadow-card)]"
                >
                  <header className="flex items-center justify-between bg-[var(--bg-surface-tint)] px-5 py-2.5 border-b border-[var(--hairline)]">
                    <h3 className="font-mono-code text-[13px] font-semibold text-[var(--ink-primary)] tabular-nums">
                      {group.label}
                    </h3>
                    <span className="rounded-xs border border-[var(--hairline)] bg-[var(--bg-surface)] px-2 py-0.5 font-mono-code text-[11px] text-[var(--ink-muted)] tabular-nums">
                      {tp(
                        {
                          "zh-CN": "{count} 项日程",
                          "zh-HK": "{count} 項行程",
                          en: {
                            one: "{count} event",
                            other: "{count} events",
                          },
                        },
                        group.items.length,
                      )}
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
                              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11.5px] text-[var(--ink-muted)]">
                                <span title={ev.organizer}>
                                  {tx(
                                    {
                                      "zh-CN": "组织者：{org}",
                                      "zh-HK": "組織者：{org}",
                                      en: "Organizer: {org}",
                                    },
                                    {
                                      org: localizePersona(ev.organizer)
                                        .displayName,
                                    },
                                  )}
                                </span>
                                {isOrganizer && (
                                  <span className="text-[var(--accent-ink)]">
                                    {tx({
                                      "zh-CN": "· 我发起的",
                                      "zh-HK": "· 我發起的",
                                      en: "· Organized by you",
                                    })}
                                  </span>
                                )}
                                <span className="font-mono-code">
                                  · r{ev.revision}
                                </span>
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
                    {loadingMore
                      ? t("common.loading")
                      : tx({
                          "zh-CN": "加载更多日程",
                          "zh-HK": "載入更多行程",
                          en: "Load More Events",
                        })}
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
