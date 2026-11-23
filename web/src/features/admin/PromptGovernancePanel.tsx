"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Lock,
  Play,
  RefreshCw,
  ShieldCheck,
  Sliders,
} from "lucide-react";
import { isApiError, isStaleAuthError, type ApiError } from "@/lib/api-client";
import { useLocale, type TrilingualText } from "@/lib/i18n";
import { useSession } from "@/lib/session-context";
import { AccessNoticeCard, Button } from "@/components/ui";
import {
  fetchPromptPolicies,
  simulatePromptPolicy,
} from "@/features/admin/api";
import type {
  PromptPolicyEntry,
  PromptScopeKey,
  PromptSimulateResponse,
} from "@/lib/types";

const SCOPE_ORDER: readonly PromptScopeKey[] = [
  "general",
  "orders",
  "dispatch",
  "invoice-review",
  "warehouse-insights",
  "approvals",
  "mail-outbox",
  "calendar-meetings",
];

const SCOPE_LABELS: Record<PromptScopeKey, TrilingualText> = {
  general: {
    "zh-CN": "通用助手与工作提醒",
    "zh-HK": "通用助手與工作提醒",
    en: "General Assistant & Brief",
  },
  orders: {
    "zh-CN": "销售订单与接单",
    "zh-HK": "銷售訂單與接單",
    en: "Sales Orders & Intake",
  },
  dispatch: {
    "zh-CN": "运单调度与改期",
    "zh-HK": "運單調度與改期",
    en: "Dispatch & Shipments",
  },
  "invoice-review": {
    "zh-CN": "发票与财务审阅",
    "zh-HK": "發票與財務審閱",
    en: "Invoice & Finance Review",
  },
  "warehouse-insights": {
    "zh-CN": "仓储决策洞察",
    "zh-HK": "倉儲決策洞察",
    en: "Warehouse Insights",
  },
  approvals: {
    "zh-CN": "独立审批与复核",
    "zh-HK": "獨立審批與覆核",
    en: "Independent Approvals",
  },
  "mail-outbox": {
    "zh-CN": "企业邮件与发信草稿",
    "zh-HK": "企業郵件與發信草稿",
    en: "Enterprise Mail & Outbox",
  },
  "calendar-meetings": {
    "zh-CN": "内部日程与会议",
    "zh-HK": "內部日程與會議",
    en: "Calendar & Meetings",
  },
};

const MODULE_SIM_GRANTS: Record<
  Exclude<PromptScopeKey, "general">,
  string[]
> = {
  orders: ["order.read", "order.work"],
  dispatch: ["shipment.read", "shipment.reschedule"],
  "invoice-review": ["finance.read"],
  "warehouse-insights": ["decision.read"],
  approvals: ["workbench.approve.orders", "workbench.approve.shipments"],
  "mail-outbox": ["mail.read"],
  "calendar-meetings": [],
};

const SIM_MODULE_SCOPES: readonly Exclude<PromptScopeKey, "general">[] = [
  "orders",
  "dispatch",
  "invoice-review",
  "warehouse-insights",
  "approvals",
  "mail-outbox",
  "calendar-meetings",
];

type SimRole = "viewer" | "operator" | "manager" | "admin";

const ROLE_DEFAULT_MODULES: Record<
  SimRole,
  Array<Exclude<PromptScopeKey, "general">>
> = {
  viewer: ["mail-outbox", "calendar-meetings"],
  operator: ["orders", "dispatch", "mail-outbox", "calendar-meetings"],
  manager: [
    "orders",
    "dispatch",
    "invoice-review",
    "warehouse-insights",
    "approvals",
    "mail-outbox",
    "calendar-meetings",
  ],
  admin: [
    "orders",
    "dispatch",
    "invoice-review",
    "warehouse-insights",
    "approvals",
    "mail-outbox",
    "calendar-meetings",
  ],
};

