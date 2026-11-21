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
import {
  CALENDAR_CONNECTOR_LABELS_I18N,
  localizeMcpSyncMessage,
  useLocale,
} from "@/lib/i18n";
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

export interface McpCalendarConnectorsPanelProps {
  onQuickZoomBook?: () => void;
}

export function McpCalendarConnectorsPanel({
  onQuickZoomBook,
}: McpCalendarConnectorsPanelProps) {
  const { status, authGeneration } = useSession();
  const { locale, tx, localizeError } = useLocale();

  const [connectors, setConnectors] = useState<McpConnectorStatusItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [syncFeedback, setSyncFeedback] = useState<
    Record<
      string,
      { result: ExternalCalendarSyncResult; overrideMessage?: string }
    >
  >({});

  const connectorLabel = useCallback(
    (id: McpConnectorStatusItem["connector"]) =>
      CALENDAR_CONNECTOR_LABELS_I18N[id]?.[locale] ?? id,
    [locale],
  );

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
        setSyncFeedback((prev) => ({ ...prev, [target]: { result: item } }));
      }
    } catch (err) {
      if (isStaleAuthError(err)) return;
      const msg = isApiError(err)
        ? localizeError(err)
        : tx({
            "zh-CN": "同步请求暂不可用",
            "zh-HK": "同步請求暫時無法使用",
            en: "Sync request temporarily unavailable",
          });
      setSyncFeedback((prev) => ({
        ...prev,
        [target]: {
          result: {
            connector: target,
            label: connectorLabel(target),
            status: "error",
            external_event_id: null,
            message: msg,
          },
          overrideMessage: msg,
        },
      }));
    } finally {
      setSyncingId(null);
    }
  };

  const renderSetupPopoverContent = (
    conn: McpConnectorStatusItem,
    displayLabel: string,
  ) => (
    <Popover.Content
      side="bottom"
      align="end"
      sideOffset={8}
      className="z-50 w-[290px] rounded-card bg-[var(--bg-surface)] p-3.5 shadow-[var(--shadow-popover)] focus:outline-none space-y-2"
    >
      <div className="text-[12.5px] font-semibold text-[var(--ink-primary)]">
        {tx(
          {
            "zh-CN": "{label} · 服务端连接配置",
            "zh-HK": "{label} · 伺服器端連線設定",
            en: "{label} · Server Setup",
          },
          { label: displayLabel },
        )}
      </div>
      <p className="text-[11.5px] text-[var(--ink-muted)] leading-relaxed">
        {tx({
          "zh-CN": "在服务端配置以下环境变量后即可启用实时同步（浏览器不接触密钥）：",
          "zh-HK": "於伺服器端設定以下環境變數即可啟用即時同步（瀏覽器不會接觸金鑰）：",
          en: "Configure these server-side environment variables to enable live sync (credentials never reach the browser):",
        })}
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
          {tx({
            "zh-CN": "请参阅服务端连接器配置文档。",
            "zh-HK": "請參閱伺服器端連接器設定文件。",
            en: "Refer to the server-side connector configuration guide.",
          })}
        </div>
      )}
    </Popover.Content>
  );

  const visibleConnectors = EXTERNAL_CONNECTOR_IDS.map((id) => {
    const found = connectors.find((c) => c.connector === id);
    if (found) return found;
    return {
      connector: id,
      connector_id: id,
      label: connectorLabel(id),
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
      className="rounded-card bg-[var(--bg-surface)] p-5 shadow-[var(--shadow-card)] space-y-4"
      aria-label={tx({
        "zh-CN": "外部日历与视频会议连接器",
        "zh-HK": "外部日曆與視像會議連接器",
        en: "External calendar and video meeting connectors",
      })}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-[14px] font-semibold text-[var(--ink-primary)]">
            {tx({
              "zh-CN": "外部日历与视频会议连接",
              "zh-HK": "外部日曆與視像會議連線",
              en: "External Calendar & Video Connectors",
            })}
          </h3>
          <p className="mt-0.5 text-[12px] text-[var(--ink-muted)]">
            {tx({
              "zh-CN": "连接后新预约的会议将自动双向同步；未连接时仍可在站内日历导出 .ics 文件。",
              "zh-HK": "連線後新預約的會議將自動雙向同步；未連線時仍可於站內日曆匯出 .ics 檔案。",
              en: "New meetings sync automatically once connected; .ics export is always available.",
            })}
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
          <span>
            {tx({
              "zh-CN": "刷新状态",
              "zh-HK": "重新整理狀態",
              en: "Refresh Status",
            })}
          </span>
        </Button>
      </div>

      {/* 4 Unified Connector Tiles inside the Connectors Card — Opus Nit #4 & M-8 */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {visibleConnectors.map((conn) => {
          const id = conn.connector;
          const isCal = isCalendarTarget(id);
          const feedbackEntry = syncFeedback[id];
          const feedback = feedbackEntry?.result;
          const feedbackMessage = feedbackEntry
            ? (feedbackEntry.overrideMessage ??
              localizeMcpSyncMessage(feedbackEntry.result, locale))
            : null;
          const displayLabel = connectorLabel(id);
          const capabilityCaption = isCal
            ? tx({
                "zh-CN": "双向日程同步",
                "zh-HK": "雙向行程同步",
                en: "Two-way sync",
              })
            : tx({
                "zh-CN": "视频会议链接",
                "zh-HK": "視像會議連結",
                en: "Video meeting links",
              });

          return (
            <Interactive3DCard
              key={id}
              maxTilt={2.5}
              hoverLiftPx={-1}
              sheenIntensity="subtle"
              data-testid={`mcp-connector-${id}`}
              className="flex flex-col justify-between rounded-tile bg-[var(--bg-surface-tint)] p-4 ring-1 ring-[var(--hairline)] hover:bg-[var(--bg-surface)] hover:shadow-[var(--shadow-card)] transition-all"
            >
              <div>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span
                      className={[
                        "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
                        conn.configured
                          ? "bg-[var(--accent-wash)] text-[var(--accent-ink)]"
                          : "bg-[var(--bg-surface)] text-[var(--ink-secondary)] shadow-[var(--shadow-subtle)]",
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
                        {displayLabel}
                      </div>
                      <div
                        title={conn.protocol}
                        className="truncate text-[11.5px] text-[var(--ink-muted)]"
                      >
                        {capabilityCaption}
                      </div>
                    </div>
                  </div>

                  {/* Setup Env-Var Popover */}
                  <Popover.Root>
                    <Popover.Trigger asChild>
                      <button
                        type="button"
                        aria-label={tx(
                          {
                            "zh-CN": "查看 {label} 服务端接入配置",
                            "zh-HK": "檢視 {label} 伺服器端接入設定",
                            en: "View {label} server configuration",
                          },
                          { label: displayLabel },
                        )}
                        title={tx({
                          "zh-CN": "查看服务端接入变量",
                          "zh-HK": "檢視伺服器端接入變數",
                          en: "Server environment variables",
                        })}
                        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--ink-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--ink-primary)] transition-colors cursor-pointer"
                      >
                        <Settings2 className="h-3.5 w-3.5" strokeWidth={1.85} />
                      </button>
                    </Popover.Trigger>
                    <Popover.Portal>
                      {renderSetupPopoverContent(conn, displayLabel)}
                    </Popover.Portal>
                  </Popover.Root>
                </div>

                {/* Single unified status badge per connector card (no duplicate "未连接" + "待配置 MCP") */}
                <div className="mt-3">
                  <StatusBadge
                    status={conn.configured ? "connected" : "sandbox_ready"}
                    label={
                      conn.configured
                        ? tx({
                            "zh-CN": "已连接",
                            "zh-HK": "已連線",
                            en: "Connected",
                          })
                        : tx({
                            "zh-CN": "待配置 MCP",
                            "zh-HK": "待設定 MCP",
                            en: "MCP Setup Needed",
                          })
                    }
                    compact
                  />
                </div>

                {feedback && feedbackMessage && (
                  <div
                    className={[
                      "mt-2.5 rounded-sm px-2.5 py-1.5 text-[11.5px] leading-snug",
                      feedback.status === "synced"
                        ? "bg-[var(--status-emerald-wash)] text-[var(--status-emerald)]"
                        : "bg-[var(--bg-surface)] text-[var(--ink-secondary)]",
                    ].join(" ")}
                  >
                    {feedback.status === "synced" && (
                      <CheckCircle2 className="mr-1 inline h-3 w-3" />
                    )}
                    <span>{feedbackMessage}</span>
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
                      <span>
                        {syncingId === id
                          ? tx({
                              "zh-CN": "同步中…",
                              "zh-HK": "同步中…",
                              en: "Syncing…",
                            })
                          : tx({
                              "zh-CN": "触发同步",
                              "zh-HK": "觸發同步",
                              en: "Sync Now",
                            })}
                      </span>
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
                          <span>
                            {tx({
                              "zh-CN": "连接",
                              "zh-HK": "連線",
                              en: "Connect",
                            })}
                          </span>
                        </Button>
                      </Popover.Trigger>
                      <Popover.Portal>
                        {renderSetupPopoverContent(conn, displayLabel)}
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
                    <span>
                      {tx({
                        "zh-CN": "预约 Zoom 会议",
                        "zh-HK": "預約 Zoom 會議",
                        en: "Book Zoom Meeting",
                      })}
                    </span>
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
                        <span>
                          {tx({
                            "zh-CN": "连接",
                            "zh-HK": "連線",
                            en: "Connect",
                          })}
                        </span>
                      </Button>
                    </Popover.Trigger>
                    <Popover.Portal>
                      {renderSetupPopoverContent(conn, displayLabel)}
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
