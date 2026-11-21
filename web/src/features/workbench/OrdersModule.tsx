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
      {/* Quick Entry & Intake Lookup Strip */}
      <div className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-sheet)] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <h2 className="text-[14px] font-semibold text-[var(--ink-primary)]">
              接单与销售订单草稿工作区
            </h2>
            <p className="text-[12px] text-[var(--ink-muted)]">
              已授权写入站点：
              <span className="font-mono-code text-[var(--ink-primary)]">
                {orderWriteWarehouses.join(", ") || "无（只读）"}
              </span>{" "}
              · 已授权读取站点：
              <span className="font-mono-code text-[var(--ink-primary)]">
                {orderReadWarehouses.join(", ") || "无"}
              </span>
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
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
              <input
                type="text"
                value={intakeQuery}
                onChange={(e) => setIntakeQuery(e.target.value)}
                placeholder="输入 intake_id 面板核对"
                className="h-8 w-48 rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-2.5 font-mono-code text-[12px]"
              />
              <Button size="sm" variant="secondary" type="submit">
                <Search className="h-3.5 w-3.5" />
                <PanelRight className="h-3.5 w-3.5" />
              </Button>
            </form>

            {canCreateOrder && (
              <Link
                href="/orders/new"
                data-testid="work-new-order-link"
                className="inline-flex h-9 items-center gap-1.5 rounded-[4px] bg-[var(--accent)] px-3.5 text-[13px] font-medium text-white hover:bg-[var(--accent-hover)]"
              >
                <FilePlus2 className="h-4 w-4" strokeWidth={1.75} />
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
