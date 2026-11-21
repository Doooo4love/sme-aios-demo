import type { ProposalAction, ProposalState } from "@/lib/types";
import {
  DEFAULT_LOCALE,
  LOCALE_META,
  type Locale,
} from "@/lib/i18n/types";
import {
  localizeActionForLocale,
  localizeRoleForLocale,
  localizeStatusForLocale,
  translateKey,
} from "@/lib/i18n/dictionaries";

/** Canonical enterprise tenant timezone (aligned with HKT labels across Workbench/Admin/Calendar). */
export const DEFAULT_TENANT_TIMEZONE = "Asia/Hong_Kong";

interface ZonedParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
}

const partsFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getZonedParts(date: Date, timeZone: string): ZonedParts {
  let fmt = partsFormatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    partsFormatterCache.set(timeZone, fmt);
  }
  const parts = fmt.formatToParts(date);
  let year = "0000";
  let month = "01";
  let day = "01";
  let hour = "00";
  let minute = "00";
  let second = "00";
  for (const p of parts) {
    if (p.type === "year") year = p.value;
    else if (p.type === "month") month = p.value;
    else if (p.type === "day") day = p.value;
    else if (p.type === "hour") hour = p.value === "24" ? "00" : p.value;
    else if (p.type === "minute") minute = p.value;
    else if (p.type === "second") second = p.value;
  }
  return { year, month, day, hour, minute, second };
}

/**
 * Formats a Unix timestamp (seconds) deterministically in Asia/Hong_Kong (or explicit timeZone).
 */
export function formatUnixTime(
  seconds: number | null | undefined,
  options?: { dateOnly?: boolean; withSeconds?: boolean; timeZone?: string },
  _locale: Locale = DEFAULT_LOCALE,
): string {
  void _locale;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    return "—";
  }
  const tz = options?.timeZone || DEFAULT_TENANT_TIMEZONE;
  const p = getZonedParts(new Date(seconds * 1000), tz);
  const datePart = `${p.year}-${p.month}-${p.day}`;
  if (options?.dateOnly) return datePart;
  const timePart = options?.withSeconds
    ? `${p.hour}:${p.minute}:${p.second}`
    : `${p.hour}:${p.minute}`;
  return `${datePart} ${timePart}`;
}

/**
 * Timezone-explicit `HH:mm` or `HH:mm:ss` formatter (replaces fragile `.slice(11)` string slicing).
 */
export function formatTimeOnly(
  seconds: number | null | undefined,
  options?: { withSeconds?: boolean; timeZone?: string },
  _locale: Locale = DEFAULT_LOCALE,
): string {
  void _locale;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    return "—";
  }
  const tz = options?.timeZone || DEFAULT_TENANT_TIMEZONE;
  const p = getZonedParts(new Date(seconds * 1000), tz);
  return options?.withSeconds
    ? `${p.hour}:${p.minute}:${p.second}`
    : `${p.hour}:${p.minute}`;
}

/**
 * Returns `YYYY-MM-DD` in the tenant timezone (default Asia/Hong_Kong),
 * preventing UTC date rollover before 08:00 HKT (`toISOString().slice(0, 10)` bug).
 */
