"use client";

import React from "react";
import { DEFAULT_TENANT_TIMEZONE, formatLocalIsoDate } from "@/lib/format";
import { DEFAULT_LOCALE, type Locale } from "@/lib/i18n/types";

export type BubbleGroupPos = "single" | "first" | "middle" | "last";

const DEFAULT_BURST_WINDOW_SEC = 300;

const burstPartsCache = new Map<string, Intl.DateTimeFormat>();

function getBurstParts(date: Date, timeZone: string) {
  let fmt = burstPartsCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    burstPartsCache.set(timeZone, fmt);
  }
  const parts = fmt.formatToParts(date);
  let year = "0000";
  let month = "01";
  let day = "01";
  let hour = "00";
  let minute = "00";
  for (const p of parts) {
    if (p.type === "year") year = p.value;
    else if (p.type === "month") month = p.value;
    else if (p.type === "day") day = p.value;
    else if (p.type === "hour") hour = p.value === "24" ? "00" : p.value;
    else if (p.type === "minute") minute = p.value;
  }
  return { year, month, day, hour, minute };
}

/**
 * Returns true when a centered burst timestamp header should appear before `curCreatedAt`:
 * - first message in stream (`prevCreatedAt` null/undefined/invalid)
 * - calendar day changed in tenant timezone
 * - elapsed gap >= 300s (5 minutes)
 */
export function shouldShowBurstTimestamp(
  prevCreatedAt: number | null | undefined,
  curCreatedAt: number,
  windowSec = DEFAULT_BURST_WINDOW_SEC,
): boolean {
  if (
    typeof prevCreatedAt !== "number" ||
    !Number.isFinite(prevCreatedAt) ||
    prevCreatedAt <= 0
  ) {
    return true;
  }
  if (!Number.isFinite(curCreatedAt) || curCreatedAt <= 0) {
    return false;
  }
  if (Math.abs(curCreatedAt - prevCreatedAt) >= windowSec) {
    return true;
  }
  const prevDay = formatLocalIsoDate(
    prevCreatedAt * 1000,
    DEFAULT_TENANT_TIMEZONE,
  );
  const curDay = formatLocalIsoDate(
    curCreatedAt * 1000,
    DEFAULT_TENANT_TIMEZONE,
  );
  return prevDay !== curDay;
}

/**
 * Formats centered iMessage-style burst timestamps:
 * - Today -> "今天 02:37" / "Today 02:37"
 * - Yesterday -> "昨天 14:20" / "Yesterday 14:20"
 * - Same year -> "11月22日 09:15" / "Nov 22, 09:15"
 * - Earlier year -> "2025年11月22日 09:15" / "Nov 22, 2025, 09:15"
 */
