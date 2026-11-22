"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  Mail,
  Send,
  ShieldCheck,
  UserCheck,
} from "lucide-react";
import {
  fetchMcpStatus,
  generateClientId,
  isApiError,
  isStaleAuthError,
  sendGovernedEmailApi,
  type ApiError,
} from "@/lib/api-client";
import { useLocale } from "@/lib/i18n";
import { useSession } from "@/lib/session-context";
import { Interactive3DCard } from "@/components/kinetic";
import { AccessNoticeCard } from "@/components/ui/AccessNoticeCard";
import { Button } from "@/components/ui/Button";
import { StatusBadge } from "@/components/ui/StatusBadge";
import type {
  EmailDraftPayload,
  EmailSendResponse,
  EmailTransportMode,
  McpConnectorStatusItem,
} from "@/lib/types";

const EMAIL_ADDR_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const CRLF_RE = /[\r\n]/;

function parseAddressList(raw: string): string[] {
  return raw
    .split(/[,;\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export interface EmailComposeCardProps {
  draft: EmailDraftPayload;
  initialSent?: EmailSendResponse | null;
  onSent?: (res: EmailSendResponse) => void;
}

export function EmailComposeCard({
  draft,
  initialSent = null,
  onSent,
}: EmailComposeCardProps) {
  const { status, authGeneration, handleAccessChanged } = useSession();
  const { tx, t, formatDateTime } = useLocale();

  const [toInput, setToInput] = useState(() => draft.to.join(", "));
  const [ccInput, setCcInput] = useState(() => draft.cc.join(", "));
  const [showCc, setShowCc] = useState(() => draft.cc.length > 0);
  const [subject, setSubject] = useState(() => draft.subject);
  const [body, setBody] = useState(() => draft.body);

  const [emailConnector, setEmailConnector] =
    useState<McpConnectorStatusItem | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [apiError, setApiError] = useState<ApiError | null>(null);
  const [sentResult, setSentResult] = useState<EmailSendResponse | null>(
    initialSent,
  );
  const [copiedMsgId, setCopiedMsgId] = useState(false);

  const clientIdRef = useRef<string>(generateClientId("email"));
  const submittingRef = useRef(false);

  useEffect(() => {
    setToInput(draft.to.join(", "));
    setCcInput(draft.cc.join(", "));
    setShowCc(draft.cc.length > 0);
    setSubject(draft.subject);
    setBody(draft.body);
    setValidationError(null);
    setApiError(null);
    clientIdRef.current = generateClientId("email");
  }, [draft]);

  useEffect(() => {
    if (initialSent) {
      setSentResult(initialSent);
    }
  }, [initialSent]);

  useEffect(() => {
    if (status !== "authenticated") return;
    const controller = new AbortController();
    fetchMcpStatus(controller.signal)
      .then((res) => {
        if (controller.signal.aborted) return;
        const found = res.connectors.find(
          (c) => (c.connector as string) === "email",
        );
        if (found) setEmailConnector(found);
      })
      .catch(() => {
        // Non-blocking: transport falls back to governed_outbox label
      });
    return () => {
      controller.abort();
    };
  }, [status, authGeneration]);

  const parsedTo = useMemo(() => parseAddressList(toInput), [toInput]);
  const parsedCc = useMemo(() => parseAddressList(ccInput), [ccInput]);

  const transportLabel = useCallbackTransportLabel(
    emailConnector,
    sentResult?.transport_mode,
    tx,
  );

  const handleCopyMessageId = async (msgId: string) => {
    try {
      await navigator.clipboard.writeText(msgId);
      setCopiedMsgId(true);
      window.setTimeout(() => setCopiedMsgId(false), 1800);
    } catch {
      // ignore clipboard restriction
    }
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingRef.current || sentResult) return;

    const toList = parseAddressList(toInput);
    const ccList = parseAddressList(ccInput);
    const trimmedSubject = subject.trim();
    const trimmedBody = body.trim();

    if (toList.length === 0) {
      setValidationError(
        tx({
          "zh-CN": "请至少填写一位有效收件人邮箱。",
          "zh-HK": "請至少填寫一位有效收件人電郵。",
          en: "Please enter at least one valid recipient email address.",
        }),
      );
      return;
    }

    if (toList.length + ccList.length > 10) {
      setValidationError(
        tx({
          "zh-CN": "单封受控邮件最多发送给 10 位收件人（含抄送）。",
          "zh-HK": "單封受控電郵最多發送給 10 位收件人（含副本）。",
          en: "A governed email may include at most 10 total recipients (To + CC).",
        }),
      );
      return;
    }

    const invalidAddr = [...toList, ...ccList].find(
      (addr) => CRLF_RE.test(addr) || !EMAIL_ADDR_RE.test(addr),
    );
    if (invalidAddr) {
      setValidationError(
        tx(
          {
            "zh-CN": "收件人邮箱格式无效：{addr}",
            "zh-HK": "收件人電郵格式無效：{addr}",
            en: "Invalid email address: {addr}",
          },
          { addr: invalidAddr },
        ),
      );
      return;
    }

    if (!trimmedSubject || CRLF_RE.test(trimmedSubject)) {
      setValidationError(
        tx({
          "zh-CN": "请输入有效的邮件主题（不可包含换行符）。",
          "zh-HK": "請輸入有效的電郵主題（不可包含換行符）。",
          en: "Please enter a valid single-line subject.",
        }),
      );
      return;
    }

    if (!trimmedBody) {
      setValidationError(
        tx({
          "zh-CN": "邮件正文不能为空。",
          "zh-HK": "電郵正文不能為空。",
          en: "Email body cannot be empty.",
        }),
      );
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    setValidationError(null);
    setApiError(null);

    try {
      const res = await sendGovernedEmailApi({
        client_id: clientIdRef.current,
        to: toList,
        cc: ccList.length > 0 ? ccList : undefined,
        subject: trimmedSubject,
        body: trimmedBody,
      });
      setSentResult(res);
      onSent?.(res);
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
            "zh-CN": "邮件发送未能完成，请检查网络或配置后重试。",
            "zh-HK": "電郵發送未能完成，請檢查網路或設定後重試。",
            en: "Failed to send email. Please check connectivity and retry.",
          }),
        );
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  if (sentResult) {
    const receipt = sentResult.receipt;
    const deliveryLabel =
      sentResult.delivery_status === "sent"
        ? tx({
            "zh-CN": "已通过外部邮件通道投递",
            "zh-HK": "已透過外部電郵通道投遞",
            en: "Delivered via External Mail",
          })
        : sentResult.delivery_status === "delivered_internal"
          ? tx({
              "zh-CN": "已投递并推送站内收件通知",
              "zh-HK": "已投遞並推送站內收件通知",
              en: "Delivered & Internal Colleague Notified",
            })
          : tx({
              "zh-CN": "已存入受控发件箱并完成审计存证",
              "zh-HK": "已存入受控寄件匣並完成稽核存證",
              en: "Recorded in Governed Outbox",
            });

    return (
      <Interactive3DCard
        maxTilt={2}
        hoverLiftPx={-1}
        sheenIntensity="subtle"
        data-testid="email-sent-receipt-card"
        className="overflow-hidden rounded-card border border-[var(--hairline)] bg-[var(--bg-surface)] shadow-[var(--shadow-card)]"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 bg-[var(--status-emerald-wash)] px-4 py-3 border-b border-[var(--status-emerald-border)]">
          <div className="flex items-center gap-2">
            <CheckCircle2
              className="h-4 w-4 text-[var(--status-emerald)]"
              strokeWidth={2}
            />
            <span className="text-[13.5px] font-semibold text-[var(--ink-primary)]">
              {tx({
                "zh-CN": "受控邮件已发送并留痕",
                "zh-HK": "受控電郵已發送並留痕",
                en: "Governed Email Sent & Audited",
              })}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <StatusBadge status="healthy" label={transportLabel} compact />
          </div>
        </div>

        <div className="p-4 space-y-3">
          <div className="text-[13.5px] font-semibold tracking-[-0.01em] text-[var(--ink-primary)]">
            {receipt.subject_line}
          </div>

          <dl className="divide-y divide-[var(--hairline-subtle)] rounded-tile border border-[var(--hairline)] bg-[var(--bg-surface-tint)] text-[12px]">
            <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2">
              <dt className="aios-micro-label shrink-0">
                {tx({ "zh-CN": "收件人", "zh-HK": "收件人", en: "Recipients" })}
              </dt>
              <dd className="font-mono-code tabular-nums text-[var(--ink-primary)] text-right break-all">
                {receipt.recipients.join(", ")}
              </dd>
            </div>
            {receipt.cc.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2">
                <dt className="aios-micro-label shrink-0">CC</dt>
                <dd className="font-mono-code tabular-nums text-[var(--ink-secondary)] text-right break-all">
                  {receipt.cc.join(", ")}
                </dd>
              </div>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2">
              <dt className="aios-micro-label shrink-0">
                {tx({
                  "zh-CN": "投递状态",
                  "zh-HK": "投遞狀態",
                  en: "Delivery Status",
                })}
              </dt>
              <dd className="font-medium text-[var(--status-emerald)]">
                {deliveryLabel}
              </dd>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2">
              <dt className="aios-micro-label shrink-0">RFC Message-ID</dt>
              <dd className="flex items-center gap-1.5 font-mono-code text-[11.5px] text-[var(--ink-primary)]">
                <span className="max-w-[260px] truncate tabular-nums">
                  {sentResult.message_id}
                </span>
                <button
                  type="button"
                  onClick={() => void handleCopyMessageId(sentResult.message_id)}
                  aria-label={t("common.copy")}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-[var(--ink-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--ink-primary)] cursor-pointer"
                >
                  {copiedMsgId ? (
                    <Check className="h-3 w-3 text-[var(--status-emerald)]" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                </button>
              </dd>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2">
              <dt className="aios-micro-label shrink-0">
                {tx({
                  "zh-CN": "审计存证编号",
                  "zh-HK": "稽核存證編號",
                  en: "Audit Receipt ID",
                })}
              </dt>
              <dd className="font-mono-code text-[11.5px] text-[var(--ink-secondary)] tabular-nums">
                {receipt.id} · {formatDateTime(receipt.created_at)}
              </dd>
            </div>
          </dl>
        </div>
      </Interactive3DCard>
    );
  }

  return (
    <Interactive3DCard
      maxTilt={1.5}
      hoverLiftPx={-1}
      sheenIntensity="subtle"
      data-testid="email-compose-card"
      className="overflow-hidden rounded-card border border-[var(--hairline-strong)] bg-[var(--bg-surface)] shadow-[var(--shadow-floating)]"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--hairline)] bg-[var(--bg-surface-tint)] px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-sm border border-[var(--accent-border)] bg-[var(--accent-wash)] text-[var(--accent-ink)]">
            <Mail className="h-3.5 w-3.5" strokeWidth={2} />
          </span>
          <div>
            <div className="text-[13.5px] font-semibold tracking-[-0.01em] text-[var(--ink-primary)]">
              {tx({
                "zh-CN": "受控邮件发送确认",
                "zh-HK": "受控電郵發送確認",
                en: "Governed Email Draft",
              })}
            </div>
            <div className="text-[11px] text-[var(--ink-muted)]">
              {tx({
                "zh-CN": "发送前可自由编辑收件人、主题与正文，确认后写入审计日志",
                "zh-HK": "發送前可自由編輯收件人、主題與正文，確認後寫入稽核紀錄",
                en: "Edit recipients, subject & body before sending with full audit logging",
              })}
            </div>
          </div>
        </div>

        <StatusBadge
          status={emailConnector?.configured ? "connected" : "sandbox_ready"}
          label={transportLabel}
          compact
        />
      </div>

      <form onSubmit={(e) => void handleSend(e)} className="p-4 space-y-3">
        {draft.resolved_contacts && draft.resolved_contacts.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 rounded-tile border border-[var(--hairline)] bg-[var(--bg-surface-tint)] px-3 py-2">
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--ink-muted)] mr-0.5">
              <UserCheck className="h-3 w-3 text-[var(--accent)]" />
              <span>
                {tx({
                  "zh-CN": "已解析企业同事：",
                  "zh-HK": "已解析企業同事：",
                  en: "Resolved colleagues:",
                })}
              </span>
            </span>
            {draft.resolved_contacts.map((contact) => (
              <span
                key={`${contact.subject}-${contact.email}`}
                className="inline-flex items-center gap-1.5 rounded-xs border border-[var(--accent-border)] bg-[var(--accent-wash)] px-2 py-0.5 text-[11px] font-medium text-[var(--accent-ink)]"
              >
                <span>{contact.display_name}</span>
                <span className="font-mono-code text-[10.5px] tabular-nums opacity-85">
                  {contact.email}
                </span>
              </span>
            ))}
          </div>
        )}

        {draft.warnings && draft.warnings.length > 0 && (
          <div className="rounded-tile border border-[var(--status-amber-border)] bg-[var(--status-amber-wash)] px-3 py-2 text-[12px] text-[var(--status-amber-ink)] space-y-1">
            {draft.warnings.map((warn, idx) => (
              <div key={idx} className="flex items-start gap-1.5">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{warn}</span>
              </div>
            ))}
          </div>
        )}

        <div>
          <div className="flex items-center justify-between gap-2">
            <label className="aios-micro-label">
              {tx({
                "zh-CN": "收件人 (To，多个邮箱用逗号分隔)",
                "zh-HK": "收件人 (To，多個電郵以逗號分隔)",
                en: "To (comma-separated emails)",
              })}
            </label>
            {!showCc && (
              <button
                type="button"
                onClick={() => setShowCc(true)}
                className="font-mono-code text-[11px] font-medium text-[var(--accent-ink)] hover:underline cursor-pointer"
              >
                + CC
              </button>
            )}
          </div>
          <input
            type="text"
            value={toInput}
            onChange={(e) => {
              setToInput(e.target.value);
              setValidationError(null);
            }}
            data-testid="email-compose-to"
            placeholder="colleague@theodic.local"
            className="mt-1.5 h-9 w-full rounded-sm border border-[var(--hairline-strong)] bg-[var(--bg-surface-tint)] px-3 font-mono-code text-[12.5px] text-[var(--ink-primary)] focus:border-[var(--accent)] focus:bg-[var(--bg-surface)] focus:ring-2 focus:ring-[var(--accent-ring)] focus:outline-none transition-colors"
          />
          {parsedTo.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {parsedTo.map((addr, idx) => (
                <span
                  key={`${addr}-${idx}`}
                  className={[
                    "rounded-xs border px-2 py-0.5 font-mono-code text-[10.5px] tabular-nums",
                    EMAIL_ADDR_RE.test(addr)
                      ? "border-[var(--hairline)] bg-[var(--bg-surface-subtle)] text-[var(--ink-secondary)]"
                      : "border-[var(--status-crimson-border)] bg-[var(--status-crimson-wash)] text-[var(--status-crimson)]",
                  ].join(" ")}
                >
                  {addr}
                </span>
              ))}
            </div>
          )}
        </div>

        {showCc && (
          <div>
            <label className="aios-micro-label block">
              {tx({
                "zh-CN": "抄送 (CC)",
                "zh-HK": "副本 (CC)",
                en: "CC (optional)",
              })}
            </label>
            <input
              type="text"
              value={ccInput}
              onChange={(e) => {
                setCcInput(e.target.value);
                setValidationError(null);
              }}
              data-testid="email-compose-cc"
              placeholder="manager@theodic.local"
              className="mt-1.5 h-9 w-full rounded-sm border border-[var(--hairline-strong)] bg-[var(--bg-surface-tint)] px-3 font-mono-code text-[12.5px] text-[var(--ink-primary)] focus:border-[var(--accent)] focus:bg-[var(--bg-surface)] focus:ring-2 focus:ring-[var(--accent-ring)] focus:outline-none transition-colors"
            />
            {parsedCc.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {parsedCc.map((addr, idx) => (
                  <span
                    key={`${addr}-${idx}`}
                    className={[
                      "rounded-xs border px-2 py-0.5 font-mono-code text-[10.5px] tabular-nums",
                      EMAIL_ADDR_RE.test(addr)
                        ? "border-[var(--hairline)] bg-[var(--bg-surface-subtle)] text-[var(--ink-muted)]"
                        : "border-[var(--status-crimson-border)] bg-[var(--status-crimson-wash)] text-[var(--status-crimson)]",
                    ].join(" ")}
                  >
                    {addr}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        <div>
          <label className="aios-micro-label block">
            {tx({ "zh-CN": "邮件主题", "zh-HK": "電郵主題", en: "Subject" })}
          </label>
          <input
            type="text"
            maxLength={200}
            value={subject}
            onChange={(e) => {
              setSubject(e.target.value);
              setValidationError(null);
            }}
            data-testid="email-compose-subject"
            className="mt-1.5 h-9 w-full rounded-sm border border-[var(--hairline-strong)] bg-[var(--bg-surface-tint)] px-3 text-[13px] font-medium text-[var(--ink-primary)] focus:border-[var(--accent)] focus:bg-[var(--bg-surface)] focus:ring-2 focus:ring-[var(--accent-ring)] focus:outline-none transition-colors"
          />
        </div>

        <div>
          <label className="aios-micro-label block">
            {tx({ "zh-CN": "邮件正文", "zh-HK": "電郵正文", en: "Message Body" })}
          </label>
          <textarea
            rows={4}
            maxLength={4000}
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
              setValidationError(null);
            }}
            data-testid="email-compose-body"
            className="mt-1.5 w-full rounded-sm border border-[var(--hairline-strong)] bg-[var(--bg-surface-tint)] p-3 text-[13px] leading-relaxed text-[var(--ink-primary)] focus:border-[var(--accent)] focus:bg-[var(--bg-surface)] focus:ring-2 focus:ring-[var(--accent-ring)] focus:outline-none transition-colors"
          />
        </div>

        {validationError && (
          <div
            role="alert"
            className="flex items-center gap-2 rounded-tile border border-[var(--status-crimson-border)] bg-[var(--status-crimson-wash)] px-3 py-2 text-[12px] text-[var(--status-crimson)]"
          >
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span>{validationError}</span>
          </div>
        )}

        {apiError && <AccessNoticeCard error={apiError} />}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--hairline-subtle)] pt-3">
          <span className="inline-flex items-center gap-1.5 text-[11.5px] text-[var(--ink-muted)]">
            <ShieldCheck className="h-3.5 w-3.5 text-[var(--accent)]" />
            <span>
              {tx({
                "zh-CN": "受控外发校验已启用 · 需人工点击确认",
                "zh-HK": "受控外發校驗已啟用 · 須人工點擊確認",
                en: "Governed mail check active · Requires explicit confirmation",
              })}
            </span>
          </span>

          <Button
            type="submit"
            size="sm"
            variant="primary"
            loading={submitting}
            data-testid="email-confirm-send-btn"
          >
            <Send className="h-3.5 w-3.5" strokeWidth={1.9} />
            <span>
              {tx({
                "zh-CN": "确认发送邮件",
                "zh-HK": "確認發送電郵",
                en: "Confirm & Send Email",
              })}
            </span>
          </Button>
        </div>
      </form>
    </Interactive3DCard>
  );
}

function useCallbackTransportLabel(
  connector: McpConnectorStatusItem | null,
  sentMode: EmailTransportMode | undefined,
  tx: ReturnType<typeof useLocale>["tx"],
): string {
  if (sentMode === "live_mcp") {
    return tx({
      "zh-CN": "Email MCP 实时通道",
      "zh-HK": "Email MCP 即時通道",
      en: "Live Email MCP",
    });
  }
  if (sentMode === "live_smtp") {
    return tx({
      "zh-CN": "TLS SMTP 直连通道",
      "zh-HK": "TLS SMTP 直連通道",
      en: "Live TLS SMTP",
    });
  }
  if (sentMode === "governed_outbox") {
    return tx({
      "zh-CN": "受控发件箱存证",
      "zh-HK": "受控寄件匣存證",
      en: "Governed Outbox",
    });
  }
  if (connector) {
    if (connector.mode === "live_mcp") {
      return tx({
        "zh-CN": "Email MCP 已就绪",
        "zh-HK": "Email MCP 已就緒",
        en: "Email MCP Ready",
      });
    }
    if (connector.mode === "live_api") {
      return tx({
        "zh-CN": "SMTP TLS 已就绪",
        "zh-HK": "SMTP TLS 已就緒",
        en: "SMTP TLS Ready",
      });
    }
  }
  return tx({
    "zh-CN": "受控发件箱模式",
    "zh-HK": "受控寄件匣模式",
    en: "Governed Outbox",
  });
}
