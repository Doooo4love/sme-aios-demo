"use client";

import React, { useEffect, useRef, useState } from "react";
import { ChevronDown, Users } from "lucide-react";
import {
  generateClientId,
  isApiError,
  isStaleAuthError,
  type ApiError,
} from "@/lib/api-client";
import { LOCALE_META, formatChatRoomTitle, useLocale } from "@/lib/i18n";
import { useSession } from "@/lib/session-context";
import { AccessNoticeCard } from "@/components/ui/AccessNoticeCard";
import { Avatar } from "@/components/ui/Avatar";
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
  const { locale, t, tp, tx, localizePersona } = useLocale();
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
      setValidationError(
        tx({
          "zh-CN": "请输入日程主题（1–120 字符）。",
          "zh-HK": "請輸入行程主題（1–120 個字元）。",
          en: "Please enter an event title (1–120 characters).",
        }),
      );
      return;
    }
    const startsIso = dateTimeLocalToOffsetIso(startsLocal);
    const endsIso = dateTimeLocalToOffsetIso(endsLocal);
    if (!startsIso || !endsIso) {
      setValidationError(
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
      setValidationError(
        tx({
          "zh-CN": "开始时间必须晚于当前时间。",
          "zh-HK": "開始時間必須晚於目前時間。",
          en: "Start time must be in the future.",
        }),
      );
      return;
    }
    if (endMs <= startMs || endMs - startMs > 86_400_000) {
      setValidationError(
        tx({
          "zh-CN": "结束时间必须晚于开始时间且时长不超过 24 小时。",
          "zh-HK": "結束時間必須晚於開始時間且時長不超過 24 小時。",
          en: "End time must be after start time and within 24 hours.",
        }),
      );
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
        setValidationError(
          tx({
            "zh-CN": "创建日程失败，请稍后重试。",
            "zh-HK": "建立行程失敗，請稍後重試。",
            en: "Failed to create event. Please try again.",
          }),
        );
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
      title={tx({
        "zh-CN": "新建站内日程",
        "zh-HK": "新增站內行程",
        en: "New Calendar Event",
      })}
      subtitle={tx({
        "zh-CN": "创建个人日程，或关联共同协作房间邀请房间内同事参会。",
        "zh-HK": "建立個人行程，或關聯共同協作對話邀請對話內同事與會。",
        en: "Create a personal event or link a shared room to invite its members.",
      })}
      size="md"
      footer={
        <>
          <Button
            variant="ghost"
            pill
            disabled={submitting}
            onClick={() => onOpenChange(false)}
          >
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            pill
            loading={submitting}
            disabled={submitting}
            data-testid="calendar-create-submit"
            onClick={() => void handleSubmit()}
          >
            {submitting
              ? tx({
                  "zh-CN": "创建中…",
                  "zh-HK": "建立中…",
                  en: "Creating…",
                })
              : tx({
                  "zh-CN": "确认创建",
                  "zh-HK": "確認建立",
                  en: "Create Event",
                })}
          </Button>
        </>
      }
    >
      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
        <div>
          <label
            htmlFor="cal-new-title"
            className="block text-[12px] font-medium text-[var(--ink-secondary)]"
          >
            {tx({
              "zh-CN": "日程主题",
              "zh-HK": "行程主題",
              en: "Event Title",
            })}
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
            placeholder={tx({
              "zh-CN": "例如：HK01 订单排期核对",
              "zh-HK": "例如：HK01 訂單排期核對",
              en: "e.g. HK01 Order Dispatch Review",
            })}
            className="aios-input mt-1.5 h-10 w-full px-3.5 text-[13.5px]"
          />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label
              htmlFor="cal-new-start"
              className="block text-[12px] font-medium text-[var(--ink-secondary)]"
            >
              {tx({
                "zh-CN": "开始时间",
                "zh-HK": "開始時間",
                en: "Start Time",
              })}
            </label>
            <input
              id="cal-new-start"
              data-testid="calendar-create-start-input"
              type="datetime-local"
              lang={LOCALE_META[locale].htmlLang}
              required
              value={startsLocal}
              onChange={(e) => {
                setStartsLocal(e.target.value);
                markEdited();
              }}
              className="aios-input mt-1.5 h-10 w-full font-mono-code text-[12.5px]"
            />
          </div>

          <div>
            <label
              htmlFor="cal-new-end"
              className="block text-[12px] font-medium text-[var(--ink-secondary)]"
            >
              {tx({
                "zh-CN": "结束时间",
                "zh-HK": "結束時間",
                en: "End Time",
              })}
            </label>
            <input
              id="cal-new-end"
              data-testid="calendar-create-end-input"
              type="datetime-local"
              lang={LOCALE_META[locale].htmlLang}
              required
              value={endsLocal}
              onChange={(e) => {
                setEndsLocal(e.target.value);
                markEdited();
              }}
              className="aios-input mt-1.5 h-10 w-full font-mono-code text-[12.5px]"
            />
          </div>
        </div>

        {chatAvailable && (
          <div>
            <label
              htmlFor="cal-new-room"
              className="block text-[12px] font-medium text-[var(--ink-secondary)]"
            >
              {tx({
                "zh-CN": "关联协作会话（可选 · 多人会议需选择共同会话）",
                "zh-HK": "關聯協作對話（可選 · 多人會議須選擇共同對話）",
                en: "Linked Team Room (optional · required to invite colleagues)",
              })}
            </label>
            <div className="relative mt-1.5">
              <select
                id="cal-new-room"
                data-testid="calendar-create-room-select"
                value={selectedRoomId}
                onChange={(e) => {
                  setSelectedRoomId(e.target.value);
                  markEdited();
                }}
                className="aios-select h-10 w-full text-[13px]"
              >
                <option value="">
                  {tx({
                    "zh-CN": "仅个人日程（不关联会话）",
                    "zh-HK": "僅個人行程（不關聯對話）",
                    en: "Personal event only (no room)",
                  })}
                </option>
                {rooms.map((room) => (
                  <option key={room.id} value={room.id}>
                    {formatChatRoomTitle(room.title, locale)}
                  </option>
                ))}
              </select>
              <ChevronDown
                className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--ink-muted)]"
                strokeWidth={1.85}
                aria-hidden="true"
              />
            </div>
          </div>
        )}

        {selectedRoomId && (
          <div>
            <div className="flex items-center justify-between text-[12px] text-[var(--ink-secondary)]">
              <span className="flex items-center gap-1.5 font-medium">
                <Users className="h-3.5 w-3.5" />
                <span>
                  {tx({
                    "zh-CN": "选择会话参会人",
                    "zh-HK": "選擇對話與會者",
                    en: "Select Room Attendees",
                  })}
                </span>
              </span>
              <span className="text-[11px] text-[var(--ink-muted)] tabular-nums">
                {loadingMembers
                  ? tx({
                      "zh-CN": "加载成员…",
                      "zh-HK": "載入成員…",
                      en: "Loading…",
                    })
                  : tp(
                      {
                        "zh-CN": "{count} 人",
                        "zh-HK": "{count} 人",
                        en: {
                          one: "{count} selected",
                          other: "{count} selected",
                        },
                      },
                      selectedAttendees.length,
                    )}
              </span>
            </div>
            <div className="mt-1.5 max-h-[140px] overflow-y-auto divide-y divide-[var(--hairline-subtle)] rounded-tile bg-[var(--bg-surface-tint)]">
              {roomMembers.map((subject) => {
                const isSelf = actor?.subject === subject;
                const displayName = localizePersona(subject).displayName;
                return (
                  <label
                    key={subject}
                    className="flex items-center justify-between gap-2 px-3.5 py-2 text-[12.5px] cursor-pointer hover:bg-[var(--bg-hover)]"
                  >
                    <span className="flex min-w-0 items-center gap-2.5 text-[var(--ink-primary)]">
                      <input
                        type="checkbox"
                        checked={isSelf || selectedAttendees.includes(subject)}
                        disabled={isSelf}
                        onChange={() => toggleAttendee(subject)}
                        className="h-4 w-4 rounded accent-[var(--accent-solid)]"
                      />
                      <Avatar
                        name={displayName}
                        fallbackText={subject}
                        size="xs"
                      />
                      <span className="truncate font-medium">{displayName}</span>
                      {displayName !== subject && (
                        <span className="font-mono-code text-[11px] text-[var(--ink-muted)]">
                          {subject}
                        </span>
                      )}
                    </span>
                    {isSelf && (
                      <span className="shrink-0 rounded-full bg-[var(--accent-wash)] px-2 py-0.5 text-[10.5px] font-medium text-[var(--accent-ink)]">
                        {tx({
                          "zh-CN": "组织者",
                          "zh-HK": "組織者",
                          en: "Organizer",
                        })}
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
            className="rounded-sm bg-[var(--status-crimson-wash)] px-3.5 py-2.5 text-[12.5px] text-[var(--status-crimson)]"
          >
            {validationError}
          </div>
        )}

        {apiError && <AccessNoticeCard error={apiError} />}
      </form>
    </Modal>
  );
}
