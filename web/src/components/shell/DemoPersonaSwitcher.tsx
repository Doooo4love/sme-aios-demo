"use client";

import React, { useState } from "react";
import { DropdownMenu } from "radix-ui";
import { Check, ChevronDown, RefreshCw, Shield } from "lucide-react";
import { useSession } from "@/lib/session-context";
import { Avatar } from "@/components/ui/Avatar";
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

export function DemoPersonaSwitcher({
  side = "bottom",
  align = "end",
}: {
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
}) {
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
              "inline-flex h-8 items-center gap-1.5 rounded-full bg-[var(--bg-surface)] px-3 text-[12px] text-[var(--ink-primary)]",
              "shadow-[var(--shadow-subtle)] hover:shadow-[var(--shadow-card)] hover:bg-[var(--bg-surface-tint)]",
              "transition-all duration-[140ms] cursor-pointer disabled:opacity-50",
            ].join(" ")}
          >
            {switchingPersona ? (
              <RefreshCw
                className="h-3.5 w-3.5 animate-spin text-[var(--accent)]"
                strokeWidth={1.85}
              />
            ) : (
              <Shield
                className="h-3.5 w-3.5 text-[var(--accent)]"
                strokeWidth={1.85}
              />
            )}
            <span className="font-mono-code font-medium">{actor.subject}</span>
            <span className="hidden sm:inline text-[var(--ink-muted)] font-mono-code text-[11px]">
              · {actor.tenant}
              {actor.warehouses.length > 0 ? ` · ${actor.warehouses.join("/")}` : ""}
            </span>
            <ChevronDown
              className="h-3.5 w-3.5 text-[var(--ink-muted)]"
              strokeWidth={1.85}
            />
          </button>
        </DropdownMenu.Trigger>

        <DropdownMenu.Portal>
          <DropdownMenu.Content
            side={side}
            align={align}
            sideOffset={8}
            className={[
              "z-50 w-[328px] max-h-[min(520px,80dvh)] overflow-auto rounded-lg",
              "bg-[var(--bg-surface)] p-2 shadow-[var(--shadow-popover)] focus:outline-none",
            ].join(" ")}
          >
            <div className="border-b border-[var(--hairline)] px-2.5 pb-2.5 pt-1">
              <div className="text-[12.5px] font-semibold text-[var(--ink-primary)]">
                本地演示身份切换
              </div>
              <div className="mt-0.5 text-[11.5px] text-[var(--ink-muted)]">
                切换时自动清空会话缓存、草稿与在途请求
              </div>
              {errorMsg && (
                <div className="mt-1.5 text-[11.5px] text-[var(--status-crimson)]">
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
                <DropdownMenu.Group key={group} className="mt-2">
                  <DropdownMenu.Label className="px-2.5 py-1 text-[11px] font-medium text-[var(--ink-muted)]">
                    {GROUP_LABELS[group]}
                  </DropdownMenu.Label>
                  {items.map((item) => {
                    const isCurrent = item.subject === actor.subject;
                    return (
                      <DropdownMenu.Item
                        key={item.subject}
                        data-testid={`persona-option-${item.subject}`}
                        disabled={switchingPersona}
                        onSelect={() => void handleSwitch(item.subject)}
                        className={[
                          "flex cursor-pointer items-center gap-2.5 rounded-sm px-2.5 py-2 outline-none",
                          "transition-colors duration-[140ms]",
                          isCurrent
                            ? "bg-[var(--accent-wash)] text-[var(--ink-primary)]"
                            : "hover:bg-[var(--bg-hover)] focus:bg-[var(--bg-hover)]",
                        ].join(" ")}
                      >
                        <Avatar
                          name={item.display_name || item.label}
                          fallbackText={item.subject}
                          size="xs"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="font-mono-code text-[12px] font-semibold text-[var(--ink-primary)]">
                              {item.subject}
                            </span>
                            <span className="truncate text-[11.5px] text-[var(--ink-secondary)]">
                              {item.display_name
                                ? `${item.display_name} · ${item.label}`
                                : item.label}
                            </span>
                          </div>
                          <div className="mt-0.5 font-mono-code text-[10.5px] text-[var(--ink-muted)]">
                            {item.tenant} · {item.warehouses.join(", ")} ·{" "}
                            {item.role}
                          </div>
                        </div>
                        {isCurrent && (
                          <Check
                            className="h-4 w-4 shrink-0 text-[var(--accent)]"
                            strokeWidth={2.2}
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
