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
    return employees.filter((subject) => subject.toLowerCase().includes(q));
  }, [employees, searchQuery]);

  // Strict capability gate: never fetch admin lists when actor lacks workbench.access.manage
  if (!canManagePeople) {
    return (
      <div
        className="mx-auto max-w-[820px] px-4 py-8 sm:px-6"
        data-testid="people-access-denied"
      >
        <AccessNoticeCard
          variant="ACCESS_RESTRICTED"
          title="需要全站点模块权限管理员权限"
          message="此区域仅限具备 workbench.access.manage 权限且拥有租户全仓库范围的管理员（如 access-admin）访问。普通运维管理员及业务岗位账号不可管理员工模块授权。"
          backHref={canAccessAdminOps ? "/admin" : "/inbox"}
          backLabel={canAccessAdminOps ? "前往运维监控" : "返回工作台"}
        />
      </div>
    );
  }

  const manageableWarehouses = catalog?.warehouses.length
    ? catalog.warehouses.join(" / ")
    : actor?.warehouses.join(" / ") || "—";
  const moduleCount = catalog ? Object.keys(catalog.modules).length : 5;

  return (
    <div
      className="mx-auto max-w-[1120px] space-y-5 px-4 py-6 sm:px-6 lg:py-7 pb-16"
      data-testid="people-directory-page"
    >
      {/* Unified Porcelain Page-Header Card (matches /work & /admin) */}
      <section className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] p-5 sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-[20px] font-semibold tracking-[-0.02em] text-[var(--ink-primary)] leading-tight">
              员工权限与模块授权
            </h1>
            <p className="mt-1 text-[13px] text-[var(--ink-secondary)]">
              按仓库范围管理员工对订单、调度、发票审阅、仓库概览及审批模块的独立授权。
            </p>
            <p className="mt-1.5 text-[12px] text-[var(--ink-muted)] tabular-nums">
              <span className="font-mono-code">{actor?.tenant ?? "—"}</span>
              <span className="mx-1.5 text-[var(--ink-faint)]">·</span>
              <span className="font-mono-code">{manageableWarehouses}</span>
              <span className="mx-1.5 text-[var(--ink-faint)]">·</span>
              <span>{moduleCount} 个可配置模块</span>
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {canAccessAdminOps && (
              <Link
                href="/admin"
                className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium text-[var(--accent)] hover:bg-[var(--accent-wash)] transition-colors duration-[150ms]"
              >
                <Activity className="h-3.5 w-3.5" strokeWidth={1.85} />
                <span>运维监控</span>
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
              <span>刷新目录</span>
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

      {/* Directory Porcelain Sheet (macOS Messages Contacts Aesthetic) */}
      {!error && (
        <section className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] overflow-hidden">
          {/* Client-Side Search & Filter Bar */}
          <div className="flex flex-col gap-3 border-b border-[var(--hairline-subtle)] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
              <label
                htmlFor="people-search-input"
                className="text-[12.5px] font-medium text-[var(--ink-secondary)] whitespace-nowrap"
              >
                在已加载员工中筛选
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
                  placeholder="输入员工标识关键字（仅筛选已加载项）…"
                  data-testid="people-search-input"
                  className="h-9 w-full rounded-full bg-[var(--bg-surface-subtle)] pl-9 pr-9 font-mono-code text-[13px] text-[var(--ink-primary)] placeholder:font-sans placeholder:text-[var(--ink-faint)] focus:bg-[var(--bg-surface)] focus:ring-2 focus:ring-[var(--accent-ring)] focus:outline-none transition-all"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery("")}
                    aria-label="清空筛选条件"
                    className="absolute right-2 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full text-[var(--ink-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--ink-primary)] cursor-pointer"
                  >
                    <X className="h-3 w-3" strokeWidth={2} />
                  </button>
                )}
              </div>
            </div>

            <div className="inline-flex items-center gap-1.5 text-[12px] text-[var(--ink-muted)] tabular-nums self-start sm:self-auto">
              <Users className="h-3.5 w-3.5" strokeWidth={1.85} />
              <span>
                显示 {filteredEmployees.length} / 已加载 {employees.length}
                {nextCursor ? "+" : ""}
              </span>
            </div>
          </div>

          {/* Employee Contacts List */}
          {loading && employees.length === 0 ? (
            <div className="px-6 py-14 text-center text-[13px] text-[var(--ink-muted)]">
              正在加载租户员工目录…
            </div>
          ) : filteredEmployees.length === 0 ? (
            <div className="px-6 py-14 text-center text-[13.5px] text-[var(--ink-muted)]">
              {employees.length === 0
                ? "当前租户暂无已登录登记的员工记录。"
                : `在已加载的 ${employees.length} 位员工中未匹配到「${searchQuery.trim()}」${nextCursor ? "，可点击下方「加载更多员工」继续检索后续页。" : "。"}`}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-[var(--hairline-subtle)] bg-[var(--bg-surface-tint)] text-[12px] font-medium text-[var(--ink-muted)]">
                    <th className="px-5 py-3">员工账号</th>
                    <th className="px-4 py-3">可配置说明</th>
                    <th className="px-5 py-3 text-right">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--hairline-subtle)]">
                  {filteredEmployees.map((subject) => {
                    const isSelf = actor?.subject === subject;
                    const detailHref = `/admin/people/${encodeURIComponent(subject)}`;
                    return (
                      <tr
                        key={subject}
                        data-testid={`employee-row-${subject}`}
                        className="group transition-colors duration-[140ms] hover:bg-[var(--bg-surface-tint)]/85"
                      >
                        <td className="px-5 py-3.5">
                          <div className="flex items-center gap-3">
                            <Avatar
                              fallbackText={subject}
                              name={subject}
                              size="md"
                              kind="user"
                            />
                            <div className="min-w-0 flex flex-wrap items-center gap-2">
                              <Link
                                href={detailHref}
                                className="font-mono-code text-[13.5px] font-semibold text-[var(--ink-primary)] group-hover:text-[var(--accent)] transition-colors"
                              >
                                {subject}
                              </Link>
                              {isSelf && (
                                <span
                                  data-testid="employee-self-badge"
                                  className="inline-flex items-center rounded-full bg-[var(--status-amber-wash)] px-2.5 py-0.5 text-[11px] font-medium text-[var(--status-amber-ink)]"
                                >
                                  当前本人账号 · 只读
                                </span>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3.5 text-[13px] text-[var(--ink-muted)]">
                          {isSelf
                            ? "管理员不能修改自己的模块授权，仅支持只读核对"
                            : "可配置 5 项模块动作、仓库范围及到期时间"}
                        </td>
                        <td className="px-5 py-3.5 text-right">
                          <Link
                            href={detailHref}
                            data-testid={`employee-open-${subject}`}
                            className={[
                              "inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium transition-colors duration-[150ms]",
                              isSelf
                                ? "text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)]"
                                : "text-[var(--accent)] hover:bg-[var(--accent-wash)]",
                            ].join(" ")}
                          >
                            <span>{isSelf ? "只读查看" : "管理授权"}</span>
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
                ? `已加载 ${employees.length} 位员工，仍有更多记录 · 首次登录后自动登记`
                : `共 ${employees.length} 位已登记员工 · 首次登录工作台后自动登记`}
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
                加载更多员工
              </Button>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
