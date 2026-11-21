"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  Briefcase,
  Building2,
  ClipboardCheck,
  Eye,
  EyeOff,
  FilePlus2,
  Inbox,
  Receipt,
  RotateCcw,
  Scale,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  Truck,
  Users,
} from "lucide-react";
import {
  fetchTasks,
  getAuthGeneration,
  isStaleAuthError,
} from "@/lib/api-client";
import { formatRoleLabel } from "@/lib/format";
import { useSession } from "@/lib/session-context";
import { useWorkbench } from "@/lib/workbench-context";
import { Interactive3DCard } from "@/components/kinetic/Interactive3DCard";
import { Avatar } from "@/components/ui/Avatar";
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
  PERMISSION_TIERS,
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

interface GovernanceShortcut {
  id: string;
  href: string;
  label: string;
  caption: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
}

export function WorkbenchView() {
  const {
    actor,
    profile,
    capabilities,
    demoConfig,
    avatarVersion,
    authGeneration,
    canCreateOrder,
    canAccessAdminOps,
    canManagePeople,
  } = useSession();
  const { assignedCount, setAssignedCount } = useWorkbench();

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
  const prefsContainerRef = useRef<HTMLDivElement | null>(null);

  // Real live task KPI counts (strictly from BFF /v1/workbench/tasks, zero fake numbers)
  const [kpiCounts, setKpiCounts] = useState<{
    assigned: number | null;
    submitted: number | null;
  }>({ assigned: null, submitted: null });

  const hasApprovalCapability = useMemo(
    () => authorizedModules.includes("approvals"),
    [authorizedModules],
  );

  const loadKpiCounts = useCallback(async () => {
    const startGen = getAuthGeneration();
    try {
      const [assignedRes, submittedRes] = await Promise.all([
        fetchTasks("assigned", { limit: 50 }),
        fetchTasks("submitted", { limit: 50 }),
      ]);
      if (startGen !== getAuthGeneration()) return;
      setKpiCounts({
        assigned: assignedRes.items.length,
        submitted: submittedRes.items.length,
      });
      setAssignedCount(assignedRes.items.length);
    } catch (error) {
      if (isStaleAuthError(error) || startGen !== getAuthGeneration()) return;
    }
  }, [setAssignedCount]);

  // Purge personal display preferences & reload real KPI counts on authGeneration change
  useEffect(() => {
    setCustomOrder([]);
    setHiddenModules({});
    setActiveModule("queues");
    setPrefsOpen(false);
    setKpiCounts({ assigned: null, submitted: null });
    if (actor) {
      void loadKpiCounts();
    }
  }, [authGeneration, actor, loadKpiCounts]);

  // Close minimal preferences popover on click outside or Escape
  useEffect(() => {
    if (!prefsOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (
        prefsContainerRef.current &&
        !prefsContainerRef.current.contains(e.target as Node)
      ) {
        setPrefsOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPrefsOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [prefsOpen]);

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

  // Governance direct-access cards strictly gated by real server capabilities
  const governanceShortcuts = useMemo<GovernanceShortcut[]>(() => {
    const list: GovernanceShortcut[] = [];
    if (canManagePeople) {
      list.push({
        id: "people",
        href: "/admin/people",
        label: "员工模块权限",
        caption: "岗位授权、仓库范围与生效期管理",
        icon: Users,
      });
    }
    if (canAccessAdminOps) {
      list.push({
        id: "ops",
        href: "/admin",
        label: "运维监控与异常",
        caption: "出站队列、熔断开关与异常回执核查",
        icon: Activity,
      });
    }
    return list;
  }, [canManagePeople, canAccessAdminOps]);

  // Group visible modules into explicit Permission Tiers (only rendering tiers with >=1 authorized capability)
  const visibleTiers = useMemo(() => {
    const orderRank = new Map<WorkbenchModuleId, number>();
    visibleModules.forEach((id, idx) => orderRank.set(id, idx));

    return PERMISSION_TIERS.map((tier) => {
      if (tier.id === "governance") {
        return {
          ...tier,
          modules: [] as WorkbenchModuleId[],
          shortcuts: governanceShortcuts,
        };
      }
      const tierModules = tier.moduleIds
        .filter((id) => orderRank.has(id))
        .sort((a, b) => (orderRank.get(a) ?? 0) - (orderRank.get(b) ?? 0));
      return {
        ...tier,
        modules: tierModules,
        shortcuts: [] as GovernanceShortcut[],
      };
    }).filter((tier) => tier.modules.length > 0 || tier.shortcuts.length > 0);
  }, [visibleModules, governanceShortcuts]);

  const activeSpec = ALL_MODULE_SPECS[activeModule];

  // Always prefer human display name (profile display_name -> persona display_name/label -> subject)
  const userDisplayName = useMemo(() => {
    const rawProfileName = profile?.display_name?.trim();
    if (rawProfileName && rawProfileName !== actor?.subject) {
      return rawProfileName;
    }
    const persona = demoConfig?.personas.find(
      (p) => p.subject === actor?.subject,
    );
    return (
      persona?.display_name ||
      persona?.label ||
      rawProfileName ||
      actor?.subject ||
      "成员"
    );
  }, [profile?.display_name, actor?.subject, demoConfig?.personas]);

  const userAvatarSrc = profile?.has_avatar
    ? `/v1/profile/avatar?v=${avatarVersion}`
    : null;
  const warehouses = actor?.warehouses ?? [];

  const liveAssignedCount =
    kpiCounts.assigned !== null ? kpiCounts.assigned : assignedCount;
  const liveSubmittedCount = kpiCounts.submitted;
  const hasActionableAssigned = liveAssignedCount > 0;
  const hasActionableApproval = hasApprovalCapability && liveAssignedCount > 0;

  const handleQueueCountsSync = useCallback(
    (counts: { assigned: number; submitted: number }) => {
      setKpiCounts(counts);
    },
    [],
  );

  return (
    <div
      className="mx-auto max-w-[1280px] space-y-5 px-4 py-5 sm:px-6 lg:py-6 pb-20"
      data-testid="workbench-page"
    >
      {/* 1. Frosted Identity & Role-Scope Hero Strip */}
      <section className="rounded-card bg-[var(--bg-surface)]/92 backdrop-blur-xl shadow-[var(--shadow-card)] p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3.5">
            <Avatar
              src={userAvatarSrc}
              name={userDisplayName}
              fallbackText={actor?.subject || "U"}
              size="lg"
              kind="user"
              status="online"
            />
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-[19px] font-semibold tracking-[-0.02em] text-[var(--ink-primary)] truncate">
                  {userDisplayName} · 工作台
                </h1>
                {actor?.role && (
                  <span className="inline-flex items-center rounded-full bg-[var(--accent-wash)] px-2.5 py-0.5 text-[11.5px] font-medium text-[var(--accent)]">
                    {formatRoleLabel(actor.role)}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12.5px] text-[var(--ink-muted)]">
                <span>
                  租户{" "}
                  <span className="font-mono-code text-[var(--ink-secondary)]">
                    {actor?.tenant ?? "—"}
                  </span>
                </span>
                <span aria-hidden="true" className="text-[var(--ink-faint)]">
                  ·
                </span>
                <span>
                  账号{" "}
                  <span className="font-mono-code text-[var(--ink-secondary)]">
                    {actor?.subject ?? "—"}
                  </span>
                </span>
                {warehouses.length > 0 && (
                  <>
                    <span
                      aria-hidden="true"
                      className="text-[var(--ink-faint)]"
                    >
                      ·
                    </span>
                    <div className="inline-flex flex-wrap items-center gap-1">
                      <span>授权仓库</span>
                      {warehouses.map((wh) => (
                        <span
                          key={wh}
                          className="rounded-full bg-[var(--bg-surface-subtle)] px-2 py-0.5 font-mono-code text-[11px] font-medium text-[var(--ink-secondary)]"
                        >
                          {wh}
                        </span>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            {canCreateOrder && (
              <Link
                href="/orders/new"
                data-testid="work-header-new-order-link"
                className="inline-flex h-9 items-center gap-1.5 rounded-full bg-[var(--accent)] px-4 text-[13px] font-medium text-white shadow-[0_1px_2px_rgba(22,104,227,0.24)] hover:bg-[var(--accent-hover)] hover:shadow-[0_4px_12px_-2px_rgba(22,104,227,0.32)] active:scale-[0.98] transition-all duration-[165ms]"
              >
                <FilePlus2 className="h-3.5 w-3.5" strokeWidth={1.9} />
                <span>新建订单进件</span>
              </Link>
            )}

            {/* Minimal Floating Popover for In-Memory Display Preferences */}
            <div className="relative" ref={prefsContainerRef}>
              <Button
                size="md"
                pill
                variant="secondary"
                onClick={() => setPrefsOpen((v) => !v)}
                aria-expanded={prefsOpen}
                aria-haspopup="dialog"
                data-testid="work-view-prefs-btn"
              >
                <SlidersHorizontal className="h-3.5 w-3.5 text-[var(--ink-secondary)]" />
                <span>模块排序</span>
              </Button>

              {prefsOpen && (
                <div
                  role="dialog"
                  aria-label="模块显示顺序与折叠偏好"
                  data-testid="work-view-prefs-panel"
                  className="absolute right-0 top-full z-30 mt-2 w-[min(420px,calc(100vw-32px))] rounded-card bg-[var(--bg-surface)] p-4 shadow-[var(--shadow-popover)] space-y-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-[13.5px] font-semibold text-[var(--ink-primary)]">
                        模块显示偏好
                      </div>
                      <p className="mt-0.5 text-[11.5px] text-[var(--ink-muted)] leading-relaxed">
                        仅调整当前会话内的排序与折叠，严格受服务端授权边界约束。
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setCustomOrder([]);
                        setHiddenModules({});
                      }}
                      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--bg-surface-subtle)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--accent)] hover:bg-[var(--accent-wash)] transition-colors cursor-pointer"
                    >
                      <RotateCcw className="h-3 w-3" />
                      <span>重置</span>
                    </button>
                  </div>

                  <div className="space-y-1.5">
                    {orderedAuthorizedModules.map((id, idx) => {
                      const spec = ALL_MODULE_SPECS[id];
                      const Icon = MODULE_ICONS[id];
                      const isHidden = Boolean(hiddenModules[id]);
                      return (
                        <div
                          key={id}
                          className={[
                            "flex items-center justify-between gap-2 rounded-sm px-3 py-2 text-[12.5px] transition-colors",
                            isHidden
                              ? "bg-[var(--bg-surface-tint)] text-[var(--ink-muted)]"
                              : "bg-[var(--bg-surface-subtle)]/75 text-[var(--ink-primary)]",
                          ].join(" ")}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <Icon
                              className="h-3.5 w-3.5 shrink-0 text-[var(--ink-muted)]"
                              strokeWidth={1.8}
                            />
                            <span className="font-medium truncate">
                              {spec.label}
                            </span>
                            {spec.required && (
                              <span className="rounded-full bg-[var(--bg-surface)] px-1.5 py-0.5 text-[10px] text-[var(--ink-muted)]">
                                常驻
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <button
                              type="button"
                              disabled={idx === 0}
                              onClick={() => moveModule(id, -1)}
                              aria-label={`将 ${spec.label} 左移`}
                              className="inline-flex h-6 w-6 items-center justify-center rounded-full hover:bg-[var(--bg-surface)] disabled:opacity-30 cursor-pointer transition-colors"
                            >
                              <ArrowLeft className="h-3 w-3" />
                            </button>
                            <button
                              type="button"
                              disabled={
                                idx === orderedAuthorizedModules.length - 1
                              }
                              onClick={() => moveModule(id, 1)}
                              aria-label={`将 ${spec.label} 右移`}
                              className="inline-flex h-6 w-6 items-center justify-center rounded-full hover:bg-[var(--bg-surface)] disabled:opacity-30 cursor-pointer transition-colors"
                            >
                              <ArrowRight className="h-3 w-3" />
                            </button>
                            {!spec.required && (
                              <button
                                type="button"
                                onClick={() => toggleHideModule(id)}
                                aria-label={
                                  isHidden
                                    ? `显示 ${spec.label}`
                                    : `隐藏 ${spec.label}`
                                }
                                className="inline-flex h-6 w-6 items-center justify-center rounded-full hover:bg-[var(--bg-surface)] cursor-pointer transition-colors"
                              >
                                {isHidden ? (
                                  <EyeOff className="h-3 w-3" />
                                ) : (
                                  <Eye className="h-3 w-3" />
                                )}
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Real Live KPI Summary Strip (Unified Icon Chips + Interactive vs Sheen-Only Tiles) */}
        <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Interactive3DCard
            maxTilt={2}
            hoverLiftPx={-1}
            sheenIntensity="subtle"
            onClick={() => setActiveModule("queues")}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setActiveModule("queues");
              }
            }}
            className="group cursor-pointer rounded-tile bg-[var(--bg-surface-tint)] p-4 shadow-[var(--shadow-subtle)] hover:bg-[var(--bg-surface)] hover:shadow-[var(--shadow-card)] transition-all duration-[200ms]"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12.5px] font-medium text-[var(--ink-muted)]">
                待我处理
              </span>
              <span
                className={[
                  "flex h-7 w-7 items-center justify-center rounded-full",
                  hasActionableAssigned
                    ? "bg-[var(--accent-wash)] text-[var(--accent)]"
                    : "bg-[var(--bg-surface)] text-[var(--ink-secondary)] shadow-[var(--shadow-subtle)]",
                ].join(" ")}
              >
                <Inbox className="h-3.5 w-3.5" strokeWidth={1.9} />
              </span>
            </div>
            <div className="mt-2 font-mono-code tabular-nums text-[24px] font-semibold tracking-[-0.02em] text-[var(--ink-primary)]">
              {kpiCounts.assigned !== null ? kpiCounts.assigned : "—"}
            </div>
            <div className="mt-1 text-[11.5px] text-[var(--ink-muted)]">
              当前待办与分派任务
            </div>
          </Interactive3DCard>

          <Interactive3DCard
            maxTilt={2}
            hoverLiftPx={-1}
            sheenIntensity="subtle"
            onClick={() => setActiveModule("queues")}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setActiveModule("queues");
              }
            }}
            className="group cursor-pointer rounded-tile bg-[var(--bg-surface-tint)] p-4 shadow-[var(--shadow-subtle)] hover:bg-[var(--bg-surface)] hover:shadow-[var(--shadow-card)] transition-all duration-[200ms]"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12.5px] font-medium text-[var(--ink-muted)]">
                已提交
              </span>
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--bg-surface)] text-[var(--ink-secondary)] shadow-[var(--shadow-subtle)]">
                <Send className="h-3.5 w-3.5" strokeWidth={1.9} />
              </span>
            </div>
            <div className="mt-2 font-mono-code tabular-nums text-[24px] font-semibold tracking-[-0.02em] text-[var(--ink-primary)]">
              {liveSubmittedCount !== null ? liveSubmittedCount : "—"}
            </div>
            <div className="mt-1 text-[11.5px] text-[var(--ink-muted)]">
              本人发起的提案与回执
            </div>
          </Interactive3DCard>

          <Interactive3DCard
            interactive={hasApprovalCapability}
            maxTilt={2}
            hoverLiftPx={-1}
            sheenIntensity="subtle"
            onClick={() => {
              if (
                hasApprovalCapability &&
                visibleModules.includes("approvals")
              ) {
                setActiveModule("approvals");
              }
            }}
            role={hasApprovalCapability ? "button" : undefined}
            tabIndex={hasApprovalCapability ? 0 : undefined}
            onKeyDown={
              hasApprovalCapability
                ? (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      if (visibleModules.includes("approvals")) {
                        setActiveModule("approvals");
                      }
                    }
                  }
                : undefined
            }
            className={[
              "rounded-tile bg-[var(--bg-surface-tint)] p-4 shadow-[var(--shadow-subtle)] transition-all duration-[200ms]",
              hasApprovalCapability
                ? "cursor-pointer hover:bg-[var(--bg-surface)] hover:shadow-[var(--shadow-card)]"
                : "",
            ].join(" ")}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12.5px] font-medium text-[var(--ink-muted)]">
                待我审批
              </span>
              <span
                className={[
                  "flex h-7 w-7 items-center justify-center rounded-full",
                  hasActionableApproval
                    ? "bg-[var(--accent-wash)] text-[var(--accent)]"
                    : "bg-[var(--bg-surface)] text-[var(--ink-secondary)] shadow-[var(--shadow-subtle)]",
                ].join(" ")}
              >
                <ShieldCheck className="h-3.5 w-3.5" strokeWidth={1.9} />
              </span>
            </div>
            <div
              className={[
                "mt-2 font-mono-code tabular-nums text-[24px] font-semibold tracking-[-0.02em]",
                hasActionableApproval
                  ? "text-[var(--accent)]"
                  : "text-[var(--ink-primary)]",
              ].join(" ")}
            >
              {hasApprovalCapability
                ? kpiCounts.assigned !== null
                  ? kpiCounts.assigned
                  : liveAssignedCount
                : "—"}
            </div>
            <div className="mt-1 text-[11.5px] text-[var(--ink-muted)]">
              {hasApprovalCapability
                ? "授权站点待独立确认"
                : "当前岗位未开通审批权限"}
            </div>
          </Interactive3DCard>

          <Interactive3DCard
            interactive={false}
            sheenIntensity="subtle"
            className="rounded-tile bg-[var(--bg-surface-tint)] p-4 shadow-[var(--shadow-subtle)]"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12.5px] font-medium text-[var(--ink-muted)]">
                授权仓库
              </span>
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--bg-surface)] text-[var(--ink-secondary)] shadow-[var(--shadow-subtle)]">
                <Building2 className="h-3.5 w-3.5" strokeWidth={1.9} />
              </span>
            </div>
            <div className="mt-2 font-mono-code tabular-nums text-[24px] font-semibold tracking-[-0.02em] text-[var(--ink-primary)]">
              {warehouses.length}
            </div>
            <div className="mt-1 truncate font-mono-code text-[11.5px] text-[var(--ink-muted)]">
              {warehouses.length > 0 ? warehouses.join(" · ") : "未分配站点"}
            </div>
          </Interactive3DCard>
        </div>
      </section>

      {/* 2. Explicit Permission-Tiered Navigation Hub (Only Authorized Tiers Rendered) */}
      <section
        aria-label="权限层级功能导航"
        className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] p-4 sm:p-5 space-y-4"
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:flex xl:flex-wrap xl:items-stretch">
          {visibleTiers.map((tier) => (
            <div
              key={tier.id}
              data-testid={`work-tier-${tier.id}`}
              className="flex flex-col justify-start rounded-tile bg-[var(--bg-surface-tint)] p-3 xl:flex-1 xl:min-w-[220px]"
            >
              <div className="mb-2 px-1">
                <span className="text-[12px] font-semibold text-[var(--ink-secondary)]">
                  {tier.label}
                </span>
              </div>

              {tier.modules.length > 0 ? (
                <div
                  role="tablist"
                  aria-label={tier.label}
                  className="flex flex-wrap items-center gap-1.5"
                >
                  {tier.modules.map((id) => {
                    const spec = ALL_MODULE_SPECS[id];
                    const Icon = MODULE_ICONS[id];
                    const active = activeModule === id;
                    const showBadge =
                      id === "approvals" && liveAssignedCount > 0;
                    return (
                      <button
                        key={id}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        data-testid={`work-tab-${id}`}
                        onClick={() => setActiveModule(id)}
                        className={[
                          "inline-flex h-9 items-center gap-1.5 rounded-sm px-3 text-[13px] transition-all duration-[165ms] cursor-pointer",
                          active
                            ? "bg-[var(--bg-surface)] text-[var(--accent)] font-semibold shadow-[var(--shadow-subtle)] ring-1 ring-[var(--accent-border)]"
                            : "text-[var(--ink-secondary)] font-medium hover:bg-[var(--bg-surface)]/70 hover:text-[var(--ink-primary)]",
                        ].join(" ")}
                      >
                        <Icon
                          className={[
                            "h-3.5 w-3.5 shrink-0",
                            active
                              ? "text-[var(--accent)]"
                              : "text-[var(--ink-muted)]",
                          ].join(" ")}
                          strokeWidth={1.85}
                        />
                        <span>{spec.label}</span>
                        {showBadge && (
                          <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[var(--accent)] px-1.5 font-mono-code tabular-nums text-[10.5px] font-semibold text-white">
                            {liveAssignedCount > 99 ? "99+" : liveAssignedCount}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-1.5">
                  {tier.shortcuts.map((shortcut) => {
                    const Icon = shortcut.icon;
                    return (
                      <Link
                        key={shortcut.id}
                        href={shortcut.href}
                        data-testid={`work-governance-${shortcut.id}`}
                        className="group inline-flex h-9 items-center gap-1.5 rounded-sm px-3 text-[13px] font-medium text-[var(--ink-secondary)] hover:bg-[var(--bg-surface)]/75 hover:text-[var(--accent)] transition-all duration-[165ms]"
                        title={shortcut.caption}
                      >
                        <Icon
                          className="h-3.5 w-3.5 shrink-0 text-[var(--ink-muted)] group-hover:text-[var(--accent)] transition-colors"
                          strokeWidth={1.85}
                        />
                        <span>{shortcut.label}</span>
                        <ArrowUpRight className="h-3.5 w-3.5 text-[var(--ink-faint)] group-hover:text-[var(--accent)] transition-colors" />
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Active Module Context Line */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--hairline-subtle)] pt-3 px-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[14px] font-semibold text-[var(--ink-primary)]">
              {activeSpec.label}
            </span>
            <span aria-hidden="true" className="text-[var(--ink-faint)]">
              ·
            </span>
            <span className="text-[12.5px] text-[var(--ink-muted)] truncate">
              {activeSpec.description}
            </span>
          </div>
        </div>
      </section>

      {/* 3. Active Capability-Authorized Module Surface */}
      <div>
        {activeModule === "queues" && (
          <UnifiedQueuesPanel onCountsLoaded={handleQueueCountsSync} />
        )}
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
