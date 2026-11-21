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
 * Native macOS Sequoia bubble curvature:
 * - Bubbles WITH an SVG tail (`single`, `last`) keep full 18px (`rounded-lg`) bottom corner
 *   so the SVG tail integrates seamlessly without double-corner pinching.
 * - Intermediate bubbles pinch only the stacked seam to 6px (`rounded-xs`).
 */
export function getBubbleRadiusClass(
  side: "sent" | "received",
  pos: BubbleGroupPos,
): string {
  if (side === "sent") {
    switch (pos) {
      case "single":
        return "rounded-lg";
      case "first":
        return "rounded-lg rounded-br-xs";
      case "middle":
        return "rounded-lg rounded-tr-xs rounded-br-xs";
      case "last":
        return "rounded-lg rounded-tr-xs";
    }
  }
  switch (pos) {
    case "single":
      return "rounded-lg";
    case "first":
      return "rounded-lg rounded-bl-xs";
    case "middle":
      return "rounded-lg rounded-tl-xs rounded-bl-xs";
    case "last":
      return "rounded-lg rounded-tl-xs";
  }
}

export function shouldShowBubbleTail(pos: BubbleGroupPos): boolean {
  return pos === "single" || pos === "last";
}

export function IMessageBubbleTail({
  side,
  className = "",
}: {
  side: "sent" | "received";
  className?: string;
}) {
  return (
    <svg
      width="11"
      height="16"
      viewBox="0 0 11 16"
      aria-hidden="true"
      className={[
        "imessage-tail",
        side === "sent"
          ? "-right-[5px] text-[var(--accent)]"
          : "-left-[5px] -scale-x-100 text-[var(--agent-bubble-bg)]",
        className,
      ].join(" ")}
    >
      <path
        d="M0 0C0 8.5 3.5 14 11 16C5.5 16 1.5 14.5 0 12.5V0Z"
        fill="currentColor"
      />
    </svg>
  );
}
