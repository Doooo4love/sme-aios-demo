"use client";

import React from "react";
import { DropdownMenu } from "radix-ui";
import { Check, Globe, Moon, Sun } from "lucide-react";
import {
  LOCALE_META,
  SUPPORTED_LOCALES,
  useLocale,
  type Locale,
} from "@/lib/i18n";
import { useTheme } from "@/lib/theme-context";

export interface LanguageSwitcherProps {
  /** "segmented" renders 1-click 简/繁/EN pill buttons; "dropdown" renders a compact Globe trigger menu. Default: "segmented" */
  variant?: "segmented" | "dropdown";
  size?: "sm" | "md";
  /** Omit outer inset track when embedded directly inside a floating frosted capsule (prevents pill-in-pill heaviness). */
  bare?: boolean;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  className?: string;
}

export function LanguageSwitcher({
  variant = "segmented",
  size = "sm",
  bare = false,
  side = "bottom",
  align = "end",
  className = "",
}: LanguageSwitcherProps) {
  const { locale, setLocale, t } = useLocale();

  if (variant === "dropdown") {
    const activeMeta = LOCALE_META[locale];
    return (
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            data-testid="locale-switcher"
            aria-label={t("prefs.languageAria")}
            title={`${t("prefs.languageLabel")}: ${activeMeta.nativeLabel}`}
            className={[
              "inline-flex items-center gap-1 rounded-full bg-[var(--bg-surface)] text-[var(--ink-secondary)]",
              "shadow-[var(--shadow-subtle)] hover:bg-[var(--bg-surface-tint)] hover:text-[var(--ink-primary)]",
              "transition-colors duration-[140ms] cursor-pointer",
              size === "sm"
                ? "h-8 px-2.5 text-[11.5px] [@media(pointer:coarse)]:h-9"
                : "h-9 px-3 text-[12px]",
              className,
            ].join(" ")}
          >
            <Globe className="h-3.5 w-3.5 text-[var(--ink-muted)]" strokeWidth={1.8} />
            <span lang={activeMeta.htmlLang} className="font-medium">
              {activeMeta.shortLabel}
            </span>
          </button>
        </DropdownMenu.Trigger>

        <DropdownMenu.Portal>
          <DropdownMenu.Content
            side={side}
            align={align}
            sideOffset={8}
            className="z-50 w-[168px] rounded-lg bg-[var(--bg-surface)] p-1.5 shadow-[var(--shadow-popover)] focus:outline-none"
          >
            <DropdownMenu.Label className="px-2.5 py-1 text-[11px] font-medium text-[var(--ink-muted)]">
              {t("prefs.languageLabel")}
            </DropdownMenu.Label>
            {SUPPORTED_LOCALES.map((code: Locale) => {
              const meta = LOCALE_META[code];
              const active = locale === code;
              return (
                <DropdownMenu.Item
                  key={code}
                  data-testid={`locale-option-${code}`}
                  lang={meta.htmlLang}
                  onSelect={() => setLocale(code)}
                  className={[
                    "flex cursor-pointer items-center justify-between gap-2 rounded-sm px-2.5 py-1.5 text-[12.5px] outline-none transition-colors",
                    active
                      ? "bg-[var(--accent-wash)] font-medium text-[var(--accent-ink)]"
                      : "text-[var(--ink-primary)] hover:bg-[var(--bg-hover)] focus:bg-[var(--bg-hover)]",
                  ].join(" ")}
                >
                  <span>{meta.nativeLabel}</span>
                  {active && <Check className="h-3.5 w-3.5 shrink-0" strokeWidth={2.2} />}
                </DropdownMenu.Item>
              );
            })}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    );
  }

  return (
    <div
      role="group"
      data-testid="locale-switcher"
      aria-label={t("prefs.languageAria")}
      className={[
        "inline-flex items-center gap-0.5 rounded-full",
        bare ? "" : "bg-[var(--bg-inset)] p-0.5 ring-1 ring-[var(--hairline)]",
        className,
      ].join(" ")}
    >
      {SUPPORTED_LOCALES.map((code: Locale) => {
        const meta = LOCALE_META[code];
        const active = locale === code;
        return (
          <button
            key={code}
            type="button"
            lang={meta.htmlLang}
            data-testid={`locale-option-${code}`}
            aria-label={meta.nativeLabel}
            aria-pressed={active}
            title={meta.nativeLabel}
            onClick={() => setLocale(code)}
            className={[
              "inline-flex items-center justify-center rounded-full font-medium select-none transition-all duration-[140ms] cursor-pointer",
              size === "sm"
                ? "h-7 min-w-[28px] px-2 text-[11.5px] [@media(pointer:coarse)]:h-9 [@media(pointer:coarse)]:min-w-[36px]"
                : "h-8 min-w-[32px] px-2.5 text-[12px] [@media(pointer:coarse)]:h-9 [@media(pointer:coarse)]:min-w-[36px]",
              active
                ? "bg-[var(--bg-surface)] text-[var(--accent-ink)] shadow-[var(--shadow-subtle)] ring-1 ring-[var(--hairline-strong)] font-semibold"
                : "text-[var(--ink-muted)] hover:text-[var(--ink-primary)] hover:bg-[var(--bg-hover)]",
            ].join(" ")}
          >
            {meta.shortLabel}
          </button>
        );
      })}
    </div>
  );
}

