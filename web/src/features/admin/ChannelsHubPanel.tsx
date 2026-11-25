"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  KeyRound,
  Link2,
  MessageSquareShare,
  Radio,
  RefreshCw,
  Send,
  ShieldCheck,
  UserCheck,
  Webhook,
} from "lucide-react";
import {
  fetchChannelBindings,
  fetchChannelOutbound,
  fetchChannelsCatalog,
  generateClientId,
  isApiError,
  isStaleAuthError,
  sendChannelOutbound,
  upsertChannelBinding,
  type ApiError,
} from "@/lib/api-client";
import { formatShortDigest } from "@/lib/format";
import { useLocale } from "@/lib/i18n";
import { useSession } from "@/lib/session-context";
import { AccessNoticeCard, Button, Modal, StatusBadge } from "@/components/ui";
import type {
  ChannelBindingItem,
  ChannelOutboundReceipt,
  EnterpriseChannelItem,
} from "@/lib/types";

const CHANNEL_ORDER: readonly string[] = [
  "whatsapp",
  "wecom",
  "feishu",
  "dingtalk",
  "slack",
  "teams",
  "telegram",
  "line",
];

function getChannelDisplayName(
  ch: EnterpriseChannelItem,
  locale: "zh-CN" | "zh-HK" | "en",
): string {
  if (locale === "en") return ch.name;
  if (locale === "zh-HK") return ch.name_hk || ch.name;
  return ch.name_zh || ch.name;
}