export function formatLocalIsoDate(
  input: Date | number = new Date(),
  timeZone: string = DEFAULT_TENANT_TIMEZONE,
): string {
  const date = typeof input === "number" ? new Date(input) : input;
  const p = getZonedParts(date, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

export function formatShortRelativeTime(
  unixSeconds: number | null | undefined,
  locale: Locale = DEFAULT_LOCALE,
  timeZone: string = DEFAULT_TENANT_TIMEZONE,
): string {
  if (
    typeof unixSeconds !== "number" ||
    !Number.isFinite(unixSeconds) ||
    unixSeconds <= 0
  ) {
    return "";
  }
  const msgDate = new Date(unixSeconds * 1000);
  const nowDate = new Date();
  const msgParts = getZonedParts(msgDate, timeZone);
  const nowParts = getZonedParts(nowDate, timeZone);

  const startOfTodayUtc = Date.UTC(
    Number(nowParts.year),
    Number(nowParts.month) - 1,
    Number(nowParts.day),
  );
  const startOfMsgDayUtc = Date.UTC(
    Number(msgParts.year),
    Number(msgParts.month) - 1,
    Number(msgParts.day),
  );
  const dayDiff = Math.round((startOfTodayUtc - startOfMsgDayUtc) / 86_400_000);

  if (dayDiff === 0) {
    return `${msgParts.hour}:${msgParts.minute}`;
  }
  if (dayDiff === 1) {
    return translateKey(locale, "common.yesterday");
  }
  if (msgParts.year === nowParts.year) {
    if (locale === "en") {
      return new Intl.DateTimeFormat(LOCALE_META.en.intlLocale, {
        timeZone,
        month: "short",
        day: "numeric",
      }).format(msgDate);
    }
    return `${Number(msgParts.month)}/${Number(msgParts.day)}`;
  }
  if (locale === "en") {
    return new Intl.DateTimeFormat(LOCALE_META.en.intlLocale, {
      timeZone,
      month: "short",
      year: "numeric",
    }).format(msgDate);
  }
  return `${msgParts.year}/${Number(msgParts.month)}`;
}

export function formatLocalizedCurrency(
  amount: number | string | null | undefined,
  currency = "HKD",
  locale: Locale = DEFAULT_LOCALE,
  options?: { fromMinorUnits?: boolean },
): string {
  if (amount === null || amount === undefined || amount === "") return "—";
  const numeric =
    typeof amount === "number"
      ? amount
      : Number(String(amount).replace(/,/g, "").trim());
  const code = (currency || "HKD").trim().toUpperCase();
  if (!Number.isFinite(numeric)) {
    return `${code} ${String(amount)}`;
  }
  const value = options?.fromMinorUnits ? numeric / 100 : numeric;
  const intlLocale = LOCALE_META[locale].intlLocale;
  const formatted = new Intl.NumberFormat(intlLocale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
  return `${code} ${formatted}`;
}

export function formatClockRange(
  startsAt: number,
  endsAt: number,
  timeZone: string = DEFAULT_TENANT_TIMEZONE,
): string {
  const s = getZonedParts(new Date(startsAt * 1000), timeZone);
  const e = getZonedParts(new Date(endsAt * 1000), timeZone);
  return `${s.hour}:${s.minute} – ${e.hour}:${e.minute}`;
}

export function formatShortDigest(
  digest: string | null | undefined,
  head = 8,
  tail = 6,
): string {
  if (!digest) return "—";
  if (digest.length <= head + tail + 2) return digest;
  return `${digest.slice(0, head)}…${digest.slice(-tail)}`;
}

export function formatRelativeCountdown(
  expiresUnixSeconds: number,
  locale: Locale = DEFAULT_LOCALE,
): {
  label: string;
  dueSoon: boolean;
  expired: boolean;
} {
  const diff = Math.floor(expiresUnixSeconds - Date.now() / 1000);
  if (diff <= 0) {
    return {
      label: translateKey(locale, "common.expired"),
      dueSoon: false,
      expired: true,
    };
  }
  const mins = Math.floor(diff / 60);
  const secs = diff % 60;
  if (mins < 5) {
    return {
      label: mins > 0 ? `${mins}m ${String(secs).padStart(2, "0")}s` : `${secs}s`,
      dueSoon: true,
      expired: false,
    };
  }
  if (mins < 60) {
    return {
      label: translateKey(locale, "common.expiresInMinutes", { minutes: mins }),
      dueSoon: false,
      expired: false,
    };
  }
  const hours = Math.floor(mins / 60);
  return {
    label: `${hours}h ${mins % 60}m`,
    dueSoon: false,
    expired: false,
  };
}

export function formatProposalAction(
  action: ProposalAction | string,
  locale: Locale = DEFAULT_LOCALE,
): string {
  return localizeActionForLocale(action, locale);
}

export function formatProposalStateLabel(
  state: ProposalState | string,
  locale: Locale = DEFAULT_LOCALE,
): string {
  return localizeStatusForLocale(state, locale);
}

export function formatRoleLabel(
  role: string,
  locale: Locale = DEFAULT_LOCALE,
): string {
  return localizeRoleForLocale(role, locale);
}

/** Deterministic natural sort for warehouse codes (e.g. HK01, HK02 — never HK02/HK01). */
export function sortWarehouses(warehouses: readonly string[]): string[] {
  return [...warehouses].sort((a, b) =>
    a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }),
  );
}

export function getTenantMark(tenant: string): string {
  const cleaned = tenant.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (cleaned === "HARBOUR") return "HB";
  if (cleaned === "ISLAND") return "IS";
  return (cleaned.slice(0, 2) || "AI").padEnd(2, "X");
}

export function getMonogram(
  name: string | null | undefined,
  fallback: string,
): string {
  const source = (name || fallback || "?").trim();
  if (!source) return "?";
  // For CJK names, take first 2 chars cleanly
  if (/[\u4e00-\u9fff]/.test(source)) {
    return source.slice(0, 2);
  }
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
  }
  return source.slice(0, 2).toUpperCase();
}

export function isSafeRelativeRedirect(
  next: string | null | undefined,
): string | null {
  if (!next) return null;
  if (!next.startsWith("/") || next.startsWith("//") || next.includes("\\")) {
    return null;
  }
  if (next.startsWith("/login")) return "/inbox";
  return next;
}
