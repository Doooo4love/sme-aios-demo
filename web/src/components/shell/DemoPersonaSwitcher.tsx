"use client";

import React, { useState } from "react";
import { DropdownMenu } from "radix-ui";
import { Check, ChevronDown, RefreshCw, Shield } from "lucide-react";
import { useSession } from "@/lib/session-context";
import type { DemoPersonaId, DemoPersonaMeta } from "@/lib/types";

const GROUP_LABELS: Record<DemoPersonaMeta["group"], string> = {
  core: "核心演示岗位",
  specialist: "专岗与只读视图",
  isolation: "跨仓 / 跨租户隔离验证",
};

const GROUP_ORDER: readonly DemoPersonaMeta["group"][] = [
  "core",
  "specialist",
  "isolation",
];

export function DemoPersonaSwitcher() {
  const { actor, demoConfig, switchingPersona, switchDemoPersona } =
    useSession();
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!demoConfig?.enabled || !actor) {
    return null;
  }

  const handleSwitch = async (persona: DemoPersonaId) => {
    if (persona === actor.subject || switchingPersona) return;
    setErrorMsg(null);
    try {
      await switchDemoPersona(persona);
    } catch {
      setErrorMsg("切换身份失败，请重试");
    }
  };

  return (
    <div className="relative flex items-center">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            disabled={switchingPersona}
            aria-label="切换本地演示身份"
            className={[
              "inline-flex h-8 items-center gap-1.5 rounded-[4px] border border-[var(--hairline-strong)]",
              "bg-[var(--bg-subtle)] px-2.5 text-[12px] text-[var(--ink-primary)]",
              "hover:bg-[var(--bg-plane)] transition-colors duration-[120ms] cursor-pointer disabled:opacity-50",
            ].join(" ")}
          >
            {switchingPersona ? (
              <RefreshCw
                className="h-3.5 w-3.5 animate-spin text-[var(--accent)]"
                strokeWidth={1.75}
              />
            ) : (
              <Shield
                className="h-3.5 w-3.5 text-[var(--accent)]"
                strokeWidth={1.75}
              />
            )}
            <span className="font-mono-code font-medium">{actor.subject}</span>
            <span className="hidden sm:inline text-[var(--ink-muted)] font-mono-code text-[11px]">
              ({actor.tenant})
            </span>
            <ChevronDown
              className="h-3.5 w-3.5 text-[var(--ink-muted)]"
              strokeWidth={1.75}
            />
          </button>
        </DropdownMenu.Trigger>

        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={6}
            className={[
              "z-50 w-[320px] max-h-[min(520px,80dvh)] overflow-auto rounded-[6px]",
              "border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] p-1.5 shadow-[var(--shadow-popover)]",
            ].join(" ")}
          >
            <div className="border-b border-[var(--hairline)] px-2.5 py-2">
              <div className="text-[12px] font-semibold text-[var(--ink-primary)]">
                本地演示身份切换
              </div>
              <div className="mt-0.5 text-[11px] text-[var(--ink-muted)]">
                切换时将清空会话缓存、草稿与所有在途请求
              </div>
              {errorMsg && (
                <div className="mt-1 text-[11.5px] text-[var(--status-crimson)]">
                  {errorMsg}
                </div>
              )}
            </div>

            {GROUP_ORDER.map((group) => {
              const items = demoConfig.personas.filter(
                (p) => p.group === group,
              );
              if (items.length === 0) return null;
              return (
                <DropdownMenu.Group key={group} className="mt-1.5">
                  <DropdownMenu.Label className="px-2.5 py-1 font-mono-code text-[10.5px] uppercase tracking-[0.04em] text-[var(--ink-muted)]">
                    {GROUP_LABELS[group]}
                  </DropdownMenu.Label>
                  {items.map((item) => {
                    const isCurrent = item.subject === actor.subject;
                    return (
                      <DropdownMenu.Item
                        key={item.subject}
                        disabled={switchingPersona}
                        onSelect={() => void handleSwitch(item.subject)}
                        className={[
                          "flex cursor-pointer items-start justify-between gap-2 rounded-[4px] px-2.5 py-1.5 outline-none",
                          "transition-colors duration-[120ms]",
                          isCurrent
                            ? "bg-[var(--accent-wash)] text-[var(--ink-primary)]"
                            : "hover:bg-[var(--bg-subtle)] focus:bg-[var(--bg-subtle)]",
                        ].join(" ")}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="font-mono-code text-[12px] font-semibold text-[var(--ink-primary)]">
                              {item.subject}
                            </span>
                            <span className="text-[11.5px] text-[var(--ink-secondary)]">
                              {item.label}
                            </span>
                          </div>
                          <div className="mt-0.5 font-mono-code text-[10.5px] text-[var(--ink-muted)]">
                            {item.tenant} · {item.warehouses.join(", ")} ·{" "}
                            {item.role}
                          </div>
                        </div>
                        {isCurrent && (
                          <Check
                            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--accent)]"
                            strokeWidth={2}
                          />
                        )}
                      </DropdownMenu.Item>
                    );
                  })}
                </DropdownMenu.Group>
              );
            })}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}