export interface ThemeToggleProps {
  size?: "sm" | "md";
  showLabel?: boolean;
  className?: string;
}

export function ThemeToggle({
  size = "sm",
  showLabel = false,
  className = "",
}: ThemeToggleProps) {
  const { theme, toggleTheme } = useTheme();
  const { t } = useLocale();
  const isDark = theme === "dark";
  // Action label without conflicting aria-pressed (announces clear action cleanly in VoiceOver/NVDA)
  const actionLabel = isDark ? t("prefs.switchToLight") : t("prefs.switchToDark");

  return (
    <button
      type="button"
      data-testid="theme-toggle-btn"
      aria-label={actionLabel}
      title={actionLabel}
      onClick={toggleTheme}
      className={[
        "inline-flex items-center justify-center rounded-full text-[var(--ink-secondary)]",
        "hover:bg-[var(--bg-hover)] hover:text-[var(--ink-primary)]",
        "transition-colors duration-[140ms] cursor-pointer select-none",
        showLabel
          ? size === "sm"
            ? "h-7 gap-1.5 px-2.5 text-[11.5px] font-medium [@media(pointer:coarse)]:h-9"
            : "h-8 gap-1.5 px-3 text-[12px] font-medium [@media(pointer:coarse)]:h-9"
          : size === "sm"
            ? "h-7 w-7 [@media(pointer:coarse)]:h-9 [@media(pointer:coarse)]:w-9"
            : "h-8 w-8 [@media(pointer:coarse)]:h-9 [@media(pointer:coarse)]:w-9",
        className,
      ].join(" ")}
    >
      {isDark ? (
        <Sun className="h-[15px] w-[15px] text-[var(--status-amber-ink)]" strokeWidth={1.85} />
      ) : (
        <Moon className="h-[15px] w-[15px]" strokeWidth={1.85} />
      )}
      {showLabel && (
        <span>{isDark ? t("prefs.themeDark") : t("prefs.themeLight")}</span>
      )}
    </button>
  );
}

export interface PreferencesBarProps {
  variant?: "floating" | "inline" | "compact";
  languageVariant?: "segmented" | "dropdown";
  hidden?: boolean;
  className?: string;
}

export function PreferencesBar({
  variant = "inline",
  languageVariant = "segmented",
  hidden = false,
  className = "",
}: PreferencesBarProps) {
  if (hidden) return null;
  const isFloating = variant === "floating";

  return (
    <div
      data-testid="preferences-bar"
      className={[
        "inline-flex items-center gap-1.5",
        isFloating
          ? "aios-topbar-glass rounded-full px-1.5 py-1 shadow-[var(--shadow-floating)] ring-1 ring-[var(--hairline-strong)]"
          : variant === "compact"
            ? "rounded-full px-1 py-0.5"
            : "rounded-full",
        className,
      ].join(" ")}
    >
      <LanguageSwitcher variant={languageVariant} size="sm" bare={isFloating} />
      <span
        aria-hidden="true"
        className="h-3.5 w-px bg-[var(--hairline-strong)]"
      />
      <ThemeToggle size="sm" />
    </div>
  );
}
