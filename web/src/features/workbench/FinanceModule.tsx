"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FileCheck2,
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
import { sortWarehouses } from "@/lib/format";
import { useLocale } from "@/lib/i18n";
import { useSession } from "@/lib/session-context";
import { useWorkbench } from "@/lib/workbench-context";
import { Interactive3DCard } from "@/components/kinetic/Interactive3DCard";
import { AccessNoticeCard } from "@/components/ui/AccessNoticeCard";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { SourceTag } from "@/components/ui/SourceTag";
import { StatusBadge } from "@/components/ui/StatusBadge";
import type { InvoiceView } from "@/lib/types";
import { AssurancePanel } from "@/features/workbench/AssurancePanel";
import { getSyntheticContractClauses } from "@/features/workbench/types";

export function FinanceModule() {
  const { locale, t, tx, formatCurrency, localizeStatus } = useLocale();
  const { actor, capabilities, authGeneration, handleAccessChanged } =
    useSession();
  const { openDrawer } = useWorkbench();

  const invoiceTool = useMemo(
    () =>
      capabilities?.tools.find((tItem) => tItem.id === "finance.invoice.read"),
    [capabilities],
  );
  const authorizedWarehouses = useMemo(
    () => sortWarehouses(invoiceTool?.warehouses ?? []),
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

  const contractClauses = useMemo(
    () => getSyntheticContractClauses(locale),
    [locale],
  );

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

  const reviewClauseCount = contractClauses.filter(
    (c) => c.riskLevel === "review",
  ).length;

  return (
    <div className="space-y-5" data-testid="workbench-finance-module">
      {/* Real Invoice Lookup Porcelain Card */}
      <div className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--hairline)] px-5 py-4">
          <div>
            <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--ink-primary)]">
              {tx({
                "zh-CN": "实时发票审阅查询",
                "zh-HK": "即時發票審閱查詢",
                en: "Live Invoice Lookup",
              })}
            </h2>
            <p className="mt-0.5 text-[12.5px] text-[var(--ink-muted)]">
              {tx({
                "zh-CN":
                  "按当前账号授权仓库实时调用财务发票查询接口，支持权责即时收回与跨仓隔离校验。",
                "zh-HK":
                  "按目前帳號授權倉庫即時呼叫財務發票查詢介面，支援權責即時收回與跨倉隔離校驗。",
                en: "Queries authorized warehouses in real time with instant permission revocation and warehouse isolation.",
              })}
            </p>
          </div>
          {invoiceTool && <SourceTag source={invoiceTool.source} />}
        </div>

        <div className="p-5 space-y-4">
          {authorizedWarehouses.length === 0 ? (
            <AccessNoticeCard
              variant="ACCESS_RESTRICTED"
              title={tx({
                "zh-CN": "当前账号未开通发票查询仓库",
                "zh-HK": "目前帳號未開通發票查詢倉庫",
                en: "No Authorized Invoice Warehouses",
              })}
              message={tx({
                "zh-CN":
                  "如需查询仓库发票（例如 HK01 · INV-100），请由权限管理员授予发票审阅模块权限。",
                "zh-HK":
                  "如需查詢倉庫發票（例如 HK01 · INV-100），請由權限管理員授予發票審閱模組權限。",
                en: "Ask an access administrator to grant invoice review access (e.g. HK01 · INV-100).",
              })}
            />
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleLookupInvoice();
              }}
              className="flex flex-wrap items-end gap-3"
            >
              <label className="block space-y-1.5">
                <span className="text-[12px] font-medium text-[var(--ink-secondary)]">
                  {tx({
                    "zh-CN": "授权仓库",
                    "zh-HK": "授權倉庫",
                    en: "Warehouse",
                  })}
                </span>
                <select
                  value={warehouse}
                  onChange={(e) => setWarehouse(e.target.value)}
                  data-testid="finance-warehouse-select"
                  className="h-9 rounded-sm border border-[var(--hairline-strong)] bg-[var(--bg-surface-tint)] px-3 font-mono-code text-[12.5px] font-semibold text-[var(--ink-primary)] focus:bg-[var(--bg-surface)] focus:border-[var(--accent)] focus:ring-3 focus:ring-[var(--accent-ring)] focus:outline-none transition-all duration-[150ms]"
                >
                  {authorizedWarehouses.map((wh) => (
                    <option key={wh} value={wh}>
                      {wh}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block flex-1 min-w-[200px] space-y-1.5">
                <span className="text-[12px] font-medium text-[var(--ink-secondary)]">
                  {tx({
                    "zh-CN": "发票编号",
                    "zh-HK": "發票編號",
                    en: "Invoice ID",
                  })}
                </span>
                <input
                  type="text"
                  required
                  value={invoiceId}
                  onChange={(e) => setInvoiceId(e.target.value)}
                  placeholder={tx({
                    "zh-CN": "例如 INV-100",
                    "zh-HK": "例如 INV-100",
                    en: "e.g. INV-100",
                  })}
                  data-testid="finance-invoice-id-input"
                  className="h-9 w-full rounded-sm border border-[var(--hairline-strong)] bg-[var(--bg-surface-tint)] px-3 font-mono-code text-[13px] text-[var(--ink-primary)] focus:bg-[var(--bg-surface)] focus:border-[var(--accent)] focus:ring-3 focus:ring-[var(--accent-ring)] focus:outline-none transition-all duration-[150ms]"
                />
              </label>

              <Button
                type="submit"
                variant="primary"
                loading={loading}
                data-testid="finance-lookup-btn"
              >
                <Search className="h-3.5 w-3.5" />
                <span>{t("finance.invoiceQuery")}</span>
              </Button>

              {authorizedWarehouses.includes("HK01") && (
                <Button
                  size="sm"
                  pill
                  variant="secondary"
                  onClick={() => {
                    setWarehouse("HK01");
                    setInvoiceId("INV-100");
                    void handleLookupInvoice({ wh: "HK01", id: "INV-100" });
                  }}
                  data-testid="finance-sample-inv100-btn"
                  className="font-mono-code"
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
              className="rounded-tile bg-[var(--bg-surface-tint)] p-4.5 space-y-3.5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--accent-wash)] text-[var(--accent-ink)]">
                    <Receipt className="h-4 w-4" strokeWidth={1.85} />
                  </span>
                  <span className="font-mono-code text-[14.5px] font-semibold text-[var(--ink-primary)]">
                    {invoiceResult.data.invoice_id}
                  </span>
                  <span className="rounded-full bg-[var(--bg-surface)] px-2.5 py-0.5 font-mono-code text-[11px] font-medium text-[var(--ink-secondary)] shadow-[var(--shadow-subtle)]">
                    {invoiceResult.data.warehouse}
                  </span>
                  <StatusBadge status={invoiceResult.data.state} compact />
                  <SourceTag source={invoiceResult.source} />
                </div>

                <Button
                  size="sm"
                  pill
                  variant="secondary"
                  onClick={(e) =>
                    openDrawer(
                      {
                        kind: "invoice",
                        id: invoiceResult.data.invoice_id,
                        warehouse: invoiceResult.data.warehouse,
                        title: tx(
                          {
                            "zh-CN": "发票审阅 · {id}",
                            "zh-HK": "發票審閱 · {id}",
                            en: "Invoice · {id}",
                          },
                          { id: invoiceResult.data.invoice_id },
                        ),
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
                  <span>
                    {tx({
                      "zh-CN": "在右侧面板查看",
                      "zh-HK": "於右側面板檢視",
                      en: "Open in Drawer",
                    })}
                  </span>
                </Button>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 text-[12.5px]">
                <div className="rounded-sm bg-[var(--bg-surface)] px-3.5 py-2.5 shadow-[var(--shadow-subtle)]">
                  <div className="text-[11.5px] text-[var(--ink-muted)]">
                    {tx({
                      "zh-CN": "发票金额",
                      "zh-HK": "發票金額",
                      en: "Invoice Amount",
                    })}
                  </div>
                  <div className="mt-0.5 font-mono-code tabular-nums text-[16px] font-semibold text-[var(--ink-primary)]">
                    {formatCurrency(
                      invoiceResult.data.amount,
                      invoiceResult.data.currency,
                    )}
                  </div>
                </div>
                <div className="rounded-sm bg-[var(--bg-surface)] px-3.5 py-2.5 shadow-[var(--shadow-subtle)]">
                  <div className="text-[11.5px] text-[var(--ink-muted)]">
                    {tx({
                      "zh-CN": "所属仓库",
                      "zh-HK": "所屬倉庫",
                      en: "Warehouse",
                    })}
                  </div>
                  <div className="mt-0.5 font-mono-code text-[14px] font-medium text-[var(--ink-primary)]">
                    {invoiceResult.data.warehouse}
                  </div>
                </div>
                <div className="rounded-sm bg-[var(--bg-surface)] px-3.5 py-2.5 shadow-[var(--shadow-subtle)]">
                  <div className="text-[11.5px] text-[var(--ink-muted)]">
                    {tx({
                      "zh-CN": "结算状态",
                      "zh-HK": "結算狀態",
                      en: "Settlement Status",
                    })}
                  </div>
                  <div className="mt-0.5 font-medium text-[14px] text-[var(--ink-primary)]">
                    {localizeStatus(invoiceResult.data.state)}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Real Assurance Contract Cases (when actor has assurance.contract grant) */}
      {hasContractAssurance && (
        <div className="space-y-2.5">
          <h3 className="px-1 text-[13.5px] font-semibold text-[var(--ink-secondary)]">
            {tx({
              "zh-CN": "关联受控合同预审案件",
              "zh-HK": "關聯受控合約預審案件",
              en: "Linked Governed Contract Assurance Cases",
            })}
          </h3>
          <AssurancePanel fixedKinds={["contract"]} />
        </div>
      )}

      {/* Clearly Labeled Synthetic Contract Clause & Payment Milestone Section */}
      <div className="space-y-3" data-testid="finance-synthetic-contract-card">
        {/* Sheen-only Porcelain Highlight Banner for Synthetic Contract Summary */}
        <Interactive3DCard
          interactive={false}
          sheenIntensity="subtle"
          className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] p-5"
        >
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-start gap-3.5 min-w-0">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--accent-wash)] text-[var(--accent-ink)]">
                <FileCheck2 className="h-5 w-5" strokeWidth={1.85} />
              </span>
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--ink-primary)]">
                    {tx({
                      "zh-CN": "合同条款与付款里程碑核对",
                      "zh-HK": "合約條款與付款里程碑核對",
                      en: "Contract Clauses & Payment Milestones",
                    })}
                  </h3>
                  <SourceTag source="synthetic" />
                </div>
                <p className="text-[12.5px] text-[var(--ink-muted)] leading-relaxed">
                  {tx({ "zh-CN": "共", "zh-HK": "共", en: "Showing" })}{" "}
                  <span className="tabular-nums font-semibold text-[var(--ink-primary)]">
                    {contractClauses.length}
                  </span>{" "}
                  {tx({
                    "zh-CN": "项演示条款，其中",
                    "zh-HK": "項示範條款，其中",
                    en: "demo clauses, with",
                  })}{" "}
                  <span className="tabular-nums font-semibold text-[var(--status-amber-ink)]">
                    {reviewClauseCount}
                  </span>{" "}
                  {tx({
                    "zh-CN":
                      "项偏离标准模板（账期与自动续约），不代表真实外部 ERP 写入记录。",
                    "zh-HK":
                      "項偏離標準範本（帳期與自動續約），不代表真實外部 ERP 寫入紀錄。",
                    en: "deviations from standard template (payment term & auto-renewal); does not represent live ERP records.",
                  })}
                </p>
              </div>
            </div>

            <Button
              size="sm"
              pill
              variant="secondary"
              onClick={() => setClauseModalOpen(true)}
              data-testid="finance-contract-fullscreen-btn"
            >
              <Maximize2 className="h-3.5 w-3.5" />
              <span>
                {tx({
                  "zh-CN": "全屏条款对比",
                  "zh-HK": "全螢幕條款比對",
                  en: "Fullscreen Diff",
                })}
              </span>
            </Button>
          </div>
        </Interactive3DCard>

        {/* Flat Steady Data Table Sheet */}
        <div className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-[12.5px]">
              <thead>
                <tr className="border-b border-[var(--hairline-subtle)] bg-[var(--bg-surface-tint)] text-[11.5px] text-[var(--ink-muted)]">
                  <th className="px-4 py-2.5 font-medium">
                    {tx({
                      "zh-CN": "条款号",
                      "zh-HK": "條款號",
                      en: "Clause",
                    })}
                  </th>
                  <th className="px-3.5 py-2.5 font-medium">
                    {tx({
                      "zh-CN": "条款主题",
                      "zh-HK": "條款主題",
                      en: "Topic",
                    })}
                  </th>
                  <th className="px-3.5 py-2.5 font-medium">
                    {tx({
                      "zh-CN": "付款里程碑",
                      "zh-HK": "付款里程碑",
                      en: "Payment Milestone",
                    })}
                  </th>
                  <th className="px-4 py-2.5 font-medium text-right">
                    {tx({
                      "zh-CN": "核对状态",
                      "zh-HK": "核對狀態",
                      en: "Review Status",
                    })}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--hairline-subtle)]">
                {contractClauses.map((clause) => (
                  <tr
                    key={clause.clauseId}
                    className="hover:bg-[var(--bg-surface-tint)]/80 transition-colors duration-[150ms]"
                  >
                    <td className="px-4 py-3 font-mono-code font-semibold text-[var(--ink-primary)]">
                      {clause.clauseId}
                    </td>
                    <td className="px-3.5 py-3 font-medium text-[var(--ink-primary)]">
                      {clause.topic}
                    </td>
                    <td className="px-3.5 py-3 text-[var(--ink-secondary)]">
                      {clause.paymentMilestone}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {clause.riskLevel === "review" ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-[var(--status-amber-wash)] px-2.5 py-0.5 text-[11.5px] font-medium text-[var(--status-amber-ink)]">
                          <AlertTriangle className="h-3 w-3" />
                          <span>
                            {tx({
                              "zh-CN": "偏离标准条款",
                              "zh-HK": "偏離標準條款",
                              en: "Deviation",
                            })}
                          </span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full bg-[var(--status-emerald-wash)] px-2.5 py-0.5 text-[11.5px] font-medium text-[var(--status-emerald)]">
                          <CheckCircle2 className="h-3 w-3" />
                          <span>
                            {tx({
                              "zh-CN": "符合标准模板",
                              "zh-HK": "符合標準範本",
                              en: "Standard",
                            })}
                          </span>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Expandable Fullscreen Modal for Wide Contract Clause Comparison */}
      <Modal
        open={clauseModalOpen}
        onOpenChange={setClauseModalOpen}
        title={tx({
          "zh-CN": "合同条款与付款里程碑全屏对比（合成演示数据）",
          "zh-HK": "合約條款與付款里程碑全螢幕比對（合成示範資料）",
          en: "Contract Clause & Milestone Comparison (Synthetic Demo)",
        })}
        subtitle={tx({
          "zh-CN":
            "宽表并排比对标准模板与拟签条款差异，便于财务与法务审阅付款节点与风险边界。",
          "zh-HK":
            "寬表並排比對標準範本與擬簽條款差異，便於財務與法務審閱付款節點與風險邊界。",
          en: "Side-by-side comparison of standard template terms vs. proposed contract language.",
        })}
        size="xl"
        expandable
      >
        <div
          className="space-y-3.5"
          data-testid="finance-contract-fullscreen-modal"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <SourceTag source="synthetic" />
            <span className="text-[12px] text-[var(--ink-muted)]">
              {tx({
                "zh-CN":
                  "演示合同模板，不代表真实外部 ERP / 法务系统写入记录",
                "zh-HK":
                  "示範合約範本，不代表真實外部 ERP / 法務系統寫入紀錄",
                en: "Demo contract template — not a live ERP or CLM write record",
              })}
            </span>
          </div>
          <div className="overflow-x-auto rounded-tile bg-[var(--bg-surface)] shadow-[var(--shadow-subtle)]">
            <table className="w-full border-collapse text-left text-[13px]">
              <thead>
                <tr className="border-b border-[var(--hairline-subtle)] bg-[var(--bg-surface-tint)] text-[12px] text-[var(--ink-secondary)]">
                  <th className="px-4 py-3 font-medium w-[90px]">
                    {tx({ "zh-CN": "编号", "zh-HK": "編號", en: "ID" })}
                  </th>
                  <th className="px-4 py-3 font-medium w-[18%]">
                    {tx({
                      "zh-CN": "条款主题",
                      "zh-HK": "條款主題",
                      en: "Topic",
                    })}
                  </th>
                  <th className="px-4 py-3 font-medium w-[27%]">
                    {tx({
                      "zh-CN": "标准模板条款",
                      "zh-HK": "標準範本條款",
                      en: "Standard Template",
                    })}
                  </th>
                  <th className="px-4 py-3 font-medium w-[28%]">
                    {tx({
                      "zh-CN": "拟签合同条款",
                      "zh-HK": "擬簽合約條款",
                      en: "Proposed Clause",
                    })}
                  </th>
                  <th className="px-4 py-3 font-medium w-[18%]">
                    {tx({
                      "zh-CN": "付款里程碑",
                      "zh-HK": "付款里程碑",
                      en: "Payment Milestone",
                    })}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--hairline-subtle)]">
                {contractClauses.map((clause) => (
                  <tr
                    key={clause.clauseId}
                    className={
                      clause.riskLevel === "review"
                        ? "bg-[var(--status-amber-wash)]/45"
                        : ""
                    }
                  >
                    <td className="px-4 py-3.5 font-mono-code font-semibold text-[var(--ink-primary)]">
                      {clause.clauseId}
                    </td>
                    <td className="px-4 py-3.5 font-medium text-[var(--ink-primary)]">
                      {clause.topic}
                    </td>
                    <td className="px-4 py-3.5 text-[var(--ink-muted)]">
                      {clause.standardTerm}
                    </td>
                    <td className="px-4 py-3.5 font-medium text-[var(--ink-primary)]">
                      {clause.proposedTerm}
                    </td>
                    <td className="px-4 py-3.5 text-[var(--ink-secondary)]">
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
