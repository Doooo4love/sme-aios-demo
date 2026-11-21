import type {
  DemoPersonaMeta,
  NoticeKind,
  ProposalAction,
  ProposalState,
  Role,
} from "@/lib/types";
import {
  DEFAULT_LOCALE,
  interpolateTemplate,
  type Locale,
  type LocaleVars,
  type LocalizedPersonaInfo,
  type TrilingualText,
} from "@/lib/i18n/types";
import {
  COMMON_DICTIONARY,
  COMPACT_PROPOSAL_STATE_LABELS_I18N,
  ERROR_CODE_MESSAGES_I18N,
  NOTICE_KIND_LABELS_I18N,
  PERSONA_LOCALIZATIONS,
  PROPOSAL_ACTION_LABELS_I18N,
  RAW_DETAIL_TRANSLATIONS_I18N,
  ROLE_LABELS_I18N,
  SOURCE_LABELS_I18N,
  STATUS_LABELS_I18N,
  TOOL_LABELS_I18N,
  resolveLocalizedPersona,
} from "@/lib/i18n/dictionaries/common";
import { MESSENGER_DICTIONARY } from "@/lib/i18n/dictionaries/messenger";
import {
  ASSURANCE_FIELD_LABELS_I18N,
  ASSURANCE_KIND_LABELS_I18N,
  ASSURANCE_TRACK_LABELS_I18N,
  TIMELINE_EVENT_LABELS_I18N,
  WORKBENCH_DICTIONARY,
} from "@/lib/i18n/dictionaries/workbench";
import {
  ADMIN_DICTIONARY,
  GRANT_LABELS_I18N,
  MODULE_ACCESS_META_I18N,
  TIMEZONE_LABELS_I18N,
} from "@/lib/i18n/dictionaries/admin";

export const DICTIONARY = {
  ...COMMON_DICTIONARY,
  ...MESSENGER_DICTIONARY,
  ...WORKBENCH_DICTIONARY,
  ...ADMIN_DICTIONARY,
} as const satisfies Record<string, TrilingualText>;

export type TranslationKey = keyof typeof DICTIONARY;

export function translateKey(
  locale: Locale,
  key: TranslationKey,
  vars?: LocaleVars,
): string {
  const entry = DICTIONARY[key];
  const raw = entry[locale] ?? entry[DEFAULT_LOCALE];
  return interpolateTemplate(raw, vars);
}

export function translateInline(
  locale: Locale,
  text: TrilingualText,
  vars?: LocaleVars,
): string {
  const raw = text[locale] ?? text[DEFAULT_LOCALE];
  return interpolateTemplate(raw, vars);
}

export function localizeStatusForLocale(
  status: string,
  locale: Locale = DEFAULT_LOCALE,
  options?: { compact?: boolean },
): string {
  if (options?.compact) {
    const compactEntry =
      COMPACT_PROPOSAL_STATE_LABELS_I18N[status as ProposalState];
    if (compactEntry) return compactEntry[locale];
  }
  const entry = STATUS_LABELS_I18N[status];
  if (entry) return entry[locale];
  return status;
}

export function localizeActionForLocale(
  action: ProposalAction | string,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const entry = PROPOSAL_ACTION_LABELS_I18N[action as ProposalAction];
  return entry ? entry[locale] : action;
}

export function localizeRoleForLocale(
  role: Role | string,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const entry = ROLE_LABELS_I18N[role as Role];
  return entry ? entry[locale] : role;
}

export function localizeSourceForLocale(
  source: string,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const entry = SOURCE_LABELS_I18N[source.toLowerCase()];
  return entry ? entry[locale] : source;
}

export function localizeToolForLocale(
  toolId: string,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const entry = TOOL_LABELS_I18N[toolId];
  return entry ? entry[locale] : toolId;
}

export function localizeNoticeKindForLocale(
  kind: NoticeKind | string,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const entry = NOTICE_KIND_LABELS_I18N[kind as NoticeKind];
  if (entry) return entry[locale];
  return locale === "en"
    ? "Workbench notification"
    : locale === "zh-HK"
      ? "工作台通知"
      : "工作台通知";
}

