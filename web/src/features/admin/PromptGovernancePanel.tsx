"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldCheck,
  Sliders,
  Trash2,
} from "lucide-react";
import { isApiError, isStaleAuthError, type ApiError } from "@/lib/api-client";
import { useLocale, type TrilingualText } from "@/lib/i18n";
import { useSession } from "@/lib/session-context";
import { AccessNoticeCard, Button, StatusBadge } from "@/components/ui";
import { ActionConfirmDialog } from "@/features/admin/ActionConfirmDialog";
import {
  fetchPromptPolicies,
  resetPromptPolicy,
  simulatePromptPolicy,
  updatePromptPolicy,
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
  const { tx, formatDateTime, localizeError, localizeRole } = useLocale();

  const isAdmin = actor?.role === "admin";

  const [policies, setPolicies] = useState<PromptPolicyEntry[]>([]);
  const [selectedScope, setSelectedScope] = useState<PromptScopeKey>("general");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<ApiError | null>(null);

  // Active editor buffer
  const [draftDirective, setDraftDirective] = useState("");
  const [draftRules, setDraftRules] = useState<string[]>([]);
  const [newRuleInput, setNewRuleInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [editorFeedback, setEditorFeedback] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);

  // Simulator state
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
        const sorted = [...res.items].sort(
          (a, b) =>
            SCOPE_ORDER.indexOf(a.scope_key) - SCOPE_ORDER.indexOf(b.scope_key),
        );
        setPolicies(sorted);
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
    setEditorFeedback(null);
    setSimResult(null);
    setSimError(null);
    if (!isAdmin) return;

    const controller = new AbortController();
    void loadPolicies(controller.signal);
    return () => {
      controller.abort();
    };
  }, [authGeneration, isAdmin, loadPolicies]);

  const activePolicy = useMemo(
    () =>
      policies.find((p) => p.scope_key === selectedScope) ?? policies[0] ?? null,
    [policies, selectedScope],
  );

  // Sync editor buffer whenever selected scope or saved policy changes
  useEffect(() => {
    if (!activePolicy) return;
    setDraftDirective(activePolicy.directive);
    setDraftRules(activePolicy.guardrail_rules);
    setNewRuleInput("");
  }, [activePolicy]);

  const isDirty = useMemo(() => {
    if (!activePolicy) return false;
    if (draftDirective.trim() !== activePolicy.directive.trim()) return true;
    if (draftRules.length !== activePolicy.guardrail_rules.length) return true;
    return draftRules.some(
      (rule, idx) =>
        rule.trim() !== (activePolicy.guardrail_rules[idx] ?? "").trim(),
    );
  }, [activePolicy, draftDirective, draftRules]);

  const handleAddRule = () => {
    const trimmed = newRuleInput.trim();
    if (!trimmed || draftRules.length >= 25) return;
    setDraftRules((prev) => [...prev, trimmed.slice(0, 400)]);
    setNewRuleInput("");
    setEditorFeedback(null);
  };

  const handleUpdateRule = (index: number, value: string) => {
    setDraftRules((prev) => prev.map((r, i) => (i === index ? value : r)));
    setEditorFeedback(null);
  };

  const handleRemoveRule = (index: number) => {
    setDraftRules((prev) => prev.filter((_, i) => i !== index));
    setEditorFeedback(null);
  };

  const handleSave = async () => {
    if (!activePolicy || saving) return;
    const cleanedDirective = draftDirective.trim();
    const cleanedRules = draftRules.map((r) => r.trim()).filter(Boolean);
    if (!cleanedDirective) {
      setEditorFeedback({
        kind: "error",
        text: tx({
          "zh-CN": "指令内容不能为空。",
          "zh-HK": "指令內容不能為空。",
          en: "Policy directive cannot be empty.",
        }),
      });
      return;
    }

    setSaving(true);
    setEditorFeedback(null);
    try {
      const updated = await updatePromptPolicy(activePolicy.scope_key, {
        directive: cleanedDirective,
        guardrail_rules: cleanedRules,
        version: activePolicy.version,
      });
      setPolicies((prev) =>
        prev.map((item) =>
          item.scope_key === updated.scope_key ? updated : item,
        ),
      );
      setEditorFeedback({
        kind: "success",
        text: tx(
          {
            "zh-CN": "已保存策略「{scope}」至版本 v{ver}。",
            "zh-HK": "已儲存策略「{scope}」至版本 v{ver}。",
            en: "Saved policy “{scope}” at version v{ver}.",
          },
          {
            scope: tx(SCOPE_LABELS[updated.scope_key]),
            ver: updated.version,
          },
        ),
      });
    } catch (err) {
      if (isStaleAuthError(err)) return;
      if (isApiError(err)) {
        if (err.status === 409) {
          void loadPolicies();
        }
        setEditorFeedback({
          kind: "error",
          text: localizeError(err),
        });
      }
    } finally {
      setSaving(false);
    }
  };

  const handleConfirmReset = async () => {
    if (!activePolicy || resetting) return;
    setResetting(true);
    setEditorFeedback(null);
    try {
      const reset = await resetPromptPolicy(activePolicy.scope_key);
      setPolicies((prev) =>
        prev.map((item) =>
          item.scope_key === reset.scope_key ? reset : item,
        ),
      );
      setResetConfirmOpen(false);
      setEditorFeedback({
        kind: "success",
        text: tx(
          {
            "zh-CN": "已将「{scope}」恢复为平台默认策略。",
            "zh-HK": "已將「{scope}」恢復為平台預設策略。",
            en: "Restored “{scope}” to platform defaults.",
          },
          { scope: tx(SCOPE_LABELS[reset.scope_key]) },
        ),
      });
    } catch (err) {
      if (isStaleAuthError(err)) return;
      setResetConfirmOpen(false);
      if (isApiError(err)) {
        setEditorFeedback({
          kind: "error",
          text: localizeError(err),
        });
      }
    } finally {
      setResetting(false);
    }
  };

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
            "分层提示词治理与权限组合模拟器仅限租户管理员配置与校验。",
          "zh-HK":
            "分層提示詞治理與權限組合模擬器僅限租戶管理員設定與校驗。",
          en: "Tiered policy directives and the permission-policy simulator are restricted to tenant administrators.",
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

      {/* Main Split Editor: Left Tier Rail + Right Directive & Guardrail Editor */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[296px_minmax(0,1fr)]">
        {/* Left Scope Rail */}
        <aside className="rounded-card border border-[var(--hairline)] bg-[var(--bg-surface)] shadow-[var(--shadow-card)] p-4 space-y-3">
          <div className="flex items-center justify-between gap-2 px-1">
            <div>
              <h2 className="aios-micro-label">
                {tx({
                  "zh-CN": "分层治理作用域",
                  "zh-HK": "分層治理作用域",
                  en: "Policy Scope Tiers",
                })}
              </h2>
              <p className="mt-0.5 text-[11.5px] font-mono-code tabular-nums text-[var(--ink-muted)]">
                {tx({
                  "zh-CN": "1 个通用基线 + 7 个业务模块层",
                  "zh-HK": "1 個通用基線 + 7 個業務模組層",
                  en: "1 baseline + 7 module tiers",
                })}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void loadPolicies()}
              disabled={loading}
              aria-label={tx({ "zh-CN": "刷新", "zh-HK": "重新整理", en: "Refresh" })}
              className="inline-flex h-8 w-8 items-center justify-center rounded-sm border border-[var(--hairline)] text-[var(--ink-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--ink-primary)] transition-colors cursor-pointer"
            >
              <RefreshCw
                className={["h-3.5 w-3.5", loading ? "animate-spin" : ""].join(
                  " ",
                )}
              />
            </button>
          </div>

          <div className="space-y-1">
            {SCOPE_ORDER.map((scopeKey) => {
              const policy = policies.find((p) => p.scope_key === scopeKey);
              const isSelected = selectedScope === scopeKey;
              return (
                <button
                  key={scopeKey}
                  type="button"
                  data-testid={`prompt-scope-tab-${scopeKey}`}
                  onClick={() => {
                    setSelectedScope(scopeKey);
                    setEditorFeedback(null);
                  }}
                  className={[
                    "flex w-full items-center justify-between gap-2 rounded-sm border px-3 py-2.5 text-left transition-all duration-[140ms] cursor-pointer",
                    isSelected
                      ? "border-[var(--accent-border)] bg-[var(--accent-wash)] text-[var(--accent-ink)]"
                      : "border-transparent hover:bg-[var(--bg-hover)] text-[var(--ink-primary)]",
                  ].join(" ")}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">
                      {tx(SCOPE_LABELS[scopeKey])}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[var(--ink-muted)]">
                      <span className="font-mono-code truncate">{scopeKey}</span>
                      <span>·</span>
                      <span className="font-mono-code tabular-nums shrink-0">
                        v{policy?.version ?? 0}
                      </span>
                    </div>
                  </div>

                  {policy?.is_custom ? (
                    <span className="shrink-0 rounded-xs border border-[var(--accent-border)] bg-[var(--accent-wash)] px-1.5 py-0.5 font-mono-code text-[10px] font-semibold text-[var(--accent-ink)]">
                      {tx({ "zh-CN": "自定义", "zh-HK": "自訂", en: "Custom" })}
                    </span>
                  ) : (
                    <span className="shrink-0 rounded-xs border border-[var(--hairline)] bg-[var(--bg-surface-subtle)] px-1.5 py-0.5 font-mono-code text-[10px] font-medium text-[var(--ink-muted)]">
                      {tx({ "zh-CN": "默认", "zh-HK": "預設", en: "Default" })}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </aside>

        {/* Right Policy Editor */}
        <section className="rounded-card border border-[var(--hairline)] bg-[var(--bg-surface)] shadow-[var(--shadow-card)] p-5 sm:p-6 space-y-4">
          {!activePolicy ? (
            <div className="py-12 text-center text-[13px] text-[var(--ink-muted)]">
              {loading
                ? tx({
                    "zh-CN": "正在加载租户策略配置…",
                    "zh-HK": "正在載入租戶策略設定…",
                    en: "Loading tenant policy configuration…",
                  })
                : tx({
                    "zh-CN": "暂无可用策略配置。",
                    "zh-HK": "暫無可用策略設定。",
                    en: "No policy scopes loaded.",
                  })}
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--hairline)] pb-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="aios-display text-[16px] font-semibold text-[var(--ink-primary)]">
                      {tx(SCOPE_LABELS[activePolicy.scope_key])}
                    </h3>
                    <span className="rounded-xs border border-[var(--hairline)] bg-[var(--bg-surface-tint)] px-2 py-0.5 font-mono-code text-[11px] text-[var(--ink-secondary)]">
                      {activePolicy.scope_key}
                    </span>
                    <StatusBadge
                      status={activePolicy.is_custom ? "active" : "inherited"}
                      label={
                        activePolicy.is_custom
                          ? tx({
                              "zh-CN": "租户已定制 v{ver}",
                              "zh-HK": "租戶已自訂 v{ver}",
                              en: "Custom v{ver}",
                            }, { ver: activePolicy.version })
                          : tx({
                              "zh-CN": "平台默认 v0",
                              "zh-HK": "平台預設 v0",
                              en: "Default v0",
                            })
                      }
                      compact
                    />
                  </div>
                  {activePolicy.updated_by && activePolicy.updated_at && (
                    <p className="mt-1 font-mono-code text-[11px] text-[var(--ink-muted)] tabular-nums">
                      {tx(
                        {
                          "zh-CN": "最近由 {user} 于 {time} 更新",
                          "zh-HK": "最近由 {user} 於 {time} 更新",
                          en: "Last updated by {user} on {time}",
                        },
                        {
                          user: activePolicy.updated_by,
                          time: formatDateTime(activePolicy.updated_at),
                        },
                      )}
                    </p>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  {activePolicy.is_custom && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={saving || resetting}
                      data-testid="prompt-reset-btn"
                      onClick={() => setResetConfirmOpen(true)}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      <span>
                        {tx({
                          "zh-CN": "恢复默认",
                          "zh-HK": "恢復預設",
                          en: "Reset to Default",
                        })}
                      </span>
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="primary"
                    loading={saving}
                    disabled={!isDirty || resetting}
                    data-testid="prompt-save-btn"
                    onClick={() => void handleSave()}
                  >
                    <Save className="h-3.5 w-3.5" />
                    <span>
                      {tx({
                        "zh-CN": "保存策略",
                        "zh-HK": "儲存策略",
                        en: "Save Policy",
                      })}
                    </span>
                  </Button>
                </div>
              </div>

              {editorFeedback && (
                <div
                  role="status"
                  data-testid="prompt-editor-feedback"
                  className={[
                    "flex items-center gap-2 rounded-tile border px-3.5 py-2.5 text-[12.5px]",
                    editorFeedback.kind === "success"
                      ? "border-[var(--status-emerald-border)] bg-[var(--status-emerald-wash)] text-[var(--status-emerald)]"
                      : "border-[var(--status-crimson-border)] bg-[var(--status-crimson-wash)] text-[var(--status-crimson)]",
                  ].join(" ")}
                >
                  {editorFeedback.kind === "success" ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
                  ) : (
                    <AlertTriangle className="h-4 w-4 shrink-0" />
                  )}
                  <span>{editorFeedback.text}</span>
                </div>
              )}

              {/* Directive Textarea */}
              <div>
                <div className="flex items-center justify-between gap-2">
                  <label
                    htmlFor="policy-directive-input"
                    className="aios-micro-label"
                  >
                    {tx({
                      "zh-CN": "核心行为指令 (Directive)",
                      "zh-HK": "核心行為指令 (Directive)",
                      en: "Core Behavior Directive",
                    })}
                  </label>
                  <span className="font-mono-code text-[11px] text-[var(--ink-muted)] tabular-nums">
                    {draftDirective.length}/4000
                  </span>
                </div>
                <textarea
                  id="policy-directive-input"
                  rows={5}
                  maxLength={4000}
                  value={draftDirective}
                  onChange={(e) => {
                    setDraftDirective(e.target.value);
                    setEditorFeedback(null);
                  }}
                  data-testid="prompt-directive-input"
                  className="mt-1.5 w-full rounded-sm border border-[var(--hairline-strong)] bg-[var(--bg-surface-tint)] p-3 text-[13px] leading-relaxed text-[var(--ink-primary)] focus:border-[var(--accent)] focus:bg-[var(--bg-surface)] focus:ring-2 focus:ring-[var(--accent-ring)] focus:outline-none transition-colors"
                />
              </div>

              {/* Guardrail Rules List */}
              <div className="space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <label className="aios-micro-label">
                    {tx({
                      "zh-CN": "强约束安全守则 (Guardrail Rules)",
                      "zh-HK": "強約束安全守則 (Guardrail Rules)",
                      en: "Enforced Guardrail Rules",
                    })}
                  </label>
                  <span className="font-mono-code text-[11px] text-[var(--ink-muted)] tabular-nums">
                    {draftRules.length}/25
                  </span>
                </div>

                <div className="space-y-2">
                  {draftRules.map((rule, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <span className="w-5 shrink-0 text-right font-mono-code text-[11px] text-[var(--ink-muted)] tabular-nums">
                        {idx + 1}.
                      </span>
                      <input
                        type="text"
                        maxLength={400}
                        value={rule}
                        onChange={(e) => handleUpdateRule(idx, e.target.value)}
                        className="h-9 flex-1 rounded-sm border border-[var(--hairline-strong)] bg-[var(--bg-surface-tint)] px-3 text-[12.5px] text-[var(--ink-primary)] focus:border-[var(--accent)] focus:bg-[var(--bg-surface)] focus:ring-2 focus:ring-[var(--accent-ring)] focus:outline-none transition-colors"
                      />
                      <button
                        type="button"
                        onClick={() => handleRemoveRule(idx)}
                        aria-label={tx({
                          "zh-CN": "移除规则",
                          "zh-HK": "移除規則",
                          en: "Remove rule",
                        })}
                        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-sm border border-[var(--hairline)] text-[var(--ink-muted)] hover:border-[var(--status-crimson-border)] hover:bg-[var(--status-crimson-wash)] hover:text-[var(--status-crimson)] transition-colors cursor-pointer"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>

                {draftRules.length < 25 && (
                  <div className="flex items-center gap-2 pt-1">
                    <input
                      type="text"
                      maxLength={400}
                      value={newRuleInput}
                      onChange={(e) => setNewRuleInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          handleAddRule();
                        }
                      }}
                      placeholder={tx({
                        "zh-CN": "输入一条新的安全护栏规则后点击添加…",
                        "zh-HK": "輸入一條新的安全護欄規則後點擊加入…",
                        en: "Add a new guardrail constraint rule…",
                      })}
                      className="h-9 flex-1 rounded-sm border border-[var(--hairline-strong)] bg-[var(--bg-surface)] px-3 text-[12.5px] text-[var(--ink-primary)] placeholder:text-[var(--ink-faint)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-ring)] focus:outline-none"
                    />
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={!newRuleInput.trim()}
                      onClick={handleAddRule}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      <span>
                        {tx({
                          "zh-CN": "添加规则",
                          "zh-HK": "加入規則",
                          en: "Add Rule",
                        })}
                      </span>
                    </Button>
                  </div>
                )}
              </div>
            </>
          )}
        </section>
      </div>

      {/* Interactive Permission-Policy Simulator */}
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
                  "zh-CN": "权限提示词组合模拟器",
                  "zh-HK": "權限提示詞組合模擬器",
                  en: "Effective Policy & Permission Simulator",
                })}
              </h3>
              <p className="mt-0.5 text-[12.5px] text-[var(--ink-secondary)]">
                {tx({
                  "zh-CN":
                    "按目标员工角色与已分配业务模块，实时预览服务端编译的生效策略段与被拒绝作用域。",
                  "zh-HK":
                    "按目標員工角色與已指派業務模組，即時預覽伺服器端編譯的生效策略段與被拒絕作用域。",
                  en: "Preview which policy tiers compile for a given role and module grant combination versus denied boundaries.",
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
                "zh-CN": "运行组合模拟",
                "zh-HK": "執行組合模擬",
                en: "Simulate Policy",
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
                en: "2. Active Module Permissions for Simulation",
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
            className="rounded-tile border border-[var(--hairline)] bg-[var(--bg-surface-tint)] p-4 space-y-3.5"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
              <div className="flex flex-wrap items-center gap-1.5">
                <ShieldCheck className="h-4 w-4 text-[var(--status-emerald)]" />
                <span className="aios-micro-label">
                  {tx({
                    "zh-CN": "生效作用域",
                    "zh-HK": "生效作用域",
                    en: "Active Scopes",
                  })}
                </span>
                {simResult.active_scopes.map((s) => (
                  <span
                    key={s}
                    className="rounded-xs border border-[var(--status-emerald-border)] bg-[var(--status-emerald-wash)] px-2 py-0.5 font-mono-code text-[11px] font-medium text-[var(--status-emerald)]"
                  >
                    {s}
                  </span>
                ))}
              </div>
              <span className="font-mono-code text-[11.5px] text-[var(--ink-muted)] tabular-nums">
                {tx(
                  {
                    "zh-CN": "编译总字符 {count}",
                    "zh-HK": "編譯總字元 {count}",
                    en: "{count} compiled chars",
                  },
                  { count: simResult.compiled_char_count },
                )}
              </span>
            </div>

            {simResult.denied_scopes.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
                <span className="aios-micro-label">
                  {tx({
                    "zh-CN": "未授权隔离作用域",
                    "zh-HK": "未授權隔離作用域",
                    en: "Denied Boundaries",
                  })}
                </span>
                {simResult.denied_scopes.map((s) => (
                  <span
                    key={s}
                    className="rounded-xs border border-[var(--status-crimson-border)] bg-[var(--status-crimson-wash)] px-2 py-0.5 font-mono-code text-[11px] text-[var(--status-crimson)]"
                  >
                    {s}
                  </span>
                ))}
              </div>
            )}

            <div className="space-y-2.5">
              {simResult.sections.map((sec) => (
                <div
                  key={sec.scope_key}
                  className="rounded-sm border border-[var(--hairline)] bg-[var(--bg-surface)] p-3.5 space-y-1.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[12.5px] font-semibold text-[var(--ink-primary)]">
                      {tx(SCOPE_LABELS[sec.scope_key]) || sec.title}
                    </span>
                    <span className="aios-micro-label font-mono-code">
                      {sec.scope_key}
                    </span>
                  </div>
                  <p className="text-[12px] leading-relaxed text-[var(--ink-secondary)]">
                    {sec.directive}
                  </p>
                  {sec.guardrail_rules.length > 0 && (
                    <ul className="mt-1 list-disc pl-4 space-y-0.5 text-[11.5px] text-[var(--ink-muted)]">
                      {sec.guardrail_rules.map((rule, rIdx) => (
                        <li key={rIdx}>{rule}</li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      <ActionConfirmDialog
        open={resetConfirmOpen}
        onOpenChange={(open) => {
          if (!open && !resetting) setResetConfirmOpen(false);
        }}
        destructive
        loading={resetting}
        title={tx({
          "zh-CN": "确认恢复平台默认策略",
          "zh-HK": "確認恢復平台預設策略",
          en: "Confirm Policy Reset",
        })}
        description={tx({
          "zh-CN":
            "此操作将清除当前租户对该作用域的自定义指令与安全守则，并立即回退到平台出厂基线版本。",
          "zh-HK":
            "此操作將清除目前租戶對該作用域的自訂指令與安全守則，並立即回退至平台出廠基線版本。",
          en: "This removes tenant customizations for this scope and restores the platform baseline immediately.",
        })}
        confirmLabel={tx({
          "zh-CN": "确认恢复默认",
          "zh-HK": "確認恢復預設",
          en: "Reset Policy",
        })}
        cancelLabel={tx({ "zh-CN": "取消", "zh-HK": "取消", en: "Cancel" })}
        onConfirm={handleConfirmReset}
      />
    </div>
  );
}
