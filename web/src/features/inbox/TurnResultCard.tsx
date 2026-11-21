"use client";

import React from "react";
import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  CheckSquare,
  FileText,
  HelpCircle,
  Mail,
  Package,
  PanelRightOpen,
  Receipt,
  Warehouse,
} from "lucide-react";
import {
  formatProposalAction,
  formatProposalStateLabel,
  formatShortDigest,
  formatUnixTime,
} from "@/lib/format";
import { Interactive3DCard } from "@/components/kinetic";
import { Button } from "@/components/ui/Button";
import { SourceTag } from "@/components/ui/SourceTag";
import { StatusBadge } from "@/components/ui/StatusBadge";
import type {
  Capabilities,
  DrawerObjectSelection,
  InvoiceView,
  MailInboxView,
  Proposal,
  ShipmentView,
  TurnResult,
  WarehouseDecisionSummary,
} from "@/lib/types";

export interface ClarificationOption {
  label: string;
  prompt: string;
  domain: string;
}

export function buildCapabilityPromptOptions(
  capabilities: Capabilities | null,
): ClarificationOption[] {
  if (!capabilities) return [];
  const options: ClarificationOption[] = [];

  for (const tool of capabilities.tools) {
    if (!tool.available) continue;
    const wh = tool.warehouses[0];

    if (tool.id === "finance.invoice.read" && wh) {
      options.push({
        domain: "财务",
        label: `查看 ${wh} 发票 INV-100`,
        prompt: `查看发票 INV-100 仓库 ${wh}`,
      });
    } else if (tool.id === "shipment.read" && wh) {
      const shp = wh === "HK02" ? "SHP-2001" : "SHP-1001";
      options.push({
        domain: "运单",
        label: `查看 ${wh} 运单 ${shp}`,
        prompt: `查看运单 ${shp} 仓库 ${wh}`,
      });
    } else if (tool.id === "decision.warehouse.summary" && wh) {
      options.push({
        domain: "经营",
        label: `查看 ${wh} 仓库概览`,
        prompt: `仓库汇总 ${wh}`,
      });
    } else if (tool.id === "mail.inbox.read") {
      options.push({
        domain: "邮箱",
        label: "查看我的收件箱",
        prompt: "查看我的收件箱",
      });
    }
  }

  return options;
}

const TOOL_LABELS: Record<string, string> = {
  "shipment.read": "运单实时状态",
  "shipment.reschedule": "运单改期提案",
  "order.draft.prepare": "销售订单草稿",
  "finance.invoice.read": "财务发票核对",
  "mail.inbox.read": "企业收件箱",
  "decision.warehouse.summary": "仓库经营概览",
};

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

function renderConciseDiff(proposal: Proposal): React.ReactNode {
  const { action, before, after } = proposal.plan;
  if (action === "shipment.reschedule") {
    const oldDate =
      typeof before.delivery_date === "string" ? before.delivery_date : "—";
    const newDate =
      typeof after.delivery_date === "string" ? after.delivery_date : "—";
    return (
      <div className="mt-3 flex flex-wrap items-center gap-2 rounded-tile bg-[var(--bg-surface-tint)] px-3.5 py-2.5 text-[12.5px]">
        <span className="text-[var(--ink-muted)]">交付日期</span>
        <span className="font-mono-code text-[var(--ink-secondary)] line-through">
          {oldDate}
        </span>
        <ArrowRight className="h-3.5 w-3.5 text-[var(--ink-faint)]" />
        <span className="rounded-xs bg-[var(--accent-wash)] px-2 py-0.5 font-mono-code font-semibold text-[var(--accent)]">
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
      <div className="mt-3 grid grid-cols-3 gap-3 rounded-tile bg-[var(--bg-surface-tint)] px-3.5 py-2.5 text-[12px]">
        <div>
          <div className="text-[11px] text-[var(--ink-muted)]">采购单号</div>
          <div className="mt-0.5 truncate font-mono-code font-medium text-[var(--ink-primary)]">
            {po}
          </div>
        </div>
        <div>
          <div className="text-[11px] text-[var(--ink-muted)]">订单总额</div>
          <div className="mt-0.5 font-mono-code font-semibold text-[var(--ink-primary)] tabular-nums">
            {currency} {total}
          </div>
        </div>
        <div>
          <div className="text-[11px] text-[var(--ink-muted)]">明细行数</div>
          <div className="mt-0.5 font-mono-code font-medium text-[var(--ink-primary)] tabular-nums">
            {items} 行
          </div>
        </div>
      </div>
    );
  }

  return null;
}

