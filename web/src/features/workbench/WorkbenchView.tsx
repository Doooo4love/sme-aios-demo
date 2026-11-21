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
import { sortWarehouses } from "@/lib/format";
import { useLocale } from "@/lib/i18n";
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
import { fetchWorkbenchApprovals } from "@/features/workbench/api";
import {
  deriveAuthorizedModules,
  getModuleSpecs,
  getPermissionTiers,
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
  const { locale, tx, localizeRole, localizePersona } = useLocale();
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

  const moduleSpecs = useMemo(() => getModuleSpecs(locale), [locale]);
  const permissionTiers = useMemo(() => getPermissionTiers(locale), [locale]);

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
  const [requestedQueueView, setRequestedQueueView] = useState<{
    view: "assigned" | "submitted" | "unified";
    seq: number;
  } | null>(null);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const prefsContainerRef = useRef<HTMLDivElement | null>(null);

  // Real live task & approval KPI counts (strictly from BFF endpoints, zero fake numbers)
  const [kpiCounts, setKpiCounts] = useState<{
    assigned: number | null;
    submitted: number | null;
    approvals: number | null;
  }>({ assigned: null, submitted: null, approvals: null });

  const hasApprovalCapability = useMemo(
    () => authorizedModules.includes("approvals"),
    [authorizedModules],
  );

  const loadKpiCounts = useCallback(async () => {
    const startGen = getAuthGeneration();
    try {
      const [assignedRes, submittedRes, approvalsRes] = await Promise.all([
        fetchTasks("assigned", { limit: 50 }),
        fetchTasks("submitted", { limit: 50 }),
        hasApprovalCapability
          ? fetchWorkbenchApprovals({ limit: 50 }).catch(() => null)
          : Promise.resolve(null),
      ]);
      if (startGen !== getAuthGeneration()) return;
      const approvalTotal = approvalsRes ? approvalsRes.items.length : null;
      setKpiCounts({
        assigned: assignedRes.items.length,
        submitted: submittedRes.items.length,
        approvals: approvalTotal,
      });
      setAssignedCount(assignedRes.items.length);
    } catch (error) {
      if (isStaleAuthError(error) || startGen !== getAuthGeneration()) return;
    }
  }, [hasApprovalCapability, setAssignedCount]);

  // Purge personal display preferences & reload real KPI counts on authGeneration change
  useEffect(() => {
    setCustomOrder([]);
    setHiddenModules({});
    setActiveModule("queues");
    setRequestedQueueView(null);
    setPrefsOpen(false);
    setKpiCounts({ assigned: null, submitted: null, approvals: null });
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
      (id) => moduleSpecs[id].required || !hiddenModules[id],
    );
  }, [orderedAuthorizedModules, hiddenModules, moduleSpecs]);

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
    if (moduleSpecs[id].required) return;
    setHiddenModules((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  // Governance direct-access cards strictly gated by real server capabilities
  const governanceShortcuts = useMemo<GovernanceShortcut[]>(() => {
    const list: GovernanceShortcut[] = [];
    if (canManagePeople) {
      list.push({
        id: "people",
        href: "/admin/people",
        label: tx({
          "zh-CN": "员工模块权限",
          "zh-HK": "員工模組權限",
          en: "Employee Access",
        }),
        caption: tx({
          "zh-CN": "岗位授权、仓库范围与生效期管理",
          "zh-HK": "職位授權、倉庫範圍與生效期管理",
          en: "Role grants, warehouse scopes, and expiration",
        }),
        icon: Users,
      });
    }
    if (canAccessAdminOps) {
      list.push({
        id: "ops",
        href: "/admin",
        label: tx({
          "zh-CN": "运维监控与异常",
          "zh-HK": "維運監控與異常",
          en: "Ops & Exceptions",
        }),
        caption: tx({
          "zh-CN": "出站队列、熔断开关与异常回执核查",
          "zh-HK": "出站佇列、熔斷開關與異常回執核查",
          en: "Outbox queue, write circuit breaker, and receipt triage",
        }),
        icon: Activity,
      });
    }
    return list;
  }, [canManagePeople, canAccessAdminOps, tx]);

  // Group visible modules into explicit Permission Tiers (only rendering tiers with >=1 authorized capability)
  const visibleTiers = useMemo(() => {
    const orderRank = new Map<WorkbenchModuleId, number>();
    visibleModules.forEach((id, idx) => orderRank.set(id, idx));

    return permissionTiers
      .map((tier) => {
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
      })
      .filter((tier) => tier.modules.length > 0 || tier.shortcuts.length > 0);
  }, [visibleModules, governanceShortcuts, permissionTiers]);

  const activeSpec = moduleSpecs[activeModule];

  // Always prefer human display name (custom profile display_name -> localized persona -> subject)
  const userDisplayName = useMemo(() => {
    const persona = demoConfig?.personas.find(
      (p) => p.subject === actor?.subject,
    );
    const localized = actor?.subject
      ? localizePersona(actor.subject, persona)
      : null;
    const rawProfileName = profile?.display_name?.trim();
    const isDefaultPersonaName =
      Boolean(persona?.display_name) && rawProfileName === persona?.display_name;
    if (
      rawProfileName &&
      rawProfileName !== actor?.subject &&
      !isDefaultPersonaName
    ) {
      return rawProfileName;
    }
    return (
      localized?.displayName ||
      rawProfileName ||
      actor?.subject ||
      tx({ "zh-CN": "成员", "zh-HK": "成員", en: "Member" })
    );
  }, [
    profile?.display_name,
    actor?.subject,
    demoConfig?.personas,
    localizePersona,
    tx,
  ]);

  const userAvatarSrc = profile?.has_avatar
    ? `/v1/profile/avatar?v=${avatarVersion}`
    : null;
  const warehouses = useMemo(
    () => sortWarehouses(actor?.warehouses ?? []),
    [actor?.warehouses],
  );

  const liveAssignedCount =
    kpiCounts.assigned !== null ? kpiCounts.assigned : assignedCount;
  const liveSubmittedCount = kpiCounts.submitted;
  const liveApprovalCount = kpiCounts.approvals;
  const hasActionableAssigned = liveAssignedCount > 0;
  const hasActionableApproval =
    hasApprovalCapability && (liveApprovalCount ?? 0) > 0;

  const handleQueueCountsSync = useCallback(
    (counts: { assigned: number; submitted: number }) => {
      setKpiCounts((prev) => ({
        ...prev,
        assigned: counts.assigned,
        submitted: counts.submitted,
      }));
    },
    [],
  );

  const handleApprovalCountSync = useCallback((count: number) => {
    setKpiCounts((prev) => ({
      ...prev,
      approvals: count,
    }));
  }, []);

  const openQueuesLane = useCallback(
    (view: "assigned" | "submitted" | "unified") => {
      setActiveModule("queues");
      setRequestedQueueView((prev) => ({ view, seq: (prev?.seq ?? 0) + 1 }));
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
                  {tx(
                    {
                      "zh-CN": "{name} · 工作台",
                      "zh-HK": "{name} · 工作台",
                      en: "{name} · Workbench",
                    },
                    { name: userDisplayName },
                  )}
                </h1>
                {actor?.role && (
                  <span className="inline-flex items-center rounded-full bg-[var(--accent-wash)] px-2.5 py-0.5 text-[11.5px] font-medium text-[var(--accent-ink)]">
                    {localizeRole(actor.role)}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12.5px] text-[var(--ink-muted)]">
                <span>
                  {tx({ "zh-CN": "租户", "zh-HK": "租戶", en: "Tenant" })}{" "}
                  <span className="font-mono-code text-[var(--ink-secondary)]">
                    {actor?.tenant ?? "—"}
                  </span>
                </span>
                <span aria-hidden="true" className="text-[var(--ink-faint)]">
                  ·
                </span>
                <span>
                  {tx({ "zh-CN": "账号", "zh-HK": "帳號", en: "Account" })}{" "}
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
                      <span>
                        {tx({
                          "zh-CN": "授权仓库",
                          "zh-HK": "授權倉庫",
                          en: "Authorized Warehouses",
                        })}
                      </span>
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
                <span>
                  {tx({
                    "zh-CN": "模块排序",
                    "zh-HK": "模組排序",
                    en: "Module Layout",
                  })}
                </span>
              </Button>

              {prefsOpen && (
                <div
                  role="dialog"
                  aria-label={tx({
                    "zh-CN": "模块显示顺序与折叠偏好",
                    "zh-HK": "模組顯示順序與摺疊偏好",
                    en: "Module layout and visibility preferences",
                  })}
                  data-testid="work-view-prefs-panel"
                  className="absolute right-0 top-full z-30 mt-2 w-[min(420px,calc(100vw-32px))] rounded-card bg-[var(--bg-surface)] p-4 shadow-[var(--shadow-popover)] space-y-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-[13.5px] font-semibold text-[var(--ink-primary)]">
                        {tx({
                          "zh-CN": "模块显示偏好",
                          "zh-HK": "模組顯示偏好",
                          en: "Module Layout",
                        })}
                      </div>
                      <p className="mt-0.5 text-[11.5px] text-[var(--ink-muted)] leading-relaxed">
                        {tx({
                          "zh-CN":
                            "仅调整当前会话内的排序与折叠，严格受服务端授权边界约束。",
                          "zh-HK":
                            "僅調整目前工作階段內的排序與摺疊，嚴格受伺服器端授權邊界約束。",
                          en: "Session-only ordering and visibility; server authorization boundaries always apply.",
                        })}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setCustomOrder([]);
                        setHiddenModules({});
                      }}
                      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--bg-surface-subtle)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--accent)] hover:bg-[var(--accent-wash)] hover:text-[var(--accent-ink)] transition-colors cursor-pointer"
                    >
                      <RotateCcw className="h-3 w-3" />
                      <span>
                        {tx({ "zh-CN": "重置", "zh-HK": "重設", en: "Reset" })}
                      </span>
                    </button>
                  </div>

                  <div className="space-y-1.5">
                    {orderedAuthorizedModules.map((id, idx) => {
                      const spec = moduleSpecs[id];
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
                                {tx({
                                  "zh-CN": "常驻",
                                  "zh-HK": "常駐",
                                  en: "Pinned",
                                })}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <button
                              type="button"
                              disabled={idx === 0}
                              onClick={() => moveModule(id, -1)}
                              aria-label={tx(
                                {
                                  "zh-CN": "将 {label} 左移",
                                  "zh-HK": "將 {label} 左移",
                                  en: "Move {label} left",
                                },
                                { label: spec.label },
                              )}
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
                              aria-label={tx(
                                {
                                  "zh-CN": "将 {label} 右移",
                                  "zh-HK": "將 {label} 右移",
                                  en: "Move {label} right",
                                },
                                { label: spec.label },
                              )}
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
                                    ? tx(
                                        {
                                          "zh-CN": "显示 {label}",
                                          "zh-HK": "顯示 {label}",
                                          en: "Show {label}",
                                        },
                                        { label: spec.label },
                                      )
                                    : tx(
                                        {
                                          "zh-CN": "隐藏 {label}",
                                          "zh-HK": "隱藏 {label}",
                                          en: "Hide {label}",
                                        },
                                        { label: spec.label },
                                      )
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
            onClick={() => openQueuesLane("assigned")}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                openQueuesLane("assigned");
              }
            }}
            className="group cursor-pointer rounded-tile bg-[var(--bg-surface-tint)] p-4 shadow-[var(--shadow-subtle)] hover:bg-[var(--bg-surface)] hover:shadow-[var(--shadow-card)] transition-all duration-[200ms]"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12.5px] font-medium text-[var(--ink-muted)]">
                {tx({
                  "zh-CN": "待我处理",
                  "zh-HK": "待我處理",
                  en: "Assigned to Me",
                })}
              </span>
              <span
                className={[
                  "flex h-7 w-7 items-center justify-center rounded-full",
                  hasActionableAssigned
                    ? "bg-[var(--accent-wash)] text-[var(--accent-ink)]"
                    : "bg-[var(--bg-surface)] text-[var(--ink-secondary)] shadow-[var(--shadow-subtle)]",
                ].join(" ")}
              >
                <Inbox className="h-3.5 w-3.5" strokeWidth={1.9} />
              </span>
            </div>
            <div className="mt-2 tabular-nums text-[24px] font-semibold tracking-[-0.02em] text-[var(--ink-primary)]">
              {kpiCounts.assigned !== null ? kpiCounts.assigned : "—"}
            </div>
            <div className="mt-1 text-[11.5px] text-[var(--ink-muted)]">
              {tx({
                "zh-CN": "当前待办与分派任务",
                "zh-HK": "目前待辦與分派任務",
                en: "Active inbox & assigned tasks",
              })}
            </div>
          </Interactive3DCard>

          <Interactive3DCard
            maxTilt={2}
            hoverLiftPx={-1}
            sheenIntensity="subtle"
            onClick={() => openQueuesLane("submitted")}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                openQueuesLane("submitted");
              }
            }}
            className="group cursor-pointer rounded-tile bg-[var(--bg-surface-tint)] p-4 shadow-[var(--shadow-subtle)] hover:bg-[var(--bg-surface)] hover:shadow-[var(--shadow-card)] transition-all duration-[200ms]"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12.5px] font-medium text-[var(--ink-muted)]">
                {tx({ "zh-CN": "已提交", "zh-HK": "已提交", en: "Submitted" })}
              </span>
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--bg-surface)] text-[var(--ink-secondary)] shadow-[var(--shadow-subtle)]">
                <Send className="h-3.5 w-3.5" strokeWidth={1.9} />
              </span>
            </div>
            <div className="mt-2 tabular-nums text-[24px] font-semibold tracking-[-0.02em] text-[var(--ink-primary)]">
              {liveSubmittedCount !== null ? liveSubmittedCount : "—"}
            </div>
            <div className="mt-1 text-[11.5px] text-[var(--ink-muted)]">
              {tx({
                "zh-CN": "本人发起的提案与回执",
                "zh-HK": "本人發起的提案與回執",
                en: "Proposals & receipts you initiated",
              })}
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
                {tx({
                  "zh-CN": "待我审批",
                  "zh-HK": "待我審批",
                  en: "Pending Approval",
                })}
              </span>
              <span
                className={[
                  "flex h-7 w-7 items-center justify-center rounded-full",
                  hasActionableApproval
                    ? "bg-[var(--accent-wash)] text-[var(--accent-ink)]"
                    : "bg-[var(--bg-surface)] text-[var(--ink-secondary)] shadow-[var(--shadow-subtle)]",
                ].join(" ")}
              >
                <ShieldCheck className="h-3.5 w-3.5" strokeWidth={1.9} />
              </span>
            </div>
            <div
              className={[
                "mt-2 tabular-nums text-[24px] font-semibold tracking-[-0.02em]",
                hasActionableApproval
                  ? "text-[var(--accent)]"
                  : "text-[var(--ink-primary)]",
              ].join(" ")}
            >
              {hasApprovalCapability
                ? liveApprovalCount !== null
                  ? liveApprovalCount
                  : "—"
                : "—"}
            </div>
            <div className="mt-1 text-[11.5px] text-[var(--ink-muted)]">
              {hasApprovalCapability
                ? tx({
                    "zh-CN": "授权仓库待独立确认",
                    "zh-HK": "授權倉庫待獨立確認",
                    en: "Awaiting independent confirmation",
                  })
                : tx({
                    "zh-CN": "当前岗位未开通审批权限",
                    "zh-HK": "目前職位未開通審批權限",
                    en: "Approval authority not enabled",
                  })}
            </div>
          </Interactive3DCard>

          <Interactive3DCard
            interactive={false}
            sheenIntensity="subtle"
            className="rounded-tile bg-[var(--bg-surface-tint)] p-4 shadow-[var(--shadow-subtle)]"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12.5px] font-medium text-[var(--ink-muted)]">
                {tx({
                  "zh-CN": "授权仓库",
                  "zh-HK": "授權倉庫",
                  en: "Authorized Warehouses",
                })}
              </span>
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--bg-surface)] text-[var(--ink-secondary)] shadow-[var(--shadow-subtle)]">
                <Building2 className="h-3.5 w-3.5" strokeWidth={1.9} />
              </span>
            </div>
            <div className="mt-2 tabular-nums text-[24px] font-semibold tracking-[-0.02em] text-[var(--ink-primary)]">
              {warehouses.length}
            </div>
            <div
              className={[
                "mt-1 truncate text-[11.5px] text-[var(--ink-muted)]",
                warehouses.length > 0 ? "font-mono-code" : "",
              ].join(" ")}
            >
              {warehouses.length > 0
                ? warehouses.join(" · ")
                : tx({
                    "zh-CN": "未分配仓库",
                    "zh-HK": "未分配倉庫",
                    en: "No warehouses assigned",
                  })}
            </div>
          </Interactive3DCard>
        </div>
      </section>

      {/* 2. Explicit Permission-Tiered Navigation Hub (Only Authorized Tiers Rendered) */}
      <section
        aria-label={tx({
          "zh-CN": "权限层级功能导航",
          "zh-HK": "權限層級功能導覽",
          en: "Permission-tiered workbench navigation",
        })}
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
                    const spec = moduleSpecs[id];
                    const Icon = MODULE_ICONS[id];
                    const active = activeModule === id;
                    const showBadge =
                      id === "approvals" && (liveApprovalCount ?? 0) > 0;
                    const badgeCount = liveApprovalCount ?? 0;
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
                            ? "bg-[var(--bg-surface)] text-[var(--accent-ink)] font-semibold shadow-[var(--shadow-subtle)] ring-1 ring-[var(--accent-border)]"
                            : "text-[var(--ink-secondary)] font-medium hover:bg-[var(--bg-surface)]/70 hover:text-[var(--ink-primary)]",
                        ].join(" ")}
                      >
                        <Icon
                          className={[
                            "h-3.5 w-3.5 shrink-0",
                            active
                              ? "text-[var(--accent-ink)]"
                              : "text-[var(--ink-muted)]",
                          ].join(" ")}
                          strokeWidth={1.85}
                        />
                        <span>{spec.label}</span>
                        {showBadge && (
                          <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[var(--accent-solid)] px-1.5 tabular-nums text-[10.5px] font-semibold text-[var(--accent-fg)]">
                            {badgeCount > 99 ? "99+" : badgeCount}
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
                        <ArrowUpRight className="h-3.5 w-3.5 text-[var(--ink-muted)] group-hover:text-[var(--accent)] transition-colors" />
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
          <UnifiedQueuesPanel
            requestedView={requestedQueueView}
            onCountsLoaded={handleQueueCountsSync}
          />
        )}
        {activeModule === "orders" && <OrdersModule />}
        {activeModule === "approvals" && (
          <ApprovalsModule onCountLoaded={handleApprovalCountSync} />
        )}
        {activeModule === "dispatch" && <DispatchModule />}
        {activeModule === "finance" && <FinanceModule />}
        {activeModule === "assurance" && <AssurancePanel />}
        {activeModule === "decision" && <DecisionModule />}
      </div>
    </div>
  );
}
