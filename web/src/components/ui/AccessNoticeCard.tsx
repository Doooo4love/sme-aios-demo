"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  Clock,
  Lock,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import type { ApiError } from "@/lib/api-client";
import { sortWarehouses } from "@/lib/format";
import { useLocale } from "@/lib/i18n";
import { Button } from "@/components/ui/Button";

export interface AccessNoticeCardProps {
  error?: ApiError | null;
  variant?:
    | "ACCESS_RESTRICTED"
    | "ACTION_NOT_ALLOWED"
    | "ACCESS_CHANGED"
    | "RECORD_UNAVAILABLE"
    | "CONFLICT"
    | "RETRY_LATER";
  title?: string;
  message?: string;
  requestId?: string | null;
  retryAfter?: number | null;
  runId?: string | null;
  authorizedWarehouses?: string[];
  onSelectWarehouse?: (warehouse: string) => void;
  viewProposalId?: string | null;
  onRetry?: () => void;
  backHref?: string;
  backLabel?: string;
  className?: string;
}

function inferVariant(
  error?: ApiError | null,
  explicit?: AccessNoticeCardProps["variant"],
): NonNullable<AccessNoticeCardProps["variant"]> {
  if (explicit) return explicit;
  if (!error) return "RECORD_UNAVAILABLE";
  if (error.status === 404 || error.code === "RECORD_UNAVAILABLE") {
    return "RECORD_UNAVAILABLE";
  }
  if (error.code === "ACCESS_CHANGED") return "ACCESS_CHANGED";
  if (error.code === "ACTION_NOT_ALLOWED") return "ACTION_NOT_ALLOWED";
  if (error.status === 403) return "ACCESS_RESTRICTED";
  if (error.status === 409) return "CONFLICT";
  if (error.status === 429 || error.status >= 500) return "RETRY_LATER";
  return "ACCESS_RESTRICTED";
}

