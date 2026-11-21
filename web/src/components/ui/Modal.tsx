"use client";

import React, { useState } from "react";
import { Dialog } from "radix-ui";
import { Maximize2, Minimize2, X } from "lucide-react";

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
  const [expanded, setExpanded] = useState(false);

  const handleOpenChange = (next: boolean) => {
    if (!next) setExpanded(false);
    onOpenChange(next);
  };

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-[var(--scrim)]" />
        <Dialog.Content
          className={[
            "fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 flex flex-col",
            "bg-[var(--bg-sheet)] border border-[var(--hairline-strong)] shadow-[var(--shadow-modal)] focus:outline-none",
            expanded
              ? "h-[calc(100dvh-24px)] w-[calc(100vw-24px)] rounded-[4px]"
              : `${SIZE_CLASSES[size]} max-h-[calc(100dvh-48px)] rounded-[6px]`,
          ].join(" ")}
        >
          <div className="flex items-start justify-between gap-3 border-b border-[var(--hairline)] px-5 py-3.5 shrink-0">
            <div className="min-w-0">
              <Dialog.Title className="text-[15px] font-semibold text-[var(--ink-primary)] truncate">
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
                  aria-label={expanded ? "还原窗口尺寸" : "全屏展开"}
                  title={expanded ? "还原窗口尺寸" : "全屏展开"}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-[4px] text-[var(--ink-muted)] hover:bg-[var(--bg-plane)] hover:text-[var(--ink-primary)] cursor-pointer"
                >
                  {expanded ? (
                    <Minimize2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                  ) : (
                    <Maximize2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                  )}
                </button>
              )}
              <Dialog.Close asChild>
                <button
                  type="button"
                  aria-label="关闭窗口"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-[4px] text-[var(--ink-muted)] hover:bg-[var(--bg-plane)] hover:text-[var(--ink-primary)] cursor-pointer"
                >
                  <X className="h-4 w-4" strokeWidth={1.75} />
                </button>
              </Dialog.Close>
            </div>
          </div>

          <div className="flex-1 overflow-auto px-5 py-4">{children}</div>

          {footer && (
            <div className="flex items-center justify-end gap-2 border-t border-[var(--hairline)] bg-[var(--bg-subtle)] px-5 py-3 shrink-0 rounded-b-[6px]">
              {footer}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
