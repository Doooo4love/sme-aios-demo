"use client";

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Calendar, CheckCircle2, Users } from "lucide-react";
import {
  generateClientId,
  isApiError,
  isStaleAuthError,
  type ApiError,
} from "@/lib/api-client";
import { formatClockRange, formatUnixTime } from "@/lib/format";
import { useSession } from "@/lib/session-context";
import { AccessNoticeCard } from "@/components/ui/AccessNoticeCard";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { SourceTag } from "@/components/ui/SourceTag";
import {
  createCalendarEvent,
  dateTimeLocalToOffsetIso,
  getNextRoundedSlot,
  toDateTimeLocalInputValue,
} from "@/features/calendar/api";
import type { CalendarEvent, Profile } from "@/lib/types";

export interface MeetingDraftModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roomId: string;
  roomTitle: string;
  members: string[];
  memberProfiles: Record<string, Profile>;
}

export function MeetingDraftModal({
  open,
  onOpenChange,
  roomId,
  roomTitle,
  members,
  memberProfiles,
}: MeetingDraftModalProps) {
  const { actor, handleAccessChanged } = useSession();

  const [title, setTitle] = useState("");
  const [startsLocal, setStartsLocal] = useState("");
  const [endsLocal, setEndsLocal] = useState("");
  const [selectedAttendees, setSelectedAttendees] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [apiError, setApiError] = useState<ApiError | null>(null);
  const [createdEvent, setCreatedEvent] = useState<CalendarEvent | null>(null);

  // ONE stable client_id per draft session; synchronous lock prevents rapid double-click duplicates
  const clientIdRef = useRef<string>(generateClientId("mtg"));
  const submittingRef = useRef(false);
  const needsFreshClientIdAfterEditRef = useRef(false);

  // Initialize fresh draft whenever modal opens
  useEffect(() => {
    if (!open) return;
    const { start, end } = getNextRoundedSlot(60);
    clientIdRef.current = generateClientId("mtg");
    submittingRef.current = false;
    needsFreshClientIdAfterEditRef.current = false;
    setTitle(roomTitle ? `${roomTitle} 协作会议` : "协作房间会议");
    setStartsLocal(toDateTimeLocalInputValue(start));
    setEndsLocal(toDateTimeLocalInputValue(end));
    setSelectedAttendees(
      members.length > 0 ? [...members] : actor ? [actor.subject] : [],
    );
    setValidationError(null);
    setApiError(null);
    setCreatedEvent(null);
    setSubmitting(false);
  }, [open, roomId, roomTitle, members, actor]);

  const markDraftEdited = () => {
    setValidationError(null);
    if (needsFreshClientIdAfterEditRef.current) {
      clientIdRef.current = generateClientId("mtg");
      needsFreshClientIdAfterEditRef.current = false;
    }
  };

  const toggleAttendee = (subject: string) => {
    if (actor && subject === actor.subject) return; // organizer always attends
    markDraftEdited();
    setSelectedAttendees((prev) =>
      prev.includes(subject)
        ? prev.filter((s) => s !== subject)
        : [...prev, subject],
    );
  };

  const handleConfirm = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (submittingRef.current || createdEvent) return;

    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setValidationError("请输入会议主题（1–120 字符）。");
      return;
    }
    if (trimmedTitle.length > 120) {
      setValidationError("会议主题不能超过 120 个字符。");
      return;
    }

    const startsIso = dateTimeLocalToOffsetIso(startsLocal);
    const endsIso = dateTimeLocalToOffsetIso(endsLocal);
    if (!startsIso || !endsIso) {
      setValidationError("请选择有效的开始和结束时间。");
      return;
    }

    const startMs = new Date(startsLocal).getTime();
    const endMs = new Date(endsLocal).getTime();
    if (startMs <= Date.now()) {
      setValidationError("会议开始时间必须晚于当前时间。");
      return;
    }
    if (endMs <= startMs) {
      setValidationError("结束时间必须晚于开始时间。");
      return;
    }
    if (endMs - startMs > 86_400_000) {
      setValidationError("单次会议时长不能超过 24 小时。");
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    setValidationError(null);
    setApiError(null);

    try {
      const attendees = Array.from(
        new Set([
          ...selectedAttendees,
          ...(actor ? [actor.subject] : []),
        ]),
      );
      const event = await createCalendarEvent({
        client_id: clientIdRef.current,
        title: trimmedTitle,
        starts_at: startsIso,
        ends_at: endsIso,
        attendees,
        room_id: roomId,
      });
      setCreatedEvent(event);
    } catch (err) {
      if (isStaleAuthError(err)) return;
      if (isApiError(err)) {
        if (err.code === "ACCESS_CHANGED") {
          void handleAccessChanged();
        }
        // On 409 conflict (busy attendee or client_id payload mismatch), allow fresh client_id once user edits time/fields
        if (err.status === 409) {
          needsFreshClientIdAfterEditRef.current = true;
        }
        setApiError(err);
      } else {
        setValidationError("创建会议失败，请保留表单内容后点击重试。");
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!submitting) onOpenChange(next);
      }}
      title={createdEvent ? "房间会议已创建" : "会议草稿预览 · 核对后确认"}
      subtitle={
        createdEvent
          ? "已写入站内日历并向参会同事发送站内通知。"
          : `关联协作房间 ${roomTitle}（仅预览，点击确认后方写入站内日历）`
      }
      size="md"
      footer={
        createdEvent ? (
          <>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              返回房间
            </Button>
            <Link
              href="/calendar"
              data-testid="meeting-view-calendar-link"
              className="inline-flex h-9 items-center gap-1.5 rounded-[4px] bg-[var(--accent)] px-3.5 text-[13.5px] font-medium text-white hover:bg-[var(--accent-hover)]"
            >
              <span>在日历中查看</span>
              <ArrowUpRight className="h-4 w-4" strokeWidth={1.75} />
            </Link>
          </>
        ) : (
          <>
            <Button
              variant="secondary"
              disabled={submitting}
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button
              variant="primary"
              loading={submitting}
              disabled={submitting}
              data-testid="room-meeting-confirm-btn"
              onClick={() => void handleConfirm()}
            >
              {submitting ? "正在创建会议…" : "确认创建日历事件"}
            </Button>
          </>
        )
      }
    >
      {createdEvent ? (
        <div
          data-testid="meeting-created-confirmation"
          className="space-y-3.5"
        >
          <div className="rounded-[6px] border border-[var(--status-emerald-border)] bg-[var(--status-emerald-wash)] p-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 font-semibold text-[var(--status-emerald)]">
                <CheckCircle2 className="h-4 w-4" strokeWidth={1.75} />
                <span>已创建站内日历事件</span>
              </div>
              <SourceTag source={createdEvent.source} />
            </div>
            <h3 className="mt-2 text-[15px] font-semibold text-[var(--ink-primary)]">
              {createdEvent.title}
            </h3>
            <dl className="mt-3 divide-y divide-[var(--hairline-subtle)] rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-sheet)] text-[12px]">
              <div className="flex justify-between px-3 py-2">
                <dt className="text-[var(--ink-muted)]">日期</dt>
                <dd className="font-mono-code font-medium text-[var(--ink-primary)]">
                  {formatUnixTime(createdEvent.starts_at, { dateOnly: true })}
                </dd>
              </div>
              <div className="flex justify-between px-3 py-2">
                <dt className="text-[var(--ink-muted)]">时间段</dt>
                <dd className="font-mono-code font-semibold text-[var(--ink-primary)]">
                  {formatClockRange(createdEvent.starts_at, createdEvent.ends_at)}
                </dd>
              </div>
              <div className="flex justify-between px-3 py-2">
                <dt className="text-[var(--ink-muted)]">组织人</dt>
                <dd className="font-mono-code text-[var(--ink-primary)]">
                  {createdEvent.organizer}
                </dd>
              </div>
              <div className="flex justify-between px-3 py-2">
                <dt className="text-[var(--ink-muted)]">事件编号 / 版本</dt>
                <dd className="font-mono-code text-[var(--ink-muted)]">
                  {createdEvent.id.slice(0, 12)} · r{createdEvent.revision}
                </dd>
              </div>
            </dl>
          </div>
        </div>
      ) : (
        <form
          onSubmit={(e) => void handleConfirm(e)}
          data-testid="room-meeting-draft-form"
          className="space-y-4"
        >
          {/* Room & Idempotency Metadata */}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] px-3 py-2 text-[11.5px]">
            <span className="flex items-center gap-1.5 text-[var(--ink-secondary)]">
              <Calendar className="h-3.5 w-3.5 text-[var(--accent)]" strokeWidth={1.75} />
              <span>绑定房间 ID：</span>
              <span className="font-mono-code text-[var(--ink-primary)]">
                {roomId.slice(0, 14)}…
              </span>
            </span>
            <span className="font-mono-code text-[10.5px] text-[var(--ink-muted)]">
              幂等键: {clientIdRef.current}
            </span>
          </div>

          <div>
            <label
              htmlFor="meeting-draft-title"
              className="block text-[12.5px] font-medium text-[var(--ink-secondary)]"
            >
              会议主题
            </label>
            <input
              id="meeting-draft-title"
              data-testid="room-meeting-title-input"
              type="text"
              maxLength={120}
              required
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                markDraftEdited();
              }}
              placeholder="输入会议主题"
              className="mt-1 h-9 w-full rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-3 text-[13.5px] text-[var(--ink-primary)] focus:border-[var(--accent)] focus:outline-none"
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label
                htmlFor="meeting-draft-start"
                className="block text-[12.5px] font-medium text-[var(--ink-secondary)]"
              >
                开始时间（本地时区）
              </label>
              <input
                id="meeting-draft-start"
                data-testid="room-meeting-start-input"
                type="datetime-local"
                required
                value={startsLocal}
                onChange={(e) => {
                  setStartsLocal(e.target.value);
                  markDraftEdited();
                }}
                className="mt-1 h-9 w-full rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-2.5 font-mono-code text-[12.5px] text-[var(--ink-primary)] focus:border-[var(--accent)] focus:outline-none"
              />
            </div>

            <div>
              <label
                htmlFor="meeting-draft-end"
                className="block text-[12.5px] font-medium text-[var(--ink-secondary)]"
              >
                结束时间（本地时区）
              </label>
              <input
                id="meeting-draft-end"
                data-testid="room-meeting-end-input"
                type="datetime-local"
                required
                value={endsLocal}
                onChange={(e) => {
                  setEndsLocal(e.target.value);
                  markDraftEdited();
                }}
                className="mt-1 h-9 w-full rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-2.5 font-mono-code text-[12.5px] text-[var(--ink-primary)] focus:border-[var(--accent)] focus:outline-none"
              />
            </div>
          </div>

          {/* Room Member Attendees */}
          <div>
            <div className="flex items-center justify-between text-[12.5px] font-medium text-[var(--ink-secondary)]">
              <span className="flex items-center gap-1.5">
                <Users className="h-3.5 w-3.5 text-[var(--ink-muted)]" />
                <span>参会房间成员</span>
              </span>
              <span className="font-mono-code text-[11px] text-[var(--ink-muted)]">
                已选 {selectedAttendees.length} 人
              </span>
            </div>
            <div className="mt-1.5 max-h-[150px] overflow-auto divide-y divide-[var(--hairline-subtle)] rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)]">
              {members.map((subject) => {
                const isSelf = actor?.subject === subject;
                const checked = isSelf || selectedAttendees.includes(subject);
                const prof = memberProfiles[subject];
                return (
                  <label
                    key={subject}
                    className="flex items-center justify-between gap-2 px-3 py-2 text-[12.5px] cursor-pointer hover:bg-[var(--bg-plane)]"
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={isSelf}
                        onChange={() => toggleAttendee(subject)}
                        className="h-3.5 w-3.5 rounded-[2px] accent-[var(--accent)]"
                      />
                      <span className="truncate font-medium text-[var(--ink-primary)]">
                        {prof?.display_name || subject}
                      </span>
                      <span className="font-mono-code text-[11px] text-[var(--ink-muted)]">
                        {subject}
                      </span>
                    </span>
                    {isSelf && (
                      <span className="font-mono-code text-[10.5px] text-[var(--accent)]">
                        组织人
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          </div>

          {validationError && (
            <div
              role="alert"
              className="rounded-[4px] border border-[var(--status-crimson-border)] bg-[var(--status-crimson-wash)] px-3 py-2 text-[12.5px] text-[var(--status-crimson)]"
            >
              {validationError}
            </div>
          )}

          {apiError && <AccessNoticeCard error={apiError} />}
        </form>
      )}
    </Modal>
  );
}
