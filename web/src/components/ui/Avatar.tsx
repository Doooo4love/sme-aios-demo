"use client";

import React, { useEffect, useState } from "react";
import { getMonogram } from "@/lib/format";

export type AvatarStatus = "online" | "busy" | "offline" | "verified";

export interface AvatarProps {
  src?: string | null;
  name?: string | null;
  fallbackText: string;
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  kind?: "user" | "agent";
  status?: AvatarStatus;
  className?: string;
}

const SIZE_MAP: Record<
  NonNullable<AvatarProps["size"]>,
  { box: string; text: string; dot: string; agentIcon: string }
> = {
  xs: {
    box: "h-6 w-6",
    text: "text-[10.5px]",
    dot: "h-2 w-2 right-0 bottom-0 ring-[1.5px]",
    agentIcon: "h-3 w-3",
  },
  sm: {
    box: "h-8 w-8",
    text: "text-[12px]",
    dot: "h-2.5 w-2.5 right-0 bottom-0 ring-2",
    agentIcon: "h-3.5 w-3.5",
  },
  md: {
    box: "h-9 w-9",
    text: "text-[13px]",
    dot: "h-2.5 w-2.5 right-0 bottom-0 ring-2",
    agentIcon: "h-4 w-4",
  },
  lg: {
    box: "h-14 w-14",
    text: "text-[19px]",
    dot: "h-3.5 w-3.5 right-0.5 bottom-0.5 ring-2",
    agentIcon: "h-6 w-6",
  },
  xl: {
    box: "h-[72px] w-[72px]",
    text: "text-[24px]",
    dot: "h-4 w-4 right-0.5 bottom-0.5 ring-2",
    agentIcon: "h-8 w-8",
  },
};

/**
 * 4 restrained theme-aware identity hues harmonized with both Light Porcelain & Dark Obsidian.
 */
const USER_TONES = [
  "bg-[var(--avatar-tone-0-bg)] text-[var(--avatar-tone-0-ink)]",
  "bg-[var(--avatar-tone-1-bg)] text-[var(--avatar-tone-1-ink)]",
  "bg-[var(--avatar-tone-2-bg)] text-[var(--avatar-tone-2-ink)]",
  "bg-[var(--avatar-tone-3-bg)] text-[var(--avatar-tone-3-ink)]",
] as const;

function pickUserTone(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return USER_TONES[Math.abs(hash) % USER_TONES.length]!;
}

const STATUS_DOT_COLOR: Record<AvatarStatus, string> = {
  online: "bg-[var(--status-emerald)]",
  busy: "bg-[var(--status-amber)]",
  offline: "bg-[var(--ink-faint)]",
  verified: "bg-[var(--accent)]",
};

export function Avatar({
  src,
  name,
  fallbackText,
  size = "sm",
  kind = "user",
  status,
  className = "",
}: AvatarProps) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  const dims = SIZE_MAP[size];
  const label = name || fallbackText;
  const rawMonogram = getMonogram(name, fallbackText);
  // Single clean CJK glyph (surname/first hanzi) avoids cramped 2-char circular fallbacks
  const monogram = /[\u4e00-\u9fff]/.test(rawMonogram)
    ? rawMonogram.slice(0, 1)
    : rawMonogram;

  const userTone = pickUserTone(fallbackText || label);

  return (
    <span
      className={[
        "relative inline-flex shrink-0 rounded-full select-none",
        dims.box,
        className,
      ].join(" ")}
    >
      {src && !failed ? (
        <span className="inline-flex h-full w-full overflow-hidden rounded-full bg-[var(--bg-surface-subtle)] ring-1 ring-[var(--hairline)]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={label}
            className="h-full w-full object-cover"
            onError={() => setFailed(true)}
          />
        </span>
      ) : (
        <span
          role="img"
          aria-label={label}
          className={[
            "inline-flex h-full w-full items-center justify-center overflow-hidden rounded-full whitespace-nowrap leading-none font-semibold ring-1",
            kind === "agent"
              ? "bg-[image:var(--agent-surface)] text-[var(--accent-ink)] ring-[var(--agent-ring)]"
              : `${userTone} ring-[var(--hairline)]`,
            dims.text,
          ].join(" ")}
        >
          {kind === "agent" ? (
            <svg
              viewBox="0 0 20 20"
              className={dims.agentIcon}
              fill="none"
              aria-hidden="true"
            >
              <circle
                cx="10"
                cy="10"
                r="7.2"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeOpacity="0.35"
              />
              <circle
                cx="10"
                cy="10"
                r="4.2"
                stroke="currentColor"
                strokeWidth="1.6"
              />
              <circle cx="10" cy="10" r="1.6" fill="currentColor" />
            </svg>
          ) : (
            monogram
          )}
        </span>
      )}

      {status && (
        <span
          aria-hidden="true"
          className={[
            "absolute rounded-full ring-[var(--bg-surface)]",
            dims.dot,
            STATUS_DOT_COLOR[status],
          ].join(" ")}
        />
      )}
    </span>
  );
}
