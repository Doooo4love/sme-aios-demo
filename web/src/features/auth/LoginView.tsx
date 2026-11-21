"use client";

import React, { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowRight,
  ChevronDown,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  ShieldCheck,
} from "lucide-react";
import { isApiError } from "@/lib/api-client";
import { isSafeRelativeRedirect } from "@/lib/format";
import { useSession } from "@/lib/session-context";
import { ArchitecturalRelayCanvas } from "@/components/kinetic/ArchitecturalRelayCanvas";
import { Interactive3DCard } from "@/components/kinetic/Interactive3DCard";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import type { DemoPersonaId, DemoPersonaMeta } from "@/lib/types";

const GROUP_TITLES: Record<DemoPersonaMeta["group"], string> = {
  core: "核心岗位",
  specialist: "专岗只读",
  isolation: "跨仓与跨租户隔离",
};

const GROUP_ORDER: readonly DemoPersonaMeta["group"][] = [
  "core",
  "specialist",
  "isolation",
];

export function LoginView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { status, demoConfig, loginAsDemo, loginWithPassword } = useSession();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submittingForm, setSubmittingForm] = useState(false);
  const [submittingPersona, setSubmittingPersona] =
    useState<DemoPersonaId | null>(null);
  const [demoHelperOpen, setDemoHelperOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorRequestId, setErrorRequestId] = useState<string | null>(null);

  const safeNext = isSafeRelativeRedirect(searchParams.get("next")) || "/inbox";

  useEffect(() => {
    if (status === "authenticated") {
      router.replace(safeNext);
    }
  }, [status, router, safeNext]);

  const busy = submittingForm || submittingPersona !== null;

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const trimmedUser = username.trim();
    if (!trimmedUser || !password) {
      setErrorMessage("请输入企业账号与登录密码。");
      return;
    }

    setSubmittingForm(true);
    setErrorMessage(null);
    setErrorRequestId(null);
    try {
      const me = await loginWithPassword(trimmedUser, password);
      if (me) {
        router.replace(safeNext);
      } else {
        setErrorMessage("会话校验未通过，请确认后端服务已启动并重试。");
      }
    } catch (error) {
      if (isApiError(error)) {
        setErrorMessage(error.message);
        setErrorRequestId(error.requestId);
      } else {
        setErrorMessage("登录失败，请稍后重试。");
      }
    } finally {
      setSubmittingForm(false);
    }
  };

  const handleDemoQuickLogin = async (persona: DemoPersonaMeta) => {
    if (busy) return;
    setUsername(persona.email || persona.subject);
    setSubmittingPersona(persona.subject);
    setErrorMessage(null);
    setErrorRequestId(null);
    try {
      const me = await loginAsDemo(persona.subject);
      if (me) {
        router.replace(safeNext);
      } else {
        setErrorMessage("会话校验未通过，请确认后端服务已启动并重试。");
      }
    } catch (error) {
      if (isApiError(error)) {
        setErrorMessage(error.message);
        setErrorRequestId(error.requestId);
      } else {
        setErrorMessage("登录失败，请稍后重试。");
      }
    } finally {
      setSubmittingPersona(null);
    }
  };

  const showPasswordForm =
    demoConfig === null ||
    demoConfig.password_login_enabled ||
    demoConfig.enabled;
  const showOidcButton =
    demoConfig === null || demoConfig.oidc_login_enabled;

  return (
    <div
      data-testid="login-page"
      className="flex min-h-dvh w-full items-center bg-[var(--bg-app)] text-[var(--ink-primary)]"
      style={{
        backgroundImage:
          "radial-gradient(ellipse 75% 65% at 72% 38%, rgba(22, 104, 227, 0.065), transparent 72%)",
      }}
    >
      <div className="mx-auto grid w-full max-w-[1340px] grid-cols-1 items-stretch gap-8 px-5 py-8 sm:px-8 lg:min-h-[620px] lg:grid-cols-[minmax(420px,468px)_minmax(0,1fr)] lg:gap-10 lg:px-12 lg:py-10">
        {/* Left Floating Porcelain Authentication Card — top & bottom aligned with 3D showcase */}
        <section className="mx-auto flex w-full max-w-[468px] flex-col justify-between rounded-xl bg-[var(--bg-surface)] p-7 shadow-[var(--shadow-card)] sm:p-9 lg:mx-0">
          <div>
            {/* Clean Brand Mark */}
            <div className="flex items-center gap-2.5">
              <span className="inline-flex h-9 w-9 items-center justify-center rounded-sm bg-[image:var(--agent-surface)] text-[var(--accent)] ring-1 ring-[var(--agent-ring)]">
                <svg
                  viewBox="0 0 20 20"
                  className="h-4.5 w-4.5"
                  fill="none"
                  aria-hidden="true"
                >
                  <circle
                    cx="10"
                    cy="10"
                    r="7.2"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeOpacity="0.35"
                  />
                  <circle
                    cx="10"
                    cy="10"
                    r="4.2"
                    stroke="currentColor"
                    strokeWidth="1.6"
                  />
                  <circle cx="10" cy="10" r="1.6" fill="currentColor" />
                </svg>
              </span>
              <div>
                <div className="text-[14px] font-semibold tracking-[-0.01em] text-[var(--ink-primary)]">
                  SME AIOS
                </div>
                <div className="text-[11.5px] text-[var(--ink-muted)]">
                  企业智能运营工作台
                </div>
              </div>
            </div>

            <div className="mt-7">
              <h1 className="text-[24px] font-semibold tracking-[-0.025em] text-[var(--ink-primary)]">
                登录企业工作台
              </h1>
              <p className="mt-1.5 text-[13.5px] text-[var(--ink-muted)]">
                使用企业账号进入个人业务助手与协作空间
              </p>
            </div>

            {errorMessage && (
              <div
                role="alert"
                data-testid="login-error"
                className="mt-5 rounded-sm bg-[var(--status-crimson-wash)] px-3.5 py-2.5 text-[12.5px] text-[var(--status-crimson)]"
              >
                <div>{errorMessage}</div>
                {errorRequestId && (
                  <div className="mt-1 font-mono-code text-[11px] opacity-80">
                    跟踪编号: {errorRequestId}
                  </div>
                )}
              </div>
            )}

            {/* Primary Account + Password Sign-In Form */}
            {showPasswordForm && (
              <form
                onSubmit={(e) => void handlePasswordSubmit(e)}
                className="mt-6 space-y-4"
              >
                <div>
                  <label
                    htmlFor="login-account"
                    className="block text-[12.5px] font-medium text-[var(--ink-secondary)]"
                  >
                    企业账号
                  </label>
                  <input
                    id="login-account"
                    name="username"
                    type="text"
                    autoComplete="username"
                    data-testid="login-account-input"
                    value={username}
                    disabled={busy}
                    onChange={(e) => {
                      setUsername(e.target.value);
                      if (errorMessage) setErrorMessage(null);
                    }}
                    placeholder="例如 operator@harbour.demo 或 manager"
                    className="mt-1.5 h-11 w-full rounded-sm border border-[var(--hairline-strong)] bg-[var(--bg-surface-tint)] px-3.5 text-[14px] text-[var(--ink-primary)] placeholder:text-[var(--ink-faint)] transition-all duration-[150ms] focus:border-[var(--accent)] focus:bg-[var(--bg-surface)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-ring)] disabled:opacity-60"
                  />
                </div>

                <div>
                  <label
                    htmlFor="login-password"
                    className="block text-[12.5px] font-medium text-[var(--ink-secondary)]"
                  >
                    登录密码
                  </label>
                  <div className="relative mt-1.5">
                    <input
                      id="login-password"
                      name="password"
                      type={showPassword ? "text" : "password"}
                      autoComplete="current-password"
                      data-testid="login-password-input"
                      value={password}
                      disabled={busy}
                      onChange={(e) => {
                        setPassword(e.target.value);
                        if (errorMessage) setErrorMessage(null);
                      }}
                      placeholder="请输入登录密码"
                      className="h-11 w-full rounded-sm border border-[var(--hairline-strong)] bg-[var(--bg-surface-tint)] pl-3.5 pr-10 text-[14px] text-[var(--ink-primary)] placeholder:text-[var(--ink-faint)] transition-all duration-[150ms] focus:border-[var(--accent)] focus:bg-[var(--bg-surface)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-ring)] disabled:opacity-60"
                    />
                    <button
                      type="button"
                      aria-label={showPassword ? "隐藏密码" : "显示密码"}
                      onClick={() => setShowPassword((v) => !v)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex h-7 w-7 items-center justify-center rounded-full text-[var(--ink-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--ink-primary)] cursor-pointer"
                    >
                      {showPassword ? (
                        <EyeOff className="h-4 w-4" strokeWidth={1.8} />
                      ) : (
                        <Eye className="h-4 w-4" strokeWidth={1.8} />
                      )}
                    </button>
                  </div>
                </div>

                <Button
                  type="submit"
                  size="lg"
                  variant="primary"
                  loading={submittingForm}
                  disabled={busy}
                  data-testid="login-submit-btn"
                  className="w-full"
                >
                  <span>{submittingForm ? "正在验证身份…" : "登录工作台"}</span>
                  {!submittingForm && (
                    <ArrowRight className="h-4 w-4" strokeWidth={2} />
                  )}
                </Button>
              </form>
            )}

            {/* Enterprise OIDC Single Sign-On */}
            {showOidcButton && (
              <div className="mt-5">
                {showPasswordForm && (
                  <div className="relative my-4 flex items-center justify-center">
                    <div className="h-px w-full bg-[var(--hairline)]" />
                    <span className="bg-[var(--bg-surface)] px-3 text-[11.5px] text-[var(--ink-muted)] shrink-0">
                      或
                    </span>
                    <div className="h-px w-full bg-[var(--hairline)]" />
                  </div>
                )}
                <a
                  href="/v1/session/login"
                  data-testid="login-oidc-button"
                  className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-sm bg-[var(--bg-surface)] px-4 text-[13.5px] font-medium text-[var(--ink-primary)] shadow-[var(--shadow-subtle)] hover:bg-[var(--bg-surface-tint)] hover:shadow-[var(--shadow-card)] transition-all duration-[150ms]"
                >
                  <KeyRound className="h-4 w-4 text-[var(--accent)]" strokeWidth={1.85} />
                  <span>使用企业单点登录 (OIDC)</span>
                  <ArrowRight className="h-4 w-4 text-[var(--ink-muted)]" strokeWidth={1.85} />
                </a>
              </div>
            )}

            {/* Collapsed-by-Default Local Demo Quick-Fill Helper */}
            {demoConfig?.enabled && (
              <div className="mt-5" data-testid="login-persona-list">
                <button
                  type="button"
                  data-testid="login-demo-helper-toggle"
                  aria-expanded={demoHelperOpen}
                  onClick={() => setDemoHelperOpen((v) => !v)}
                  className="flex w-full items-center justify-between gap-2 rounded-sm bg-[var(--bg-surface-tint)] px-3.5 py-2.5 text-[12.5px] font-medium text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--ink-primary)] transition-colors cursor-pointer"
                >
                  <span className="flex items-center gap-2">
                    <span>测试演示账号快速填入</span>
                    <span className="rounded-full bg-[var(--accent-wash)] px-2 py-0.5 font-mono-code text-[10.5px] font-semibold text-[var(--accent)]">
                      {demoConfig.personas.length} 角色
                    </span>
                  </span>
                  <ChevronDown
                    className={[
                      "h-4 w-4 text-[var(--ink-muted)] transition-transform duration-[200ms]",
                      demoHelperOpen ? "rotate-180" : "rotate-0",
                    ].join(" ")}
                    strokeWidth={1.85}
                  />
                </button>

                <div
                  className="aios-accordion"
                  data-open={demoHelperOpen ? "true" : "false"}
                >
                  <div className="aios-accordion-inner">
                    <div className="mt-2.5 space-y-3 max-h-[260px] overflow-auto rounded-md bg-[var(--bg-surface-tint)] p-3">
                      {GROUP_ORDER.map((group) => {
                        const items = demoConfig.personas.filter(
                          (p) => p.group === group,
                        );
                        if (items.length === 0) return null;
                        return (
                          <div key={group}>
                            <div className="mb-1.5 px-1 text-[11px] font-medium text-[var(--ink-muted)]">
                              {GROUP_TITLES[group]}
                            </div>
                            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                              {items.map((persona) => {
                                const isPending =
                                  submittingPersona === persona.subject;
                                return (
                                  <button
                                    key={persona.subject}
                                    type="button"
                                    data-testid={`login-persona-${persona.subject}`}
                                    disabled={busy}
                                    onClick={() =>
                                      void handleDemoQuickLogin(persona)
                                    }
                                    className="flex items-center gap-2.5 rounded-sm bg-[var(--bg-surface)] px-2.5 py-2 text-left shadow-[var(--shadow-subtle)] hover:shadow-[var(--shadow-card)] hover:ring-1 hover:ring-[var(--accent-border)] transition-all duration-[140ms] cursor-pointer disabled:opacity-55"
                                  >
                                    <Avatar
                                      name={persona.display_name || persona.label}
                                      fallbackText={persona.subject}
                                      size="xs"
                                    />
                                    <div className="min-w-0 flex-1">
                                      <div className="flex items-center justify-between gap-1">
                                        <span className="truncate font-mono-code text-[11.5px] font-semibold text-[var(--ink-primary)]">
                                          {persona.subject}
                                        </span>
                                        <span className="shrink-0 font-mono-code text-[10px] text-[var(--accent)]">
                                          {isPending ? "…" : persona.warehouses.join("/")}
                                        </span>
                                      </div>
                                      <div className="truncate text-[11px] text-[var(--ink-muted)]">
                                        {persona.display_name
                                          ? `${persona.display_name} · ${persona.label}`
                                          : persona.label}
                                      </div>
                                    </div>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {demoConfig && !demoConfig.enabled && !demoConfig.oidc_login_enabled && (
              <div className="mt-6 rounded-md bg-[var(--bg-surface-tint)] p-4 text-[13px] text-[var(--ink-secondary)]">
                <p>当前环境尚未配置企业 OIDC 或受控本地演示登录。</p>
                <Button
                  size="sm"
                  variant="secondary"
                  className="mt-3"
                  onClick={() => window.location.reload()}
                >
                  重新检查登录配置
                </Button>
              </div>
            )}
          </div>

          <footer className="mt-7 flex items-center gap-2 border-t border-[var(--hairline)] pt-4 text-[11.5px] text-[var(--ink-muted)]">
            <Lock
              className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]"
              strokeWidth={1.85}
            />
            <span>企业单点登录 · 会话受站点权限保护</span>
            <ShieldCheck
              className="ml-auto h-3.5 w-3.5 shrink-0 text-[var(--ink-faint)]"
              strokeWidth={1.85}
            />
          </footer>
        </section>

        {/* Right Desktop Porcelain 3D Architectural Showcase (sheen-only, zero double parallax) */}
        <aside className="hidden lg:block min-h-[620px] max-h-[680px]">
          <Interactive3DCard
            maxTilt={0}
            interactive={false}
            sheenIntensity="medium"
            className="h-full w-full overflow-hidden rounded-xl shadow-[var(--shadow-card)]"
          >
            <ArchitecturalRelayCanvas />
          </Interactive3DCard>
        </aside>

        {/* Mobile Compact Porcelain 3D Preview */}
        <div className="h-[200px] w-full overflow-hidden rounded-lg shadow-[var(--shadow-card)] lg:hidden">
          <ArchitecturalRelayCanvas compact />
        </div>
      </div>
    </div>
  );
}
