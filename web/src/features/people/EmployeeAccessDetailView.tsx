"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Clock,
  Info,
  RefreshCw,
  Save,
  ShieldAlert,
  ShieldOff,
  X,
} from "lucide-react";
import { isApiError, isStaleAuthError, type ApiError } from "@/lib/api-client";
import { formatUnixTime } from "@/lib/format";
import { useSession } from "@/lib/session-context";
import { AccessNoticeCard, Button, StatusBadge } from "@/components/ui";
import { ActionConfirmDialog } from "@/features/admin/ActionConfirmDialog";
import {
  fetchEmployeeModuleAssignments,
  fetchModuleAccessCatalog,
  saveEmployeeModuleAssignment,
} from "@/features/people/api";
import {
  classifyModuleAssignment,
  getDependentWriteGrants,
  getLocalTimezoneLabel,
  getModuleMeta,
  GRANT_META,
  GRANT_PREREQUISITES,
  localInputToUnixSeconds,
  MAX_EXPIRES_AT_UNIX,
  sortCatalogModuleIds,
  unixSecondsToLocalInput,
} from "@/features/people/module-meta";
import type {
  Grant,
  ModuleAccessCatalog,
  ModuleAssignment,
} from "@/lib/types";

interface ModuleDraft {
  grants: Grant[];
  warehouses: string[];
  expiresAtInput: string;
}

interface ModuleFeedback {
  kind: "success" | "conflict" | "error" | "info";
  message: string;
  requestId?: string | null;
}

function buildDraftFromAssignment(
  assignment: ModuleAssignment | undefined,
): ModuleDraft {
  if (!assignment) {
    return { grants: [], warehouses: [], expiresAtInput: "" };
  }
  return {
    grants: [...assignment.grants],
    warehouses: [...assignment.warehouses],
    expiresAtInput: unixSecondsToLocalInput(assignment.expires_at),
  };
}

function sameSortedSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((val, idx) => val === sb[idx]);
}

function isDraftDirty(
  draft: ModuleDraft,
  assignment: ModuleAssignment | undefined,
): boolean {
  const baseline = buildDraftFromAssignment(assignment);
  return (
    !sameSortedSet(draft.grants, baseline.grants) ||
    !sameSortedSet(draft.warehouses, baseline.warehouses) ||
    draft.expiresAtInput.trim() !== baseline.expiresAtInput.trim()
  );
}

export interface EmployeeAccessDetailViewProps {
  subject: string;
}