export function ChannelsHubPanel() {
  const { actor, canAccessAdminOps, authGeneration, handleAccessChanged } =
    useSession();
  const { locale, t, tx, formatDateTime, localizeError } = useLocale();

  const [catalog, setCatalog] = useState<EnterpriseChannelItem[]>([]);
  const [bindings, setBindings] = useState<ChannelBindingItem[]>([]);
  const [outboundLog, setOutboundLog] = useState<ChannelOutboundReceipt[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [copiedWebhookId, setCopiedWebhookId] = useState<string | null>(null);

  // Employee Handle Binding Modal state
  const [bindModalChannel, setBindModalChannel] =
    useState<EnterpriseChannelItem | null>(null);
  const [bindSubject, setBindSubject] = useState("");
  const [bindExternalUserId, setBindExternalUserId] = useState("");
  const [bindDisplayHandle, setBindDisplayHandle] = useState("");
  const [bindSaving, setBindSaving] = useState(false);
  const [bindError, setBindError] = useState<string | null>(null);
  const [bindFeedback, setBindFeedback] = useState<string | null>(null);

  // Governed Channel Relay Test state
  const [relayChannelId, setRelayChannelId] = useState<string>("whatsapp");
  const [relayTargetHandle, setRelayTargetHandle] = useState<string>("");
  const [relayText, setRelayText] = useState<string>("");
  const [relaySending, setRelaySending] = useState(false);
  const [relayError, setRelayError] = useState<ApiError | null>(null);
  const [relayValidationError, setRelayValidationError] = useState<
    string | null
  >(null);
  const [relayReceipt, setRelayReceipt] =
    useState<ChannelOutboundReceipt | null>(null);
  const [logChannelFilter, setLogChannelFilter] = useState<string>("ALL");

  const relaySectionRef = useRef<HTMLElement | null>(null);
  const channelScope: "tenant" | "mine" =
    actor?.role === "admin" && Boolean(actor?.grants.includes("operations.manage"))
      ? "tenant"
      : "mine";

  const loadAll = useCallback(
    async (signal?: AbortSignal) => {
      if (!canAccessAdminOps) return;
      setLoading(true);
      setLoadError(null);
      try {
        const [catRes, bindRes, outRes] = await Promise.all([
          fetchChannelsCatalog(signal),
          fetchChannelBindings({ scope: channelScope }, signal),
          fetchChannelOutbound({ limit: 30, scope: channelScope }, signal),
        ]);
        if (signal?.aborted) return;
        const sortedCatalog = [...(catRes.items ?? [])].sort((a, b) => {
          const ia = CHANNEL_ORDER.indexOf(a.channel_id);
          const ib = CHANNEL_ORDER.indexOf(b.channel_id);
          return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
        });
        setCatalog(sortedCatalog);
        setBindings(bindRes.items ?? []);
        setOutboundLog(outRes.items ?? []);
        if (sortedCatalog.length > 0) {
          setRelayChannelId((prev) =>
            sortedCatalog.some((c) => c.channel_id === prev)
              ? prev
              : sortedCatalog[0]!.channel_id,
          );
        }
      } catch (err) {
        if (isStaleAuthError(err)) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (isApiError(err)) {
          if (err.code === "ACCESS_CHANGED") {
            void handleAccessChanged();
          }
          setLoadError(err);
        }
      } finally {
        setLoading(false);
      }
    },
    [canAccessAdminOps, channelScope, handleAccessChanged],
  );

  useEffect(() => {
    setCatalog([]);
    setBindings([]);
    setOutboundLog([]);
    setLoadError(null);
    setBindModalChannel(null);
    setBindFeedback(null);
    setRelayError(null);
    setRelayValidationError(null);
    setRelayReceipt(null);
    setLogChannelFilter("ALL");
    if (!canAccessAdminOps) return;

    const controller = new AbortController();
    void loadAll(controller.signal);
    return () => {
      controller.abort();
    };
  }, [authGeneration, canAccessAdminOps, loadAll]);

  const bindingsByChannel = useMemo(() => {
    const map = new Map<string, ChannelBindingItem[]>();
    for (const b of bindings) {
      const list = map.get(b.channel_id) ?? [];
      list.push(b);
      map.set(b.channel_id, list);
    }
    return map;
  }, [bindings]);

  const connectedCount = useMemo(
    () =>
      catalog.filter(
        (c) =>
          c.configured ||
          c.transport_mode === "connected_mcp" ||
          c.transport_mode === "connected_api",
      ).length,
    [catalog],
  );

  const filteredOutboundLog = useMemo(() => {
    if (logChannelFilter === "ALL") return outboundLog;
    return outboundLog.filter((item) => item.channel_id === logChannelFilter);
  }, [outboundLog, logChannelFilter]);

  const handleCopyWebhook = async (channelId: string, path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      setCopiedWebhookId(channelId);
      window.setTimeout(() => setCopiedWebhookId(null), 1600);
    } catch {
      // ignore clipboard errors
    }
  };

  const openBindModal = (ch: EnterpriseChannelItem) => {
    const existingSelf = bindings.find(
      (b) => b.channel_id === ch.channel_id && b.subject === actor?.subject,
    );
    const existingAny =
      existingSelf ?? bindings.find((b) => b.channel_id === ch.channel_id);
    setBindModalChannel(ch);
    setBindSubject(existingAny?.subject ?? actor?.subject ?? "");
    setBindExternalUserId(existingAny?.external_user_id ?? "");
    setBindDisplayHandle(existingAny?.display_handle ?? "");
    setBindError(null);
  };

  const handleSaveBinding = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bindModalChannel || bindSaving) return;
    const extId = bindExternalUserId.trim();
    const handle = bindDisplayHandle.trim();
    const targetSub = bindSubject.trim();

    if (!extId || !handle) {
      setBindError(
        tx({
          "zh-CN": "请填写外部平台用户 ID 与显示账号名。",
          "zh-HK": "請填寫外部平台用戶 ID 與顯示帳號名。",
          en: "Please enter both external user ID and display handle.",
        }),
      );
      return;
    }

    setBindSaving(true);
    setBindError(null);
    try {
      const saved = await upsertChannelBinding(bindModalChannel.channel_id, {
        external_user_id: extId,
        display_handle: handle,
        subject: targetSub || undefined,
        verified: true,
      });
      setBindings((prev) => {
        const filtered = prev.filter(
          (item) =>
            !(
              item.channel_id === saved.channel_id &&
              item.subject === saved.subject
            ),
        );
        return [saved, ...filtered];
      });
      setBindModalChannel(null);
      setBindFeedback(
        tx(
          {
            "zh-CN": "已绑定 {channel} 员工标识 {handle}（主体 {subject}）。",
            "zh-HK": "已綁定 {channel} 員工識別碼 {handle}（主體 {subject}）。",
            en: "Bound {channel} handle {handle} for {subject}.",
          },
          {
            channel: getChannelDisplayName(bindModalChannel, locale),
            handle: saved.display_handle,
            subject: saved.subject,
          },
        ),
      );
    } catch (err) {
      if (isStaleAuthError(err)) return;
      if (isApiError(err)) {
        if (err.code === "ACCESS_CHANGED") {
          void handleAccessChanged();
        }
        setBindError(localizeError(err));
      } else {
        setBindError(
          tx({
            "zh-CN": "保存通道绑定失败，请稍后重试。",
            "zh-HK": "儲存通道綁定失敗，請稍後重試。",
            en: "Failed to save channel binding. Please try again.",
          }),
        );
      }
    } finally {
      setBindSaving(false);
    }
  };

  const handleSelectRelayChannel = (ch: EnterpriseChannelItem) => {
    setRelayChannelId(ch.channel_id);
    setRelayError(null);
    setRelayValidationError(null);
    const channelBindings = bindingsByChannel.get(ch.channel_id) ?? [];
    if (channelBindings.length > 0 && !relayTargetHandle.trim()) {
      setRelayTargetHandle(channelBindings[0]!.display_handle);
    }
    relaySectionRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
    });
  };

  const handleSendRelay = async (e: React.FormEvent) => {
    e.preventDefault();
    if (relaySending) return;
    const targetHandle = relayTargetHandle.trim();
    const messageText = relayText.trim();

    if (!targetHandle) {
      setRelayValidationError(
        tx({
          "zh-CN": "请输入目标外部联系人或群组句柄。",
          "zh-HK": "請輸入目標外部聯絡人或群組句柄。",
          en: "Please enter a target external handle or room identifier.",
        }),
      );
      return;
    }
    if (!messageText) {
      setRelayValidationError(
        tx({
          "zh-CN": "请输入要发送的消息内容。",
          "zh-HK": "請輸入要傳送的訊息內容。",
          en: "Please enter a message body to relay.",
        }),
      );
      return;
    }

    setRelaySending(true);
    setRelayError(null);
    setRelayValidationError(null);
    setRelayReceipt(null);
    try {
      const receipt = await sendChannelOutbound({
        channel_id: relayChannelId,
        target_handle: targetHandle,
        text: messageText,
        client_id: generateClientId("ch"),
      });
      setRelayReceipt(receipt);
      setRelayText("");
      setOutboundLog((prev) => [
        receipt,
        ...prev.filter((item) => item.id !== receipt.id),
      ]);
    } catch (err) {
      if (isStaleAuthError(err)) return;
      if (isApiError(err)) {
        if (err.code === "ACCESS_CHANGED") {
          void handleAccessChanged();
        }
        setRelayError(err);
      } else {
        setRelayValidationError(
          tx({
            "zh-CN": "消息通道外发失败，请稍后重试。",
            "zh-HK": "訊息通道外發失敗，請稍後重試。",
            en: "Channel outbound relay failed. Please try again.",
          }),
        );
      }
    } finally {
      setRelaySending(false);
    }
  };

  const renderTransportBadge = (ch: EnterpriseChannelItem) => {
    if (ch.transport_mode === "connected_mcp") {
      return (
        <StatusBadge
          status="connected"
          label={tx({
            "zh-CN": "MCP 已连接",
            "zh-HK": "MCP 已連線",
            en: "Connected (MCP)",
          })}
          compact
        />
      );
    }
    if (ch.transport_mode === "connected_api") {
      return (
        <StatusBadge
          status="connected"
          label={tx({
            "zh-CN": "API 已连接",
            "zh-HK": "API 已連線",
            en: "Connected (API)",
          })}
          compact
        />
      );
    }
    return (
      <StatusBadge
        status="sandbox_ready"
        label={tx({
          "zh-CN": "就绪 · 可绑定",
          "zh-HK": "就緒 · 可綁定",
          en: "Ready to Bind",
        })}
        compact
      />
    );
  };

  return (
    <div className="space-y-5" data-testid="channels-hub-panel">
      {loadError && (
        <AccessNoticeCard
          error={loadError}
          onRetry={() => void loadAll()}
        />
      )}

      {/* Top Hub Overview Card */}
      <section className="rounded-card border border-[var(--hairline)] bg-[var(--bg-surface)] shadow-[var(--shadow-card)] p-5 sm:p-6 space-y-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3.5 min-w-0">
            <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-sm border border-[var(--accent-border)] bg-[var(--accent-wash)] text-[var(--accent-ink)]">
              <MessageSquareShare className="h-5 w-5" strokeWidth={1.9} />
            </span>
            <div className="min-w-0">
              <h2 className="aios-display text-[16.5px] font-semibold text-[var(--ink-primary)]">
                {tx({
                  "zh-CN": "企业消息通道集成中心（8 大主流平台）",
                  "zh-HK": "企業訊息通道整合中心（8 大主流平台）",
                  en: "Enterprise Messaging Channels Hub (8 Integrations)",
                })}
              </h2>
              <p className="mt-1 text-[13px] leading-relaxed text-[var(--ink-secondary)]">
                {tx({
                  "zh-CN":
                    "统一接入 WhatsApp Business、企业微信、飞书 / Lark、钉钉、Slack、Microsoft Teams、Telegram 与 LINE，强制执行 Webhook 验签防重放、租户员工身份绑定与受控外发审计存证。",
                  "zh-HK":
                    "統一接入 WhatsApp Business、企業微信、飛書 / Lark、釘釘、Slack、Microsoft Teams、Telegram 與 LINE，強制執行 Webhook 驗簽防重放、租戶員工身份綁定與受控外發稽核存證。",
                  en: "Unified integration for WhatsApp Business, WeCom, Feishu / Lark, DingTalk, Slack, Microsoft Teams, Telegram, and LINE with fail-closed webhook signatures, identity binding, and audited outbound relay.",
                })}
              </p>
            </div>
          </div>

          <Button
            size="sm"
            variant="secondary"
            loading={loading}
            data-testid="channels-refresh-btn"
            onClick={() => void loadAll()}
            className="shrink-0"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>
              {tx({ "zh-CN": "刷新状态", "zh-HK": "重新整理", en: "Refresh" })}
            </span>
          </Button>
        </div>

        {/* 4 Summary Metrics */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-tile border border-[var(--hairline)] bg-[var(--bg-surface-tint)] px-3.5 py-2.5">
            <div className="aios-micro-label">
              {tx({
                "zh-CN": "支持通道数",
                "zh-HK": "支援通道數",
                en: "Supported Channels",
              })}
            </div>
            <div className="aios-kpi mt-1 text-[20px] font-semibold text-[var(--ink-primary)]">
              {catalog.length || 8}
            </div>
          </div>

          <div className="rounded-tile border border-[var(--hairline)] bg-[var(--bg-surface-tint)] px-3.5 py-2.5">
            <div className="aios-micro-label">
              {tx({
                "zh-CN": "实时直连 / MCP",
                "zh-HK": "即時直連 / MCP",
                en: "Live Connected",
              })}
            </div>
            <div className="aios-kpi mt-1 text-[20px] font-semibold text-[var(--status-emerald)]">
              {connectedCount}
            </div>
          </div>

          <div className="rounded-tile border border-[var(--hairline)] bg-[var(--bg-surface-tint)] px-3.5 py-2.5">
            <div className="aios-micro-label">
              {tx({
                "zh-CN": "已绑定员工账号",
                "zh-HK": "已綁定員工帳號",
                en: "Bound Handles",
              })}
            </div>
            <div className="aios-kpi mt-1 text-[20px] font-semibold text-[var(--accent)]">
              {bindings.length}
            </div>
          </div>

          <div className="rounded-tile border border-[var(--hairline)] bg-[var(--bg-surface-tint)] px-3.5 py-2.5">
            <div className="aios-micro-label">
              {tx({
                "zh-CN": "外发审计留痕",
                "zh-HK": "外發稽核留痕",
                en: "Audited Relays",
              })}
            </div>
            <div className="aios-kpi mt-1 text-[20px] font-semibold text-[var(--ink-primary)]">
              {outboundLog.length}
            </div>
          </div>
        </div>

        {bindFeedback && (
          <div
            role="status"
            data-testid="channel-binding-feedback"
            className="flex items-center gap-2 rounded-tile border border-[var(--status-emerald-border)] bg-[var(--status-emerald-wash)] px-3.5 py-2.5 text-[12.5px] text-[var(--status-emerald)]"
          >
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            <span>{bindFeedback}</span>
          </div>
        )}
      </section>

      {/* 8-Channel Integration Cards Grid */}
      <section className="space-y-2.5">
        <div className="flex items-center justify-between px-1">
          <h3 className="aios-micro-label">
            {tx({
              "zh-CN": "全通道接入矩阵与回调验签策略",
              "zh-HK": "全通道接入矩陣與回呼驗簽策略",
              en: "Channel Integration Matrix & Signature Schemes",
            })}
          </h3>
          <span className="font-mono-code text-[11px] text-[var(--ink-muted)] tabular-nums">
            {catalog.length} / 8
          </span>
        </div>

        {loading && catalog.length === 0 ? (
          <div className="rounded-card border border-[var(--hairline)] bg-[var(--bg-surface)] p-10 text-center text-[13px] text-[var(--ink-muted)] shadow-[var(--shadow-card)]">
            {tx({
              "zh-CN": "正在加载企业消息通道目录…",
              "zh-HK": "正在載入企業訊息通道目錄…",
              en: "Loading enterprise channels catalog…",
            })}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {catalog.map((ch) => {
              const chBindings = bindingsByChannel.get(ch.channel_id) ?? [];
              const displayName = getChannelDisplayName(ch, locale);
              return (
                <article
                  key={ch.channel_id}
                  data-testid={`channel-card-${ch.channel_id}`}
                  className="flex flex-col justify-between rounded-card border border-[var(--hairline)] bg-[var(--bg-surface)] p-4 sm:p-5 shadow-[var(--shadow-card)] space-y-3.5"
                >
                  <div className="space-y-3">
                    {/* Card Header */}
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h4 className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--ink-primary)]">
                            {displayName}
                          </h4>
                          <span className="rounded-xs border border-[var(--hairline)] bg-[var(--bg-surface-tint)] px-2 py-0.5 font-mono-code text-[10.5px] text-[var(--ink-secondary)]">
                            {ch.channel_id}
                          </span>
                          <span className="rounded-xs border border-[var(--hairline)] bg-[var(--bg-surface-subtle)] px-1.5 py-0.5 text-[10.5px] font-medium text-[var(--ink-muted)]">
                            {ch.region}
                          </span>
                        </div>
                        <p className="mt-0.5 text-[11.5px] text-[var(--ink-muted)]">
                          {ch.protocol}
                        </p>
                      </div>

                      <div className="shrink-0">{renderTransportBadge(ch)}</div>
                    </div>

                    {/* Signature & Webhook */}
                    <dl className="divide-y divide-[var(--hairline-subtle)] rounded-tile border border-[var(--hairline)] bg-[var(--bg-surface-tint)] text-[11.5px]">
                      <div className="flex items-center justify-between gap-2 px-3 py-2">
                        <dt className="flex items-center gap-1.5 text-[var(--ink-muted)] shrink-0">
                          <ShieldCheck className="h-3.5 w-3.5 text-[var(--status-emerald)]" />
                          <span>
                            {tx({
                              "zh-CN": "回调验签",
                              "zh-HK": "回呼驗簽",
                              en: "Signature",
                            })}
                          </span>
                        </dt>
                        <dd
                          title={ch.signature_scheme}
                          className="min-w-0 truncate text-right font-mono-code text-[var(--ink-primary)]"
                        >
                          {ch.signature_scheme}
                        </dd>
                      </div>

                      <div className="flex items-center justify-between gap-2 px-3 py-2">
                        <dt className="flex items-center gap-1.5 text-[var(--ink-muted)] shrink-0">
                          <Webhook className="h-3.5 w-3.5 text-[var(--accent)]" />
                          <span>Webhook</span>
                        </dt>
                        <dd className="flex items-center gap-1.5 min-w-0">
                          <code
                            title={ch.webhook_path}
                            className="min-w-0 truncate font-mono-code text-[var(--ink-secondary)]"
                          >
                            {ch.webhook_path}
                          </code>
                          <button
                            type="button"
                            onClick={() =>
                              void handleCopyWebhook(
                                ch.channel_id,
                                ch.webhook_path,
                              )
                            }
                            aria-label={t("common.copy")}
                            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-xs text-[var(--ink-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--ink-primary)] cursor-pointer"
                          >
                            {copiedWebhookId === ch.channel_id ? (
                              <Check className="h-3 w-3 text-[var(--status-emerald)]" />
                            ) : (
                              <Copy className="h-3 w-3" />
                            )}
                          </button>
                        </dd>
                      </div>
                    </dl>

                    {/* Capabilities & Setup Env Keys */}
                    {ch.capabilities.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {ch.capabilities.map((cap) => (
                          <span
                            key={cap}
                            className="rounded-xs border border-[var(--hairline)] bg-[var(--bg-surface-subtle)] px-2 py-0.5 font-mono-code text-[10.5px] text-[var(--ink-secondary)]"
                          >
                            {cap}
                          </span>
                        ))}
                      </div>
                    )}

                    {ch.setup_env_keys.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--ink-muted)]">
                        <KeyRound className="h-3 w-3 shrink-0" />
                        <span>
                          {tx({
                            "zh-CN": "凭据变量：",
                            "zh-HK": "憑證變數：",
                            en: "Env keys:",
                          })}
                        </span>
                        {ch.setup_env_keys.map((keyName) => (
                          <code
                            key={keyName}
                            className="rounded-xs bg-[var(--bg-surface-tint)] px-1.5 py-0.5 font-mono-code text-[10px] text-[var(--ink-secondary)]"
                          >
                            {keyName}
                          </code>
                        ))}
                      </div>
                    )}

                    {/* Current Employee Bindings */}
                    {chBindings.length > 0 && (
                      <div className="rounded-tile border border-[var(--accent-border)] bg-[var(--accent-wash)] px-3 py-2 text-[11.5px] space-y-1">
                        <div className="flex items-center gap-1.5 font-medium text-[var(--accent-ink)]">
                          <UserCheck className="h-3.5 w-3.5" />
                          <span>
                            {tx(
                              {
                                "zh-CN": "已绑定 {count} 位员工身份",
                                "zh-HK": "已綁定 {count} 位員工身份",
                                en: "{count} bound employee handle(s)",
                              },
                              { count: chBindings.length },
                            )}
                          </span>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {chBindings.map((b) => (
                            <span
                              key={`${b.channel_id}-${b.subject}`}
                              className="inline-flex items-center gap-1 rounded-xs border border-[var(--accent-border)] bg-[var(--bg-surface)] px-2 py-0.5 text-[11px] text-[var(--ink-primary)]"
                            >
                              <span className="font-mono-code font-medium">
                                {b.subject}
                              </span>
                              <span className="text-[var(--ink-muted)]">→</span>
                              <span>{b.display_handle}</span>
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Card Footer Actions */}
                  <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--hairline-subtle)] pt-3">
                    <Button
                      size="sm"
                      variant="secondary"
                      data-testid={`channel-bind-btn-${ch.channel_id}`}
                      onClick={() => openBindModal(ch)}
                    >
                      <Link2 className="h-3.5 w-3.5 text-[var(--accent)]" />
                      <span>
                        {tx({
                          "zh-CN": "绑定员工身份",
                          "zh-HK": "綁定員工身份",
                          en: "Bind Handle",
                        })}
                      </span>
                    </Button>
                    <Button
                      size="sm"
                      variant="quiet"
                      data-testid={`channel-relay-btn-${ch.channel_id}`}
                      onClick={() => handleSelectRelayChannel(ch)}
                    >
                      <Radio className="h-3.5 w-3.5 text-[var(--accent)]" />
                      <span>
                        {tx({
                          "zh-CN": "受控外发测试",
                          "zh-HK": "受控外發測試",
                          en: "Test Relay",
                        })}
                      </span>
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {/* Governed Channel Relay Tester & Outbound Audit Log */}
      <section
        ref={relaySectionRef}
        data-testid="channel-relay-section"
        className="grid grid-cols-1 gap-5 lg:grid-cols-12"
      >
        {/* Relay Test Form */}
        <div className="rounded-card border border-[var(--hairline)] bg-[var(--bg-surface)] shadow-[var(--shadow-card)] p-5 sm:p-6 lg:col-span-5 space-y-4">
          <div className="flex items-start gap-3 border-b border-[var(--hairline)] pb-3.5">
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-sm border border-[var(--accent-border)] bg-[var(--accent-wash)] text-[var(--accent-ink)]">
              <Send className="h-4 w-4" strokeWidth={1.9} />
            </span>
            <div>
              <h3 className="aios-display text-[15.5px] font-semibold text-[var(--ink-primary)]">
                {tx({
                  "zh-CN": "受控通道外发验证",
                  "zh-HK": "受控通道外發驗證",
                  en: "Governed Channel Relay",
                })}
              </h3>
              <p className="mt-0.5 text-[12px] text-[var(--ink-secondary)]">
                {tx({
                  "zh-CN":
                    "通过安全脱敏校验并按 MCP → 官方 Webhook → 受控中继队列优先级外发，生成幂等审计存证。",
                  "zh-HK":
                    "通過安全脫敏校驗並按 MCP → 官方 Webhook → 受控中繼佇列優先順序外發，產生冪等稽核存證。",
                  en: "Scrubs secrets and relays via MCP → Official Webhook → Governed Relay with idempotent audit receipts.",
                })}
              </p>
            </div>
          </div>

          <form onSubmit={(e) => void handleSendRelay(e)} className="space-y-3.5">
            <div>
              <label
                htmlFor="relay-channel-select"
                className="aios-micro-label block"
              >
                {tx({
                  "zh-CN": "目标消息通道 (channel_id)",
                  "zh-HK": "目標訊息通道 (channel_id)",
                  en: "Target Channel (channel_id)",
                })}
              </label>
              <div className="relative mt-1.5">
                <select
                  id="relay-channel-select"
                  data-testid="channel-relay-select"
                  value={relayChannelId}
                  onChange={(e) => {
                    setRelayChannelId(e.target.value);
                    setRelayValidationError(null);
                    setRelayError(null);
                  }}
                  className="aios-select w-full text-[13px]"
                >
                  {catalog.map((ch) => (
                    <option key={ch.channel_id} value={ch.channel_id}>
                      {getChannelDisplayName(ch, locale)} ({ch.channel_id})
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

            <div>
              <label
                htmlFor="relay-target-handle"
                className="aios-micro-label block"
              >
                {tx({
                  "zh-CN": "接收人 / 群组句柄",
                  "zh-HK": "接收人 / 群組句柄",
                  en: "Target Handle / Recipient",
                })}
              </label>
              <input
                id="relay-target-handle"
                type="text"
                maxLength={160}
                value={relayTargetHandle}
                onChange={(e) => {
                  setRelayTargetHandle(e.target.value);
                  setRelayValidationError(null);
                }}
                data-testid="channel-relay-target-input"
                placeholder={tx({
                  "zh-CN": "例如 @lin.mingzhe 或 +85291234567",
                  "zh-HK": "例如 @lin.mingzhe 或 +85291234567",
                  en: "e.g. @lin.mingzhe or +85291234567",
                })}
                className="mt-1.5 h-9 w-full rounded-sm border border-[var(--hairline-strong)] bg-[var(--bg-surface-tint)] px-3 font-mono-code text-[12.5px] text-[var(--ink-primary)] placeholder:font-sans placeholder:text-[var(--ink-faint)] focus:border-[var(--accent)] focus:bg-[var(--bg-surface)] focus:ring-2 focus:ring-[var(--accent-ring)] focus:outline-none"
              />
            </div>

            <div>
              <label
                htmlFor="relay-message-text"
                className="aios-micro-label block"
              >
                {tx({
                  "zh-CN": "消息正文",
                  "zh-HK": "訊息正文",
                  en: "Message Content",
                })}
              </label>
              <textarea
                id="relay-message-text"
                rows={3}
                maxLength={2000}
                value={relayText}
                onChange={(e) => {
                  setRelayText(e.target.value);
                  setRelayValidationError(null);
                }}
                data-testid="channel-relay-text-input"
                placeholder={tx({
                  "zh-CN": "例如：HK01 运单 SHP-1001 改期提案已获主管批准。",
                  "zh-HK": "例如：HK01 運單 SHP-1001 改期提案已獲主管批准。",
                  en: "e.g. HK01 shipment SHP-1001 reschedule approved.",
                })}
                className="mt-1.5 w-full rounded-sm border border-[var(--hairline-strong)] bg-[var(--bg-surface-tint)] p-3 text-[13px] leading-relaxed text-[var(--ink-primary)] placeholder:text-[var(--ink-faint)] focus:border-[var(--accent)] focus:bg-[var(--bg-surface)] focus:ring-2 focus:ring-[var(--accent-ring)] focus:outline-none"
              />
            </div>

            {relayValidationError && (
              <div
                role="alert"
                className="flex items-center gap-2 rounded-tile border border-[var(--status-crimson-border)] bg-[var(--status-crimson-wash)] px-3 py-2 text-[12px] text-[var(--status-crimson)]"
              >
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                <span>{relayValidationError}</span>
              </div>
            )}

            {relayError && <AccessNoticeCard error={relayError} />}

            {relayReceipt && (
              <div
                role="status"
                data-testid="channel-relay-receipt"
                className="rounded-tile border border-[var(--status-emerald-border)] bg-[var(--status-emerald-wash)] px-3.5 py-2.5 text-[12px] text-[var(--status-emerald)] space-y-1"
              >
                <div className="flex items-center gap-1.5 font-semibold">
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                  <span>
                    {tx({
                      "zh-CN": "已写入受控外发审计存证",
                      "zh-HK": "已寫入受控外發稽核存證",
                      en: "Relayed & Audited",
                    })}
                  </span>
                </div>
                <div className="font-mono-code text-[11px] text-[var(--ink-secondary)] tabular-nums">
                  {relayReceipt.channel_id} · {relayReceipt.transport_mode} ·{" "}
                  {relayReceipt.external_message_id}
                </div>
              </div>
            )}

            <Button
              type="submit"
              size="sm"
              variant="primary"
              loading={relaySending}
              data-testid="channel-relay-submit-btn"
              className="w-full"
            >
              <Send className="h-3.5 w-3.5" />
              <span>
                {tx({
                  "zh-CN": "发送受控通道消息",
                  "zh-HK": "傳送受控通道訊息",
                  en: "Send Governed Channel Message",
                })}
              </span>
            </Button>
          </form>
        </div>

        {/* Outbound Audit Log */}
        <div
          data-testid="channel-outbound-log"
          className="rounded-card border border-[var(--hairline)] bg-[var(--bg-surface)] shadow-[var(--shadow-card)] p-5 sm:p-6 lg:col-span-7 flex flex-col space-y-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--hairline)] pb-3.5">
            <div>
              <h3 className="aios-display text-[15.5px] font-semibold text-[var(--ink-primary)]">
                {tx({
                  "zh-CN": "受控外发审计流水",
                  "zh-HK": "受控外發稽核流水",
                  en: "Governed Channel Relay Audit Log",
                })}
              </h3>
              <p className="mt-0.5 text-[12px] text-[var(--ink-muted)]">
                {tx({
                  "zh-CN": "按通道与幂等键记录每笔出站消息摘要、SHA-256 与投递状态。",
                  "zh-HK": "按通道與冪等鍵紀錄每筆出站訊息摘要、SHA-256 與投遞狀態。",
                  en: "Records every outbound relay with body digest, transport mode, and external message receipt.",
                })}
              </p>
            </div>

            <div className="relative">
              <select
                value={logChannelFilter}
                onChange={(e) => setLogChannelFilter(e.target.value)}
                aria-label={tx({
                  "zh-CN": "按通道筛选流水",
                  "zh-HK": "按通道篩選流水",
                  en: "Filter audit log by channel",
                })}
                className="aios-select h-8 px-2.5 pr-7"
              >
                <option value="ALL">
                  {tx({
                    "zh-CN": "全部通道",
                    "zh-HK": "全部通道",
                    en: "All Channels",
                  })}
                </option>
                {catalog.map((ch) => (
                  <option key={ch.channel_id} value={ch.channel_id}>
                    {getChannelDisplayName(ch, locale)}
                  </option>
                ))}
              </select>
              <ChevronDown
                className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--ink-muted)]"
                strokeWidth={1.85}
                aria-hidden="true"
              />
            </div>
          </div>

          {filteredOutboundLog.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center rounded-tile border border-[var(--hairline-subtle)] bg-[var(--bg-surface-tint)] py-12 px-4 text-center">
              <MessageSquareShare className="h-6 w-6 text-[var(--ink-muted)]" />
              <p className="mt-2.5 text-[13px] font-medium text-[var(--ink-primary)]">
                {tx({
                  "zh-CN": "暂无通道外发审计记录",
                  "zh-HK": "暫無通道外發稽核紀錄",
                  en: "No outbound channel relays yet",
                })}
              </p>
              <p className="mt-1 text-[12px] text-[var(--ink-muted)]">
                {tx({
                  "zh-CN": "可通过左侧表单发送一条测试消息，实时验证受控外发与存证链路。",
                  "zh-HK": "可透過左側表單傳送一則測試訊息，即時驗證受控外發與存證鏈路。",
                  en: "Send a test relay on the left to verify governed channel auditing.",
                })}
              </p>
            </div>
          ) : (
            <div className="max-h-[420px] space-y-2.5 overflow-y-auto pr-0.5">
              {filteredOutboundLog.map((entry) => (
                <div
                  key={entry.id}
                  data-testid={`channel-outbound-row-${entry.id}`}
                  className="rounded-tile border border-[var(--hairline)] bg-[var(--bg-surface-tint)] p-3.5 space-y-2"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="rounded-xs border border-[var(--accent-border)] bg-[var(--accent-wash)] px-2 py-0.5 font-mono-code text-[11px] font-semibold text-[var(--accent-ink)]">
                        {entry.channel_id}
                      </span>
                      <span className="font-mono-code text-[12px] font-medium text-[var(--ink-primary)]">
                        {entry.target_handle}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="rounded-xs border border-[var(--hairline)] bg-[var(--bg-surface)] px-2 py-0.5 font-mono-code text-[10.5px] text-[var(--ink-secondary)]">
                        {entry.transport_mode}
                      </span>
                      <StatusBadge
                        status="healthy"
                        label={entry.delivery_status}
                        compact
                      />
                    </div>
                  </div>

                  <p className="text-[12.5px] leading-relaxed text-[var(--ink-secondary)] break-words">
                    {entry.body_preview}
                  </p>

                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--hairline-subtle)] pt-2 font-mono-code text-[10.5px] text-[var(--ink-muted)] tabular-nums">
                    <span title={entry.external_message_id}>
                      msg:{formatShortDigest(entry.external_message_id, 10, 6)}
                    </span>
                    <span>{formatDateTime(entry.created_at)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Employee Channel Handle Binding Modal */}
      <Modal
        open={bindModalChannel !== null}
        onOpenChange={(open) => {
          if (!open && !bindSaving) setBindModalChannel(null);
        }}
        title={
          bindModalChannel
            ? tx(
                {
                  "zh-CN": "绑定 {channel} 员工身份",
                  "zh-HK": "綁定 {channel} 員工身份",
                  en: "Bind {channel} Handle",
                },
                { channel: getChannelDisplayName(bindModalChannel, locale) },
              )
            : ""
        }
        subtitle={tx({
          "zh-CN":
            "将企业外部通讯账号与本租户员工主体绑定，以便路由与审计追踪。",
          "zh-HK":
            "將企業外部通訊帳號與本租戶員工主體綁定，以便路由與稽核追蹤。",
          en: "Map an external messaging identity to a tenant employee subject for governed routing and audit.",
        })}
        size="sm"
        footer={
          <>
            <Button
              variant="ghost"
              disabled={bindSaving}
              onClick={() => setBindModalChannel(null)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              loading={bindSaving}
              data-testid="channel-bind-submit-btn"
              onClick={(e) => void handleSaveBinding(e)}
            >
              {tx({
                "zh-CN": "保存绑定",
                "zh-HK": "儲存綁定",
                en: "Save Binding",
              })}
            </Button>
          </>
        }
      >
        <form onSubmit={(e) => void handleSaveBinding(e)} className="space-y-3.5">
          <div>
            <label className="aios-micro-label block">
              {tx({
                "zh-CN": "企业员工标识 (subject)",
                "zh-HK": "企業員工識別碼 (subject)",
                en: "Employee Subject",
              })}
            </label>
            <input
              type="text"
              value={bindSubject}
              onChange={(e) => setBindSubject(e.target.value)}
              data-testid="channel-bind-subject-input"
              placeholder="operator"
              className="mt-1.5 h-9 w-full rounded-sm border border-[var(--hairline-strong)] bg-[var(--bg-surface-tint)] px-3 font-mono-code text-[12.5px] text-[var(--ink-primary)] focus:border-[var(--accent)] focus:bg-[var(--bg-surface)] focus:ring-2 focus:ring-[var(--accent-ring)] focus:outline-none"
            />
          </div>

          <div>
            <label className="aios-micro-label block">
              {tx({
                "zh-CN": "外部平台 User ID / 手机号",
                "zh-HK": "外部平台 User ID / 手機號",
                en: "External User ID",
              })}
            </label>
            <input
              type="text"
              required
              value={bindExternalUserId}
              onChange={(e) => {
                setBindExternalUserId(e.target.value);
                setBindError(null);
              }}
              data-testid="channel-bind-external-id-input"
              placeholder={tx({
                "zh-CN": "例如 wxid_operator_01 或 +85291234567",
                "zh-HK": "例如 wxid_operator_01 或 +85291234567",
                en: "e.g. U01928374 or +85291234567",
              })}
              className="mt-1.5 h-9 w-full rounded-sm border border-[var(--hairline-strong)] bg-[var(--bg-surface-tint)] px-3 font-mono-code text-[12.5px] text-[var(--ink-primary)] focus:border-[var(--accent)] focus:bg-[var(--bg-surface)] focus:ring-2 focus:ring-[var(--accent-ring)] focus:outline-none"
            />
          </div>

          <div>
            <label className="aios-micro-label block">
              {tx({
                "zh-CN": "显示句柄 / 昵称",
                "zh-HK": "顯示句柄 / 暱稱",
                en: "Display Handle",
              })}
            </label>
            <input
              type="text"
              required
              value={bindDisplayHandle}
              onChange={(e) => {
                setBindDisplayHandle(e.target.value);
                setBindError(null);
              }}
              data-testid="channel-bind-handle-input"
              placeholder={tx({
                "zh-CN": "例如 @lin.mingzhe",
                "zh-HK": "例如 @lin.mingzhe",
                en: "e.g. @lin.mingzhe",
              })}
              className="mt-1.5 h-9 w-full rounded-sm border border-[var(--hairline-strong)] bg-[var(--bg-surface-tint)] px-3 text-[12.5px] text-[var(--ink-primary)] focus:border-[var(--accent)] focus:bg-[var(--bg-surface)] focus:ring-2 focus:ring-[var(--accent-ring)] focus:outline-none"
            />
          </div>

          {bindError && (
            <div
              role="alert"
              className="flex items-center gap-2 rounded-tile border border-[var(--status-crimson-border)] bg-[var(--status-crimson-wash)] px-3 py-2 text-[12px] text-[var(--status-crimson)]"
            >
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span>{bindError}</span>
            </div>
          )}
        </form>
      </Modal>
    </div>
  );
}
