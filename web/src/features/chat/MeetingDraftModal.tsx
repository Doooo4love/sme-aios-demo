"use client";

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  Calendar,
  Check,
  CheckCircle2,
  Download,
  ExternalLink,
  Users,
  Video,
} from "lucide-react";
import {
  confirmZoomBooking,
  fetchMcpStatus,
  generateClientId,
  getCalendarIcsUrl,
  isApiError,
  isStaleAuthError,
  type ApiError,
} from "@/lib/api-client";
import { formatClockRange } from "@/lib/format";
import {
  CALENDAR_CONNECTOR_LABELS_I18N,
  LOCALE_META,
  PERSONA_LOCALIZATIONS,
  localizeMcpSyncMessage,
  localizeZoomStatusLabel,
  useLocale,
} from "@/lib/i18n";
import { useSession } from "@/lib/session-context";
import { AccessNoticeCard } from "@/components/ui/AccessNoticeCard";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { SourceTag } from "@/components/ui/SourceTag";
import { StatusBadge } from "@/components/ui/StatusBadge";
import {
  createCalendarEvent,
  dateTimeLocalToOffsetIso,
  getNextRoundedSlot,
  toDateTimeLocalInputValue,
} from "@/features/calendar/api";
import type {
  CalendarEvent,
  ExternalCalendarSyncResult,
  ExternalCalendarTarget,
  McpConnectorStatusItem,
  Profile,
  ZoomMeetingResult,
} from "@/lib/types";

