"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  BarChart3,
  Building2,
  Package,
  PanelRight,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import {
  callWorkbenchTool,
  getAuthGeneration,
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
import { SourceTag } from "@/components/ui/SourceTag";
import type { WarehouseDecisionSummary } from "@/lib/types";

interface SummaryEntry {
  warehouse: string;
  loading: boolean;
  data: WarehouseDecisionSummary | null;
  source: string | null;
  error: ApiError | null;
  verifiedAt: number | null;
}

export function DecisionModule() {
  const { tx, localizeError } = useLocale();
  const { capabilities, authGeneration, handleAccessChanged } = useSession();
  const { openDrawer } = useWorkbench();

  const summaryTool = useMemo(
    () =>
      capabilities?.tools.find(
        (tItem) => tItem.id === "decision.warehouse.summary",
      ),
    [capabilities],
  );
  const authorizedWarehouses = useMemo(
    () => sortWarehouses(summaryTool?.warehouses ?? []),
    [summaryTool],
  );

  const [entries, setEntries] = useState<Record<string, SummaryEntry>>({});

  const fetchOneWarehouse = useCallback(
    async (wh: string) => {
      const startGen = getAuthGeneration();
      setEntries((prev) => ({
        ...prev,
        [wh]: {
          warehouse: wh,
          loading: true,
          data: prev[wh]?.data ?? null,
          source: prev[wh]?.source ?? null,
          error: null,
          verifiedAt: prev[wh]?.verifiedAt ?? null,
        },
      }));
      try {
        const res = await callWorkbenchTool({
          tool: "decision.warehouse.summary",
          warehouse: wh,
        });
        if (startGen !== getAuthGeneration()) return;
        if (res.kind === "result") {
          setEntries((prev) => ({
            ...prev,
            [wh]: {
              warehouse: wh,
              loading: false,
              data: res.data as WarehouseDecisionSummary,
              source: res.source,
              error: null,
              verifiedAt: Date.now(),
            },
          }));
        }
      } catch (err) {
        if (isStaleAuthError(err) || startGen !== getAuthGeneration()) return;
        if (isApiError(err)) {
          if (err.code === "ACCESS_CHANGED") {
            setEntries({});
            void handleAccessChanged();
            return;
          }
          setEntries((prev) => ({
            ...prev,
            [wh]: {
              warehouse: wh,
              loading: false,
              data: null,
              source: null,
              error: err,
              verifiedAt: null,
            },
          }));
        }
      }
    },
    [handleAccessChanged],
  );

  useEffect(() => {
    setEntries({});
    for (const wh of authorizedWarehouses) {
      void fetchOneWarehouse(wh);
    }
  }, [authorizedWarehouses, authGeneration, fetchOneWarehouse]);

  const totalOpenShipments = useMemo(() => {
    return authorizedWarehouses.reduce(
      (sum, wh) => sum + (entries[wh]?.data?.open_shipments ?? 0),
      0,
    );
  }, [authorizedWarehouses, entries]);

  return (
    <div className="space-y-4" data-testid="workbench-decision-module">
      {authorizedWarehouses.length === 0 ? (
        <div className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] p-5">
          <AccessNoticeCard
            variant="ACCESS_RESTRICTED"
            title={tx({
              "zh-CN": "暂无经营汇总可见仓库",
              "zh-HK": "暫無營運摘要可見倉庫",
              en: "No Authorized Summary Warehouses",
            })}
            message={tx({
              "zh-CN": "当前账号未获授权访问任何仓库的经营汇总数据。",
              "zh-HK": "目前帳號未獲授權存取任何倉庫的營運摘要資料。",
              en: "Your account is not authorized to view operational summaries for any warehouse.",
            })}
          />
        </div>
      ) : (
        <>
          {/* Sheen-only Warehouse Summary KPI Row (strictly real backend numbers, no false-affordance tilt) */}
          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-3">
            <Interactive3DCard
              interactive={false}
              sheenIntensity="subtle"
              className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] p-5"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12.5px] font-medium text-[var(--ink-muted)]">
                  {tx({
                    "zh-CN": "已授权统计仓库",
                    "zh-HK": "已授權統計倉庫",
                    en: "Authorized Warehouses",
                  })}
                </span>
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--bg-surface)] text-[var(--ink-secondary)] shadow-[var(--shadow-subtle)]">
                  <Building2 className="h-4 w-4" strokeWidth={1.85} />
                </span>
              </div>
              <div className="mt-2.5 tabular-nums text-[28px] font-semibold tracking-[-0.02em] text-[var(--ink-primary)]">
                {authorizedWarehouses.length}
              </div>
              <div className="mt-1 font-mono-code text-[11.5px] text-[var(--ink-muted)]">
                {authorizedWarehouses.join(" · ")}
              </div>
            </Interactive3DCard>

            <Interactive3DCard
              interactive={false}
              sheenIntensity="subtle"
              className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] p-5"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12.5px] font-medium text-[var(--ink-muted)]">
                  {tx({
                    "zh-CN": "实时在途 / 未结运单合计",
                    "zh-HK": "即時在途 / 未結運單合計",
                    en: "Total Open Shipments",
                  })}
                </span>
                <span
                  className={[
                    "flex h-8 w-8 items-center justify-center rounded-full shadow-[var(--shadow-subtle)]",
                    totalOpenShipments > 0
                      ? "bg-[var(--accent-wash)] text-[var(--accent-ink)]"
                      : "bg-[var(--bg-surface)] text-[var(--ink-secondary)]",
                  ].join(" ")}
                >
                  <Package className="h-4 w-4" strokeWidth={1.85} />
                </span>
              </div>
              <div
                className="mt-2.5 tabular-nums text-[28px] font-semibold tracking-[-0.02em] text-[var(--accent)]"
                data-testid="decision-total-open-shipments"
              >
                {totalOpenShipments}
              </div>
              <div className="mt-1 text-[11.5px] text-[var(--ink-muted)]">
                {tx({
                  "zh-CN": "全部授权仓库实时聚合计数",
                  "zh-HK": "全部授權倉庫即時彙總計數",
                  en: "Live aggregate across all authorized warehouses",
                })}
              </div>
            </Interactive3DCard>

            <Interactive3DCard
              interactive={false}
              sheenIntensity="subtle"
              className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] p-5"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12.5px] font-medium text-[var(--ink-muted)]">
                  {tx({
                    "zh-CN": "权限边界模式",
                    "zh-HK": "權限邊界模式",
                    en: "Access Boundary",
                  })}
                </span>
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--bg-surface)] text-[var(--ink-secondary)] shadow-[var(--shadow-subtle)]">
                  <ShieldCheck className="h-4 w-4" strokeWidth={1.85} />
                </span>
              </div>
              <div className="mt-3 text-[15px] font-semibold text-[var(--status-emerald)]">
                {tx({
                  "zh-CN": "只读视图 · 实时鉴权",
                  "zh-HK": "唯讀檢視 · 即時鑑權",
                  en: "Read-Only · Live Auth",
                })}
              </div>
              <div className="mt-1 text-[11.5px] text-[var(--ink-muted)]">
                {tx({
                  "zh-CN": "每次刷新与下钻均由服务端重新校验",
                  "zh-HK": "每次重新整理與下鑽均由伺服器端重新校驗",
                  en: "Every refresh and drill-down re-verifies server permissions",
                })}
              </div>
            </Interactive3DCard>
          </div>

          {/* Flat Steady Per-Warehouse Real Metrics Porcelain Sheet */}
          <div className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--hairline)] px-5 py-4">
              <div>
                <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--ink-primary)]">
                  {tx({
                    "zh-CN": "跨仓经营只读汇总",
                    "zh-HK": "跨倉營運唯讀摘要",
                    en: "Cross-Warehouse Read-Only Summary",
                  })}
                </h2>
                <p className="mt-0.5 text-[12.5px] text-[var(--ink-muted)]">
                  {tx({
                    "zh-CN":
                      "严格呈现服务端实时运营指标；点击单仓下钻将即时触发服务端鉴权核验。",
                    "zh-HK":
                      "嚴格呈現伺服器端即時營運指標；點擊單倉下鑽將即時觸發伺服器端鑑權核驗。",
                    en: "Live server operational metrics; drilling into any warehouse triggers fresh authorization.",
                  })}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {summaryTool && <SourceTag source={summaryTool.source} />}
                <Button
                  size="sm"
                  pill
                  variant="secondary"
                  onClick={() => {
                    for (const wh of authorizedWarehouses) {
                      void fetchOneWarehouse(wh);
                    }
                  }}
                  data-testid="decision-refresh-all-btn"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  <span>
                    {tx({
                      "zh-CN": "实时刷新全部仓库",
                      "zh-HK": "即時重新整理全部倉庫",
                      en: "Refresh All Warehouses",
                    })}
                  </span>
                </Button>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-[13px]">
                <thead>
                  <tr className="border-b border-[var(--hairline-subtle)] bg-[var(--bg-surface-tint)] text-[11.5px] text-[var(--ink-muted)]">
                    <th className="px-5 py-2.5 font-medium">
                      {tx({
                        "zh-CN": "仓库",
                        "zh-HK": "倉庫",
                        en: "Warehouse",
                      })}
                    </th>
                    <th className="px-4 py-2.5 font-medium text-right">
                      {tx({
                        "zh-CN": "在途未结运单",
                        "zh-HK": "在途未結運單",
                        en: "Open Shipments",
                      })}
                    </th>
                    <th className="px-4 py-2.5 font-medium">
                      {tx({
                        "zh-CN": "统计基准日",
                        "zh-HK": "統計基準日",
                        en: "As-Of Date",
                      })}
                    </th>
                    <th className="px-4 py-2.5 font-medium">
                      {tx({
                        "zh-CN": "数据来源",
                        "zh-HK": "資料來源",
                        en: "Source",
                      })}
                    </th>
                    <th className="px-5 py-2.5 font-medium text-right">
                      {tx({
                        "zh-CN": "实时鉴权下钻",
                        "zh-HK": "即時鑑權下鑽",
                        en: "Authorized Drill-Down",
                      })}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--hairline-subtle)]">
                  {authorizedWarehouses.map((wh) => {
                    const entry = entries[wh];
                    return (
                      <tr
                        key={wh}
                        data-testid={`decision-row-${wh}`}
                        className="hover:bg-[var(--bg-surface-tint)]/80 transition-colors duration-[150ms]"
                      >
                        <td className="px-5 py-3.5 font-mono-code font-semibold text-[var(--ink-primary)]">
                          <div className="flex items-center gap-2.5">
                            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--accent-wash)] text-[var(--accent-ink)]">
                              <BarChart3 className="h-3.5 w-3.5" />
                            </span>
                            <span>{wh}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3.5 tabular-nums text-right text-[16px] font-semibold text-[var(--ink-primary)]">
                          {entry?.loading
                            ? "…"
                            : entry?.data
                              ? entry.data.open_shipments
                              : "—"}
                        </td>
                        <td className="px-4 py-3.5 font-mono-code tabular-nums text-[var(--ink-secondary)]">
                          {entry?.data?.as_of ?? "—"}
                        </td>
                        <td className="px-4 py-3.5">
                          {entry?.source ? (
                            <SourceTag source={entry.source} />
                          ) : entry?.error ? (
                            <span className="text-[12px] text-[var(--status-crimson)]">
                              {localizeError(entry.error)}
                            </span>
                          ) : (
                            <span className="text-[var(--ink-muted)]">—</span>
                          )}
                        </td>
                        <td className="px-5 py-3.5 text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-1.5">
                            <Button
                              size="sm"
                              pill
                              variant="secondary"
                              loading={entry?.loading}
                              onClick={() => void fetchOneWarehouse(wh)}
                              data-testid={`decision-reverify-${wh}`}
                            >
                              <RefreshCw className="h-3 w-3" />
                              <span>
                                {tx({
                                  "zh-CN": "重新鉴权拉取",
                                  "zh-HK": "重新鑑權拉取",
                                  en: "Re-Verify",
                                })}
                              </span>
                            </Button>
                            <Button
                              size="sm"
                              pill
                              variant="quiet"
                              onClick={(e) => {
                                void fetchOneWarehouse(wh);
                                openDrawer(
                                  {
                                    kind: "summary",
                                    id: wh,
                                    warehouse: wh,
                                    title: tx(
                                      {
                                        "zh-CN": "经营汇总下钻 · {wh}",
                                        "zh-HK": "營運摘要下鑽 · {wh}",
                                        en: "Warehouse Summary · {wh}",
                                      },
                                      { wh },
                                    ),
                                  },
                                  { tab: "current", trigger: e.currentTarget },
                                );
                              }}
                              data-testid={`decision-drilldown-${wh}`}
                            >
                              <PanelRight className="h-3.5 w-3.5" />
                              <span>
                                {tx({
                                  "zh-CN": "下钻面板",
                                  "zh-HK": "下鑽面板",
                                  en: "Inspect",
                                })}
                              </span>
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
