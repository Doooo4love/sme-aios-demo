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
import { formatClockRange, formatUnixTime } from "@/lib/format";
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
      setFormError("请输入会议主题（1–120 字符）。");
      return;
    }
    const startsIso = dateTimeLocalToOffsetIso(startsLocal);
    const endsIso = dateTimeLocalToOffsetIso(endsLocal);
    if (!startsIso || !endsIso) {
      setFormError("请选择有效的开始和结束时间。");
      return;
    }
    const startMs = new Date(startsLocal).getTime();
    const endMs = new Date(endsLocal).getTime();
    if (startMs <= Date.now()) {
      setFormError("调整后的开始时间必须晚于当前时间。");
      return;
    }
    if (endMs <= startMs || endMs - startMs > 86_400_000) {
      setFormError("结束时间必须晚于开始时间且时长不超过 24 小时。");
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
      setSaveSuccess(`已更新日程（当前版本 r${updated.revision}）。`);
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
        if (
          err.status === 409 &&
          !err.message.includes("冲突") &&
          !err.message.toLowerCase().includes("busy")
        ) {
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
      setSaveSuccess("该会议已取消，并已通知参会同事。");
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
        正在加载日程详情…
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
              <span>{formatUnixTime(detail.starts_at, { dateOnly: true })}</span>
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
            <dt className="text-[var(--ink-muted)]">组织人</dt>
            <dd className="mt-0.5 font-mono-code text-[var(--ink-primary)]">
              {detail.organizer}
            </dd>
          </div>
          <div>
            <dt className="text-[var(--ink-muted)]">乐观锁版本</dt>
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
            <span>导出本日程 .ics</span>
          </a>
        </div>
      </div>

      {/* Attendees List */}
      <div className="rounded-card bg-[var(--bg-surface-tint)] overflow-hidden">
        <div className="flex items-center justify-between border-b border-[var(--hairline-subtle)] px-4 py-2.5 text-[12px] font-medium text-[var(--ink-secondary)]">
          <span className="flex items-center gap-1.5">
            <Users className="h-3.5 w-3.5" strokeWidth={1.85} />
            <span>参会成员</span>
          </span>
          <span className="font-mono-code tabular-nums">
            {detail.attendees.length} 人
          </span>
        </div>
        <ul className="divide-y divide-[var(--hairline-subtle)] text-[12.5px]">
          {detail.attendees.map((subject) => (
            <li
              key={subject}
              className="flex items-center justify-between px-4 py-2 font-mono-code text-[var(--ink-primary)]"
            >
              <span>{subject}</span>
              {subject === detail.organizer && (
                <span className="rounded-full bg-[var(--accent-wash)] px-2 py-0.5 text-[10.5px] font-sans font-medium text-[var(--accent)]">
                  组织人
                </span>
              )}
            </li>
          ))}
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
            <span>日程版本已更新（最新 r{conflictSnapshot.revision}）</span>
          </div>
          <p className="text-[var(--ink-secondary)] leading-relaxed">
            该日程在其他会话中已被修改。请核对服务端最新快照后再决定是否重新提交：
          </p>
          <dl className="divide-y divide-[var(--hairline-subtle)] rounded-sm bg-[var(--bg-surface)] text-[11.5px]">
            <div className="flex justify-between gap-2 px-3 py-2">
              <dt className="text-[var(--ink-muted)]">最新主题</dt>
              <dd className="font-medium text-[var(--ink-primary)] text-right">
                {conflictSnapshot.title}
              </dd>
            </div>
            <div className="flex justify-between gap-2 px-3 py-2">
              <dt className="text-[var(--ink-muted)]">最新时间</dt>
              <dd className="font-mono-code text-[var(--ink-primary)] tabular-nums">
                {formatUnixTime(conflictSnapshot.starts_at)} –{" "}
                {formatUnixTime(conflictSnapshot.ends_at)}
              </dd>
            </div>
            <div className="flex justify-between gap-2 px-3 py-2">
              <dt className="text-[var(--ink-muted)]">最新状态</dt>
              <dd className="font-mono-code text-[var(--ink-primary)]">
                {conflictSnapshot.cancelled ? "已取消" : "有效"}
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
              采用服务端最新内容
            </Button>
            {!conflictSnapshot.cancelled && (
              <Button
                size="sm"
                variant="primary"
                pill
                onClick={() => setConflictSnapshot(null)}
              >
                基于 r{conflictSnapshot.revision} 重试
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
              <span>编辑 / 改期日程</span>
            </span>
            <button
              type="button"
              onClick={() => void loadDetail(false)}
              className="inline-flex items-center gap-1 text-[11.5px] text-[var(--ink-muted)] hover:text-[var(--ink-primary)] cursor-pointer"
            >
              <RefreshCw className="h-3 w-3" />
              <span>刷新快照</span>
            </button>
          </div>

          <div>
            <label
              htmlFor="cal-edit-title"
              className="block text-[11.5px] font-medium text-[var(--ink-secondary)]"
            >
              主题
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
              className="mt-1 h-9 w-full rounded-sm bg-[var(--bg-surface-tint)] px-3 text-[13px] text-[var(--ink-primary)] ring-1 ring-[var(--hairline-strong)] focus:bg-[var(--bg-surface)] focus:ring-[1.5px] focus:ring-[var(--accent)] focus:outline-none"
            />
          </div>

          <div>
            <label
              htmlFor="cal-edit-start"
              className="block text-[11.5px] font-medium text-[var(--ink-secondary)]"
            >
              开始时间
            </label>
            <input
              id="cal-edit-start"
              data-testid="calendar-edit-start-input"
              type="datetime-local"
              required
              value={startsLocal}
              onChange={(e) => {
                setStartsLocal(e.target.value);
                setFormError(null);
              }}
              className="mt-1 h-9 w-full rounded-sm bg-[var(--bg-surface-tint)] px-3 font-mono-code text-[12.5px] text-[var(--ink-primary)] ring-1 ring-[var(--hairline-strong)] focus:bg-[var(--bg-surface)] focus:ring-[1.5px] focus:ring-[var(--accent)] focus:outline-none"
            />
          </div>

          <div>
            <label
              htmlFor="cal-edit-end"
              className="block text-[11.5px] font-medium text-[var(--ink-secondary)]"
            >
              结束时间
            </label>
            <input
              id="cal-edit-end"
              data-testid="calendar-edit-end-input"
              type="datetime-local"
              required
              value={endsLocal}
              onChange={(e) => {
                setEndsLocal(e.target.value);
                setFormError(null);
              }}
              className="mt-1 h-9 w-full rounded-sm bg-[var(--bg-surface-tint)] px-3 font-mono-code text-[12.5px] text-[var(--ink-primary)] ring-1 ring-[var(--hairline-strong)] focus:bg-[var(--bg-surface)] focus:ring-[1.5px] focus:ring-[var(--accent)] focus:outline-none"
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
              <span>取消会议</span>
            </Button>

            <Button
              type="submit"
              size="sm"
              variant="primary"
              pill
              loading={saving}
              data-testid="calendar-save-edit-btn"
            >
              {saving ? "保存中…" : "保存修改"}
            </Button>
          </div>
        </form>
      ) : (
        <div className="rounded-tile bg-[var(--bg-surface-tint)] px-3.5 py-3 text-[12px] text-[var(--ink-muted)]">
          {detail.cancelled
            ? "该会议已取消，不可再编辑。"
            : `仅组织人（${detail.organizer}）可调整或取消此会议。`}
        </div>
      )}

      <ConfirmDialog
        open={cancelDialogOpen}
        onOpenChange={setCancelDialogOpen}
        title="确认取消此站内会议？"
        description="取消后会议状态将标记为已取消，所有参会成员都会收到站内取消通知。"
        scopeSummary={`影响 ${detail.attendees.length} 位参会成员的站内日历`}
        metadata={[
          { label: "会议主题", value: detail.title },
          {
            label: "时间段",
            value: `${formatUnixTime(detail.starts_at, { dateOnly: true })} ${formatClockRange(detail.starts_at, detail.ends_at)}`,
            mono: true,
          },
          { label: "当前版本", value: `r${detail.revision}`, mono: true },
        ]}
        confirmLabel="确认取消会议"
        destructive
        loading={cancelling}
        onConfirm={handleConfirmCancel}
      />
    </div>
  );
}
