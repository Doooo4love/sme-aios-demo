"use client";

import React, { useMemo, useState } from "react";
import { ArrowRight, Check, Copy, Maximize2 } from "lucide-react";
import { formatShortDigest } from "@/lib/format";
import {
  DEFAULT_LOCALE,
  localizeStatusForLocale,
  translateInline,
  translateKey,
  useLocale,
  type Locale,
  type TrilingualText,
} from "@/lib/i18n";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import type {
  Plan,
  SalesOrderLinePlan,
  SalesOrderPlanAfter,
  SalesOrderPlanBefore,
  ShipmentReschedulePlanAfter,
  ShipmentView,
} from "@/lib/types";

export interface DiffRowItem {
  key: string;
  label: string;
  before: string;
  after: string;
  changed: boolean;
  mono?: boolean;
  /** Full raw value when `before`/`after` are displayed shortened (enables tooltip + copy) */
  rawValue?: string;
}

export interface ProposalDiffViewProps {
  plan: Plan;
  proposalId?: string;
  compact?: boolean;
  className?: string;
}

function asString(v: unknown, fallback = "—"): string {
  if (v === null || v === undefined || v === "") return fallback;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return fallback;
}

const UOM_LABELS_I18N: Readonly<Record<string, TrilingualText>> = {
  CASE: { "zh-CN": "箱", "zh-HK": "箱", en: "Case" },
  CS: { "zh-CN": "箱", "zh-HK": "箱", en: "Case" },
  CARTON: { "zh-CN": "箱", "zh-HK": "箱", en: "Carton" },
  CTN: { "zh-CN": "箱", "zh-HK": "箱", en: "Carton" },
  EACH: { "zh-CN": "件", "zh-HK": "件", en: "Each" },
  EA: { "zh-CN": "件", "zh-HK": "件", en: "Each" },
  PCS: { "zh-CN": "件", "zh-HK": "件", en: "Pcs" },
  PC: { "zh-CN": "件", "zh-HK": "件", en: "Pc" },
  UNIT: { "zh-CN": "件", "zh-HK": "件", en: "Unit" },
  PACK: { "zh-CN": "包", "zh-HK": "包", en: "Pack" },
  PK: { "zh-CN": "包", "zh-HK": "包", en: "Pack" },
  BOX: { "zh-CN": "盒", "zh-HK": "盒", en: "Box" },
  PALLET: { "zh-CN": "托盘", "zh-HK": "卡板", en: "Pallet" },
  PLT: { "zh-CN": "托盘", "zh-HK": "卡板", en: "Pallet" },
  KG: { "zh-CN": "千克", "zh-HK": "公斤", en: "kg" },
  G: { "zh-CN": "克", "zh-HK": "克", en: "g" },
};

export function localizeUom(
  uom: string,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const normalized = uom.trim().toUpperCase();
  const entry = UOM_LABELS_I18N[normalized];
  return entry ? entry[locale] : uom;
}

function isPlaceholderBefore(before: string): boolean {
  return before === "—" || before === "";
}

export function extractSalesOrderAfter(
  plan: Plan,
): SalesOrderPlanAfter | null {
  if (plan.action !== "sales_order.create_draft") return null;
  const after = plan.after as Partial<SalesOrderPlanAfter>;
  if (!after || typeof after !== "object") return null;
  return {
    po: asString(after.po),
    buyer: asString(after.buyer),
    currency: asString(after.currency),
    legal_entity: asString(after.legal_entity, plan.warehouse),
    delivery: asString(after.delivery),
    total: asString(after.total),
    items: Array.isArray(after.items)
      ? (after.items as SalesOrderLinePlan[])
      : [],
  };
}

export function extractSalesOrderBefore(
  plan: Plan,
): SalesOrderPlanBefore | null {
  if (plan.action !== "sales_order.create_draft") return null;
  const before = plan.before as Partial<SalesOrderPlanBefore>;
  if (!before || typeof before !== "object") return null;
  return {
    intake_id: asString(before.intake_id, ""),
    source_sha256: asString(before.source_sha256, ""),
  };
}

