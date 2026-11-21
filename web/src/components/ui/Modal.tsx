"use client";

import React, { useState } from "react";
import { Dialog } from "radix-ui";
import { Maximize2, Minimize2, X } from "lucide-react";
import { useLocale } from "@/lib/i18n";

export interface ModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  subtitle?: string;
  size?: "sm" | "md" | "lg" | "xl";
  expandable?: boolean;
  footer?: React.ReactNode;
  children: React.ReactNode;
}

const SIZE_CLASSES: Record<NonNullable<ModalProps["size"]>, string> = {
  sm: "w-[min(440px,calc(100vw-24px))]",
  md: "w-[min(600px,calc(100vw-24px))]",
  lg: "w-[min(840px,calc(100vw-24px))]",
  xl: "w-[min(1080px,calc(100vw-24px))]",
};

export function Modal({
  open,
  onOpenChange,
  title,
  subtitle,
  size = "md",
  expandable = false,
  footer,
  children,
}: ModalProps) {
  const { t } = useLocale();
  const [expanded, setExpanded] = useState(false);

  const handleOpenChange = (next: boolean) => {
    if (!next) setExpanded(false);
    onOpenChange(next);
  };

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="aios-modal-scrim fixed inset-0 z-50 bg-[var(--scrim)] backdrop-blur-[6px]" />
        <Dialog.Content
          className={[
            "aios-modal-content fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 flex flex-col",
            "bg-[var(--bg-surface)] shadow-[var(--shadow-modal)] focus:outline-none overflow-hidden",
            expanded
              ? "h-[calc(100dvh-24px)] w-[calc(100vw-24px)] rounded-lg"
              : `${SIZE_CLASSES[size]} max-h-[calc(100dvh-48px)] rounded-lg`,
          ].join(" ")}
        >
          <div className="flex items-start justify-between gap-3 border-b border-[var(--hairline)] px-6 py-4 shrink-0">
            <div className="min-w-0">
              <Dialog.Title className="text-[15.5px] font-semibold tracking-[-0.01em] text-[var(--ink-primary)] truncate">
                {title}
              </Dialog.Title>
              {subtitle && (
                <Dialog.Description className="mt-0.5 text-[12.5px] text-[var(--ink-muted)]">
                  {subtitle}
                </Dialog.Description>
              )}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {expandable && (
                <button
                  type="button"
                  onClick={() => setExpanded((v) => !v)}
                  aria-label={
                    expanded
                      ? t("common.restoreWindowSize")
                      : t("common.expandFullscreen")
                  }
                  title={
                    expanded
                      ? t("common.restoreWindowSize")
                      : t("common.expandFullscreen")
                  }
                  className="inline-flex h-8 w-8 items-center justify-center rounded-full text-[var(--ink-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--ink-primary)] transition-colors cursor-pointer"
                >
                  {expanded ? (
                    <Minimize2 className="h-3.5 w-3.5" strokeWidth={1.8} />
                  ) : (
                    <Maximize2 className="h-3.5 w-3.5" strokeWidth={1.8} />
                  )}
                </button>
              )}
              <Dialog.Close asChild>
                <button
                  type="button"
                  aria-label={t("common.closeWindow")}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-full text-[var(--ink-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--ink-primary)] transition-colors cursor-pointer"
                >
                  <X className="h-4 w-4" strokeWidth={1.8} />
                </button>
              </Dialog.Close>
            </div>
          </div>

          <div className="flex-1 overflow-auto px-6 py-5">{children}</div>

          {footer && (
            <div className="flex items-center justify-end gap-2.5 border-t border-[var(--hairline)] bg-[var(--bg-surface-tint)] px-6 py-3.5 shrink-0">
              {footer}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
