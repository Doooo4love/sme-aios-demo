"use client";

import React from "react";
import { AlertDialog } from "radix-ui";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import { Button, type ConfirmDialogMetadataItem } from "@/components/ui";

export interface ActionConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  scopeSummary?: string;
  metadata?: ConfirmDialogMetadataItem[];
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  loading?: boolean;
  onConfirm: () => void | Promise<void>;
  dialogTestId?: string;
  confirmTestId?: string;
  cancelTestId?: string;
  children?: React.ReactNode;
}

export function ActionConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  scopeSummary,
  metadata,
  confirmLabel = "确认执行",
  cancelLabel = "取消",
  destructive = false,
  loading = false,
  onConfirm,
  dialogTestId = "confirm-dialog",
  confirmTestId = "confirm-dialog-submit",
  cancelTestId = "confirm-dialog-cancel",
  children,
}: ActionConfirmDialogProps) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-[var(--scrim)]" />
        <AlertDialog.Content
          data-testid={dialogTestId}
          className={[
            "fixed left-1/2 top-1/2 z-50 w-[min(480px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2",
            "bg-[var(--bg-sheet)] border border-[var(--hairline-strong)] rounded-[6px]",
            "shadow-[var(--shadow-modal)] p-5 focus:outline-none",
          ].join(" ")}
        >
          <div className="flex items-start gap-3">
            <div
              className={[
                "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[4px] border",
                destructive
                  ? "border-[var(--status-crimson-border)] bg-[var(--status-crimson-wash)] text-[var(--status-crimson)]"
                  : "border-[var(--accent-border)] bg-[var(--accent-wash)] text-[var(--accent)]",
              ].join(" ")}
            >
              {destructive ? (
                <AlertTriangle className="h-4 w-4" strokeWidth={1.75} />
              ) : (
                <ShieldCheck className="h-4 w-4" strokeWidth={1.75} />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <AlertDialog.Title className="text-[15px] font-semibold text-[var(--ink-primary)] leading-snug">
                {title}
              </AlertDialog.Title>
              <AlertDialog.Description className="mt-1.5 text-[13.5px] text-[var(--ink-secondary)] leading-relaxed">
                {description}
              </AlertDialog.Description>
            </div>
          </div>

          {scopeSummary && (
            <div className="mt-4 rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] px-3 py-2 text-[12.5px] text-[var(--ink-secondary)]">
              <span className="font-medium text-[var(--ink-primary)]">
                影响范围：
              </span>
              {scopeSummary}
            </div>
          )}

          {metadata && metadata.length > 0 && (
            <dl className="mt-3 divide-y divide-[var(--hairline-subtle)] rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)]">
              {metadata.map((item) => (
                <div
                  key={item.label}
                  className="flex items-center justify-between gap-3 px-3 py-1.5 text-[12px]"
                >
                  <dt className="text-[var(--ink-muted)] shrink-0">
                    {item.label}
                  </dt>
                  <dd
                    className={[
                      "text-[var(--ink-primary)] text-right break-all",
                      item.mono ? "font-mono-code" : "tabular-nums",
                    ].join(" ")}
                  >
                    {item.value}
                  </dd>
                </div>
              ))}
            </dl>
          )}

          {children && <div className="mt-3">{children}</div>}

          <div className="mt-5 flex items-center justify-end gap-2 border-t border-[var(--hairline)] pt-3.5">
            <AlertDialog.Cancel asChild>
              <Button
                variant="secondary"
                disabled={loading}
                data-testid={cancelTestId}
              >
                {cancelLabel}
              </Button>
            </AlertDialog.Cancel>
            <Button
              variant={destructive ? "danger-solid" : "primary"}
              loading={loading}
              data-testid={confirmTestId}
              onClick={() => void onConfirm()}
            >
              {confirmLabel}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