export function buildPlanDiffRows(
  plan: Plan,
  locale: Locale = DEFAULT_LOCALE,
): DiffRowItem[] {
  if (plan.action === "shipment.reschedule") {
    const before = plan.before as Partial<ShipmentView>;
    const after = plan.after as Partial<ShipmentReschedulePlanAfter>;
    const beforeDate = asString(before.delivery_date);
    const afterDate = asString(after.delivery_date);
    const statusRaw = asString(before.status);
    const statusLabel =
      statusRaw !== "—"
        ? localizeStatusForLocale(statusRaw, locale)
        : statusRaw;
    return [
      {
        key: "shipment_id",
        label: translateKey(locale, "proposal.diff.field.shipmentId"),
        before: asString(before.shipment_id, plan.target),
        after: asString(before.shipment_id, plan.target),
        changed: false,
        mono: true,
      },
      {
        key: "warehouse",
        label: translateInline(locale, {
          "zh-CN": "仓库",
          "zh-HK": "倉庫",
          en: "Warehouse",
        }),
        before: asString(before.warehouse, plan.warehouse),
        after: plan.warehouse,
        changed: false,
        mono: true,
      },
      {
        key: "status",
        label: translateKey(locale, "proposal.diff.field.status"),
        before: statusLabel,
        after: statusLabel,
        changed: false,
        mono: false,
      },
      {
        key: "expected_version",
        label: translateKey(locale, "proposal.diff.field.expectedVersion"),
        before: `v${asString(before.version ?? plan.expected_version, "—")}`,
        after:
          typeof before.version === "number"
            ? `v${before.version + 1}`
            : `v${asString(plan.expected_version, "—")}`,
        changed: true,
        mono: true,
      },
      {
        key: "delivery_date",
        label: translateKey(locale, "proposal.diff.field.deliveryDate"),
        before: beforeDate,
        after: afterDate,
        changed: beforeDate !== afterDate,
        mono: true,
      },
    ];
  }

  if (plan.action === "sales_order.create_draft") {
    const before = extractSalesOrderBefore(plan);
    const after = extractSalesOrderAfter(plan);
    const legalEntityDisplay =
      after && after.legal_entity && after.legal_entity !== plan.warehouse
        ? `${after.legal_entity} (${plan.warehouse})`
        : plan.warehouse;
    const rawIntakeId = before?.intake_id || "";
    const shortIntakeId = rawIntakeId
      ? formatShortDigest(rawIntakeId, 6, 5)
      : "—";
    const rawSourceHash = before?.source_sha256 || "";
    const shortSourceHash = rawSourceHash
      ? formatShortDigest(rawSourceHash, 6, 5)
      : "—";

    const rows: DiffRowItem[] = [
      {
        key: "legal_entity",
        label: translateInline(locale, {
          "zh-CN": "法人实体 / 仓库",
          "zh-HK": "法人實體 / 倉庫",
          en: "Legal Entity / Warehouse",
        }),
        before: plan.warehouse,
        after: legalEntityDisplay,
        changed: false,
        mono: true,
      },
      {
        key: "po",
        label: translateKey(locale, "proposal.diff.field.po"),
        before: "—",
        after: after?.po ?? "—",
        changed: true,
        mono: true,
      },
      {
        key: "buyer",
        label: translateKey(locale, "proposal.diff.field.buyer"),
        before: "—",
        after: after?.buyer ?? "—",
        changed: true,
        mono: true,
      },
      {
        key: "delivery",
        label: translateInline(locale, {
          "zh-CN": "交付日期",
          "zh-HK": "交付日期",
          en: "Delivery Date",
        }),
        before: "—",
        after: after?.delivery ?? "—",
        changed: true,
        mono: true,
      },
      {
        key: "total",
        label: translateKey(locale, "proposal.diff.field.total"),
        before: "—",
        after: after ? `${after.currency} ${after.total}` : "—",
        changed: true,
        mono: true,
      },
      {
        key: "intake_id",
        label: translateKey(locale, "proposal.diff.field.intakeId"),
        before: shortIntakeId,
        after: shortIntakeId,
        changed: false,
        mono: true,
        rawValue: rawIntakeId || undefined,
      },
      {
        key: "source_sha256",
        label: translateKey(locale, "proposal.diff.field.sourceSha"),
        before: shortSourceHash,
        after: shortSourceHash,
        changed: false,
        mono: true,
        rawValue: rawSourceHash || undefined,
      },
    ];
    return rows;
  }

  // Generic fallback for unknown plan shapes
  const allKeys = Array.from(
    new Set([
      ...Object.keys(plan.before ?? {}),
      ...Object.keys(plan.after ?? {}),
    ]),
  );
  return allKeys.map((key) => {
    const b = asString(plan.before?.[key]);
    const a = asString(plan.after?.[key]);
    return {
      key,
      label: key,
      before: b,
      after: a,
      changed: b !== a,
      mono: true,
    };
  });
}

