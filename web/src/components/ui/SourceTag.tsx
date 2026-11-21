"use client";

import React from "react";
import { useLocale } from "@/lib/i18n";

const EMPHASIZED_SOURCES = new Set(["erp", "mcp"]);

export interface SourceTagProps {
  source: string;
  className?: string;
}

export function SourceTag({ source, className = "" }: SourceTagProps) {
  const { localizeSource } = useLocale();
  const normalized = source.toLowerCase();
  const emphasis = EMPHASIZED_SOURCES.has(normalized);
  const label = localizeSource(normalized);

  return (
    <span
      className={[
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium leading-none",
        emphasis
          ? "bg-[var(--accent-wash)] text-[var(--accent-ink)]"
          : "bg-[var(--bg-surface-subtle)] text-[var(--ink-muted)]",
        className,
      ].join(" ")}
    >
      {label}
    </span>
  );
}
