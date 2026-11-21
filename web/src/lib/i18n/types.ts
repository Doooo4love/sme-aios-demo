export type Locale = "zh-CN" | "zh-HK" | "en";

export const SUPPORTED_LOCALES = ["zh-CN", "zh-HK", "en"] as const;

export const DEFAULT_LOCALE: Locale = "zh-CN";

export const LOCALE_COOKIE_NAME = "aios_locale";

export type TrilingualText = Readonly<Record<Locale, string>>;

export interface PluralText {
  readonly "zh-CN": string;
  readonly "zh-HK": string;
  readonly en: Readonly<{ one: string; other: string }>;
}

export type LocaleVars = Record<
  string,
  string | number | boolean | null | undefined
>;

export interface LocaleDescriptor {
  code: Locale;
  shortLabel: string;
  nativeLabel: string;
  htmlLang: string;
  intlLocale: string;
}

export const LOCALE_META: Readonly<Record<Locale, LocaleDescriptor>> = {
  "zh-CN": {
    code: "zh-CN",
    shortLabel: "简",
    nativeLabel: "简体中文",
    htmlLang: "zh-CN",
    intlLocale: "zh-CN",
  },
  "zh-HK": {
    code: "zh-HK",
    shortLabel: "繁",
    nativeLabel: "繁體中文",
    htmlLang: "zh-HK",
    intlLocale: "zh-HK",
  },
  en: {
    code: "en",
    shortLabel: "EN",
    nativeLabel: "English",
    htmlLang: "en",
    intlLocale: "en-HK",
  },
};

export interface LocalizedPersonaInfo {
  displayName: string;
  label: string;
  summary: string;
  department: string;
}

export function isSupportedLocale(value: unknown): value is Locale {
  return value === "zh-CN" || value === "zh-HK" || value === "en";
}

export function normalizeLocale(raw: string | null | undefined): Locale {
  if (!raw) return DEFAULT_LOCALE;
  const trimmed = raw.trim();
  if (isSupportedLocale(trimmed)) return trimmed;
  const lower = trimmed.toLowerCase();
  if (
    lower === "zh-hk" ||
    lower === "zh-tw" ||
    lower === "zh-hant" ||
    lower.startsWith("zh-hant-")
  ) {
    return "zh-HK";
  }
  if (lower === "en" || lower.startsWith("en-")) {
    return "en";
  }
  return DEFAULT_LOCALE;
}

export function interpolateTemplate(
  template: string,
  vars?: LocaleVars,
): string {
  if (!vars) return template;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key: string) => {
    const val = vars[key];
    if (val === undefined || val === null) return match;
    return String(val);
  });
}

const pluralRulesCache = new Map<string, Intl.PluralRules>();

function getPluralRules(intlLocale: string): Intl.PluralRules {
  let rules = pluralRulesCache.get(intlLocale);
  if (!rules) {
    rules = new Intl.PluralRules(intlLocale);
    pluralRulesCache.set(intlLocale, rules);
  }
  return rules;
}

export function formatPluralText(
  locale: Locale,
  text: PluralText,
  count: number,
  vars?: LocaleVars,
): string {
  const mergedVars: LocaleVars = { count, ...vars };
  if (locale === "en") {
    const category = getPluralRules(LOCALE_META.en.intlLocale).select(count);
    const template = category === "one" ? text.en.one : text.en.other;
    return interpolateTemplate(template, mergedVars);
  }
  const template = text[locale] ?? text[DEFAULT_LOCALE];
  return interpolateTemplate(template, mergedVars);
}

export function readCookieValue(name: string): string | null {
  if (typeof document === "undefined" || !document.cookie) return null;
  const prefix = `${name}=`;
  const parts = document.cookie.split(";");
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      try {
        return decodeURIComponent(trimmed.slice(prefix.length));
      } catch {
        return trimmed.slice(prefix.length);
      }
    }
  }
  return null;
}

export function writePreferenceCookie(name: string, value: string): void {
  if (typeof document === "undefined") return;
  document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=31536000; SameSite=Lax`;
}
