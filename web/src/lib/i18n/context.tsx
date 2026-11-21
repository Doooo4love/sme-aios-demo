"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  formatLocalIsoDate,
  formatLocalizedCurrency,
  formatRelativeCountdown,
  formatShortRelativeTime,
  formatTimeOnly,
  formatUnixTime,
} from "@/lib/format";
import type { DemoPersonaMeta } from "@/lib/types";
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE_NAME,
  LOCALE_META,
  formatPluralText,
  normalizeLocale,
  readCookieValue,
  writePreferenceCookie,
  type Locale,
  type LocaleVars,
  type LocalizedPersonaInfo,
  type PluralText,
  type TrilingualText,
} from "@/lib/i18n/types";
import {
  localizeActionForLocale,
  localizeErrorMessageForLocale,
  localizeNoticeKindForLocale,
  localizePersonaForLocale,
  localizeRoleForLocale,
  localizeSourceForLocale,
  localizeStatusForLocale,
  localizeTimelineEventForLocale,
  localizeToolForLocale,
  translateInline,
  translateKey,
  type TranslationKey,
} from "@/lib/i18n/dictionaries";

export interface LocaleContextValue {
  locale: Locale;
  setLocale: (next: Locale) => void;
  t: (key: TranslationKey, vars?: LocaleVars) => string;
  tx: (text: TrilingualText, vars?: LocaleVars) => string;
  /** Plural-aware inline translator backed by Intl.PluralRules (`{ count }` auto-injected). */
  tp: (text: PluralText, count: number, vars?: LocaleVars) => string;
  formatDateTime: (
    unixSeconds: number | null | undefined,
    options?: { dateOnly?: boolean; withSeconds?: boolean; timeZone?: string },
  ) => string;
  formatTimeOnly: (
    unixSeconds: number | null | undefined,
    options?: { withSeconds?: boolean; timeZone?: string },
  ) => string;
  formatLocalIsoDate: (input?: Date | number, timeZone?: string) => string;
  formatShortTime: (unixSeconds: number | null | undefined) => string;
  formatCurrency: (
    amount: number | string | null | undefined,
    currency?: string,
    options?: { fromMinorUnits?: boolean },
  ) => string;
  formatCountdown: (expiresUnixSeconds: number) => {
    label: string;
    dueSoon: boolean;
    expired: boolean;
  };
  localizeStatus: (status: string, options?: { compact?: boolean }) => string;
  localizeAction: (action: string) => string;
  localizeTimelineEvent: (event: string) => {
    label: string;
    tone: "neutral" | "emerald" | "amber" | "crimson";
  };
  localizePersona: (
    subject: string,
    fallback?: Partial<DemoPersonaMeta>,
  ) => LocalizedPersonaInfo;
  localizeRole: (role: string) => string;
  localizeSource: (source: string) => string;
  localizeTool: (toolId: string) => string;
  localizeNoticeKind: (kind: string) => string;
  localizeError: (
    error:
      | {
          status?: number;
          code?: string;
          message?: string;
          rawDetail?: unknown;
        }
      | null
      | undefined,
  ) => string;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({
  initialLocale = DEFAULT_LOCALE,
  children,
}: {
  initialLocale?: Locale;
  children: React.ReactNode;
}) {
  const [locale, setLocaleState] = useState<Locale>(() =>
    normalizeLocale(initialLocale),
  );

  // Sync with cookie if client navigated before hydration or changed in another tab
  useEffect(() => {
    const fromCookie = readCookieValue(LOCALE_COOKIE_NAME);
    if (fromCookie) {
      const normalized = normalizeLocale(fromCookie);
      setLocaleState((prev) => (prev === normalized ? prev : normalized));
    }
  }, []);

  // Keep <html lang> and document.title synced with active locale
  useEffect(() => {
    if (typeof document === "undefined") return;
    const meta = LOCALE_META[locale];
    if (document.documentElement.lang !== meta.htmlLang) {
      document.documentElement.lang = meta.htmlLang;
    }
    const localizedTitle = translateKey(locale, "brand.title");
    if (document.title !== localizedTitle) {
      document.title = localizedTitle;
    }
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    const normalized = normalizeLocale(next);
    setLocaleState(normalized);
    writePreferenceCookie(LOCALE_COOKIE_NAME, normalized);
    if (typeof document !== "undefined") {
      document.documentElement.lang = LOCALE_META[normalized].htmlLang;
      document.title = translateKey(normalized, "brand.title");
    }
  }, []);

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      setLocale,
      t: (key, vars) => translateKey(locale, key, vars),
      tx: (text, vars) => translateInline(locale, text, vars),
      tp: (text, count, vars) => formatPluralText(locale, text, count, vars),
      formatDateTime: (unixSeconds, options) =>
        formatUnixTime(unixSeconds, options, locale),
      formatTimeOnly: (unixSeconds, options) =>
        formatTimeOnly(unixSeconds, options, locale),
      formatLocalIsoDate: (input, timeZone) =>
        formatLocalIsoDate(input, timeZone),
      formatShortTime: (unixSeconds) =>
        formatShortRelativeTime(unixSeconds, locale),
      formatCurrency: (amount, currency, options) =>
        formatLocalizedCurrency(amount, currency, locale, options),
      formatCountdown: (expiresUnixSeconds) =>
        formatRelativeCountdown(expiresUnixSeconds, locale),
      localizeStatus: (status, options) =>
        localizeStatusForLocale(status, locale, options),
      localizeAction: (action) => localizeActionForLocale(action, locale),
      localizeTimelineEvent: (event) =>
        localizeTimelineEventForLocale(event, locale),
      localizePersona: (subject, fallback) =>
        localizePersonaForLocale(subject, locale, fallback),
      localizeRole: (role) => localizeRoleForLocale(role, locale),
      localizeSource: (source) => localizeSourceForLocale(source, locale),
      localizeTool: (toolId) => localizeToolForLocale(toolId, locale),
      localizeNoticeKind: (kind) => localizeNoticeKindForLocale(kind, locale),
      localizeError: (error) =>
        error ? localizeErrorMessageForLocale(error, locale) : "",
    }),
    [locale, setLocale],
  );

  return (
    <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
  );
}

export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) {
    throw new Error("useLocale must be used within a LocaleProvider");
  }
  return ctx;
}
