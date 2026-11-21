"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  BarChart3,
  Briefcase,
  ClipboardCheck,
  Eye,
  EyeOff,
  FilePlus2,
  Receipt,
  Scale,
  SlidersHorizontal,
  Truck,
} from "lucide-react";
import { useSession } from "@/lib/session-context";
import { Button } from "@/components/ui/Button";
import { ApprovalsModule } from "@/features/workbench/ApprovalsModule";
import { AssurancePanel } from "@/features/workbench/AssurancePanel";
import { DecisionModule } from "@/features/workbench/DecisionModule";
import { DispatchModule } from "@/features/workbench/DispatchModule";
import { FinanceModule } from "@/features/workbench/FinanceModule";
import { OrdersModule } from "@/features/workbench/OrdersModule";
import { UnifiedQueuesPanel } from "@/features/workbench/UnifiedQueuesPanel";
import {
  ALL_MODULE_SPECS,
  deriveAuthorizedModules,
  type WorkbenchModuleId,
} from "@/features/workbench/types";

const MODULE_ICONS: Record<
  WorkbenchModuleId,
  React.ComponentType<{ className?: string; strokeWidth?: number }>
> = {
  queues: Briefcase,
  orders: FilePlus2,
  approvals: ClipboardCheck,
  dispatch: Truck,
  finance: Receipt,
  assurance: Scale,
  decision: BarChart3,
};

