import { DEFAULT_LOCALE, type Locale } from "@/lib/i18n/types";

export interface IcsEventInput {
  id: string;
  tenant: string;
  title: string;
  organizer: string;
  starts_at: number; // Unix seconds
  ends_at: number; // Unix seconds
  revision: number;
  cancelled: boolean;
  attendees?: Array<{ subject: string; displayName?: string; email?: string }>;
  joinUrl?: string | null;
  passcode?: string | null;
  description?: string | null;
}

const ZOOM_URL_RE =
  /^https:\/\/([a-z0-9-]+\.)?zoom\.us\/[A-Za-z0-9/?=&_%.-]{1,240}$/;

export function isValidZoomJoinUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  if (/[\r\n\x00-\x1f]/.test(url)) return false;
  return ZOOM_URL_RE.test(url.trim());
}

function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

function sanitizeParamValue(value: string): string {
  return value.replace(/[\r\n"\\;,:]/g, " ").trim().slice(0, 80);
}

function formatIcsUtc(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/**
 * RFC 5545 Section 3.1: fold lines longer than 75 UTF-8 octets using CRLF + SPACE.
 */
function foldIcsLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).byteLength <= 75) {
    return line;
  }

  const out: string[] = [];
  let current = "";
  let currentBytes = 0;
  let limit = 75;

  for (const ch of line) {
    const chBytes = encoder.encode(ch).byteLength;
    if (currentBytes + chBytes > limit) {
      out.push(current);
      current = ` ${ch}`;
      currentBytes = 1 + chBytes;
      limit = 75;
    } else {
      current += ch;
      currentBytes += chBytes;
    }
  }
  if (current) out.push(current);
  return out.join("\r\n");
}

interface IcsLocaleStrings {
  defaultCalName: string;
  defaultDescription: string;
  organizerLabel: string;
  zoomLinkLabel: string;
  passcodeLabel: string;
  defaultLocation: string;
  prodLang: string;
}

function getIcsLocaleStrings(locale: Locale): IcsLocaleStrings {
  if (locale === "en") {
    return {
      defaultCalName: "AIOS Enterprise Calendar",
      defaultDescription: "AIOS Internal Enterprise Calendar",
      organizerLabel: "Organizer",
      zoomLinkLabel: "Zoom Join URL",
      passcodeLabel: "Passcode",
      defaultLocation: "AIOS Internal Calendar",
      prodLang: "EN",
    };
  }
  if (locale === "zh-HK") {
    return {
      defaultCalName: "AIOS 企業日程",
      defaultDescription: "AIOS 站內企業日程",
      organizerLabel: "組織者",
      zoomLinkLabel: "Zoom 會議連結",
      passcodeLabel: "入會密碼",
      defaultLocation: "AIOS 站內協作日曆",
      prodLang: "ZH-HK",
    };
  }
  return {
    defaultCalName: "AIOS 企业日程",
    defaultDescription: "AIOS 站内企业日程",
    organizerLabel: "组织者",
    zoomLinkLabel: "Zoom 会议链接",
    passcodeLabel: "入会密码",
    defaultLocation: "AIOS 站内协作日历",
    prodLang: "ZH",
  };
}

/**
 * Pure RFC 5545 + RFC 7986 iCalendar (.ics) generator.
 * Compatible with Apple iCloud Calendar, Google Calendar, and Microsoft Outlook.
 */
export function buildCalendarIcs(
  events: readonly IcsEventInput[],
  options?: { calendarName?: string; locale?: Locale },
): string {
  const locale = options?.locale ?? DEFAULT_LOCALE;
  const strings = getIcsLocaleStrings(locale);
  const calName = options?.calendarName || strings.defaultCalName;
  const dtStamp = formatIcsUtc(Math.floor(Date.now() / 1000));

  const rawLines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//Theodic//Enterprise Workbench Calendar//${strings.prodLang}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(calName)}`,
  ];

  for (const ev of events) {
    const safeTenant = ev.tenant.replace(/[^A-Za-z0-9.-]/g, "") || "aios";
    const safeId = ev.id.replace(/[^A-Za-z0-9._-]/g, "");
    const safeJoinUrl =
      ev.joinUrl && isValidZoomJoinUrl(ev.joinUrl) ? ev.joinUrl.trim() : null;
    const safePasscode =
      ev.passcode && /^[A-Za-z0-9_@*#-]{1,32}$/.test(ev.passcode.trim())
        ? ev.passcode.trim()
        : null;

    const descParts: string[] = [
      ev.description?.trim() || strings.defaultDescription,
      `${strings.organizerLabel}: ${ev.organizer}`,
    ];
    if (safeJoinUrl) {
      descParts.push(`${strings.zoomLinkLabel}: ${safeJoinUrl}`);
      if (safePasscode) {
        descParts.push(`${strings.passcodeLabel}: ${safePasscode}`);
      }
    }

    rawLines.push("BEGIN:VEVENT");
    rawLines.push(`UID:${safeId}@${safeTenant}.aios.local`);
    rawLines.push(`DTSTAMP:${dtStamp}`);
    rawLines.push(`DTSTART:${formatIcsUtc(ev.starts_at)}`);
    rawLines.push(`DTEND:${formatIcsUtc(ev.ends_at)}`);
    rawLines.push(`SUMMARY:${escapeIcsText(ev.title)}`);
    rawLines.push(`DESCRIPTION:${escapeIcsText(descParts.join("\n"))}`);
    rawLines.push(`SEQUENCE:${Math.max(0, Math.trunc(ev.revision))}`);
    rawLines.push(`STATUS:${ev.cancelled ? "CANCELLED" : "CONFIRMED"}`);

    if (safeJoinUrl) {
      // Multi-layer Zoom link compatibility for Apple Calendar, Google Calendar, and Outlook
      rawLines.push(`LOCATION:${escapeIcsText(safeJoinUrl)}`);
      rawLines.push(`URL:${safeJoinUrl}`);
      rawLines.push(
        `CONFERENCE;VALUE=URI;FEATURE=AUDIO,VIDEO;LABEL="Join Zoom Meeting":${safeJoinUrl}`,
      );
    } else {
      rawLines.push(`LOCATION:${escapeIcsText(strings.defaultLocation)}`);
    }

    if (ev.attendees && ev.attendees.length > 0) {
      for (const att of ev.attendees) {
        const cn = sanitizeParamValue(att.displayName || att.subject);
        const mail = (att.email || `${att.subject}@${safeTenant}.local`).replace(
          /[\r\n\s]/g,
          "",
        );
        rawLines.push(
          `ATTENDEE;CN="${cn}";ROLE=REQ-PARTICIPANT:mailto:${mail}`,
        );
      }
    }

    rawLines.push("END:VEVENT");
  }

  rawLines.push("END:VCALENDAR");

  return `${rawLines.map(foldIcsLine).join("\r\n")}\r\n`;
}