export function EmployeeAccessDetailView({
  subject,
}: EmployeeAccessDetailViewProps) {
  const {
    actor,
    canManagePeople,
    canAccessAdminOps,
    authGeneration,
    handleAccessChanged,
  } = useSession();

  const [catalog, setCatalog] = useState<ModuleAccessCatalog | null>(null);
  const [assignments, setAssignments] = useState<
    Record<string, ModuleAssignment>
  >({});
  const [drafts, setDrafts] = useState<Record<string, ModuleDraft>>({});
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [savingModule, setSavingModule] = useState<string | null>(null);
  const [feedbackByModule, setFeedbackByModule] = useState<
    Record<string, ModuleFeedback | null>
  >({});
  const [lastSavedAt, setLastSavedAt] = useState<Record<string, number>>({});
  const [revokeTargetModule, setRevokeTargetModule] = useState<string | null>(
    null,
  );
  const [nowUnix, setNowUnix] = useState<number>(() =>
    Math.floor(Date.now() / 1000),
  );
  const [localTzLabel, setLocalTzLabel] = useState<string>("本地时区");

  const isSelf = actor?.subject === subject;

  useEffect(() => {
    setLocalTzLabel(getLocalTimezoneLabel());
    const timer = window.setInterval(() => {
      setNowUnix(Math.floor(Date.now() / 1000));
    }, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const syncDraftsFromServer = useCallback(
    (
      nextCatalog: ModuleAccessCatalog,
      nextAssignments: Record<string, ModuleAssignment>,
    ) => {
      const nextDrafts: Record<string, ModuleDraft> = {};
      for (const moduleId of Object.keys(nextCatalog.modules)) {
        nextDrafts[moduleId] = buildDraftFromAssignment(
          nextAssignments[moduleId],
        );
      }
      setDrafts(nextDrafts);
    },
    [],
  );

  const loadEmployeeAccess = useCallback(
    async (signal?: AbortSignal) => {
      if (!canManagePeople) return;
      setLoading(true);
      setLoadError(null);
      try {
        const [catalogRes, employeeRes] = await Promise.all([
          fetchModuleAccessCatalog(signal),
          fetchEmployeeModuleAssignments(subject, signal),
        ]);
        setCatalog(catalogRes);
        setAssignments(employeeRes.assignments);
        syncDraftsFromServer(catalogRes, employeeRes.assignments);
        setNowUnix(Math.floor(Date.now() / 1000));
      } catch (err) {
        if (isStaleAuthError(err)) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (isApiError(err)) {
          if (err.code === "ACCESS_CHANGED") {
            setCatalog(null);
            setAssignments({});
            setDrafts({});
            void handleAccessChanged();
          }
          setLoadError(err);
        }
      } finally {
        setLoading(false);
      }
    },
    [canManagePeople, subject, syncDraftsFromServer, handleAccessChanged],
  );

  useEffect(() => {
    setCatalog(null);
    setAssignments({});
    setDrafts({});
    setLoadError(null);
    setFeedbackByModule({});
    setLastSavedAt({});
    setRevokeTargetModule(null);

    if (!canManagePeople) return;

    const controller = new AbortController();
    void loadEmployeeAccess(controller.signal);
    return () => {
      controller.abort();
    };
  }, [authGeneration, canManagePeople, subject, loadEmployeeAccess]);

  const moduleIds = useMemo(() => {
    if (!catalog) return [];
    return sortCatalogModuleIds(Object.keys(catalog.modules));
  }, [catalog]);

  const setModuleFeedback = useCallback(
    (moduleId: string, feedback: ModuleFeedback | null) => {
      setFeedbackByModule((prev) => ({ ...prev, [moduleId]: feedback }));
    },
    [],
  );

  const handleToggleGrant = useCallback(
    (moduleId: string, grant: Grant, checked: boolean) => {
      if (isSelf) return;
      const current = drafts[moduleId] ?? {
        grants: [],
        warehouses: [],
        expiresAtInput: "",
      };
      const nextSet = new Set<Grant>(current.grants);
      let infoNote: string | null = null;

      if (checked) {
        nextSet.add(grant);
        const requiredRead = GRANT_PREREQUISITES[grant];
        if (requiredRead && !nextSet.has(requiredRead)) {
          nextSet.add(requiredRead);
          infoNote = `已自动勾选前置读取权限 ${requiredRead}（写入动作 ${grant} 依赖对应读取权限）。`;
        }
      } else {
        nextSet.delete(grant);
        const dependents = getDependentWriteGrants(grant);
        const removed: Grant[] = [];
        for (const dep of dependents) {
          if (nextSet.has(dep)) {
            nextSet.delete(dep);
            removed.push(dep);
          }
        }
        if (removed.length > 0) {
          infoNote = `取消 ${grant} 后已同步取消依赖它的写入权限 ${removed.join(", ")}。`;
        }
      }

      const nextGrants = Array.from(nextSet);
      setDrafts((prev) => ({
        ...prev,
        [moduleId]: {
          ...(prev[moduleId] ?? current),
          grants: nextGrants,
        },
      }));
      if (infoNote) {
        setModuleFeedback(moduleId, { kind: "info", message: infoNote });
      } else {
        setModuleFeedback(moduleId, null);
      }
    },
    [isSelf, drafts, setModuleFeedback],
  );

  const handleToggleWarehouse = useCallback(
    (moduleId: string, warehouse: string, checked: boolean) => {
      if (isSelf) return;
      setDrafts((prev) => {
        const current = prev[moduleId] ?? {
          grants: [],
          warehouses: [],
          expiresAtInput: "",
        };
        const nextSet = new Set<string>(current.warehouses);
        if (checked) {
          nextSet.add(warehouse);
        } else {
          nextSet.delete(warehouse);
        }
        return {
          ...prev,
          [moduleId]: {
            ...current,
            warehouses: Array.from(nextSet),
          },
        };
      });
      setModuleFeedback(moduleId, null);
    },
    [isSelf, setModuleFeedback],
  );

  const handleSetAllWarehouses = useCallback(
    (moduleId: string, warehouses: string[]) => {
      if (isSelf) return;
      setDrafts((prev) => {
        const current = prev[moduleId] ?? {
          grants: [],
          warehouses: [],
          expiresAtInput: "",
        };
        return {
          ...prev,
          [moduleId]: {
            ...current,
            warehouses: [...warehouses],
          },
        };
      });
      setModuleFeedback(moduleId, null);
    },
    [isSelf, setModuleFeedback],
  );

  const handleExpiryChange = useCallback(
    (moduleId: string, value: string) => {
      if (isSelf) return;
      setDrafts((prev) => {
        const current = prev[moduleId] ?? {
          grants: [],
          warehouses: [],
          expiresAtInput: "",
        };
        return {
          ...prev,
          [moduleId]: {
            ...current,
            expiresAtInput: value,
          },
        };
      });
      setModuleFeedback(moduleId, null);
    },
    [isSelf, setModuleFeedback],
  );

  const reloadAfterConflict = useCallback(
    async (moduleId: string, requestId: string | null) => {
      try {
        const fresh = await fetchEmployeeModuleAssignments(subject);
        setAssignments(fresh.assignments);
        setDrafts((prev) => ({
          ...prev,
          [moduleId]: buildDraftFromAssignment(fresh.assignments[moduleId]),
        }));
        setNowUnix(Math.floor(Date.now() / 1000));
      } catch (refreshErr) {
        if (isStaleAuthError(refreshErr)) return;
      }
      setModuleFeedback(moduleId, {
        kind: "conflict",
        message: "配置已被其他管理员更新，已刷新最新状态，请核对后重新提交。",
        requestId,
      });
    },
    [subject, setModuleFeedback],
  );

  const handleSaveModule = useCallback(
    async (moduleId: string) => {
      if (!catalog || isSelf || savingModule) return;
      const draft = drafts[moduleId] ?? {
        grants: [],
        warehouses: [],
        expiresAtInput: "",
      };
      const persisted = assignments[moduleId];
      const currentVersion = persisted ? persisted.version : 0;

      // Client-side validation matching backend Assignment & ModuleAccess.put
      if (draft.grants.length === 0 && draft.warehouses.length === 0) {
        setModuleFeedback(moduleId, {
          kind: "error",
          message:
            "授予权限时必须至少选择一项动作与一个仓库；如需撤销此模块权限，请点击「撤销该模块权限」。",
        });
        return;
      }
      if (draft.grants.length === 0 || draft.warehouses.length === 0) {
        setModuleFeedback(moduleId, {
          kind: "error",
          message: "授予模块权限时，必须同时选择至少一项动作权限与至少一个仓库站点。",
        });
        return;
      }

      for (const g of draft.grants) {
        const req = GRANT_PREREQUISITES[g];
        if (req && !draft.grants.includes(req)) {
          setModuleFeedback(moduleId, {
            kind: "error",
            message: `动作 ${g} 依赖前置读取权限 ${req}，请同时勾选后再保存。`,
          });
          return;
        }
      }

      let expiresAt: number | null = null;
      if (draft.expiresAtInput.trim().length > 0) {
        const parsedUnix = localInputToUnixSeconds(draft.expiresAtInput);
        const currentSeconds = Math.floor(Date.now() / 1000);
        if (
          parsedUnix === null ||
          parsedUnix <= currentSeconds ||
          parsedUnix > MAX_EXPIRES_AT_UNIX
        ) {
          setModuleFeedback(moduleId, {
            kind: "error",
            message: "到期时间必须晚于当前本地时间，且不得超过 2100 年。",
          });
          return;
        }
        expiresAt = parsedUnix;
      }

      setSavingModule(moduleId);
      setModuleFeedback(moduleId, null);
      try {
        const saved = await saveEmployeeModuleAssignment(subject, moduleId, {
          version: currentVersion,
          grants: draft.grants,
          warehouses: draft.warehouses,
          expires_at: expiresAt,
        });
        const savedNow = Math.floor(Date.now() / 1000);
        setAssignments((prev) => ({ ...prev, [moduleId]: saved }));
        setDrafts((prev) => ({
          ...prev,
          [moduleId]: buildDraftFromAssignment(saved),
        }));
        setLastSavedAt((prev) => ({ ...prev, [moduleId]: savedNow }));
        setNowUnix(savedNow);
        setModuleFeedback(moduleId, {
          kind: "success",
          message: `已保存模块显式授权（版本 v${saved.version}）。`,
        });
      } catch (err) {
        if (isStaleAuthError(err)) return;
        if (isApiError(err)) {
          if (err.status === 409) {
            await reloadAfterConflict(moduleId, err.requestId);
          } else if (err.code === "ACCESS_CHANGED") {
            setCatalog(null);
            setAssignments({});
            setDrafts({});
            void handleAccessChanged();
            setLoadError(err);
          } else {
            setModuleFeedback(moduleId, {
              kind: "error",
              message: err.message,
              requestId: err.requestId,
            });
          }
        }
      } finally {
        setSavingModule(null);
      }
    },
    [
      catalog,
      isSelf,
      savingModule,
      drafts,
      assignments,
      subject,
      setModuleFeedback,
      reloadAfterConflict,
      handleAccessChanged,
    ],
  );

  const handleConfirmRevoke = useCallback(async () => {
    if (!revokeTargetModule || isSelf || savingModule) return;
    const moduleId = revokeTargetModule;
    const persisted = assignments[moduleId];
    const currentVersion = persisted ? persisted.version : 0;

    setSavingModule(moduleId);
    setModuleFeedback(moduleId, null);
    try {
      const saved = await saveEmployeeModuleAssignment(subject, moduleId, {
        version: currentVersion,
        grants: [],
        warehouses: [],
        expires_at: null,
      });
      const savedNow = Math.floor(Date.now() / 1000);
      setAssignments((prev) => ({ ...prev, [moduleId]: saved }));
      setDrafts((prev) => ({
        ...prev,
        [moduleId]: buildDraftFromAssignment(saved),
      }));
      setLastSavedAt((prev) => ({ ...prev, [moduleId]: savedNow }));
      setNowUnix(savedNow);
      setRevokeTargetModule(null);
      setModuleFeedback(moduleId, {
        kind: "success",
        message: `已撤销此模块权限（版本 v${saved.version}），相关查询与待派发提案已阻断。`,
      });
    } catch (err) {
      if (isStaleAuthError(err)) return;
      setRevokeTargetModule(null);
      if (isApiError(err)) {
        if (err.status === 409) {
          await reloadAfterConflict(moduleId, err.requestId);
        } else if (err.code === "ACCESS_CHANGED") {
          setCatalog(null);
          setAssignments({});
          setDrafts({});
          void handleAccessChanged();
          setLoadError(err);
        } else {
          setModuleFeedback(moduleId, {
            kind: "error",
            message: err.message,
            requestId: err.requestId,
          });
        }
      }
    } finally {
      setSavingModule(null);
    }
  }, [
    revokeTargetModule,
    isSelf,
    savingModule,
    assignments,
    subject,
    setModuleFeedback,
    reloadAfterConflict,
    handleAccessChanged,
  ]);

  // Strict capability gate: never fetch admin APIs when actor lacks workbench.access.manage
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

  const revokeModuleMeta = revokeTargetModule
    ? getModuleMeta(revokeTargetModule, 0)
    : null;
  const revokeCurrentVersion = revokeTargetModule
    ? (assignments[revokeTargetModule]?.version ?? 0)
    : 0;

  return (
    <div
      className="mx-auto max-w-[1060px] space-y-4 p-4 sm:p-6"
      data-testid="employee-access-detail-page"
    >
      {/* Top Header */}
      <section className="rounded-[6px] border border-[var(--hairline)] bg-[var(--bg-sheet)] p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <Link
              href="/admin/people"
              className="inline-flex items-center gap-1.5 text-[12px] font-medium text-[var(--ink-muted)] hover:text-[var(--ink-primary)]"
            >
              <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} />
              <span>返回员工目录</span>
            </Link>
            <div className="mt-2 flex flex-wrap items-center gap-2.5">
              <h2
                className="font-mono-code text-[20px] font-semibold tracking-[-0.01em] text-[var(--ink-primary)] break-all"
                data-testid="employee-detail-subject"
              >
                {subject}
              </h2>
              {isSelf && (
                <span className="inline-flex items-center rounded-[4px] border border-[var(--status-amber-border)] bg-[var(--status-amber-wash)] px-2 py-0.5 text-[11.5px] font-medium text-[var(--status-amber-ink)]">
                  本人账号 · 只读
                </span>
              )}
            </div>
            <p className="mt-1 text-[12.5px] text-[var(--ink-muted)]">
              租户{" "}
              <span className="font-mono-code text-[var(--ink-primary)]">
                {actor?.tenant ?? "—"}
              </span>{" "}
              · 可管理仓库：
              <span className="font-mono-code text-[var(--ink-primary)]">
                {catalog?.warehouses.join(", ") || "—"}
              </span>
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <Button
              size="sm"
              variant="secondary"
              loading={loading}
              data-testid="employee-access-refresh"
              onClick={() => void loadEmployeeAccess()}
            >
              <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} />
              <span>刷新最新配置</span>
            </Button>
          </div>
        </div>

        {/* Self-Modification Guard Banner */}
        {isSelf && (
          <div
            role="alert"
            data-testid="self-edit-guard-banner"
            className="mt-4 flex items-start gap-2.5 rounded-[4px] border border-[var(--status-crimson-border)] bg-[var(--status-crimson-wash)] px-3.5 py-2.5 text-[12.5px] text-[var(--status-crimson)]"
          >
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.75} />
            <div>
              <span className="font-semibold">管理员不能修改自己的模块授权。</span>
              <span className="ml-1 text-[var(--ink-secondary)]">
                所有授权勾选、到期编辑、保存与撤销操作均已禁用，请由其他具备全站点权限的管理员协助调整。
              </span>
            </div>
          </div>
        )}

        {/* Configured vs Effective Scope Clarity Note */}
        <div
          data-testid="scope-intersection-note"
          className="mt-3.5 flex items-start gap-2.5 rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] px-3.5 py-2.5 text-[12px] text-[var(--ink-secondary)] leading-relaxed"
        >
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--accent)]" strokeWidth={1.75} />
          <div>
            <span className="font-medium text-[var(--ink-primary)]">
              配置范围与实际生效范围说明：
            </span>
            此处配置的仓库范围将与员工经身份提供商核验的仓库范围取交集（
            <span className="font-mono-code text-[11.5px]">
              有效范围 = 模块显式配置 ∩ 员工身份仓库
            </span>
            ）；未显式配置的模块继承员工身份默认权限。员工最终生效的能力清单与仓库边界以其本人的{" "}
            <code className="font-mono-code text-[11.5px]">
              /v1/workbench/capabilities
            </code>{" "}
            返回为准。
          </div>
        </div>
      </section>

      {loadError && (
        <AccessNoticeCard
          error={loadError}
          onRetry={
            loadError.status === 404
              ? undefined
              : () => void loadEmployeeAccess()
          }
          backHref="/admin/people"
          backLabel="返回员工目录"
        />
      )}

      {loading && !catalog && !loadError && (
        <div className="rounded-[6px] border border-[var(--hairline)] bg-[var(--bg-sheet)] px-4 py-12 text-center font-mono-code text-[12.5px] text-[var(--ink-muted)]">
          正在加载员工模块授权快照…
        </div>
      )}

      {/* 5 Stacked Module Architectural Cards */}
      {catalog && !loadError && (
        <div className="space-y-3.5">
          {moduleIds.map((moduleId, idx) => {
            const spec = catalog.modules[moduleId]!;
            const meta = getModuleMeta(moduleId, idx);
            const persisted = assignments[moduleId];
            const stateInfo = classifyModuleAssignment(persisted, nowUnix);
            const draft = drafts[moduleId] ?? buildDraftFromAssignment(persisted);
            const dirty = isDraftDirty(draft, persisted);
            const isSavingThis = savingModule === moduleId;
            const feedback = feedbackByModule[moduleId];
            const persistedVersion = persisted ? persisted.version : 0;
            const isAlreadyRevoked = stateInfo.status === "revoked";
            const savedAt = lastSavedAt[moduleId];

            return (
              <section
                key={moduleId}
                data-testid={`module-card-${moduleId}`}
                data-module-state={stateInfo.status}
                className="rounded-[6px] border border-[var(--hairline)] bg-[var(--bg-sheet)] overflow-hidden"
              >
                {/* Module Card Header */}
                <div className="flex flex-col gap-2.5 border-b border-[var(--hairline)] px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono-code text-[11px] text-[var(--ink-muted)]">
                        MODULE · {meta.index}
                      </span>
                      <h3 className="text-[15px] font-semibold text-[var(--ink-primary)]">
                        {meta.title}
                      </h3>
                      <code className="rounded-[2px] border border-[var(--hairline)] bg-[var(--bg-subtle)] px-1.5 py-0.5 font-mono-code text-[11px] text-[var(--ink-secondary)]">
                        {moduleId}
                      </code>
                      {dirty && !isSelf && (
                        <span className="font-mono-code text-[11px] font-medium text-[var(--status-amber-ink)]">
                          · 未保存修改
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-[12.5px] text-[var(--ink-muted)]">
                      {meta.description}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    <StatusBadge
                      status={stateInfo.status}
                      label={stateInfo.label}
                    />
                    <span
                      data-testid={`module-version-${moduleId}`}
                      className="rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-subtle)] px-2 py-1 font-mono-code text-[11.5px] text-[var(--ink-secondary)] tabular-nums"
                    >
                      v{persistedVersion}
                    </span>
                  </div>
                </div>

                {/* Role Constraint Banner (e.g., approvals -> manager/admin only) */}
                {spec.roles && spec.roles.length > 0 && (
                  <div className="border-b border-[var(--hairline)] bg-[var(--status-amber-wash)] px-4 py-2 text-[12px] text-[var(--status-amber-ink)]">
                    <span className="font-medium">角色约束：</span>
                    仅当目标员工角色属于{" "}
                    <span className="font-mono-code font-semibold">
                      {spec.roles.join(" / ")}
                    </span>{" "}
                    时此模块授权才会生效；显式配置审批仓库后，审批范围可独立于经办写入权限生效。
                  </div>
                )}

                {/* Persisted Snapshot Summary Row */}
                <div className="grid grid-cols-1 gap-3 border-b border-[var(--hairline)] bg-[var(--bg-subtle)] px-4 py-2.5 text-[12px] sm:grid-cols-4">
                  <div>
                    <div className="text-[11px] text-[var(--ink-muted)]">
                      当前规则状态
                    </div>
                    <div className="mt-0.5 text-[var(--ink-primary)] font-medium">
                      {stateInfo.label}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] text-[var(--ink-muted)]">
                      已持久化动作
                    </div>
                    <div className="mt-0.5 font-mono-code text-[11.5px] text-[var(--ink-primary)] break-all">
                      {!persisted
                        ? "继承身份默认"
                        : persisted.grants.length === 0
                          ? "空（已撤销）"
                          : persisted.grants.join(", ")}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] text-[var(--ink-muted)]">
                      已持久化仓库
                    </div>
                    <div className="mt-0.5 font-mono-code text-[11.5px] text-[var(--ink-primary)]">
                      {!persisted
                        ? "继承身份默认"
                        : persisted.warehouses.length === 0
                          ? "空（已撤销）"
                          : persisted.warehouses.join(", ")}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] text-[var(--ink-muted)]">
                      到期时间（{localTzLabel}）
                    </div>
                    <div className="mt-0.5 font-mono-code text-[11.5px] text-[var(--ink-primary)] tabular-nums">
                      {!persisted
                        ? "不适用"
                        : persisted.expires_at
                          ? `${formatUnixTime(persisted.expires_at)}${stateInfo.status === "expired" ? "（已到期）" : ""}`
                          : persisted.grants.length === 0
                            ? "不适用"
                            : "永久有效"}
                    </div>
                  </div>
                </div>

                {/* Editor Body */}
                <div className="grid grid-cols-1 gap-5 p-4 lg:grid-cols-12">
                  {/* Column 1: Action Grants */}
                  <div className="lg:col-span-5">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-[12px] font-semibold text-[var(--ink-secondary)]">
                        动作权限 (grants)
                      </span>
                      <span className="font-mono-code text-[11px] text-[var(--ink-muted)] tabular-nums">
                        已选 {draft.grants.length} / {spec.grants.length}
                      </span>
                    </div>
                    <div className="divide-y divide-[var(--hairline-subtle)] rounded-[4px] border border-[var(--hairline)]">
                      {spec.grants.map((grant) => {
                        const checked = draft.grants.includes(grant);
                        const grantInfo = GRANT_META[grant];
                        const reqGrant = GRANT_PREREQUISITES[grant];
                        const checkboxId = `grant-${moduleId}-${grant}`;
                        return (
                          <label
                            key={grant}
                            htmlFor={checkboxId}
                            className={[
                              "flex items-start gap-2.5 px-3 py-2.5 transition-colors duration-[120ms]",
                              isSelf
                                ? "cursor-not-allowed opacity-65"
                                : "cursor-pointer hover:bg-[var(--bg-subtle)]",
                              checked ? "bg-[var(--accent-wash)]" : "",
                            ].join(" ")}
                          >
                            <input
                              id={checkboxId}
                              type="checkbox"
                              checked={checked}
                              disabled={isSelf || isSavingThis}
                              data-testid={`grant-checkbox-${moduleId}-${grant}`}
                              onChange={(e) =>
                                handleToggleGrant(
                                  moduleId,
                                  grant,
                                  e.target.checked,
                                )
                              }
                              className="mt-0.5 h-4 w-4 shrink-0 rounded-[2px] border-[var(--hairline-strong)] accent-[var(--accent)]"
                            />
                            <div className="min-w-0 flex-1">
                              <div className="text-[13px] font-medium text-[var(--ink-primary)] leading-snug">
                                {grantInfo?.label ?? grant}
                              </div>
                              <div className="mt-0.5 flex flex-wrap items-center gap-2 font-mono-code text-[11px] text-[var(--ink-muted)]">
                                <span>{grant}</span>
                                {reqGrant && (
                                  <span className="rounded-[2px] border border-[var(--hairline)] bg-[var(--bg-subtle)] px-1 py-0.5 text-[10px]">
                                    需前置 {reqGrant}
                                  </span>
                                )}
                              </div>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </div>

                  {/* Column 2: Warehouses */}
                  <div className="lg:col-span-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className="text-[12px] font-semibold text-[var(--ink-secondary)]">
                        仓库范围 (warehouses)
                      </span>
                      {!isSelf && catalog.warehouses.length > 0 && (
                        <div className="flex items-center gap-2 text-[11px]">
                          <button
                            type="button"
                            disabled={isSavingThis}
                            onClick={() =>
                              handleSetAllWarehouses(
                                moduleId,
                                catalog.warehouses,
                              )
                            }
                            className="text-[var(--accent)] hover:underline cursor-pointer disabled:opacity-50"
                          >
                            全选
                          </button>
                          <button
                            type="button"
                            disabled={isSavingThis}
                            onClick={() => handleSetAllWarehouses(moduleId, [])}
                            className="text-[var(--ink-muted)] hover:text-[var(--ink-primary)] cursor-pointer disabled:opacity-50"
                          >
                            清空
                          </button>
                        </div>
                      )}
                    </div>
                    <div className="divide-y divide-[var(--hairline-subtle)] rounded-[4px] border border-[var(--hairline)]">
                      {catalog.warehouses.map((wh) => {
                        const checked = draft.warehouses.includes(wh);
                        const whId = `wh-${moduleId}-${wh}`;
                        return (
                          <label
                            key={wh}
                            htmlFor={whId}
                            className={[
                              "flex items-center gap-2.5 px-3 py-2.5 transition-colors duration-[120ms]",
                              isSelf
                                ? "cursor-not-allowed opacity-65"
                                : "cursor-pointer hover:bg-[var(--bg-subtle)]",
                              checked ? "bg-[var(--accent-wash)]" : "",
                            ].join(" ")}
                          >
                            <input
                              id={whId}
                              type="checkbox"
                              checked={checked}
                              disabled={isSelf || isSavingThis}
                              data-testid={`warehouse-checkbox-${moduleId}-${wh}`}
                              onChange={(e) =>
                                handleToggleWarehouse(
                                  moduleId,
                                  wh,
                                  e.target.checked,
                                )
                              }
                              className="h-4 w-4 shrink-0 rounded-[2px] border-[var(--hairline-strong)] accent-[var(--accent)]"
                            />
                            <span className="font-mono-code text-[13px] font-medium text-[var(--ink-primary)]">
                              {wh}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </div>

                  {/* Column 3: Optional Expiration */}
                  <div className="lg:col-span-4">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <label
                        htmlFor={`expiry-${moduleId}`}
                        className="text-[12px] font-semibold text-[var(--ink-secondary)]"
                      >
                        到期时间（可选）
                      </label>
                      {draft.expiresAtInput && !isSelf && (
                        <button
                          type="button"
                          disabled={isSavingThis}
                          data-testid={`module-expiry-clear-${moduleId}`}
                          onClick={() => handleExpiryChange(moduleId, "")}
                          className="inline-flex items-center gap-1 text-[11px] text-[var(--ink-muted)] hover:text-[var(--ink-primary)] cursor-pointer disabled:opacity-50"
                        >
                          <X className="h-3 w-3" strokeWidth={1.75} />
                          <span>清除（永久有效）</span>
                        </button>
                      )}
                    </div>
                    <div className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] p-3">
                      <div className="flex items-center gap-2">
                        <Clock
                          className="h-3.5 w-3.5 shrink-0 text-[var(--ink-muted)]"
                          strokeWidth={1.75}
                        />
                        <input
                          id={`expiry-${moduleId}`}
                          type="datetime-local"
                          value={draft.expiresAtInput}
                          disabled={isSelf || isSavingThis}
                          aria-invalid={
                            (feedback?.kind === "error" &&
                              feedback.message.includes("到期时间")) ||
                            undefined
                          }
                          data-testid={`module-expiry-${moduleId}`}
                          onChange={(e) =>
                            handleExpiryChange(moduleId, e.target.value)
                          }
                          className="h-8 min-w-0 flex-1 rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-2 font-mono-code text-[12px] text-[var(--ink-primary)] tabular-nums focus:border-[var(--accent)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                        />
                      </div>
                      <p className="mt-2 text-[11.5px] text-[var(--ink-muted)] leading-relaxed">
                        留空表示永久有效；填写后将按本地时区（{localTzLabel}
                        ）换算为 Unix 秒时间戳提交（仅支持未来时间）。
                      </p>
                    </div>
                  </div>
                </div>

                {/* Inline Feedback Strip */}
                {feedback && (
                  <div
                    role={feedback.kind === "info" ? "status" : "alert"}
                    data-testid={
                      feedback.kind === "conflict"
                        ? `module-conflict-${moduleId}`
                        : `module-feedback-${moduleId}`
                    }
                    className={[
                      "mx-4 mb-3 flex items-start justify-between gap-3 rounded-[4px] border px-3 py-2 text-[12.5px]",
                      feedback.kind === "success"
                        ? "border-[var(--status-emerald-border)] bg-[var(--status-emerald-wash)] text-[var(--status-emerald)]"
                        : feedback.kind === "conflict"
                          ? "border-[var(--status-amber-border)] bg-[var(--status-amber-wash)] text-[var(--status-amber-ink)]"
                          : feedback.kind === "error"
                            ? "border-[var(--status-crimson-border)] bg-[var(--status-crimson-wash)] text-[var(--status-crimson)]"
                            : "border-[var(--accent-border)] bg-[var(--accent-wash)] text-[var(--accent)]",
                    ].join(" ")}
                  >
                    <div className="flex items-start gap-2 min-w-0">
                      {feedback.kind === "success" ? (
                        <CheckCircle2
                          className="mt-0.5 h-3.5 w-3.5 shrink-0"
                          strokeWidth={1.75}
                        />
                      ) : feedback.kind === "info" ? (
                        <Info
                          className="mt-0.5 h-3.5 w-3.5 shrink-0"
                          strokeWidth={1.75}
                        />
                      ) : (
                        <AlertTriangle
                          className="mt-0.5 h-3.5 w-3.5 shrink-0"
                          strokeWidth={1.75}
                        />
                      )}
                      <div className="min-w-0">
                        <span>{feedback.message}</span>
                        {feedback.requestId && (
                          <span className="ml-2 font-mono-code text-[11px] opacity-80">
                            跟踪编号: {feedback.requestId}
                          </span>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setModuleFeedback(moduleId, null)}
                      aria-label="关闭提示"
                      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[2px] opacity-70 hover:opacity-100 cursor-pointer"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}

                {/* Action Footer */}
                <div className="flex flex-col gap-2.5 border-t border-[var(--hairline)] bg-[var(--bg-subtle)] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="font-mono-code text-[11.5px] text-[var(--ink-muted)] tabular-nums">
                    {persisted
                      ? `乐观锁版本 v${persisted.version}${savedAt ? ` · 本次已保存于 ${formatUnixTime(savedAt, { withSeconds: true }).slice(11)}` : ""}`
                      : "首次保存将携带 version: 0 创建显式规则"}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={isSelf || isSavingThis || isAlreadyRevoked}
                      data-testid={`module-revoke-${moduleId}`}
                      onClick={() => setRevokeTargetModule(moduleId)}
                    >
                      <ShieldOff className="h-3.5 w-3.5" strokeWidth={1.75} />
                      <span>
                        {isAlreadyRevoked ? "已撤销此模块" : "撤销该模块权限"}
                      </span>
                    </Button>

                    <Button
                      size="sm"
                      variant="primary"
                      loading={isSavingThis && revokeTargetModule !== moduleId}
                      disabled={isSelf || isSavingThis}
                      data-testid={`module-save-${moduleId}`}
                      onClick={() => void handleSaveModule(moduleId)}
                    >
                      <Save className="h-3.5 w-3.5" strokeWidth={1.75} />
                      <span>保存授权</span>
                    </Button>
                  </div>
                </div>
              </section>
            );
          })}
        </div>
      )}

      {/* Explicit Revoke Confirmation Dialog */}
      <ActionConfirmDialog
        open={revokeTargetModule !== null}
        onOpenChange={(open) => {
          if (!open && !savingModule) {
            setRevokeTargetModule(null);
          }
        }}
        destructive
        loading={
          revokeTargetModule !== null && savingModule === revokeTargetModule
        }
        title={
          revokeModuleMeta
            ? `确认撤销「${revokeModuleMeta.title}」模块权限`
            : "确认撤销模块权限"
        }
        description="撤销该员工此模块权限，发送空动作与空仓库配置，生效后将阻断相关查询及待派发提案。"
        scopeSummary={`租户 ${actor?.tenant ?? "—"} · 目标员工 ${subject} · 模块 ${revokeModuleMeta?.title ?? ""} (${revokeTargetModule ?? ""})`}
        metadata={[
          { label: "目标员工 (subject)", value: subject, mono: true },
          {
            label: "目标模块",
            value: revokeTargetModule ?? "—",
            mono: true,
          },
          {
            label: "提交乐观锁版本",
            value: `v${revokeCurrentVersion}`,
            mono: true,
          },
          {
            label: "提交撤销载荷",
            value: "grants: [], warehouses: [], expires_at: null",
            mono: true,
          },
        ]}
        confirmLabel="确认撤销权限"
        cancelLabel="取消"
        dialogTestId="revoke-confirm-dialog"
        confirmTestId="confirm-dialog-submit"
        onConfirm={handleConfirmRevoke}
      />
    </div>
  );
}
