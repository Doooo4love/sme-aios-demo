"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Calendar,
  Download,
  RefreshCw,
  Trash2,
  Users,
} from "lucide-react";
import {
  getCalendarIcsUrl,
  isApiError,
  isStaleAuthError,
  type ApiError,
} from "@/lib/api-client";
import { formatClockRange } from "@/lib/format";
import { LOCALE_META, useLocale } from "@/lib/i18n";
import { useSession } from "@/lib/session-context";
import { AccessNoticeCard } from "@/components/ui/AccessNoticeCard";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SourceTag } from "@/components/ui/SourceTag";
import { StatusBadge } from "@/components/ui/StatusBadge";
import {
  cancelCalendarEvent,
  dateTimeLocalToOffsetIso,
  fetchCalendarEventDetail,
  toDateTimeLocalInputValue,
  updateCalendarEvent,
} from "@/features/calendar/api";
import type { CalendarEvent, CalendarEventDetail } from "@/lib/types";

export interface CalendarEventDrawerProps {
  eventId: string;
  onEventUpdated: (updated: CalendarEvent) => void;
}

export function CalendarEventDrawer({
  eventId,
  onEventUpdated,
}: CalendarEventDrawerProps) {
  const { actor, authGeneration, handleAccessChanged } = useSession();
  const { locale, t, tp, tx, formatDateTime, localizePersona } = useLocale();

  const [detail, setDetail] = useState<CalendarEventDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<ApiError | null>(null);

  const [title, setTitle] = useState("");
  const [startsLocal, setStartsLocal] = useState("");
  const [endsLocal, setEndsLocal] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [saveApiError, setSaveApiError] = useState<ApiError | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);

  const [conflictSnapshot, setConflictSnapshot] =
    useState<CalendarEventDetail | null>(null);

  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const syncFormFromDetail = useCallback((ev: CalendarEventDetail) => {
    setTitle(ev.title);
    setStartsLocal(toDateTimeLocalInputValue(new Date(ev.starts_at * 1000)));
    setEndsLocal(toDateTimeLocalInputValue(new Date(ev.ends_at * 1000)));
  }, []);

  const loadDetail = useCallback(
    async (preserveDraft = false) => {
      setLoading(true);
      setLoadError(null);
      try {
        const res = await fetchCalendarEventDetail(eventId);
        setDetail(res);
        if (!preserveDraft) {
          syncFormFromDetail(res);
          setConflictSnapshot(null);
        }
        return res;
      } catch (err) {
        if (isStaleAuthError(err)) return null;
        if (isApiError(err)) {
          if (err.code === "ACCESS_CHANGED" || err.status === 404) {
            setDetail(null);
          }
          if (err.code === "ACCESS_CHANGED") {
            void handleAccessChanged();
          }
          setLoadError(err);
        }
        return null;
      } finally {
        setLoading(false);
      }
    },
    [eventId, syncFormFromDetail, handleAccessChanged],
  );

  useEffect(() => {
    setDetail(null);
    setLoadError(null);
    setFormError(null);
    setSaveApiError(null);
    setSaveSuccess(null);
    setConflictSnapshot(null);
    setCancelDialogOpen(false);
    void loadDetail(false);
  }, [eventId, authGeneration, loadDetail]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!detail || saving || detail.cancelled) return;

    const trimmed = title.trim();
    if (!trimmed) {
      setFormError(
        tx({
          "zh-CN": "请输入会议主题（1–120 字符）。",
          "zh-HK": "請輸入會議主題（1–120 個字元）。",
          en: "Please enter an event title (1–120 characters).",
        }),
      );
      return;
    }
    const startsIso = dateTimeLocalToOffsetIso(startsLocal);
    const endsIso = dateTimeLocalToOffsetIso(endsLocal);
    if (!startsIso || !endsIso) {
      setFormError(
        tx({
          "zh-CN": "请选择有效的开始和结束时间。",
          "zh-HK": "請選擇有效的開始和結束時間。",
          en: "Please select valid start and end times.",
        }),
      );
      return;
    }
    const startMs = new Date(startsLocal).getTime();
    const endMs = new Date(endsLocal).getTime();
    if (startMs <= Date.now()) {
      setFormError(
        tx({
          "zh-CN": "调整后的开始时间必须晚于当前时间。",
          "zh-HK": "調整後的開始時間必須晚於目前時間。",
          en: "Updated start time must be in the future.",
        }),
      );
      return;
    }
    if (endMs <= startMs || endMs - startMs > 86_400_000) {
      setFormError(
        tx({
          "zh-CN": "结束时间必须晚于开始时间且时长不超过 24 小时。",
          "zh-HK": "結束時間必須晚於開始時間且時長不超過 24 小時。",
          en: "End time must be after start time and within 24 hours.",
        }),
      );
      return;
    }

    setSaving(true);
    setFormError(null);
    setSaveApiError(null);
    setSaveSuccess(null);
    setConflictSnapshot(null);

    try {
      const updated = await updateCalendarEvent(detail.id, {
        title: trimmed,
        starts_at: startsIso,
        ends_at: endsIso,
        revision: detail.revision,
      });
      const merged: CalendarEventDetail = {
        ...updated,
        attendees: detail.attendees,
      };
      setDetail(merged);
      syncFormFromDetail(merged);
      setSaveSuccess(
        tx(
          {
            "zh-CN": "已更新日程（当前版本 r{rev}）。",
            "zh-HK": "已更新行程（目前版本 r{rev}）。",
            en: "Event updated (revision r{rev}).",
          },
          { rev: updated.revision },
        ),
      );
      onEventUpdated(updated);
    } catch (err) {
      if (isStaleAuthError(err)) return;
      if (isApiError(err)) {
        if (err.code === "ACCESS_CHANGED") {
          setDetail(null);
          void handleAccessChanged();
          setLoadError(err);
          return;
        }
        const isTimeOrAttendeeConflict =
          err.code === "ATTENDEE_BUSY" ||
          err.code === "TIME_CONFLICT" ||
          err.code === "INVALID_TIME_RANGE" ||
          err.message.includes("冲突") ||
          err.message.includes("衝突") ||
          err.message.toLowerCase().includes("busy");
        if (err.status === 409 && !isTimeOrAttendeeConflict) {
          const latest = await loadDetail(true);
          if (latest) {
            setConflictSnapshot(latest);
            onEventUpdated(latest);
          }
          return;
        }
        setSaveApiError(err);
      }
    } finally {
      setSaving(false);
    }
  };

  const handleConfirmCancel = async () => {
    if (!detail || cancelling) return;
    setCancelling(true);
    setSaveApiError(null);
    try {
      const updated = await cancelCalendarEvent(detail.id, detail.revision);
      const merged: CalendarEventDetail = {
        ...updated,
        attendees: detail.attendees,
      };
      setDetail(merged);
      setCancelDialogOpen(false);
      setSaveSuccess(
        tx({
          "zh-CN": "该会议已取消，并已通知参会同事。",
          "zh-HK": "該會議已取消，並已通知與會同事。",
          en: "Event cancelled and attendees notified.",
        }),
      );
      onEventUpdated(updated);
    } catch (err) {
      if (isStaleAuthError(err)) return;
      if (isApiError(err)) {
        if (err.status === 409) {
          setCancelDialogOpen(false);
          const latest = await loadDetail(false);
          if (latest) {
            setConflictSnapshot(latest);
            onEventUpdated(latest);
          }
          return;
        }
        setSaveApiError(err);
      }
    } finally {
      setCancelling(false);
    }
  };

  if (loading && !detail) {
    return (
      <div className="py-10 text-center text-[12.5px] text-[var(--ink-muted)]">
        {tx({
          "zh-CN": "正在加载日程详情…",
          "zh-HK": "正在載入行程詳情…",
          en: "Loading event details…",
        })}
      </div>
    );
  }

  if (loadError) {
    return (
      <AccessNoticeCard
        error={loadError}
        onRetry={() => void loadDetail(false)}
      />
    );
  }

  if (!detail) return null;

  const isOrganizer = actor?.subject === detail.organizer;

  return (
    <div className="space-y-4" data-testid="calendar-event-drawer">
      {/* Header Summary */}
      <div className="rounded-card bg-[var(--bg-surface-tint)] p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3
              className={[
                "text-[15px] font-semibold text-[var(--ink-primary)] break-words",
                detail.cancelled ? "line-through opacity-70" : "",
              ].join(" ")}
            >
              {detail.title}
            </h3>
            <div className="mt-1 flex flex-wrap items-center gap-2 font-mono-code text-[12px] text-[var(--ink-muted)] tabular-nums">
              <span>{formatDateTime(detail.starts_at, { dateOnly: true })}</span>
              <span>{formatClockRange(detail.starts_at, detail.ends_at)}</span>
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {detail.cancelled && <StatusBadge status="cancelled" compact />}
            <SourceTag source={detail.source} />
          </div>
        </div>

        <dl className="mt-3 grid grid-cols-2 gap-3 border-t border-[var(--hairline-subtle)] pt-3 text-[12px]">
          <div>
            <dt className="text-[var(--ink-muted)]">
              {tx({ "zh-CN": "组织者", "zh-HK": "組織者", en: "Organizer" })}
            </dt>
            <dd
              title={detail.organizer}
              className="mt-0.5 font-medium text-[var(--ink-primary)]"
            >
              {localizePersona(detail.organizer).displayName}
            </dd>
          </div>
          <div>
            <dt className="text-[var(--ink-muted)]">
              {tx({
                "zh-CN": "乐观锁版本",
                "zh-HK": "樂觀鎖版本",
                en: "Revision",
              })}
            </dt>
            <dd className="mt-0.5 font-mono-code text-[var(--ink-primary)]">
              r{detail.revision}
            </dd>
          </div>
        </dl>

        <div className="mt-3 pt-2.5 border-t border-[var(--hairline-subtle)]">
          <a
            href={getCalendarIcsUrl({ eventId: detail.id })}
            download
            className="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-full bg-[var(--bg-surface)] px-3 text-[12px] font-medium text-[var(--ink-primary)] shadow-[var(--shadow-subtle)] hover:shadow-[var(--shadow-card)] hover:text-[var(--accent)] transition-all"
          >
            <Download className="h-3.5 w-3.5 text-[var(--accent)]" />
            <span>
              {tx({
                "zh-CN": "导出本日程 .ics",
                "zh-HK": "匯出此行程 .ics",
                en: "Export Event .ics",
              })}
            </span>
          </a>
        </div>
      </div>

      {/* Attendees List */}
      <div className="rounded-card bg-[var(--bg-surface-tint)] overflow-hidden">
        <div className="flex items-center justify-between border-b border-[var(--hairline-subtle)] px-4 py-2.5 text-[12px] font-medium text-[var(--ink-secondary)]">
          <span className="flex items-center gap-1.5">
            <Users className="h-3.5 w-3.5" strokeWidth={1.85} />
            <span>
              {tx({
                "zh-CN": "参会成员",
                "zh-HK": "與會成員",
                en: "Attendees",
              })}
            </span>
          </span>
          <span className="tabular-nums">
            {tp(
              {
                "zh-CN": "{count} 人",
                "zh-HK": "{count} 人",
                en: {
                  one: "{count} attendee",
                  other: "{count} attendees",
                },
              },
              detail.attendees.length,
            )}
          </span>
        </div>
        <ul className="divide-y divide-[var(--hairline-subtle)] text-[12.5px]">
          {detail.attendees.map((subject) => {
            const displayName = localizePersona(subject).displayName;
            return (
              <li
                key={subject}
                className="flex items-center justify-between gap-2 px-4 py-2 text-[var(--ink-primary)]"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-medium">{displayName}</span>
                  {displayName !== subject && (
                    <span className="font-mono-code text-[11px] text-[var(--ink-muted)]">
                      {subject}
                    </span>
                  )}
                </span>
                {subject === detail.organizer && (
                  <span className="shrink-0 rounded-full bg-[var(--accent-wash)] px-2 py-0.5 text-[10.5px] font-medium text-[var(--accent-ink)]">
                    {tx({
                      "zh-CN": "组织者",
                      "zh-HK": "組織者",
                      en: "Organizer",
                    })}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {/* 409 Optimistic Revision Conflict Diff Banner */}
      {conflictSnapshot && (
        <div
          role="alert"
          data-testid="calendar-conflict-banner"
          className="rounded-card bg-[var(--status-amber-wash)] p-3.5 text-[12px] space-y-2.5"
        >
          <div className="flex items-center gap-1.5 font-semibold text-[var(--status-amber-ink)]">
            <AlertTriangle className="h-4 w-4 shrink-0" strokeWidth={1.85} />
            <span>
              {tx(
                {
                  "zh-CN": "日程版本已更新（最新 r{rev}）",
                  "zh-HK": "行程版本已更新（最新 r{rev}）",
                  en: "Event Updated Elsewhere (Latest r{rev})",
                },
                { rev: conflictSnapshot.revision },
              )}
            </span>
          </div>
          <p className="text-[var(--ink-secondary)] leading-relaxed">
            {tx({
              "zh-CN": "该日程在其他会话中已被修改。请核对服务端最新快照后再决定是否重新提交：",
              "zh-HK": "該行程於其他工作階段已被修改。請核對伺服器最新快照後再決定是否重新提交：",
              en: "This event was modified in another session. Review the latest snapshot before resubmitting:",
            })}
          </p>
          <dl className="divide-y divide-[var(--hairline-subtle)] rounded-sm bg-[var(--bg-surface)] text-[11.5px]">
            <div className="flex justify-between gap-2 px-3 py-2">
              <dt className="text-[var(--ink-muted)]">
                {tx({
                  "zh-CN": "最新主题",
                  "zh-HK": "最新主題",
                  en: "Latest Title",
                })}
              </dt>
              <dd className="font-medium text-[var(--ink-primary)] text-right">
                {conflictSnapshot.title}
              </dd>
            </div>
            <div className="flex justify-between gap-2 px-3 py-2">
              <dt className="text-[var(--ink-muted)]">
                {tx({
                  "zh-CN": "最新时间",
                  "zh-HK": "最新時間",
                  en: "Latest Time",
                })}
              </dt>
              <dd className="font-mono-code text-[var(--ink-primary)] tabular-nums">
                {formatDateTime(conflictSnapshot.starts_at)} –{" "}
                {formatDateTime(conflictSnapshot.ends_at)}
              </dd>
            </div>
            <div className="flex justify-between gap-2 px-3 py-2">
              <dt className="text-[var(--ink-muted)]">
                {tx({
                  "zh-CN": "最新状态",
                  "zh-HK": "最新狀態",
                  en: "Latest Status",
                })}
              </dt>
              <dd className="font-medium text-[var(--ink-primary)]">
                {conflictSnapshot.cancelled
                  ? tx({
                      "zh-CN": "已取消",
                      "zh-HK": "已取消",
                      en: "Cancelled",
                    })
                  : tx({ "zh-CN": "有效", "zh-HK": "有效", en: "Active" })}
              </dd>
            </div>
          </dl>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              size="sm"
              variant="secondary"
              pill
              onClick={() => {
                syncFormFromDetail(conflictSnapshot);
                setConflictSnapshot(null);
              }}
            >
              {tx({
                "zh-CN": "采用服务端最新内容",
                "zh-HK": "採用伺服器最新內容",
                en: "Use Server Version",
              })}
            </Button>
            {!conflictSnapshot.cancelled && (
              <Button
                size="sm"
                variant="primary"
                pill
                onClick={() => setConflictSnapshot(null)}
              >
                {tx(
                  {
                    "zh-CN": "基于 r{rev} 重试",
                    "zh-HK": "基於 r{rev} 重試",
                    en: "Retry on r{rev}",
                  },
                  { rev: conflictSnapshot.revision },
                )}
              </Button>
            )}
          </div>
        </div>
      )}

      {saveSuccess && (
        <div
          role="status"
          className="rounded-sm bg-[var(--status-emerald-wash)] px-3.5 py-2.5 text-[12.5px] text-[var(--status-emerald)]"
        >
          {saveSuccess}
        </div>
      )}

      {saveApiError && <AccessNoticeCard error={saveApiError} />}

      {/* Organizer Edit & Cancel Controls */}
      {isOrganizer && !detail.cancelled ? (
        <form
          onSubmit={(e) => void handleSave(e)}
          data-testid="calendar-edit-form"
          className="rounded-card bg-[var(--bg-surface)] p-4 shadow-[var(--shadow-card)] space-y-3"
        >
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-[13px] font-semibold text-[var(--ink-primary)]">
              <Calendar className="h-3.5 w-3.5 text-[var(--accent)]" />
              <span>
                {tx({
                  "zh-CN": "编辑 / 改期日程",
                  "zh-HK": "編輯 / 改期行程",
                  en: "Edit / Reschedule Event",
                })}
              </span>
            </span>
            <button
              type="button"
              onClick={() => void loadDetail(false)}
              className="inline-flex items-center gap-1 text-[11.5px] text-[var(--ink-muted)] hover:text-[var(--ink-primary)] cursor-pointer"
            >
              <RefreshCw className="h-3 w-3" />
              <span>
                {tx({
                  "zh-CN": "刷新快照",
                  "zh-HK": "重新整理快照",
                  en: "Reload",
                })}
              </span>
            </button>
          </div>

          <div>
            <label
              htmlFor="cal-edit-title"
              className="block text-[11.5px] font-medium text-[var(--ink-secondary)]"
            >
              {tx({ "zh-CN": "主题", "zh-HK": "主題", en: "Title" })}
            </label>
            <input
              id="cal-edit-title"
              data-testid="calendar-edit-title-input"
              type="text"
              maxLength={120}
              required
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                setFormError(null);
              }}
              className="aios-input mt-1 w-full"
            />
          </div>

          <div>
            <label
              htmlFor="cal-edit-start"
              className="block text-[11.5px] font-medium text-[var(--ink-secondary)]"
            >
              {tx({
                "zh-CN": "开始时间",
                "zh-HK": "開始時間",
                en: "Start Time",
              })}
            </label>
            <input
              id="cal-edit-start"
              data-testid="calendar-edit-start-input"
              type="datetime-local"
              lang={LOCALE_META[locale].htmlLang}
              required
              value={startsLocal}
              onChange={(e) => {
                setStartsLocal(e.target.value);
                setFormError(null);
              }}
              className="aios-input mt-1 w-full font-mono-code text-[12.5px]"
            />
          </div>

          <div>
            <label
              htmlFor="cal-edit-end"
              className="block text-[11.5px] font-medium text-[var(--ink-secondary)]"
            >
              {tx({
                "zh-CN": "结束时间",
                "zh-HK": "結束時間",
                en: "End Time",
              })}
            </label>
            <input
              id="cal-edit-end"
              data-testid="calendar-edit-end-input"
              type="datetime-local"
              lang={LOCALE_META[locale].htmlLang}
              required
              value={endsLocal}
              onChange={(e) => {
                setEndsLocal(e.target.value);
                setFormError(null);
              }}
              className="aios-input mt-1 w-full font-mono-code text-[12.5px]"
            />
          </div>

          {formError && (
            <div
              role="alert"
              className="rounded-sm bg-[var(--status-crimson-wash)] px-3 py-2 text-[12px] text-[var(--status-crimson)]"
            >
              {formError}
            </div>
          )}

          <div className="flex items-center justify-between gap-2 border-t border-[var(--hairline-subtle)] pt-3">
            <Button
              type="button"
              size="sm"
              variant="danger"
              pill
              data-testid="calendar-cancel-event-btn"
              onClick={() => setCancelDialogOpen(true)}
            >
              <Trash2 className="h-3.5 w-3.5" strokeWidth={1.85} />
              <span>{t("calendar.event.cancel")}</span>
            </Button>

            <Button
              type="submit"
              size="sm"
              variant="primary"
              pill
              loading={saving}
              data-testid="calendar-save-edit-btn"
            >
              {saving
                ? tx({
                    "zh-CN": "保存中…",
                    "zh-HK": "儲存中…",
                    en: "Saving…",
                  })
                : t("settings.saveChanges")}
            </Button>
          </div>
        </form>
      ) : (
        <div className="rounded-tile bg-[var(--bg-surface-tint)] px-3.5 py-3 text-[12px] text-[var(--ink-muted)]">
          {detail.cancelled
            ? tx({
                "zh-CN": "该会议已取消，不可再编辑。",
                "zh-HK": "該會議已取消，不可再編輯。",
                en: "This event has been cancelled and can no longer be edited.",
              })
            : tx(
                {
                  "zh-CN": "仅组织者（{org}）可调整或取消此会议。",
                  "zh-HK": "僅組織者（{org}）可調整或取消此會議。",
                  en: "Only the organizer ({org}) can edit or cancel this event.",
                },
                { org: localizePersona(detail.organizer).displayName },
              )}
        </div>
      )}

      <ConfirmDialog
        open={cancelDialogOpen}
        onOpenChange={setCancelDialogOpen}
        title={tx({
          "zh-CN": "确认取消此站内会议？",
          "zh-HK": "確認取消此站內會議？",
          en: "Cancel this calendar event?",
        })}
        description={tx({
          "zh-CN": "取消后会议状态将标记为已取消，所有参会成员都会收到站内取消通知。",
          "zh-HK": "取消後會議狀態將標記為已取消，所有與會成員均會收到站內取消通知。",
          en: "The event will be marked cancelled and all attendees will receive an in-app cancellation notice.",
        })}
        scopeSummary={tp(
          {
            "zh-CN": "影响 {count} 位参会成员的站内日历",
            "zh-HK": "影響 {count} 位與會成員的站內日曆",
            en: {
              one: "Affects {count} attendee's calendar",
              other: "Affects {count} attendees' calendars",
            },
          },
          detail.attendees.length,
        )}
        metadata={[
          { label: t("zoom.meetingTitleLabel"), value: detail.title },
          {
            label: tx({ "zh-CN": "时间段", "zh-HK": "時段", en: "Time" }),
            value: `${formatDateTime(detail.starts_at, { dateOnly: true })} ${formatClockRange(detail.starts_at, detail.ends_at)}`,
            mono: true,
          },
          {
            label: tx({
              "zh-CN": "当前版本",
              "zh-HK": "目前版本",
              en: "Current Revision",
            }),
            value: `r${detail.revision}`,
            mono: true,
          },
        ]}
        confirmLabel={tx({
          "zh-CN": "确认取消会议",
          "zh-HK": "確認取消會議",
          en: "Confirm Cancellation",
        })}
        destructive
        loading={cancelling}
        onConfirm={handleConfirmCancel}
      />
    </div>
  );
}
