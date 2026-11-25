"use client";

import React from "react";
import { ChevronRight } from "lucide-react";
import { Avatar, type AvatarStatus } from "@/components/ui/Avatar";

export interface ConversationHeaderProps {
  /** Left action slot (e.g. mobile Back pill) */
  leftSlot?: React.ReactNode;
  /** Right action slot (e.g. Workbench pill or Zoom / Members pills) */
  rightSlot?: React.ReactNode;
  /** Center identity avatar + pill config */
  avatarSrc?: string | null;
  avatarName: string;
  avatarFallbackText: string;
  avatarKind?: "user" | "agent";
  avatarStatus?: AvatarStatus;
  title: string;
  titleTestId?: string;
  subtitle?: string | null;
  onOpenProfile?: () => void;
  profileAriaLabel?: string;
  profileButtonTestId?: string;
  scrolled?: boolean;
}

/**
 * Authentic macOS Sequoia / iOS Messages floating borderless sticky header:
 * - Zero hairline divider: floats transparently above the message stream
 * - Progressive gradient blur veil fades gently at rest and intensifies on hover / focus / scroll
 * - Horizontally centered Avatar + cleanly separated frosted Name · Role › capsule
 */
export function ConversationHeader({
  leftSlot,
  rightSlot,
  avatarSrc,
  avatarName,
  avatarFallbackText,
  avatarKind = "user",
  avatarStatus,
  title,
  titleTestId,
  subtitle,
  onOpenProfile,
  profileAriaLabel,
  profileButtonTestId = "conversation-header-profile-btn",
  scrolled = false,
}: ConversationHeaderProps) {
  return (
    <header
      data-scrolled={scrolled ? "true" : "false"}
      className="aios-chat-header @container sticky top-0 z-20 -mb-[88px] h-[88px] shrink-0"
    >
      <div aria-hidden="true" className="aios-chat-header-veil" />

      <div className="relative z-10 grid h-full grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 px-3 sm:px-5">
        {/* Left Action Slot */}
        <div className="flex min-w-0 items-center justify-start gap-1.5">
          {leftSlot}
        </div>

        {/* Center Floating Identity Trigger */}
        <div className="flex min-w-0 justify-center">
          <button
            type="button"
            data-testid={profileButtonTestId}
            aria-label={profileAriaLabel || title}
            onClick={onOpenProfile}
            disabled={!onOpenProfile}
            className={[
              "group flex min-w-0 max-w-[clamp(108px,calc(100cqw-244px),260px)] md:max-w-[clamp(200px,calc(100cqw-468px),340px)] flex-col items-center justify-center gap-2 rounded-modal px-2 py-0.5 transition-transform duration-[150ms]",
              onOpenProfile
                ? "cursor-pointer active:scale-[0.98]"
                : "cursor-default",
            ].join(" ")}
          >
            <Avatar
              src={avatarSrc}
              name={avatarName}
              fallbackText={avatarFallbackText}
              size="sm"
              kind={avatarKind}
              status={avatarStatus}
              className="shadow-[var(--shadow-subtle)] transition-transform duration-[150ms] group-hover:scale-[1.04]"
            />

            <span className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-[var(--hairline)] bg-[var(--bg-surface)]/82 px-2.5 py-[2.5px] shadow-[var(--shadow-subtle)] backdrop-blur-md transition-all duration-[150ms] group-hover:border-[var(--accent-border)] group-hover:bg-[var(--bg-surface)]">
              <span
                data-testid={titleTestId}
                className="min-w-0 truncate text-[12.5px] font-semibold tracking-[-0.015em] text-[var(--ink-primary)] group-hover:text-[var(--accent-ink)]"
              >
                {title}
              </span>
              {subtitle && (
                <span className="hidden sm:inline min-w-0 shrink-[2] truncate max-w-[min(220px,32cqw)] text-[11px] font-normal text-[var(--ink-muted)]">
                  · {subtitle}
                </span>
              )}
              {onOpenProfile && (
                <ChevronRight
                  className="h-3 w-3 shrink-0 text-[var(--ink-muted)] transition-transform duration-[150ms] group-hover:translate-x-[1px] group-hover:text-[var(--accent)]"
                  strokeWidth={2.2}
                  aria-hidden="true"
                />
              )}
            </span>
          </button>
        </div>

        {/* Right Action Slot */}
        <div className="flex min-w-0 items-center justify-end gap-1.5">
          {rightSlot}
        </div>
      </div>
    </header>
  );
}
