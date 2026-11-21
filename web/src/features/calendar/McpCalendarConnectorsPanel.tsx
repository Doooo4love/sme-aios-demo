"use client";

import React, { useCallback, useEffect, useState } from "react";
import { Popover } from "radix-ui";
import {
  Calendar,
  CheckCircle2,
  Cloud,
  Link2,
  RefreshCw,
  Settings2,
  Video,
} from "lucide-react";
import {
  fetchMcpStatus,
  isApiError,
  isStaleAuthError,
  triggerExternalCalendarSync,
} from "@/lib/api-client";
import { useSession } from "@/lib/session-context";
import { Interactive3DCard } from "@/components/kinetic";
import { Button } from "@/components/ui/Button";
import { StatusBadge } from "@/components/ui/StatusBadge";
import type {
  ExternalCalendarSyncResult,
  ExternalCalendarTarget,
  McpConnectorStatusItem,
} from "@/lib/types";

const EXTERNAL_CONNECTOR_IDS: readonly McpConnectorStatusItem["connector"][] = [
  "google",
  "icloud",
  "outlook",
  "zoom",
];

function isCalendarTarget(
  id: McpConnectorStatusItem["connector"],
): id is ExternalCalendarTarget {
  return id === "google" || id === "icloud" || id === "outlook";
}

function renderSetupPopoverContent(conn: McpConnectorStatusItem) {
  return (
    <Popover.Content
      side="bottom"
      align="end"
      sideOffset={8}
      className="z-50 w-[290px] rounded-card bg-[var(--bg-surface)] p-3.5 shadow-[var(--shadow-popover)] focus:outline-none space-y-2"
    >
      <div className="text-[12.5px] font-semibold text-[var(--ink-primary)]">
        {conn.label} · 服务端连接配置
      </div>
      <p className="text-[11.5px] text-[var(--ink-muted)] leading-relaxed">
        在服务端配置以下环境变量后即可启用实时同步（浏览器不接触密钥）：
      </p>
      {conn.setup_env_keys.length > 0 ? (
        <ul className="space-y-1 rounded-sm bg-[var(--bg-surface-tint)] p-2.5 font-mono-code text-[11px] text-[var(--ink-secondary)]">
          {conn.setup_env_keys.map((key) => (
            <li key={key} className="truncate">
              {key}
            </li>
          ))}
        </ul>
      ) : (
        <div className="rounded-sm bg-[var(--bg-surface-tint)] p-2.5 text-[11.5px] text-[var(--ink-muted)]">
          请参阅服务端连接器配置文档。
        </div>
      )}
    </Popover.Content>
  );
}

export interface McpCalendarConnectorsPanelProps {
  onQuickZoomBook?: () => void;
}

