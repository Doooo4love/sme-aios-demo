"use client";

import React from "react";

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "ghost"
  | "danger"
  | "danger-solid";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    "bg-[var(--accent)] text-[var(--accent-fg)] border border-[var(--accent)] hover:bg-[var(--accent-hover)] active:bg-[var(--accent-active)]",
  secondary:
    "bg-[var(--bg-sheet)] text-[var(--ink-primary)] border border-[var(--hairline-strong)] hover:bg-[var(--bg-subtle)] hover:border-[var(--ink-muted)]",
  ghost:
    "bg-transparent text-[var(--ink-secondary)] border border-transparent hover:bg-[var(--bg-plane)] hover:text-[var(--ink-primary)]",
  danger:
    "bg-[var(--bg-sheet)] text-[var(--status-crimson)] border border-[var(--status-crimson-border)] hover:bg-[var(--status-crimson-wash)]",
  "danger-solid":
    "bg-[var(--status-crimson)] text-white border border-[var(--status-crimson)] hover:opacity-92",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-[12px] gap-1.5",
  md: "h-9 px-3.5 text-[13.5px] gap-2",
  lg: "h-11 px-4 text-[14px] gap-2",
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = "secondary",
      size = "md",
      loading = false,
      disabled,
      className = "",
      type = "button",
      children,
      ...rest
    },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type={type}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        className={[
          "inline-flex shrink-0 items-center justify-center whitespace-nowrap font-medium select-none",
          "rounded-[4px] transition-[background-color,border-color,color,opacity] duration-[120ms]",
          "cursor-pointer disabled:cursor-not-allowed disabled:opacity-45",
          VARIANT_CLASSES[variant],
          SIZE_CLASSES[size],
          className,
        ].join(" ")}
        {...rest}
      >
        {children}
      </button>
    );
  },
);
