"use client";

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowUpRight,
  Calendar,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Download,
  ExternalLink,
  MessageSquare,
  Users,
  Video,
  X,
} from "lucide-react";
import {
  confirmZoomBooking,
  isApiError,
  isStaleAuthError,
  type ApiError,
} from "@/lib/api-client";
import { formatClockRange } from "@/lib/format";
import {
  CALENDAR_CONNECTOR_LABELS_I18N,
  LOCALE_META,
  PERSONA_LOCALIZATIONS,
  TIMEZONE_LABELS_I18N,
  localizeMcpSyncMessage,
  localizeNlMeetingWarning,
  localizeZoomStatusLabel,
  useLocale,
} from "@/lib/i18n";
import { useSession } from "@/lib/session-context";
import {
  BriefProgressChain,
  Interactive3DCard,
  type BriefProgressStep,
} from "@/components/kinetic";
import { AccessNoticeCard } from "@/components/ui/AccessNoticeCard";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { SourceTag } from "@/components/ui/SourceTag";
import { StatusBadge } from "@/components/ui/StatusBadge";
import {
  dateTimeLocalToOffsetIso,
  toDateTimeLocalInputValue,
} from "@/features/calendar/api";
import type {
  ExternalCalendarTarget,
  ZoomBookingConfirmResponse,
  ZoomBookingPreviewResponse,
} from "@/lib/types";

const ALL_CALENDAR_TARGETS: readonly ExternalCalendarTarget[] = [
  "google",
  "icloud",
  "outlook",
];

function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return toDateTimeLocalInputValue(d);
}

export interface ZoomBookingCardProps {
  preview?: ZoomBookingPreviewResponse | null;
  confirmed?: ZoomBookingConfirmResponse | null;
  parsing?: boolean;
  parseError?: string | null;
  onConfirmed?: (res: ZoomBookingConfirmResponse) => void;
  onDismiss?: () => void;
}