export function AccessNoticeCard({
  error,
  variant: explicitVariant,
  title,
  message,
  requestId,
  retryAfter,
  runId,
  authorizedWarehouses,
  onSelectWarehouse,
  viewProposalId,
  onRetry,
  backHref,
  backLabel,
  className = "",
}: AccessNoticeCardProps) {
  const { t, localizeError } = useLocale();
  const variant = inferVariant(error, explicitVariant);
  const initialSeconds = retryAfter ?? error?.retryAfter ?? null;
  const [countdown, setCountdown] = useState<number>(initialSeconds ?? 0);

  useEffect(() => {
    setCountdown(initialSeconds ?? 0);
  }, [initialSeconds]);

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = window.setInterval(() => {
      setCountdown((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [countdown]);

  const effectiveRequestId = requestId ?? error?.requestId ?? null;
  const effectiveRunId = runId ?? error?.runId ?? null;
  const effectiveProposalId = viewProposalId ?? error?.viewProposalId ?? null;
  const warehouses = sortWarehouses(
    authorizedWarehouses ?? error?.warehouses ?? [],
  );

  const config = (() => {
    switch (variant) {
      case "RECORD_UNAVAILABLE":
        return {
          tone: "bg-[var(--bg-surface)] shadow-[var(--shadow-card)]",
          iconBox:
            "bg-[var(--bg-surface-subtle)] text-[var(--ink-secondary)]",
          Icon: Lock,
          defaultTitle: t("notice.recordUnavailable.title"),
          defaultMessage: t("notice.recordUnavailable.message"),
        };
      case "ACCESS_RESTRICTED":
        return {
          tone: "bg-[var(--status-crimson-wash)]",
          iconBox:
            "bg-[var(--bg-surface)] text-[var(--status-crimson)] shadow-[var(--shadow-subtle)]",
          Icon: ShieldAlert,
          defaultTitle: t("notice.accessRestricted.title"),
          defaultMessage: t("notice.accessRestricted.message"),
        };
      case "ACTION_NOT_ALLOWED":
        return {
          tone: "bg-[var(--status-amber-wash)]",
          iconBox:
            "bg-[var(--bg-surface)] text-[var(--status-amber-ink)] shadow-[var(--shadow-subtle)]",
          Icon: ShieldAlert,
          defaultTitle: t("notice.actionNotAllowed.title"),
          defaultMessage: t("notice.actionNotAllowed.message"),
        };
      case "ACCESS_CHANGED":
        return {
          tone: "bg-[var(--status-amber-wash)]",
          iconBox:
            "bg-[var(--bg-surface)] text-[var(--status-amber-ink)] shadow-[var(--shadow-subtle)]",
          Icon: AlertTriangle,
          defaultTitle: t("notice.accessChanged.title"),
          defaultMessage: t("notice.accessChanged.message"),
        };
      case "CONFLICT":
        return {
          tone: "bg-[var(--status-amber-wash)]",
          iconBox:
            "bg-[var(--bg-surface)] text-[var(--status-amber-ink)] shadow-[var(--shadow-subtle)]",
          Icon: RefreshCw,
          defaultTitle: t("notice.conflict.title"),
          defaultMessage: t("notice.conflict.message"),
        };
      case "RETRY_LATER":
        return {
          tone: "bg-[var(--status-amber-wash)]",
          iconBox:
            "bg-[var(--bg-surface)] text-[var(--status-amber-ink)] shadow-[var(--shadow-subtle)]",
          Icon: Clock,
          defaultTitle: t("notice.retryLater.title"),
          defaultMessage:
            countdown > 0
              ? t("notice.retryLater.countdown", { seconds: countdown })
              : t("notice.retryLater.ready"),
        };
    }
  })();

  const Icon = config.Icon;
  const displayTitle = title ?? config.defaultTitle;
  const localizedErrorMessage = error ? localizeError(error) : undefined;
  const displayMessage =
    variant === "RECORD_UNAVAILABLE"
      ? t("notice.recordUnavailable.message")
      : (message ?? localizedErrorMessage ?? config.defaultMessage);

  return (
    <div
      role="alert"
      className={["rounded-md p-4", config.tone, className].join(" ")}
    >
      <div className="flex items-start gap-3">
        <div
          className={[
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
            config.iconBox,
          ].join(" ")}
        >
          <Icon className="h-4 w-4" strokeWidth={1.85} aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-semibold text-[var(--ink-primary)]">
            {displayTitle}
          </h3>
          <p className="mt-1 text-[13px] text-[var(--ink-secondary)] leading-relaxed">
            {displayMessage}
          </p>

          {variant === "RETRY_LATER" && countdown > 0 && (
            <p className="mt-1.5 tabular-nums text-[12px] text-[var(--status-amber-ink)]">
              Retry-After:{" "}
              <span className="font-mono-code">{countdown}s</span>
            </p>
          )}

          {warehouses.length > 0 && onSelectWarehouse && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <span className="text-[12px] text-[var(--ink-muted)] mr-1">
                {t("notice.authorizedWarehouses")}
              </span>
              {warehouses.map((wh) => (
                <Button
                  key={wh}
                  size="sm"
                  pill
                  variant="secondary"
                  onClick={() => onSelectWarehouse(wh)}
                >
                  {t("notice.switchWarehouse", { warehouse: wh })}
                </Button>
              ))}
            </div>
          )}

          {(effectiveProposalId || onRetry || backHref) && (
            <div className="mt-3.5 flex flex-wrap items-center gap-2">
              {effectiveProposalId && (
                <Link
                  href={`/proposals/${encodeURIComponent(effectiveProposalId)}`}
                  className="inline-flex h-8 items-center gap-1.5 rounded-full bg-[var(--bg-surface)] px-3.5 text-[12.5px] font-medium text-[var(--ink-primary)] shadow-[var(--shadow-subtle)] hover:shadow-[var(--shadow-card)] transition-shadow"
                >
                  <span>{t("notice.viewProposalDetail")}</span>
                  <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.8} />
                </Link>
              )}

              {onRetry && (
                <Button
                  size="sm"
                  pill
                  variant="secondary"
                  disabled={variant === "RETRY_LATER" && countdown > 0}
                  onClick={onRetry}
                >
                  <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.8} />
                  <span>
                    {variant === "RETRY_LATER" && countdown > 0
                      ? t("notice.waitSeconds", { seconds: countdown })
                      : variant === "CONFLICT"
                        ? t("notice.refreshSnapshot")
                        : t("common.retry")}
                  </span>
                </Button>
              )}

              {backHref && (
                <Link
                  href={backHref}
                  className="inline-flex h-8 items-center rounded-full bg-[var(--bg-surface)] px-3.5 text-[12.5px] font-medium text-[var(--ink-primary)] shadow-[var(--shadow-subtle)] hover:shadow-[var(--shadow-card)] transition-shadow"
                >
                  {backLabel ?? t("common.backToWorkbench")}
                </Link>
              )}
            </div>
          )}

          {(effectiveRequestId || effectiveRunId) && (
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[var(--hairline-subtle)] pt-2 text-[11px] text-[var(--ink-muted)]">
              {effectiveRequestId && (
                <span>
                  {t("common.requestId")}:{" "}
                  <span className="font-mono-code">{effectiveRequestId}</span>
                </span>
              )}
              {effectiveRunId && (
                <span>
                  {t("common.runId")}:{" "}
                  <span className="font-mono-code">{effectiveRunId}</span>
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