export function localizeTimelineEventForLocale(
  rawEvent: string,
  locale: Locale = DEFAULT_LOCALE,
): { label: string; tone: "neutral" | "emerald" | "amber" | "crimson" } {
  const exact = TIMELINE_EVENT_LABELS_I18N[rawEvent];
  if (exact) {
    return { label: exact.labels[locale], tone: exact.tone };
  }
  const upper = rawEvent.toUpperCase();
  if (upper.includes("DENIED")) {
    return {
      label:
        locale === "en"
          ? "Blocked by policy gate"
          : locale === "zh-HK"
            ? "操作已被權限閘門攔截"
            : "操作已被权限闸门拦截",
      tone: "amber",
    };
  }
  if (upper.includes("RETURN")) {
    return {
      label:
        locale === "en"
          ? "Returned for revision"
          : locale === "zh-HK"
            ? "已退回修改"
            : "已退回修改",
      tone: "amber",
    };
  }
  if (upper.includes("REJECT")) {
    return {
      label:
        locale === "en"
          ? "Proposal rejected"
          : locale === "zh-HK"
            ? "已拒絕"
            : "已拒绝",
      tone: "crimson",
    };
  }
  if (upper.includes("VERIF")) {
    return {
      label:
        locale === "en"
          ? "Verified & posted"
          : locale === "zh-HK"
            ? "已核驗入帳"
            : "已核验入账",
      tone: "emerald",
    };
  }
  if (upper.includes("APPROV")) {
    return {
      label:
        locale === "en"
          ? "Approved by manager"
          : locale === "zh-HK"
            ? "獨立主管已批准"
            : "独立主管已批准",
      tone: "neutral",
    };
  }
  return {
    label:
      locale === "en"
        ? "System state update"
        : locale === "zh-HK"
          ? "系統狀態變更"
          : "系统状态变更",
    tone: "neutral",
  };
}

export function localizeErrorMessageForLocale(
  params: {
    status?: number;
    code?: string;
    message?: string;
    rawDetail?: unknown;
  },
  locale: Locale = DEFAULT_LOCALE,
): string {
  const { status, code, message, rawDetail } = params;

  if (status === 404 || code === "RECORD_UNAVAILABLE") {
    return ERROR_CODE_MESSAGES_I18N.RECORD_UNAVAILABLE![locale];
  }

  if (typeof rawDetail === "string") {
    const knownRaw = RAW_DETAIL_TRANSLATIONS_I18N[rawDetail];
    if (knownRaw) return knownRaw[locale];
  }

  if (code && ERROR_CODE_MESSAGES_I18N[code]) {
    return ERROR_CODE_MESSAGES_I18N[code]![locale];
  }

  if (status === 401) return ERROR_CODE_MESSAGES_I18N.HTTP_401![locale];
  if (status === 403) return ERROR_CODE_MESSAGES_I18N.HTTP_403![locale];
  if (status === 409) return ERROR_CODE_MESSAGES_I18N.HTTP_409![locale];
  if (status === 422) {
    if (message && message.trim().length > 0 && locale === "zh-CN") {
      return message;
    }
    return ERROR_CODE_MESSAGES_I18N.HTTP_422![locale];
  }
  if (status === 429) return ERROR_CODE_MESSAGES_I18N.HTTP_429![locale];
  if (status !== undefined && status >= 500) {
    return ERROR_CODE_MESSAGES_I18N.HTTP_503![locale];
  }

  // Never leak raw zh-CN BFF fallback messages into en or zh-HK
  if (message && message.trim().length > 0 && locale === "zh-CN") {
    return message;
  }

  return ERROR_CODE_MESSAGES_I18N.DEFAULT_ERROR![locale];
}

export function localizePersonaForLocale(
  subject: string,
  locale: Locale = DEFAULT_LOCALE,
  fallback?: Partial<DemoPersonaMeta>,
): LocalizedPersonaInfo {
  return resolveLocalizedPersona(subject, locale, fallback);
}

export {
  COMMON_DICTIONARY,
  MESSENGER_DICTIONARY,
  WORKBENCH_DICTIONARY,
  ADMIN_DICTIONARY,
  ROLE_LABELS_I18N,
  PROPOSAL_ACTION_LABELS_I18N,
  TOOL_LABELS_I18N,
  SOURCE_LABELS_I18N,
  STATUS_LABELS_I18N,
  COMPACT_PROPOSAL_STATE_LABELS_I18N,
  NOTICE_KIND_LABELS_I18N,
  ERROR_CODE_MESSAGES_I18N,
  RAW_DETAIL_TRANSLATIONS_I18N,
  PERSONA_LOCALIZATIONS,
  ASSURANCE_KIND_LABELS_I18N,
  ASSURANCE_TRACK_LABELS_I18N,
  ASSURANCE_FIELD_LABELS_I18N,
  TIMELINE_EVENT_LABELS_I18N,
  MODULE_ACCESS_META_I18N,
  GRANT_LABELS_I18N,
  TIMEZONE_LABELS_I18N,
};