export function WorkbenchView() {
  const { actor, capabilities, authGeneration, canCreateOrder } = useSession();

  // Strictly derived from server capabilities & grants — NEVER bypassed by client preference
  const authorizedModules = useMemo(
    () => deriveAuthorizedModules(actor, capabilities),
    [actor, capabilities],
  );

  // In-memory ONLY display order & hide preference (reset on authGeneration change; never persisted)
  const [customOrder, setCustomOrder] = useState<WorkbenchModuleId[]>([]);
  const [hiddenModules, setHiddenModules] = useState<
    Partial<Record<WorkbenchModuleId, boolean>>
  >({});
  const [activeModule, setActiveModule] = useState<WorkbenchModuleId>("queues");
  const [prefsOpen, setPrefsOpen] = useState(false);

  // Purge personal display preferences on account switch / authGeneration bump
  useEffect(() => {
    setCustomOrder([]);
    setHiddenModules({});
    setActiveModule("queues");
    setPrefsOpen(false);
  }, [authGeneration]);

  // Effective ordered modules = intersection of authorizedModules with in-memory display order
  const orderedAuthorizedModules = useMemo(() => {
    const authSet = new Set(authorizedModules);
    const kept = customOrder.filter((id) => authSet.has(id));
    const missing = authorizedModules.filter((id) => !kept.includes(id));
    return [...kept, ...missing];
  }, [authorizedModules, customOrder]);

  const visibleModules = useMemo(() => {
    return orderedAuthorizedModules.filter(
      (id) => ALL_MODULE_SPECS[id].required || !hiddenModules[id],
    );
  }, [orderedAuthorizedModules, hiddenModules]);

  // Keep activeModule valid whenever capabilities shrink or tab gets hidden
  useEffect(() => {
    if (!visibleModules.includes(activeModule)) {
      setActiveModule(visibleModules[0] ?? "queues");
    }
  }, [visibleModules, activeModule]);

  const moveModule = (id: WorkbenchModuleId, direction: -1 | 1) => {
    const current = [...orderedAuthorizedModules];
    const idx = current.indexOf(id);
    if (idx < 0) return;
    const target = idx + direction;
    if (target < 0 || target >= current.length) return;
    const next = [...current];
    const [item] = next.splice(idx, 1);
    next.splice(target, 0, item!);
    setCustomOrder(next);
  };

  const toggleHideModule = (id: WorkbenchModuleId) => {
    if (ALL_MODULE_SPECS[id].required) return;
    setHiddenModules((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const activeSpec = ALL_MODULE_SPECS[activeModule];

  return (
    <div
      className="mx-auto max-w-[1260px] space-y-4 p-4 lg:p-6 pb-16"
      data-testid="workbench-page"
    >
      {/* Top Capability-Driven Modular Tab Bar */}
      <div className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-sheet)]">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--hairline)] bg-[var(--bg-plane)] px-4 py-2.5">
          <div className="min-w-0">
            <div className="font-mono-code text-[10.5px] uppercase tracking-[0.04em] text-[var(--ink-muted)]">
              WORKBENCH · {actor?.tenant ?? "—"} ·{" "}
              {actor?.warehouses.join(", ") || "NO-SITE"}
            </div>
            <h2 className="text-[15px] font-semibold text-[var(--ink-primary)]">
              {activeSpec.label}
            </h2>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {canCreateOrder && (
              <Link
                href="/orders/new"
                data-testid="work-header-new-order-link"
                className="inline-flex h-8 items-center gap-1.5 rounded-[4px] bg-[var(--accent)] px-3 text-[12.5px] font-medium text-white hover:bg-[var(--accent-hover)]"
              >
                <FilePlus2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                <span>新建订单进件</span>
              </Link>
            )}

            <Button
              size="sm"
              variant="secondary"
              onClick={() => setPrefsOpen((v) => !v)}
              aria-expanded={prefsOpen}
              data-testid="work-view-prefs-btn"
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              <span>模块排序/隐藏</span>
            </Button>
          </div>
        </div>

        {/* Modular Tabs Row */}
        <div
          role="tablist"
          aria-label="能力驱动业务模块"
          className="flex flex-wrap items-center gap-1 border-b border-[var(--hairline)] bg-[var(--bg-sheet)] px-3 pt-1.5"
        >
          {visibleModules.map((id) => {
            const spec = ALL_MODULE_SPECS[id];
            const Icon = MODULE_ICONS[id];
            const active = activeModule === id;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={active}
                data-testid={`work-tab-${id}`}
                onClick={() => setActiveModule(id)}
                className={[
                  "inline-flex items-center gap-1.5 border-b-2 -mb-px px-3 py-2 text-[13px] font-medium transition-colors duration-[120ms] cursor-pointer",
                  active
                    ? "border-[var(--accent)] text-[var(--accent)]"
                    : "border-transparent text-[var(--ink-secondary)] hover:text-[var(--ink-primary)]",
                ].join(" ")}
              >
                <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
                <span>{spec.label}</span>
              </button>
            );
          })}
        </div>

        {/* In-Memory Display Order & Hide Preferences Bar */}
        {prefsOpen && (
          <div
            data-testid="work-view-prefs-panel"
            className="border-b border-[var(--hairline)] bg-[var(--bg-subtle)] px-4 py-3 space-y-2"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
              <span className="font-medium text-[var(--ink-primary)]">
                界面显示顺序与折叠（仅内存生效，严格受服务端 capabilities 边界约束）
              </span>
              <button
                type="button"
                onClick={() => {
                  setCustomOrder([]);
                  setHiddenModules({});
                }}
                className="text-[12px] text-[var(--accent)] hover:underline cursor-pointer"
              >
                恢复默认顺序
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              {orderedAuthorizedModules.map((id, idx) => {
                const spec = ALL_MODULE_SPECS[id];
                const isHidden = Boolean(hiddenModules[id]);
                return (
                  <div
                    key={id}
                    className={[
                      "inline-flex items-center gap-1.5 rounded-[4px] border px-2 py-1 text-[12px]",
                      isHidden
                        ? "border-[var(--hairline)] bg-[var(--bg-plane)] text-[var(--ink-muted)]"
                        : "border-[var(--hairline-strong)] bg-[var(--bg-sheet)] text-[var(--ink-primary)]",
                    ].join(" ")}
                  >
                    <span className="font-medium">{spec.label}</span>
                    <button
                      type="button"
                      disabled={idx === 0}
                      onClick={() => moveModule(id, -1)}
                      aria-label={`将 ${spec.label} 左移`}
                      className="inline-flex h-5 w-5 items-center justify-center rounded-[2px] hover:bg-[var(--bg-plane)] disabled:opacity-30 cursor-pointer"
                    >
                      <ArrowLeft className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      disabled={idx === orderedAuthorizedModules.length - 1}
                      onClick={() => moveModule(id, 1)}
                      aria-label={`将 ${spec.label} 右移`}
                      className="inline-flex h-5 w-5 items-center justify-center rounded-[2px] hover:bg-[var(--bg-plane)] disabled:opacity-30 cursor-pointer"
                    >
                      <ArrowRight className="h-3 w-3" />
                    </button>
                    {!spec.required && (
                      <button
                        type="button"
                        onClick={() => toggleHideModule(id)}
                        aria-label={
                          isHidden ? `显示 ${spec.label}` : `隐藏 ${spec.label}`
                        }
                        className="inline-flex h-5 w-5 items-center justify-center rounded-[2px] hover:bg-[var(--bg-plane)] cursor-pointer"
                      >
                        {isHidden ? (
                          <EyeOff className="h-3 w-3" />
                        ) : (
                          <Eye className="h-3 w-3" />
                        )}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="px-4 py-2 text-[12px] text-[var(--ink-muted)]">
          {activeSpec.description}
        </div>
      </div>

      {/* Active Capability-Authorized Module Surface */}
      <div>
        {activeModule === "queues" && <UnifiedQueuesPanel />}
        {activeModule === "orders" && <OrdersModule />}
        {activeModule === "approvals" && <ApprovalsModule />}
        {activeModule === "dispatch" && <DispatchModule />}
        {activeModule === "finance" && <FinanceModule />}
        {activeModule === "assurance" && <AssurancePanel />}
        {activeModule === "decision" && <DecisionModule />}
      </div>
    </div>
  );
}
