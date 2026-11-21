"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Maximize2,
  PanelRight,
  Receipt,
  Search,
} from "lucide-react";
import {
  callWorkbenchTool,
  isApiError,
  isStaleAuthError,
  type ApiError,
} from "@/lib/api-client";
import { useSession } from "@/lib/session-context";
import { useWorkbench } from "@/lib/workbench-context";
import { AccessNoticeCard } from "@/components/ui/AccessNoticeCard";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { SourceTag } from "@/components/ui/SourceTag";
import { StatusBadge } from "@/components/ui/StatusBadge";
import type { InvoiceView } from "@/lib/types";
import { AssurancePanel } from "@/features/workbench/AssurancePanel";
import { SYNTHETIC_CONTRACT_CLAUSES } from "@/features/workbench/types";

export function FinanceModule() {
  const { actor, capabilities, authGeneration, handleAccessChanged } =
    useSession();
  const { openDrawer } = useWorkbench();

  const invoiceTool = useMemo(
    () => capabilities?.tools.find((t) => t.id === "finance.invoice.read"),
    [capabilities],
  );
  const authorizedWarehouses = useMemo(
    () => invoiceTool?.warehouses ?? [],
    [invoiceTool],
  );
  const hasContractAssurance = Boolean(
    actor?.grants.includes("assurance.contract"),
  );

  const [warehouse, setWarehouse] = useState<string>("");
  const [invoiceId, setInvoiceId] = useState<string>("INV-100");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [invoiceResult, setInvoiceResult] = useState<{
    data: InvoiceView;
    source: string;
  } | null>(null);

  const [clauseModalOpen, setClauseModalOpen] = useState(false);

  useEffect(() => {
    if (authorizedWarehouses.length === 0) {
      setWarehouse("");
      return;
    }
    setWarehouse((prev) =>
      prev && authorizedWarehouses.includes(prev)
        ? prev
        : authorizedWarehouses[0]!,
    );
  }, [authorizedWarehouses]);

  useEffect(() => {
    setInvoiceResult(null);
    setError(null);
  }, [authGeneration]);

  const handleLookupInvoice = async (override?: {
    wh?: string;
    id?: string;
  }) => {
    const wh = override?.wh ?? warehouse;
    const id = (override?.id ?? invoiceId).trim();
    if (!wh || !id) return;
    setLoading(true);
    setError(null);
    try {
      const res = await callWorkbenchTool({
        tool: "finance.invoice.read",
        warehouse: wh,
        invoice_id: id,
      });
      if (res.kind === "result") {
        setInvoiceResult({
          data: res.data as InvoiceView,
          source: res.source,
        });
      }
    } catch (err) {
      if (isStaleAuthError(err)) return;
      if (isApiError(err)) {
        if (err.code === "ACCESS_CHANGED") {
          setInvoiceResult(null);
          void handleAccessChanged();
        }
        setError(err);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="workbench-finance-module">
      {/* Real Invoice Lookup (POST /v1/workbench/calls finance.invoice.read) */}
      <div className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-sheet)]">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--hairline)] bg-[var(--bg-subtle)] px-4 py-2.5">
          <div>
            <h2 className="text-[14px] font-semibold text-[var(--ink-primary)]">
              实时发票审阅查询（finance.invoice.read）
            </h2>
            <p className="text-[12px] text-[var(--ink-muted)]">
              按当前账号获授权仓库实时调用财务发票查询接口，支持权责即时收回与跨仓隔离校验。
            </p>
          </div>
          {invoiceTool && <SourceTag source={invoiceTool.source} />}
        </div>

        <div className="p-4 space-y-4">
          {authorizedWarehouses.length === 0 ? (
            <AccessNoticeCard
              variant="ACCESS_RESTRICTED"
              title="当前账号未开通发票查询站点"
              message="如需查询仓库发票（例如 HK01 · INV-100），请由权限管理员授予 invoice-review（finance.read）模块权限。"
            />
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleLookupInvoice();
              }}
              className="flex flex-wrap items-end gap-3"
            >
              <label className="block space-y-1">
                <span className="text-[12px] font-medium text-[var(--ink-secondary)]">
                  授权仓库
                </span>
                <select
                  value={warehouse}
                  onChange={(e) => setWarehouse(e.target.value)}
                  data-testid="finance-warehouse-select"
                  className="h-9 rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-2.5 font-mono-code text-[12.5px] font-semibold"
                >
                  {authorizedWarehouses.map((wh) => (
                    <option key={wh} value={wh}>
                      {wh}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block flex-1 min-w-[200px] space-y-1">
                <span className="text-[12px] font-medium text-[var(--ink-secondary)]">
                  发票编号
                </span>
                <input
                  type="text"
                  required
                  value={invoiceId}
                  onChange={(e) => setInvoiceId(e.target.value)}
                  placeholder="例如 INV-100"
                  data-testid="finance-invoice-id-input"
                  className="h-9 w-full rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-2.5 font-mono-code text-[13px]"
                />
              </label>

              <Button
                type="submit"
                variant="primary"
                loading={loading}
                data-testid="finance-lookup-btn"
              >
                <Search className="h-3.5 w-3.5" />
                <span>查询发票</span>
              </Button>

              {authorizedWarehouses.includes("HK01") && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setWarehouse("HK01");
                    setInvoiceId("INV-100");
                    void handleLookupInvoice({ wh: "HK01", id: "INV-100" });
                  }}
                  data-testid="finance-sample-inv100-btn"
                >
                  HK01 · INV-100
                </Button>
              )}
            </form>
          )}

          {error && (
            <AccessNoticeCard
              error={error}
              authorizedWarehouses={
                error.status === 403 ? authorizedWarehouses : undefined
              }
              onSelectWarehouse={
                error.status === 403
                  ? (wh) => {
                      setWarehouse(wh);
                      setError(null);
                    }
                  : undefined
              }
            />
          )}

          {invoiceResult && (
            <div
              data-testid="finance-invoice-result"
              className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] p-4 space-y-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Receipt
                    className="h-4 w-4 text-[var(--accent)]"
                    strokeWidth={1.75}
                  />
                  <span className="font-mono-code text-[14px] font-semibold text-[var(--ink-primary)]">
                    {invoiceResult.data.invoice_id}
                  </span>
                  <span className="rounded-[2px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-1.5 py-0.5 font-mono-code text-[11px]">
                    {invoiceResult.data.warehouse}
                  </span>
                  <StatusBadge status={invoiceResult.data.state} compact />
                  <SourceTag source={invoiceResult.source} />
                </div>

                <Button
                  size="sm"
                  variant="secondary"
                  onClick={(e) =>
                    openDrawer(
                      {
                        kind: "invoice",
                        id: invoiceResult.data.invoice_id,
                        warehouse: invoiceResult.data.warehouse,
                        title: `发票审阅 · ${invoiceResult.data.invoice_id}`,
                        meta: {
                          invoice: invoiceResult.data,
                          source: invoiceResult.source,
                        },
                      },
                      { tab: "current", trigger: e.currentTarget },
                    )
                  }
                >
                  <PanelRight className="h-3.5 w-3.5" />
                  <span>在右侧面板查看</span>
                </Button>
              </div>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-sheet)] p-3 text-[12.5px]">
                <div>
                  <span className="text-[var(--ink-muted)]">发票金额：</span>
                  <span className="font-mono-code text-[14px] font-semibold text-[var(--ink-primary)]">
                    {invoiceResult.data.currency} {invoiceResult.data.amount}
                  </span>
                </div>
                <div>
                  <span className="text-[var(--ink-muted)]">所属站点：</span>
                  <span className="font-mono-code text-[var(--ink-primary)]">
                    {invoiceResult.data.warehouse}
                  </span>
                </div>
                <div>
                  <span className="text-[var(--ink-muted)]">结算状态：</span>
                  <span className="font-mono-code text-[var(--ink-primary)]">
                    {invoiceResult.data.state}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Real Assurance Contract Cases (when actor has assurance.contract grant) */}
      {hasContractAssurance && (
        <div className="space-y-2">
          <div className="font-mono-code text-[11px] uppercase tracking-[0.04em] text-[var(--ink-muted)]">
            CONTRACT ASSURANCE · 关联受控合同预审案件
          </div>
          <AssurancePanel fixedKinds={["contract"]} />
        </div>
      )}

      {/* Clearly Labeled Synthetic Contract Clause & Payment Milestone Card */}
      <div
        className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-sheet)] overflow-hidden"
        data-testid="finance-synthetic-contract-card"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--hairline)] bg-[var(--bg-plane)] px-4 py-2">
          <div className="flex items-center gap-2">
            <span className="font-mono-code text-[11px] uppercase tracking-[0.04em] text-[var(--ink-secondary)]">
              CONTRACT CLAUSES & PAYMENT MILESTONES · 合同条款与付款里程碑核对
            </span>
            <SourceTag source="synthetic" />
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setClauseModalOpen(true)}
            data-testid="finance-contract-fullscreen-btn"
            className="h-6 px-2 text-[11.5px]"
          >
            <Maximize2 className="h-3 w-3" />
            <span>全屏条款对比</span>
          </Button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-[12px]">
            <thead>
              <tr className="border-b border-[var(--hairline)] bg-[var(--bg-subtle)] text-[11px] text-[var(--ink-muted)]">
                <th className="px-3 py-2 font-medium">条款号</th>
                <th className="px-3 py-2 font-medium">条款主题</th>
                <th className="px-3 py-2 font-medium">付款里程碑</th>
                <th className="px-3 py-2 font-medium text-right">核对状态</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--hairline-subtle)]">
              {SYNTHETIC_CONTRACT_CLAUSES.map((clause) => (
                <tr
                  key={clause.clauseId}
                  className="hover:bg-[var(--bg-subtle)]"
                >
                  <td className="px-3 py-2 font-mono-code font-semibold text-[var(--ink-primary)]">
                    {clause.clauseId}
                  </td>
                  <td className="px-3 py-2 font-medium text-[var(--ink-primary)]">
                    {clause.topic}
                  </td>
                  <td className="px-3 py-2 text-[var(--ink-secondary)]">
                    {clause.paymentMilestone}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {clause.riskLevel === "review" ? (
                      <span className="inline-flex items-center gap-1 font-medium text-[var(--status-amber-ink)]">
                        <AlertTriangle className="h-3.5 w-3.5" />
                        <span>偏离标准条款</span>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 font-medium text-[var(--status-emerald)]">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        <span>符合标准模板</span>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Expandable Fullscreen Modal for Wide Contract Clause Comparison */}
      <Modal
        open={clauseModalOpen}
        onOpenChange={setClauseModalOpen}
        title="合同条款与付款里程碑全屏对比（合成演示数据）"
        subtitle="宽表并排比对标准模板与拟签条款差异，便于财务与法务审阅付款节点与风险边界。"
        size="xl"
        expandable
      >
        <div
          className="space-y-3"
          data-testid="finance-contract-fullscreen-modal"
        >
          <div className="flex items-center justify-between">
            <SourceTag source="synthetic" />
            <span className="text-[12px] text-[var(--ink-muted)]">
              演示合同模板，不代表真实外部 ERP/法务系统写入记录
            </span>
          </div>
          <div className="overflow-x-auto rounded-[4px] border border-[var(--hairline)]">
            <table className="w-full border-collapse text-left text-[13px]">
              <thead>
                <tr className="border-b border-[var(--hairline)] bg-[var(--bg-plane)] text-[12px] text-[var(--ink-secondary)]">
                  <th className="px-3.5 py-2.5 font-medium w-[90px]">编号</th>
                  <th className="px-3.5 py-2.5 font-medium w-[18%]">条款主题</th>
                  <th className="px-3.5 py-2.5 font-medium w-[27%]">
                    标准模板条款
                  </th>
                  <th className="px-3.5 py-2.5 font-medium w-[28%]">
                    拟签合同条款
                  </th>
                  <th className="px-3.5 py-2.5 font-medium w-[18%]">
                    付款里程碑
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--hairline-subtle)]">
                {SYNTHETIC_CONTRACT_CLAUSES.map((clause) => (
                  <tr
                    key={clause.clauseId}
                    className={
                      clause.riskLevel === "review"
                        ? "bg-[var(--status-amber-wash)]/45"
                        : ""
                    }
                  >
                    <td className="px-3.5 py-3 font-mono-code font-semibold text-[var(--ink-primary)]">
                      {clause.clauseId}
                    </td>
                    <td className="px-3.5 py-3 font-medium text-[var(--ink-primary)]">
                      {clause.topic}
                    </td>
                    <td className="px-3.5 py-3 text-[var(--ink-muted)]">
                      {clause.standardTerm}
                    </td>
                    <td className="px-3.5 py-3 font-medium text-[var(--ink-primary)]">
                      {clause.proposedTerm}
                    </td>
                    <td className="px-3.5 py-3 text-[var(--ink-secondary)]">
                      {clause.paymentMilestone}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Modal>
    </div>
  );
}
