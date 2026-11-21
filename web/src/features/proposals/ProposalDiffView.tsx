"use client";

import React, { useMemo, useState } from "react";
import { ArrowRight, Check, Copy, Maximize2 } from "lucide-react";
import { formatShortDigest } from "@/lib/format";
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

export function buildPlanDiffRows(plan: Plan): DiffRowItem[] {
  if (plan.action === "shipment.reschedule") {
    const before = plan.before as Partial<ShipmentView>;
    const after = plan.after as Partial<ShipmentReschedulePlanAfter>;
    const beforeDate = asString(before.delivery_date);
    const afterDate = asString(after.delivery_date);
    return [
      {
        key: "shipment_id",
        label: "运单编号",
        before: asString(before.shipment_id, plan.target),
        after: asString(before.shipment_id, plan.target),
        changed: false,
        mono: true,
      },
      {
        key: "warehouse",
        label: "仓库站点",
        before: asString(before.warehouse, plan.warehouse),
        after: plan.warehouse,
        changed: false,
        mono: true,
      },
      {
        key: "status",
        label: "当前状态",
        before: asString(before.status),
        after: asString(before.status),
        changed: false,
        mono: true,
      },
      {
        key: "expected_version",
        label: "版本锁",
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
        label: "预计交付日期",
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
        label: "法人实体 / 站点",
        before: plan.warehouse,
        after: legalEntityDisplay,
        changed: false,
        mono: true,
      },
      {
        key: "po",
        label: "客户采购单号 (PO)",
        before: "新建草稿",
        after: after?.po ?? "—",
        changed: true,
        mono: true,
      },
      {
        key: "buyer",
        label: "买方编码",
        before: "—",
        after: after?.buyer ?? "—",
        changed: true,
        mono: true,
      },
      {
        key: "delivery",
        label: "交付日期",
        before: "—",
        after: after?.delivery ?? "—",
        changed: true,
        mono: true,
      },
      {
        key: "total",
        label: "订单总额",
        before: "0.00",
        after: after ? `${after.currency} ${after.total}` : "—",
        changed: true,
        mono: true,
      },
      {
        key: "intake_id",
        label: "来源进件编号",
        before: shortIntakeId,
        after: shortIntakeId,
        changed: false,
        mono: true,
        rawValue: rawIntakeId || undefined,
      },
      {
        key: "source_sha256",
        label: "源证据摘要",
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

export function summarizePlanChange(plan: Plan): string {
  if (plan.action === "shipment.reschedule") {
    const before = plan.before as Partial<ShipmentView>;
    const after = plan.after as Partial<ShipmentReschedulePlanAfter>;
    return `运单 ${plan.target} 交期：${asString(before.delivery_date)} → ${asString(after.delivery_date)}`;
  }
  const after = extractSalesOrderAfter(plan);
  if (after) {
    const itemSummary = after.items
      .map(
        (item) =>
          `${item.source_sku} (${item.source_quantity} ${item.source_uom} → ${item.erp_quantity} ${item.erp_uom})`,
      )
      .join("；");
    return `PO ${after.po} · 总额 ${after.currency} ${after.total}${itemSummary ? ` · ${itemSummary}` : ""}`;
  }
  return `${plan.action} · ${plan.target}`;
}

export function ProposalDiffView({
  plan,
  proposalId,
  compact = false,
  className = "",
}: ProposalDiffViewProps) {
  const [fullscreenOpen, setFullscreenOpen] = useState(false);
  const [copiedRowKey, setCopiedRowKey] = useState<string | null>(null);

  const diffRows = useMemo(() => buildPlanDiffRows(plan), [plan]);
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
            拟变更字段比对
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
          <span>全屏对比</span>
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
                  <span className="rounded-full bg-[var(--accent-wash)] px-2 py-0.5 text-[10.5px] font-medium text-[var(--accent)]">
                    变更
                  </span>
                )}
              </div>
              {row.changed ? (
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 font-mono-code text-[12px]">
                  <span className="text-[var(--ink-muted)] line-through">
                    {row.before}
                  </span>
                  <ArrowRight
                    className="h-3 w-3 shrink-0 text-[var(--accent)]"
                    strokeWidth={1.9}
                  />
                  <span className="rounded-xs bg-[var(--accent-wash)] px-2 py-0.5 font-semibold text-[var(--accent)]">
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
                      title={`复制完整值 ${row.rawValue}`}
                      aria-label={`复制 ${row.label}`}
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
              <tr className="border-b border-[var(--hairline-subtle)] bg-[var(--bg-surface-tint)] text-[11.5px] text-[var(--ink-muted)]">
                <th className="px-4.5 py-2.5 font-medium w-[28%]">字段</th>
                <th className="px-4 py-2.5 font-medium w-[32%]">原值</th>
                <th className="px-4.5 py-2.5 font-medium w-[40%]">拟写入值</th>
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
                    title={row.rawValue}
                    className={[
                      "px-4 py-3 text-[var(--ink-muted)]",
                      row.mono ? "font-mono-code" : "tabular-nums",
                      row.changed ? "line-through" : "",
                    ].join(" ")}
                  >
                    {row.before}
                  </td>
                  <td
                    className={[
                      "px-4.5 py-3",
                      row.mono ? "font-mono-code" : "tabular-nums",
                    ].join(" ")}
                  >
                    {row.changed ? (
                      <span className="inline-block rounded-xs bg-[var(--accent-wash)] px-2 py-0.5 font-semibold text-[var(--accent)]">
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
                              void handleCopyRaw(row.key, row.rawValue!)
                            }
                            title={`复制完整值 ${row.rawValue}`}
                            aria-label={`复制 ${row.label}`}
                            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[var(--ink-faint)] hover:bg-[var(--bg-hover)] hover:text-[var(--ink-primary)] transition-colors cursor-pointer"
                          >
                            {copiedRowKey === row.key ? (
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
            <span>订单明细行换算（源单据 → ERP 标准单位）</span>
            <span className="font-mono-code tabular-nums text-[11.5px] font-normal text-[var(--ink-muted)]">
              {salesOrderAfter.items.length} 行
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
                  <div className="font-mono-code tabular-nums text-[11.5px] text-[var(--ink-muted)]">
                    {item.source_quantity} {item.source_uom} →{" "}
                    <span className="rounded-xs bg-[var(--accent-wash)] px-1.5 py-0.5 font-semibold text-[var(--accent)]">
                      {item.erp_quantity} {item.erp_uom}
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
                    <th className="px-4.5 py-2 font-medium">源 SKU</th>
                    <th className="px-3.5 py-2 font-medium">ERP SKU</th>
                    <th className="px-3.5 py-2 font-medium text-right">
                      源数量 / 单位
                    </th>
                    <th className="px-3.5 py-2 font-medium text-right">
                      ERP 数量 / 单位
                    </th>
                    <th className="px-4.5 py-2 font-medium text-right">
                      行小计 ({salesOrderAfter.currency})
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
                      <td className="px-3.5 py-3 font-mono-code tabular-nums text-right text-[var(--ink-muted)]">
                        {item.source_quantity} {item.source_uom}
                      </td>
                      <td className="px-3.5 py-3 font-mono-code tabular-nums text-right">
                        <span className="rounded-xs bg-[var(--accent-wash)] px-2 py-0.5 font-semibold text-[var(--accent)]">
                          {item.erp_quantity} {item.erp_uom}
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
        title={`全屏字段差异对比${proposalId ? ` · ${formatShortDigest(proposalId, 6, 4)}` : ""}`}
        subtitle={`站点：${plan.warehouse} · 目标：${plan.target}`}
        size="xl"
        expandable
      >
        <div className="space-y-5" data-testid="proposal-fullscreen-diff-modal">
          <div className="rounded-tile bg-[var(--bg-surface)] shadow-[var(--shadow-subtle)] overflow-hidden">
            <table className="w-full border-collapse text-left text-[13px]">
              <thead>
                <tr className="border-b border-[var(--hairline-subtle)] bg-[var(--bg-surface-tint)] text-[12px] text-[var(--ink-secondary)]">
                  <th className="px-4 py-3 font-medium w-[24%]">字段名称</th>
                  <th className="px-4 py-3 font-medium w-[35%]">
                    当前快照 / 原值
                  </th>
                  <th className="px-4 py-3 font-medium w-[41%]">拟写入值</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--hairline-subtle)]">
                {diffRows.map((row) => (
                  <tr key={row.key}>
                    <td className="px-4 py-3 font-medium text-[var(--ink-secondary)]">
                      {row.label}
                    </td>
                    <td
                      title={row.rawValue}
                      className={[
                        "px-4 py-3 font-mono-code text-[var(--ink-muted)]",
                        row.changed ? "line-through" : "",
                      ].join(" ")}
                    >
                      {row.before}
                    </td>
                    <td className="px-4 py-3 font-mono-code">
                      {row.changed ? (
                        <span className="inline-block rounded-xs bg-[var(--accent-wash)] px-2 py-0.5 font-semibold text-[var(--accent)]">
                          {row.after}
                        </span>
                      ) : (
                        <span
                          title={row.rawValue ?? row.after}
                          className="text-[var(--ink-primary)]"
                        >
                          {row.after}
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
                完整订单明细行换算表（共 {salesOrderAfter.items.length} 行 ·
                合计{" "}
                <span className="font-mono-code tabular-nums text-[var(--ink-primary)]">
                  {salesOrderAfter.currency} {salesOrderAfter.total}
                </span>
                ）
              </div>
              <table className="w-full border-collapse text-left text-[13px]">
                <thead>
                  <tr className="border-b border-[var(--hairline-subtle)] bg-[var(--bg-surface-tint)]/60 text-[11.5px] text-[var(--ink-muted)]">
                    <th className="px-4 py-2.5 font-medium">#</th>
                    <th className="px-4 py-2.5 font-medium">源商品编码</th>
                    <th className="px-4 py-2.5 font-medium">ERP 商品编码</th>
                    <th className="px-4 py-2.5 font-medium text-right">
                      源数量与单位
                    </th>
                    <th className="px-4 py-2.5 font-medium text-right">
                      ERP 标准数量与单位
                    </th>
                    <th className="px-4 py-2.5 font-medium text-right">
                      行金额 ({salesOrderAfter.currency})
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
                      <td className="px-4 py-2.5 font-mono-code tabular-nums text-right text-[var(--ink-muted)]">
                        {item.source_quantity} {item.source_uom}
                      </td>
                      <td className="px-4 py-2.5 font-mono-code tabular-nums text-right">
                        <span className="rounded-xs bg-[var(--accent-wash)] px-2 py-0.5 font-semibold text-[var(--accent)]">
                          {item.erp_quantity} {item.erp_uom}
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
