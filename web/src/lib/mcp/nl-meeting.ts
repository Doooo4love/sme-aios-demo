import { randomUUID } from "node:crypto";
import {
  DEFAULT_LOCALE,
  PERSONA_LOCALIZATIONS,
  localizeNlMeetingWarning,
  type Locale,
} from "@/lib/i18n";
import type {
  CompanyContact,
  DemoPersonaId,
  ExternalCalendarTarget,
  NlMeetingWarningItem,
  ZoomBookingAttendee,
  ZoomBookingDraft,
} from "@/lib/types";

export interface ParseMeetingOptions {
  timezone?: string;
  tzOffsetMinutes?: number;
  roomId?: string | null;
  defaultCalendarTargets?: ExternalCalendarTarget[];
  locale?: Locale;
  selfSubject?: string;
}

export interface ParsedMeetingResult {
  draft: ZoomBookingDraft;
  warnings: string[];
  warningItems: NlMeetingWarningItem[];
}

const MEETING_INTENT_RE =
  /(?:zoom|预约会议|預約會議|安排会议|安排會議|约个?会|約個?會|定个?会|定個?會|开个?会|開個?會|开会|開會|视频会议|視像會議|視頻會議|会议邀请|會議邀請|对账会|對帳會|评审会|評審會|book\s+(?:a\s+)?(?:\d+\s*(?:min|mins|minute|minutes|h|hr|hour|hours)\s+)?(?:zoom\s+)?meeting|schedule\s+(?:a\s+)?(?:zoom\s+)?(?:meeting|call)|zoom\s+meeting)/i;

export function detectMeetingIntent(utterance: string): boolean {
  return MEETING_INTENT_RE.test(utterance.trim());
}

const ZH_NUM_MAP: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  兩: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
  十一: 11,
  十二: 12,
};

function parseZhOrDigitNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  if (trimmed in ZH_NUM_MAP) return ZH_NUM_MAP[trimmed]!;
  if (
    trimmed.startsWith("十") &&
    trimmed.length === 2 &&
    trimmed[1]! in ZH_NUM_MAP
  ) {
    return 10 + ZH_NUM_MAP[trimmed[1]!]!;
  }
  return null;
}

const WEEKDAY_ZH: Record<string, number> = {
  日: 0,
  天: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
};

const WEEKDAY_EN: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

interface WallClockDate {
  year: number;
  month: number; // 1..12
  day: number; // 1..31
  hour: number;
  minute: number;
  dow: number; // 0=Sun..6=Sat
}

function toWallClock(utcMs: number, offsetMinutes: number): WallClockDate {
  const shifted = new Date(utcMs + offsetMinutes * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    dow: shifted.getUTCDay(),
  };
}

function wallClockToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  offsetMinutes: number,
): number {
  return (
    Date.UTC(year, month - 1, day, hour, minute, 0, 0) - offsetMinutes * 60_000
  );
}

function addDaysToWall(
  base: WallClockDate,
  deltaDays: number,
  offsetMinutes: number,
): WallClockDate {
  const ms = wallClockToUtcMs(
    base.year,
    base.month,
    base.day,
    12,
    0,
    offsetMinutes,
  );
  return toWallClock(ms + deltaDays * 86_400_000, offsetMinutes);
}