export interface TurnResultCardProps {
  result: TurnResult;
  capabilities: Capabilities | null;
  timestamp?: number;
  onSelectClarification?: (prompt: string) => void;
  onInspectObject: (
    selection: DrawerObjectSelection,
    trigger: HTMLElement | null,
  ) => void;
}

export function TurnResultCard({
  result,
  capabilities,
  timestamp,
  onSelectClarification,
  onInspectObject,
}: TurnResultCardProps) {
  if (result.kind === "clarification") {
    const options = buildCapabilityPromptOptions(capabilities);
    return (
      <Interactive3DCard
        maxTilt={2}
        hoverLiftPx={-1}
        sheenIntensity="subtle"
        data-testid="turn-card-clarification"
        className="rounded-card bg-[var(--bg-surface)] p-4 shadow-[var(--shadow-card)]"
      >
        <div className="flex items-center gap-2 text-[12.5px] font-medium text-[var(--ink-secondary)]">
          <HelpCircle
            className="h-4 w-4 text-[var(--accent)]"
            strokeWidth={1.85}
          />
          <span>需要补充指令要素</span>
        </div>
        <p className="mt-2 text-[14px] leading-relaxed text-[var(--ink-primary)] break-words">
          {result.question}
        </p>

        {options.length > 0 && onSelectClarification && (
          <div className="mt-3.5 border-t border-[var(--hairline-subtle)] pt-3">
            <div className="mb-2 text-[11.5px] text-[var(--ink-muted)]">
              可直接点选常用查询：
            </div>
            <div className="flex flex-wrap gap-1.5">
              {options.map((opt) => (
                <button
                  key={opt.prompt}
                  type="button"
                  data-testid={`clarification-option-${opt.domain}`}
                  onClick={() => onSelectClarification(opt.prompt)}
                  className="inline-flex items-center gap-1.5 rounded-full bg-[var(--bg-surface-subtle)] px-3 py-1.5 text-[12px] font-medium text-[var(--ink-primary)] hover:bg-[var(--accent-wash)] hover:text-[var(--accent)] transition-colors duration-[140ms] cursor-pointer"
                >
                  <span className="text-[11px] text-[var(--ink-muted)]">
                    {opt.domain}
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
    const toolLabel = TOOL_LABELS[result.tool] || result.tool;
    const warehouse =
      typeof rawData.warehouse === "string" ? rawData.warehouse : undefined;

    const buildDrawerSelection = (): DrawerObjectSelection => {
      if (result.tool === "shipment.read" && isShipmentView(rawData)) {
        return {
          kind: "shipment",
          id: rawData.shipment_id,
          warehouse: rawData.warehouse,
          title: `运单 ${rawData.shipment_id}`,
          meta: { result },
        };
      }
      if (result.tool === "finance.invoice.read" && isInvoiceView(rawData)) {
        return {
          kind: "invoice",
          id: rawData.invoice_id,
          warehouse: rawData.warehouse,
          title: `发票 ${rawData.invoice_id}`,
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
        className="overflow-hidden rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] hover:shadow-[var(--shadow-card-hover)]"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 bg-[var(--bg-surface-tint)] px-4 py-2.5 border-b border-[var(--hairline-subtle)]">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-[var(--status-emerald)]" />
            <span className="text-[12.5px] font-semibold text-[var(--ink-primary)]">
              {toolLabel}
            </span>
            {warehouse && (
              <span className="rounded-full bg-[var(--bg-surface)] px-2 py-0.5 font-mono-code text-[10.5px] text-[var(--ink-secondary)] shadow-[var(--shadow-subtle)] leading-none">
                {warehouse}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <SourceTag source={result.source} />
            {timestamp && (
              <span className="font-mono-code text-[11px] text-[var(--ink-muted)] tabular-nums">
                {formatUnixTime(timestamp)}
              </span>
            )}
          </div>
        </div>

        <div className="p-4">
          {result.tool === "finance.invoice.read" && isInvoiceView(rawData) ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-[var(--accent-wash)] text-[var(--accent)]">
                    <Receipt className="h-4 w-4" strokeWidth={1.85} />
                  </span>
                  <span className="text-[14.5px] font-semibold tracking-[-0.01em] text-[var(--ink-primary)]">
                    发票{" "}
                    <span className="font-mono-code font-medium">
                      {rawData.invoice_id}
                    </span>
                  </span>
                </div>
                <StatusBadge status={rawData.state} compact />
              </div>
              <dl className="grid grid-cols-3 gap-3 rounded-tile bg-[var(--bg-surface-tint)] px-3.5 py-2.5 text-[12px]">
                <div>
                  <dt className="text-[11px] text-[var(--ink-muted)]">所属仓库</dt>
                  <dd className="mt-0.5 font-mono-code font-medium text-[var(--ink-primary)]">
                    {rawData.warehouse}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] text-[var(--ink-muted)]">币种</dt>
                  <dd className="mt-0.5 font-mono-code font-medium text-[var(--ink-primary)]">
                    {rawData.currency}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] text-[var(--ink-muted)]">发票金额</dt>
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
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-[var(--accent-wash)] text-[var(--accent)]">
                    <Package className="h-4 w-4" strokeWidth={1.85} />
                  </span>
                  <span className="text-[14.5px] font-semibold tracking-[-0.01em] text-[var(--ink-primary)]">
                    运单{" "}
                    <span className="font-mono-code font-medium">
                      {rawData.shipment_id}
                    </span>
                  </span>
                </div>
                <StatusBadge status={rawData.status} compact />
              </div>
              <dl className="grid grid-cols-3 gap-3 rounded-tile bg-[var(--bg-surface-tint)] px-3.5 py-2.5 text-[12px]">
                <div>
                  <dt className="text-[11px] text-[var(--ink-muted)]">仓库站点</dt>
                  <dd className="mt-0.5 font-mono-code font-medium text-[var(--ink-primary)]">
                    {rawData.warehouse}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] text-[var(--ink-muted)]">计划交付日</dt>
                  <dd className="mt-0.5 font-mono-code font-semibold text-[var(--ink-primary)] tabular-nums">
                    {rawData.delivery_date}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] text-[var(--ink-muted)]">记录版本</dt>
                  <dd className="mt-0.5 font-mono-code font-medium text-[var(--ink-primary)] tabular-nums">
                    v{rawData.version}
                  </dd>
                </div>
              </dl>
            </div>
          ) : result.tool === "decision.warehouse.summary" &&
            isWarehouseSummary(rawData) ? (
            <div className="flex flex-wrap items-center justify-between gap-4 rounded-tile bg-[var(--bg-surface-tint)] px-4 py-3">
              <div className="flex items-center gap-3">
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-[var(--accent-wash)] text-[var(--accent)]">
                  <Warehouse className="h-4 w-4" strokeWidth={1.85} />
                </span>
                <div>
                  <div className="text-[11.5px] text-[var(--ink-muted)]">
                    仓库站点 {rawData.warehouse} · 在途未关闭运单
                  </div>
                  <div className="mt-0.5 font-mono-code text-[22px] font-semibold text-[var(--ink-primary)] tabular-nums">
                    {rawData.open_shipments}
                  </div>
                </div>
              </div>
              <div>
                <div className="text-[11px] text-[var(--ink-muted)]">统计基准日</div>
                <div className="mt-0.5 font-mono-code text-[12.5px] font-medium text-[var(--ink-secondary)] tabular-nums">
                  {rawData.as_of}
                </div>
              </div>
            </div>
          ) : result.tool === "mail.inbox.read" && isMailInboxView(rawData) ? (
            <div className="space-y-2.5">
              <div className="flex items-center gap-2 text-[12px] text-[var(--ink-muted)]">
                <Mail className="h-3.5 w-3.5 text-[var(--accent)]" strokeWidth={1.85} />
                <span>共 {rawData.messages.length} 封邮件摘要</span>
              </div>
              {rawData.messages.length === 0 ? (
                <div className="rounded-tile bg-[var(--bg-surface-tint)] px-3.5 py-3 text-[12.5px] text-[var(--ink-muted)]">
                  当前收件箱暂无邮件记录。
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
                      <div className="mt-0.5 font-mono-code text-[11px] text-[var(--ink-muted)]">
                        发件人：{msg.sender}
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
              实时只读视图
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
              <span>在右侧核对</span>
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
        ? "已生成待审提案"
        : `提案状态 · ${formatProposalStateLabel(proposal.state)}`;

    return (
      <Interactive3DCard
        maxTilt={2.5}
        hoverLiftPx={-1}
        sheenIntensity="subtle"
        data-testid="turn-card-proposal"
        data-proposal-id={proposal.id}
        className="overflow-hidden rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] hover:shadow-[var(--shadow-card-hover)]"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 bg-[var(--bg-surface-tint)] px-4 py-2.5 border-b border-[var(--hairline-subtle)]">
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
                {formatProposalAction(proposal.plan.action)}
              </span>
              <span className="rounded-full bg-[var(--bg-surface-subtle)] px-2 py-0.5 font-mono-code text-[10.5px] text-[var(--ink-secondary)]">
                {proposal.warehouse}
              </span>
              <span
                title={proposal.id}
                className="font-mono-code text-[11.5px] text-[var(--ink-muted)]"
              >
                {formatShortDigest(proposal.id, 6, 4)}
              </span>
            </div>
            <span className="font-mono-code text-[11px] text-[var(--ink-muted)]">
              摘要 {formatShortDigest(proposal.digest)}
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
                    title: formatProposalAction(proposal.plan.action),
                  },
                  e.currentTarget,
                )
              }
            >
              <PanelRightOpen className="h-3.5 w-3.5" strokeWidth={1.85} />
              <span>右侧核对</span>
            </Button>
            <Link
              href={`/proposals/${encodeURIComponent(proposal.id)}`}
              data-testid="turn-proposal-open-page"
              className="inline-flex h-8 items-center gap-1 rounded-full bg-[var(--accent)] px-3.5 text-[12.5px] font-medium text-white shadow-[0_1px_2px_rgba(22,104,227,0.22)] hover:bg-[var(--accent-hover)] transition-colors"
            >
              <span>打开单据详情</span>
              <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.9} />
            </Link>
          </div>
        </div>
      </Interactive3DCard>
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
      className="overflow-hidden rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] ring-1 ring-[var(--accent-border)]"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 bg-[var(--accent-wash)] px-4 py-2.5">
        <div className="flex items-center gap-2">
          <CheckSquare
            className="h-3.5 w-3.5 text-[var(--accent)]"
            strokeWidth={1.9}
          />
          <span className="text-[13px] font-semibold text-[var(--ink-primary)]">
            审批快照预览 · 需核对摘要后确认
          </span>
        </div>
        <StatusBadge status={proposal.state} compact />
      </div>

      <div className="p-4">
        <div className="grid grid-cols-2 gap-3 rounded-tile bg-[var(--bg-surface-tint)] px-3.5 py-2.5 text-[12px] sm:grid-cols-3">
          <div>
            <div className="text-[11px] text-[var(--ink-muted)]">单据编号</div>
            <div
              title={proposal.id}
              className="mt-0.5 font-mono-code font-medium text-[var(--ink-primary)]"
            >
              {formatShortDigest(proposal.id, 6, 4)}
            </div>
          </div>
          <div>
            <div className="text-[11px] text-[var(--ink-muted)]">发起人 / 仓库</div>
            <div className="mt-0.5 font-mono-code text-[var(--ink-primary)]">
              {proposal.requester} · {proposal.warehouse}
            </div>
          </div>
          <div>
            <div className="text-[11px] text-[var(--ink-muted)]">摘要锁</div>
            <div className="mt-0.5 font-mono-code text-[var(--ink-primary)]">
              {formatShortDigest(proposal.digest)}
            </div>
          </div>
        </div>

        {renderConciseDiff(proposal)}

        <p className="mt-3 text-[12px] text-[var(--ink-muted)]">
          正式批准、退回或拒绝需在单据详情页核对摘要后显式确认。
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
                  title: "审批核对预览",
                },
                e.currentTarget,
              )
            }
          >
            <PanelRightOpen className="h-3.5 w-3.5" strokeWidth={1.85} />
            <span>右侧预览</span>
          </Button>
          <Link
            href={`/proposals/${encodeURIComponent(proposal.id)}`}
            data-testid="turn-approval-open-formal"
            className="inline-flex h-8 items-center gap-1 rounded-full bg-[var(--accent)] px-3.5 text-[12.5px] font-medium text-white shadow-[0_1px_2px_rgba(22,104,227,0.22)] hover:bg-[var(--accent-hover)] transition-colors"
          >
            <span>前往正式审批页确认</span>
            <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.9} />
          </Link>
        </div>
      </div>
    </Interactive3DCard>
  );
}
