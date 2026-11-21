"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
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
import {
  AccessNoticeCard,
  Avatar,
  Button,
  StatusBadge,
} from "@/components/ui";
import { ActionConfirmDialog } from "@/features/admin/ActionConfirmDialog";
import {
  fetchEmployeeModuleAssignments,
  fetchModuleAccessCatalog,
  saveEmployeeModuleAssignment,
} from "@/features/people/api";
import {
  classifyModuleAssignment,
  formatOffsetDaysLocalInput,
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
  const [localTzLabel, setLocalTzLabel] = useState<string>("本地时间");

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
          const reqLabel = GRANT_META[requiredRead]?.label ?? requiredRead;
          const grantLabel = GRANT_META[grant]?.label ?? grant;
          infoNote = `已自动勾选前置读取权限「${reqLabel}」（「${grantLabel}」依赖对应读取权限）。`;
        }
      } else {
        nextSet.delete(grant);
        const dependents = getDependentWriteGrants(grant);
        const removed: string[] = [];
        for (const dep of dependents) {
          if (nextSet.has(dep)) {
            nextSet.delete(dep);
            removed.push(GRANT_META[dep]?.label ?? dep);
          }
        }
        if (removed.length > 0) {
          const grantLabel = GRANT_META[grant]?.label ?? grant;
          infoNote = `取消「${grantLabel}」后已同步取消依赖它的写入权限（${removed.join("、")}）。`;
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
          message:
            "授予模块权限时，必须同时选择至少一项动作权限与至少一个仓库站点。",
        });
        return;
      }

      for (const g of draft.grants) {
        const req = GRANT_PREREQUISITES[g];
        if (req && !draft.grants.includes(req)) {
          setModuleFeedback(moduleId, {
            kind: "error",
            message: `「${GRANT_META[g]?.label ?? g}」依赖前置读取权限「${GRANT_META[req]?.label ?? req}」，请同时勾选后再保存。`,
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
            message:
              "到期时间格式需为 YYYY-MM-DD HH:MM，且必须晚于当前本地时间（不超过 2100 年）。",
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
          message: `已保存模块授权（第 ${saved.version} 版配置）。`,
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
        message: `已撤销此模块权限（第 ${saved.version} 版配置），相关查询与待派发提案已阻断。`,
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

  const revokeModuleMeta = revokeTargetModule
    ? getModuleMeta(revokeTargetModule, 0)
    : null;
  const revokeCurrentVersion = revokeTargetModule
    ? (assignments[revokeTargetModule]?.version ?? 0)
    : 0;

  return (
    <div
      className="mx-auto max-w-[1060px] space-y-5 px-4 py-6 sm:px-6 lg:py-7 pb-16"
      data-testid="employee-access-detail-page"
    >
      {/* Back Pill */}
      <div>
        <Link
          href="/admin/people"
          className="inline-flex items-center gap-1.5 rounded-full bg-[var(--bg-surface)] px-3 py-1 text-[12px] font-medium text-[var(--ink-secondary)] shadow-[var(--shadow-subtle)] hover:text-[var(--accent)] hover:shadow-[var(--shadow-card)] transition-all duration-[150ms]"
        >
          <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.85} />
          <span>返回员工目录</span>
        </Link>
      </div>

      {/* Unified Porcelain Employee Header Sheet */}
      <section className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] p-5 sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4 min-w-0">
            <Avatar
              fallbackText={subject}
              name={subject}
              size="lg"
              kind="user"
            />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1
                  className="font-mono-code text-[20px] font-semibold tracking-[-0.02em] text-[var(--ink-primary)] break-all"
                  data-testid="employee-detail-subject"
                >
                  {subject}
                </h1>
                {isSelf && (
                  <span className="inline-flex items-center rounded-full bg-[var(--status-amber-wash)] px-2.5 py-0.5 text-[11.5px] font-medium text-[var(--status-amber-ink)]">
                    本人账号 · 只读
                  </span>
                )}
              </div>
              <p className="mt-1 text-[12.5px] text-[var(--ink-muted)] tabular-nums">
                <span className="font-mono-code">{actor?.tenant ?? "—"}</span>
                <span className="mx-1.5 text-[var(--ink-faint)]">·</span>
                <span>
                  可管理仓库{" "}
                  <span className="font-mono-code text-[var(--ink-secondary)]">
                    {catalog?.warehouses.join(" / ") || "—"}
                  </span>
                </span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <Button
              size="sm"
              pill
              variant="secondary"
              loading={loading}
              data-testid="employee-access-refresh"
              onClick={() => void loadEmployeeAccess()}
            >
              <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.85} />
              <span>刷新最新配置</span>
            </Button>
          </div>
        </div>

        {/* Self-Modification Guard Banner */}
        {isSelf && (
          <div
            role="alert"
            data-testid="self-edit-guard-banner"
            className="mt-4 flex items-start gap-3 rounded-tile bg-[var(--status-crimson-wash)] px-4 py-3 text-[13px] text-[var(--status-crimson)]"
          >
            <ShieldAlert
              className="mt-0.5 h-4 w-4 shrink-0"
              strokeWidth={1.85}
            />
            <div className="leading-relaxed">
              <span className="font-semibold">
                管理员不能修改自己的模块授权。
              </span>
              <span className="ml-1 text-[var(--ink-secondary)]">
                所有编辑、保存与撤销操作均已禁用，请由其他具备全站点权限的管理员协助调整。
              </span>
            </div>
          </div>
        )}

        {/* Single Page-Level Scope & Expiry Explanation (Shown ONCE per page, never repeated per card) */}
        <p
          data-testid="scope-intersection-note"
          className="mt-4 border-t border-[var(--hairline-subtle)] pt-3.5 text-[12px] text-[var(--ink-muted)] leading-relaxed"
        >
          实际生效范围取「模块显式配置」与「员工身份已验证仓库」的交集，未单独配置的模块沿用默认权限；到期时间留空即永久有效（按
          {localTzLabel}计算，格式{" "}
          <span className="font-mono-code text-[var(--ink-secondary)]">
            YYYY-MM-DD HH:MM
          </span>
          ）。
        </p>
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
        <div className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] px-6 py-14 text-center text-[13px] text-[var(--ink-muted)]">
          正在加载员工模块授权快照…
        </div>
      )}

      {/* 5 Elevated Porcelain Module Sheets (NO 3D tilt on input/checkbox edit cards) */}
      {catalog && !loadError && (
        <div className="space-y-4">
          {moduleIds.map((moduleId, idx) => {
            const spec = catalog.modules[moduleId]!;
            const meta = getModuleMeta(moduleId, idx);
            const persisted = assignments[moduleId];
            const stateInfo = classifyModuleAssignment(persisted, nowUnix);
            const draft =
              drafts[moduleId] ?? buildDraftFromAssignment(persisted);
            const dirty = isDraftDirty(draft, persisted);
            const isSavingThis = savingModule === moduleId;
            const feedback = feedbackByModule[moduleId];
            const persistedVersion = persisted ? persisted.version : 0;
            const isAlreadyRevoked = stateInfo.status === "revoked";
            const savedAt = lastSavedAt[moduleId];
            const showExplicitActions = dirty || Boolean(persisted);
            const hasExpiry = draft.expiresAtInput.trim().length > 0;

            return (
              <section
                key={moduleId}
                data-testid={`module-card-${moduleId}`}
                data-module-state={stateInfo.status}
                className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] p-5 sm:p-6"
              >
                {/* Module Card Header (raw module slug tucked into title tooltip) */}
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <h2
                        title={`模块标识：${moduleId}`}
                        className="text-[16px] font-semibold tracking-[-0.015em] text-[var(--ink-primary)]"
                      >
                        {meta.title}
                      </h2>
                      {dirty && !isSelf && (
                        <span className="inline-flex items-center rounded-full bg-[var(--status-amber-wash)] px-2.5 py-0.5 text-[11px] font-medium text-[var(--status-amber-ink)]">
                          未保存修改
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-[13px] text-[var(--ink-muted)] leading-relaxed">
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
                      title={
                        persisted
                          ? `当前为第 ${persistedVersion} 版配置 (v${persistedVersion})`
                          : "尚未单独配置 (v0)"
                      }
                      className="inline-flex items-center rounded-full bg-[var(--bg-surface-subtle)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--ink-secondary)] tabular-nums leading-none"
                    >
                      {persisted ? `第 ${persistedVersion} 版` : "首次配置"}
                    </span>
                  </div>
                </div>

                {/* Role Constraint Notice (e.g., approvals -> manager/admin only) */}
                {spec.roles && spec.roles.length > 0 && (
                  <div className="mt-4 rounded-tile bg-[var(--status-amber-wash)] px-3.5 py-2.5 text-[12.5px] text-[var(--status-amber-ink)] leading-relaxed">
                    <span className="font-semibold">角色约束：</span>
                    仅当员工角色为主管或管理员时此模块授权才会生效；配置审批仓库后可独立于经办写入权限生效。
                  </div>
                )}

                {/* Concise Persisted Snapshot Strip (shown ONLY when explicitly configured — zero inherited repetition) */}
                {persisted && (
                  <dl className="mt-4 grid grid-cols-1 gap-3 rounded-tile bg-[var(--bg-surface-tint)] px-4 py-3 text-[12px] sm:grid-cols-3">
                    <div>
                      <dt className="text-[11px] text-[var(--ink-muted)]">
                        已保存动作
                      </dt>
                      <dd
                        title={persisted.grants.join(", ") || "空"}
                        className="mt-0.5 font-medium text-[var(--ink-primary)]"
                      >
                        {persisted.grants.length === 0
                          ? "已清空（已撤销）"
                          : persisted.grants
                              .map((g) => GRANT_META[g]?.label ?? g)
                              .join("、")}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-[11px] text-[var(--ink-muted)]">
                        已保存仓库
                      </dt>
                      <dd className="mt-0.5 font-mono-code text-[12px] font-medium text-[var(--ink-primary)]">
                        {persisted.warehouses.length === 0
                          ? "已清空（已撤销）"
                          : persisted.warehouses.join(" · ")}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-[11px] text-[var(--ink-muted)]">
                        到期时间（{localTzLabel}）
                      </dt>
                      <dd className="mt-0.5 font-mono-code text-[12px] text-[var(--ink-primary)] tabular-nums">
                        {persisted.expires_at
                          ? `${formatUnixTime(persisted.expires_at)}${stateInfo.status === "expired" ? "（已到期）" : ""}`
                          : persisted.grants.length === 0
                            ? "不适用"
                            : "永久有效"}
                      </dd>
                    </div>
                  </dl>
                )}

                {/* Editor Body */}
                <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-12">
                  {/* Column 1: Action Grants (Custom Accessible Cobalt Checkboxes) */}
                  <div className="lg:col-span-5">
                    <div className="mb-2.5 flex items-center justify-between">
                      <span className="text-[12.5px] font-semibold text-[var(--ink-secondary)]">
                        动作权限
                      </span>
                      <span className="text-[11.5px] text-[var(--ink-muted)] tabular-nums">
                        已选 {draft.grants.length} / {spec.grants.length}
                      </span>
                    </div>
                    <div className="space-y-2">
                      {spec.grants.map((grant) => {
                        const checked = draft.grants.includes(grant);
                        const grantInfo = GRANT_META[grant];
                        const reqGrant = GRANT_PREREQUISITES[grant];
                        const reqLabel = reqGrant
                          ? (GRANT_META[reqGrant]?.label ?? reqGrant)
                          : null;
                        const checkboxId = `grant-${moduleId}-${grant}`;
                        return (
                          <label
                            key={grant}
                            htmlFor={checkboxId}
                            title={`权限编码：${grant}`}
                            className={[
                              "flex items-center gap-3 rounded-tile px-3.5 py-2.5 transition-all duration-[150ms] select-none",
                              isSelf
                                ? "cursor-not-allowed opacity-65"
                                : "cursor-pointer",
                              checked
                                ? "bg-[var(--accent-wash)] ring-1 ring-[var(--accent-border)]"
                                : "bg-[var(--bg-surface-tint)] hover:bg-[var(--bg-surface-subtle)]",
                            ].join(" ")}
                          >
                            <span className="relative flex h-4.5 w-4.5 shrink-0 items-center justify-center">
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
                                className="peer absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
                              />
                              <span
                                aria-hidden="true"
                                className={[
                                  "pointer-events-none flex h-4.5 w-4.5 items-center justify-center rounded-xs transition-all duration-[150ms] peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--accent)] peer-focus-visible:ring-offset-1",
                                  checked
                                    ? "bg-[var(--accent)] text-white shadow-[0_1px_2px_rgba(22,104,227,0.28)]"
                                    : "bg-[var(--bg-surface)] ring-1 ring-[var(--hairline-strong)]",
                                ].join(" ")}
                              >
                                {checked && (
                                  <Check className="h-3 w-3" strokeWidth={2.75} />
                                )}
                              </span>
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="text-[13px] font-medium text-[var(--ink-primary)] leading-snug">
                                {grantInfo?.label ?? grant}
                              </div>
                              {reqLabel && (
                                <div className="mt-0.5 text-[11px] text-[var(--ink-muted)]">
                                  需先具备「{reqLabel}」
                                </div>
                              )}
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </div>

                  {/* Column 2: Warehouses (Pure Tactile Toggle Pills — No Inner Checkbox Chrome) */}
                  <div className="lg:col-span-3">
                    <div className="mb-2.5 flex items-center justify-between gap-2">
                      <span className="text-[12.5px] font-semibold text-[var(--ink-secondary)]">
                        仓库范围
                      </span>
                      {!isSelf && catalog.warehouses.length > 0 && (
                        <div className="flex items-center gap-2 text-[11.5px]">
                          <button
                            type="button"
                            disabled={isSavingThis}
                            onClick={() =>
                              handleSetAllWarehouses(
                                moduleId,
                                catalog.warehouses,
                              )
                            }
                            className="font-medium text-[var(--accent)] hover:underline cursor-pointer disabled:opacity-50"
                          >
                            全选
                          </button>
                          <button
                            type="button"
                            disabled={isSavingThis}
                            onClick={() =>
                              handleSetAllWarehouses(moduleId, [])
                            }
                            className="text-[var(--ink-muted)] hover:text-[var(--ink-primary)] cursor-pointer disabled:opacity-50"
                          >
                            清空
                          </button>
                        </div>
                      )}
                    </div>

                    <div className="flex flex-wrap gap-2">
                      {catalog.warehouses.map((wh) => {
                        const checked = draft.warehouses.includes(wh);
                        const whId = `wh-${moduleId}-${wh}`;
                        return (
                          <label
                            key={wh}
                            htmlFor={whId}
                            className={[
                              "relative inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 text-[13px] font-medium transition-all duration-[150ms] select-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--accent)] has-[:focus-visible]:ring-offset-1",
                              isSelf
                                ? "cursor-not-allowed opacity-65"
                                : "cursor-pointer",
                              checked
                                ? "bg-[var(--accent)] text-white shadow-[0_1px_3px_rgba(22,104,227,0.28)]"
                                : "bg-[var(--bg-surface-tint)] text-[var(--ink-secondary)] hover:bg-[var(--bg-surface-subtle)] hover:text-[var(--ink-primary)]",
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
                              className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
                            />
                            {checked && (
                              <Check
                                className="h-3.5 w-3.5 shrink-0"
                                strokeWidth={2.5}
                                aria-hidden="true"
                              />
                            )}
                            <span className="font-mono-code font-semibold">
                              {wh}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </div>

                  {/* Column 3: Localized Chinese Expiry Picker (Zero US mm/dd/yyyy Chrome) */}
                  <div className="lg:col-span-4">
                    <div className="mb-2.5 flex items-center justify-between gap-2">
                      <label
                        htmlFor={`expiry-${moduleId}`}
                        className="text-[12.5px] font-semibold text-[var(--ink-secondary)]"
                      >
                        有效期限
                      </label>
                      {hasExpiry && !isSelf && (
                        <button
                          type="button"
                          disabled={isSavingThis}
                          data-testid={`module-expiry-clear-${moduleId}`}
                          onClick={() => handleExpiryChange(moduleId, "")}
                          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium text-[var(--accent)] hover:bg-[var(--accent-wash)] transition-colors cursor-pointer disabled:opacity-50"
                        >
                          <X className="h-3 w-3" strokeWidth={1.85} />
                          <span>改为永久</span>
                        </button>
                      )}
                    </div>

                    <div className="space-y-2 rounded-tile bg-[var(--bg-surface-tint)] p-3">
                      {/* Quick Chinese Expiry Presets */}
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          disabled={isSelf || isSavingThis}
                          onClick={() => handleExpiryChange(moduleId, "")}
                          className={[
                            "rounded-full px-2.5 py-1 text-[11.5px] font-medium transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-55",
                            !hasExpiry
                              ? "bg-[var(--bg-surface)] text-[var(--ink-primary)] shadow-[var(--shadow-subtle)]"
                              : "text-[var(--ink-muted)] hover:text-[var(--ink-primary)] hover:bg-[var(--bg-surface)]/60",
                          ].join(" ")}
                        >
                          永久有效
                        </button>
                        <button
                          type="button"
                          disabled={isSelf || isSavingThis}
                          onClick={() =>
                            handleExpiryChange(
                              moduleId,
                              formatOffsetDaysLocalInput(7),
                            )
                          }
                          className="rounded-full px-2.5 py-1 text-[11.5px] font-medium text-[var(--ink-secondary)] hover:bg-[var(--bg-surface)] hover:text-[var(--accent)] transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-55"
                        >
                          7 天后到期
                        </button>
                        <button
                          type="button"
                          disabled={isSelf || isSavingThis}
                          onClick={() =>
                            handleExpiryChange(
                              moduleId,
                              formatOffsetDaysLocalInput(30),
                            )
                          }
                          className="rounded-full px-2.5 py-1 text-[11.5px] font-medium text-[var(--ink-secondary)] hover:bg-[var(--bg-surface)] hover:text-[var(--accent)] transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-55"
                        >
                          30 天后到期
                        </button>
                      </div>

                      {/* Clean Localized YYYY-MM-DD HH:MM Input */}
                      <div className="relative flex items-center">
                        <Clock
                          className="pointer-events-none absolute left-3 h-3.5 w-3.5 text-[var(--ink-muted)]"
                          strokeWidth={1.85}
                        />
                        <input
                          id={`expiry-${moduleId}`}
                          type="text"
                          inputMode="numeric"
                          lang="zh-CN"
                          value={draft.expiresAtInput}
                          disabled={isSelf || isSavingThis}
                          placeholder="留空即永久有效，或填 2026-12-31 18:00"
                          aria-invalid={
                            (feedback?.kind === "error" &&
                              feedback.message.includes("到期时间")) ||
                            undefined
                          }
                          data-testid={`module-expiry-${moduleId}`}
                          onChange={(e) =>
                            handleExpiryChange(moduleId, e.target.value)
                          }
                          className="h-9 w-full rounded-sm border border-[var(--hairline-strong)] bg-[var(--bg-surface)] pl-8.5 pr-3 font-mono-code text-[12px] text-[var(--ink-primary)] placeholder:font-sans placeholder:text-[var(--ink-faint)] tabular-nums focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-ring)] focus:outline-none transition-all disabled:cursor-not-allowed disabled:opacity-60"
                        />
                      </div>
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
                      "mt-4 flex items-start justify-between gap-3 rounded-tile px-3.5 py-2.5 text-[12.5px]",
                      feedback.kind === "success"
                        ? "bg-[var(--status-emerald-wash)] text-[var(--status-emerald)]"
                        : feedback.kind === "conflict"
                          ? "bg-[var(--status-amber-wash)] text-[var(--status-amber-ink)]"
                          : feedback.kind === "error"
                            ? "bg-[var(--status-crimson-wash)] text-[var(--status-crimson)]"
                            : "bg-[var(--accent-wash)] text-[var(--accent)]",
                    ].join(" ")}
                  >
                    <div className="flex items-start gap-2 min-w-0">
                      {feedback.kind === "success" ? (
                        <CheckCircle2
                          className="mt-0.5 h-4 w-4 shrink-0"
                          strokeWidth={1.85}
                        />
                      ) : feedback.kind === "info" ? (
                        <Info
                          className="mt-0.5 h-4 w-4 shrink-0"
                          strokeWidth={1.85}
                        />
                      ) : (
                        <AlertTriangle
                          className="mt-0.5 h-4 w-4 shrink-0"
                          strokeWidth={1.85}
                        />
                      )}
                      <div className="min-w-0 leading-relaxed">
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
                      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full opacity-70 hover:opacity-100 cursor-pointer"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}

                {/* Action Footer (Progressive disclosure: show full Revoke + Save pair only when dirty or explicitly configured) */}
                <div className="mt-5 flex flex-col gap-3 border-t border-[var(--hairline-subtle)] pt-3.5 sm:flex-row sm:items-center sm:justify-between">
                  <div className="text-[12px] text-[var(--ink-muted)] tabular-nums">
                    {persisted
                      ? `第 ${persisted.version} 版配置${savedAt ? ` · 已保存 ${formatUnixTime(savedAt, { withSeconds: true }).slice(11)}` : ""}`
                      : "尚未单独配置"}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {showExplicitActions ? (
                      <>
                        <Button
                          size="sm"
                          pill
                          variant="danger"
                          disabled={isSelf || isSavingThis || isAlreadyRevoked}
                          data-testid={`module-revoke-${moduleId}`}
                          onClick={() => setRevokeTargetModule(moduleId)}
                        >
                          <ShieldOff
                            className="h-3.5 w-3.5"
                            strokeWidth={1.85}
                          />
                          <span>
                            {isAlreadyRevoked
                              ? "已撤销此模块"
                              : "撤销该模块权限"}
                          </span>
                        </Button>

                        <Button
                          size="sm"
                          pill
                          variant="primary"
                          loading={
                            isSavingThis && revokeTargetModule !== moduleId
                          }
                          disabled={isSelf || isSavingThis}
                          data-testid={`module-save-${moduleId}`}
                          onClick={() => void handleSaveModule(moduleId)}
                        >
                          <Save className="h-3.5 w-3.5" strokeWidth={1.85} />
                          <span>保存授权</span>
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        pill
                        variant="ghost"
                        disabled={isSelf || isSavingThis}
                        data-testid={`module-revoke-${moduleId}`}
                        onClick={() => setRevokeTargetModule(moduleId)}
                      >
                        <ShieldOff className="h-3.5 w-3.5" strokeWidth={1.85} />
                        <span>停用此模块</span>
                      </Button>
                    )}
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
        description="撤销后将清空该员工此模块的动作与仓库配置，生效后立即阻断相关查询及待派发提案。"
        scopeSummary={`租户 ${actor?.tenant ?? "—"} · 目标员工 ${subject} · 模块 ${revokeModuleMeta?.title ?? ""}`}
        metadata={[
          { label: "目标员工", value: subject, mono: true },
          {
            label: "目标模块",
            value: revokeModuleMeta?.title ?? revokeTargetModule ?? "—",
          },
          {
            label: "当前配置版本",
            value:
              revokeCurrentVersion > 0
                ? `第 ${revokeCurrentVersion} 版`
                : "首次配置",
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
