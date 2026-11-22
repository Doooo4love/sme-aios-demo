"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Activity,
  ArrowRight,
  RefreshCw,
  Search,
  Users,
  X,
} from "lucide-react";
import { isApiError, isStaleAuthError, type ApiError } from "@/lib/api-client";
import { sortWarehouses } from "@/lib/format";
import { useLocale } from "@/lib/i18n";
import { useSession } from "@/lib/session-context";
import { AccessNoticeCard, Avatar, Button } from "@/components/ui";
import {
  fetchModuleAccessCatalog,
  fetchModuleAccessEmployees,
} from "@/features/people/api";
import type { ModuleAccessCatalog } from "@/lib/types";

const PAGE_LIMIT = 50;

export function PeopleDirectoryView() {
  const {
    actor,
    canManagePeople,
    canAccessAdminOps,
    authGeneration,
    handleAccessChanged,
  } = useSession();
  const { t, tx, tp, localizePersona } = useLocale();

  const [catalog, setCatalog] = useState<ModuleAccessCatalog | null>(null);
  const [employees, setEmployees] = useState<string[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const loadDirectory = useCallback(
    async (signal?: AbortSignal) => {
      if (!canManagePeople) return;
      setLoading(true);
      setError(null);
      try {
        const [catalogRes, pageRes] = await Promise.all([
          fetchModuleAccessCatalog(signal),
          fetchModuleAccessEmployees({ limit: PAGE_LIMIT }, signal),
        ]);
        setCatalog(catalogRes);
        setEmployees(pageRes.items);
        setNextCursor(pageRes.next);
      } catch (err) {
        if (isStaleAuthError(err)) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (isApiError(err)) {
          if (err.code === "ACCESS_CHANGED") {
            setCatalog(null);
            setEmployees([]);
            setNextCursor(null);
            void handleAccessChanged();
          }
          setError(err);
        }
      } finally {
        setLoading(false);
      }
    },
    [canManagePeople, handleAccessChanged],
  );

  // Clear stale data on authGeneration switch and reload only if strictly authorized
  useEffect(() => {
    setCatalog(null);
    setEmployees([]);
    setNextCursor(null);
    setError(null);
    setSearchQuery("");

    if (!canManagePeople) return;

    const controller = new AbortController();
    void loadDirectory(controller.signal);
    return () => {
      controller.abort();
    };
  }, [authGeneration, canManagePeople, loadDirectory]);

  const handleLoadMore = useCallback(async () => {
    if (!canManagePeople || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const pageRes = await fetchModuleAccessEmployees({
        after: nextCursor,
        limit: PAGE_LIMIT,
      });
      setEmployees((prev) => {
        const seen = new Set(prev);
        const merged = [...prev];
        for (const item of pageRes.items) {
          if (!seen.has(item)) {
            seen.add(item);
            merged.push(item);
          }
        }
        return merged;
      });
      setNextCursor(pageRes.next);
    } catch (err) {
      if (isStaleAuthError(err)) return;
      if (isApiError(err)) {
        if (err.code === "ACCESS_CHANGED") {
          setCatalog(null);
          setEmployees([]);
          setNextCursor(null);
          void handleAccessChanged();
        }
        setError(err);
      }
    } finally {
      setLoadingMore(false);
    }
  }, [canManagePeople, nextCursor, loadingMore, handleAccessChanged]);

  const filteredEmployees = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return employees;
    return employees.filter((subject) => {
      if (subject.toLowerCase().includes(q)) return true;
      const persona = localizePersona(subject);
      return persona.displayName.toLowerCase().includes(q);
    });
  }, [employees, searchQuery, localizePersona]);

  // Strict capability gate: never fetch admin lists when actor lacks workbench.access.manage
  if (!canManagePeople) {
    return (
      <div
        className="mx-auto max-w-[820px] px-4 py-8 sm:px-6"
        data-testid="people-access-denied"
      >
        <AccessNoticeCard
          variant="ACCESS_RESTRICTED"
          title={tx({
            "zh-CN": "需要全仓库模块权限管理员权限",
            "zh-HK": "需要全倉庫模組權限管理員權限",
            en: "All-Warehouse Access Admin Permission Required",
          })}
          message={tx({
            "zh-CN":
              "此区域仅限具备 workbench.access.manage 权限且拥有租户全仓库范围的管理员（如 access-admin）访问。普通运维管理员及业务岗位账号不可管理员工模块授权。",
            "zh-HK":
              "此區域僅限具備 workbench.access.manage 權限且擁有租戶全倉庫範圍的管理員（如 access-admin）存取。一般維運管理員及業務職位帳號不可管理員工模組授權。",
            en: "This area is restricted to administrators with workbench.access.manage and all-warehouse tenant scope (e.g. access-admin). Operations admins and business accounts cannot manage employee module access.",
          })}
          backHref={canAccessAdminOps ? "/admin" : "/inbox"}
          backLabel={
            canAccessAdminOps
              ? tx({
                  "zh-CN": "前往运维监控",
                  "zh-HK": "前往維運監控",
                  en: "Go to Operations",
                })
              : t("common.backToWorkbench")
          }
        />
      </div>
    );
  }

  const sortedWarehouses = catalog?.warehouses.length
    ? sortWarehouses(catalog.warehouses)
    : actor?.warehouses.length
      ? sortWarehouses(actor.warehouses)
      : [];
  const manageableWarehouses =
    sortedWarehouses.length > 0 ? sortedWarehouses.join(" / ") : "—";
  const moduleCount = catalog ? Object.keys(catalog.modules).length : 5;

  return (
    <div
      className="mx-auto max-w-[1120px] space-y-5 px-4 py-6 sm:px-6 lg:py-7 pb-16"
      data-testid="people-directory-page"
    >
      {/* Unified Porcelain / Obsidian Page-Header Card (matches /work & /admin) */}
      <section className="rounded-card border border-[var(--hairline)] bg-[var(--bg-surface)] shadow-[var(--shadow-card)] p-5 sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h1 className="aios-display text-[20px] font-semibold text-[var(--ink-primary)] leading-tight">
              {tx({
                "zh-CN": "员工权限与模块授权",
                "zh-HK": "員工權限與模組授權",
                en: "Employee Module Access",
              })}
            </h1>
            <p className="mt-1 text-[13px] text-[var(--ink-secondary)]">
              {tx({
                "zh-CN":
                  "按仓库范围管理员工对订单进件、运单调度、发票审阅、仓库经营汇总及主管审批模块的独立授权。",
                "zh-HK":
                  "按倉庫範圍管理員工對訂單進件、運單調度、發票審閱、倉庫營運摘要及主管審批模組的獨立授權。",
                en: "Manage per-employee module access across Orders, Dispatch, Invoice Review, Warehouse Insights, and Approvals by warehouse scope.",
              })}
            </p>
            <p className="mt-1.5 text-[12px] text-[var(--ink-muted)] tabular-nums">
              <span className="font-mono-code">{actor?.tenant ?? "—"}</span>
              <span className="mx-1.5 text-[var(--ink-faint)]">·</span>
              <span className="font-mono-code">{manageableWarehouses}</span>
              <span className="mx-1.5 text-[var(--ink-faint)]">·</span>
              <span>
                {tp(
                  {
                    "zh-CN": "{count} 个可配置模块",
                    "zh-HK": "{count} 個可設定模組",
                    en: {
                      one: "{count} configurable module",
                      other: "{count} configurable modules",
                    },
                  },
                  moduleCount,
                )}
              </span>
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {canAccessAdminOps && (
              <Link
                href="/admin"
                className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium text-[var(--accent-ink)] hover:bg-[var(--accent-wash)] transition-colors duration-[150ms]"
              >
                <Activity className="h-3.5 w-3.5" strokeWidth={1.85} />
                <span>{t("shell.nav.admin")}</span>
              </Link>
            )}
            <Button
              size="sm"
              pill
              variant="secondary"
              loading={loading}
              data-testid="people-refresh-btn"
              onClick={() => void loadDirectory()}
            >
              <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.85} />
              <span>
                {tx({
                  "zh-CN": "刷新目录",
                  "zh-HK": "重新整理目錄",
                  en: "Refresh Directory",
                })}
              </span>
            </Button>
          </div>
        </div>
      </section>

      {error && (
        <AccessNoticeCard
          error={error}
          onRetry={() => void loadDirectory()}
          backHref="/inbox"
        />
      )}

      {/* Directory Sheet (macOS Messages Contacts Aesthetic) */}
      {!error && (
        <section className="rounded-card border border-[var(--hairline)] bg-[var(--bg-surface)] shadow-[var(--shadow-card)] overflow-hidden">
          {/* Client-Side Search & Filter Bar */}
          <div className="flex flex-col gap-3 border-b border-[var(--hairline-subtle)] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
              <label
                htmlFor="people-search-input"
                className="text-[12.5px] font-medium text-[var(--ink-secondary)] whitespace-nowrap"
              >
                {tx({
                  "zh-CN": "在已加载员工中筛选",
                  "zh-HK": "於已載入員工中篩選",
                  en: "Filter loaded employees",
                })}
              </label>
              <div className="relative flex-1 max-w-[380px]">
                <Search
                  className="pointer-events-none absolute left-3.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--ink-muted)]"
                  strokeWidth={1.85}
                />
                <input
                  id="people-search-input"
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={tx({
                    "zh-CN": "输入员工姓名或账号（仅筛选已加载项）…",
                    "zh-HK": "輸入員工姓名或帳號（僅篩選已載入項目）…",
                    en: "Filter by name or account (loaded items only)…",
                  })}
                  data-testid="people-search-input"
                  className="h-9 w-full rounded-sm border border-[var(--hairline-strong)] bg-[var(--bg-surface-tint)] pl-9 pr-9 text-[13px] text-[var(--ink-primary)] placeholder:text-[var(--ink-faint)] focus:border-[var(--accent-border)] focus:bg-[var(--bg-surface)] focus:ring-2 focus:ring-[var(--accent-ring)] focus:outline-none transition-all"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery("")}
                    aria-label={tx({
                      "zh-CN": "清空筛选条件",
                      "zh-HK": "清除篩選條件",
                      en: "Clear filter",
                    })}
                    className="absolute right-2 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full text-[var(--ink-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--ink-primary)] cursor-pointer"
                  >
                    <X className="h-3 w-3" strokeWidth={2} />
                  </button>
                )}
              </div>
            </div>

            <div className="inline-flex items-center gap-1.5 font-mono-code text-[12px] text-[var(--ink-muted)] tabular-nums self-start sm:self-auto">
              <Users className="h-3.5 w-3.5" strokeWidth={1.85} />
              <span>
                {tx(
                  {
                    "zh-CN": "显示 {filtered} / 已加载 {loaded}{more}",
                    "zh-HK": "顯示 {filtered} / 已載入 {loaded}{more}",
                    en: "Showing {filtered} / {loaded}{more} loaded",
                  },
                  {
                    filtered: filteredEmployees.length,
                    loaded: employees.length,
                    more: nextCursor ? "+" : "",
                  },
                )}
              </span>
            </div>
          </div>

          {/* Employee Contacts List */}
          {loading && employees.length === 0 ? (
            <div className="px-6 py-14 text-center text-[13px] text-[var(--ink-muted)]">
              {tx({
                "zh-CN": "正在加载租户员工目录…",
                "zh-HK": "正在載入租戶員工目錄…",
                en: "Loading tenant employee directory…",
              })}
            </div>
          ) : filteredEmployees.length === 0 ? (
            <div className="px-6 py-14 text-center text-[13.5px] text-[var(--ink-muted)]">
              {employees.length === 0
                ? tx({
                    "zh-CN": "当前租户暂无已登录登记的员工记录。",
                    "zh-HK": "目前租戶暫無已登入登記的員工紀錄。",
                    en: "No registered employees in this tenant yet.",
                  })
                : nextCursor
                  ? tp(
                      {
                        "zh-CN":
                          "在已加载的 {count} 位员工中未匹配到「{query}」，可点击下方「加载更多员工」继续检索后续页。",
                        "zh-HK":
                          "於已載入的 {count} 位員工中未符合「{query}」，可點擊下方「載入更多員工」繼續檢索後續頁。",
                        en: {
                          one: "No match for “{query}” in {count} loaded employee. Click “Load More” below to fetch additional pages.",
                          other:
                            "No match for “{query}” among {count} loaded employees. Click “Load More” below to fetch additional pages.",
                        },
                      },
                      employees.length,
                      { query: searchQuery.trim() },
                    )
                  : tp(
                      {
                        "zh-CN":
                          "在已加载的 {count} 位员工中未匹配到「{query}」。",
                        "zh-HK":
                          "於已載入的 {count} 位員工中未符合「{query}」。",
                        en: {
                          one: "No match for “{query}” in {count} loaded employee.",
                          other:
                            "No match for “{query}” among {count} loaded employees.",
                        },
                      },
                      employees.length,
                      { query: searchQuery.trim() },
                    )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="aios-micro-label border-b border-[var(--hairline)] bg-[var(--bg-surface-tint)]">
                    <th className="px-5 py-3">
                      {tx({
                        "zh-CN": "员工账号",
                        "zh-HK": "員工帳號",
                        en: "Employee Account",
                      })}
                    </th>
                    <th className="px-4 py-3">
                      {tx({
                        "zh-CN": "可配置说明",
                        "zh-HK": "可設定說明",
                        en: "Access Scope",
                      })}
                    </th>
                    <th className="px-5 py-3 text-right">
                      {tx({
                        "zh-CN": "操作",
                        "zh-HK": "操作",
                        en: "Action",
                      })}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--hairline-subtle)]">
                  {filteredEmployees.map((subject) => {
                    const isSelf = actor?.subject === subject;
                    const detailHref = `/admin/people/${encodeURIComponent(subject)}`;
                    const persona = localizePersona(subject);
                    const hasDistinctName =
                      persona.displayName.trim() !== "" &&
                      persona.displayName !== subject;
                    return (
                      <tr
                        key={subject}
                        data-testid={`employee-row-${subject}`}
                        className="group transition-colors duration-[140ms] hover:bg-[var(--bg-surface-tint)]/85"
                      >
                        <td className="px-5 py-3.5">
                          <div className="flex items-center gap-3">
                            <Avatar
                              fallbackText={persona.displayName}
                              name={persona.displayName}
                              size="md"
                              kind="user"
                            />
                            <div className="min-w-0 flex flex-wrap items-center gap-2">
                              <Link
                                href={detailHref}
                                className="text-[13.5px] font-semibold text-[var(--ink-primary)] group-hover:text-[var(--accent)] transition-colors"
                              >
                                {persona.displayName}
                              </Link>
                              {hasDistinctName && (
                                <span className="inline-flex items-center rounded-xs border border-[var(--hairline)] bg-[var(--bg-surface-tint)] px-2 py-0.5 font-mono-code text-[11px] font-medium text-[var(--ink-muted)]">
                                  {subject}
                                </span>
                              )}
                              {isSelf && (
                                <span
                                  data-testid="employee-self-badge"
                                  className="inline-flex items-center rounded-full bg-[var(--status-amber-wash)] px-2.5 py-0.5 text-[11px] font-medium text-[var(--status-amber-ink)]"
                                >
                                  {tx({
                                    "zh-CN": "当前本人账号 · 只读",
                                    "zh-HK": "目前本人帳號 · 唯讀",
                                    en: "Your Account · Read-Only",
                                  })}
                                </span>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3.5 text-[13px] text-[var(--ink-muted)]">
                          {isSelf
                            ? tx({
                                "zh-CN":
                                  "管理员不能修改自己的模块授权，仅支持只读核对",
                                "zh-HK":
                                  "管理員不能修改自己的模組授權，僅支援唯讀核對",
                                en: "Administrators cannot modify their own module grants (read-only)",
                              })
                            : tx({
                                "zh-CN":
                                  "可配置 5 项模块动作、仓库范围及到期时间",
                                "zh-HK":
                                  "可設定 5 項模組操作、倉庫範圍及到期時間",
                                en: "Configure actions, warehouse scopes, and expiry across 5 modules",
                              })}
                        </td>
                        <td className="px-5 py-3.5 text-right">
                          <Link
                            href={detailHref}
                            data-testid={`employee-open-${subject}`}
                            className={[
                              "inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium transition-colors duration-[150ms]",
                              isSelf
                                ? "text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)]"
                                : "text-[var(--accent-ink)] hover:bg-[var(--accent-wash)]",
                            ].join(" ")}
                          >
                            <span>
                              {isSelf
                                ? tx({
                                    "zh-CN": "只读查看",
                                    "zh-HK": "唯讀檢視",
                                    en: "View",
                                  })
                                : tx({
                                    "zh-CN": "管理授权",
                                    "zh-HK": "管理授權",
                                    en: "Manage",
                                  })}
                            </span>
                            <ArrowRight
                              className="h-3.5 w-3.5"
                              strokeWidth={1.85}
                            />
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Cursor Pagination Footer with Honest Discovery Note */}
          <div className="flex flex-col gap-2.5 border-t border-[var(--hairline-subtle)] bg-[var(--bg-surface-tint)] px-5 py-3.5 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-[12px] text-[var(--ink-muted)] tabular-nums">
              {nextCursor
                ? tp(
                    {
                      "zh-CN":
                        "已加载 {count} 位员工，仍有更多记录 · 首次登录后自动登记",
                      "zh-HK":
                        "已載入 {count} 位員工，仍有更多紀錄 · 首次登入後自動登記",
                      en: {
                        one: "Loaded {count} employee, more available · Auto-registered on first sign-in",
                        other:
                          "Loaded {count} employees, more available · Auto-registered on first sign-in",
                      },
                    },
                    employees.length,
                  )
                : tp(
                    {
                      "zh-CN":
                        "共 {count} 位已登记员工 · 首次登录工作台后自动登记",
                      "zh-HK":
                        "共 {count} 位已登記員工 · 首次登入工作台後自動登記",
                      en: {
                        one: "{count} registered employee · Auto-registered on first sign-in",
                        other:
                          "{count} registered employees · Auto-registered on first sign-in",
                      },
                    },
                    employees.length,
                  )}
            </span>
            {nextCursor && (
              <Button
                size="sm"
                pill
                variant="quiet"
                loading={loadingMore}
                data-testid="people-load-more"
                onClick={() => void handleLoadMore()}
              >
                {tx({
                  "zh-CN": "加载更多员工",
                  "zh-HK": "載入更多員工",
                  en: "Load More",
                })}
              </Button>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
