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
  "shipment.read": "运单查询",
  "shipment.reschedule": "运单改期提案",
  "order.draft.prepare": "销售订单草稿",
  "finance.invoice.read": "财务发票",
  "mail.inbox.read": "企业收件箱",
  "decision.warehouse.summary": "仓库经营概览",
};

function isInvoiceView(data: Record<string, unknown>): data is Record<string, unknown> & InvoiceView {
  return (
    typeof data.invoice_id === "string" &&
    typeof data.amount === "string" &&
    typeof data.currency === "string"
  );
}

function isShipmentView(data: Record<string, unknown>): data is Record<string, unknown> & ShipmentView {
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
      <div className="mt-2.5 flex flex-wrap items-center gap-2 rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] px-3 py-2 text-[12.5px]">
        <span className="text-[var(--ink-muted)]">交付日期</span>
        <span className="font-mono-code text-[var(--ink-secondary)] line-through">
          {oldDate}
        </span>
        <ArrowRight className="h-3.5 w-3.5 text-[var(--ink-muted)]" />
        <span className="font-mono-code font-semibold text-[var(--accent)]">
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
      <div className="mt-2.5 grid grid-cols-3 gap-2 rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] px-3 py-2 text-[12px]">
        <div>
          <div className="text-[11px] text-[var(--ink-muted)]">采购单号</div>
          <div className="font-mono-code font-medium text-[var(--ink-primary)] truncate">
            {po}
          </div>
        </div>
        <div>
          <div className="text-[11px] text-[var(--ink-muted)]">订单总额</div>
          <div className="font-mono-code font-semibold text-[var(--ink-primary)]">
            {currency} {total}
          </div>
        </div>
        <div>
          <div className="text-[11px] text-[var(--ink-muted)]">明细行数</div>
          <div className="font-mono-code font-medium text-[var(--ink-primary)]">
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
  // 1. Clarification
  if (result.kind === "clarification") {
    const options = buildCapabilityPromptOptions(capabilities);
    return (
      <div
        data-testid="turn-card-clarification"
        className="rounded-[6px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] p-4"
      >
        <div className="flex items-center gap-2 text-[12px] font-medium text-[var(--ink-secondary)]">
          <HelpCircle className="h-4 w-4 text-[var(--accent)]" strokeWidth={1.75} />
          <span>需要补充指令要素</span>
        </div>
        <p className="mt-2 text-[13.5px] leading-relaxed text-[var(--ink-primary)] break-words">
          {result.question}
        </p>

        {options.length > 0 && onSelectClarification && (
          <div className="mt-3 border-t border-[var(--hairline-subtle)] pt-3">
            <div className="mb-2 text-[11.5px] text-[var(--ink-muted)]">
              可直接点选当前账号已授权的标准查询指令：
            </div>
            <div className="flex flex-wrap gap-1.5">
              {options.map((opt) => (
                <button
                  key={opt.prompt}
                  type="button"
                  data-testid={`clarification-option-${opt.domain}`}
                  onClick={() => onSelectClarification(opt.prompt)}
                  className="inline-flex items-center gap-1.5 rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-subtle)] px-2.5 py-1.5 text-[12px] text-[var(--ink-primary)] hover:border-[var(--accent-border)] hover:bg-[var(--accent-wash)] transition-colors duration-[120ms] cursor-pointer"
                >
                  <span className="font-mono-code text-[10.5px] text-[var(--ink-muted)]">
                    {opt.domain}
                  </span>
                  <span>{opt.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  // 2. Typed Read Result
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
      <div
        data-testid="turn-card-result"
        data-tool={result.tool}
        className="rounded-[6px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] overflow-hidden"
      >
        {/* Top Metadata Strip */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--hairline)] bg-[var(--bg-subtle)] px-3.5 py-2">
          <div className="flex items-center gap-2">
            <span className="font-mono-code text-[11px] font-semibold text-[var(--status-emerald)]">
              已获取结果
            </span>
            <span className="text-[var(--hairline-strong)]">·</span>
            <span className="text-[12.5px] font-medium text-[var(--ink-primary)]">
              {toolLabel}
            </span>
            {warehouse && (
              <span className="rounded-[2px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-1.5 py-0.5 font-mono-code text-[10.5px] text-[var(--ink-secondary)] leading-none">
                {warehouse}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <SourceTag source={result.source} />
            {timestamp && (
              <span className="font-mono-code text-[11px] text-[var(--ink-muted)]">
                {formatUnixTime(timestamp)}
              </span>
            )}
          </div>
        </div>

        {/* Typed Payload Body */}
        <div className="p-3.5">
          {result.tool === "finance.invoice.read" && isInvoiceView(rawData) ? (
            <div className="space-y-2.5">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Receipt className="h-4 w-4 text-[var(--accent)]" strokeWidth={1.75} />
                  <span className="font-mono-code text-[14px] font-semibold text-[var(--ink-primary)]">
                    {rawData.invoice_id}
                  </span>
                </div>
                <StatusBadge status={rawData.state} compact />
              </div>
              <dl className="grid grid-cols-3 gap-2 rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] px-3 py-2 text-[12px]">
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
                <div className="text-right">
                  <dt className="text-[11px] text-[var(--ink-muted)]">发票金额</dt>
                  <dd className="mt-0.5 font-mono-code text-[13.5px] font-semibold text-[var(--ink-primary)]">
                    {rawData.amount}
                  </dd>
                </div>
              </dl>
            </div>
          ) : result.tool === "shipment.read" && isShipmentView(rawData) ? (
            <div className="space-y-2.5">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Package className="h-4 w-4 text-[var(--accent)]" strokeWidth={1.75} />
                  <span className="font-mono-code text-[14px] font-semibold text-[var(--ink-primary)]">
                    {rawData.shipment_id}
                  </span>
                </div>
                <StatusBadge status={rawData.status} compact />
              </div>
              <dl className="grid grid-cols-3 gap-2 rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] px-3 py-2 text-[12px]">
                <div>
                  <dt className="text-[11px] text-[var(--ink-muted)]">仓库站点</dt>
                  <dd className="mt-0.5 font-mono-code font-medium text-[var(--ink-primary)]">
                    {rawData.warehouse}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] text-[var(--ink-muted)]">计划交付日</dt>
                  <dd className="mt-0.5 font-mono-code font-semibold text-[var(--ink-primary)]">
                    {rawData.delivery_date}
                  </dd>
                </div>
                <div className="text-right">
                  <dt className="text-[11px] text-[var(--ink-muted)]">记录版本</dt>
                  <dd className="mt-0.5 font-mono-code font-medium text-[var(--ink-primary)]">
                    v{rawData.version}
                  </dd>
                </div>
              </dl>
            </div>
          ) : result.tool === "decision.warehouse.summary" &&
            isWarehouseSummary(rawData) ? (
            <div className="flex flex-wrap items-center justify-between gap-4 rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] px-3.5 py-2.5">
              <div className="flex items-center gap-2.5">
                <Warehouse className="h-4 w-4 text-[var(--accent)]" strokeWidth={1.75} />
                <div>
                  <div className="text-[11.5px] text-[var(--ink-muted)]">
                    仓库站点 {rawData.warehouse} · 在途未关闭运单
                  </div>
                  <div className="mt-0.5 font-mono-code text-[20px] font-semibold text-[var(--ink-primary)]">
                    {rawData.open_shipments}
                  </div>
                </div>
              </div>
              <div className="text-right">
                <div className="text-[11px] text-[var(--ink-muted)]">统计基准日</div>
                <div className="mt-0.5 font-mono-code text-[12.5px] font-medium text-[var(--ink-secondary)]">
                  {rawData.as_of}
                </div>
              </div>
            </div>
          ) : result.tool === "mail.inbox.read" && isMailInboxView(rawData) ? (
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-[12px] text-[var(--ink-muted)]">
                <Mail className="h-3.5 w-3.5 text-[var(--accent)]" strokeWidth={1.75} />
                <span>
                  共 {rawData.messages.length} 封邮件摘要（仅头部投影）
                </span>
              </div>
              {rawData.messages.length === 0 ? (
                <div className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] px-3 py-3 text-[12.5px] text-[var(--ink-muted)]">
                  当前收件箱暂无邮件记录。
                </div>
              ) : (
                <div className="divide-y divide-[var(--hairline)] rounded-[4px] border border-[var(--hairline)]">
                  {rawData.messages.map((msg) => (
                    <div key={msg.id} className="px-3 py-2 text-[12.5px]">
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
            <dl className="divide-y divide-[var(--hairline-subtle)] rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] text-[12px]">
              {Object.entries(rawData).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3 px-3 py-1.5">
                  <dt className="font-mono-code text-[var(--ink-muted)]">{k}</dt>
                  <dd className="font-mono-code text-right text-[var(--ink-primary)] break-all">
                    {typeof v === "string" || typeof v === "number" || typeof v === "boolean"
                      ? String(v)
                      : JSON.stringify(v)}
                  </dd>
                </div>
              ))}
            </dl>
          )}

          {/* Action Row */}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--hairline-subtle)] pt-2.5">
            <span className="font-mono-code text-[11px] text-[var(--ink-muted)]">
              只读实时投影 · 受当前权限约束
            </span>
            <Button
              size="sm"
              variant="secondary"
              data-testid="turn-result-open-drawer"
              onClick={(e) =>
                onInspectObject(buildDrawerSelection(), e.currentTarget)
              }
            >
              <PanelRightOpen className="h-3.5 w-3.5" strokeWidth={1.75} />
              <span>在业务面板查看</span>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // 3. Proposal Card
  if (result.kind === "proposal") {
    const { proposal } = result;
    const headline =
      proposal.state === "PROPOSED"
        ? "已生成提案 · 待审批"
        : `提案当前状态 · ${formatProposalStateLabel(proposal.state)}`;

    return (
      <div
        data-testid="turn-card-proposal"
        data-proposal-id={proposal.id}
        className="rounded-[6px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] overflow-hidden"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--hairline)] bg-[var(--bg-subtle)] px-3.5 py-2">
          <div className="flex items-center gap-2">
            <FileText className="h-3.5 w-3.5 text-[var(--accent)]" strokeWidth={1.75} />
            <span className="text-[12.5px] font-semibold text-[var(--ink-primary)]">
              {headline}
            </span>
          </div>
          <StatusBadge status={proposal.state} compact />
        </div>

        <div className="p-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
            <div className="flex items-center gap-2">
              <span className="font-mono-code font-semibold text-[var(--ink-primary)]">
                {proposal.id}
              </span>
              <span className="rounded-[2px] border border-[var(--hairline-strong)] bg-[var(--bg-subtle)] px-1.5 py-0.5 font-mono-code text-[10.5px] text-[var(--ink-secondary)]">
                {proposal.warehouse}
              </span>
              <span className="text-[var(--ink-secondary)]">
                {formatProposalAction(proposal.plan.action)}
              </span>
            </div>
            <span className="font-mono-code text-[11px] text-[var(--ink-muted)]">
              摘要 {formatShortDigest(proposal.digest)}
            </span>
          </div>

          {renderConciseDiff(proposal)}

          <div className="mt-3 flex flex-wrap items-center justify-end gap-2 border-t border-[var(--hairline-subtle)] pt-2.5">
            <Button
              size="sm"
              variant="secondary"
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
              <PanelRightOpen className="h-3.5 w-3.5" strokeWidth={1.75} />
              <span>在业务面板查看</span>
            </Button>
            <Link
              href={`/proposals/${encodeURIComponent(proposal.id)}`}
              data-testid="turn-proposal-open-page"
              className="inline-flex h-7 items-center gap-1 rounded-[4px] bg-[var(--accent)] px-2.5 text-[12px] font-medium text-white hover:bg-[var(--accent-hover)]"
            >
              <span>打开单据详情</span>
              <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.75} />
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // 4. Approval Preview Card (NEVER approves via /turns!)
  const { proposal } = result;
  return (
    <div
      data-testid="turn-card-approval-preview"
      data-proposal-id={proposal.id}
      className="rounded-[6px] border border-[var(--accent-border)] bg-[var(--bg-sheet)] overflow-hidden"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--accent-border)] bg-[var(--accent-wash)] px-3.5 py-2">
        <div className="flex items-center gap-2">
          <CheckSquare className="h-3.5 w-3.5 text-[var(--accent)]" strokeWidth={1.75} />
          <span className="text-[12.5px] font-semibold text-[var(--ink-primary)]">
            请核对后确认 · 审批快照预览
          </span>
        </div>
        <StatusBadge status={proposal.state} compact />
      </div>

      <div className="p-3.5">
        <div className="grid grid-cols-2 gap-2 text-[12px] sm:grid-cols-3">
          <div>
            <div className="text-[11px] text-[var(--ink-muted)]">单据编号</div>
            <div className="font-mono-code font-semibold text-[var(--ink-primary)]">
              {proposal.id}
            </div>
          </div>
          <div>
            <div className="text-[11px] text-[var(--ink-muted)]">发起人 / 仓库</div>
            <div className="font-mono-code text-[var(--ink-primary)]">
              {proposal.requester} · {proposal.warehouse}
            </div>
          </div>
          <div>
            <div className="text-[11px] text-[var(--ink-muted)]">摘要锁 (SHA-256)</div>
            <div className="font-mono-code text-[var(--ink-primary)]">
              {formatShortDigest(proposal.digest)}
            </div>
          </div>
        </div>

        {renderConciseDiff(proposal)}

        <p className="mt-2.5 text-[12px] text-[var(--ink-muted)]">
          对话区仅展示实时审批预览，正式批准、退回或拒绝必须在单据详情页核对摘要后显式确认。
        </p>

        <div className="mt-3 flex flex-wrap items-center justify-end gap-2 border-t border-[var(--hairline-subtle)] pt-2.5">
          <Button
            size="sm"
            variant="secondary"
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
            <PanelRightOpen className="h-3.5 w-3.5" strokeWidth={1.75} />
            <span>在业务面板预览</span>
          </Button>
          <Link
            href={`/proposals/${encodeURIComponent(proposal.id)}`}
            data-testid="turn-approval-open-formal"
            className="inline-flex h-7 items-center gap-1 rounded-[4px] bg-[var(--accent)] px-3 text-[12px] font-medium text-white hover:bg-[var(--accent-hover)]"
          >
            <span>前往正式审批页确认</span>
            <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.75} />
          </Link>
        </div>
      </div>
    </div>
  );
}
