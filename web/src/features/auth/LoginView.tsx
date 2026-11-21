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
import { isSafeRelativeRedirect, sortWarehouses } from "@/lib/format";
import { useLocale, type TranslationKey } from "@/lib/i18n";
import { useSession } from "@/lib/session-context";
import { ArchitecturalRelayCanvas } from "@/components/kinetic/ArchitecturalRelayCanvas";
import { Interactive3DCard } from "@/components/kinetic/Interactive3DCard";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { PreferencesBar } from "@/components/ui/PreferencesControls";
import type { DemoPersonaId, DemoPersonaMeta } from "@/lib/types";

const GROUP_TITLE_KEYS: Record<DemoPersonaMeta["group"], TranslationKey> = {
  core: "demo.group.coreShort",
  specialist: "demo.group.specialistShort",
  isolation: "demo.group.isolationShort",
};

const GROUP_ORDER: readonly DemoPersonaMeta["group"][] = [
  "core",
  "specialist",
  "isolation",
];

type LoginErrorState =
  | { kind: "key"; key: TranslationKey; requestId?: string | null }
  | {
      kind: "api";
      status: number;
      code: string;
      message: string;
      rawDetail?: unknown;
      requestId: string | null;
    };

export function LoginView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { status, demoConfig, loginAsDemo, loginWithPassword } = useSession();
  const { t, tp, localizePersona, localizeError } = useLocale();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submittingForm, setSubmittingForm] = useState(false);
  const [submittingPersona, setSubmittingPersona] =
    useState<DemoPersonaId | null>(null);
  const [demoHelperOpen, setDemoHelperOpen] = useState(false);
  const [errorState, setErrorState] = useState<LoginErrorState | null>(null);

  const safeNext = isSafeRelativeRedirect(searchParams.get("next")) || "/inbox";

  useEffect(() => {
    if (status === "authenticated") {
      router.replace(safeNext);
    }
  }, [status, router, safeNext]);

  const busy = submittingForm || submittingPersona !== null;

  const resolvedErrorMessage = (() => {
    if (!errorState) return null;
    if (errorState.kind === "key") return t(errorState.key);
    return localizeError(errorState);
  })();
  const errorRequestId = errorState?.requestId ?? null;

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const trimmedUser = username.trim();
    if (!trimmedUser || !password) {
      setErrorState({ kind: "key", key: "login.errorMissingFields" });
      return;
    }

    setSubmittingForm(true);
    setErrorState(null);
    try {
      const me = await loginWithPassword(trimmedUser, password);
      if (me) {
        router.replace(safeNext);
      } else {
        setErrorState({ kind: "key", key: "login.errorSessionVerify" });
      }
    } catch (error) {
      if (isApiError(error)) {
        setErrorState({
          kind: "api",
          status: error.status,
          code: error.code,
          message: error.message,
          rawDetail: error.rawDetail,
          requestId: error.requestId,
        });
      } else {
        setErrorState({ kind: "key", key: "login.errorGeneric" });
      }
    } finally {
      setSubmittingForm(false);
    }
  };

  const handleDemoQuickLogin = async (persona: DemoPersonaMeta) => {
    if (busy) return;
    setUsername(persona.email || persona.subject);
    setSubmittingPersona(persona.subject);
    setErrorState(null);
    try {
      const me = await loginAsDemo(persona.subject);
      if (me) {
        router.replace(safeNext);
      } else {
        setErrorState({ kind: "key", key: "login.errorSessionVerify" });
      }
    } catch (error) {
      if (isApiError(error)) {
        setErrorState({
          kind: "api",
          status: error.status,
          code: error.code,
          message: error.message,
          rawDetail: error.rawDetail,
          requestId: error.requestId,
        });
      } else {
        setErrorState({ kind: "key", key: "login.errorGeneric" });
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
      className="relative flex min-h-dvh w-full flex-col justify-center bg-[var(--bg-app)] text-[var(--ink-primary)]"
      style={{
        backgroundImage: "var(--bg-login-glow)",
      }}
    >
      {/* Whisper-quiet Floating Frosted Language + Theme Pill (top-right) */}
      <div className="flex justify-end px-5 pt-4 sm:px-8 lg:fixed lg:right-6 lg:top-5 lg:z-30 lg:p-0">
        <PreferencesBar variant="floating" />
      </div>

      {/* Balanced Desktop Grid: items-center so Login Card hugs natural vertical rhythm (zero awkward empty void) */}
      <div className="mx-auto grid w-full max-w-[1340px] grid-cols-1 items-center gap-8 px-5 py-6 sm:px-8 lg:grid-cols-[minmax(420px,468px)_minmax(0,1fr)] lg:gap-10 lg:px-12 lg:py-10">
        {/* Left Floating Porcelain / Obsidian Authentication Card */}
        <section className="mx-auto flex w-full max-w-[468px] flex-col rounded-xl bg-[var(--bg-surface)] p-7 shadow-[var(--shadow-card)] sm:p-9 lg:mx-0">
          {/* Clean Brand Mark */}
          <div className="flex items-center gap-2.5">
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-sm bg-[image:var(--agent-surface)] text-[var(--accent-ink)] ring-1 ring-[var(--agent-ring)]">
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
                {t("brand.name")}
              </div>
              <div className="text-[11.5px] text-[var(--ink-muted)]">
                {t("brand.tagline")}
              </div>
            </div>
          </div>

          <div className="mt-7">
            <h1 className="text-[24px] font-semibold tracking-[-0.025em] text-[var(--ink-primary)]">
              {t("login.heading")}
            </h1>
            <p className="mt-1.5 text-[13.5px] text-[var(--ink-muted)]">
              {t("login.subtitle")}
            </p>
          </div>

          {resolvedErrorMessage && (
            <div
              role="alert"
              data-testid="login-error"
              className="mt-5 rounded-sm bg-[var(--status-crimson-wash)] px-3.5 py-2.5 text-[12.5px] text-[var(--status-crimson)]"
            >
              <div>{resolvedErrorMessage}</div>
              {errorRequestId && (
                <div className="mt-1 text-[11px] opacity-85">
                  <span>{t("common.requestId")}: </span>
                  <span className="font-mono-code">{errorRequestId}</span>
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
                  {t("login.accountLabel")}
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
                    if (errorState) setErrorState(null);
                  }}
                  placeholder={t("login.accountPlaceholder")}
                  className="mt-1.5 h-11 w-full rounded-sm border border-[var(--hairline-strong)] bg-[var(--bg-surface-tint)] px-3.5 text-[14px] text-[var(--ink-primary)] placeholder:text-[var(--ink-faint)] transition-all duration-[150ms] focus:border-[var(--accent)] focus:bg-[var(--bg-surface)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-ring)] disabled:opacity-60"
                />
              </div>

              <div>
                <label
                  htmlFor="login-password"
                  className="block text-[12.5px] font-medium text-[var(--ink-secondary)]"
                >
                  {t("login.passwordLabel")}
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
                      if (errorState) setErrorState(null);
                    }}
                    placeholder={t("login.passwordPlaceholder")}
                    className="h-11 w-full rounded-sm border border-[var(--hairline-strong)] bg-[var(--bg-surface-tint)] pl-3.5 pr-10 text-[14px] text-[var(--ink-primary)] placeholder:text-[var(--ink-faint)] transition-all duration-[150ms] focus:border-[var(--accent)] focus:bg-[var(--bg-surface)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-ring)] disabled:opacity-60"
                  />
                  <button
                    type="button"
                    aria-label={
                      showPassword
                        ? t("login.hidePasswordAria")
                        : t("login.showPasswordAria")
                    }
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
                <span>
                  {submittingForm
                    ? t("login.submitLoading")
                    : t("login.submitIdle")}
                </span>
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
                    {t("login.orDivider")}
                  </span>
                  <div className="h-px w-full bg-[var(--hairline)]" />
                </div>
              )}
              <a
                href="/v1/session/login"
                data-testid="login-oidc-button"
                className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-sm bg-[var(--bg-surface)] px-4 text-[13.5px] font-medium text-[var(--ink-primary)] shadow-[var(--shadow-subtle)] hover:bg-[var(--bg-surface-tint)] hover:shadow-[var(--shadow-card)] transition-all duration-[150ms]"
              >
                <KeyRound
                  className="h-4 w-4 text-[var(--accent)]"
                  strokeWidth={1.85}
                />
                <span>{t("login.oidcButton")}</span>
                <ArrowRight
                  className="h-4 w-4 text-[var(--ink-muted)]"
                  strokeWidth={1.85}
                />
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
                  <span>{t("login.demoHelperToggle")}</span>
                  <span className="rounded-full bg-[var(--accent-wash)] px-2 py-0.5 tabular-nums text-[10.5px] font-semibold text-[var(--accent-ink)]">
                    {tp(
                      {
                        "zh-CN": "{count} 角色",
                        "zh-HK": "{count} 角色",
                        en: { one: "{count} role", other: "{count} roles" },
                      },
                      demoConfig.personas.length,
                    )}
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
                            {t(GROUP_TITLE_KEYS[group])}
                          </div>
                          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                            {items.map((persona) => {
                              const isPending =
                                submittingPersona === persona.subject;
                              const localized = localizePersona(
                                persona.subject,
                                persona,
                              );
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
                                    name={localized.displayName || localized.label}
                                    fallbackText={persona.subject}
                                    size="xs"
                                  />
                                  <div className="min-w-0 flex-1">
                                    <div className="flex items-center justify-between gap-1">
                                      <span className="truncate font-mono-code text-[11.5px] font-semibold text-[var(--ink-primary)]">
                                        {persona.subject}
                                      </span>
                                      <span className="shrink-0 font-mono-code text-[10px] text-[var(--accent-ink)]">
                                        {isPending
                                          ? "…"
                                          : sortWarehouses(persona.warehouses).join("/")}
                                      </span>
                                    </div>
                                    <div className="truncate text-[11px] text-[var(--ink-muted)]">
                                      {localized.displayName
                                        ? `${localized.displayName} · ${localized.label}`
                                        : localized.label}
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

          {demoConfig &&
            !demoConfig.enabled &&
            !demoConfig.oidc_login_enabled && (
              <div className="mt-6 rounded-md bg-[var(--bg-surface-tint)] p-4 text-[13px] text-[var(--ink-secondary)]">
                <p>{t("login.unconfigured")}</p>
                <Button
                  size="sm"
                  variant="secondary"
                  className="mt-3"
                  onClick={() => window.location.reload()}
                >
                  {t("login.recheckConfig")}
                </Button>
              </div>
            )}

          <footer className="mt-6 flex items-center gap-2 border-t border-[var(--hairline)] pt-4 text-[11.5px] text-[var(--ink-muted)]">
            <Lock
              className="h-3.5 w-3.5 shrink-0 text-[var(--accent-ink)]"
              strokeWidth={1.85}
            />
            <span>
              {showPasswordForm ? t("login.footer") : t("login.footerSso")}
            </span>
            <ShieldCheck
              className="ml-auto h-3.5 w-3.5 shrink-0 text-[var(--ink-faint)]"
              strokeWidth={1.85}
            />
          </footer>
        </section>

        {/* Right Desktop Porcelain / Obsidian 3D Architectural Showcase (sheen-only, zero double parallax) */}
        <aside className="hidden lg:block h-[610px] min-h-[580px] max-h-[650px]">
          <Interactive3DCard
            maxTilt={0}
            interactive={false}
            sheenIntensity="medium"
            className="h-full w-full overflow-hidden rounded-xl shadow-[var(--shadow-card)]"
          >
            <ArchitecturalRelayCanvas />
          </Interactive3DCard>
        </aside>

        {/* Mobile Compact Porcelain / Obsidian 3D Preview */}
        <div className="h-[200px] w-full overflow-hidden rounded-lg shadow-[var(--shadow-card)] lg:hidden">
          <ArchitecturalRelayCanvas compact />
        </div>
      </div>
    </div>
  );
}