function formatOffsetIso(utcMs: number, offsetMinutes: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const wall = toWallClock(utcMs, offsetMinutes);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const oh = pad(Math.floor(abs / 60));
  const om = pad(abs % 60);
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}:00${sign}${oh}:${om}`;
}

function daysUntilWeekday(
  currentDow: number,
  targetDow: number,
  forceNextWeek: boolean,
): number {
  if (forceNextWeek) {
    // Monday-anchored week offset (standard in China/HK/ISO)
    const curIso = currentDow === 0 ? 7 : currentDow;
    const tgtIso = targetDow === 0 ? 7 : targetDow;
    return 7 - curIso + tgtIso;
  }
  const diff = (targetDow - currentDow + 7) % 7;
  return diff === 0 ? 7 : diff;
}

const ROLE_KEYWORDS: Array<{ pattern: RegExp; subject: string }> = [
  { pattern: /(?:^|[\s和与與跟@])(权限管理员|權限管理員)/i, subject: "access-admin" },
  { pattern: /(?:^|[\s和与與跟@])(运维管理员|維運管理員|運維管理員)/i, subject: "admin" },
  { pattern: /(?:^|[\s和与與跟@])(二仓主管|二倉主管|hk02\s*主管)/i, subject: "other-manager" },
  { pattern: /(?:^|[\s和与與跟@])(主管|经理|經理)/i, subject: "manager" },
  { pattern: /(?:^|[\s和与與跟@])(财务|財務|会计|會計)/i, subject: "finance" },
  { pattern: /(?:^|[\s和与與跟@])(质检|質檢|品控|品質)/i, subject: "quality" },
  { pattern: /(?:^|[\s和与與跟@])(法务|法務|合规|合規)/i, subject: "legal" },
  { pattern: /(?:^|[\s和与與跟@])(经办|經辦|接单|接單)/i, subject: "operator" },
  { pattern: /(?:^|[\s和与與跟@])(高管|经营|經營|營運)/i, subject: "executive" },
];

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripPrintableTitle(raw: string): string {
  const cleaned = raw
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/^[\s,，。.:：;；\-—·的关于關於用开開约約]+/, "")
    .replace(/[\s,，。.:：;；\-—·]+$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return cleaned.slice(0, 120);
}

function getDefaultMeetingTitle(locale: Locale): string {
  if (locale === "en") return "Zoom Collaboration Meeting";
  if (locale === "zh-HK") return "Zoom 協作會議";
  return "Zoom 协作会议";
}

function getContactAliasNames(contact: CompanyContact): string[] {
  const set = new Set<string>();
  if (contact.display_name && contact.display_name.length >= 2) {
    set.add(contact.display_name);
  }
  if (contact.default_display_name && contact.default_display_name.length >= 2) {
    set.add(contact.default_display_name);
  }
  const localized = PERSONA_LOCALIZATIONS[contact.subject as DemoPersonaId];
  if (localized) {
    for (const loc of ["zh-CN", "zh-HK", "en"] as const) {
      const name = localized[loc].displayName;
      if (name && name.length >= 2) set.add(name);
    }
  }
  return Array.from(set).sort((a, b) => b.length - a.length);
}

/**
 * Deterministic trilingual (zh-CN + zh-HK + EN) natural-language meeting parser.
 * Resolves attendees strictly against the caller's same-tenant contacts list.
 */
export function parseNaturalLanguageMeeting(
  utterance: string,
  nowIso: string | undefined,
  contacts: readonly CompanyContact[],
  options?: ParseMeetingOptions,
): ParsedMeetingResult {
  const locale: Locale = options?.locale ?? DEFAULT_LOCALE;
  const selfSubject = options?.selfSubject?.trim() || null;
  const warningItems: NlMeetingWarningItem[] = [];
  const pushWarning = (item: NlMeetingWarningItem) => {
    warningItems.push(item);
  };

  const offsetMinutes =
    typeof options?.tzOffsetMinutes === "number" &&
    Number.isFinite(options.tzOffsetMinutes) &&
    Math.abs(options.tzOffsetMinutes) <= 840
      ? Math.trunc(options.tzOffsetMinutes)
      : 480; // Default Asia/Hong_Kong (+08:00)
  const timezone = options?.timezone?.trim() || "Asia/Hong_Kong";

  const nowMs = nowIso ? Date.parse(nowIso) : Date.now();
  const safeNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const nowWall = toWallClock(safeNowMs, offsetMinutes);

  let remaining = utterance.trim();

  // -------------------------------------------------------------------------
  // 1. Parse Date (zh-CN + zh-HK + EN)
  // -------------------------------------------------------------------------
  let targetDate: WallClockDate = { ...nowWall };
  let dateExplicit = false;

  const isoDateMatch = remaining.match(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/);
  const zhMonthDayMatch = remaining.match(/(\d{1,2})月(\d{1,2})[日号號]?/);
  const zhNextWeekMatch = remaining.match(
    /下(?:周|週|星期)([一二三四五六日天])/,
  );
  const zhWeekMatch = remaining.match(
    /(?:这|這|本)?(?:周|週|星期)([一二三四五六日天])/,
  );
  const enNextWeekMatch = remaining.match(
    /\b(next|this)\s+(mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/i,
  );
  const zhRelDayMatch = remaining.match(
    /(大后天|大後天|后天|後天|明天|明日|今天|今日|今晚)/,
  );
  const enRelDayMatch = remaining.match(
    /\b(day\s+after\s+tomorrow|tomorrow|today|tonight)\b/i,
  );

  if (isoDateMatch) {
    const y = Number.parseInt(isoDateMatch[1]!, 10);
    const m = Number.parseInt(isoDateMatch[2]!, 10);
    const d = Number.parseInt(isoDateMatch[3]!, 10);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      targetDate = { ...targetDate, year: y, month: m, day: d };
      dateExplicit = true;
      remaining = remaining.replace(isoDateMatch[0], " ");
    }
  } else if (zhMonthDayMatch) {
    const m = Number.parseInt(zhMonthDayMatch[1]!, 10);
    const d = Number.parseInt(zhMonthDayMatch[2]!, 10);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      let y = nowWall.year;
      if (m < nowWall.month || (m === nowWall.month && d < nowWall.day)) {
        y += 1;
      }
      targetDate = { ...targetDate, year: y, month: m, day: d };
      dateExplicit = true;
      remaining = remaining.replace(zhMonthDayMatch[0], " ");
    }
  } else if (zhNextWeekMatch) {
    const dow = WEEKDAY_ZH[zhNextWeekMatch[1]!]!;
    targetDate = addDaysToWall(
      nowWall,
      daysUntilWeekday(nowWall.dow, dow, true),
      offsetMinutes,
    );
    dateExplicit = true;
    remaining = remaining.replace(zhNextWeekMatch[0], " ");
  } else if (zhWeekMatch) {
    const dow = WEEKDAY_ZH[zhWeekMatch[1]!]!;
    targetDate = addDaysToWall(
      nowWall,
      daysUntilWeekday(nowWall.dow, dow, false),
      offsetMinutes,
    );
    dateExplicit = true;
    remaining = remaining.replace(zhWeekMatch[0], " ");
  } else if (enNextWeekMatch) {
    const kw = enNextWeekMatch[1]!.toLowerCase();
    const dow = WEEKDAY_EN[enNextWeekMatch[2]!.toLowerCase()]!;
    targetDate = addDaysToWall(
      nowWall,
      daysUntilWeekday(nowWall.dow, dow, kw === "next"),
      offsetMinutes,
    );
    dateExplicit = true;
    remaining = remaining.replace(enNextWeekMatch[0], " ");
  } else if (zhRelDayMatch) {
    const word = zhRelDayMatch[1]!;
    const delta =
      word === "大后天" || word === "大後天"
        ? 3
        : word === "后天" || word === "後天"
          ? 2
          : word === "明天" || word === "明日"
            ? 1
            : 0;
    targetDate = addDaysToWall(nowWall, delta, offsetMinutes);
    dateExplicit = true;
    if (word !== "今晚") {
      remaining = remaining.replace(zhRelDayMatch[0], " ");
    }
  } else if (enRelDayMatch) {
    const word = enRelDayMatch[1]!.toLowerCase();
    const delta = word.includes("after") ? 2 : word === "tomorrow" ? 1 : 0;
    targetDate = addDaysToWall(nowWall, delta, offsetMinutes);
    dateExplicit = true;
    if (word !== "tonight") {
      remaining = remaining.replace(enRelDayMatch[0], " ");
    }
  }

  // -------------------------------------------------------------------------
  // 2. Parse Time of Day (zh-CN + zh-HK + EN)
  // -------------------------------------------------------------------------
  let hour: number | null = null;
  let minute = 0;

  const zhTimeRe =
    /(早上|上午|清晨|中午|下午|午后|午後|傍晚|晚上|今晚)?\s*(\d{1,2}|[一二两兩三四五六七八九十]{1,2})\s*(?:点|點|时|時)(?:钟|鐘)?(?:(半|一刻|三刻|(\d{1,2})分?))?/;
  const enAmPmRe =
    /(?:\bat\s+)?(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/i;
  const clock24Re =
    /(早上|上午|中午|下午|午后|午後|晚上|今晚|at\s+)?\b([01]?\d|2[0-3]):([0-5]\d)\b/i;

  const zhTimeMatch = remaining.match(zhTimeRe);
  const enAmPmMatch = !zhTimeMatch ? remaining.match(enAmPmRe) : null;
  const clock24Match =
    !zhTimeMatch && !enAmPmMatch ? remaining.match(clock24Re) : null;

  if (zhTimeMatch) {
    const period = zhTimeMatch[1] || "";
    const parsedH = parseZhOrDigitNumber(zhTimeMatch[2]!);
    if (parsedH !== null && parsedH >= 0 && parsedH <= 23) {
      hour = parsedH;
      const frac = zhTimeMatch[3] || "";
      if (frac === "半") minute = 30;
      else if (frac === "一刻") minute = 15;
      else if (frac === "三刻") minute = 45;
      else if (zhTimeMatch[4]) {
        minute = Math.min(59, Number.parseInt(zhTimeMatch[4], 10));
      }

      if (
        (period === "下午" ||
          period === "午后" ||
          period === "午後" ||
          period === "傍晚" ||
          period === "晚上" ||
          period === "今晚") &&
        hour >= 1 &&
        hour <= 11
      ) {
        hour += 12;
      } else if (period === "中午" && hour >= 1 && hour <= 5) {
        hour += 12;
      }
      remaining = remaining.replace(zhTimeMatch[0], " ");
    }
  } else if (enAmPmMatch) {
    let h = Number.parseInt(enAmPmMatch[1]!, 10);
    const m = enAmPmMatch[2] ? Number.parseInt(enAmPmMatch[2], 10) : 0;
    const mer = enAmPmMatch[3]!.toLowerCase().replace(/\./g, "");
    if (h >= 1 && h <= 12 && m >= 0 && m <= 59) {
      if (mer === "pm" && h < 12) h += 12;
      if (mer === "am" && h === 12) h = 0;
      hour = h;
      minute = m;
      remaining = remaining.replace(enAmPmMatch[0], " ");
    }
  } else if (clock24Match) {
    const period = (clock24Match[1] || "").trim().toLowerCase();
    let h = Number.parseInt(clock24Match[2]!, 10);
    const m = Number.parseInt(clock24Match[3]!, 10);
    if (
      (period === "下午" ||
        period === "午后" ||
        period === "午後" ||
        period === "晚上" ||
        period === "今晚") &&
      h >= 1 &&
      h <= 11
    ) {
      h += 12;
    }
    hour = h;
    minute = m;
    remaining = remaining.replace(clock24Match[0], " ");
  }

  if (hour === null) {
    if (
      dateExplicit &&
      (targetDate.day !== nowWall.day || targetDate.month !== nowWall.month)
    ) {
      hour = 10;
      minute = 0;
    } else {
      const nextHourWall = toWallClock(safeNowMs + 60 * 60_000, offsetMinutes);
      targetDate = nextHourWall;
      hour = nextHourWall.hour;
      minute = 0;
    }
    pushWarning({ code: "DEFAULT_NEXT_HOUR" });
  }

  let startUtcMs = wallClockToUtcMs(
    targetDate.year,
    targetDate.month,
    targetDate.day,
    hour,
    minute,
    offsetMinutes,
  );

  // Ensure strictly in the future (FastAPI calendar.py requires starts_at > now)
  if (startUtcMs <= safeNowMs + 60_000) {
    if (!dateExplicit) {
      startUtcMs += 86_400_000;
      pushWarning({ code: "ROLLED_TO_TOMORROW" });
    } else {
      startUtcMs = safeNowMs + 15 * 60_000;
      pushWarning({ code: "ADJUSTED_15_MIN" });
    }
  }

  // -------------------------------------------------------------------------
  // 3. Parse Duration (zh-CN + zh-HK + EN)
  // -------------------------------------------------------------------------
  let durationMinutes = 60;
  const durComplexEn = remaining.match(
    /\b(\d+)\s*h(?:ours?|rs?)?\s*(\d+)\s*m(?:in(?:s|utes?)?)?\b/i,
  );
  const durEnHour = !durComplexEn
    ? remaining.match(/\b(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/i)
    : null;
  const durEnMin =
    !durComplexEn && !durEnHour
      ? remaining.match(/\b(\d+)\s*(?:minutes?|mins?|min)\b/i)
      : null;
  const durZhHourHalf = remaining.match(
    /(\d+|[一二两兩三四])\s*(?:个|個)半(?:小时|小時)/,
  );
  const durZhHalf = !durZhHourHalf
    ? remaining.match(/半(?:个|個)?(?:小时|小時)/)
    : null;
  const durZhHour =
    !durZhHourHalf && !durZhHalf
      ? remaining.match(/(\d+(?:\.\d+)?|[一二两兩三四])\s*(?:个|個)?(?:小时|小時)/)
      : null;
  const durZhMin =
    !durZhHourHalf && !durZhHalf && !durZhHour
      ? remaining.match(/(\d+)\s*(?:分钟|分鐘)/)
      : null;

  if (durComplexEn) {
    durationMinutes =
      Number.parseInt(durComplexEn[1]!, 10) * 60 +
      Number.parseInt(durComplexEn[2]!, 10);
    remaining = remaining.replace(durComplexEn[0], " ");
  } else if (durEnHour) {
    durationMinutes = Math.round(Number.parseFloat(durEnHour[1]!) * 60);
    remaining = remaining.replace(durEnHour[0], " ");
  } else if (durEnMin) {
    durationMinutes = Number.parseInt(durEnMin[1]!, 10);
    remaining = remaining.replace(durEnMin[0], " ");
  } else if (durZhHourHalf) {
    const rawH = durZhHourHalf[1]!;
    const n = /^\d/.test(rawH)
      ? Number.parseInt(rawH, 10)
      : parseZhOrDigitNumber(rawH);
    if (n) durationMinutes = n * 60 + 30;
    remaining = remaining.replace(durZhHourHalf[0], " ");
  } else if (durZhHalf) {
    durationMinutes = 30;
    remaining = remaining.replace(durZhHalf[0], " ");
  } else if (durZhHour) {
    const rawH = durZhHour[1]!;
    const n = /^\d/.test(rawH)
      ? Number.parseFloat(rawH)
      : parseZhOrDigitNumber(rawH);
    if (n) durationMinutes = Math.round(n * 60);
    remaining = remaining.replace(durZhHour[0], " ");
  } else if (durZhMin) {
    durationMinutes = Number.parseInt(durZhMin[1]!, 10);
    remaining = remaining.replace(durZhMin[0], " ");
  }

  durationMinutes = Math.max(15, Math.min(480, durationMinutes));
  const endUtcMs = startUtcMs + durationMinutes * 60_000;

  // -------------------------------------------------------------------------
  // 4. Detect Zoom & External Calendar Targets
  // -------------------------------------------------------------------------
  const explicitlyOffline =
    /线下|線下|现场|現場|面对面|面對面|会议室|會議室|in-person|offline/i.test(
      utterance,
    );
  const createZoom = !explicitlyOffline;

  const detectedTargets: ExternalCalendarTarget[] = [];
  if (/google|谷歌/i.test(utterance)) detectedTargets.push("google");
  if (/icloud|苹果|蘋果|apple/i.test(utterance)) detectedTargets.push("icloud");
  if (/outlook|微软|微軟|m365|microsoft/i.test(utterance)) {
    detectedTargets.push("outlook");
  }

  const calendarTargets: ExternalCalendarTarget[] =
    detectedTargets.length > 0
      ? detectedTargets
      : options?.defaultCalendarTargets &&
          options.defaultCalendarTargets.length > 0
        ? [...options.defaultCalendarTargets]
        : ["google", "icloud", "outlook"];

  // -------------------------------------------------------------------------
  // 5. Tenant-Scoped Attendee Extraction & Cross-Tenant / Self Guard
  // -------------------------------------------------------------------------
  const matchedMap = new Map<string, ZoomBookingAttendee>();
  const unresolvedMentions: string[] = [];

  const addMatchedContact = (c: CompanyContact) => {
    // Strip self-mentions from title cleanly without adding self as an external attendee (M-3)
    if (selfSubject && c.subject === selfSubject) return;
    if (!matchedMap.has(c.subject)) {
      matchedMap.set(c.subject, {
        subject: c.subject,
        display_name: c.display_name,
        email: c.email,
        department: c.department,
      });
    }
  };

  // Sort contacts by longest subject first so "other-manager" matches before "manager"
  const sortedContacts = [...contacts].sort(
    (a, b) => b.subject.length - a.subject.length,
  );

  // Track exact hyphenated spans so "island-manager" never substring-matches "manager"
  const knownForeignTokens = remaining.match(
    /(?:^|[\s和与與跟@])([a-z][a-z0-9]*(?:-[a-z0-9]+)+)(?=$|[\s,，。开開用约約的])/gi,
  );
  const hyphenatedCandidates = new Set<string>();
  if (knownForeignTokens) {
    for (const rawTok of knownForeignTokens) {
      const cleaned = rawTok.replace(/^[\s和与與跟@]+/, "").toLowerCase();
      hyphenatedCandidates.add(cleaned);
    }
  }

  for (const token of hyphenatedCandidates) {
    const exact = sortedContacts.find((c) => c.subject.toLowerCase() === token);
    if (exact) {
      addMatchedContact(exact);
      remaining = remaining.replace(
        new RegExp(`(?:和|与|與|跟|with|@)?\\s*${escapeRegex(token)}`, "gi"),
        " ",
      );
    } else if (
      /-(?:manager|admin|operator|finance|viewer|legal|quality|executive)$/i.test(
        token,
      )
    ) {
      unresolvedMentions.push(token);
      pushWarning({ code: "UNRESOLVED_MENTION", params: { token } });
      remaining = remaining.replace(
        new RegExp(`(?:和|与|與|跟|with|@)?\\s*${escapeRegex(token)}`, "gi"),
        " ",
      );
    }
  }

  // Match same-tenant contacts (including self so self-mentions are stripped from title!)
  for (const contact of sortedContacts) {
    const subRe = new RegExp(
      `(?:和|与|與|跟|with|@)?\\s*(?<![A-Za-z0-9_-])${escapeRegex(contact.subject)}(?![A-Za-z0-9_-])`,
      "gi",
    );
    if (subRe.test(remaining)) {
      addMatchedContact(contact);
      remaining = remaining.replace(subRe, " ");
      continue;
    }

    const emailRe = new RegExp(
      `(?:和|与|與|跟|with)?\\s*${escapeRegex(contact.email)}`,
      "gi",
    );
    if (emailRe.test(remaining)) {
      addMatchedContact(contact);
      remaining = remaining.replace(emailRe, " ");
      continue;
    }

    for (const cname of getContactAliasNames(contact)) {
      const nameRe = new RegExp(
        `(?:和|与|與|跟|with|@)?\\s*${escapeRegex(cname)}`,
        "gi",
      );
      if (nameRe.test(remaining)) {
        addMatchedContact(contact);
        remaining = remaining.replace(nameRe, " ");
        break;
      }
    }
  }

  // Fallback self-subject strip even if caller passed contacts without includeSelf
  if (selfSubject) {
    const selfRe = new RegExp(
      `(?:和|与|與|跟|with|@)\\s*(?<![A-Za-z0-9_-])${escapeRegex(selfSubject)}(?![A-Za-z0-9_-])`,
      "gi",
    );
    remaining = remaining.replace(selfRe, " ");
  }

  // Match Chinese role phrases (SC + TC) strictly within caller's contacts
  for (const kw of ROLE_KEYWORDS) {
    const m = remaining.match(kw.pattern);
    if (m) {
      const contact = contacts.find((c) => c.subject === kw.subject);
      if (contact) {
        addMatchedContact(contact);
        remaining = remaining.replace(
          new RegExp(`(?:和|与|與|跟|@)?${escapeRegex(m[1]!)}`, "g"),
          " ",
        );
      }
    }
  }

  // Detect any remaining explicit @mentions not found in tenant directory
  const leftoverAtMentions = remaining.match(/@([A-Za-z0-9_-]{2,40})/g);
  if (leftoverAtMentions) {
    for (const rawAt of leftoverAtMentions) {
      const token = rawAt.slice(1);
      if (
        token !== selfSubject &&
        !matchedMap.has(token) &&
        !unresolvedMentions.includes(token)
      ) {
        unresolvedMentions.push(token);
        pushWarning({ code: "UNRESOLVED_MENTION", params: { token } });
      }
      remaining = remaining.replace(rawAt, " ");
    }
  }

  // -------------------------------------------------------------------------
  // 6. Clean Title Extraction (zh-CN + zh-HK + EN)
  // -------------------------------------------------------------------------
  const titleCandidate = remaining
    .replace(/\b(?:book|schedule|create|set\s+up|arrange)\b/gi, " ")
    .replace(/\b(?:zoom|video|online)\s+(?:meeting|call|session)\b/gi, " ")
    .replace(/\b(?:zoom|meeting|call)\b/gi, " ")
    .replace(/\b(?:a|an|with|about|regarding|for|at|on|sync\s+to|to)\b/gi, " ")
    .replace(
      /(?:请|請|帮我|幫我|麻烦|麻煩|预约|預約|安排|定一个|定一個|约一个|約一個|发起|發起|创建|建立|創建|同步到|同步至|用\s*zoom|视频会议|視像會議|視頻會議|线上会议|線上會議|视频|視像|視頻|线上|線上|开个|開個|开会|開會|讨论|討論|关于|關於|主题为|主題為|主题是|主題是)/gi,
      " ",
    )
    .replace(
      /(?:google|谷歌|icloud|苹果|蘋果|outlook|微软|微軟|m365)(?:\s*日历|\s*日曆|\s*calendar)?/gi,
      " ",
    )
    .replace(/(?:^|\s)[开開](?=\S)/g, " ");

  const cleanedTitle = stripPrintableTitle(titleCandidate);
  const titleIsDefault = cleanedTitle.length < 2;
  const title = titleIsDefault ? getDefaultMeetingTitle(locale) : cleanedTitle;

  const clientId = `zm_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const warnings = warningItems.map((item) =>
    localizeNlMeetingWarning(item, locale),
  );

  return {
    draft: {
      client_id: clientId,
      title,
      title_is_default: titleIsDefault,
      starts_at: formatOffsetIso(startUtcMs, offsetMinutes),
      ends_at: formatOffsetIso(endUtcMs, offsetMinutes),
      duration_minutes: durationMinutes,
      timezone,
      room_id: options?.roomId ?? null,
      create_zoom: createZoom,
      notify_room: true,
      calendar_targets: calendarTargets,
      attendees: Array.from(matchedMap.values()),
      unresolved_mentions: unresolvedMentions,
    },
    warnings,
    warningItems,
  };
}