export function McpCalendarConnectorsPanel({
  onQuickZoomBook,
}: McpCalendarConnectorsPanelProps) {
  const { status, authGeneration } = useSession();

  const [connectors, setConnectors] = useState<McpConnectorStatusItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [syncFeedback, setSyncFeedback] = useState<
    Record<string, ExternalCalendarSyncResult>
  >({});

  const loadStatus = useCallback(async () => {
    if (status !== "authenticated") return;
    setLoading(true);
    try {
      const res = await fetchMcpStatus();
      setConnectors(res.connectors);
    } catch (err) {
      if (!isStaleAuthError(err)) {
        setConnectors([]);
      }
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    setSyncFeedback({});
    void loadStatus();
  }, [authGeneration, loadStatus]);

  const handleTriggerSync = async (target: ExternalCalendarTarget) => {
    if (syncingId) return;
    setSyncingId(target);
    try {
      const tz =
        Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
      const res = await triggerExternalCalendarSync({
        calendar_targets: [target],
        timezone: tz,
      });
      const item = res.results.find((r) => r.connector === target);
      if (item) {
        setSyncFeedback((prev) => ({ ...prev, [target]: item }));
      }
    } catch (err) {
      if (isStaleAuthError(err)) return;
      const msg = isApiError(err) ? err.message : "同步请求暂不可用";
      setSyncFeedback((prev) => ({
        ...prev,
        [target]: {
          connector: target,
          label: target,
          status: "error",
          external_event_id: null,
          message: msg,
        },
      }));
    } finally {
      setSyncingId(null);
    }
  };

  const visibleConnectors = EXTERNAL_CONNECTOR_IDS.map((id) => {
    const found = connectors.find((c) => c.connector === id);
    if (found) return found;
    return {
      connector: id,
      connector_id: id,
      label:
        id === "google"
          ? "Google Calendar"
          : id === "icloud"
            ? "Apple iCloud 日历"
            : id === "outlook"
              ? "Outlook / M365 日历"
              : "Zoom 视频会议",
      category: id === "zoom" ? "meeting" : "calendar",
      configured: false,
      status: "sandbox_ready",
      mode: id === "zoom" ? "sandbox_preview" : "ics_fallback",
      protocol: id === "icloud" ? "CalDAV MCP" : "MCP",
      supports_sync: true,
      setup_env_keys: [],
    } satisfies McpConnectorStatusItem;
  });

  return (
    <section
      data-testid="mcp-connectors-strip"
      className="space-y-3"
      aria-label="外部日历与视频会议连接器"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-[14px] font-semibold text-[var(--ink-primary)]">
            外部日历与视频会议连接
          </h3>
          <p className="mt-0.5 text-[12px] text-[var(--ink-muted)]">
            连接后新预约的会议将自动双向同步；未连接时仍可在站内日历导出 .ics 文件。
          </p>
        </div>

        <Button
          size="sm"
          variant="ghost"
          pill
          onClick={() => void loadStatus()}
          disabled={loading}
        >
          <RefreshCw
            className={["h-3.5 w-3.5", loading ? "animate-spin" : ""].join(" ")}
            strokeWidth={1.85}
          />
          <span>刷新状态</span>
        </Button>
      </div>

      {/* 4 Unified Frosted Porcelain Connector Tiles (zero off-palette brand hexes) */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {visibleConnectors.map((conn) => {
          const id = conn.connector;
          const isCal = isCalendarTarget(id);
          const feedback = syncFeedback[id];

          return (
            <Interactive3DCard
              key={id}
              maxTilt={2.5}
              hoverLiftPx={-1}
              sheenIntensity="subtle"
              data-testid={`mcp-connector-${id}`}
              className="flex flex-col justify-between rounded-card bg-[var(--bg-surface)] p-4 shadow-[var(--shadow-card)] hover:shadow-[var(--shadow-card-hover)]"
            >
              <div>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span
                      className={[
                        "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
                        conn.configured
                          ? "bg-[var(--accent-wash)] text-[var(--accent)]"
                          : "bg-[var(--bg-surface-subtle)] text-[var(--ink-secondary)]",
                      ].join(" ")}
                    >
                      {id === "zoom" ? (
                        <Video className="h-4 w-4" strokeWidth={1.85} />
                      ) : id === "icloud" ? (
                        <Cloud className="h-4 w-4" strokeWidth={1.85} />
                      ) : (
                        <Calendar className="h-4 w-4" strokeWidth={1.85} />
                      )}
                    </span>
                    <div className="min-w-0">
                      <div className="truncate text-[13.5px] font-semibold text-[var(--ink-primary)]">
                        {conn.label}
                      </div>
                      <div
                        title={conn.protocol}
                        className="truncate text-[11.5px] text-[var(--ink-muted)]"
                      >
                        {conn.configured ? "已连接 · 实时同步" : "未连接"}
                      </div>
                    </div>
                  </div>

                  {/* Setup Env-Var Popover */}
                  <Popover.Root>
                    <Popover.Trigger asChild>
                      <button
                        type="button"
                        aria-label={`查看 ${conn.label} 服务端接入配置`}
                        title="查看服务端接入变量"
                        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--ink-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--ink-primary)] transition-colors cursor-pointer"
                      >
                        <Settings2 className="h-3.5 w-3.5" strokeWidth={1.85} />
                      </button>
                    </Popover.Trigger>
                    <Popover.Portal>
                      {renderSetupPopoverContent(conn)}
                    </Popover.Portal>
                  </Popover.Root>
                </div>

                <div className="mt-3">
                  <StatusBadge
                    status={conn.configured ? "connected" : "sandbox_ready"}
                    label={conn.configured ? "已连接" : "待配置 MCP"}
                    compact
                  />
                </div>

                {feedback && (
                  <div
                    className={[
                      "mt-2.5 rounded-sm px-2.5 py-1.5 text-[11.5px] leading-snug",
                      feedback.status === "synced"
                        ? "bg-[var(--status-emerald-wash)] text-[var(--status-emerald)]"
                        : "bg-[var(--bg-surface-tint)] text-[var(--ink-secondary)]",
                    ].join(" ")}
                  >
                    {feedback.status === "synced" && (
                      <CheckCircle2 className="mr-1 inline h-3 w-3" />
                    )}
                    <span>{feedback.message}</span>
                  </div>
                )}
              </div>

              {/* Footer Action: "触发同步" ONLY when configured; "连接" popover when unconfigured */}
              <div className="mt-3.5 pt-2.5 border-t border-[var(--hairline-subtle)]">
                {isCal ? (
                  conn.configured ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      pill
                      loading={syncingId === id}
                      disabled={syncingId !== null}
                      onClick={() => void handleTriggerSync(id)}
                      className="w-full"
                    >
                      <RefreshCw
                        className={[
                          "h-3 w-3",
                          syncingId === id ? "animate-spin" : "",
                        ].join(" ")}
                      />
                      <span>{syncingId === id ? "同步中…" : "触发同步"}</span>
                    </Button>
                  ) : (
                    <Popover.Root>
                      <Popover.Trigger asChild>
                        <Button
                          size="sm"
                          variant="secondary"
                          pill
                          className="w-full"
                        >
                          <Link2 className="h-3.5 w-3.5 text-[var(--ink-secondary)]" />
                          <span>连接</span>
                        </Button>
                      </Popover.Trigger>
                      <Popover.Portal>
                        {renderSetupPopoverContent(conn)}
                      </Popover.Portal>
                    </Popover.Root>
                  )
                ) : conn.configured ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    pill
                    onClick={onQuickZoomBook}
                    className="w-full"
                  >
                    <Video className="h-3.5 w-3.5 text-[var(--accent)]" />
                    <span>预约 Zoom 会议</span>
                  </Button>
                ) : (
                  <Popover.Root>
                    <Popover.Trigger asChild>
                      <Button
                        size="sm"
                        variant="secondary"
                        pill
                        className="w-full"
                      >
                        <Link2 className="h-3.5 w-3.5 text-[var(--ink-secondary)]" />
                        <span>连接</span>
                      </Button>
                    </Popover.Trigger>
                    <Popover.Portal>
                      {renderSetupPopoverContent(conn)}
                    </Popover.Portal>
                  </Popover.Root>
                )}
              </div>
            </Interactive3DCard>
          );
        })}
      </div>
    </section>
  );
}