export function summarizePlanChange(
  plan: Plan,
  locale: Locale = DEFAULT_LOCALE,
): string {
  if (plan.action === "shipment.reschedule") {
    const before = plan.before as Partial<ShipmentView>;
    const after = plan.after as Partial<ShipmentReschedulePlanAfter>;
    return translateInline(
      locale,
      {
        "zh-CN": "运单 {target} 交期：{from} → {to}",
        "zh-HK": "運單 {target} 交期：{from} → {to}",
        en: "Shipment {target} delivery: {from} → {to}",
      },
      {
        target: plan.target,
        from: asString(before.delivery_date),
        to: asString(after.delivery_date),
      },
    );
  }
  const after = extractSalesOrderAfter(plan);
  if (after) {
    const sep = locale === "en" ? "; " : "；";
    const itemSummary = after.items
      .map(
        (item) =>
          `${item.source_sku} (${item.source_quantity} ${localizeUom(item.source_uom, locale)} → ${item.erp_quantity} ${localizeUom(item.erp_uom, locale)})`,
      )
      .join(sep);
    return translateInline(
      locale,
      {
        "zh-CN": "PO {po} · 总额 {currency} {total}{items}",
        "zh-HK": "PO {po} · 總額 {currency} {total}{items}",
        en: "PO {po} · Total {currency} {total}{items}",
      },
      {
        po: after.po,
        currency: after.currency,
        total: after.total,
        items: itemSummary ? ` · ${itemSummary}` : "",
      },
    );
  }
  return `${plan.action} · ${plan.target}`;
}

