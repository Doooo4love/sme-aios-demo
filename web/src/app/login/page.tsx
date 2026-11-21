"use client";

import React, { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, KeyRound, Lock, ShieldCheck } from "lucide-react";
import { isApiError } from "@/lib/api-client";
import { isSafeRelativeRedirect } from "@/lib/format";
import { useSession } from "@/lib/session-context";
import { ArchitecturalRelayCanvas } from "@/components/kinetic/ArchitecturalRelayCanvas";
import { Button } from "@/components/ui/Button";
import type { DemoPersonaId, DemoPersonaMeta } from "@/lib/types";

const GROUP_TITLES: Record<DemoPersonaMeta["group"], string> = {
  core: "核心业务角色",
  specialist: "专岗与只读角色",
  isolation: "跨仓与跨租户隔离验证",
};

const GROUP_ORDER: readonly DemoPersonaMeta["group"][] = [
  "core",
  "specialist",
  "isolation",
];

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { status, demoConfig, loginAsDemo } = useSession();
  const [submittingPersona, setSubmittingPersona] =
    useState<DemoPersonaId | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const safeNext = isSafeRelativeRedirect(searchParams.get("next")) || "/inbox";

  useEffect(() => {
    if (status === "authenticated") {
      router.replace(safeNext);
    }
  }, [status, router, safeNext]);

  const handleDemoLogin = async (persona: DemoPersonaId) => {
    if (submittingPersona) return;
    setSubmittingPersona(persona);
    setErrorMessage(null);
    try {
      const me = await loginAsDemo(persona);
      if (me) {
        router.replace(safeNext);
      } else {
        setErrorMessage("会话校验未通过，请确认后端服务已启动并重试。");
      }
    } catch (error) {
      if (isApiError(error)) {
        setErrorMessage(error.message);
      } else {
        setErrorMessage("登录失败，请稍后重试。");
      }
    } finally {
      setSubmittingPersona(null);
    }
  };

  return (
    <div className="min-h-dvh w-full bg-[var(--bg-canvas)] text-[var(--ink-primary)] grid grid-cols-1 lg:grid-cols-[minmax(380px,460px)_minmax(0,1fr)]">
      {/* Mobile Compact 3D Obsidian Stage Preview */}
      <div className="h-[190px] w-full lg:hidden">
        <ArchitecturalRelayCanvas compact />
      </div>

      {/* Left Precision Authentication Sheet */}
      <section className="flex flex-col justify-between border-r border-[var(--hairline)] bg-[var(--bg-sheet)] px-6 py-8 sm:px-10 sm:py-10">
        <div>
          <div className="flex items-center justify-between border-b border-[var(--hairline)] pb-4">
            <span className="font-mono-code text-[13px] font-semibold tracking-[0.06em] text-[var(--ink-primary)]">
              SME AIOS
            </span>
            <span className="font-mono-code text-[11px] tracking-[0.04em] text-[var(--ink-muted)]">
              OPERATIONS WORKBENCH · V1
            </span>
          </div>

          <div className="mt-7">
            <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-[var(--ink-primary)]">
              登录企业工作台
            </h1>
            <p className="mt-1.5 text-[13.5px] text-[var(--ink-muted)]">
              基于同源企业身份与最小权限边界运行
            </p>
          </div>

          {errorMessage && (
            <div
              role="alert"
              className="mt-5 rounded-[4px] border border-[var(--status-crimson-border)] bg-[var(--status-crimson-wash)] px-3.5 py-2.5 text-[12.5px] text-[var(--status-crimson)]"
            >
              {errorMessage}
            </div>
          )}

          {/* Enterprise OIDC Single Sign-On */}
          {(demoConfig === null || demoConfig.oidc_login_enabled) && (
            <div className="mt-6">
              <a
                href="/v1/session/login"
                className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-[4px] bg-[var(--accent)] px-4 text-[14px] font-medium text-white hover:bg-[var(--accent-hover)] transition-colors duration-[120ms]"
              >
                <KeyRound className="h-4 w-4" strokeWidth={1.75} />
                <span>使用企业单点登录 (OIDC)</span>
                <ArrowRight className="h-4 w-4" strokeWidth={1.75} />
              </a>
            </div>
          )}

          {/* Controlled Local Demo Mode Persona Directory */}
          {demoConfig?.enabled && (
            <div className="mt-6">
              <div className="mb-2.5 flex items-center justify-between">
                <span className="font-mono-code text-[11px] uppercase tracking-[0.04em] text-[var(--ink-muted)]">
                  LOCAL DEMO IDENTITIES · 本地受控演示身份
                </span>
                <span className="font-mono-code text-[11px] text-[var(--accent)]">
                  {demoConfig.personas.length} 角色
                </span>
              </div>

              <div className="space-y-4 max-h-[calc(100dvh-340px)] overflow-auto pr-1">
                {GROUP_ORDER.map((group) => {
                  const items = demoConfig.personas.filter(
                    (p) => p.group === group,
                  );
                  if (items.length === 0) return null;
                  return (
                    <div key={group}>
                      <div className="mb-1.5 font-mono-code text-[10.5px] text-[var(--ink-muted)]">
                        {GROUP_TITLES[group]}
                      </div>
                      <div className="divide-y divide-[var(--hairline)] rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)]">
                        {items.map((persona) => {
                          const busy = submittingPersona === persona.subject;
                          return (
                            <button
                              key={persona.subject}
                              type="button"
                              disabled={submittingPersona !== null}
                              onClick={() => void handleDemoLogin(persona.subject)}
                              className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-[var(--bg-subtle)] transition-colors duration-[120ms] cursor-pointer disabled:opacity-55"
                            >
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                  <span className="font-mono-code text-[12.5px] font-semibold text-[var(--ink-primary)]">
                                    {persona.subject}
                                  </span>
                                  <span className="text-[12px] font-medium text-[var(--ink-secondary)]">
                                    {persona.label}
                                  </span>
                                </div>
                                <div className="mt-0.5 text-[11.5px] text-[var(--ink-muted)] truncate">
                                  {persona.summary}
                                </div>
                              </div>
                              <div className="shrink-0 text-right">
                                <div className="font-mono-code text-[10.5px] text-[var(--ink-muted)]">
                                  {persona.tenant} · {persona.warehouses.join("/")}
                                </div>
                                <div className="mt-0.5 text-[11.5px] font-medium text-[var(--accent)]">
                                  {busy ? "登录中…" : "进入 →"}
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
          )}

          {demoConfig && !demoConfig.enabled && !demoConfig.oidc_login_enabled && (
            <div className="mt-6 rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-subtle)] p-4 text-[13px] text-[var(--ink-secondary)]">
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

        <footer className="mt-8 flex items-center gap-2 border-t border-[var(--hairline)] pt-4 text-[11.5px] text-[var(--ink-muted)]">
          <Lock className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" strokeWidth={1.75} />
          <span>HttpOnly 同源会话 · 租户与仓库实时校验 · 无客户端凭证</span>
          <ShieldCheck className="ml-auto h-3.5 w-3.5 shrink-0 text-[var(--ink-faint)]" strokeWidth={1.75} />
        </footer>
      </section>

      {/* Right Desktop 3D Obsidian Architectural Stage */}
      <aside className="hidden lg:block h-dvh sticky top-0">
        <ArchitecturalRelayCanvas />
      </aside>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-dvh items-center justify-center bg-[var(--bg-canvas)] font-mono-code text-[13px] text-[var(--ink-muted)]">
          正在初始化登录视图…
        </div>
      }
    >
      <LoginContent />
    </Suspense>
  );
}
