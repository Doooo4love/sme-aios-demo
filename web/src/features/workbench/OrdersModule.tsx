"use client";

import React, { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, FilePlus2, PanelRight, Search } from "lucide-react";
import { sortWarehouses } from "@/lib/format";
import { useLocale } from "@/lib/i18n";
import { useSession } from "@/lib/session-context";
import { useWorkbench } from "@/lib/workbench-context";
import { Button } from "@/components/ui/Button";
import { UnifiedQueuesPanel } from "@/features/workbench/UnifiedQueuesPanel";

export function OrdersModule() {
  const { tx } = useLocale();
  const { capabilities, canCreateOrder } = useSession();
  const { openDrawer } = useWorkbench();
  const [intakeQuery, setIntakeQuery] = useState("");

  const orderWriteWarehouses = useMemo(() => {
    return sortWarehouses(
      capabilities?.tools.find(
        (t) => t.id === "order.draft.prepare" && t.available,
      )?.warehouses ?? [],
    );
  }, [capabilities]);

  const orderReadWarehouses = useMemo(
    () => sortWarehouses(capabilities?.order_read_warehouses ?? []),
    [capabilities?.order_read_warehouses],
  );

  return (
    <div className="space-y-4" data-testid="workbench-orders-module">
      {/* Quick Entry & Intake Lookup Porcelain Card */}
      <div className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--ink-primary)]">
              {tx({
                "zh-CN": "接单与销售订单草稿工作区",
                "zh-HK": "接單與銷售訂單草稿工作區",
                en: "Order Intake & Sales Draft Workspace",
              })}
            </h2>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-[var(--ink-muted)]">
              <span className="inline-flex items-center gap-1.5">
                <span>
                  {tx({
                    "zh-CN": "授权写入仓库",
                    "zh-HK": "授權寫入倉庫",
                    en: "Write Warehouses",
                  })}
                </span>
                {orderWriteWarehouses.length > 0 ? (
                  orderWriteWarehouses.map((wh) => (
                    <span
                      key={`w-${wh}`}
                      className="rounded-full bg-[var(--accent-wash)] px-2 py-0.5 font-mono-code text-[11px] font-medium text-[var(--accent-ink)]"
                    >
                      {wh}
                    </span>
                  ))
                ) : (
                  <span className="rounded-full bg-[var(--bg-surface-subtle)] px-2 py-0.5 text-[11px] text-[var(--ink-muted)]">
                    {tx({
                      "zh-CN": "仅只读",
                      "zh-HK": "僅唯讀",
                      en: "Read-only",
                    })}
                  </span>
                )}
              </span>
              <span aria-hidden="true" className="text-[var(--ink-faint)]">
                ·
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span>
                  {tx({
                    "zh-CN": "授权读取仓库",
                    "zh-HK": "授權讀取倉庫",
                    en: "Read Warehouses",
                  })}
                </span>
                {orderReadWarehouses.length > 0 ? (
                  orderReadWarehouses.map((wh) => (
                    <span
                      key={`r-${wh}`}
                      className="rounded-full bg-[var(--bg-surface-subtle)] px-2 py-0.5 font-mono-code text-[11px] font-medium text-[var(--ink-secondary)]"
                    >
                      {wh}
                    </span>
                  ))
                ) : (
                  <span>
                    {tx({ "zh-CN": "无", "zh-HK": "無", en: "None" })}
                  </span>
                )}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const id = intakeQuery.trim();
                if (!id) return;
                openDrawer(
                  {
                    kind: "intake",
                    id,
                    title: tx(
                      {
                        "zh-CN": "进件证据 · {id}",
                        "zh-HK": "進件憑證 · {id}",
                        en: "Intake Evidence · {id}",
                      },
                      { id },
                    ),
                  },
                  { tab: "current" },
                );
              }}
              className="flex items-center gap-1.5"
            >
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--ink-muted)]" />
                <input
                  type="text"
                  value={intakeQuery}
                  onChange={(e) => setIntakeQuery(e.target.value)}
                  placeholder={tx({
                    "zh-CN": "输入进件编号核对",
                    "zh-HK": "輸入進件編號核對",
                    en: "Enter intake ID to inspect",
                  })}
                  className="h-9 w-52 rounded-full bg-[var(--bg-surface-tint)] border border-[var(--hairline-strong)] pl-8 pr-3 font-mono-code text-[12px] text-[var(--ink-primary)] placeholder:text-[var(--ink-faint)] focus:bg-[var(--bg-surface)] focus:border-[var(--accent)] focus:ring-3 focus:ring-[var(--accent-ring)] focus:outline-none transition-all duration-[160ms]"
                />
              </div>
              <Button
                size="sm"
                pill
                variant="secondary"
                type="submit"
                title={tx({
                  "zh-CN": "在右侧面板核对进件",
                  "zh-HK": "於右側面板核對進件",
                  en: "Inspect intake in side drawer",
                })}
              >
                <PanelRight className="h-3.5 w-3.5" />
                <span>
                  {tx({ "zh-CN": "调阅", "zh-HK": "調閱", en: "Inspect" })}
                </span>
              </Button>
            </form>

            {canCreateOrder && (
              <Link
                href="/orders/new"
                data-testid="work-new-order-link"
                className="inline-flex h-9 items-center gap-1.5 rounded-full bg-[var(--accent-solid)] px-4 text-[13px] font-medium text-[var(--accent-fg)] shadow-[var(--shadow-subtle)] hover:bg-[var(--accent-solid-hover)] hover:shadow-[var(--shadow-card)] active:scale-[0.98] transition-all duration-[165ms]"
              >
                <FilePlus2 className="h-3.5 w-3.5" strokeWidth={1.9} />
                <span>
                  {tx({
                    "zh-CN": "新建订单进件",
                    "zh-HK": "新增訂單進件",
                    en: "New Order Intake",
                  })}
                </span>
                <ArrowUpRight className="h-3.5 w-3.5" />
              </Link>
            )}
          </div>
        </div>
      </div>

      {/* Compact Sales Order Proposals Queue */}
      <UnifiedQueuesPanel
        actionFilter="sales_order.create_draft"
        defaultView="submitted"
        compactHeader
      />
    </div>
  );
}
