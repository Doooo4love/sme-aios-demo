"use client";

import React from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  Bell,
  Calendar,
  CheckSquare,
  FileText,
  HelpCircle,
  Mail,
  Package,
  PanelRightOpen,
  Receipt,
  ShieldAlert,
  Sparkles,
  Warehouse,
} from "lucide-react";
import { formatShortDigest } from "@/lib/format";
import {
  DEFAULT_LOCALE,
  translateInline,
  useLocale,
  type Locale,
} from "@/lib/i18n";
import { Interactive3DCard } from "@/components/kinetic";
import { Button } from "@/components/ui/Button";
import { SourceTag } from "@/components/ui/SourceTag";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { EmailComposeCard } from "@/features/inbox/EmailComposeCard";
import type {
  Capabilities,
  DrawerObjectSelection,
  EmailSendResponse,
  InvoiceView,
  MailInboxView,
  Proposal,
  ShipmentView,
  SuggestedAction,
  TurnResult,
  WarehouseDecisionSummary,
} from "@/lib/types";

export type CapabilityDomainId = "finance" | "shipment" | "insights" | "mail";

export interface ClarificationOption {
  /** Stable locale-independent icon key */
  domainId: CapabilityDomainId;
  /** Backwards-compatible E2E data-testid suffix */
  domain: string;
  /** Localized short domain badge */
  domainLabel: string;
  label: string;
  prompt: string;
}

export function buildCapabilityPromptOptions(
  capabilities: Capabilities | null,
  locale: Locale = DEFAULT_LOCALE,
): ClarificationOption[] {
  if (!capabilities) return [];
  const options: ClarificationOption[] = [];

  for (const tool of capabilities.tools) {
    if (!tool.available) continue;
    const wh = tool.warehouses[0];

    if (tool.id === "finance.invoice.read" && wh) {
      options.push({
        domainId: "finance",
        domain: "财务",
        domainLabel: translateInline(locale, {
          "zh-CN": "财务",
          "zh-HK": "財務",
          en: "Finance",
        }),
        label: translateInline(
          locale,
          {
            "zh-CN": "查看 {wh} 发票 INV-100",
            "zh-HK": "檢視 {wh} 發票 INV-100",
            en: "Check {wh} invoice INV-100",
          },
          { wh },
        ),
        prompt: translateInline(
          locale,
          {
            "zh-CN": "查看发票 INV-100 仓库 {wh}",
            "zh-HK": "檢視發票 INV-100 倉庫 {wh}",
            en: "Show invoice INV-100 in {wh}",
          },
          { wh },
        ),
      });
    } else if (tool.id === "shipment.read" && wh) {
      const shp = wh === "HK02" ? "SHP-2001" : "SHP-1001";
      options.push({
        domainId: "shipment",
        domain: "运单",
        domainLabel: translateInline(locale, {
          "zh-CN": "运单",
          "zh-HK": "運單",
          en: "Shipments",
        }),
        label: translateInline(
          locale,
          {
            "zh-CN": "查看 {wh} 运单 {shp}",
            "zh-HK": "檢視 {wh} 運單 {shp}",
            en: "Check {wh} shipment {shp}",
          },
          { wh, shp },
        ),
        prompt: translateInline(
          locale,
          {
            "zh-CN": "查看运单 {shp} 仓库 {wh}",
            "zh-HK": "檢視運單 {shp} 倉庫 {wh}",
            en: "Show shipment {shp} in {wh}",
          },
          { wh, shp },
        ),
      });
    } else if (tool.id === "decision.warehouse.summary" && wh) {
      options.push({
        domainId: "insights",
        domain: "经营",
        domainLabel: translateInline(locale, {
          "zh-CN": "经营",
          "zh-HK": "營運",
          en: "Insights",
        }),
        label: translateInline(
          locale,
          {
            "zh-CN": "查看 {wh} 仓库概览",
            "zh-HK": "檢視 {wh} 倉庫概覽",
            en: "{wh} warehouse summary",
          },
          { wh },
        ),
        prompt: translateInline(
          locale,
          {
            "zh-CN": "仓库汇总 {wh}",
            "zh-HK": "倉庫摘要 {wh}",
            en: "Warehouse summary {wh}",
          },
          { wh },
        ),
      });
    } else if (tool.id === "mail.inbox.read") {
      options.push({
        domainId: "mail",
        domain: "邮箱",
        domainLabel: translateInline(locale, {
          "zh-CN": "邮箱",
          "zh-HK": "電郵",
          en: "Mail",
        }),
        label: translateInline(locale, {
          "zh-CN": "查看我的收件箱",
          "zh-HK": "檢視我的收件箱",
          en: "Check my inbox",
        }),
        prompt: translateInline(locale, {
          "zh-CN": "查看我的收件箱",
          "zh-HK": "檢視我的收件箱",
          en: "Check my inbox",
        }),
      });
    }
  }

  return options;
}

function isInvoiceView(
  data: Record<string, unknown>,
): data is Record<string, unknown> & InvoiceView {
  return (
    typeof data.invoice_id === "string" &&
    typeof data.amount === "string" &&
    typeof data.currency === "string"
  );
}

function isShipmentView(
  data: Record<string, unknown>,
): data is Record<string, unknown> & ShipmentView {
  return (
    typeof data.shipment_id === "string" &&
    typeof data.delivery_date === "string"
  );
}

function isWarehouseSummary(
  data: Record<string, unknown>,
): data is Record<string, unknown> & WarehouseDecisionSummary {
  return (
    typeof data.warehouse === "string" &&
    typeof data.open_shipments === "number"
  );
}

function isMailInboxView(
  data: Record<string, unknown>,
): data is Record<string, unknown> & MailInboxView {
  return Array.isArray(data.messages);
}

