"use client";

import React from "react";
import { AlertDialog } from "radix-ui";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import { useLocale } from "@/lib/i18n";
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
  confirmLabel,
  cancelLabel,
  destructive = false,
  loading = false,
  onConfirm,
  dialogTestId = "confirm-dialog",
  confirmTestId = "confirm-dialog-submit",
  cancelTestId = "confirm-dialog-cancel",
  children,
}: ActionConfirmDialogProps) {
  const { t } = useLocale();
  const resolvedConfirm = confirmLabel ?? t("common.confirmExecute");
  const resolvedCancel = cancelLabel ?? t("common.cancel");

  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="aios-modal-scrim fixed inset-0 z-50 bg-[var(--scrim)] backdrop-blur-[4px]" />
        <AlertDialog.Content
          data-testid={dialogTestId}
          className={[
            "aios-modal-content fixed left-1/2 top-1/2 z-50 w-[min(480px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2",
            "border border-[var(--hairline-strong)] bg-[var(--bg-surface)] rounded-modal shadow-[var(--shadow-modal)] p-6 focus:outline-none",
          ].join(" ")}
        >
          <div className="flex items-start gap-3.5">
            <div
              className={[
                "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-sm border",
                destructive
                  ? "border-[var(--status-crimson-border)] bg-[var(--status-crimson-wash)] text-[var(--status-crimson)]"
                  : "border-[var(--accent-border)] bg-[var(--accent-wash)] text-[var(--accent-ink)]",
              ].join(" ")}
            >
              {destructive ? (
                <AlertTriangle className="h-4.5 w-4.5" strokeWidth={1.85} />
              ) : (
                <ShieldCheck className="h-4.5 w-4.5" strokeWidth={1.85} />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <AlertDialog.Title className="aios-display text-[15.5px] font-semibold text-[var(--ink-primary)] leading-snug">
                {title}
              </AlertDialog.Title>
              <AlertDialog.Description className="mt-1.5 text-[13.5px] text-[var(--ink-secondary)] leading-relaxed">
                {description}
              </AlertDialog.Description>
            </div>
          </div>

          {scopeSummary && (
            <div className="mt-4 rounded-md bg-[var(--bg-surface-tint)] px-3.5 py-2.5 text-[12.5px] text-[var(--ink-secondary)] leading-relaxed">
              <span className="font-medium text-[var(--ink-primary)]">
                {t("common.impactScope")}
              </span>
              {scopeSummary}
            </div>
          )}

          {metadata && metadata.length > 0 && (
            <dl className="mt-3 divide-y divide-[var(--hairline-subtle)] rounded-md bg-[var(--bg-surface-tint)]">
              {metadata.map((item) => (
                <div
                  key={item.label}
                  className="flex items-center justify-between gap-3 px-3.5 py-2 text-[12px]"
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

          {children && <div className="mt-3.5">{children}</div>}

          <div className="mt-6 flex items-center justify-end gap-2.5">
            <AlertDialog.Cancel asChild>
              <Button
                variant="secondary"
                disabled={loading}
                data-testid={cancelTestId}
              >
                {resolvedCancel}
              </Button>
            </AlertDialog.Cancel>
            <Button
              variant={destructive ? "danger-solid" : "primary"}
              loading={loading}
              data-testid={confirmTestId}
              onClick={() => void onConfirm()}
            >
              {resolvedConfirm}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
