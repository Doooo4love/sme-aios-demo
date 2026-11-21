"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Activity,
  ArrowRight,
  Info,
  RefreshCw,
  Search,
  ShieldCheck,
  Users,
  X,
} from "lucide-react";
import { isApiError, isStaleAuthError, type ApiError } from "@/lib/api-client";
import { useSession } from "@/lib/session-context";
import { AccessNoticeCard, Button } from "@/components/ui";
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
        className="mx-auto max-w-[820px] p-4 sm:p-6"
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

  return (
    <div
      className="mx-auto max-w-[1120px] space-y-4 p-4 sm:p-6"
      data-testid="people-directory-page"
    >
      {/* Header Sheet */}
      <section className="rounded-[6px] border border-[var(--hairline)] bg-[var(--bg-sheet)] p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="font-mono-code text-[11px] uppercase tracking-[0.04em] text-[var(--ink-muted)]">
              MODULE ACCESS GOVERNANCE · 员工模块授权目录
            </p>
            <h2 className="mt-1 text-[20px] font-semibold tracking-[-0.02em] text-[var(--ink-primary)]">
              员工权限与模块授权
            </h2>
            <p className="mt-1 text-[13px] text-[var(--ink-muted)]">
              按租户与仓库范围管理员工对订单、调度、发票审阅、仓库概览及审批模块的显式授权或撤销规则。
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {canAccessAdminOps && (
              <Link
                href="/admin"
                className="inline-flex h-8 items-center gap-1.5 rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-subtle)] px-3 text-[12px] font-medium text-[var(--ink-primary)] hover:bg-[var(--bg-plane)] transition-colors duration-[120ms]"
              >
                <Activity className="h-3.5 w-3.5 text-[var(--ink-muted)]" strokeWidth={1.75} />
                <span>运维控制中心</span>
              </Link>
            )}
            <Button
              size="sm"
              variant="secondary"
              loading={loading}
              data-testid="people-refresh-btn"
              onClick={() => void loadDirectory()}
            >
              <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} />
              <span>刷新目录</span>
            </Button>
          </div>
        </div>

        {/* Scope Metadata Strip */}
        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-[var(--hairline)] pt-3 text-[12px]">
          <div className="flex items-center gap-1.5 text-[var(--ink-secondary)]">
            <ShieldCheck className="h-3.5 w-3.5 text-[var(--accent)]" strokeWidth={1.75} />
            <span>管理租户：</span>
            <span className="font-mono-code font-medium text-[var(--ink-primary)]">
              {actor?.tenant ?? "—"}
            </span>
          </div>
          <div className="flex items-center gap-1.5 text-[var(--ink-secondary)]">
            <span>可管理仓库范围：</span>
            <span className="font-mono-code font-medium text-[var(--ink-primary)]">
              {catalog?.warehouses.length
                ? catalog.warehouses.join(", ")
                : actor?.warehouses.join(", ") || "—"}
            </span>
          </div>
          <div className="flex items-center gap-1.5 text-[var(--ink-secondary)]">
            <span>可配置模块数：</span>
            <span className="font-mono-code font-medium text-[var(--ink-primary)] tabular-nums">
              {catalog ? Object.keys(catalog.modules).length : 5}
            </span>
          </div>
        </div>

        {/* Honest Directory Discovery Note */}
        <div className="mt-3 flex items-start gap-2 rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] px-3 py-2 text-[12px] text-[var(--ink-secondary)] leading-relaxed">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--ink-muted)]" strokeWidth={1.75} />
          <span>
            员工会在首次登录工作台后自动登记进入本租户目录；当前目录接口按稳定{" "}
            <code className="font-mono-code text-[11.5px]">subject</code>{" "}
            游标分页返回员工主体标识，不含额外姓名检索索引。
          </span>
        </div>
      </section>

      {error && (
        <AccessNoticeCard
          error={error}
          onRetry={() => void loadDirectory()}
          backHref="/inbox"
        />
      )}

      {/* Directory Sheet */}
      {!error && (
        <section className="rounded-[6px] border border-[var(--hairline)] bg-[var(--bg-sheet)] overflow-hidden">
          {/* Client-Side Search & Filter Bar */}
          <div className="flex flex-col gap-2.5 border-b border-[var(--hairline)] bg-[var(--bg-subtle)] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-1 flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
              <label
                htmlFor="people-search-input"
                className="text-[12px] font-medium text-[var(--ink-secondary)] whitespace-nowrap"
              >
                在已加载员工中筛选
              </label>
              <div className="relative flex-1 max-w-[360px]">
                <Search
                  className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--ink-muted)]"
                  strokeWidth={1.75}
                />
                <input
                  id="people-search-input"
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="输入 subject 关键字（仅筛选已加载项）…"
                  data-testid="people-search-input"
                  className="h-8 w-full rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] pl-8 pr-8 font-mono-code text-[12.5px] text-[var(--ink-primary)] placeholder:font-sans placeholder:text-[var(--ink-faint)] focus:border-[var(--accent)] focus:outline-none"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery("")}
                    aria-label="清空筛选条件"
                    className="absolute right-1.5 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-[2px] text-[var(--ink-muted)] hover:bg-[var(--bg-plane)] hover:text-[var(--ink-primary)] cursor-pointer"
                  >
                    <X className="h-3 w-3" strokeWidth={1.75} />
                  </button>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2 font-mono-code text-[12px] text-[var(--ink-muted)] tabular-nums">
              <Users className="h-3.5 w-3.5" strokeWidth={1.75} />
              <span>
                显示 {filteredEmployees.length} / 已加载 {employees.length}
                {nextCursor ? "+" : ""}
              </span>
            </div>
          </div>

          {/* Employee Table */}
          {loading && employees.length === 0 ? (
            <div className="px-4 py-12 text-center font-mono-code text-[12.5px] text-[var(--ink-muted)]">
              正在加载租户员工目录…
            </div>
          ) : filteredEmployees.length === 0 ? (
            <div className="px-4 py-12 text-center text-[13px] text-[var(--ink-muted)]">
              {employees.length === 0
                ? "当前租户暂无已登录登记的员工记录。"
                : `在已加载的 ${employees.length} 位员工中未匹配到「${searchQuery.trim()}」${nextCursor ? "，可点击下方「加载更多」继续检索后续页。" : "。"}`}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-[var(--hairline)] bg-[var(--bg-plane)] text-[11.5px] font-medium text-[var(--ink-secondary)]">
                    <th className="px-4 py-2.5">员工主体标识 (subject)</th>
                    <th className="px-4 py-2.5">授权操作范围</th>
                    <th className="px-4 py-2.5 text-right">配置入口</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--hairline)]">
                  {filteredEmployees.map((subject) => {
                    const isSelf = actor?.subject === subject;
                    const detailHref = `/admin/people/${encodeURIComponent(subject)}`;
                    return (
                      <tr
                        key={subject}
                        data-testid={`employee-row-${subject}`}
                        className="transition-colors duration-[120ms] hover:bg-[var(--bg-subtle)]"
                      >
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <Link
                              href={detailHref}
                              className="font-mono-code text-[13px] font-semibold text-[var(--ink-primary)] hover:text-[var(--accent)] hover:underline"
                            >
                              {subject}
                            </Link>
                            {isSelf && (
                              <span
                                data-testid="employee-self-badge"
                                className="inline-flex items-center rounded-[4px] border border-[var(--status-amber-border)] bg-[var(--status-amber-wash)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--status-amber-ink)]"
                              >
                                当前本人账号 · 不可修改
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-[12.5px] text-[var(--ink-muted)]">
                          {isSelf
                            ? "管理员不能修改自己的模块授权（仅支持只读核对）"
                            : "可配置 5 项工作台模块动作、仓库交集范围及到期时间"}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <Link
                            href={detailHref}
                            data-testid={`employee-open-${subject}`}
                            className={[
                              "inline-flex h-8 items-center gap-1.5 rounded-[4px] border px-3 text-[12px] font-medium transition-colors duration-[120ms]",
                              isSelf
                                ? "border-[var(--hairline-strong)] bg-[var(--bg-subtle)] text-[var(--ink-secondary)] hover:bg-[var(--bg-plane)]"
                                : "border-[var(--accent-border)] bg-[var(--accent-wash)] text-[var(--accent)] hover:bg-[var(--accent-wash-strong)]",
                            ].join(" ")}
                          >
                            <span>{isSelf ? "只读查看" : "管理模块授权"}</span>
                            <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.75} />
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Cursor Pagination Footer */}
          <div className="flex flex-col gap-2 border-t border-[var(--hairline)] bg-[var(--bg-subtle)] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <span className="font-mono-code text-[11.5px] text-[var(--ink-muted)] tabular-nums">
              {nextCursor
                ? `当前游标 after=${nextCursor} · 仍有更多员工可加载`
                : `已加载全部已登记员工（共 ${employees.length} 位）`}
            </span>
            {nextCursor && (
              <Button
                size="sm"
                variant="secondary"
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
