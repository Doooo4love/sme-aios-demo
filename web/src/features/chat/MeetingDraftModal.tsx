"use client";

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  Calendar,
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
import { formatClockRange, formatUnixTime } from "@/lib/format";
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

const CALENDAR_TARGETS: Array<{ id: ExternalCalendarTarget; label: string }> = [
  { id: "google", label: "Google Calendar" },
  { id: "icloud", label: "Apple iCloud" },
  { id: "outlook", label: "Outlook / M365" },
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
        ? prev.filter((t) => t !== target)
        : [...prev, target],
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
        setValidationError("创建会议失败，请保留表单内容后点击重试。");
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const connectorById = new Map(mcpConnectors.map((c) => [c.connector, c]));
  const zoomConnector = connectorById.get("zoom");

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!submitting) onOpenChange(next);
      }}
      title={createdEvent ? "会议已写入站内日历" : "预约房间会议 · 核对后确认"}
      subtitle={
        createdEvent
          ? "已写入 AIOS 站内日历并向参会同事发送站内通知。"
          : `关联会话「${roomTitle}」（仅预览草稿，点击确认后方正式写入）`
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
              返回会话
            </Button>
            {icsUrl && (
              <a
                href={icsUrl}
                download
                className="inline-flex h-9 items-center gap-1.5 rounded-full bg-[var(--bg-surface)] px-3.5 text-[12.5px] font-medium text-[var(--ink-primary)] shadow-[var(--shadow-subtle)] hover:shadow-[var(--shadow-card)] transition-all"
              >
                <Download className="h-3.5 w-3.5 text-[var(--accent)]" />
                <span>下载 .ics</span>
              </a>
            )}
            <Link
              href="/calendar"
              data-testid="meeting-view-calendar-link"
              className="inline-flex h-9 items-center gap-1.5 rounded-full bg-[var(--accent)] px-4 text-[13px] font-medium text-white shadow-[0_1px_2px_rgba(22,104,227,0.24)] hover:bg-[var(--accent-hover)] transition-colors"
            >
              <span>在日历中查看</span>
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
              取消
            </Button>
            <Button
              variant="primary"
              pill
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
          <div className="rounded-card bg-[var(--status-emerald-wash)] p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 font-semibold text-[var(--status-emerald)]">
                <CheckCircle2 className="h-4 w-4" strokeWidth={2} />
                <span>已创建站内日历事件</span>
              </div>
              <SourceTag source={createdEvent.source} />
            </div>
            <h3 className="text-[15.5px] font-semibold text-[var(--ink-primary)]">
              {createdEvent.title}
            </h3>
            <dl className="divide-y divide-[var(--hairline-subtle)] rounded-sm bg-[var(--bg-surface)] text-[12px]">
              <div className="flex justify-between px-3.5 py-2.5">
                <dt className="text-[var(--ink-muted)]">日期</dt>
                <dd className="font-mono-code font-medium text-[var(--ink-primary)] tabular-nums">
                  {formatUnixTime(createdEvent.starts_at, { dateOnly: true })}
                </dd>
              </div>
              <div className="flex justify-between px-3.5 py-2.5">
                <dt className="text-[var(--ink-muted)]">时间段</dt>
                <dd className="font-mono-code font-semibold text-[var(--ink-primary)] tabular-nums">
                  {formatClockRange(
                    createdEvent.starts_at,
                    createdEvent.ends_at,
                  )}
                </dd>
              </div>
              <div className="flex justify-between px-3.5 py-2.5">
                <dt className="text-[var(--ink-muted)]">组织人</dt>
                <dd className="font-mono-code text-[var(--ink-primary)]">
                  {createdEvent.organizer}
                </dd>
              </div>
              <div className="flex justify-between px-3.5 py-2.5">
                <dt className="text-[var(--ink-muted)]">事件编号 / 版本</dt>
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
                  <span>Zoom 视频会议</span>
                </span>
                <StatusBadge
                  status={
                    zoomResult.mode === "live_mcp" ||
                    zoomResult.mode === "live_api"
                      ? "connected"
                      : "sandbox_ready"
                  }
                  label={zoomResult.status_label}
                  compact
                />
              </div>
              {zoomResult.join_url && (
                <a
                  href={zoomResult.join_url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-mono-code text-[12px] text-[var(--accent)] hover:underline break-all"
                >
                  <span>{zoomResult.join_url}</span>
                  <ExternalLink className="h-3 w-3 shrink-0" />
                </a>
              )}
            </div>
          )}

          {externalSyncResults.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {externalSyncResults.map((res) => (
                <span
                  key={res.connector}
                  title={res.message}
                  className={[
                    "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-medium",
                    res.status === "synced"
                      ? "bg-[var(--status-emerald-wash)] text-[var(--status-emerald)]"
                      : "bg-[var(--bg-surface-subtle)] text-[var(--ink-muted)]",
                  ].join(" ")}
                >
                  <span>{res.label}</span>
                  <span className="opacity-80">
                    {res.status === "synced" ? "已同步" : ".ics 可用"}
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
            <span className="flex items-center gap-1.5 text-[var(--ink-secondary)]">
              <Calendar
                className="h-3.5 w-3.5 text-[var(--accent)]"
                strokeWidth={1.85}
              />
              <span>绑定会话：</span>
              <span className="font-mono-code text-[var(--ink-primary)]">
                {roomId.slice(0, 14)}…
              </span>
            </span>
            <span className="font-mono-code text-[10.5px] text-[var(--ink-muted)]">
              幂等键 {clientIdRef.current}
            </span>
          </div>

          <div>
            <label
              htmlFor="meeting-draft-title"
              className="block text-[12px] font-medium text-[var(--ink-secondary)]"
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
              className="mt-1.5 h-10 w-full rounded-sm bg-[var(--bg-surface-tint)] px-3.5 text-[13.5px] text-[var(--ink-primary)] ring-1 ring-[var(--hairline-strong)] focus:bg-[var(--bg-surface)] focus:ring-[1.5px] focus:ring-[var(--accent)] focus:outline-none transition-all"
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label
                htmlFor="meeting-draft-start"
                className="block text-[12px] font-medium text-[var(--ink-secondary)]"
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
                className="mt-1.5 h-10 w-full rounded-sm bg-[var(--bg-surface-tint)] px-3 font-mono-code text-[12.5px] text-[var(--ink-primary)] ring-1 ring-[var(--hairline-strong)] focus:bg-[var(--bg-surface)] focus:ring-[1.5px] focus:ring-[var(--accent)] focus:outline-none"
              />
            </div>

            <div>
              <label
                htmlFor="meeting-draft-end"
                className="block text-[12px] font-medium text-[var(--ink-secondary)]"
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
                className="mt-1.5 h-10 w-full rounded-sm bg-[var(--bg-surface-tint)] px-3 font-mono-code text-[12.5px] text-[var(--ink-primary)] ring-1 ring-[var(--hairline-strong)] focus:bg-[var(--bg-surface)] focus:ring-[1.5px] focus:ring-[var(--accent)] focus:outline-none"
              />
            </div>
          </div>

          {/* Room Member Attendees */}
          <div>
            <div className="flex items-center justify-between text-[12px] font-medium text-[var(--ink-secondary)]">
              <span className="flex items-center gap-1.5">
                <Users className="h-3.5 w-3.5 text-[var(--ink-muted)]" />
                <span>参会房间成员</span>
              </span>
              <span className="font-mono-code text-[11px] text-[var(--ink-muted)]">
                已选 {selectedAttendees.length} 人
              </span>
            </div>
            <div className="mt-1.5 max-h-[144px] overflow-y-auto divide-y divide-[var(--hairline-subtle)] rounded-tile bg-[var(--bg-surface-tint)]">
              {members.map((subject) => {
                const isSelf = actor?.subject === subject;
                const checked = isSelf || selectedAttendees.includes(subject);
                const prof = memberProfiles[subject];
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
                        className="h-4 w-4 rounded accent-[var(--accent)]"
                      />
                      <Avatar
                        name={prof?.display_name || subject}
                        fallbackText={subject}
                        size="xs"
                      />
                      <span className="truncate font-medium text-[var(--ink-primary)]">
                        {prof?.display_name || subject}
                      </span>
                      <span className="font-mono-code text-[11px] text-[var(--ink-muted)]">
                        {subject}
                      </span>
                    </span>
                    {isSelf && (
                      <span className="rounded-full bg-[var(--accent-wash)] px-2 py-0.5 text-[10.5px] font-medium text-[var(--accent)]">
                        组织人
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
                  className="h-4 w-4 rounded accent-[var(--accent)]"
                />
                <Video className="h-3.5 w-3.5 text-[var(--accent)]" />
                <span>同步生成 Zoom 视频会议链接</span>
              </span>
              <span className="text-[11px] text-[var(--ink-muted)]">
                {zoomConnector?.configured ? "实时连接" : "沙盒预览"}
              </span>
            </label>

            <div className="border-t border-[var(--hairline-subtle)] pt-2.5">
              <div className="text-[11.5px] font-medium text-[var(--ink-muted)] mb-2">
                可选：同步至外部日历 MCP（确认后同时支持 .ics 导出）
              </div>
              <div className="flex flex-wrap gap-1.5">
                {CALENDAR_TARGETS.map((target) => {
                  const active = selectedTargets.includes(target.id);
                  const conn = connectorById.get(target.id);
                  return (
                    <button
                      key={target.id}
                      type="button"
                      onClick={() => toggleExternalTarget(target.id)}
                      className={[
                        "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium transition-all duration-[140ms] cursor-pointer",
                        active
                          ? "bg-[var(--accent-wash-strong)] text-[var(--accent)] ring-1 ring-[var(--accent-border)]"
                          : "bg-[var(--bg-surface)] text-[var(--ink-secondary)] shadow-[var(--shadow-subtle)] hover:text-[var(--ink-primary)]",
                      ].join(" ")}
                    >
                      <span
                        className={[
                          "h-1.5 w-1.5 rounded-full",
                          conn?.configured
                            ? "bg-[var(--status-emerald)]"
                            : "bg-[var(--ink-faint)]",
                        ].join(" ")}
                      />
                      <span>{target.label}</span>
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