export function formatBurstTimestamp(
  ts: number,
  locale: Locale = DEFAULT_LOCALE,
  timeZone: string = DEFAULT_TENANT_TIMEZONE,
): string {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) {
    return "";
  }
  const msgDate = new Date(ts * 1000);
  const nowDate = new Date();
  const msgParts = getBurstParts(msgDate, timeZone);
  const nowParts = getBurstParts(nowDate, timeZone);
  const hhmm = `${msgParts.hour}:${msgParts.minute}`;

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
    return locale === "en" ? `Today ${hhmm}` : `今天 ${hhmm}`;
  }
  if (dayDiff === 1) {
    return locale === "en" ? `Yesterday ${hhmm}` : `昨天 ${hhmm}`;
  }

  const monthNum = Number(msgParts.month);
  const dayNum = Number(msgParts.day);

  if (msgParts.year === nowParts.year) {
    if (locale === "en") {
      const dateStr = new Intl.DateTimeFormat("en-US", {
        timeZone,
        month: "short",
        day: "numeric",
      }).format(msgDate);
      return `${dateStr}, ${hhmm}`;
    }
    return `${monthNum}月${dayNum}日 ${hhmm}`;
  }

  if (locale === "en") {
    const dateStr = new Intl.DateTimeFormat("en-US", {
      timeZone,
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(msgDate);
    return `${dateStr}, ${hhmm}`;
  }
  return `${msgParts.year}年${monthNum}月${dayNum}日 ${hhmm}`;
}

export function computeBubbleGroupPos<
  T extends { sender: string; createdAt: number },
>(
  items: readonly T[],
  index: number,
  windowSec = DEFAULT_BURST_WINDOW_SEC,
): BubbleGroupPos {
  const cur = items[index];
  if (!cur) return "single";
  const prev = index > 0 ? items[index - 1] : null;
  const next = index < items.length - 1 ? items[index + 1] : null;

  const samePrev = Boolean(
    prev &&
      prev.sender === cur.sender &&
      !shouldShowBurstTimestamp(prev.createdAt, cur.createdAt, windowSec),
  );
  const sameNext = Boolean(
    next &&
      next.sender === cur.sender &&
      !shouldShowBurstTimestamp(cur.createdAt, next.createdAt, windowSec),
  );

  if (samePrev && sameNext) return "middle";
  if (samePrev) return "last";
  if (sameNext) return "first";
  return "single";
}

/**
 * Native macOS Sequoia iMessage / WhatsApp bubble curvature:
 * - Outer R-corners use generous `20px` (`--radius-bubble`).
 * - Intermediate stacked seam corners tighten to `6px` (`--radius-bubble-tight`).
 * - Tail-bearing bottom-most bubbles (`single`, `last`) ease the tail corner to `10px`
 *   (`--radius-bubble-tail`) so the overlapping SVG tail meets both walls with C1 continuity.
 */
export function getBubbleRadiusClass(
  side: "sent" | "received",
  pos: BubbleGroupPos,
): string {
  if (side === "sent") {
    switch (pos) {
      case "single":
        return "rounded-[var(--radius-bubble)] rounded-br-[var(--radius-bubble-tail)]";
      case "first":
        return "rounded-[var(--radius-bubble)] rounded-br-[var(--radius-bubble-tight)]";
      case "middle":
        return "rounded-[var(--radius-bubble)] rounded-tr-[var(--radius-bubble-tight)] rounded-br-[var(--radius-bubble-tight)]";
      case "last":
        return "rounded-[var(--radius-bubble)] rounded-tr-[var(--radius-bubble-tight)] rounded-br-[var(--radius-bubble-tail)]";
    }
  }
  switch (pos) {
    case "single":
      return "rounded-[var(--radius-bubble)] rounded-bl-[var(--radius-bubble-tail)]";
    case "first":
      return "rounded-[var(--radius-bubble)] rounded-bl-[var(--radius-bubble-tight)]";
    case "middle":
      return "rounded-[var(--radius-bubble)] rounded-tl-[var(--radius-bubble-tight)] rounded-bl-[var(--radius-bubble-tight)]";
    case "last":
      return "rounded-[var(--radius-bubble)] rounded-tl-[var(--radius-bubble-tight)] rounded-bl-[var(--radius-bubble-tail)]";
  }
}

export function shouldShowBubbleTail(pos: BubbleGroupPos): boolean {
  return pos === "single" || pos === "last";
}

/**
 * Overlapping Apple iMessage tail (16×18):
 * - x=0..10 sits inside the bubble's 10px bottom corner radius (`--radius-bubble-tail`),
 *   completely bridging the arc so zero background notch ever shows in light or dark mode.
 * - x=10..16 flares cleanly 6px beyond the bubble wall into a crisp curved tail tip.
 */
export function IMessageBubbleTail({
  side,
  className = "",
}: {
  side: "sent" | "received";
  className?: string;
}) {
  return (
    <svg
      width="16"
      height="18"
      viewBox="0 0 16 18"
      aria-hidden="true"
      className={[
        "imessage-tail",
        side === "sent"
          ? "-right-[6px] text-[var(--bubble-sent-bg)]"
          : "-left-[6px] -scale-x-100 text-[var(--bubble-received-bg)]",
        className,
      ].join(" ")}
    >
      <path
        d="M0 18 L0 8 L10 8 C10 13 12 16.2 16 18 C12 18 9.2 17 7.4 15.4 C5.6 17.3 3 18 0 18 Z"
        fill="currentColor"
      />
    </svg>
  );
}
