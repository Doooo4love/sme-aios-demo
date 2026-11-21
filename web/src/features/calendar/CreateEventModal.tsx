"use client";

import React, { useEffect, useRef, useState } from "react";
import { Users } from "lucide-react";
import {
  generateClientId,
  isApiError,
  isStaleAuthError,
  type ApiError,
} from "@/lib/api-client";
import { useSession } from "@/lib/session-context";
import { AccessNoticeCard } from "@/components/ui/AccessNoticeCard";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import {
  createCalendarEvent,
  dateTimeLocalToOffsetIso,
  getNextRoundedSlot,
  toDateTimeLocalInputValue,
} from "@/features/calendar/api";
import { fetchRoomMembers } from "@/features/chat/api";
import { fetchChatRooms } from "@/features/inbox/api";
import type { CalendarEvent, ChatRoom } from "@/lib/types";

export interface CreateEventModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (event: CalendarEvent) => void;
}

export function CreateEventModal({
  open,
  onOpenChange,
  onCreated,
}: CreateEventModalProps) {
  const { actor, capabilities, handleAccessChanged } = useSession();
  const chatAvailable = Boolean(capabilities?.chat_available);

  const [title, setTitle] = useState("");
  const [startsLocal, setStartsLocal] = useState("");
  const [endsLocal, setEndsLocal] = useState("");
  const [selectedRoomId, setSelectedRoomId] = useState<string>("");
  const [rooms, setRooms] = useState<ChatRoom[]>([]);
  const [roomMembers, setRoomMembers] = useState<string[]>([]);
  const [selectedAttendees, setSelectedAttendees] = useState<string[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [apiError, setApiError] = useState<ApiError | null>(null);

  const clientIdRef = useRef<string>(generateClientId("cal"));
  const submittingRef = useRef(false);
  const needsFreshClientIdRef = useRef(false);

  // Reset form & fetch rooms when modal opens
  useEffect(() => {
    if (!open) return;
    const { start, end } = getNextRoundedSlot(60);
    clientIdRef.current = generateClientId("cal");
    submittingRef.current = false;
    needsFreshClientIdRef.current = false;
    setTitle("");
    setStartsLocal(toDateTimeLocalInputValue(start));
    setEndsLocal(toDateTimeLocalInputValue(end));
    setSelectedRoomId("");
    setRoomMembers([]);
    setSelectedAttendees([]);
    setValidationError(null);
    setApiError(null);
    setSubmitting(false);

    if (chatAvailable) {
      fetchChatRooms({ limit: 50 })
        .then((res) => setRooms(res.items))
        .catch(() => setRooms([]));
    } else {
      setRooms([]);
    }
  }, [open, chatAvailable]);

  // Load room members when a common room is picked
  useEffect(() => {
    if (!open || !selectedRoomId) {
      setRoomMembers([]);
      setSelectedAttendees([]);
      return;
    }
    let cancelled = false;
    setLoadingMembers(true);
    fetchRoomMembers(selectedRoomId, { limit: 50 })
      .then((res) => {
        if (cancelled) return;
        setRoomMembers(res.items);
        setSelectedAttendees(res.items);
      })
      .catch(() => {
        if (!cancelled) {
          setRoomMembers([]);
          setSelectedAttendees([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingMembers(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, selectedRoomId]);

  const markEdited = () => {
    setValidationError(null);
    if (needsFreshClientIdRef.current) {
      clientIdRef.current = generateClientId("cal");
      needsFreshClientIdRef.current = false;
    }
  };

  const toggleAttendee = (subject: string) => {
    if (actor && subject === actor.subject) return;
    markEdited();
    setSelectedAttendees((prev) =>
      prev.includes(subject)
        ? prev.filter((s) => s !== subject)
        : [...prev, subject],
    );
  };

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (submittingRef.current) return;

    const trimmed = title.trim();
    if (!trimmed) {
      setValidationError("请输入日程主题（1–120 字符）。");
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
      setValidationError("开始时间必须晚于当前时间。");
      return;
    }
    if (endMs <= startMs || endMs - startMs > 86_400_000) {
      setValidationError("结束时间必须晚于开始时间且时长不超过 24 小时。");
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    setValidationError(null);
    setApiError(null);

    try {
      const attendees = selectedRoomId
        ? Array.from(
            new Set([
              ...selectedAttendees,
              ...(actor ? [actor.subject] : []),
            ]),
          )
        : [];
      const created = await createCalendarEvent({
        client_id: clientIdRef.current,
        title: trimmed,
        starts_at: startsIso,
        ends_at: endsIso,
        room_id: selectedRoomId || null,
        attendees,
      });
      onCreated(created);
      onOpenChange(false);
    } catch (err) {
      if (isStaleAuthError(err)) return;
      if (isApiError(err)) {
        if (err.code === "ACCESS_CHANGED") {
          void handleAccessChanged();
        }
        if (err.status === 409) {
          needsFreshClientIdRef.current = true;
        }
        setApiError(err);
      } else {
        setValidationError("创建日程失败，请稍后重试。");
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
      title="新建站内日程"
      subtitle="创建个人日程，或关联共同协作房间邀请房间内同事参会。"
      size="md"
      footer={
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
            data-testid="calendar-create-submit"
            onClick={() => void handleSubmit()}
          >
            {submitting ? "创建中…" : "确认创建"}
          </Button>
        </>
      }
    >
      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
        <div>
          <label
            htmlFor="cal-new-title"
            className="block text-[12.5px] font-medium text-[var(--ink-secondary)]"
          >
            日程主题
          </label>
          <input
            id="cal-new-title"
            data-testid="calendar-create-title-input"
            type="text"
            maxLength={120}
            required
            autoFocus
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              markEdited();
            }}
            placeholder="例如：HK01 订单排期核对"
            className="mt-1 h-9 w-full rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-3 text-[13.5px] text-[var(--ink-primary)] focus:border-[var(--accent)] focus:outline-none"
          />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label
              htmlFor="cal-new-start"
              className="block text-[12.5px] font-medium text-[var(--ink-secondary)]"
            >
              开始时间
            </label>
            <input
              id="cal-new-start"
              data-testid="calendar-create-start-input"
              type="datetime-local"
              required
              value={startsLocal}
              onChange={(e) => {
                setStartsLocal(e.target.value);
                markEdited();
              }}
              className="mt-1 h-9 w-full rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-2.5 font-mono-code text-[12.5px] text-[var(--ink-primary)] focus:border-[var(--accent)] focus:outline-none"
            />
          </div>

          <div>
            <label
              htmlFor="cal-new-end"
              className="block text-[12.5px] font-medium text-[var(--ink-secondary)]"
            >
              结束时间
            </label>
            <input
              id="cal-new-end"
              data-testid="calendar-create-end-input"
              type="datetime-local"
              required
              value={endsLocal}
              onChange={(e) => {
                setEndsLocal(e.target.value);
                markEdited();
              }}
              className="mt-1 h-9 w-full rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-2.5 font-mono-code text-[12.5px] text-[var(--ink-primary)] focus:border-[var(--accent)] focus:outline-none"
            />
          </div>
        </div>

        {/* Optional Common Room Picker for Multi-Attendee Meetings */}
        {chatAvailable && (
          <div>
            <label
              htmlFor="cal-new-room"
              className="block text-[12.5px] font-medium text-[var(--ink-secondary)]"
            >
              关联协作房间（可选 · 多人会议必选共同房间）
            </label>
            <select
              id="cal-new-room"
              data-testid="calendar-create-room-select"
              value={selectedRoomId}
              onChange={(e) => {
                setSelectedRoomId(e.target.value);
                markEdited();
              }}
              className="mt-1 h-9 w-full rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-2.5 text-[13px] text-[var(--ink-primary)] focus:border-[var(--accent)] focus:outline-none"
            >
              <option value="">仅个人日程（不关联房间）</option>
              {rooms.map((room) => (
                <option key={room.id} value={room.id}>
                  # {room.title}
                </option>
              ))}
            </select>
          </div>
        )}

        {selectedRoomId && (
          <div>
            <div className="flex items-center justify-between text-[12px] text-[var(--ink-secondary)]">
              <span className="flex items-center gap-1.5 font-medium">
                <Users className="h-3.5 w-3.5" />
                <span>选择房间参会人</span>
              </span>
              <span className="font-mono-code text-[11px] text-[var(--ink-muted)]">
                {loadingMembers ? "加载成员…" : `${selectedAttendees.length} 人`}
              </span>
            </div>
            <div className="mt-1.5 max-h-[130px] overflow-auto divide-y divide-[var(--hairline-subtle)] rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)]">
              {roomMembers.map((subject) => {
                const isSelf = actor?.subject === subject;
                return (
                  <label
                    key={subject}
                    className="flex items-center justify-between px-3 py-1.5 text-[12px] cursor-pointer hover:bg-[var(--bg-plane)]"
                  >
                    <span className="flex items-center gap-2 font-mono-code text-[var(--ink-primary)]">
                      <input
                        type="checkbox"
                        checked={isSelf || selectedAttendees.includes(subject)}
                        disabled={isSelf}
                        onChange={() => toggleAttendee(subject)}
                        className="h-3.5 w-3.5 rounded-[2px] accent-[var(--accent)]"
                      />
                      <span>{subject}</span>
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
        )}

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
    </Modal>
  );
}
