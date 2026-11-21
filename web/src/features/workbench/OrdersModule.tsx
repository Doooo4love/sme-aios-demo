"use client";

import React, { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, FilePlus2, PanelRight, Search } from "lucide-react";
import { useSession } from "@/lib/session-context";
import { useWorkbench } from "@/lib/workbench-context";
import { Button } from "@/components/ui/Button";
import { UnifiedQueuesPanel } from "@/features/workbench/UnifiedQueuesPanel";

export function OrdersModule() {
  const { capabilities, canCreateOrder } = useSession();
  const { openDrawer } = useWorkbench();
  const [intakeQuery, setIntakeQuery] = useState("");

  const orderWriteWarehouses = useMemo(() => {
    return (
      capabilities?.tools.find(
        (t) => t.id === "order.draft.prepare" && t.available,
      )?.warehouses ?? []
    );
  }, [capabilities]);

  const orderReadWarehouses = capabilities?.order_read_warehouses ?? [];

  return (
    <div className="space-y-4" data-testid="workbench-orders-module">
      {/* Quick Entry & Intake Lookup Porcelain Card */}
      <div className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--ink-primary)]">
              接单与销售订单草稿工作区
            </h2>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-[var(--ink-muted)]">
              <span className="inline-flex items-center gap-1.5">
                <span>授权写入站点</span>
                {orderWriteWarehouses.length > 0 ? (
                  orderWriteWarehouses.map((wh) => (
                    <span
                      key={`w-${wh}`}
                      className="rounded-full bg-[var(--accent-wash)] px-2 py-0.5 font-mono-code text-[11px] font-medium text-[var(--accent)]"
                    >
                      {wh}
                    </span>
                  ))
                ) : (
                  <span className="rounded-full bg-[var(--bg-surface-subtle)] px-2 py-0.5 text-[11px] text-[var(--ink-muted)]">
                    仅只读
                  </span>
                )}
              </span>
              <span aria-hidden="true" className="text-[var(--ink-faint)]">
                ·
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span>授权读取站点</span>
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
                  <span>无</span>
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
                    title: `进件证据 · ${id}`,
                  },
                  { tab: "current" },
                );
              }}
              className="flex items-center gap-1.5"
            >
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--ink-faint)]" />
                <input
                  type="text"
                  value={intakeQuery}
                  onChange={(e) => setIntakeQuery(e.target.value)}
                  placeholder="输入进件编号核对"
                  className="h-9 w-52 rounded-full bg-[var(--bg-surface-tint)] border border-[var(--hairline-strong)] pl-8 pr-3 font-mono-code text-[12px] text-[var(--ink-primary)] placeholder:text-[var(--ink-faint)] focus:bg-[var(--bg-surface)] focus:border-[var(--accent)] focus:ring-3 focus:ring-[var(--accent-ring)] focus:outline-none transition-all duration-[160ms]"
                />
              </div>
              <Button
                size="sm"
                pill
                variant="secondary"
                type="submit"
                title="在右侧面板核对进件"
              >
                <PanelRight className="h-3.5 w-3.5" />
                <span>调阅</span>
              </Button>
            </form>

            {canCreateOrder && (
              <Link
                href="/orders/new"
                data-testid="work-new-order-link"
                className="inline-flex h-9 items-center gap-1.5 rounded-full bg-[var(--accent)] px-4 text-[13px] font-medium text-white shadow-[0_1px_2px_rgba(22,104,227,0.24)] hover:bg-[var(--accent-hover)] hover:shadow-[0_4px_12px_-2px_rgba(22,104,227,0.32)] active:scale-[0.98] transition-all duration-[165ms]"
              >
                <FilePlus2 className="h-3.5 w-3.5" strokeWidth={1.9} />
                <span>新建订单进件</span>
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