export function ZoomBookingCard({
  preview,
  confirmed,
  parsing = false,
  parseError = null,
  onConfirmed,
  onDismiss,
}: ZoomBookingCardProps) {
  const { handleAccessChanged } = useSession();
  const { t, tx, tp, locale, formatDateTime, localizePersona } = useLocale();

  const defaultMeetingTitle = tx({
    "zh-CN": "Zoom 协作会议",
    "zh-HK": "Zoom 協作會議",
    en: "Zoom Team Meeting",
  });

  const [title, setTitle] = useState(() =>
    preview?.draft.title_is_default
      ? defaultMeetingTitle
      : (preview?.draft.title ?? ""),
  );
  const [startsLocal, setStartsLocal] = useState(() =>
    preview?.draft.starts_at ? isoToLocalInput(preview.draft.starts_at) : "",
  );
  const [endsLocal, setEndsLocal] = useState(() =>
    preview?.draft.ends_at ? isoToLocalInput(preview.draft.ends_at) : "",
  );
  const [attendees, setAttendees] = useState(preview?.draft.attendees ?? []);
  const [createZoom, setCreateZoom] = useState(
    preview?.draft.create_zoom ?? true,
  );
  const [calendarTargets, setCalendarTargets] = useState<
    ExternalCalendarTarget[]
  >(preview?.draft.calendar_targets ?? ["google", "icloud", "outlook"]);
  const [submitting, setSubmitting] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [apiError, setApiError] = useState<ApiError | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);

  const clientIdRef = useRef<string>(preview?.draft.client_id ?? "");
  const submittingRef = useRef(false);

  const calendarTargetLabel = (target: ExternalCalendarTarget | string) => {
    const known =
      CALENDAR_CONNECTOR_LABELS_I18N[
        target as keyof typeof CALENDAR_CONNECTOR_LABELS_I18N
      ];
    return known ? known[locale] : target;
  };

  const resolveAttendeeName = (subject: string, rawName?: string) => {
    const known =
      PERSONA_LOCALIZATIONS[subject as keyof typeof PERSONA_LOCALIZATIONS];
    if (known && (!rawName || rawName === known["zh-CN"].displayName)) {
      return localizePersona(subject).displayName;
    }
    return rawName || localizePersona(subject).displayName || subject;
  };

  const localizeTimezone = (tz: string) =>
    TIMEZONE_LABELS_I18N[tz]?.[locale] ?? tz;

  useEffect(() => {
    if (!preview) return;
    clientIdRef.current = preview.draft.client_id;
    submittingRef.current = false;
    setTitle(
      preview.draft.title_is_default
        ? defaultMeetingTitle
        : preview.draft.title,
    );
    setStartsLocal(isoToLocalInput(preview.draft.starts_at));
    setEndsLocal(isoToLocalInput(preview.draft.ends_at));
    setAttendees(preview.draft.attendees);
    setCreateZoom(preview.draft.create_zoom);
    setCalendarTargets(preview.draft.calendar_targets);
    setValidationError(null);
    setApiError(null);
  }, [preview, defaultMeetingTitle]);

  if (parsing) {
    return <BriefProgressChain phase="pending" className="py-1" />;
  }

  if (parseError && !preview && !confirmed) {
    return (
      <div
        role="alert"
        className="rounded-card bg-[var(--bg-surface)] p-4 shadow-[var(--shadow-card)] text-[13px] text-[var(--status-crimson)]"
      >
        <div className="flex items-center gap-2 font-medium">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>
            {tx({
              "zh-CN": "未能解析会议预约请求",
              "zh-HK": "未能解析會議預約請求",
              en: "Could Not Parse Meeting Request",
            })}
          </span>
        </div>
        <p className="mt-1 text-[12.5px] text-[var(--ink-secondary)]">
          {parseError}
        </p>
      </div>
    );
  }

  if (confirmed) {
    const ev = confirmed.internal_event || confirmed.event;
    const zoom = confirmed.zoom || confirmed.zoom_meeting;
    const syncList =
      confirmed.external_sync || confirmed.calendar_sync_results || [];
    const activeSyncItems = syncList.filter((s) => s.status !== "unconfigured");
    const syncedCount = syncList.filter((s) => s.status === "synced").length;
    const isZoomLive = zoom.mode === "live_mcp" || zoom.mode === "live_api";
    const zoomStatusLocalized = localizeZoomStatusLabel(zoom, locale);

    const progressSteps: BriefProgressStep[] = [
      {
        id: "internal-cal",
        label: tx({
          "zh-CN": "已写入 AIOS 站内日历并通知参会同事",
          "zh-HK": "已寫入 AIOS 站內日曆並通知與會同事",
          en: "Saved to AIOS calendar and notified attendees",
        }),
        status: "done",
        meta: `r${ev.revision}`,
      },
      {
        id: "zoom-step",
        label: zoomStatusLocalized,
        status: isZoomLive
          ? "done"
          : zoom.mode === "error_fallback"
            ? "error"
            : "waiting",
        meta: zoom.meeting_id ? `ID ${zoom.meeting_id}` : undefined,
      },
      {
        id: "ext-cal",
        label:
          syncedCount > 0
            ? tp(
                {
                  "zh-CN": "外部日历已同步 {count} 项",
                  "zh-HK": "外部日曆已同步 {count} 項",
                  en: {
                    one: "Synced to {count} external calendar",
                    other: "Synced to {count} external calendars",
                  },
                },
                syncedCount,
              )
            : tx({
                "zh-CN": "已生成通用 .ics 日历文件",
                "zh-HK": "已產生通用 .ics 日曆檔案",
                en: "Universal .ics invite generated",
              }),
        status: syncedCount > 0 ? "done" : "waiting",
      },
    ];

    const handleCopyJoinUrl = async () => {
      if (!zoom.join_url) return;
      try {
        await navigator.clipboard.writeText(zoom.join_url);
        setCopiedUrl(true);
        window.setTimeout(() => setCopiedUrl(false), 1800);
      } catch {
        // ignore clipboard permission issues
      }
    };

    const attendeeListSeparator = locale === "en" ? ", " : "、";
    const humanizedAttendees = ev.attendees
      .map((sub) => resolveAttendeeName(sub))
      .join(attendeeListSeparator);

    return (
      <div className="space-y-1.5">
        <BriefProgressChain
          phase="done"
          summaryLabel={tx({
            "zh-CN": "已写入站内日历 · 3 步同步核验",
            "zh-HK": "已寫入站內日曆 · 3 步同步核驗",
            en: "Saved to calendar · 3 sync steps verified",
          })}
          steps={progressSteps}
        />

        <Interactive3DCard
          maxTilt={2}
          hoverLiftPx={-1}
          sheenIntensity="subtle"
          data-testid="zoom-booking-confirmed-card"
          className="overflow-hidden rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)]"
        >
          {/* M-6a: Consistent confirmed heading & badge (zero "confirmed + sandbox" vs "unconnected" contradiction) */}
          <div className="flex flex-wrap items-center justify-between gap-2 bg-[var(--status-emerald-wash)] px-4 py-3">
            <div className="flex items-center gap-2">
              <CheckCircle2
                className="h-4 w-4 text-[var(--status-emerald)]"
                strokeWidth={2}
              />
              <span className="text-[13.5px] font-semibold text-[var(--ink-primary)]">
                {isZoomLive
                  ? tx({
                      "zh-CN": "会议预约已确认",
                      "zh-HK": "會議預約已確認",
                      en: "Meeting Booked",
                    })
                  : tx({
                      "zh-CN": "已写入站内日历",
                      "zh-HK": "已寫入站內日曆",
                      en: "Saved to Calendar",
                    })}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <StatusBadge
                status={isZoomLive ? "connected" : "sandbox_ready"}
                label={
                  isZoomLive
                    ? tx({
                        "zh-CN": "Zoom 已连接",
                        "zh-HK": "Zoom 已連線",
                        en: "Zoom Connected",
                      })
                    : zoom.mode === "skipped"
                      ? tx({
                          "zh-CN": "仅站内日程",
                          "zh-HK": "僅站內行程",
                          en: "Calendar Only",
                        })
                      : tx({
                          "zh-CN": "Zoom 未连接",
                          "zh-HK": "Zoom 未連線",
                          en: "Zoom Not Connected",
                        })
                }
                compact
              />
              <SourceTag source={ev.source} />
            </div>
          </div>

          <div className="p-4 space-y-3.5">
            <div>
              <h3 className="text-[15px] font-semibold text-[var(--ink-primary)]">
                {ev.title}
              </h3>
              {/* M-6b & S-1: Sans for humanized attendee names, mono strictly on date/clock codes */}
              <div className="mt-1 flex flex-wrap items-center gap-3 text-[12px] text-[var(--ink-secondary)]">
                <span className="inline-flex items-center gap-1.5 font-mono-code tabular-nums">
                  <Calendar className="h-3.5 w-3.5 text-[var(--accent)]" />
                  <span>{formatDateTime(ev.starts_at, { dateOnly: true })}</span>
                </span>
                <span className="inline-flex items-center gap-1.5 font-mono-code tabular-nums">
                  <Clock className="h-3.5 w-3.5 text-[var(--ink-muted)]" />
                  <span>{formatClockRange(ev.starts_at, ev.ends_at)}</span>
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Users className="h-3.5 w-3.5 text-[var(--ink-muted)]" />
                  <span>{humanizedAttendees}</span>
                </span>
              </div>
            </div>

            {zoom.join_url ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-tile bg-[var(--accent-wash)] px-3.5 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-[12px] font-semibold text-[var(--accent-ink)]">
                    <Video className="h-3.5 w-3.5" />
                    <span>
                      {tx({
                        "zh-CN": "Zoom 视频会议链接",
                        "zh-HK": "Zoom 視像會議連結",
                        en: "Zoom Video Meeting Link",
                      })}
                    </span>
                    {zoom.passcode && (
                      <span className="text-[11px] font-normal text-[var(--ink-secondary)]">
                        ·{" "}
                        {tx({
                          "zh-CN": "密码 ",
                          "zh-HK": "密碼 ",
                          en: "Passcode ",
                        })}
                        <span className="font-mono-code">{zoom.passcode}</span>
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate font-mono-code text-[11.5px] text-[var(--ink-primary)]">
                    {zoom.join_url}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <Button
                    size="sm"
                    variant="secondary"
                    pill
                    onClick={() => void handleCopyJoinUrl()}
                  >
                    {copiedUrl ? (
                      <Check className="h-3.5 w-3.5 text-[var(--status-emerald)]" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                    <span>
                      {copiedUrl ? t("common.copied") : t("common.copy")}
                    </span>
                  </Button>
                  <a
                    href={zoom.join_url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-8 items-center gap-1 rounded-full bg-[var(--accent-solid)] px-3 text-[12px] font-medium text-[var(--accent-fg)] hover:bg-[var(--accent-solid-hover)] transition-colors"
                  >
                    <span>
                      {tx({
                        "zh-CN": "加入",
                        "zh-HK": "加入",
                        en: "Join",
                      })}
                    </span>
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              </div>
            ) : (
              <div className="rounded-tile bg-[var(--bg-surface-tint)] px-3.5 py-2.5 text-[12.5px] text-[var(--ink-secondary)]">
                {zoomStatusLocalized}
              </div>
            )}

            {/* External sync pills ONLY for connected / errored connectors (localized tooltip via M-5) */}
            {activeSyncItems.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {activeSyncItems.map((item) => (
                  <span
                    key={item.connector}
                    title={localizeMcpSyncMessage(item, locale)}
                    className={[
                      "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-medium",
                      item.status === "synced"
                        ? "bg-[var(--status-emerald-wash)] text-[var(--status-emerald)]"
                        : "bg-[var(--status-amber-wash)] text-[var(--status-amber-ink)]",
                    ].join(" ")}
                  >
                    <span
                      className={[
                        "h-1.5 w-1.5 rounded-full",
                        item.status === "synced"
                          ? "bg-[var(--status-emerald)]"
                          : "bg-[var(--status-amber)]",
                      ].join(" ")}
                    />
                    <span>{calendarTargetLabel(item.connector)}</span>
                    <span className="text-[10.5px] opacity-85">
                      {item.status === "synced"
                        ? tx({
                            "zh-CN": "已同步",
                            "zh-HK": "已同步",
                            en: "Synced",
                          })
                        : tx({
                            "zh-CN": "同步受阻",
                            "zh-HK": "同步受阻",
                            en: "Sync failed",
                          })}
                    </span>
                  </span>
                ))}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[var(--hairline-subtle)]">
              <a
                href={confirmed.ics_download_url}
                download
                data-testid="zoom-booking-ics-download"
                className="inline-flex h-8 items-center gap-1.5 rounded-full bg-[var(--bg-surface-subtle)] px-3.5 text-[12px] font-medium text-[var(--ink-primary)] hover:bg-[var(--bg-hover)] transition-colors"
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

              <div className="flex items-center gap-2">
                {ev.room_id && (
                  <Link
                    href={`/inbox/${encodeURIComponent(ev.room_id)}`}
                    className="inline-flex h-8 items-center gap-1 rounded-full bg-[var(--bg-surface)] px-3 text-[12px] font-medium text-[var(--ink-secondary)] shadow-[var(--shadow-subtle)] hover:text-[var(--ink-primary)] transition-colors"
                  >
                    <MessageSquare className="h-3.5 w-3.5" />
                    <span>
                      {tx({
                        "zh-CN": "协作房间",
                        "zh-HK": "協作對話",
                        en: "Team Room",
                      })}
                    </span>
                  </Link>
                )}
                <Link
                  href="/calendar"
                  className="inline-flex h-8 items-center gap-1 rounded-full bg-[var(--accent-solid)] px-3.5 text-[12px] font-medium text-[var(--accent-fg)] hover:bg-[var(--accent-solid-hover)] transition-colors"
                >
                  <span>
                    {tx({
                      "zh-CN": "查看日历",
                      "zh-HK": "檢視日曆",
                      en: "View Calendar",
                    })}
                  </span>
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </Link>
              </div>
            </div>
          </div>
        </Interactive3DCard>
      </div>
    );
  }

  if (!preview) return null;

  const toggleCalendarTarget = (target: ExternalCalendarTarget) => {
    setCalendarTargets((prev) =>
      prev.includes(target)
        ? prev.filter((item) => item !== target)
        : [...prev, target],
    );
  };

  const removeAttendee = (subject: string) => {
    setAttendees((prev) => prev.filter((a) => a.subject !== subject));
  };

  const connectorById = new Map(
    preview.connectors.map((c) => [c.connector, c]),
  );

  // M-4: Prefer structured warning_items, fall back to localized warning strings
  const localizedWarnings: string[] =
    preview.warning_items && preview.warning_items.length > 0
      ? preview.warning_items.map((item) =>
          localizeNlMeetingWarning(item, locale),
        )
      : preview.warnings.map((w) => localizeNlMeetingWarning(w, locale));

  const hasUnresolvedWarning = Boolean(
    preview.warning_items?.some((w) => w.code === "UNRESOLVED_MENTION") ||
      (preview.draft.unresolved_mentions.length > 0 &&
        localizedWarnings.some((w) =>
          w.includes(preview.draft.unresolved_mentions[0]!),
        )),
  );

  const handleConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingRef.current) return;

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
      const res = await confirmZoomBooking({
        client_id: clientIdRef.current,
        title: trimmedTitle,
        starts_at: startsIso,
        ends_at: endsIso,
        timezone: preview.draft.timezone,
        attendees: attendees.map((a) => a.subject),
        room_id: preview.draft.room_id,
        create_zoom: createZoom,
        notify_room: preview.draft.notify_room,
        calendar_targets: calendarTargets,
      });
      onConfirmed?.(res);
    } catch (err) {
      if (isStaleAuthError(err)) return;
      if (isApiError(err)) {
        if (err.code === "ACCESS_CHANGED") {
          void handleAccessChanged();
        }
        setApiError(err);
      } else {
        setValidationError(
          tx({
            "zh-CN": "确认预约失败，请稍后重试。",
            "zh-HK": "確認預約失敗，請稍後重試。",
            en: "Failed to confirm booking. Please try again.",
          }),
        );
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const htmlLang = LOCALE_META[locale].htmlLang;

  return (
    <Interactive3DCard
      maxTilt={2}
      hoverLiftPx={-1}
      sheenIntensity="subtle"
      data-testid="zoom-booking-preview-card"
      className="overflow-hidden rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)]"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 bg-[var(--bg-surface-tint)] px-4 py-3 border-b border-[var(--hairline-subtle)]">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-[var(--accent-wash)] text-[var(--accent-ink)]">
            <Video className="h-3.5 w-3.5" strokeWidth={2} />
          </span>
          <div>
            <div className="text-[13.5px] font-semibold text-[var(--ink-primary)]">
              {tx({
                "zh-CN": "Zoom 会议预约预览",
                "zh-HK": "Zoom 會議預約預覽",
                en: "Zoom Meeting Draft",
              })}
            </div>
            <div className="text-[11px] text-[var(--ink-muted)]">
              {tx({
                "zh-CN": "核对时间与参会同事后确认写入站内日历",
                "zh-HK": "核對時間與與會同事後確認寫入站內日曆",
                en: "Review time and attendees before booking",
              })}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <StatusBadge
            status={preview.zoom_configured ? "connected" : "sandbox_ready"}
            label={
              preview.zoom_configured
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
          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              aria-label={tx({
                "zh-CN": "取消预约预览",
                "zh-HK": "取消預約預覽",
                en: "Dismiss booking draft",
              })}
              className="inline-flex h-7 w-7 items-center justify-center rounded-full text-[var(--ink-muted)] hover:bg-[var(--bg-hover)] cursor-pointer"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      <form onSubmit={(e) => void handleConfirm(e)} className="p-4 space-y-3.5">
        {(localizedWarnings.length > 0 ||
          (preview.draft.unresolved_mentions.length > 0 &&
            !hasUnresolvedWarning)) && (
          <div className="rounded-tile bg-[var(--status-amber-wash)] px-3.5 py-2.5 text-[12px] text-[var(--status-amber-ink)] space-y-1">
            {localizedWarnings.map((w, idx) => (
              <div key={idx} className="flex items-start gap-1.5">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{w}</span>
              </div>
            ))}
            {preview.draft.unresolved_mentions.length > 0 &&
              !hasUnresolvedWarning && (
                <div className="flex items-start gap-1.5">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    {localizeNlMeetingWarning(
                      {
                        code: "UNRESOLVED_MENTION",
                        params: {
                          token: preview.draft.unresolved_mentions.join(
                            locale === "en" ? ", " : "、",
                          ),
                        },
                      },
                      locale,
                    )}
                  </span>
                </div>
              )}
          </div>
        )}

        <div>
          <label className="block text-[11.5px] font-medium text-[var(--ink-muted)]">
            {t("zoom.meetingTitleLabel")}
          </label>
          <input
            type="text"
            maxLength={120}
            required
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              setValidationError(null);
            }}
            data-testid="zoom-booking-title-input"
            className="mt-1 h-9 w-full rounded-sm bg-[var(--bg-surface-tint)] px-3 text-[13.5px] font-medium text-[var(--ink-primary)] ring-1 ring-[var(--hairline-strong)] focus:bg-[var(--bg-surface)] focus:ring-2 focus:ring-[var(--accent)] focus:outline-none transition-all"
          />
        </div>

        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          <div>
            <label className="block text-[11.5px] font-medium text-[var(--ink-muted)]">
              {tx(
                {
                  "zh-CN": "开始时间（{tz}）",
                  "zh-HK": "開始時間（{tz}）",
                  en: "Start ({tz})",
                },
                { tz: localizeTimezone(preview.draft.timezone) },
              )}
            </label>
            <input
              type="datetime-local"
              lang={htmlLang}
              required
              value={startsLocal}
              onChange={(e) => {
                setStartsLocal(e.target.value);
                setValidationError(null);
              }}
              className="mt-1 h-9 w-full rounded-sm bg-[var(--bg-surface-tint)] px-2.5 font-mono-code text-[12.5px] text-[var(--ink-primary)] ring-1 ring-[var(--hairline-strong)] focus:bg-[var(--bg-surface)] focus:ring-2 focus:ring-[var(--accent)] focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-[11.5px] font-medium text-[var(--ink-muted)]">
              {tx({
                "zh-CN": "结束时间",
                "zh-HK": "結束時間",
                en: "End",
              })}
            </label>
            <input
              type="datetime-local"
              lang={htmlLang}
              required
              value={endsLocal}
              onChange={(e) => {
                setEndsLocal(e.target.value);
                setValidationError(null);
              }}
              className="mt-1 h-9 w-full rounded-sm bg-[var(--bg-surface-tint)] px-2.5 font-mono-code text-[12.5px] text-[var(--ink-primary)] ring-1 ring-[var(--hairline-strong)] focus:bg-[var(--bg-surface)] focus:ring-2 focus:ring-[var(--accent)] focus:outline-none"
            />
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between text-[11.5px] font-medium text-[var(--ink-muted)]">
            <span>
              {tx({
                "zh-CN": "同租户参会同事",
                "zh-HK": "同租戶與會同事",
                en: "Tenant Attendees",
              })}
            </span>
            <span className="tabular-nums">
              {attendees.length > 0
                ? tp(
                    {
                      "zh-CN": "{count} 位受邀",
                      "zh-HK": "{count} 位受邀",
                      en: {
                        one: "{count} attendee",
                        other: "{count} attendees",
                      },
                    },
                    attendees.length,
                  )
                : tx({
                    "zh-CN": "仅本人日程",
                    "zh-HK": "僅本人行程",
                    en: "Solo event",
                  })}
            </span>
          </div>
          {attendees.length === 0 ? (
            <div className="mt-1.5 rounded-sm bg-[var(--bg-surface-tint)] px-3 py-2 text-[12px] text-[var(--ink-muted)]">
              {tx({
                "zh-CN": "未指定其他同事，将为您创建个人会议日程。",
                "zh-HK": "未指定其他同事，將為您建立個人會議行程。",
                en: "No colleagues specified — this will be booked as a personal event.",
              })}
            </div>
          ) : (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {attendees.map((att) => {
                const name = resolveAttendeeName(att.subject, att.display_name);
                return (
                  <span
                    key={att.subject}
                    className="inline-flex items-center gap-1.5 rounded-full bg-[var(--bg-surface-subtle)] py-1 pl-1.5 pr-2 text-[12px] text-[var(--ink-primary)]"
                  >
                    <Avatar
                      name={name}
                      fallbackText={att.subject}
                      size="xs"
                    />
                    <span className="font-medium">{name}</span>
                    <span className="font-mono-code text-[10.5px] text-[var(--ink-muted)]">
                      {att.subject}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeAttendee(att.subject)}
                      aria-label={tx(
                        {
                          "zh-CN": "移除参会人 {name}",
                          "zh-HK": "移除與會者 {name}",
                          en: "Remove attendee {name}",
                        },
                        { name },
                      )}
                      className="ml-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full text-[var(--ink-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--ink-primary)] cursor-pointer"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                );
              })}
            </div>
          )}
        </div>

        <div className="rounded-tile bg-[var(--bg-surface-tint)] p-3 space-y-2.5">
          <label className="flex items-center justify-between gap-2 text-[12.5px] cursor-pointer">
            <span className="flex items-center gap-2 font-medium text-[var(--ink-primary)]">
              <input
                type="checkbox"
                checked={createZoom}
                onChange={(e) => setCreateZoom(e.target.checked)}
                className="h-4 w-4 rounded accent-[var(--accent-solid)]"
              />
              <span>
                {tx({
                  "zh-CN": "创建 Zoom 视频会议链接",
                  "zh-HK": "建立 Zoom 視像會議連結",
                  en: "Create Zoom video meeting link",
                })}
              </span>
            </span>
            <span className="text-[11px] text-[var(--ink-muted)]">
              {preview.zoom_configured
                ? tx({
                    "zh-CN": "实时连接",
                    "zh-HK": "即時連線",
                    en: "Live",
                  })
                : tx({
                    "zh-CN": "待配置 MCP",
                    "zh-HK": "待設定 MCP",
                    en: "MCP Pending",
                  })}
            </span>
          </label>

          {/* M-6e: Unmistakable selected vs unselected sync chips with Check icon & aria-pressed */}
          <div className="border-t border-[var(--hairline-subtle)] pt-2.5">
            <div className="text-[11.5px] font-medium text-[var(--ink-muted)] mb-2">
              {tx({
                "zh-CN": "同步至外部日历（同时生成 .ics）",
                "zh-HK": "同步至外部日曆（同時產生 .ics）",
                en: "Sync to external calendars (also generates .ics)",
              })}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {ALL_CALENDAR_TARGETS.map((target) => {
                const selected = calendarTargets.includes(target);
                const statusInfo = connectorById.get(target);
                return (
                  <button
                    key={target}
                    type="button"
                    aria-pressed={selected}
                    title={
                      statusInfo?.configured
                        ? tx({
                            "zh-CN": "已配置实时同步",
                            "zh-HK": "已設定即時同步",
                            en: "Live sync configured",
                          })
                        : tx({
                            "zh-CN": "未配置 MCP，将提供 .ics 导出",
                            "zh-HK": "未設定 MCP，將提供 .ics 匯出",
                            en: "MCP not configured — .ics export provided",
                          })
                    }
                    onClick={() => toggleCalendarTarget(target)}
                    className={[
                      "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium transition-all duration-[140ms] cursor-pointer",
                      selected
                        ? "bg-[var(--accent-solid)] text-[var(--accent-fg)] shadow-[var(--shadow-subtle)]"
                        : "bg-[var(--bg-surface)] text-[var(--ink-secondary)] ring-1 ring-[var(--hairline-strong)] hover:text-[var(--ink-primary)]",
                    ].join(" ")}
                  >
                    {selected ? (
                      <Check className="h-3.5 w-3.5 shrink-0" strokeWidth={2.4} />
                    ) : (
                      <span
                        aria-hidden="true"
                        className="h-3 w-3 shrink-0 rounded-full border border-[var(--hairline-strong)]"
                      />
                    )}
                    <span>{calendarTargetLabel(target)}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {validationError && (
          <div
            role="alert"
            className="rounded-tile bg-[var(--status-crimson-wash)] px-3 py-2 text-[12.5px] text-[var(--status-crimson)]"
          >
            {validationError}
          </div>
        )}

        {apiError && <AccessNoticeCard error={apiError} />}

        {/* M-6d: Keep internal idempotency key in tooltip rather than user-facing chrome */}
        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
          {onDismiss && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              pill
              disabled={submitting}
              onClick={onDismiss}
            >
              {t("common.cancel")}
            </Button>
          )}
          <Button
            type="submit"
            size="sm"
            variant="primary"
            pill
            loading={submitting}
            disabled={submitting}
            data-testid="zoom-booking-confirm-btn"
            title={preview.draft.client_id}
          >
            <Check className="h-3.5 w-3.5" strokeWidth={2.2} />
            <span>
              {submitting
                ? tx({
                    "zh-CN": "正在预约并同步…",
                    "zh-HK": "正在預約並同步…",
                    en: "Booking & syncing…",
                  })
                : tx({
                    "zh-CN": "确认预约并写入日历",
                    "zh-HK": "確認預約並寫入日曆",
                    en: "Confirm & Book",
                  })}
            </span>
          </Button>
        </div>
      </form>
    </Interactive3DCard>
  );
}