export function PromptGovernancePanel() {
  const { actor, authGeneration, handleAccessChanged } = useSession();
  const { locale, tx, localizeError, localizeRole } = useLocale();

  const isAdmin = actor?.role === "admin";

  const [policies, setPolicies] = useState<PromptPolicyEntry[]>([]);
  const [sealedBanner, setSealedBanner] = useState<{
    sealed: boolean;
    managedBy: string;
  }>({ sealed: true, managedBy: "theodic_core_team" });
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<ApiError | null>(null);

  // Role / Scope Simulator state
  const [simRole, setSimRole] = useState<SimRole>("operator");
  const [simModules, setSimModules] = useState<
    Array<Exclude<PromptScopeKey, "general">>
  >(ROLE_DEFAULT_MODULES.operator);
  const [simulating, setSimulating] = useState(false);
  const [simResult, setSimResult] = useState<PromptSimulateResponse | null>(
    null,
  );
  const [simError, setSimError] = useState<ApiError | null>(null);

  const loadPolicies = useCallback(
    async (signal?: AbortSignal) => {
      if (!isAdmin) return;
      setLoading(true);
      setLoadError(null);
      try {
        const res = await fetchPromptPolicies(signal);
        if (signal?.aborted) return;
        const sorted = [...(res.items ?? [])].sort(
          (a, b) =>
            SCOPE_ORDER.indexOf(a.scope_key) - SCOPE_ORDER.indexOf(b.scope_key),
        );
        setPolicies(sorted);
        setSealedBanner({
          sealed: res.sealed ?? true,
          managedBy: res.managed_by ?? "theodic_core_team",
        });
      } catch (err) {
        if (isStaleAuthError(err)) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (isApiError(err)) {
          if (err.code === "ACCESS_CHANGED") {
            void handleAccessChanged();
          }
          setLoadError(err);
        }
      } finally {
        setLoading(false);
      }
    },
    [isAdmin, handleAccessChanged],
  );

  useEffect(() => {
    setPolicies([]);
    setLoadError(null);
    setSimResult(null);
    setSimError(null);
    if (!isAdmin) return;

    const controller = new AbortController();
    void loadPolicies(controller.signal);
    return () => {
      controller.abort();
    };
  }, [authGeneration, isAdmin, loadPolicies]);

  const handleToggleSimModule = (mod: Exclude<PromptScopeKey, "general">) => {
    setSimModules((prev) =>
      prev.includes(mod) ? prev.filter((item) => item !== mod) : [...prev, mod],
    );
  };

  const handleRunSimulation = async () => {
    if (simulating) return;
    setSimulating(true);
    setSimError(null);
    const derivedGrants = Array.from(
      new Set(simModules.flatMap((mod) => MODULE_SIM_GRANTS[mod] ?? [])),
    );
    try {
      const res = await simulatePromptPolicy({
        role: simRole,
        grants: derivedGrants,
        warehouses: ["HK01"],
      });
      setSimResult(res);
    } catch (err) {
      if (isStaleAuthError(err)) return;
      if (isApiError(err)) {
        setSimError(err);
      }
    } finally {
      setSimulating(false);
    }
  };

  const resolveScopeTitle = useCallback(
    (entry: PromptPolicyEntry): string => {
      if (locale === "en" && entry.title_en) return entry.title_en;
      if (locale === "zh-HK" && entry.title_hk) return entry.title_hk;
      if (locale === "zh-CN" && entry.title_zh) return entry.title_zh;
      return tx(SCOPE_LABELS[entry.scope_key]) || entry.title;
    },
    [locale, tx],
  );

  const totalSealedRules = useMemo(
    () => policies.reduce((acc, item) => acc + (item.rule_count ?? 0), 0),
    [policies],
  );

  if (!isAdmin) {
    return (
      <AccessNoticeCard
        variant="ACCESS_RESTRICTED"
        title={tx({
          "zh-CN": "需要租户管理员角色 (admin)",
          "zh-HK": "需要租戶管理員角色 (admin)",
          en: "Tenant Administrator Role Required (admin)",
        })}
        message={tx({
          "zh-CN":
            "密封策略摘要与权限作用域组合模拟器仅限租户管理员查看与核验。",
          "zh-HK":
            "密封策略摘要與權限作用域組合模擬器僅限租戶管理員檢視與核驗。",
          en: "Sealed policy posture and the permission-scope simulator are restricted to tenant administrators.",
        })}
      />
    );
  }

  return (
    <div className="space-y-5" data-testid="prompt-governance-panel">
      {loadError && (
        <AccessNoticeCard
          error={loadError}
          onRetry={() => void loadPolicies()}
        />
      )}

      {/* Read-Only Sealed Policy Posture Banner */}
      <section className="rounded-card border border-[var(--status-emerald-border)] bg-[var(--bg-surface)] shadow-[var(--shadow-card)] p-5 sm:p-6 space-y-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3.5 min-w-0">
            <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-sm border border-[var(--status-emerald-border)] bg-[var(--status-emerald-wash)] text-[var(--status-emerald)]">
              <ShieldCheck className="h-5 w-5" strokeWidth={1.9} />
            </span>

            <div className="min-w-0 space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="aios-display text-[16.5px] font-semibold text-[var(--ink-primary)]">
                  {tx({
                    "zh-CN": "核心战略提示词已密封保护",
                    "zh-HK": "核心策略提示詞已密封保護",
                    en: "Sealed Policy Posture",
                  })}
                </h2>
                <span
                  data-testid="policy-sealed-badge"
                  className="inline-flex items-center gap-1.5 rounded-xs border border-[var(--status-emerald-border)] bg-[var(--status-emerald-wash)] px-2.5 py-0.5 text-[11px] font-semibold text-[var(--status-emerald)]"
                >
                  <Lock className="h-3 w-3" strokeWidth={2.1} />
                  <span>Managed by Theodic Core Team</span>
                </span>
                {policies.length > 0 && (
                  <span className="rounded-xs border border-[var(--hairline)] bg-[var(--bg-surface-tint)] px-2 py-0.5 font-mono-code text-[11px] text-[var(--ink-secondary)] tabular-nums">
                    {tx(
                      {
                        "zh-CN": "{scopes} 个作用域 · {rules} 条密封守则",
                        "zh-HK": "{scopes} 個作用域 · {rules} 條密封守則",
                        en: "{scopes} scopes · {rules} sealed rules",
                      },
                      { scopes: policies.length, rules: totalSealedRules },
                    )}
                  </span>
                )}
              </div>

              <p className="text-[13px] leading-relaxed text-[var(--ink-secondary)]">
                {tx({
                  "zh-CN":
                    "为防止策略外泄、越权篡改与提示词注入攻击，助手核心人格基线、通用策略与全部 7 个业务模块指令已由 Theodic 核心团队在服务端代码层硬性密封。租户管理员与运行中的 AI 模型均无法读取、导出、覆写或重置任何原始提示词正文，所有越权修改请求均会自动阻断并记入安全审计。",
                  "zh-HK":
                    "為防止策略外洩、越權篡改與提示詞注入攻擊，助手核心人格基線、通用策略與全部 7 個業務模組指令已由 Theodic 核心團隊於伺服器端程式碼層硬性密封。租戶管理員與運行中的 AI 模型均無法讀取、匯出、覆寫或重設任何原始提示詞正文，所有越權修改請求均會自動阻斷並記入安全稽核。",
                  en: "To prevent policy leakage, tampering, and prompt-injection bypasses, core persona baselines, general directives, and all 7 module scopes are cryptographically sealed in code by the Theodic Core Team. Neither tenant administrators nor AI models can view, export, edit, or reset raw prompt text; mutation attempts fail closed and log security audit incidents.",
                })}
              </p>

              <p className="font-mono-code text-[11px] text-[var(--ink-muted)]">
                posture={sealedBanner.sealed ? "sealed_read_only" : "sealed"} ·
                custodian={sealedBanner.managedBy}
              </p>
            </div>
          </div>

          <Button
            size="sm"
            variant="secondary"
            loading={loading}
            onClick={() => void loadPolicies()}
            className="shrink-0"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>
              {tx({
                "zh-CN": "核验密封摘要",
                "zh-HK": "核驗密封摘要",
                en: "Verify Digests",
              })}
            </span>
          </Button>
        </div>
      </section>

      {/* 8 Read-Only Sealed Scope Cards */}
      <section className="space-y-2.5">
        <div className="flex items-center justify-between px-1">
          <h3 className="aios-micro-label">
            {tx({
              "zh-CN": "已密封策略作用域清单（只读元数据摘要）",
              "zh-HK": "已密封策略作用域清單（唯讀中繼資料摘要）",
              en: "Sealed Policy Scopes (Read-Only Integrity Metadata)",
            })}
          </h3>
          <span className="font-mono-code text-[11px] text-[var(--ink-muted)] tabular-nums">
            {tx({
              "zh-CN": "1 个通用基线 + 7 个业务模块层",
              "zh-HK": "1 個通用基線 + 7 個業務模組層",
              en: "1 baseline + 7 module tiers",
            })}
          </span>
        </div>

        {loading && policies.length === 0 ? (
          <div className="rounded-card border border-[var(--hairline)] bg-[var(--bg-surface)] p-10 text-center text-[13px] text-[var(--ink-muted)] shadow-[var(--shadow-card)]">
            {tx({
              "zh-CN": "正在核验服务端密封策略摘要…",
              "zh-HK": "正在核驗伺服器端密封策略摘要…",
              en: "Verifying sealed policy digests…",
            })}
          </div>
        ) : policies.length === 0 ? (
          <div className="rounded-card border border-[var(--hairline)] bg-[var(--bg-surface)] p-10 text-center text-[13px] text-[var(--ink-muted)] shadow-[var(--shadow-card)]">
            {tx({
              "zh-CN": "暂无已加载的策略作用域元数据。",
              "zh-HK": "暫無已載入的策略作用域中繼資料。",
              en: "No sealed policy scope metadata available.",
            })}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2 xl:grid-cols-4">
            {policies.map((policy) => (
              <article
                key={policy.scope_key}
                data-testid={`sealed-policy-card-${policy.scope_key}`}
                className="flex flex-col justify-between rounded-card border border-[var(--hairline)] bg-[var(--bg-surface)] p-4 shadow-[var(--shadow-card)]"
              >
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate rounded-xs border border-[var(--hairline)] bg-[var(--bg-surface-tint)] px-2 py-0.5 font-mono-code text-[11px] font-medium text-[var(--ink-secondary)]">
                      {policy.scope_key}
                    </span>
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-xs border border-[var(--status-emerald-border)] bg-[var(--status-emerald-wash)] px-1.5 py-0.5 text-[10.5px] font-semibold text-[var(--status-emerald)]">
                      <Lock className="h-2.5 w-2.5" strokeWidth={2.2} />
                      <span>
                        {tx({
                          "zh-CN": "已密封",
                          "zh-HK": "已密封",
                          en: "Sealed",
                        })}
                      </span>
                    </span>
                  </div>

                  <h4 className="text-[14px] font-semibold tracking-[-0.01em] text-[var(--ink-primary)]">
                    {resolveScopeTitle(policy)}
                  </h4>

                  <p className="text-[12px] leading-relaxed text-[var(--ink-secondary)]">
                    {policy.description}
                  </p>
                </div>

                <div className="mt-4 flex items-center justify-between gap-2 border-t border-[var(--hairline-subtle)] pt-2.5 font-mono-code text-[11px] text-[var(--ink-muted)] tabular-nums">
                  <span title={policy.policy_digest} className="min-w-0 truncate">
                    sha256:{policy.policy_digest}
                  </span>
                  <span className="shrink-0">
                    {tx(
                      {
                        "zh-CN": "{count} 条守则",
                        "zh-HK": "{count} 條守則",
                        en: "{count} rules",
                      },
                      { count: policy.rule_count },
                    )}
                  </span>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {/* Interactive Role / Scope Simulator (Active vs Denied Scopes ONLY — Zero Prompt Content) */}
      <section
        data-testid="prompt-policy-simulator"
        className="rounded-card border border-[var(--hairline)] bg-[var(--bg-surface)] shadow-[var(--shadow-card)] p-5 sm:p-6 space-y-4"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-[var(--hairline)] pb-4">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-sm border border-[var(--accent-border)] bg-[var(--accent-wash)] text-[var(--accent-ink)]">
              <Sliders className="h-4 w-4" strokeWidth={1.9} />
            </span>
            <div>
              <h3 className="aios-display text-[15.5px] font-semibold text-[var(--ink-primary)]">
                {tx({
                  "zh-CN": "角色 / 作用域生效境界模拟器",
                  "zh-HK": "角色 / 作用域生效邊界模擬器",
                  en: "Role & Scope Boundary Simulator",
                })}
              </h3>
              <p className="mt-0.5 text-[12.5px] text-[var(--ink-secondary)]">
                {tx({
                  "zh-CN":
                    "按目标员工角色与已分配模块权限，实时核验哪些密封作用域会激活（Active）以及哪些边界被强制隔离（Denied），全程不暴露任何内部指令正文。",
                  "zh-HK":
                    "按目標員工角色與已指派模組權限，即時核驗哪些密封作用域會啟用（Active）以及哪些邊界被強制隔離（Denied），全程不暴露任何內部指令正文。",
                  en: "Preview which sealed scopes activate versus which boundaries are denied for a role and module grant set, with zero directive disclosure.",
                })}
              </p>
            </div>
          </div>

          <Button
            size="sm"
            variant="primary"
            loading={simulating}
            data-testid="prompt-simulate-btn"
            onClick={() => void handleRunSimulation()}
          >
            <Play className="h-3.5 w-3.5" />
            <span>
              {tx({
                "zh-CN": "运行作用域模拟",
                "zh-HK": "執行作用域模擬",
                en: "Simulate Scopes",
              })}
            </span>
          </Button>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          <div className="lg:col-span-4 space-y-2">
            <div className="aios-micro-label">
              {tx({
                "zh-CN": "1. 选择模拟角色",
                "zh-HK": "1. 選擇模擬角色",
                en: "1. Simulated Role",
              })}
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {(["viewer", "operator", "manager", "admin"] as const).map(
                (r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => {
                      setSimRole(r);
                      setSimModules(ROLE_DEFAULT_MODULES[r]);
                    }}
                    className={[
                      "rounded-sm border px-3 py-2 text-left text-[12.5px] font-medium transition-colors cursor-pointer",
                      simRole === r
                        ? "border-[var(--accent-border)] bg-[var(--accent-wash)] text-[var(--accent-ink)]"
                        : "border-[var(--hairline)] bg-[var(--bg-surface-tint)] text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)]",
                    ].join(" ")}
                  >
                    <div>{localizeRole(r)}</div>
                    <div className="font-mono-code text-[10.5px] opacity-75">
                      {r}
                    </div>
                  </button>
                ),
              )}
            </div>
          </div>

          <div className="lg:col-span-8 space-y-2">
            <div className="aios-micro-label">
              {tx({
                "zh-CN": "2. 勾选模拟账号已获授权的业务模块",
                "zh-HK": "2. 勾選模擬帳號已獲授權的業務模組",
                en: "2. Active Module Grants for Simulation",
              })}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {SIM_MODULE_SCOPES.map((mod) => {
                const checked = simModules.includes(mod);
                return (
                  <button
                    key={mod}
                    type="button"
                    onClick={() => handleToggleSimModule(mod)}
                    className={[
                      "inline-flex items-center gap-1.5 rounded-sm border px-2.5 py-1.5 text-[12px] font-medium transition-colors cursor-pointer",
                      checked
                        ? "border-[var(--accent-border)] bg-[var(--accent-wash)] text-[var(--accent-ink)]"
                        : "border-[var(--hairline)] bg-[var(--bg-surface-tint)] text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)]",
                    ].join(" ")}
                  >
                    <span>{tx(SCOPE_LABELS[mod])}</span>
                    <span className="font-mono-code text-[10.5px] opacity-80">
                      {mod}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {simError && <AccessNoticeCard error={simError} />}

        {simResult && (
          <div
            data-testid="prompt-simulate-output"
            className="rounded-tile border border-[var(--hairline)] bg-[var(--bg-surface-tint)] p-4 space-y-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--hairline-subtle)] pb-2.5">
              <div className="flex items-center gap-2 text-[12px]">
                <span className="font-semibold text-[var(--ink-primary)]">
                  {localizeRole(simResult.role)}
                </span>
                <span className="font-mono-code text-[11px] text-[var(--ink-muted)]">
                  ({simResult.role})
                </span>
              </div>
              <span className="inline-flex items-center gap-1 rounded-xs border border-[var(--status-emerald-border)] bg-[var(--status-emerald-wash)] px-2 py-0.5 font-mono-code text-[10.5px] font-semibold text-[var(--status-emerald)]">
                <Lock className="h-3 w-3" />
                <span>{simResult.managed_by}</span>
              </span>
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="rounded-sm border border-[var(--status-emerald-border)] bg-[var(--bg-surface)] p-3.5 space-y-2">
                <div className="flex items-center gap-1.5">
                  <ShieldCheck className="h-4 w-4 text-[var(--status-emerald)]" />
                  <span className="aios-micro-label">
                    {tx({
                      "zh-CN": "生效作用域 (Active Scopes)",
                      "zh-HK": "生效作用域 (Active Scopes)",
                      en: "Active Scopes",
                    })}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {simResult.active_scopes.length > 0 ? (
                    simResult.active_scopes.map((s) => (
                      <span
                        key={s}
                        className="inline-flex items-center gap-1.5 rounded-xs border border-[var(--status-emerald-border)] bg-[var(--status-emerald-wash)] px-2 py-1 text-[11.5px] font-medium text-[var(--status-emerald)]"
                      >
                        <span>{tx(SCOPE_LABELS[s]) || s}</span>
                        <span className="font-mono-code text-[10.5px] opacity-85">
                          {s}
                        </span>
                      </span>
                    ))
                  ) : (
                    <span className="text-[12px] text-[var(--ink-muted)]">—</span>
                  )}
                </div>
              </div>

              <div className="rounded-sm border border-[var(--status-crimson-border)] bg-[var(--bg-surface)] p-3.5 space-y-2">
                <div className="flex items-center gap-1.5">
                  <Lock className="h-4 w-4 text-[var(--status-crimson)]" />
                  <span className="aios-micro-label">
                    {tx({
                      "zh-CN": "未授权隔离作用域 (Denied Scopes)",
                      "zh-HK": "未授權隔離作用域 (Denied Scopes)",
                      en: "Denied Scopes",
                    })}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {simResult.denied_scopes.length > 0 ? (
                    simResult.denied_scopes.map((s) => (
                      <span
                        key={s}
                        className="inline-flex items-center gap-1.5 rounded-xs border border-[var(--status-crimson-border)] bg-[var(--status-crimson-wash)] px-2 py-1 text-[11.5px] font-medium text-[var(--status-crimson)]"
                      >
                        <span>{tx(SCOPE_LABELS[s]) || s}</span>
                        <span className="font-mono-code text-[10.5px] opacity-85">
                          {s}
                        </span>
                      </span>
                    ))
                  ) : (
                    <span className="text-[12px] text-[var(--ink-muted)]">
                      {tx({
                        "zh-CN": "全部作用域已获授权",
                        "zh-HK": "全部作用域已獲授權",
                        en: "None — all scopes active",
                      })}
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
