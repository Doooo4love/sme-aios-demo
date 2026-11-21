"use client";

import React, { useEffect, useState } from "react";
import { getMonogram } from "@/lib/format";

export interface AvatarProps {
  src?: string | null;
  name?: string | null;
  fallbackText: string;
  size?: "xs" | "sm" | "md" | "lg";
  kind?: "user" | "agent";
  className?: string;
}

const SIZE_MAP: Record<
  NonNullable<AvatarProps["size"]>,
  { box: string; text: string; radius: string }
> = {
  xs: { box: "h-6 w-6", text: "text-[10px]", radius: "rounded-[4px]" },
  sm: { box: "h-7 w-7", text: "text-[11px]", radius: "rounded-[4px]" },
  md: { box: "h-8 w-8", text: "text-[12px]", radius: "rounded-[4px]" },
  lg: { box: "h-[72px] w-[72px]", text: "text-[20px]", radius: "rounded-[6px]" },
};

export function Avatar({
  src,
  name,
  fallbackText,
  size = "sm",
  kind = "user",
  className = "",
}: AvatarProps) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  const dims = SIZE_MAP[size];
  const label = name || fallbackText;
  const monogram = getMonogram(name, fallbackText);

  if (src && !failed) {
    return (
      <span
        className={[
          "relative inline-flex shrink-0 overflow-hidden border border-[var(--hairline-strong)] bg-[var(--bg-subtle)]",
          dims.box,
          dims.radius,
          className,
        ].join(" ")}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={label}
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      </span>
    );
  }

  return (
    <span
      role="img"
      aria-label={label}
      className={[
        "inline-flex shrink-0 items-center justify-center border font-mono-code font-semibold select-none",
        kind === "agent"
          ? "border-[var(--accent-border)] bg-[var(--accent-wash)] text-[var(--accent)]"
          : "border-[var(--hairline-strong)] bg-[var(--bg-sheet)] text-[var(--ink-secondary)]",
        dims.box,
        dims.text,
        dims.radius,
        className,
      ].join(" ")}
    >
      {kind === "agent" ? (
        <svg
          viewBox="0 0 16 16"
          className={size === "lg" ? "h-8 w-8" : "h-3.5 w-3.5"}
          fill="none"
          aria-hidden="true"
        >
          <polygon
            points="8,1.5 14.5,5.25 14.5,10.75 8,14.5 1.5,10.75 1.5,5.25"
            stroke="currentColor"
            strokeWidth="1.4"
          />
          <rect
            x="6.25"
            y="6.25"
            width="3.5"
            height="3.5"
            transform="rotate(45 8 8)"
            fill="currentColor"
          />
        </svg>
      ) : (
        monogram
      )}
    </span>
  );
}
