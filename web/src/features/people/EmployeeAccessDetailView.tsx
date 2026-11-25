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
import { sortWarehouses } from "@/lib/format";
import {
  LOCALE_META,
  useLocale,
  type LocaleVars,
  type TrilingualText,
} from "@/lib/i18n";
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
  getGrantLabel,
  getLocalTimezoneLabel,
  getModuleMeta,
  GRANT_PREREQUISITES,
  localInputToUnixSeconds,
  MAX_EXPIRES_AT_UNIX,
  sortCatalogModuleIds,
  sortGrantsByDependency,
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
  text?: TrilingualText;
  vars?: LocaleVars;
  apiError?: ApiError;
  requestId?: string | null;
  field?: "expiry";
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
  const {
    locale,
    t,
    tx,
    formatDateTime,
    formatTimeOnly,
    localizePersona,
    localizeError,
  } = useLocale();

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
  const [mounted, setMounted] = useState(false);

  const isSelf = actor?.subject === subject;
  const persona = useMemo(
    () => localizePersona(subject),
    [localizePersona, subject],
  );
  const hasDistinctName =
    persona.displayName.trim() !== "" && persona.displayName !== subject;

  useEffect(() => {
    setMounted(true);
    const timer = window.setInterval(() => {
      setNowUnix(Math.floor(Date.now() / 1000));
    }, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const localTzLabel = useMemo(
    () =>
      mounted
        ? getLocalTimezoneLabel(locale)
        : tx({ "zh-CN": "本地时间", "zh-HK": "本地時間", en: "Local time" }),
    [mounted, locale, tx],
  );

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

  const sortedCatalogWarehouses = useMemo(
    () => (catalog?.warehouses.length ? sortWarehouses(catalog.warehouses) : []),
    [catalog],
  );

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
      let infoText: TrilingualText | null = null;

      if (checked) {
        nextSet.add(grant);
        const requiredRead = GRANT_PREREQUISITES[grant];
        if (requiredRead && !nextSet.has(requiredRead)) {
          nextSet.add(requiredRead);
          infoText = {
            "zh-CN": `已自动勾选前置读取权限「${getGrantLabel(requiredRead, "zh-CN")}」（「${getGrantLabel(grant, "zh-CN")}」依赖对应读取权限）。`,
            "zh-HK": `已自動勾選前置讀取權限「${getGrantLabel(requiredRead, "zh-HK")}」（「${getGrantLabel(grant, "zh-HK")}」依賴對應讀取權限）。`,
            en: `Automatically selected required read permission “${getGrantLabel(requiredRead, "en")}” (“${getGrantLabel(grant, "en")}” requires read access).`,
          };
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
          infoText = {
            "zh-CN": `取消「${getGrantLabel(grant, "zh-CN")}」后已同步取消依赖它的写入权限（${removed.map((g) => getGrantLabel(g, "zh-CN")).join("、")}）。`,
            "zh-HK": `取消「${getGrantLabel(grant, "zh-HK")}」後已同步取消依賴它的寫入權限（${removed.map((g) => getGrantLabel(g, "zh-HK")).join("、")}）。`,
            en: `Unchecking “${getGrantLabel(grant, "en")}” also removed dependent write permissions (${removed.map((g) => getGrantLabel(g, "en")).join(", ")}).`,
          };
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
      if (infoText) {
        setModuleFeedback(moduleId, { kind: "info", text: infoText });
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
        text: {
          "zh-CN":
            "配置已被其他管理员更新，已刷新最新状态，请核对后重新提交。",
          "zh-HK":
            "設定已被其他管理員更新，已重新整理最新狀態，請核對後重新提交。",
          en: "Assignment was updated by another administrator. Latest state reloaded — review and submit again.",
        },
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

      const personalScope = catalog?.modules[moduleId]?.scope === "personal";
      // Client-side validation matching backend ModuleAccess.put
      if (!personalScope && draft.grants.length === 0 && draft.warehouses.length === 0) {
        setModuleFeedback(moduleId, {
          kind: "error",
          text: {
            "zh-CN":
              "授予权限时必须至少选择一项动作与一个仓库；如需撤销此模块权限，请点击「撤销该模块权限」。",
            "zh-HK":
              "授予權限時必須至少選擇一項操作與一個倉庫；如需撤銷此模組權限，請點擊「撤銷該模組權限」。",
            en: "Select at least one action and one warehouse to grant access; to revoke this module, click “Revoke Module”.",
          },
        });
        return;
      }
      if (personalScope && draft.grants.length === 0) {
        setModuleFeedback(moduleId, {
          kind: "error",
          text: {
            "zh-CN": "请选择要开放给员工的操作，或撤销该模块权限。",
            "zh-HK": "請選擇要開放給員工的操作，或撤銷此模組權限。",
            en: "Select an action or revoke the module.",
          },
        });
        return;
      }
      if (!personalScope && (draft.grants.length === 0 || draft.warehouses.length === 0)) {
        setModuleFeedback(moduleId, {
          kind: "error",
          text: {
            "zh-CN":
              "授予模块权限时，必须同时选择至少一项动作权限与至少一个仓库。",
            "zh-HK":
              "授予模組權限時，必須同時選擇至少一項操作權限與至少一個倉庫。",
            en: "Select at least one action grant and at least one warehouse together.",
          },
        });
        return;
      }

      for (const g of draft.grants) {
        const req = GRANT_PREREQUISITES[g];
        if (req && !draft.grants.includes(req)) {
          setModuleFeedback(moduleId, {
            kind: "error",
            text: {
              "zh-CN": `「${getGrantLabel(g, "zh-CN")}」依赖前置读取权限「${getGrantLabel(req, "zh-CN")}」，请同时勾选后再保存。`,
              "zh-HK": `「${getGrantLabel(g, "zh-HK")}」依賴前置讀取權限「${getGrantLabel(req, "zh-HK")}」，請同時勾選後再儲存。`,
              en: `“${getGrantLabel(g, "en")}” requires read permission “${getGrantLabel(req, "en")}”. Select both before saving.`,
            },
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
            field: "expiry",
            text: {
              "zh-CN":
                "到期时间格式需为 YYYY-MM-DD HH:MM，且必须晚于当前本地时间（不超过 2100 年）。",
              "zh-HK":
                "到期時間格式須為 YYYY-MM-DD HH:MM，且必須晚於目前本地時間（不超過 2100 年）。",
              en: "Expiration must use YYYY-MM-DD HH:MM in local time and be in the future (up to year 2100).",
            },
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
          warehouses: personalScope ? [] : draft.warehouses,
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
          text: {
            "zh-CN": "已保存模块授权（第 {version} 版配置）。",
            "zh-HK": "已儲存模組授權（第 {version} 版設定）。",
            en: "Module access saved (Rev {version}).",
          },
          vars: { version: saved.version },
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
              apiError: err,
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
      catalog,
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
        text: {
          "zh-CN":
            "已撤销此模块权限（第 {version} 版配置），相关查询与待派发提案已阻断。",
          "zh-HK":
            "已撤銷此模組權限（第 {version} 版設定），相關查詢與待派發提案已阻斷。",
          en: "Module access revoked (Rev {version}). Related queries and queued proposals are now blocked.",
        },
        vars: { version: saved.version },
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
            apiError: err,
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

  const revokeModuleMeta = revokeTargetModule
    ? getModuleMeta(revokeTargetModule, 0, locale)
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
          <span>
            {tx({
              "zh-CN": "返回员工目录",
              "zh-HK": "返回員工目錄",
              en: "Back to Directory",
            })}
          </span>
        </Link>
      </div>

      {/* Unified Porcelain / Obsidian Employee Header Sheet */}
      <section className="rounded-card border border-[var(--hairline)] bg-[var(--bg-surface)] shadow-[var(--shadow-card)] p-5 sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4 min-w-0">
            <Avatar
              fallbackText={persona.displayName}
              name={persona.displayName}
              size="lg"
              kind="user"
            />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                {hasDistinctName ? (
                  <>
                    <h1 className="aios-display text-[20px] font-semibold text-[var(--ink-primary)] leading-tight">
                      {persona.displayName}
                    </h1>
                    <span
                      data-testid="employee-detail-subject"
                      className="inline-flex items-center rounded-xs border border-[var(--hairline)] bg-[var(--bg-surface-tint)] px-2 py-0.5 font-mono-code text-[12px] font-medium text-[var(--ink-secondary)]"
                    >
                      {subject}
                    </span>
                  </>
                ) : (
                  <h1
                    className="aios-display text-[20px] font-semibold text-[var(--ink-primary)] break-all leading-tight"
                    data-testid="employee-detail-subject"
                  >
                    {subject}
                  </h1>
                )}
                {isSelf && (
                  <span className="inline-flex items-center rounded-full bg-[var(--status-amber-wash)] px-2.5 py-0.5 text-[11.5px] font-medium text-[var(--status-amber-ink)]">
                    {tx({
                      "zh-CN": "本人账号 · 只读",
                      "zh-HK": "本人帳號 · 唯讀",
                      en: "Your Account · Read-Only",
                    })}
                  </span>
                )}
              </div>
              <p className="mt-1 text-[12.5px] text-[var(--ink-muted)] tabular-nums">
                <span className="font-mono-code">{actor?.tenant ?? "—"}</span>
                <span className="mx-1.5 text-[var(--ink-faint)]">·</span>
                <span>
                  {tx({
                    "zh-CN": "可管理仓库",
                    "zh-HK": "可管理倉庫",
                    en: "Managed warehouses",
                  })}{" "}
                  <span className="font-mono-code text-[var(--ink-secondary)]">
                    {sortedCatalogWarehouses.length > 0
                      ? sortedCatalogWarehouses.join(" / ")
                      : "—"}
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
              <span>
                {tx({
                  "zh-CN": "刷新最新配置",
                  "zh-HK": "重新整理最新設定",
                  en: "Refresh Config",
                })}
              </span>
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
                {tx({
                  "zh-CN": "管理员不能修改自己的模块授权。",
                  "zh-HK": "管理員不能修改自己的模組授權。",
                  en: "Administrators cannot modify their own module access.",
                })}
              </span>
              <span className="ml-1 text-[var(--ink-secondary)]">
                {tx({
                  "zh-CN":
                    "所有编辑、保存与撤销操作均已禁用，请由其他具备全仓库权限的管理员协助调整。",
                  "zh-HK":
                    "所有編輯、儲存與撤銷操作均已停用，請由其他具備全倉庫權限的管理員協助調整。",
                  en: "All editing, saving, and revocation controls are disabled. Ask another all-warehouse access administrator to make changes.",
                })}
              </span>
            </div>
          </div>
        )}

        {/* Single Page-Level Scope & Expiry Explanation (Shown ONCE per page, never repeated per card) */}
        <p
          data-testid="scope-intersection-note"
          className="mt-4 border-t border-[var(--hairline-subtle)] pt-3.5 text-[12px] text-[var(--ink-muted)] leading-relaxed"
        >
          {tx(
            {
              "zh-CN":
                "实际生效范围取「模块显式配置」与「员工身份已验证仓库」的交集，未单独配置的模块沿用默认权限；到期时间留空即永久有效（按{tz}计算，格式 ",
              "zh-HK":
                "實際生效範圍取「模組顯式設定」與「員工身份已驗證倉庫」的交集，未單獨設定的模組沿用預設權限；到期時間留空即永久有效（按{tz}計算，格式 ",
              en: "Effective access is the intersection of explicit module settings and the employee's verified identity warehouses; unconfigured modules inherit default grants. Leave expiry blank for no expiry (in {tz}, format ",
            },
            { tz: localTzLabel },
          )}
          <span className="font-mono-code text-[var(--ink-secondary)]">
            YYYY-MM-DD HH:MM
          </span>
          {tx({ "zh-CN": "）。", "zh-HK": "）。", en: ")." })}
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
          backLabel={tx({
            "zh-CN": "返回员工目录",
            "zh-HK": "返回員工目錄",
            en: "Back to Directory",
          })}
        />
      )}

      {loading && !catalog && !loadError && (
        <div className="rounded-card bg-[var(--bg-surface)] shadow-[var(--shadow-card)] px-6 py-14 text-center text-[13px] text-[var(--ink-muted)]">
          {tx({
            "zh-CN": "正在加载员工模块授权快照…",
            "zh-HK": "正在載入員工模組授權快照…",
            en: "Loading employee module assignments…",
          })}
        </div>
      )}

      {/* 5 Elevated Module Sheets (NO 3D tilt on input/checkbox edit cards) */}
      {catalog && !loadError && (
        <div className="space-y-4">
          {moduleIds.map((moduleId, idx) => {
            const spec = catalog.modules[moduleId]!;
            const personalScope = spec.scope === "personal";
            const orderedSpecGrants = sortGrantsByDependency(
              spec.grants,
              spec.grants,
            );
            const meta = getModuleMeta(moduleId, idx, locale);
            const persisted = assignments[moduleId];
            const orderedPersistedGrants = persisted
              ? sortGrantsByDependency(persisted.grants, spec.grants)
              : [];
            const orderedPersistedWarehouses = persisted
              ? sortWarehouses(persisted.warehouses)
              : [];
            const stateInfo = classifyModuleAssignment(
              persisted,
              nowUnix,
              locale,
            );
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
                className="rounded-card border border-[var(--hairline)] bg-[var(--bg-surface)] shadow-[var(--shadow-card)] p-5 sm:p-6"
              >
                {/* Module Card Header (raw module slug tucked into title tooltip) */}
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <h2
                        title={tx(
                          {
                            "zh-CN": "模块标识：{id}",
                            "zh-HK": "模組識別碼：{id}",
                            en: "Module ID: {id}",
                          },
                          { id: moduleId },
                        )}
                        className="aios-display text-[16px] font-semibold text-[var(--ink-primary)]"
                      >
                        {meta.title}
                      </h2>
                      {dirty && !isSelf && (
                        <span className="inline-flex items-center rounded-full bg-[var(--status-amber-wash)] px-2.5 py-0.5 text-[11px] font-medium text-[var(--status-amber-ink)]">
                          {tx({
                            "zh-CN": "未保存修改",
                            "zh-HK": "未儲存修改",
                            en: "Unsaved",
                          })}
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
                          ? tx(
                              {
                                "zh-CN": "当前为第 {version} 版配置 (v{version})",
                                "zh-HK": "目前為第 {version} 版設定 (v{version})",
                                en: "Revision {version} (v{version})",
                              },
                              { version: persistedVersion },
                            )
                          : tx({
                              "zh-CN": "尚未单独配置 (v0)",
                              "zh-HK": "尚未單獨設定 (v0)",
                              en: "Not explicitly configured yet (v0)",
                            })
                      }
                      className="inline-flex items-center rounded-full bg-[var(--bg-surface-subtle)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--ink-secondary)] tabular-nums leading-none"
                    >
                      {persisted
                        ? tx(
                            {
                              "zh-CN": "第 {version} 版",
                              "zh-HK": "第 {version} 版",
                              en: "Rev {version}",
                            },
                            { version: persistedVersion },
                          )
                        : tx({
                            "zh-CN": "首次配置",
                            "zh-HK": "首次設定",
                            en: "Default",
                          })}
                    </span>
                  </div>
                </div>

                {/* Role Constraint Notice (e.g., approvals -> manager/admin only) */}
                {spec.roles && spec.roles.length > 0 && (
                  <div className="mt-4 rounded-tile bg-[var(--status-amber-wash)] px-3.5 py-2.5 text-[12.5px] text-[var(--status-amber-ink)] leading-relaxed">
                    <span className="font-semibold">
                      {tx({
                        "zh-CN": "角色约束：",
                        "zh-HK": "角色約束：",
                        en: "Role constraint: ",
                      })}
                    </span>
                    {tx({
                      "zh-CN":
                        "仅当员工角色为主管或管理员时此模块授权才会生效；配置审批仓库后可独立于经办写入权限生效。",
                      "zh-HK":
                        "僅當員工角色為主管或管理員時此模組授權才會生效；設定審批倉庫後可獨立於經辦寫入權限生效。",
                      en: "Takes effect only when the employee's role is Manager or Admin. Configured approval warehouses apply independently of operator write permissions.",
                    })}
                  </div>
                )}

                {/* Concise Persisted Snapshot Strip (shown ONLY when explicitly configured — zero inherited repetition) */}
                {persisted && (
                  <dl className="mt-4 grid grid-cols-1 gap-3 rounded-tile bg-[var(--bg-surface-tint)] px-4 py-3 text-[12px] sm:grid-cols-3">
                    <div>
                      <dt className="text-[11px] text-[var(--ink-muted)]">
                        {tx({
                          "zh-CN": "已保存动作",
                          "zh-HK": "已儲存操作",
                          en: "Saved Actions",
                        })}
                      </dt>
                      <dd
                        title={
                          orderedPersistedGrants.join(", ") ||
                          tx({ "zh-CN": "空", "zh-HK": "空", en: "None" })
                        }
                        className="mt-0.5 font-medium text-[var(--ink-primary)]"
                      >
                        {orderedPersistedGrants.length === 0
                          ? tx({
                              "zh-CN": "已清空（已撤销）",
                              "zh-HK": "已清空（已撤銷）",
                              en: "Cleared (Revoked)",
                            })
                          : orderedPersistedGrants
                              .map((g) => getGrantLabel(g, locale))
                              .join(locale === "en" ? ", " : "、")}
                      </dd>
                    </div>
                    {!personalScope && (
                    <div>
                      <dt className="text-[11px] text-[var(--ink-muted)]">
                        {tx({
                          "zh-CN": "已保存仓库",
                          "zh-HK": "已儲存倉庫",
                          en: "Saved Warehouses",
                        })}
                      </dt>
                      <dd
                        className={[
                          "mt-0.5 text-[12px] font-medium text-[var(--ink-primary)]",
                          orderedPersistedWarehouses.length > 0
                            ? "font-mono-code"
                            : "",
                        ].join(" ")}
                      >
                        {orderedPersistedWarehouses.length === 0
                          ? tx({
                              "zh-CN": "已清空（已撤销）",
                              "zh-HK": "已清空（已撤銷）",
                              en: "Cleared (Revoked)",
                            })
                          : orderedPersistedWarehouses.join(" · ")}
                      </dd>
                    </div>
                    )}
                    <div>
                      <dt className="text-[11px] text-[var(--ink-muted)]">
                        {tx(
                          {
                            "zh-CN": "到期时间（{tz}）",
                            "zh-HK": "到期時間（{tz}）",
                            en: "Expiration ({tz})",
                          },
                          { tz: localTzLabel },
                        )}
                      </dt>
                      <dd className="mt-0.5 text-[12px] text-[var(--ink-primary)] tabular-nums">
                        {persisted.expires_at ? (
                          <>
                            <span className="font-mono-code">
                              {formatDateTime(persisted.expires_at)}
                            </span>
                            {stateInfo.status === "expired" && (
                              <span>
                                {tx({
                                  "zh-CN": "（已到期）",
                                  "zh-HK": "（已到期）",
                                  en: " (Expired)",
                                })}
                              </span>
                            )}
                          </>
                        ) : persisted.grants.length === 0 ? (
                          tx({
                            "zh-CN": "不适用",
                            "zh-HK": "不適用",
                            en: "N/A",
                          })
                        ) : (
                          tx({
                            "zh-CN": "永久有效",
                            "zh-HK": "永久有效",
                            en: "No Expiry",
                          })
                        )}
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
                        {tx({
                          "zh-CN": "动作权限",
                          "zh-HK": "操作權限",
                          en: "Action Grants",
                        })}
                      </span>
                      <span className="text-[11.5px] text-[var(--ink-muted)] tabular-nums">
                        {tx(
                          {
                            "zh-CN": "已选 {selected} / {total}",
                            "zh-HK": "已選 {selected} / {total}",
                            en: "{selected} / {total} selected",
                          },
                          {
                            selected: draft.grants.length,
                            total: orderedSpecGrants.length,
                          },
                        )}
                      </span>
                    </div>
                    <div className="space-y-2">
                      {orderedSpecGrants.map((grant) => {
                        const checked = draft.grants.includes(grant);
                        const grantLabel = getGrantLabel(grant, locale);
                        const reqGrant = GRANT_PREREQUISITES[grant];
                        const reqLabel = reqGrant
                          ? getGrantLabel(reqGrant, locale)
                          : null;
                        const checkboxId = `grant-${moduleId}-${grant}`;
                        return (
                          <label
                            key={grant}
                            htmlFor={checkboxId}
                            title={tx(
                              {
                                "zh-CN": "权限编码：{grant}",
                                "zh-HK": "權限編碼：{grant}",
                                en: "Grant code: {grant}",
                              },
                              { grant },
                            )}
                            className={[
                              "flex items-center gap-3 rounded-tile px-3.5 py-2.5 transition-all duration-[150ms] select-none",
                              isSelf
                                ? "cursor-not-allowed opacity-65"
                                : "cursor-pointer",
                              checked
                                ? "bg-[var(--accent-wash)] ring-1 ring-[var(--accent-border)]"
                                : "bg-[var(--bg-surface-tint)] hover:bg-[var(--bg-surface-hover)]",
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
                                  "pointer-events-none flex h-4.5 w-4.5 items-center justify-center rounded-xs transition-all duration-[150ms] peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--accent)] peer-focus-visible:ring-offset-1 peer-focus-visible:ring-offset-[var(--bg-surface)]",
                                  checked
                                    ? "bg-[var(--accent-solid)] text-[var(--accent-fg)] shadow-[0_1px_2px_var(--accent-ring)]"
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
                                {grantLabel}
                              </div>
                              {reqLabel && (
                                <div className="mt-0.5 text-[11px] text-[var(--ink-muted)]">
                                  {tx(
                                    {
                                      "zh-CN": "需先具备「{req}」",
                                      "zh-HK": "須先具備「{req}」",
                                      en: "Requires “{req}”",
                                    },
                                    { req: reqLabel },
                                  )}
                                </div>
                              )}
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </div>

                  {personalScope ? (
                    <div className="lg:col-span-3">
                      <span className="text-[12.5px] font-semibold text-[var(--ink-secondary)]">
                        {tx({ "zh-CN": "员工范围", "zh-HK": "員工範圍", en: "Employee scope" })}
                      </span>
                      <p className="mt-2 text-[12px] text-[var(--ink-muted)]">
                        {tx({
                          "zh-CN": "授权仅适用于当前员工在本企业的 Agent。",
                          "zh-HK": "授權僅適用於目前員工在本企業的 Agent。",
                          en: "This permission applies to this employee's Agent in this organization.",
                        })}
                      </p>
                    </div>
                  ) : (
                  <div className="lg:col-span-3">
                    <div className="mb-2.5 flex items-center justify-between gap-2">
                      <span className="text-[12.5px] font-semibold text-[var(--ink-secondary)]">
                        {tx({
                          "zh-CN": "仓库范围",
                          "zh-HK": "倉庫範圍",
                          en: "Warehouse Scope",
                        })}
                      </span>
                      {!isSelf && sortedCatalogWarehouses.length > 0 && (
                        <div className="flex items-center gap-2 text-[11.5px]">
                          <button
                            type="button"
                            disabled={isSavingThis}
                            onClick={() =>
                              handleSetAllWarehouses(
                                moduleId,
                                sortedCatalogWarehouses,
                              )
                            }
                            className="font-medium text-[var(--accent)] hover:underline cursor-pointer disabled:opacity-50"
                          >
                            {tx({
                              "zh-CN": "全选",
                              "zh-HK": "全選",
                              en: "All",
                            })}
                          </button>
                          <button
                            type="button"
                            disabled={isSavingThis}
                            onClick={() =>
                              handleSetAllWarehouses(moduleId, [])
                            }
                            className="text-[var(--ink-muted)] hover:text-[var(--ink-primary)] cursor-pointer disabled:opacity-50"
                          >
                            {tx({
                              "zh-CN": "清空",
                              "zh-HK": "清空",
                              en: "Clear",
                            })}
                          </button>
                        </div>
                      )}
                    </div>

                    <div className="flex flex-wrap gap-2">
                      {sortedCatalogWarehouses.map((wh) => {
                        const checked = draft.warehouses.includes(wh);
                        const whId = `wh-${moduleId}-${wh}`;
                        return (
                          <label
                            key={wh}
                            htmlFor={whId}
                            className={[
                              "relative inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 text-[13px] font-medium transition-all duration-[150ms] select-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--accent)] has-[:focus-visible]:ring-offset-1 has-[:focus-visible]:ring-offset-[var(--bg-surface)]",
                              isSelf
                                ? "cursor-not-allowed opacity-65"
                                : "cursor-pointer",
                              checked
                                ? "bg-[var(--accent-solid)] text-[var(--accent-fg)] shadow-[0_1px_3px_var(--accent-ring)] hover:bg-[var(--accent-solid-hover)]"
                                : "bg-[var(--bg-surface-tint)] text-[var(--ink-secondary)] ring-1 ring-[var(--hairline)] hover:bg-[var(--bg-surface-hover)] hover:text-[var(--ink-primary)]",
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

                  )}

                  {/* Column 3: Localized Expiry Picker (Zero US mm/dd/yyyy Chrome) */}
                  <div className="lg:col-span-4">
                    <div className="mb-2.5 flex items-center justify-between gap-2">
                      <label
                        htmlFor={`expiry-${moduleId}`}
                        className="text-[12.5px] font-semibold text-[var(--ink-secondary)]"
                      >
                        {tx({
                          "zh-CN": "有效期限",
                          "zh-HK": "有效期限",
                          en: "Expiration",
                        })}
                      </label>
                      {hasExpiry && !isSelf && (
                        <button
                          type="button"
                          disabled={isSavingThis}
                          data-testid={`module-expiry-clear-${moduleId}`}
                          onClick={() => handleExpiryChange(moduleId, "")}
                          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium text-[var(--accent-ink)] hover:bg-[var(--accent-wash)] transition-colors cursor-pointer disabled:opacity-50"
                        >
                          <X className="h-3 w-3" strokeWidth={1.85} />
                          <span>
                            {tx({
                              "zh-CN": "改为永久",
                              "zh-HK": "改為永久",
                              en: "Remove expiry",
                            })}
                          </span>
                        </button>
                      )}
                    </div>

                    <div className="space-y-2 rounded-tile bg-[var(--bg-surface-tint)] p-3">
                      {/* Quick Expiry Presets */}
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          disabled={isSelf || isSavingThis}
                          onClick={() => handleExpiryChange(moduleId, "")}
                          className={[
                            "rounded-full px-2.5 py-1 text-[11.5px] font-medium transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-55",
                            !hasExpiry
                              ? "bg-[var(--bg-surface)] text-[var(--ink-primary)] shadow-[var(--shadow-subtle)] ring-1 ring-[var(--hairline-strong)]"
                              : "text-[var(--ink-muted)] hover:text-[var(--ink-primary)] hover:bg-[var(--bg-surface-hover)]",
                          ].join(" ")}
                        >
                          {tx({
                            "zh-CN": "永久有效",
                            "zh-HK": "永久有效",
                            en: "No Expiry",
                          })}
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
                          {tx({
                            "zh-CN": "7 天后到期",
                            "zh-HK": "7 天後到期",
                            en: "+7 Days",
                          })}
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
                          {tx({
                            "zh-CN": "30 天后到期",
                            "zh-HK": "30 天後到期",
                            en: "+30 Days",
                          })}
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
                          lang={LOCALE_META[locale].htmlLang}
                          value={draft.expiresAtInput}
                          disabled={isSelf || isSavingThis}
                          placeholder={tx({
                            "zh-CN": "留空即永久有效，或填 2026-12-31 18:00",
                            "zh-HK": "留空即永久有效，或填 2026-12-31 18:00",
                            en: "Blank for no expiry, or 2026-12-31 18:00",
                          })}
                          aria-invalid={
                            (feedback?.kind === "error" &&
                              feedback.field === "expiry") ||
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
                            : "bg-[var(--accent-wash)] text-[var(--accent-ink)]",
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
                        <span>
                          {feedback.apiError
                            ? localizeError(feedback.apiError)
                            : feedback.text
                              ? tx(feedback.text, feedback.vars)
                              : ""}
                        </span>
                        {feedback.requestId && (
                          <span className="ml-2 text-[11px] opacity-85">
                            {t("common.requestId")}:{" "}
                            <span className="font-mono-code">
                              {feedback.requestId}
                            </span>
                          </span>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setModuleFeedback(moduleId, null)}
                      aria-label={tx({
                        "zh-CN": "关闭提示",
                        "zh-HK": "關閉提示",
                        en: "Dismiss notice",
                      })}
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
                      ? savedAt
                        ? tx(
                            {
                              "zh-CN": "第 {version} 版配置 · 已保存 {time}",
                              "zh-HK": "第 {version} 版設定 · 已儲存 {time}",
                              en: "Rev {version} · Saved {time}",
                            },
                            {
                              version: persisted.version,
                              time: formatTimeOnly(savedAt, {
                                withSeconds: true,
                              }),
                            },
                          )
                        : tx(
                            {
                              "zh-CN": "第 {version} 版配置",
                              "zh-HK": "第 {version} 版設定",
                              en: "Rev {version}",
                            },
                            { version: persisted.version },
                          )
                      : tx({
                          "zh-CN": "尚未单独配置",
                          "zh-HK": "尚未單獨設定",
                          en: "Not configured yet",
                        })}
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
                              ? tx({
                                  "zh-CN": "已撤销此模块",
                                  "zh-HK": "已撤銷此模組",
                                  en: "Module Revoked",
                                })
                              : tx({
                                  "zh-CN": "撤销该模块权限",
                                  "zh-HK": "撤銷該模組權限",
                                  en: "Revoke Module",
                                })}
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
                          <span>
                            {tx({
                              "zh-CN": "保存授权",
                              "zh-HK": "儲存授權",
                              en: "Save Access",
                            })}
                          </span>
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
                        <span>
                          {tx({
                            "zh-CN": "停用此模块",
                            "zh-HK": "停用此模組",
                            en: "Disable Module",
                          })}
                        </span>
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
            ? tx(
                {
                  "zh-CN": "确认撤销「{title}」模块权限",
                  "zh-HK": "確認撤銷「{title}」模組權限",
                  en: "Confirm Revoking “{title}” Access",
                },
                { title: revokeModuleMeta.title },
              )
            : tx({
                "zh-CN": "确认撤销模块权限",
                "zh-HK": "確認撤銷模組權限",
                en: "Confirm Module Revocation",
              })
        }
        description={tx({
          "zh-CN":
            "撤销后将清空该员工此模块的动作与仓库配置，生效后立即阻断相关查询及待派发提案。",
          "zh-HK":
            "撤銷後將清空該員工此模組的操作與倉庫設定，生效後立即阻斷相關查詢及待派發提案。",
          en: "Revoking clears all action grants and warehouse scopes for this module, immediately blocking related queries and queued proposals.",
        })}
        scopeSummary={tx(
          {
            "zh-CN": "租户 {tenant} · 目标员工 {subject} · 模块 {module}",
            "zh-HK": "租戶 {tenant} · 目標員工 {subject} · 模組 {module}",
            en: "Tenant {tenant} · Employee {subject} · Module {module}",
          },
          {
            tenant: actor?.tenant ?? "—",
            subject,
            module: revokeModuleMeta?.title ?? "",
          },
        )}
        metadata={[
          {
            label: tx({
              "zh-CN": "目标员工",
              "zh-HK": "目標員工",
              en: "Target Employee",
            }),
            value: hasDistinctName
              ? `${persona.displayName} (${subject})`
              : subject,
          },
          {
            label: tx({
              "zh-CN": "目标模块",
              "zh-HK": "目標模組",
              en: "Target Module",
            }),
            value: revokeModuleMeta?.title ?? revokeTargetModule ?? "—",
          },
          {
            label: tx({
              "zh-CN": "当前配置版本",
              "zh-HK": "目前設定版本",
              en: "Current Revision",
            }),
            value:
              revokeCurrentVersion > 0
                ? tx(
                    {
                      "zh-CN": "第 {version} 版",
                      "zh-HK": "第 {version} 版",
                      en: "Rev {version}",
                    },
                    { version: revokeCurrentVersion },
                  )
                : tx({
                    "zh-CN": "首次配置",
                    "zh-HK": "首次設定",
                    en: "Default",
                  }),
          },
        ]}
        confirmLabel={tx({
          "zh-CN": "确认撤销权限",
          "zh-HK": "確認撤銷權限",
          en: "Confirm Revoke",
        })}
        cancelLabel={t("common.cancel")}
        dialogTestId="revoke-confirm-dialog"
        confirmTestId="confirm-dialog-submit"
        onConfirm={handleConfirmRevoke}
      />
    </div>
  );
}
