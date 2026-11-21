"use client";

import React from "react";

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "ghost"
  | "quiet"
  | "danger"
  | "danger-solid";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  pill?: boolean;
  loading?: boolean;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    "bg-[var(--accent-solid)] text-[var(--accent-fg)] shadow-[0_1px_2px_rgba(22,104,227,0.22)] hover:bg-[var(--accent-solid-hover)] hover:shadow-[0_4px_12px_-2px_rgba(22,104,227,0.32)] active:bg-[var(--accent-solid-active)] disabled:bg-[var(--bg-surface-subtle)] disabled:text-[var(--ink-muted)] disabled:shadow-none disabled:opacity-75",
  secondary:
    "bg-[var(--bg-surface)] text-[var(--ink-primary)] shadow-[var(--shadow-subtle)] hover:bg-[var(--bg-surface-tint)] hover:shadow-[var(--shadow-card)] disabled:opacity-45",
  ghost:
    "bg-transparent text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--ink-primary)] disabled:opacity-45",
  quiet:
    "bg-transparent text-[var(--accent-ink)] hover:bg-[var(--accent-wash)] active:bg-[var(--accent-wash-strong)] disabled:opacity-45",
  danger:
    "bg-[var(--status-crimson-wash)] text-[var(--status-crimson)] hover:bg-[var(--status-crimson-border)] disabled:opacity-45",
  "danger-solid":
    "bg-[var(--status-crimson-solid)] text-white shadow-[0_1px_2px_rgba(201,42,55,0.28)] hover:opacity-92 disabled:opacity-45",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-[12.5px] gap-1.5",
  md: "h-9 px-3.5 text-[13px] gap-2",
  lg: "h-11 px-4.5 text-[14px] gap-2",
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = "secondary",
      size = "md",
      pill = false,
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
          pill ? "rounded-full" : "rounded-sm",
          "transition-[background-color,box-shadow,color,opacity,transform] duration-[150ms] ease-[var(--ease-settle)]",
          "active:scale-[0.98] cursor-pointer disabled:cursor-not-allowed disabled:active:scale-100",
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
