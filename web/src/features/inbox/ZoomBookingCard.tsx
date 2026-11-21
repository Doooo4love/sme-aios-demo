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
import { formatClockRange, formatUnixTime } from "@/lib/format";
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

const CALENDAR_TARGET_META: Record<
  ExternalCalendarTarget,
  { label: string; short: string }
> = {
  google: { label: "Google Calendar", short: "Google" },
  icloud: { label: "Apple iCloud 日历", short: "iCloud" },
  outlook: { label: "Outlook / M365 日历", short: "Outlook" },
};

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

  const [title, setTitle] = useState(preview?.draft.title ?? "");
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

  useEffect(() => {
    if (!preview) return;
    clientIdRef.current = preview.draft.client_id;
    submittingRef.current = false;
    setTitle(preview.draft.title);
    setStartsLocal(isoToLocalInput(preview.draft.starts_at));
    setEndsLocal(isoToLocalInput(preview.draft.ends_at));
    setAttendees(preview.draft.attendees);
    setCreateZoom(preview.draft.create_zoom);
    setCalendarTargets(preview.draft.calendar_targets);
    setValidationError(null);
    setApiError(null);
  }, [preview]);

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
          <span>未能解析会议预约请求</span>
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

    const progressSteps: BriefProgressStep[] = [
      {
        id: "internal-cal",
        label: "已写入 AIOS 站内日历并通知参会同事",
        status: "done",
        meta: `r${ev.revision}`,
      },
      {
        id: "zoom-step",
        label: isZoomLive ? zoom.status_label : "Zoom 未连接 · 已写入站内日历",
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
            ? `外部日历已同步 ${syncedCount} 项`
            : "已生成通用 .ics 日历文件",
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

    return (
      <div className="space-y-1.5">
        <BriefProgressChain
          phase="done"
          summaryLabel="已写入站内日历 · 3 步同步核验"
          steps={progressSteps}
        />

        <Interactive3DCard
          maxTilt={2}
          hoverLiftPx={-1}
          sheenIntensity="subtle"
          data-testid="zoom-booking-confirmed-card"
          className="overflow-hidden rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)]"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 bg-[var(--status-emerald-wash)] px-4 py-3">
            <div className="flex items-center gap-2">
              <CheckCircle2
                className="h-4 w-4 text-[var(--status-emerald)]"
                strokeWidth={2}
              />
              <span className="text-[13.5px] font-semibold text-[var(--ink-primary)]">
                会议预约已确认
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <StatusBadge
                status={isZoomLive ? "connected" : "sandbox_ready"}
                label={isZoomLive ? "Zoom 已连接" : "Zoom 沙盒预览"}
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
              <div className="mt-1 flex flex-wrap items-center gap-3 font-mono-code text-[12px] text-[var(--ink-secondary)] tabular-nums">
                <span className="inline-flex items-center gap-1.5">
                  <Calendar className="h-3.5 w-3.5 text-[var(--accent)]" />
                  <span>{formatUnixTime(ev.starts_at, { dateOnly: true })}</span>
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5 text-[var(--ink-muted)]" />
                  <span>{formatClockRange(ev.starts_at, ev.ends_at)}</span>
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Users className="h-3.5 w-3.5 text-[var(--ink-muted)]" />
                  <span>{ev.attendees.join("、")}</span>
                </span>
              </div>
            </div>

            {zoom.join_url ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-tile bg-[var(--accent-wash)] px-3.5 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-[12px] font-semibold text-[var(--accent)]">
                    <Video className="h-3.5 w-3.5" />
                    <span>Zoom 视频会议链接</span>
                    {zoom.passcode && (
                      <span className="font-mono-code text-[11px] font-normal text-[var(--ink-secondary)]">
                        · 密码 {zoom.passcode}
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
                    <span>{copiedUrl ? "已复制" : "复制"}</span>
                  </Button>
                  <a
                    href={zoom.join_url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-8 items-center gap-1 rounded-full bg-[var(--accent)] px-3 text-[12px] font-medium text-white hover:bg-[var(--accent-hover)] transition-colors"
                  >
                    <span>加入</span>
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              </div>
            ) : (
              <div className="rounded-tile bg-[var(--bg-surface-tint)] px-3.5 py-2.5 text-[12.5px] text-[var(--ink-secondary)]">
                Zoom 未连接 · 已写入站内日历
              </div>
            )}

            {/* Show external sync pills ONLY for connected / errored connectors (no duplicate unconfigured noise) */}
            {activeSyncItems.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {activeSyncItems.map((item) => (
                  <span
                    key={item.connector}
                    title={item.message}
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
                    <span>{item.label}</span>
                    <span className="text-[10.5px] opacity-80">
                      {item.status === "synced" ? "已同步" : "同步受阻"}
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
                <span>下载 .ics</span>
              </a>

              <div className="flex items-center gap-2">
                {ev.room_id && (
                  <Link
                    href={`/inbox/${encodeURIComponent(ev.room_id)}`}
                    className="inline-flex h-8 items-center gap-1 rounded-full bg-[var(--bg-surface)] px-3 text-[12px] font-medium text-[var(--ink-secondary)] shadow-[var(--shadow-subtle)] hover:text-[var(--ink-primary)] transition-colors"
                  >
                    <MessageSquare className="h-3.5 w-3.5" />
                    <span>协作房间</span>
                  </Link>
                )}
                <Link
                  href="/calendar"
                  className="inline-flex h-8 items-center gap-1 rounded-full bg-[var(--accent)] px-3.5 text-[12px] font-medium text-white hover:bg-[var(--accent-hover)] transition-colors"
                >
                  <span>查看日历</span>
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
        ? prev.filter((t) => t !== target)
        : [...prev, target],
    );
  };

  const removeAttendee = (subject: string) => {
    setAttendees((prev) => prev.filter((a) => a.subject !== subject));
  };

  const connectorById = new Map(
    preview.connectors.map((c) => [c.connector, c]),
  );

  const handleConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingRef.current) return;

    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setValidationError("请输入会议主题（1–120 字符）。");
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
    if (endMs <= startMs || endMs - startMs > 86_400_000) {
      setValidationError("结束时间必须晚于开始时间且时长不超过 24 小时。");
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
        setValidationError("确认预约失败，请稍后重试。");
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

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
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-[var(--accent-wash)] text-[var(--accent)]">
            <Video className="h-3.5 w-3.5" strokeWidth={2} />
          </span>
          <div>
            <div className="text-[13.5px] font-semibold text-[var(--ink-primary)]">
              Zoom 会议预约预览
            </div>
            <div className="text-[11px] text-[var(--ink-muted)]">
              核对时间与参会同事后确认写入站内日历
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <StatusBadge
            status={preview.zoom_configured ? "connected" : "sandbox_ready"}
            label={preview.zoom_configured ? "Zoom 已连接" : "Zoom 沙盒预览"}
            compact
          />
          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              aria-label="取消预约预览"
              className="inline-flex h-7 w-7 items-center justify-center rounded-full text-[var(--ink-muted)] hover:bg-[var(--bg-hover)] cursor-pointer"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      <form onSubmit={(e) => void handleConfirm(e)} className="p-4 space-y-3.5">
        {(preview.warnings.length > 0 ||
          preview.draft.unresolved_mentions.length > 0) && (
          <div className="rounded-tile bg-[var(--status-amber-wash)] px-3.5 py-2.5 text-[12px] text-[var(--status-amber-ink)] space-y-1">
            {preview.warnings.map((w, idx) => (
              <div key={idx} className="flex items-start gap-1.5">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{w}</span>
              </div>
            ))}
            {preview.draft.unresolved_mentions.length > 0 &&
              preview.warnings.every(
                (w) => !w.includes(preview.draft.unresolved_mentions[0]!),
              ) && (
                <div className="flex items-start gap-1.5">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    未在当前租户通讯录匹配到：
                    {preview.draft.unresolved_mentions.join("、")}
                  </span>
                </div>
              )}
          </div>
        )}

        <div>
          <label className="block text-[11.5px] font-medium text-[var(--ink-muted)]">
            会议主题
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
              开始时间（{preview.draft.timezone}）
            </label>
            <input
              type="datetime-local"
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
              结束时间
            </label>
            <input
              type="datetime-local"
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
            <span>同租户参会同事</span>
            <span className="font-mono-code">
              {attendees.length > 0 ? `${attendees.length} 位受邀` : "仅本人日程"}
            </span>
          </div>
          {attendees.length === 0 ? (
            <div className="mt-1.5 rounded-sm bg-[var(--bg-surface-tint)] px-3 py-2 text-[12px] text-[var(--ink-muted)]">
              未指定其他同事，将为您创建个人会议日程。
            </div>
          ) : (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {attendees.map((att) => (
                <span
                  key={att.subject}
                  className="inline-flex items-center gap-1.5 rounded-full bg-[var(--bg-surface-subtle)] py-1 pl-1.5 pr-2 text-[12px] text-[var(--ink-primary)]"
                >
                  <Avatar
                    name={att.display_name}
                    fallbackText={att.subject}
                    size="xs"
                  />
                  <span className="font-medium">{att.display_name}</span>
                  <span className="font-mono-code text-[10.5px] text-[var(--ink-muted)]">
                    {att.subject}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeAttendee(att.subject)}
                    aria-label={`移除参会人 ${att.display_name}`}
                    className="ml-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full text-[var(--ink-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--ink-primary)] cursor-pointer"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
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
                className="h-4 w-4 rounded accent-[var(--accent)]"
              />
              <span>创建 Zoom 视频会议链接</span>
            </span>
            <span className="text-[11px] text-[var(--ink-muted)]">
              {preview.zoom_configured ? "实时连接" : "沙盒预览"}
            </span>
          </label>

          <div className="border-t border-[var(--hairline-subtle)] pt-2.5">
            <div className="text-[11.5px] font-medium text-[var(--ink-muted)] mb-2">
              同步至外部日历（同时生成 .ics）
            </div>
            <div className="flex flex-wrap gap-1.5">
              {ALL_CALENDAR_TARGETS.map((target) => {
                const selected = calendarTargets.includes(target);
                const statusInfo = connectorById.get(target);
                return (
                  <button
                    key={target}
                    type="button"
                    onClick={() => toggleCalendarTarget(target)}
                    className={[
                      "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium transition-all duration-[140ms] cursor-pointer",
                      selected
                        ? "bg-[var(--accent-wash-strong)] text-[var(--accent)] ring-1 ring-[var(--accent-border)]"
                        : "bg-[var(--bg-surface)] text-[var(--ink-secondary)] shadow-[var(--shadow-subtle)] hover:text-[var(--ink-primary)]",
                    ].join(" ")}
                  >
                    <span
                      className={[
                        "h-1.5 w-1.5 rounded-full",
                        statusInfo?.configured
                          ? "bg-[var(--status-emerald)]"
                          : "bg-[var(--ink-faint)]",
                      ].join(" ")}
                    />
                    <span>{CALENDAR_TARGET_META[target].label}</span>
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

        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <span className="font-mono-code text-[11px] text-[var(--ink-muted)]">
            幂等键 {preview.draft.client_id.slice(0, 18)}
          </span>
          <div className="flex items-center gap-2">
            {onDismiss && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                pill
                disabled={submitting}
                onClick={onDismiss}
              >
                取消
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
            >
              <Check className="h-3.5 w-3.5" strokeWidth={2.2} />
              <span>{submitting ? "正在预约并同步…" : "确认预约并写入日历"}</span>
            </Button>
          </div>
        </div>
      </form>
    </Interactive3DCard>
  );
}