export function ProposalDiffView({
  plan,
  proposalId,
  compact = false,
  className = "",
}: ProposalDiffViewProps) {
  const { locale, t, tx, tp } = useLocale();
  const [fullscreenOpen, setFullscreenOpen] = useState(false);
  const [copiedRowKey, setCopiedRowKey] = useState<string | null>(null);

  const diffRows = useMemo(
    () => buildPlanDiffRows(plan, locale),
    [plan, locale],
  );
  const salesOrderAfter = useMemo(() => extractSalesOrderAfter(plan), [plan]);

  const handleCopyRaw = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedRowKey(key);
      window.setTimeout(() => {
        setCopiedRowKey((prev) => (prev === key ? null : prev));
      }, 1500);
    } catch {
      // Clipboard may be restricted
    }
  };

  return (
    <div
      className={[
        "rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] overflow-hidden",
        className,
      ].join(" ")}
      data-testid="proposal-diff-view"
    >
      <div className="flex items-center justify-between gap-2 border-b border-[var(--hairline)] px-4.5 py-3">
        <div className="min-w-0">
          <h3 className="text-[13.5px] font-semibold text-[var(--ink-primary)]">
            {t("proposal.diff.title")}
          </h3>
        </div>
        <Button
          size="sm"
          pill
          variant="secondary"
          onClick={() => setFullscreenOpen(true)}
          data-testid="proposal-fullscreen-diff-btn"
        >
          <Maximize2 className="h-3 w-3" strokeWidth={1.85} />
          <span>{t("proposal.diff.fullscreenBtn")}</span>
        </Button>
      </div>

      {/* Vertical Diff Layout for Narrow Drawer / Compact View */}
      {compact ? (
        <div className="divide-y divide-[var(--hairline-subtle)]">
          {diffRows.map((row) => (
            <div
              key={row.key}
              data-testid="proposal-diff-row"
              data-diff-field={row.key}
              className={[
                "px-4 py-2.5 text-[12px]",
                row.changed ? "bg-[var(--bg-surface-tint)]/75" : "",
              ].join(" ")}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11.5px] font-medium text-[var(--ink-muted)]">
                  {row.label}
                </span>
                {row.changed && (
                  <span className="rounded-full bg-[var(--accent-wash)] px-2 py-0.5 text-[10.5px] font-medium text-[var(--accent-ink)]">
                    {t("proposal.diff.changedBadge")}
                  </span>
                )}
              </div>
              {row.changed ? (
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 font-mono-code text-[12px]">
                  <span
                    className={[
                      "text-[var(--ink-muted)]",
                      !isPlaceholderBefore(row.before) ? "line-through" : "",
                    ].join(" ")}
                  >
                    {row.before}
                  </span>
                  <ArrowRight
                    className="h-3 w-3 shrink-0 text-[var(--accent)]"
                    strokeWidth={1.9}
                  />
                  <span className="rounded-xs bg-[var(--accent-wash)] px-2 py-0.5 font-semibold text-[var(--accent-ink)]">
                    {row.after}
                  </span>
                </div>
              ) : (
                <div className="mt-0.5 flex items-center gap-1.5 font-mono-code text-[12px] text-[var(--ink-primary)]">
                  <span title={row.rawValue ?? row.after} className="truncate">
                    {row.after}
                  </span>
                  {row.rawValue && (
                    <button
                      type="button"
                      onClick={() => void handleCopyRaw(row.key, row.rawValue!)}
                      title={tx(
                        {
                          "zh-CN": "复制完整值 {val}",
                          "zh-HK": "複製完整值 {val}",
                          en: "Copy full value {val}",
                        },
                        { val: row.rawValue },
                      )}
                      aria-label={tx(
                        {
                          "zh-CN": "复制 {label}",
                          "zh-HK": "複製 {label}",
                          en: "Copy {label}",
                        },
                        { label: row.label },
                      )}
                      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[var(--ink-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--ink-primary)] cursor-pointer"
                    >
                      {copiedRowKey === row.key ? (
                        <Check className="h-3 w-3 text-[var(--status-emerald)]" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        /* Precision 3-Column Comparison Table on Desktop */
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-[13px]">
            <thead>
              <tr className="aios-micro-label border-b border-[var(--hairline)] bg-[var(--bg-surface-tint)]">
                <th className="px-4.5 py-2.5 font-medium w-[28%]">
                  {t("proposal.diff.colField")}
                </th>
                <th className="px-4 py-2.5 font-medium w-[32%]">
                  {t("proposal.diff.colBefore")}
                </th>
                <th className="px-4.5 py-2.5 font-medium w-[40%]">
                  {t("proposal.diff.colAfter")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--hairline-subtle)]">
              {diffRows.map((row) => (
                <tr
                  key={row.key}
                  data-testid="proposal-diff-row"
                  data-diff-field={row.key}
                  className="hover:bg-[var(--bg-surface-tint)]/65 transition-colors duration-[150ms]"
                >
                  <td className="px-4.5 py-3 font-medium text-[var(--ink-secondary)]">
                    {row.label}
                  </td>
                  <td
                    className={[
                      "px-4 py-3 text-[var(--ink-muted)]",
                      row.mono ? "font-mono-code" : "tabular-nums",
                      row.changed && !isPlaceholderBefore(row.before)
                        ? "line-through"
                        : "",
                    ].join(" ")}
                  >
                    {row.rawValue ? (
                      <span className="inline-flex items-center gap-1.5">
                        <span title={row.rawValue}>{row.before}</span>
                        <button
                          type="button"
                          onClick={() =>
                            void handleCopyRaw(
                              `${row.key}-before`,
                              row.rawValue!,
                            )
                          }
                          title={tx(
                            {
                              "zh-CN": "复制完整值 {val}",
                              "zh-HK": "複製完整值 {val}",
                              en: "Copy full value {val}",
                            },
                            { val: row.rawValue },
                          )}
                          aria-label={tx(
                            {
                              "zh-CN": "复制 {label}",
                              "zh-HK": "複製 {label}",
                              en: "Copy {label}",
                            },
                            { label: row.label },
                          )}
                          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[var(--ink-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--ink-primary)] transition-colors cursor-pointer"
                        >
                          {copiedRowKey === `${row.key}-before` ? (
                            <Check className="h-3 w-3 text-[var(--status-emerald)]" />
                          ) : (
                            <Copy className="h-3 w-3" />
                          )}
                        </button>
                      </span>
                    ) : (
                      row.before
                    )}
                  </td>
                  <td
                    className={[
                      "px-4.5 py-3",
                      row.mono ? "font-mono-code" : "tabular-nums",
                    ].join(" ")}
                  >
                    {row.changed ? (
                      <span className="inline-block rounded-xs bg-[var(--accent-wash)] px-2 py-0.5 font-semibold text-[var(--accent-ink)]">
                        {row.after}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-[var(--ink-primary)]">
                        <span title={row.rawValue ?? row.after}>
                          {row.after}
                        </span>
                        {row.rawValue && (
                          <button
                            type="button"
                            onClick={() =>
                              void handleCopyRaw(
                                `${row.key}-after`,
                                row.rawValue!,
                              )
                            }
                            title={tx(
                              {
                                "zh-CN": "复制完整值 {val}",
                                "zh-HK": "複製完整值 {val}",
                                en: "Copy full value {val}",
                              },
                              { val: row.rawValue },
                            )}
                            aria-label={tx(
                              {
                                "zh-CN": "复制 {label}",
                                "zh-HK": "複製 {label}",
                                en: "Copy {label}",
                              },
                              { label: row.label },
                            )}
                            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[var(--ink-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--ink-primary)] transition-colors cursor-pointer"
                          >
                            {copiedRowKey === `${row.key}-after` ? (
                              <Check className="h-3 w-3 text-[var(--status-emerald)]" />
                            ) : (
                              <Copy className="h-3 w-3" />
                            )}
                          </button>
                        )}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Sales Order Line Items Mapping (Source SKU/UOM -> ERP SKU/UOM) */}
      {salesOrderAfter && salesOrderAfter.items.length > 0 && (
        <div className="border-t border-[var(--hairline)]">
          <div className="flex items-center justify-between bg-[var(--bg-surface-tint)] px-4.5 py-2.5 text-[12px] font-semibold text-[var(--ink-secondary)] border-b border-[var(--hairline-subtle)]">
            <span>
              {tx({
                "zh-CN": "订单明细行换算（源单据 → ERP 标准单位）",
                "zh-HK": "訂單明細行換算（源單據 → ERP 標準單位）",
                en: "Line Item Mapping (Source → ERP UOM)",
              })}
            </span>
            <span className="tabular-nums text-[11.5px] font-normal text-[var(--ink-muted)]">
              {tp(
                {
                  "zh-CN": "{count} 行",
                  "zh-HK": "{count} 行",
                  en: { one: "{count} line", other: "{count} lines" },
                },
                salesOrderAfter.items.length,
              )}
            </span>
          </div>

          {compact ? (
            <div className="divide-y divide-[var(--hairline-subtle)]">
              {salesOrderAfter.items.map((item, idx) => (
                <div
                  key={`${item.source_sku}-${idx}`}
                  data-testid="proposal-diff-line-row"
                  className="px-4 py-2.5 text-[12px] space-y-1"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono-code font-semibold text-[var(--ink-primary)]">
                      {item.source_sku} → {item.sku}
                    </span>
                    <span className="font-mono-code tabular-nums font-semibold text-[var(--ink-primary)]">
                      {salesOrderAfter.currency} {item.line_total}
                    </span>
                  </div>
                  <div className="tabular-nums text-[11.5px] text-[var(--ink-muted)]">
                    <span title={item.source_uom}>
                      <span className="font-mono-code">
                        {item.source_quantity}
                      </span>{" "}
                      {localizeUom(item.source_uom, locale)}
                    </span>{" "}
                    →{" "}
                    <span
                      title={item.erp_uom}
                      className="rounded-xs bg-[var(--accent-wash)] px-1.5 py-0.5 font-semibold text-[var(--accent-ink)]"
                    >
                      <span className="font-mono-code">
                        {item.erp_quantity}
                      </span>{" "}
                      {localizeUom(item.erp_uom, locale)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-[12.5px]">
                <thead>
                  <tr className="border-b border-[var(--hairline-subtle)] bg-[var(--bg-surface-tint)]/60 text-[11.5px] text-[var(--ink-muted)]">
                    <th className="px-4.5 py-2 font-medium">
                      {tx({
                        "zh-CN": "源 SKU",
                        "zh-HK": "源 SKU",
                        en: "Source SKU",
                      })}
                    </th>
                    <th className="px-3.5 py-2 font-medium">ERP SKU</th>
                    <th className="px-3.5 py-2 font-medium text-right">
                      {tx({
                        "zh-CN": "源数量 / 单位",
                        "zh-HK": "源數量 / 單位",
                        en: "Source Qty / UOM",
                      })}
                    </th>
                    <th className="px-3.5 py-2 font-medium text-right">
                      {tx({
                        "zh-CN": "ERP 数量 / 单位",
                        "zh-HK": "ERP 數量 / 單位",
                        en: "ERP Qty / UOM",
                      })}
                    </th>
                    <th className="px-4.5 py-2 font-medium text-right">
                      {tx(
                        {
                          "zh-CN": "行小计 ({currency})",
                          "zh-HK": "行小計 ({currency})",
                          en: "Subtotal ({currency})",
                        },
                        { currency: salesOrderAfter.currency },
                      )}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--hairline-subtle)]">
                  {salesOrderAfter.items.map((item, idx) => (
                    <tr
                      key={`${item.source_sku}-${idx}`}
                      data-testid="proposal-diff-line-row"
                    >
                      <td className="px-4.5 py-3 font-mono-code text-[var(--ink-secondary)]">
                        {item.source_sku}
                      </td>
                      <td className="px-3.5 py-3 font-mono-code font-medium text-[var(--ink-primary)]">
                        {item.sku}
                      </td>
                      <td
                        title={item.source_uom}
                        className="px-3.5 py-3 tabular-nums text-right text-[var(--ink-muted)]"
                      >
                        <span className="font-mono-code">
                          {item.source_quantity}
                        </span>{" "}
                        {localizeUom(item.source_uom, locale)}
                      </td>
                      <td className="px-3.5 py-3 tabular-nums text-right">
                        <span
                          title={item.erp_uom}
                          className="rounded-xs bg-[var(--accent-wash)] px-2 py-0.5 font-semibold text-[var(--accent-ink)]"
                        >
                          <span className="font-mono-code">
                            {item.erp_quantity}
                          </span>{" "}
                          {localizeUom(item.erp_uom, locale)}
                        </span>
                      </td>
                      <td className="px-4.5 py-3 font-mono-code tabular-nums text-right font-semibold text-[var(--ink-primary)]">
                        {item.line_total}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Fullscreen Comparison Modal for Wide Line-Item Tables */}
      <Modal
        open={fullscreenOpen}
        onOpenChange={setFullscreenOpen}
        title={tx(
          {
            "zh-CN": "全屏字段差异对比{suffix}",
            "zh-HK": "全螢幕欄位差異比對{suffix}",
            en: "Fullscreen Field Comparison{suffix}",
          },
          {
            suffix: proposalId ? ` · ${formatShortDigest(proposalId, 6, 4)}` : "",
          },
        )}
        subtitle={tx(
          {
            "zh-CN": "仓库：{warehouse} · 目标：{target}",
            "zh-HK": "倉庫：{warehouse} · 目標：{target}",
            en: "Warehouse: {warehouse} · Target: {target}",
          },
          { warehouse: plan.warehouse, target: plan.target },
        )}
        size="xl"
        expandable
      >
        <div className="space-y-5" data-testid="proposal-fullscreen-diff-modal">
          <div className="rounded-tile bg-[var(--bg-surface)] shadow-[var(--shadow-subtle)] overflow-hidden">
            <table className="w-full border-collapse text-left text-[13px]">
              <thead>
                <tr className="border-b border-[var(--hairline-subtle)] bg-[var(--bg-surface-tint)] text-[12px] text-[var(--ink-secondary)]">
                  <th className="px-4 py-3 font-medium w-[24%]">
                    {tx({
                      "zh-CN": "字段名称",
                      "zh-HK": "欄位名稱",
                      en: "Field Name",
                    })}
                  </th>
                  <th className="px-4 py-3 font-medium w-[35%]">
                    {tx({
                      "zh-CN": "当前快照 / 原值",
                      "zh-HK": "目前快照 / 原值",
                      en: "Current Snapshot / Before",
                    })}
                  </th>
                  <th className="px-4 py-3 font-medium w-[41%]">
                    {t("proposal.diff.colAfter")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--hairline-subtle)]">
                {diffRows.map((row) => (
                  <tr key={row.key}>
                    <td className="px-4 py-3 font-medium text-[var(--ink-secondary)]">
                      {row.label}
                    </td>
                    <td
                      className={[
                        "px-4 py-3 text-[var(--ink-muted)]",
                        row.mono ? "font-mono-code" : "tabular-nums",
                        row.changed && !isPlaceholderBefore(row.before)
                          ? "line-through"
                          : "",
                      ].join(" ")}
                    >
                      {row.rawValue ? (
                        <span className="inline-flex items-center gap-1.5">
                          <span title={row.rawValue}>{row.before}</span>
                          <button
                            type="button"
                            onClick={() =>
                              void handleCopyRaw(
                                `${row.key}-modal-before`,
                                row.rawValue!,
                              )
                            }
                            title={tx(
                              {
                                "zh-CN": "复制完整值 {val}",
                                "zh-HK": "複製完整值 {val}",
                                en: "Copy full value {val}",
                              },
                              { val: row.rawValue },
                            )}
                            aria-label={tx(
                              {
                                "zh-CN": "复制 {label}",
                                "zh-HK": "複製 {label}",
                                en: "Copy {label}",
                              },
                              { label: row.label },
                            )}
                            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[var(--ink-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--ink-primary)] transition-colors cursor-pointer"
                          >
                            {copiedRowKey === `${row.key}-modal-before` ? (
                              <Check className="h-3 w-3 text-[var(--status-emerald)]" />
                            ) : (
                              <Copy className="h-3 w-3" />
                            )}
                          </button>
                        </span>
                      ) : (
                        row.before
                      )}
                    </td>
                    <td
                      className={[
                        "px-4 py-3",
                        row.mono ? "font-mono-code" : "tabular-nums",
                      ].join(" ")}
                    >
                      {row.changed ? (
                        <span className="inline-block rounded-xs bg-[var(--accent-wash)] px-2 py-0.5 font-semibold text-[var(--accent-ink)]">
                          {row.after}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-[var(--ink-primary)]">
                          <span title={row.rawValue ?? row.after}>
                            {row.after}
                          </span>
                          {row.rawValue && (
                            <button
                              type="button"
                              onClick={() =>
                                void handleCopyRaw(
                                  `${row.key}-modal-after`,
                                  row.rawValue!,
                                )
                              }
                              title={tx(
                                {
                                  "zh-CN": "复制完整值 {val}",
                                  "zh-HK": "複製完整值 {val}",
                                  en: "Copy full value {val}",
                                },
                                { val: row.rawValue },
                              )}
                              aria-label={tx(
                                {
                                  "zh-CN": "复制 {label}",
                                  "zh-HK": "複製 {label}",
                                  en: "Copy {label}",
                                },
                                { label: row.label },
                              )}
                              className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[var(--ink-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--ink-primary)] transition-colors cursor-pointer"
                            >
                              {copiedRowKey === `${row.key}-modal-after` ? (
                                <Check className="h-3 w-3 text-[var(--status-emerald)]" />
                              ) : (
                                <Copy className="h-3 w-3" />
                              )}
                            </button>
                          )}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {salesOrderAfter && salesOrderAfter.items.length > 0 && (
            <div className="rounded-tile bg-[var(--bg-surface)] shadow-[var(--shadow-subtle)] overflow-hidden">
              <div className="border-b border-[var(--hairline-subtle)] bg-[var(--bg-surface-tint)] px-4 py-2.5 text-[12.5px] font-semibold text-[var(--ink-secondary)]">
                {tp(
                  {
                    "zh-CN": "完整订单明细行换算表（共 {count} 行 · 合计 ",
                    "zh-HK": "完整訂單明細行換算表（共 {count} 行 · 合計 ",
                    en: {
                      one: "Full Line-Item UOM Conversion Table ({count} line · Total ",
                      other:
                        "Full Line-Item UOM Conversion Table ({count} lines · Total ",
                    },
                  },
                  salesOrderAfter.items.length,
                )}
                <span className="font-mono-code tabular-nums text-[var(--ink-primary)]">
                  {salesOrderAfter.currency} {salesOrderAfter.total}
                </span>
                {tx({ "zh-CN": "）", "zh-HK": "）", en: ")" })}
              </div>
              <table className="w-full border-collapse text-left text-[13px]">
                <thead>
                  <tr className="border-b border-[var(--hairline-subtle)] bg-[var(--bg-surface-tint)]/60 text-[11.5px] text-[var(--ink-muted)]">
                    <th className="px-4 py-2.5 font-medium">#</th>
                    <th className="px-4 py-2.5 font-medium">
                      {tx({
                        "zh-CN": "源商品编码",
                        "zh-HK": "源商品編碼",
                        en: "Source SKU",
                      })}
                    </th>
                    <th className="px-4 py-2.5 font-medium">
                      {tx({
                        "zh-CN": "ERP 商品编码",
                        "zh-HK": "ERP 商品編碼",
                        en: "ERP SKU",
                      })}
                    </th>
                    <th className="px-4 py-2.5 font-medium text-right">
                      {tx({
                        "zh-CN": "源数量与单位",
                        "zh-HK": "源數量與單位",
                        en: "Source Qty & UOM",
                      })}
                    </th>
                    <th className="px-4 py-2.5 font-medium text-right">
                      {tx({
                        "zh-CN": "ERP 标准数量与单位",
                        "zh-HK": "ERP 標準數量與單位",
                        en: "ERP Standard Qty & UOM",
                      })}
                    </th>
                    <th className="px-4 py-2.5 font-medium text-right">
                      {tx(
                        {
                          "zh-CN": "行金额 ({currency})",
                          "zh-HK": "行金額 ({currency})",
                          en: "Line Total ({currency})",
                        },
                        { currency: salesOrderAfter.currency },
                      )}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--hairline-subtle)]">
                  {salesOrderAfter.items.map((item, idx) => (
                    <tr key={`${item.source_sku}-${idx}`}>
                      <td className="px-4 py-2.5 font-mono-code text-[var(--ink-muted)]">
                        {idx + 1}
                      </td>
                      <td className="px-4 py-2.5 font-mono-code text-[var(--ink-secondary)]">
                        {item.source_sku}
                      </td>
                      <td className="px-4 py-2.5 font-mono-code font-semibold text-[var(--ink-primary)]">
                        {item.sku}
                      </td>
                      <td
                        title={item.source_uom}
                        className="px-4 py-2.5 tabular-nums text-right text-[var(--ink-muted)]"
                      >
                        <span className="font-mono-code">
                          {item.source_quantity}
                        </span>{" "}
                        {localizeUom(item.source_uom, locale)}
                      </td>
                      <td className="px-4 py-2.5 tabular-nums text-right">
                        <span
                          title={item.erp_uom}
                          className="rounded-xs bg-[var(--accent-wash)] px-2 py-0.5 font-semibold text-[var(--accent-ink)]"
                        >
                          <span className="font-mono-code">
                            {item.erp_quantity}
                          </span>{" "}
                          {localizeUom(item.erp_uom, locale)}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 font-mono-code tabular-nums text-right font-semibold text-[var(--ink-primary)]">
                        {item.line_total}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
