"use client";

import React from "react";

const SOURCE_LABELS: Record<string, { label: string; emphasis: boolean }> = {
  erp: { label: "ERP", emphasis: true },
  synthetic: { label: "合成数据", emphasis: false },
  finance: { label: "财务系统", emphasis: false },
  mail: { label: "企业邮箱", emphasis: false },
  decision: { label: "经营汇总", emphasis: false },
  internal: { label: "站内记录", emphasis: false },
  unconfigured: { label: "未配置", emphasis: false },
};

export interface SourceTagProps {
  source: string;
  className?: string;
}

export function SourceTag({ source, className = "" }: SourceTagProps) {
  const normalized = source.toLowerCase();
  const mapped = SOURCE_LABELS[normalized] ?? {
    label: source,
    emphasis: false,
  };

  return (
    <span
      className={[
        "inline-flex items-center rounded-[4px] border px-1.5 py-0.5 font-mono-code text-[11px] font-medium tracking-[0.03em] leading-none",
        mapped.emphasis
          ? "border-[var(--accent-border)] bg-[var(--accent-wash)] text-[var(--accent)]"
          : "border-[var(--hairline-strong)] bg-[var(--bg-subtle)] text-[var(--ink-muted)]",
        className,
      ].join(" ")}
    >
      {mapped.label}
    </span>
  );
}