export interface TurnResultCardProps {
  result: TurnResult;
  capabilities: Capabilities | null;
  timestamp?: number;
  initialEmailSent?: EmailSendResponse | null;
  onEmailSent?: (res: EmailSendResponse) => void;
  onSelectClarification?: (prompt: string) => void;
  onSelectSuggestedAction?: (action: SuggestedAction) => void;
  onInspectObject: (
    selection: DrawerObjectSelection,
    trigger: HTMLElement | null,
  ) => void;
}

export function TurnResultCard({
  result,
  capabilities,
  timestamp,
  initialEmailSent,
  onEmailSent,
  onSelectClarification,
  onSelectSuggestedAction,
  onInspectObject,
}: TurnResultCardProps) {
  const {
    locale,
    tx,
    tp,
    formatDateTime,
    localizeAction,
    localizePersona,
    localizeStatus,
    localizeTool,
  } = useLocale();

  const renderConciseDiff = (proposal: Proposal): React.ReactNode => {
    const { action, before, after } = proposal.plan;
    if (action === "shipment.reschedule") {
      const oldDate =
        typeof before.delivery_date === "string" ? before.delivery_date : "—";
      const newDate =
        typeof after.delivery_date === "string" ? after.delivery_date : "—";
      return (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-tile border border-[var(--hairline)] bg-[var(--bg-surface-tint)] px-3.5 py-2.5 text-[12.5px]">
          <span className="aios-micro-label">
            {tx({
              "zh-CN": "交付日期",
              "zh-HK": "交付日期",
              en: "Delivery Date",
            })}
          </span>
          <span className="font-mono-code tabular-nums text-[var(--ink-secondary)] line-through">
            {oldDate}
          </span>
          <ArrowRight className="h-3.5 w-3.5 text-[var(--ink-muted)]" />
          <span className="rounded-xs border border-[var(--accent-border)] bg-[var(--accent-wash)] px-2 py-0.5 font-mono-code tabular-nums font-semibold text-[var(--accent-ink)]">
            {newDate}
          </span>
        </div>
      );
    }

    if (action === "sales_order.create_draft") {
      const po = typeof after.po === "string" ? after.po : proposal.plan.target;
      const currency = typeof after.currency === "string" ? after.currency : "";
      const total = typeof after.total === "string" ? after.total : "—";
      const items = Array.isArray(after.items) ? after.items.length : 0;
      return (
        <div className="mt-3 grid grid-cols-3 gap-3 rounded-tile border border-[var(--hairline)] bg-[var(--bg-surface-tint)] px-3.5 py-2.5 text-[12px]">
          <div>
            <div className="aios-micro-label">
              {tx({
                "zh-CN": "采购单号",
                "zh-HK": "採購單號",
                en: "PO Number",
              })}
            </div>
            <div className="mt-0.5 truncate font-mono-code tabular-nums font-medium text-[var(--ink-primary)]">
              {po}
            </div>
          </div>
          <div>
            <div className="aios-micro-label">
              {tx({
                "zh-CN": "订单总额",
                "zh-HK": "訂單總額",
                en: "Order Total",
              })}
            </div>
            <div className="mt-0.5 font-mono-code font-semibold text-[var(--ink-primary)] tabular-nums">
              {currency} {total}
            </div>
          </div>
          <div>
            <div className="aios-micro-label">
              {tx({
                "zh-CN": "明细行数",
                "zh-HK": "明細行數",
                en: "Line Items",
              })}
            </div>
            <div className="mt-0.5 font-mono-code font-medium text-[var(--ink-primary)] tabular-nums">
              {tp(
                {
                  "zh-CN": "{count} 行",
                  "zh-HK": "{count} 行",
                  en: { one: "{count} line", other: "{count} lines" },
                },
                items,
              )}
            </div>
          </div>
        </div>
      );
    }

    return null;
  };

  if (result.kind === "clarification") {
    const options = buildCapabilityPromptOptions(capabilities, locale);
    return (
      <Interactive3DCard
        maxTilt={2}
        hoverLiftPx={-1}
        sheenIntensity="subtle"
        data-testid="turn-card-clarification"
        className="rounded-card border border-[var(--hairline)] bg-[var(--bg-surface)] p-4 shadow-[var(--shadow-card)]"
      >
        <div className="flex items-center gap-2">
          <HelpCircle
            className="h-4 w-4 text-[var(--accent)]"
            strokeWidth={1.85}
          />
          <span className="aios-micro-label">
            {tx({
              "zh-CN": "需要补充指令要素",
              "zh-HK": "須補充指令條件",
              en: "More Details Needed",
            })}
          </span>
        </div>
        <p className="mt-2 text-[14px] leading-relaxed text-[var(--ink-primary)] break-words">
          {result.question}
        </p>

        {options.length > 0 && onSelectClarification && (
          <div className="mt-3.5 border-t border-[var(--hairline-subtle)] pt-3">
            <div className="aios-micro-label mb-2">
              {tx({
                "zh-CN": "可直接点选常用查询",
                "zh-HK": "可直接點選常用查詢",
                en: "Try a quick query",
              })}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {options.map((opt) => (
                <button
                  key={opt.prompt}
                  type="button"
                  data-testid={`clarification-option-${opt.domain}`}
                  onClick={() => onSelectClarification(opt.prompt)}
                  className="inline-flex items-center gap-1.5 rounded-sm border border-[var(--hairline)] bg-[var(--bg-surface-subtle)] px-2.5 py-1.5 text-[12px] font-medium text-[var(--ink-primary)] hover:border-[var(--accent-border)] hover:bg-[var(--accent-wash)] hover:text-[var(--accent-ink)] transition-colors duration-[140ms] cursor-pointer"
                >
                  <span className="text-[11px] text-[var(--ink-muted)]">
                    {opt.domainLabel}
                  </span>
                  <span>{opt.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </Interactive3DCard>
    );
  }

  if (result.kind === "result") {
    const rawData = (result.data ?? {}) as Record<string, unknown>;
    const toolLabel = localizeTool(result.tool);
    const warehouse =
      typeof rawData.warehouse === "string" ? rawData.warehouse : undefined;

    const buildDrawerSelection = (): DrawerObjectSelection => {
      if (result.tool === "shipment.read" && isShipmentView(rawData)) {
        return {
          kind: "shipment",
          id: rawData.shipment_id,
          warehouse: rawData.warehouse,
          title: tx(
            {
              "zh-CN": "运单 {id}",
              "zh-HK": "運單 {id}",
              en: "Shipment {id}",
            },
            { id: rawData.shipment_id },
          ),
          meta: { result },
        };
      }
      if (result.tool === "finance.invoice.read" && isInvoiceView(rawData)) {
        return {
          kind: "invoice",
          id: rawData.invoice_id,
          warehouse: rawData.warehouse,
          title: tx(
            {
              "zh-CN": "发票 {id}",
              "zh-HK": "發票 {id}",
              en: "Invoice {id}",
            },
            { id: rawData.invoice_id },
          ),
          meta: { result },
        };
      }
      return {
        kind: "summary",
        id: warehouse || result.tool,
        warehouse,
        title: toolLabel,
        meta: { result },
      };
    };

    return (
      <Interactive3DCard
        maxTilt={2.5}
        hoverLiftPx={-1}
        sheenIntensity="subtle"
        data-testid="turn-card-result"
        data-tool={result.tool}
        className="overflow-hidden rounded-card border border-[var(--hairline)] bg-[var(--bg-surface)] shadow-[var(--shadow-card)] hover:shadow-[var(--shadow-card-hover)]"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 bg-[var(--bg-surface-tint)] px-4 py-2.5 border-b border-[var(--hairline)]">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-[var(--status-emerald)]" />
            <span className="text-[12.5px] font-semibold text-[var(--ink-primary)]">
              {toolLabel}
            </span>
            {warehouse && (
              <span className="rounded-xs border border-[var(--hairline)] bg-[var(--bg-surface)] px-2 py-0.5 font-mono-code text-[10.5px] text-[var(--ink-secondary)] leading-none">
                {warehouse}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <SourceTag source={result.source} />
            {timestamp && (
              <span className="font-mono-code text-[11px] text-[var(--ink-muted)] tabular-nums">
                {formatDateTime(timestamp)}
              </span>
            )}
          </div>
        </div>

        <div className="p-4">
          {result.tool === "finance.invoice.read" && isInvoiceView(rawData) ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-sm border border-[var(--accent-border)] bg-[var(--accent-wash)] text-[var(--accent-ink)]">
                    <Receipt className="h-4 w-4" strokeWidth={1.85} />
                  </span>
                  <span className="text-[14.5px] font-semibold tracking-[-0.01em] text-[var(--ink-primary)]">
                    {tx({
                      "zh-CN": "发票",
                      "zh-HK": "發票",
                      en: "Invoice",
                    })}{" "}
                    <span className="font-mono-code font-medium tabular-nums">
                      {rawData.invoice_id}
                    </span>
                  </span>
                </div>
                <StatusBadge status={rawData.state} compact />
              </div>
              <dl className="grid grid-cols-3 gap-3 rounded-tile border border-[var(--hairline)] bg-[var(--bg-surface-tint)] px-3.5 py-2.5 text-[12px]">
                <div>
                  <dt className="aios-micro-label">
                    {tx({
                      "zh-CN": "仓库",
                      "zh-HK": "倉庫",
                      en: "Warehouse",
                    })}
                  </dt>
                  <dd className="mt-0.5 font-mono-code font-medium text-[var(--ink-primary)]">
                    {rawData.warehouse}
                  </dd>
                </div>
                <div>
                  <dt className="aios-micro-label">
                    {tx({
                      "zh-CN": "币种",
                      "zh-HK": "幣別",
                      en: "Currency",
                    })}
                  </dt>
                  <dd className="mt-0.5 font-mono-code font-medium text-[var(--ink-primary)]">
                    {rawData.currency}
                  </dd>
                </div>
                <div>
                  <dt className="aios-micro-label">
                    {tx({
                      "zh-CN": "发票金额",
                      "zh-HK": "發票金額",
                      en: "Amount",
                    })}
                  </dt>
                  <dd className="mt-0.5 font-mono-code text-[13.5px] font-semibold text-[var(--ink-primary)] tabular-nums">
                    {rawData.amount}
                  </dd>
                </div>
              </dl>
            </div>
          ) : result.tool === "shipment.read" && isShipmentView(rawData) ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-sm border border-[var(--accent-border)] bg-[var(--accent-wash)] text-[var(--accent-ink)]">
                    <Package className="h-4 w-4" strokeWidth={1.85} />
                  </span>
                  <span className="text-[14.5px] font-semibold tracking-[-0.01em] text-[var(--ink-primary)]">
                    {tx({
                      "zh-CN": "运单",
                      "zh-HK": "運單",
                      en: "Shipment",
                    })}{" "}
                    <span className="font-mono-code font-medium tabular-nums">
                      {rawData.shipment_id}
                    </span>
                  </span>
                </div>
                <StatusBadge status={rawData.status} compact />
              </div>
              <dl className="grid grid-cols-3 gap-3 rounded-tile border border-[var(--hairline)] bg-[var(--bg-surface-tint)] px-3.5 py-2.5 text-[12px]">
                <div>
                  <dt className="aios-micro-label">
                    {tx({
                      "zh-CN": "仓库",
                      "zh-HK": "倉庫",
                      en: "Warehouse",
                    })}
                  </dt>
                  <dd className="mt-0.5 font-mono-code font-medium text-[var(--ink-primary)]">
                    {rawData.warehouse}
                  </dd>
                </div>
                <div>
                  <dt className="aios-micro-label">
                    {tx({
                      "zh-CN": "计划交付日",
                      "zh-HK": "預計交付日",
                      en: "Delivery Date",
                    })}
                  </dt>
                  <dd className="mt-0.5 font-mono-code font-medium text-[var(--ink-primary)] tabular-nums">
                    {rawData.delivery_date}
                  </dd>
                </div>
                <div>
                  <dt className="aios-micro-label">
                    {tx({
                      "zh-CN": "记录版本",
                      "zh-HK": "紀錄版本",
                      en: "Version",
                    })}
                  </dt>
                  <dd className="mt-0.5 font-mono-code font-medium text-[var(--ink-primary)] tabular-nums">
                    v{rawData.version}
                  </dd>
                </div>
              </dl>
            </div>
          ) : result.tool === "decision.warehouse.summary" &&
            isWarehouseSummary(rawData) ? (
            <div className="flex flex-wrap items-center justify-between gap-4 rounded-tile border border-[var(--hairline)] bg-[var(--bg-surface-tint)] px-4 py-3">
              <div className="flex items-center gap-3">
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-sm border border-[var(--accent-border)] bg-[var(--accent-wash)] text-[var(--accent-ink)]">
                  <Warehouse className="h-4 w-4" strokeWidth={1.85} />
                </span>
                <div>
                  <div className="aios-micro-label">
                    {tx(
                      {
                        "zh-CN": "仓库 {wh} · 在途未关闭运单",
                        "zh-HK": "倉庫 {wh} · 進行中未關閉運單",
                        en: "Warehouse {wh} · Open Shipments",
                      },
                      { wh: rawData.warehouse },
                    )}
                  </div>
                  <div className="aios-kpi mt-0.5 text-[22px] font-semibold text-[var(--ink-primary)]">
                    {rawData.open_shipments}
                  </div>
                </div>
              </div>
              <div>
                <div className="aios-micro-label">
                  {tx({
                    "zh-CN": "统计基准日",
                    "zh-HK": "統計基準日",
                    en: "As of",
                  })}
                </div>
                <div className="mt-0.5 font-mono-code text-[12.5px] font-medium text-[var(--ink-secondary)] tabular-nums">
                  {rawData.as_of}
                </div>
              </div>
            </div>
          ) : result.tool === "mail.inbox.read" && isMailInboxView(rawData) ? (
            <div className="space-y-2.5">
              <div className="flex items-center gap-2 text-[12px] text-[var(--ink-muted)]">
                <Mail
                  className="h-3.5 w-3.5 text-[var(--accent)]"
                  strokeWidth={1.85}
                />
                <span>
                  {tp(
                    {
                      "zh-CN": "共 {count} 封邮件摘要",
                      "zh-HK": "共 {count} 封電郵摘要",
                      en: { one: "{count} message", other: "{count} messages" },
                    },
                    rawData.messages.length,
                  )}
                </span>
              </div>
              {rawData.messages.length === 0 ? (
                <div className="rounded-tile bg-[var(--bg-surface-tint)] px-3.5 py-3 text-[12.5px] text-[var(--ink-muted)]">
                  {tx({
                    "zh-CN": "当前收件箱暂无邮件记录。",
                    "zh-HK": "目前收件箱暫無電郵紀錄。",
                    en: "No messages in inbox.",
                  })}
                </div>
              ) : (
                <div className="divide-y divide-[var(--hairline-subtle)] rounded-tile bg-[var(--bg-surface-tint)]">
                  {rawData.messages.map((msg) => (
                    <div key={msg.id} className="px-3.5 py-2.5 text-[12.5px]">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-[var(--ink-primary)] break-words">
                          {msg.subject}
                        </span>
                        <span className="shrink-0 font-mono-code text-[10.5px] text-[var(--ink-muted)]">
                          {msg.id}
                        </span>
                      </div>
                      <div className="mt-0.5 text-[11px] text-[var(--ink-muted)]">
                        {tx({
                          "zh-CN": "发件人：",
                          "zh-HK": "寄件人：",
                          en: "From: ",
                        })}
                        <span className="font-mono-code">{msg.sender}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <dl className="divide-y divide-[var(--hairline-subtle)] rounded-tile bg-[var(--bg-surface-tint)] text-[12px]">
              {Object.entries(rawData).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3 px-3.5 py-2">
                  <dt className="font-mono-code text-[var(--ink-muted)]">{k}</dt>
                  <dd className="font-mono-code text-right text-[var(--ink-primary)] break-all">
                    {typeof v === "string" ||
                    typeof v === "number" ||
                    typeof v === "boolean"
                      ? String(v)
                      : JSON.stringify(v)}
                  </dd>
                </div>
              ))}
            </dl>
          )}

          <div className="mt-3.5 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--hairline-subtle)] pt-3">
            <span className="text-[11.5px] text-[var(--ink-muted)]">
              {tx({
                "zh-CN": "实时只读视图",
                "zh-HK": "即時唯讀檢視",
                en: "Live read-only view",
              })}
            </span>
            <Button
              size="sm"
              variant="quiet"
              pill
              data-testid="turn-result-open-drawer"
              onClick={(e) =>
                onInspectObject(buildDrawerSelection(), e.currentTarget)
              }
            >
              <PanelRightOpen className="h-3.5 w-3.5" strokeWidth={1.85} />
              <span>
                {tx({
                  "zh-CN": "在右侧核对",
                  "zh-HK": "於右側核對",
                  en: "Inspect",
                })}
              </span>
            </Button>
          </div>
        </div>
      </Interactive3DCard>
    );
  }

  if (result.kind === "proposal") {
    const { proposal } = result;
    const headline =
      proposal.state === "PROPOSED"
        ? tx({
            "zh-CN": "已生成待审提案",
            "zh-HK": "已產生待審提案",
            en: "Proposal Ready",
          })
        : tx(
            {
              "zh-CN": "提案状态 · {state}",
              "zh-HK": "提案狀態 · {state}",
              en: "Proposal · {state}",
            },
            { state: localizeStatus(proposal.state) },
          );

    return (
      <Interactive3DCard
        maxTilt={2.5}
        hoverLiftPx={-1}
        sheenIntensity="subtle"
        data-testid="turn-card-proposal"
        data-proposal-id={proposal.id}
        className="overflow-hidden rounded-card border border-[var(--hairline)] bg-[var(--bg-surface)] shadow-[var(--shadow-card)] hover:shadow-[var(--shadow-card-hover)]"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 bg-[var(--bg-surface-tint)] px-4 py-2.5 border-b border-[var(--hairline)]">
          <div className="flex items-center gap-2">
            <FileText
              className="h-3.5 w-3.5 text-[var(--accent)]"
              strokeWidth={1.85}
            />
            <span className="text-[13px] font-semibold text-[var(--ink-primary)]">
              {headline}
            </span>
          </div>
          <StatusBadge status={proposal.state} compact />
        </div>

        <div className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[12.5px]">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-[var(--ink-primary)]">
                {localizeAction(proposal.plan.action)}
              </span>
              <span className="rounded-xs border border-[var(--hairline)] bg-[var(--bg-surface-subtle)] px-2 py-0.5 font-mono-code text-[10.5px] text-[var(--ink-secondary)]">
                {proposal.warehouse}
              </span>
              <span
                title={proposal.id}
                className="font-mono-code text-[11.5px] tabular-nums text-[var(--ink-muted)]"
              >
                {formatShortDigest(proposal.id, 6, 4)}
              </span>
            </div>
            <span className="text-[11px] text-[var(--ink-muted)]">
              {tx({ "zh-CN": "摘要 ", "zh-HK": "摘要 ", en: "Digest " })}
              <span className="font-mono-code tabular-nums">
                {formatShortDigest(proposal.digest)}
              </span>
            </span>
          </div>

          {renderConciseDiff(proposal)}

          <div className="mt-3.5 flex flex-wrap items-center justify-end gap-2 border-t border-[var(--hairline-subtle)] pt-3">
            <Button
              size="sm"
              variant="quiet"
              pill
              data-testid="turn-proposal-open-drawer"
              onClick={(e) =>
                onInspectObject(
                  {
                    kind: "proposal",
                    id: proposal.id,
                    warehouse: proposal.warehouse,
                    title: localizeAction(proposal.plan.action),
                  },
                  e.currentTarget,
                )
              }
            >
              <PanelRightOpen className="h-3.5 w-3.5" strokeWidth={1.85} />
              <span>
                {tx({
                  "zh-CN": "右侧核对",
                  "zh-HK": "右側核對",
                  en: "Inspect",
                })}
              </span>
            </Button>
            <Link
              href={`/proposals/${encodeURIComponent(proposal.id)}`}
              data-testid="turn-proposal-open-page"
              className="inline-flex h-8 items-center gap-1 rounded-full bg-[var(--accent-solid)] px-3.5 text-[12.5px] font-medium text-[var(--accent-fg)] shadow-[var(--shadow-subtle)] hover:bg-[var(--accent-solid-hover)] transition-colors"
            >
              <span>
                {tx({
                  "zh-CN": "打开单据详情",
                  "zh-HK": "開啟單據詳情",
                  en: "Open Proposal",
                })}
              </span>
              <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.9} />
            </Link>
          </div>
        </div>
      </Interactive3DCard>
    );
  }

  if (result.kind === "message") {
    const pw = result.pending_work;
    const hasPendingWork = Boolean(
      pw &&
        (pw.pending_approvals > 0 ||
          pw.returned_proposals > 0 ||
          pw.unread_notices > 0 ||
          pw.open_submitted > 0 ||
          pw.meetings_today > 0 ||
          (pw.open_exceptions ?? 0) > 0),
    );

    return (
      <div data-testid="turn-card-message" className="space-y-3">
        <div className="rounded-card border border-[var(--hairline)] bg-[var(--bg-surface)] px-4 py-3.5 shadow-[var(--shadow-card)]">
          <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-[var(--hairline-subtle)]">
            <div className="flex items-center gap-1.5">
              <Sparkles
                className="h-3.5 w-3.5 text-[var(--accent)]"
                strokeWidth={1.9}
              />
              <span className="aios-micro-label">
                {result.mode === "proactive_reminder"
                  ? tx({
                      "zh-CN": "工作提醒与业务协同",
                      "zh-HK": "工作提醒與業務協同",
                      en: "Proactive Work Reminder",
                    })
                  : result.mode === "workflow_guidance"
                    ? tx({
                        "zh-CN": "业务指引",
                        "zh-HK": "業務指引",
                        en: "Workflow Guidance",
                      })
                    : result.mode === "email_draft"
                      ? tx({
                          "zh-CN": "邮件草稿助手",
                          "zh-HK": "電郵草稿助手",
                          en: "Email Draft Assistant",
                        })
                      : tx({
                          "zh-CN": "助手回复",
                          "zh-HK": "助手回覆",
                          en: "Agent Reply",
                        })}
              </span>
            </div>
            {timestamp && (
              <span className="font-mono-code text-[11px] text-[var(--ink-muted)] tabular-nums">
                {formatDateTime(timestamp)}
              </span>
            )}
          </div>

          <p className="mt-2.5 text-[14.5px] leading-[1.6] text-[var(--ink-primary)] whitespace-pre-wrap break-words">
            {result.reply}
          </p>

          {/* Unfinished Work Reminder Strip */}
          {hasPendingWork && pw && (
            <div
              data-testid="assistant-pending-work-strip"
              className="mt-3.5 rounded-tile border border-[var(--hairline)] bg-[var(--bg-surface-tint)] px-3.5 py-2.5 space-y-2"
            >
              <div className="flex items-center gap-1.5">
                <Bell className="h-3.5 w-3.5 text-[var(--accent)]" strokeWidth={1.9} />
                <span className="aios-micro-label">
                  {tx({
                    "zh-CN": "当前待办与未完成事项",
                    "zh-HK": "目前待辦與未完成事項",
                    en: "Unfinished Work Summary",
                  })}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
                {pw.pending_approvals > 0 && (
                  <Link
                    href="/work"
                    className="inline-flex items-center gap-1.5 rounded-sm border border-[var(--status-amber-border)] bg-[var(--status-amber-wash)] px-2.5 py-1 font-medium text-[var(--status-amber-ink)] hover:opacity-90 transition-opacity font-mono-code tabular-nums"
                  >
                    <span>
                      {tx(
                        {
                          "zh-CN": "待我审批 {count} 项",
                          "zh-HK": "待我審批 {count} 項",
                          en: "{count} pending approval(s)",
                        },
                        { count: pw.pending_approvals },
                      )}
                    </span>
                    <ArrowUpRight className="h-3 w-3" />
                  </Link>
                )}

                {pw.returned_proposals > 0 && (
                  <Link
                    href="/work"
                    className="inline-flex items-center gap-1.5 rounded-sm border border-[var(--status-crimson-border)] bg-[var(--status-crimson-wash)] px-2.5 py-1 font-medium text-[var(--status-crimson)] hover:opacity-90 transition-opacity font-mono-code tabular-nums"
                  >
                    <span>
                      {tx(
                        {
                          "zh-CN": "被退回修改 {count} 项",
                          "zh-HK": "被退回修改 {count} 項",
                          en: "{count} returned proposal(s)",
                        },
                        { count: pw.returned_proposals },
                      )}
                    </span>
                    <ArrowUpRight className="h-3 w-3" />
                  </Link>
                )}

                {pw.open_submitted > 0 && (
                  <Link
                    href="/work"
                    className="inline-flex items-center gap-1.5 rounded-sm border border-[var(--hairline)] bg-[var(--bg-surface)] px-2.5 py-1 font-medium text-[var(--ink-secondary)] hover:border-[var(--accent-border)] hover:text-[var(--accent-ink)] font-mono-code tabular-nums"
                  >
                    <span>
                      {tx(
                        {
                          "zh-CN": "我提交的进行中 {count} 项",
                          "zh-HK": "我提交的進行中 {count} 項",
                          en: "{count} open submitted",
                        },
                        { count: pw.open_submitted },
                      )}
                    </span>
                  </Link>
                )}

                {pw.unread_notices > 0 && (
                  <span className="inline-flex items-center gap-1 rounded-sm border border-[var(--accent-border)] bg-[var(--accent-wash)] px-2.5 py-1 font-medium text-[var(--accent-ink)] font-mono-code tabular-nums">
                    {tx(
                      {
                        "zh-CN": "未读通知 {count} 条",
                        "zh-HK": "未讀通知 {count} 則",
                        en: "{count} unread notice(s)",
                      },
                      { count: pw.unread_notices },
                    )}
                  </span>
                )}

                {pw.meetings_today > 0 && (
                  <Link
                    href="/calendar"
                    className="inline-flex items-center gap-1 rounded-sm border border-[var(--hairline)] bg-[var(--bg-surface)] px-2.5 py-1 font-medium text-[var(--ink-secondary)] hover:border-[var(--accent-border)] hover:text-[var(--accent-ink)] font-mono-code tabular-nums"
                  >
                    <Calendar className="h-3 w-3 text-[var(--accent)]" />
                    <span>
                      {tx(
                        {
                          "zh-CN": "今日会议 {count} 场",
                          "zh-HK": "今日會議 {count} 場",
                          en: "{count} meeting(s) today",
                        },
                        { count: pw.meetings_today },
                      )}
                    </span>
                  </Link>
                )}

                {(pw.open_exceptions ?? 0) > 0 && (
                  <Link
                    href="/admin/exceptions"
                    className="inline-flex items-center gap-1 rounded-sm border border-[var(--status-crimson-border)] bg-[var(--status-crimson-wash)] px-2.5 py-1 font-medium text-[var(--status-crimson)] hover:opacity-90 font-mono-code tabular-nums"
                  >
                    <AlertTriangle className="h-3 w-3" />
                    <span>
                      {tx(
                        {
                          "zh-CN": "异常单据 {count} 项",
                          "zh-HK": "異常單據 {count} 項",
                          en: "{count} exception(s)",
                        },
                        { count: pw.open_exceptions ?? 0 },
                      )}
                    </span>
                  </Link>
                )}
              </div>

              {pw.pending_approval_ids.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 pt-0.5 text-[11px]">
                  <span className="text-[var(--ink-muted)]">
                    {tx({
                      "zh-CN": "待审单号：",
                      "zh-HK": "待審單號：",
                      en: "Proposals:",
                    })}
                  </span>
                  {pw.pending_approval_ids.slice(0, 4).map((pid) => (
                    <Link
                      key={pid}
                      href={`/proposals/${encodeURIComponent(pid)}`}
                      className="rounded-xs border border-[var(--hairline)] bg-[var(--bg-surface)] px-2 py-0.5 font-mono-code tabular-nums font-medium text-[var(--accent-ink)] hover:border-[var(--accent-border)] hover:bg-[var(--accent-wash)] transition-colors"
                    >
                      {formatShortDigest(pid, 6, 4)}
                    </Link>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Suggested Action Pills */}
          {result.suggested_actions.length > 0 && (
            <div className="mt-3.5 flex flex-wrap gap-1.5 border-t border-[var(--hairline-subtle)] pt-3">
              {result.suggested_actions.map((action) =>
                action.kind === "navigate" ? (
                  <Link
                    key={action.id}
                    href={action.href || "/work"}
                    data-testid={`suggested-action-${action.id}`}
                    className="inline-flex items-center gap-1.5 rounded-sm border border-[var(--hairline)] bg-[var(--bg-surface-subtle)] px-3 py-1.5 text-[12px] font-medium text-[var(--ink-primary)] hover:border-[var(--accent-border)] hover:bg-[var(--accent-wash)] hover:text-[var(--accent-ink)] transition-colors"
                  >
                    <span>{action.label}</span>
                    <ArrowUpRight className="h-3 w-3" />
                  </Link>
                ) : (
                  <button
                    key={action.id}
                    type="button"
                    data-testid={`suggested-action-${action.id}`}
                    onClick={() => {
                      if (onSelectSuggestedAction) {
                        onSelectSuggestedAction(action);
                      } else if (onSelectClarification && action.command) {
                        onSelectClarification(action.command);
                      }
                    }}
                    className="inline-flex items-center gap-1.5 rounded-sm border border-[var(--hairline)] bg-[var(--bg-surface-subtle)] px-3 py-1.5 text-[12px] font-medium text-[var(--ink-primary)] hover:border-[var(--accent-border)] hover:bg-[var(--accent-wash)] hover:text-[var(--accent-ink)] transition-colors cursor-pointer"
                  >
                    {action.kind === "email" && (
                      <Mail className="h-3 w-3 text-[var(--accent)]" />
                    )}
                    <span>{action.label}</span>
                  </button>
                ),
              )}
            </div>
          )}
        </div>

        {result.email_draft && (
          <EmailComposeCard
            draft={result.email_draft}
            initialSent={initialEmailSent}
            onSent={onEmailSent}
          />
        )}
      </div>
    );
  }

  if (result.kind === "refusal") {
    const isSevere =
      result.severity === "critical" || result.severity === "high";
    const severityLabel =
      result.severity === "critical"
        ? tx({ "zh-CN": "严重", "zh-HK": "嚴重", en: "Critical" })
        : result.severity === "high"
          ? tx({ "zh-CN": "高风险", "zh-HK": "高風險", en: "High" })
          : tx({ "zh-CN": "受限", "zh-HK": "受限", en: "Medium" });

    return (
      <div
        role="alert"
        data-testid="turn-card-refusal"
        className={[
          "overflow-hidden rounded-card border bg-[var(--bg-surface)] shadow-[var(--shadow-card)]",
          isSevere
            ? "border-[var(--status-crimson-border)]"
            : "border-[var(--status-amber-border)]",
        ].join(" ")}
      >
        <div
          className={[
            "flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 border-b",
            isSevere
              ? "bg-[var(--status-crimson-wash)] border-[var(--status-crimson-border)]"
              : "bg-[var(--status-amber-wash)] border-[var(--status-amber-border)]",
          ].join(" ")}
        >
          <div className="flex items-center gap-2">
            <ShieldAlert
              className={[
                "h-4 w-4 shrink-0",
                isSevere
                  ? "text-[var(--status-crimson)]"
                  : "text-[var(--status-amber-ink)]",
              ].join(" ")}
              strokeWidth={1.9}
            />
            <span className="text-[13px] font-semibold text-[var(--ink-primary)]">
              {tx({
                "zh-CN": "策略边界保护通知",
                "zh-HK": "策略邊界保護通知",
                en: "Policy Boundary Notice",
              })}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="rounded-xs border border-[var(--hairline)] bg-[var(--bg-surface)] px-2 py-0.5 font-mono-code text-[10.5px] font-medium text-[var(--ink-secondary)]">
              {result.category}
            </span>
            <span
              className={[
                "inline-flex items-center gap-1.5 rounded-xs border px-2 py-0.5 font-mono-code text-[10.5px] font-semibold",
                isSevere
                  ? "border-[var(--status-crimson-border)] bg-[var(--status-crimson-wash)] text-[var(--status-crimson)]"
                  : "border-[var(--status-amber-border)] bg-[var(--status-amber-wash)] text-[var(--status-amber-ink)]",
              ].join(" ")}
            >
              <span
                aria-hidden="true"
                className={[
                  "h-1.5 w-1.5 rounded-full",
                  isSevere
                    ? "bg-[var(--status-crimson)]"
                    : "bg-[var(--status-amber)]",
                ].join(" ")}
              />
              <span>{severityLabel}</span>
            </span>
          </div>
        </div>

        <div className="p-4 space-y-3">
          <p className="text-[13.5px] leading-relaxed text-[var(--ink-primary)] break-words">
            {result.message}
          </p>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--hairline-subtle)] pt-3 text-[11.5px]">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[var(--ink-muted)]">
                {tx({
                  "zh-CN": "当前已授权模块：",
                  "zh-HK": "目前已授權模組：",
                  en: "Authorized modules:",
                })}
              </span>
              {result.allowed_modules.length > 0 ? (
                result.allowed_modules.map((mod) => (
                  <span
                    key={mod}
                    className="rounded-xs border border-[var(--hairline)] bg-[var(--bg-surface-subtle)] px-2 py-0.5 font-mono-code text-[10.5px] text-[var(--ink-secondary)]"
                  >
                    {mod}
                  </span>
                ))
              ) : (
                <span className="text-[var(--ink-muted)]">
                  {tx({
                    "zh-CN": "仅基础协作对话",
                    "zh-HK": "僅基礎協作對話",
                    en: "Basic assistant only",
                  })}
                </span>
              )}
            </div>

            <span className="font-mono-code text-[11px] text-[var(--ink-muted)] tabular-nums">
              {tx({ "zh-CN": "事件编号 ", "zh-HK": "事件編號 ", en: "Incident " })}
              {result.incident_id}
            </span>
          </div>
        </div>
      </div>
    );
  }

  const { proposal } = result;
  return (
    <Interactive3DCard
      maxTilt={2.5}
      hoverLiftPx={-1}
      sheenIntensity="subtle"
      data-testid="turn-card-approval-preview"
      data-proposal-id={proposal.id}
      className="overflow-hidden rounded-card border border-[var(--accent-border)] bg-[var(--bg-surface)] shadow-[var(--shadow-card)]"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--accent-border)] bg-[var(--accent-wash)] px-4 py-2.5">
        <div className="flex items-center gap-2">
          <CheckSquare
            className="h-3.5 w-3.5 text-[var(--accent-ink)]"
            strokeWidth={1.9}
          />
          <span className="text-[13px] font-semibold text-[var(--ink-primary)]">
            {tx({
              "zh-CN": "审批快照预览 · 需核对摘要后确认",
              "zh-HK": "審批快照預覽 · 須核對摘要後確認",
              en: "Approval Preview · Verify Digest Before Confirming",
            })}
          </span>
        </div>
        <StatusBadge status={proposal.state} compact />
      </div>

      <div className="p-4">
        <div className="grid grid-cols-2 gap-3 rounded-tile border border-[var(--hairline)] bg-[var(--bg-surface-tint)] px-3.5 py-2.5 text-[12px] sm:grid-cols-3">
          <div>
            <div className="aios-micro-label">
              {tx({
                "zh-CN": "单据编号",
                "zh-HK": "單據編號",
                en: "Proposal ID",
              })}
            </div>
            <div
              title={proposal.id}
              className="mt-0.5 font-mono-code tabular-nums font-medium text-[var(--ink-primary)]"
            >
              {formatShortDigest(proposal.id, 6, 4)}
            </div>
          </div>
          <div>
            <div className="aios-micro-label">
              {tx({
                "zh-CN": "发起人 / 仓库",
                "zh-HK": "發起人 / 倉庫",
                en: "Requester / Warehouse",
              })}
            </div>
            <div
              title={proposal.requester}
              className="mt-0.5 text-[var(--ink-primary)]"
            >
              <span className="font-medium">
                {localizePersona(proposal.requester).displayName}
              </span>
              <span> · </span>
              <span className="font-mono-code">{proposal.warehouse}</span>
            </div>
          </div>
          <div>
            <div className="aios-micro-label">
              {tx({
                "zh-CN": "摘要锁",
                "zh-HK": "摘要鎖",
                en: "Digest lock",
              })}
            </div>
            <div className="mt-0.5 font-mono-code tabular-nums text-[var(--ink-primary)]">
              {formatShortDigest(proposal.digest)}
            </div>
          </div>
        </div>

        {renderConciseDiff(proposal)}

        <p className="mt-3 text-[12px] text-[var(--ink-muted)]">
          {tx({
            "zh-CN": "正式批准、退回或拒绝需在单据详情页核对摘要后显式确认。",
            "zh-HK": "正式批准、退回或拒絕須於單據詳情頁核對摘要後明確確認。",
            en: "Approving, returning, or rejecting requires verifying the digest on the proposal page.",
          })}
        </p>

        <div className="mt-3.5 flex flex-wrap items-center justify-end gap-2 border-t border-[var(--hairline-subtle)] pt-3">
          <Button
            size="sm"
            variant="quiet"
            pill
            data-testid="turn-approval-preview-drawer"
            onClick={(e) =>
              onInspectObject(
                {
                  kind: "proposal",
                  id: proposal.id,
                  warehouse: proposal.warehouse,
                  title: tx({
                    "zh-CN": "审批核对预览",
                    "zh-HK": "審批核對預覽",
                    en: "Approval Preview",
                  }),
                },
                e.currentTarget,
              )
            }
          >
            <PanelRightOpen className="h-3.5 w-3.5" strokeWidth={1.85} />
            <span>
              {tx({
                "zh-CN": "右侧预览",
                "zh-HK": "右側預覽",
                en: "Preview",
              })}
            </span>
          </Button>
          <Link
            href={`/proposals/${encodeURIComponent(proposal.id)}`}
            data-testid="turn-approval-open-formal"
            className="inline-flex h-8 items-center gap-1 rounded-full bg-[var(--accent-solid)] px-3.5 text-[12.5px] font-medium text-[var(--accent-fg)] shadow-[var(--shadow-subtle)] hover:bg-[var(--accent-solid-hover)] transition-colors"
          >
            <span>
              {tx({
                "zh-CN": "前往正式审批页确认",
                "zh-HK": "前往正式審批頁確認",
                en: "Review & Approve",
              })}
            </span>
            <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.9} />
          </Link>
        </div>
      </div>
    </Interactive3DCard>
  );
}
