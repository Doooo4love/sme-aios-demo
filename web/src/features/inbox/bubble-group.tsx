"use client";

import React from "react";

export type BubbleGroupPos = "single" | "first" | "middle" | "last";

export function computeBubbleGroupPos<
  T extends { sender: string; createdAt: number },
>(items: readonly T[], index: number, windowSec = 180): BubbleGroupPos {
  const cur = items[index];
  if (!cur) return "single";
  const prev = index > 0 ? items[index - 1] : null;
  const next = index < items.length - 1 ? items[index + 1] : null;

  const samePrev = Boolean(
    prev &&
      prev.sender === cur.sender &&
      Math.abs(cur.createdAt - prev.createdAt) <= windowSec,
  );
  const sameNext = Boolean(
    next &&
      next.sender === cur.sender &&
      Math.abs(next.createdAt - cur.createdAt) <= windowSec,
  );

  if (samePrev && sameNext) return "middle";
  if (samePrev) return "last";
  if (sameNext) return "first";
  return "single";
}

/**
 * Native macOS Sequoia iMessage bubble curvature:
 * - Tail-bearing bubbles (`single`, `last`) tighten the tail-side bottom corner to
 *   `rounded-br-sm` / `rounded-bl-sm` (10px) so the overlapping SVG tail meets both the
 *   vertical wall and bottom edge with C1 continuity and zero dark notch.
 * - Intermediate stacked bubbles pinch only the shared seam to `rounded-xs` (6px).
 */
export function getBubbleRadiusClass(
  side: "sent" | "received",
  pos: BubbleGroupPos,
): string {
  if (side === "sent") {
    switch (pos) {
      case "single":
        return "rounded-lg rounded-br-sm";
      case "first":
        return "rounded-lg rounded-br-xs";
      case "middle":
        return "rounded-lg rounded-tr-xs rounded-br-xs";
      case "last":
        return "rounded-lg rounded-tr-xs rounded-br-sm";
    }
  }
  switch (pos) {
    case "single":
      return "rounded-lg rounded-bl-sm";
    case "first":
      return "rounded-lg rounded-bl-xs";
    case "middle":
      return "rounded-lg rounded-tl-xs rounded-bl-xs";
    case "last":
      return "rounded-lg rounded-tl-xs rounded-bl-sm";
  }
}

export function shouldShowBubbleTail(pos: BubbleGroupPos): boolean {
  return pos === "single" || pos === "last";
}

/**
 * Overlapping Apple iMessage tail (16×18):
 * - x=0..10 sits inside the bubble's 10px bottom corner radius (`rounded-br-sm` / `rounded-bl-sm`),
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
