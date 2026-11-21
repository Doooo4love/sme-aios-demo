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
  backLabel = "返回工作台",
  className = "",
}: AccessNoticeCardProps) {
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
  const warehouses = authorizedWarehouses ?? error?.warehouses ?? [];

  const config = (() => {
    switch (variant) {
      case "RECORD_UNAVAILABLE":
        return {
          tone: "bg-[var(--bg-surface)] shadow-[var(--shadow-card)]",
          iconBox:
            "bg-[var(--bg-surface-subtle)] text-[var(--ink-secondary)]",
          Icon: Lock,
          defaultTitle: "记录不可访问",
          defaultMessage: "当前账号无法访问这条记录。",
        };
      case "ACCESS_RESTRICTED":
        return {
          tone: "bg-[var(--status-crimson-wash)]",
          iconBox:
            "bg-[var(--bg-surface)] text-[var(--status-crimson)] shadow-[var(--shadow-subtle)]",
          Icon: ShieldAlert,
          defaultTitle: "访问范围受限",
          defaultMessage: "当前账号无权执行此操作或访问该站点范围。",
        };
      case "ACTION_NOT_ALLOWED":
        return {
          tone: "bg-[var(--status-amber-wash)]",
          iconBox:
            "bg-[var(--bg-surface)] text-[var(--status-amber)] shadow-[var(--shadow-subtle)]",
          Icon: ShieldAlert,
          defaultTitle: "当前账号不可执行该动作",
          defaultMessage:
            "该操作需要独立审批授权或更高级别范围，您可以只读查看单据详情。",
        };
      case "ACCESS_CHANGED":
        return {
          tone: "bg-[var(--status-amber-wash)]",
          iconBox:
            "bg-[var(--bg-surface)] text-[var(--status-amber)] shadow-[var(--shadow-subtle)]",
          Icon: AlertTriangle,
          defaultTitle: "访问权限已变更",
          defaultMessage: "访问权限已变更，已清除旧视图并同步刷新可用能力。",
        };
      case "CONFLICT":
        return {
          tone: "bg-[var(--status-amber-wash)]",
          iconBox:
            "bg-[var(--bg-surface)] text-[var(--status-amber)] shadow-[var(--shadow-subtle)]",
          Icon: RefreshCw,
          defaultTitle: "数据快照已更新",
          defaultMessage: "数据已更新，请刷新并核对最新快照后再确认。",
        };
      case "RETRY_LATER":
        return {
          tone: "bg-[var(--status-amber-wash)]",
          iconBox:
            "bg-[var(--bg-surface)] text-[var(--status-amber)] shadow-[var(--shadow-subtle)]",
          Icon: Clock,
          defaultTitle: "服务繁忙或上游连接暂不可用",
          defaultMessage:
            countdown > 0
              ? `服务繁忙或连接器暂不可用，请在 ${countdown} 秒后重试。`
              : "服务繁忙或连接器暂不可用，请保留当前输入后点击重试。",
        };
    }
  })();

  const Icon = config.Icon;
  const displayTitle = title ?? config.defaultTitle;
  const displayMessage =
    variant === "RECORD_UNAVAILABLE"
      ? "当前账号无法访问这条记录。"
      : (message ?? error?.message ?? config.defaultMessage);

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
            <p className="mt-1.5 font-mono-code text-[12px] text-[var(--status-amber-ink)]">
              Retry-After: {countdown}s
            </p>
          )}

          {warehouses.length > 0 && onSelectWarehouse && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <span className="text-[12px] text-[var(--ink-muted)] mr-1">
                当前已授权仓库：
              </span>
              {warehouses.map((wh) => (
                <Button
                  key={wh}
                  size="sm"
                  pill
                  variant="secondary"
                  onClick={() => onSelectWarehouse(wh)}
                  className="font-mono-code"
                >
                  切换至 {wh}
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
                  <span>查看单据详情</span>
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
                      ? `请等待 ${countdown}s`
                      : variant === "CONFLICT"
                        ? "刷新最新快照"
                        : "重新尝试"}
                  </span>
                </Button>
              )}

              {backHref && (
                <Link
                  href={backHref}
                  className="inline-flex h-8 items-center rounded-full bg-[var(--bg-surface)] px-3.5 text-[12.5px] font-medium text-[var(--ink-primary)] shadow-[var(--shadow-subtle)] hover:shadow-[var(--shadow-card)] transition-shadow"
                >
                  {backLabel}
                </Link>
              )}
            </div>
          )}

          {(effectiveRequestId || effectiveRunId) && (
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[var(--hairline-subtle)] pt-2 font-mono-code text-[11px] text-[var(--ink-muted)]">
              {effectiveRequestId && (
                <span>跟踪编号: {effectiveRequestId}</span>
              )}
              {effectiveRunId && <span>运行编号: {effectiveRunId}</span>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