const CALENDAR_TARGET_IDS: readonly ExternalCalendarTarget[] = [
  "google",
  "icloud",
  "outlook",
];

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
  const { locale, t, tp, tx, formatDateTime, localizePersona } = useLocale();

  const [title, setTitle] = useState("");
  const [startsLocal, setStartsLocal] = useState("");
  const [endsLocal, setEndsLocal] = useState("");
  const [selectedAttendees, setSelectedAttendees] = useState<string[]>([]);
  const [enableZoom, setEnableZoom] = useState(false);
  const [selectedTargets, setSelectedTargets] = useState<
    ExternalCalendarTarget[]
  >([]);
  const [mcpConnectors, setMcpConnectors] = useState<McpConnectorStatusItem[]>(
    [],
  );

  const [submitting, setSubmitting] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [apiError, setApiError] = useState<ApiError | null>(null);
  const [createdEvent, setCreatedEvent] = useState<CalendarEvent | null>(null);
  const [zoomResult, setZoomResult] = useState<ZoomMeetingResult | null>(null);
  const [externalSyncResults, setExternalSyncResults] = useState<
    ExternalCalendarSyncResult[]
  >([]);
  const [icsUrl, setIcsUrl] = useState<string | null>(null);

  // ONE stable client_id per draft session; synchronous lock prevents rapid double-click duplicates
  const clientIdRef = useRef<string>(generateClientId("mtg"));
  const submittingRef = useRef(false);
  const needsFreshClientIdAfterEditRef = useRef(false);

  const targetLabel = (id: ExternalCalendarTarget | string) => {
    if (id === "google" || id === "icloud" || id === "outlook") {
      return CALENDAR_CONNECTOR_LABELS_I18N[id][locale];
    }
    return id;
  };

  const resolveMemberName = (subject: string, prof?: Profile) => {
    const raw = prof?.display_name?.trim();
    const known =
      PERSONA_LOCALIZATIONS[subject as keyof typeof PERSONA_LOCALIZATIONS];
    if (
      raw &&
      (!known ||
        (raw !== known["zh-CN"].displayName &&
          raw !== known["zh-HK"].displayName &&
          raw !== known.en.displayName))
    ) {
      return raw;
    }
    if (known) {
      return localizePersona(subject).displayName;
    }
    return raw || subject;
  };

  useEffect(() => {
    if (!open) return;
    const { start, end } = getNextRoundedSlot(60);
    clientIdRef.current = generateClientId("mtg");
    submittingRef.current = false;
    needsFreshClientIdAfterEditRef.current = false;
    setTitle(
      roomTitle
        ? tx(
            {
              "zh-CN": "{room} 协作会议",
              "zh-HK": "{room} 協作會議",
              en: "{room} Sync",
            },
            { room: roomTitle },
          )
        : tx({
            "zh-CN": "协作房间会议",
            "zh-HK": "協作對話會議",
            en: "Team Room Meeting",
          }),
    );
    setStartsLocal(toDateTimeLocalInputValue(start));
    setEndsLocal(toDateTimeLocalInputValue(end));
    setSelectedAttendees(
      members.length > 0 ? [...members] : actor ? [actor.subject] : [],
    );
    setEnableZoom(false);
    setSelectedTargets([]);
    setValidationError(null);
    setApiError(null);
    setCreatedEvent(null);
    setZoomResult(null);
    setExternalSyncResults([]);
    setIcsUrl(null);
    setSubmitting(false);

    fetchMcpStatus()
      .then((res) => setMcpConnectors(res.connectors))
      .catch(() => setMcpConnectors([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, roomId, roomTitle, members, actor]);

  const markDraftEdited = () => {
    setValidationError(null);
    if (needsFreshClientIdAfterEditRef.current) {
      clientIdRef.current = generateClientId("mtg");
      needsFreshClientIdAfterEditRef.current = false;
    }
  };

  const toggleAttendee = (subject: string) => {
    if (actor && subject === actor.subject) return;
    markDraftEdited();
    setSelectedAttendees((prev) =>
      prev.includes(subject)
        ? prev.filter((s) => s !== subject)
        : [...prev, subject],
    );
  };

  const toggleExternalTarget = (target: ExternalCalendarTarget) => {
    markDraftEdited();
    setSelectedTargets((prev) =>
      prev.includes(target)
        ? prev.filter((item) => item !== target)
        : [...prev, target],
    );
  };

  const handleConfirm = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (submittingRef.current || createdEvent) return;

    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setValidationError(
        tx({
          "zh-CN": "请输入会议主题（1–120 字符）。",
          "zh-HK": "請輸入會議主題（1–120 個字元）。",
          en: "Please enter a meeting title (1–120 characters).",
        }),
      );
      return;
    }
    if (trimmedTitle.length > 120) {
      setValidationError(
        tx({
          "zh-CN": "会议主题不能超过 120 个字符。",
          "zh-HK": "會議主題不能超過 120 個字元。",
          en: "Meeting title cannot exceed 120 characters.",
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
          en: "Please choose valid start and end times.",
        }),
      );
      return;
    }

    const startMs = new Date(startsLocal).getTime();
    const endMs = new Date(endsLocal).getTime();
    if (startMs <= Date.now()) {
      setValidationError(
        tx({
          "zh-CN": "会议开始时间必须晚于当前时间。",
          "zh-HK": "會議開始時間必須晚於目前時間。",
          en: "Start time must be in the future.",
        }),
      );
      return;
    }
    if (endMs <= startMs) {
      setValidationError(
        tx({
          "zh-CN": "结束时间必须晚于开始时间。",
          "zh-HK": "結束時間必須晚於開始時間。",
          en: "End time must be after start time.",
        }),
      );
      return;
    }
    if (endMs - startMs > 86_400_000) {
      setValidationError(
        tx({
          "zh-CN": "单次会议时长不能超过 24 小时。",
          "zh-HK": "單次會議時長不能超過 24 小時。",
          en: "Meeting duration cannot exceed 24 hours.",
        }),
      );
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

      // When Zoom or external calendar MCP sync is explicitly enabled, orchestrate via confirmZoomBooking
      // Otherwise call POST /v1/calendar/events directly (preserving strict double-click idempotency & E2E parity)
      if (enableZoom || selectedTargets.length > 0) {
        const tz =
          Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
        const res = await confirmZoomBooking({
          client_id: clientIdRef.current,
          title: trimmedTitle,
          starts_at: startsIso,
          ends_at: endsIso,
          timezone: tz,
          attendees,
          room_id: roomId,
          create_zoom: enableZoom,
          notify_room: true,
          calendar_targets: selectedTargets,
        });
        setCreatedEvent(res.internal_event || res.event);
        setZoomResult(res.zoom || res.zoom_meeting);
        setExternalSyncResults(
          res.external_sync || res.calendar_sync_results || [],
        );
        setIcsUrl(res.ics_download_url);
      } else {
        const event = await createCalendarEvent({
          client_id: clientIdRef.current,
          title: trimmedTitle,
          starts_at: startsIso,
          ends_at: endsIso,
          attendees,
          room_id: roomId,
        });
        setCreatedEvent(event);
        setIcsUrl(getCalendarIcsUrl({ eventId: event.id }));
      }
    } catch (err) {
      if (isStaleAuthError(err)) return;
      if (isApiError(err)) {
        if (err.code === "ACCESS_CHANGED") {
          void handleAccessChanged();
        }
        if (err.status === 409) {
          needsFreshClientIdAfterEditRef.current = true;
        }
        setApiError(err);
      } else {
        setValidationError(
          tx({
            "zh-CN": "创建会议失败，请保留表单内容后点击重试。",
            "zh-HK": "建立會議失敗，請保留表單內容後點擊重試。",
            en: "Failed to create meeting. Keep your details and retry.",
          }),
        );
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const connectorById = new Map(mcpConnectors.map((c) => [c.connector, c]));
  const zoomConnector = connectorById.get("zoom");
  const isZoomLive =
    zoomResult?.mode === "live_mcp" || zoomResult?.mode === "live_api";

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!submitting) onOpenChange(next);
      }}
      title={
        createdEvent
          ? tx({
              "zh-CN": "会议已写入站内日历",
              "zh-HK": "會議已寫入站內日曆",
              en: "Meeting Saved to Calendar",
            })
          : tx({
              "zh-CN": "预约房间会议 · 核对后确认",
              "zh-HK": "預約對話會議 · 核對後確認",
              en: "Schedule Room Meeting · Review & Confirm",
            })
      }
      subtitle={
        createdEvent
          ? tx({
              "zh-CN": "已写入 AIOS 站内日历并向参会同事发送站内通知。",
              "zh-HK": "已寫入 AIOS 站內日曆並向與會同事傳送站內通知。",
              en: "Saved to the AIOS calendar and notified invited colleagues.",
            })
          : tx(
              {
                "zh-CN": "关联会话「{room}」（仅预览草稿，点击确认后方正式写入）",
                "zh-HK": "關聯對話「{room}」（僅預覽草稿，點擊確認後方正式寫入）",
                en: "Linked to “{room}” (preview draft — nothing is written until confirmed)",
              },
              { room: roomTitle },
            )
      }
      size="md"
      footer={
        createdEvent ? (
          <>
            <Button
              variant="ghost"
              pill
              onClick={() => onOpenChange(false)}
            >
              {tx({
                "zh-CN": "返回会话",
                "zh-HK": "返回對話",
                en: "Back to Chat",
              })}
            </Button>
            {icsUrl && (
              <a
                href={icsUrl}
                download
                className="inline-flex h-9 items-center gap-1.5 rounded-full bg-[var(--bg-surface)] px-3.5 text-[12.5px] font-medium text-[var(--ink-primary)] shadow-[var(--shadow-subtle)] hover:shadow-[var(--shadow-card)] transition-all"
              >
                <Download className="h-3.5 w-3.5 text-[var(--accent)]" />
                <span>
                  {tx({
                    "zh-CN": "下载 .ics",
                    "zh-HK": "下載 .ics",
                    en: "Download .ics",
                  })}
                </span>
              </a>
            )}
            <Link
              href="/calendar"
              data-testid="meeting-view-calendar-link"
              className="inline-flex h-9 items-center gap-1.5 rounded-full bg-[var(--accent-solid)] px-4 text-[13px] font-medium text-[var(--accent-fg)] shadow-[var(--shadow-subtle)] hover:bg-[var(--accent-solid-hover)] transition-colors"
            >
              <span>
                {tx({
                  "zh-CN": "在日历中查看",
                  "zh-HK": "於日曆中檢視",
                  en: "View in Calendar",
                })}
              </span>
              <ArrowUpRight className="h-4 w-4" strokeWidth={1.85} />
            </Link>
          </>
        ) : (
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
              data-testid="room-meeting-confirm-btn"
              title={clientIdRef.current}
              onClick={() => void handleConfirm()}
            >
              {submitting
                ? tx({
                    "zh-CN": "正在创建会议…",
                    "zh-HK": "正在建立會議…",
                    en: "Creating meeting…",
                  })
                : tx({
                    "zh-CN": "确认创建日历事件",
                    "zh-HK": "確認建立日曆事件",
                    en: "Confirm & Create Event",
                  })}
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
          <div className="rounded-card bg-[var(--status-emerald-wash)] p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 font-semibold text-[var(--status-emerald)]">
                <CheckCircle2 className="h-4 w-4" strokeWidth={2} />
                <span>
                  {tx({
                    "zh-CN": "已创建站内日历事件",
                    "zh-HK": "已建立站內日曆事件",
                    en: "Calendar Event Created",
                  })}
                </span>
              </div>
              <SourceTag source={createdEvent.source} />
            </div>
            <h3 className="text-[15.5px] font-semibold text-[var(--ink-primary)]">
              {createdEvent.title}
            </h3>
            <dl className="divide-y divide-[var(--hairline-subtle)] rounded-sm bg-[var(--bg-surface)] text-[12px]">
              <div className="flex justify-between px-3.5 py-2.5">
                <dt className="text-[var(--ink-muted)]">
                  {tx({ "zh-CN": "日期", "zh-HK": "日期", en: "Date" })}
                </dt>
                <dd className="font-mono-code font-medium text-[var(--ink-primary)] tabular-nums">
                  {formatDateTime(createdEvent.starts_at, { dateOnly: true })}
                </dd>
              </div>
              <div className="flex justify-between px-3.5 py-2.5">
                <dt className="text-[var(--ink-muted)]">
                  {tx({ "zh-CN": "时间段", "zh-HK": "時段", en: "Time" })}
                </dt>
                <dd className="font-mono-code font-semibold text-[var(--ink-primary)] tabular-nums">
                  {formatClockRange(
                    createdEvent.starts_at,
                    createdEvent.ends_at,
                  )}
                </dd>
              </div>
              <div className="flex justify-between px-3.5 py-2.5">
                <dt className="text-[var(--ink-muted)]">
                  {tx({
                    "zh-CN": "组织者",
                    "zh-HK": "組織者",
                    en: "Organizer",
                  })}
                </dt>
                <dd
                  title={createdEvent.organizer}
                  className="font-medium text-[var(--ink-primary)]"
                >
                  {resolveMemberName(
                    createdEvent.organizer,
                    memberProfiles[createdEvent.organizer],
                  )}
                </dd>
              </div>
              <div className="flex justify-between px-3.5 py-2.5">
                <dt className="text-[var(--ink-muted)]">
                  {tx({
                    "zh-CN": "事件编号 / 版本",
                    "zh-HK": "事件編號 / 版本",
                    en: "Event ID / Rev",
                  })}
                </dt>
                <dd className="font-mono-code text-[var(--ink-muted)]">
                  {createdEvent.id.slice(0, 12)} · r{createdEvent.revision}
                </dd>
              </div>
            </dl>
          </div>

          {zoomResult && zoomResult.requested && (
            <div className="rounded-tile bg-[var(--bg-surface-tint)] p-3.5 text-[12.5px] space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 font-semibold text-[var(--ink-primary)]">
                  <Video className="h-3.5 w-3.5 text-[var(--accent)]" />
                  <span>{CALENDAR_CONNECTOR_LABELS_I18N.zoom[locale]}</span>
                </span>
                <StatusBadge
                  status={isZoomLive ? "connected" : "sandbox_ready"}
                  label={
                    isZoomLive
                      ? tx({
                          "zh-CN": "Zoom 已连接",
                          "zh-HK": "Zoom 已連線",
                          en: "Zoom Connected",
                        })
                      : tx({
                          "zh-CN": "Zoom 未连接",
                          "zh-HK": "Zoom 未連線",
                          en: "Zoom Not Connected",
                        })
                  }
                  compact
                />
              </div>
              {zoomResult.join_url ? (
                <a
                  href={zoomResult.join_url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-mono-code text-[12px] text-[var(--accent)] hover:underline break-all"
                >
                  <span>{zoomResult.join_url}</span>
                  <ExternalLink className="h-3 w-3 shrink-0" />
                </a>
              ) : (
                <p className="text-[12px] text-[var(--ink-muted)]">
                  {localizeZoomStatusLabel(zoomResult, locale)}
                </p>
              )}
            </div>
          )}

          {externalSyncResults.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {externalSyncResults.map((res) => (
                <span
                  key={res.connector}
                  title={localizeMcpSyncMessage(res, locale)}
                  className={[
                    "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-medium",
                    res.status === "synced"
                      ? "bg-[var(--status-emerald-wash)] text-[var(--status-emerald)]"
                      : "bg-[var(--bg-surface-subtle)] text-[var(--ink-muted)]",
                  ].join(" ")}
                >
                  <span>{targetLabel(res.connector)}</span>
                  <span className="opacity-80">
                    {res.status === "synced"
                      ? tx({
                          "zh-CN": "已同步",
                          "zh-HK": "已同步",
                          en: "Synced",
                        })
                      : tx({
                          "zh-CN": ".ics 可用",
                          "zh-HK": ".ics 可用",
                          en: ".ics ready",
                        })}
                  </span>
                </span>
              ))}
            </div>
          )}
        </div>
      ) : (
        <form
          onSubmit={(e) => void handleConfirm(e)}
          data-testid="room-meeting-draft-form"
          className="space-y-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-sm bg-[var(--bg-surface-tint)] px-3.5 py-2 text-[11.5px]">
            <span
              title={roomId}
              className="flex min-w-0 items-center gap-1.5 text-[var(--ink-secondary)]"
            >
              <Calendar
                className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]"
                strokeWidth={1.85}
              />
              <span className="shrink-0">
                {tx({
                  "zh-CN": "关联会话：",
                  "zh-HK": "關聯對話：",
                  en: "Room: ",
                })}
              </span>
              <span className="truncate font-medium text-[var(--ink-primary)]">
                {roomTitle || roomId.slice(0, 14)}
              </span>
            </span>
          </div>

          <div>
            <label
              htmlFor="meeting-draft-title"
              className="block text-[12px] font-medium text-[var(--ink-secondary)]"
            >
              {t("zoom.meetingTitleLabel")}
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
              placeholder={tx({
                "zh-CN": "输入会议主题",
                "zh-HK": "輸入會議主題",
                en: "Enter meeting title",
              })}
              className="mt-1.5 h-10 w-full rounded-sm bg-[var(--bg-surface-tint)] px-3.5 text-[13.5px] text-[var(--ink-primary)] ring-1 ring-[var(--hairline-strong)] focus:bg-[var(--bg-surface)] focus:ring-[1.5px] focus:ring-[var(--accent)] focus:outline-none transition-all"
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label
                htmlFor="meeting-draft-start"
                className="block text-[12px] font-medium text-[var(--ink-secondary)]"
              >
                {tx({
                  "zh-CN": "开始时间（本地时区）",
                  "zh-HK": "開始時間（本地時區）",
                  en: "Start Time (Local)",
                })}
              </label>
              <input
                id="meeting-draft-start"
                data-testid="room-meeting-start-input"
                type="datetime-local"
                lang={LOCALE_META[locale].htmlLang}
                required
                value={startsLocal}
                onChange={(e) => {
                  setStartsLocal(e.target.value);
                  markDraftEdited();
                }}
                className="mt-1.5 h-10 w-full rounded-sm bg-[var(--bg-surface-tint)] px-3 font-mono-code text-[12.5px] text-[var(--ink-primary)] ring-1 ring-[var(--hairline-strong)] focus:bg-[var(--bg-surface)] focus:ring-[1.5px] focus:ring-[var(--accent)] focus:outline-none"
              />
            </div>

            <div>
              <label
                htmlFor="meeting-draft-end"
                className="block text-[12px] font-medium text-[var(--ink-secondary)]"
              >
                {tx({
                  "zh-CN": "结束时间（本地时区）",
                  "zh-HK": "結束時間（本地時區）",
                  en: "End Time (Local)",
                })}
              </label>
              <input
                id="meeting-draft-end"
                data-testid="room-meeting-end-input"
                type="datetime-local"
                lang={LOCALE_META[locale].htmlLang}
                required
                value={endsLocal}
                onChange={(e) => {
                  setEndsLocal(e.target.value);
                  markDraftEdited();
                }}
                className="mt-1.5 h-10 w-full rounded-sm bg-[var(--bg-surface-tint)] px-3 font-mono-code text-[12.5px] text-[var(--ink-primary)] ring-1 ring-[var(--hairline-strong)] focus:bg-[var(--bg-surface)] focus:ring-[1.5px] focus:ring-[var(--accent)] focus:outline-none"
              />
            </div>
          </div>

          {/* Room Member Attendees */}
          <div>
            <div className="flex items-center justify-between text-[12px] font-medium text-[var(--ink-secondary)]">
              <span className="flex items-center gap-1.5">
                <Users className="h-3.5 w-3.5 text-[var(--ink-muted)]" />
                <span>
                  {tx({
                    "zh-CN": "参会房间成员",
                    "zh-HK": "與會對話成員",
                    en: "Room Attendees",
                  })}
                </span>
              </span>
              <span className="text-[11px] text-[var(--ink-muted)] tabular-nums">
                {tp(
                  {
                    "zh-CN": "已选 {count} 人",
                    "zh-HK": "已選 {count} 人",
                    en: {
                      one: "{count} selected",
                      other: "{count} selected",
                    },
                  },
                  selectedAttendees.length,
                )}
              </span>
            </div>
            <div className="mt-1.5 max-h-[144px] overflow-y-auto divide-y divide-[var(--hairline-subtle)] rounded-tile bg-[var(--bg-surface-tint)]">
              {members.map((subject) => {
                const isSelf = actor?.subject === subject;
                const checked = isSelf || selectedAttendees.includes(subject);
                const prof = memberProfiles[subject];
                const memberName = resolveMemberName(subject, prof);
                return (
                  <label
                    key={subject}
                    className="flex items-center justify-between gap-2 px-3.5 py-2 text-[12.5px] cursor-pointer hover:bg-[var(--bg-hover)] transition-colors"
                  >
                    <span className="flex items-center gap-2.5 min-w-0">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={isSelf}
                        onChange={() => toggleAttendee(subject)}
                        className="h-4 w-4 rounded accent-[var(--accent-solid)]"
                      />
                      <Avatar
                        name={memberName}
                        fallbackText={subject}
                        size="xs"
                      />
                      <span className="truncate font-medium text-[var(--ink-primary)]">
                        {memberName}
                      </span>
                      <span className="font-mono-code text-[11px] text-[var(--ink-muted)]">
                        {subject}
                      </span>
                    </span>
                    {isSelf && (
                      <span className="rounded-full bg-[var(--accent-wash)] px-2 py-0.5 text-[10.5px] font-medium text-[var(--accent-ink)]">
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

          {/* Optional Zoom & External Calendar MCP Sync */}
          <div className="rounded-tile bg-[var(--bg-surface-tint)] p-3.5 space-y-2.5">
            <label className="flex items-center justify-between gap-2 text-[12.5px] cursor-pointer">
              <span className="flex items-center gap-2 font-medium text-[var(--ink-primary)]">
                <input
                  type="checkbox"
                  checked={enableZoom}
                  onChange={(e) => {
                    setEnableZoom(e.target.checked);
                    markDraftEdited();
                  }}
                  className="h-4 w-4 rounded accent-[var(--accent-solid)]"
                />
                <Video className="h-3.5 w-3.5 text-[var(--accent)]" />
                <span>
                  {tx({
                    "zh-CN": "同步生成 Zoom 视频会议链接",
                    "zh-HK": "同步產生 Zoom 視像會議連結",
                    en: "Generate Zoom video meeting link",
                  })}
                </span>
              </span>
              <span className="text-[11px] text-[var(--ink-muted)]">
                {zoomConnector?.configured
                  ? tx({
                      "zh-CN": "实时连接",
                      "zh-HK": "即時連線",
                      en: "Live",
                    })
                  : tx({
                      "zh-CN": "待配置 MCP",
                      "zh-HK": "待設定 MCP",
                      en: "Pending MCP",
                    })}
              </span>
            </label>

            <div className="border-t border-[var(--hairline-subtle)] pt-2.5">
              <div className="text-[11.5px] font-medium text-[var(--ink-muted)] mb-2">
                {tx({
                  "zh-CN": "可选：同步至外部日历 MCP（确认后同时支持 .ics 导出）",
                  "zh-HK": "可選：同步至外部日曆 MCP（確認後同時支援 .ics 匯出）",
                  en: "Optional: Sync to external calendars via MCP (.ics export included)",
                })}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {CALENDAR_TARGET_IDS.map((id) => {
                  const active = selectedTargets.includes(id);
                  const conn = connectorById.get(id);
                  return (
                    <button
                      key={id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => toggleExternalTarget(id)}
                      className={[
                        "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium transition-all duration-[140ms] cursor-pointer",
                        active
                          ? "bg-[var(--accent-solid)] text-[var(--accent-fg)] shadow-[var(--shadow-subtle)]"
                          : "bg-[var(--bg-surface)] text-[var(--ink-secondary)] ring-1 ring-[var(--hairline-strong)] hover:text-[var(--ink-primary)]",
                      ].join(" ")}
                    >
                      {active ? (
                        <Check
                          className="h-3.5 w-3.5 shrink-0"
                          strokeWidth={2.4}
                        />
                      ) : (
                        <span
                          className={[
                            "h-1.5 w-1.5 rounded-full",
                            conn?.configured
                              ? "bg-[var(--status-emerald)]"
                              : "bg-[var(--ink-muted)]",
                          ].join(" ")}
                        />
                      )}
                      <span>{targetLabel(id)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

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
      )}
    </Modal>
  );
}
