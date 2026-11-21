"use client";

import React, { useState } from "react";
import { DropdownMenu } from "radix-ui";
import { Check, ChevronDown, RefreshCw, Shield } from "lucide-react";
import { sortWarehouses } from "@/lib/format";
import { useLocale, type TranslationKey } from "@/lib/i18n";
import { useSession } from "@/lib/session-context";
import { Avatar } from "@/components/ui/Avatar";
import type { DemoPersonaId, DemoPersonaMeta } from "@/lib/types";

const GROUP_LABEL_KEYS: Record<DemoPersonaMeta["group"], TranslationKey> = {
  core: "demo.group.core",
  specialist: "demo.group.specialist",
  isolation: "demo.group.isolation",
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
  const { t, localizePersona, localizeRole } = useLocale();
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!demoConfig?.enabled || !actor) {
    return null;
  }

  const currentMeta = demoConfig.personas.find(
    (p) => p.subject === actor.subject,
  );
  const currentLocalized = localizePersona(actor.subject, currentMeta);
  const currentDisplayName =
    currentLocalized.displayName || currentLocalized.label || actor.subject;
  const sortedActorWarehouses = sortWarehouses(actor.warehouses);
  const triggerTooltip = `${currentDisplayName} (${actor.subject}) · ${actor.tenant}${
    sortedActorWarehouses.length > 0
      ? ` · ${sortedActorWarehouses.join("/")}`
      : ""
  }`;

  const handleSwitch = async (persona: DemoPersonaId) => {
    if (persona === actor.subject || switchingPersona) return;
    setErrorMsg(null);
    try {
      await switchDemoPersona(persona);
    } catch {
      setErrorMsg(t("demo.switchFailed"));
    }
  };

  return (
    <div className="relative flex items-center">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            disabled={switchingPersona}
            aria-label={t("demo.switcherAria")}
            title={triggerTooltip}
            className={[
              "inline-flex h-8 items-center gap-1.5 rounded-full bg-[var(--bg-surface)] px-2.5 xl:px-3 text-[12px] text-[var(--ink-primary)]",
              "shadow-[var(--shadow-subtle)] hover:shadow-[var(--shadow-card)] hover:bg-[var(--bg-surface-tint)]",
              "transition-all duration-[140ms] cursor-pointer disabled:opacity-50",
            ].join(" ")}
          >
            {switchingPersona ? (
              <RefreshCw
                className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--accent-ink)]"
                strokeWidth={1.85}
              />
            ) : (
              <Shield
                className="h-3.5 w-3.5 shrink-0 text-[var(--accent-ink)]"
                strokeWidth={1.85}
              />
            )}
            <span className="max-w-[96px] xl:max-w-[120px] 2xl:max-w-none truncate font-medium">
              {currentDisplayName}
            </span>
            {sortedActorWarehouses.length > 0 && (
              <span className="hidden min-[1360px]:inline shrink-0 font-mono-code text-[11px] text-[var(--ink-muted)]">
                · {sortedActorWarehouses.join("/")}
              </span>
            )}
            <ChevronDown
              className="h-3.5 w-3.5 shrink-0 text-[var(--ink-muted)]"
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
              "z-50 w-[336px] max-h-[min(520px,80dvh)] overflow-auto rounded-lg",
              "bg-[var(--bg-surface)] p-2 shadow-[var(--shadow-popover)] focus:outline-none",
            ].join(" ")}
          >
            <div className="border-b border-[var(--hairline)] px-2.5 pb-2.5 pt-1">
              <div className="text-[12.5px] font-semibold text-[var(--ink-primary)]">
                {t("demo.switcherTitle")}
              </div>
              <div className="mt-0.5 text-[11.5px] text-[var(--ink-muted)]">
                {t("demo.switcherSubtitle")}
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
                    {t(GROUP_LABEL_KEYS[group])}
                  </DropdownMenu.Label>
                  {items.map((item) => {
                    const isCurrent = item.subject === actor.subject;
                    const localized = localizePersona(item.subject, item);
                    const sortedItemWarehouses = sortWarehouses(item.warehouses);
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
                          name={localized.displayName || localized.label}
                          fallbackText={item.subject}
                          size="xs"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="font-mono-code text-[12px] font-semibold text-[var(--ink-primary)]">
                              {item.subject}
                            </span>
                            <span className="truncate text-[11.5px] text-[var(--ink-secondary)]">
                              {localized.displayName
                                ? `${localized.displayName} · ${localized.label}`
                                : localized.label}
                            </span>
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[10.5px] text-[var(--ink-muted)]">
                            <span className="font-mono-code">{item.tenant}</span>
                            {sortedItemWarehouses.length > 0 && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="font-mono-code">
                                  {sortedItemWarehouses.join(", ")}
                                </span>
                              </>
                            )}
                            <span aria-hidden="true">·</span>
                            <span>{localizeRole(item.role)}</span>
                          </div>
                        </div>
                        {isCurrent && (
                          <Check
                            className="h-4 w-4 shrink-0 text-[var(--accent-ink)]"
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
