"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Bell, ShieldAlert, X } from "lucide-react";
import {
  fetchWorkPulse,
  getAuthGeneration,
  isStaleAuthError,
  onAuthReset,
} from "@/lib/api-client";
import { useLocale } from "@/lib/i18n";
import { useSession } from "@/lib/session-context";
import { useWorkbench } from "@/lib/workbench-context";
import { TheodicMark } from "@/components/ui/TheodicBrand";
import { pushProactiveAlert } from "@/features/inbox/assistant-store";
import type { WorkAlertItem, WorkPulseResponse } from "@/lib/types";

const MAX_VISIBLE_TOASTS = 3;
const AUTO_DISMISS_MS = 9000;
const FALLBACK_POLL_MS = 15_000;
const SSE_RETRY_MS = 30_000;

const DEFAULT_AGENT_NAMES = new Set([
  "个人业务助手",
  "個人業務助手",
  "Personal Agent",
]);

interface ToastEntry {
  alert: WorkAlertItem;
  paused: boolean;
  remainingMs: number;
  lastResumedAt: number;
}

// Strict per-authGeneration deduplication (purged immediately on any auth reset)
let seenGen = getAuthGeneration();
let seenAlertIds = new Set<string>();
let hydratedGens = new Set<number>();

onAuthReset((_reason, nextGen) => {
  seenGen = nextGen;
  seenAlertIds = new Set<string>();
  hydratedGens = new Set<number>();
});

function ensureSeenStore(gen: number): Set<string> {
  if (seenGen !== gen) {
    seenGen = gen;
    seenAlertIds = new Set<string>();
    hydratedGens = new Set<number>();
  }
  return seenAlertIds;
}

function normalizeAlertPayload(raw: unknown): WorkAlertItem | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id.trim() : "";
  const title = typeof obj.title === "string" ? obj.title.trim() : "";
  if (!id || !title) return null;

  const rawSeverity =
    typeof obj.severity === "string" ? obj.severity.toLowerCase() : "info";
  const severity: WorkAlertItem["severity"] =
    rawSeverity === "critical" ||
    rawSeverity === "high" ||
    rawSeverity === "medium" ||
    rawSeverity === "info"
      ? rawSeverity
      : "info";

  const rawHref =
    typeof obj.href === "string" && obj.href.startsWith("/")
      ? obj.href
      : "/inbox/assistant";
  let normalizedHref = rawHref;
  if (rawHref === "/admin/security" || rawHref.startsWith("/admin/security?")) {
    const queryPart = rawHref.includes("?") ? rawHref.split("?")[1] : "";
    normalizedHref = queryPart
      ? `/admin?tab=security&${queryPart}`
      : "/admin?tab=security";
  }

  return {
    id,
    kind: typeof obj.kind === "string" ? obj.kind : "work_alert",
    title,
    subtitle: typeof obj.subtitle === "string" ? obj.subtitle : "",
    reference: typeof obj.reference === "string" ? obj.reference : null,
    href: normalizedHref,
    severity,
    created_at:
      typeof obj.created_at === "number" && Number.isFinite(obj.created_at)
        ? obj.created_at
        : Math.floor(Date.now() / 1000),
  };
}

export function ProactiveAgentNotifier() {
  const { status, actor, agentProfile, authGeneration } = useSession();
  const { setAssignedCount, setUnreadNoticesCount } = useWorkbench();
  const { t, tx, formatShortTime } = useLocale();

  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const eventSourceRef = useRef<EventSource | null>(null);
  const fallbackTimerRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);

  const enqueueToast = useCallback((alert: WorkAlertItem) => {
    const now = Date.now();
    setToasts((prev) => {
      if (prev.some((item) => item.alert.id === alert.id)) {
        return prev;
      }
      const next: ToastEntry = {
        alert,
        paused: false,
        remainingMs: AUTO_DISMISS_MS,
        lastResumedAt: now,
      };
      const merged = [next, ...prev];
      return merged.slice(0, MAX_VISIBLE_TOASTS);
    });
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((item) => item.alert.id !== id));
  }, []);

  const setToastPaused = useCallback((id: string, paused: boolean) => {
    const now = Date.now();
    setToasts((prev) =>
      prev.map((item) => {
        if (item.alert.id !== id) return item;
        if (paused && !item.paused) {
          const elapsed = now - item.lastResumedAt;
          return {
            ...item,
            paused: true,
            remainingMs: Math.max(800, item.remainingMs - elapsed),
          };
        }
        if (!paused && item.paused) {
          return {
            ...item,
            paused: false,
            lastResumedAt: now,
          };
        }
        return item;
      }),
    );
  }, []);

  // Auto-dismiss ticker respecting per-toast hover pause state
  useEffect(() => {
    if (toasts.length === 0) return;
    const intervalId = window.setInterval(() => {
      const now = Date.now();
      setToasts((prev) => {
        let changed = false;
        const kept = prev.filter((item) => {
          if (item.paused) return true;
          const expired = now - item.lastResumedAt >= item.remainingMs;
          if (expired) changed = true;
          return !expired;
        });
        return changed ? kept : prev;
      });
    }, 300);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [toasts.length]);

  const applyPulse = useCallback(
    (pulse: WorkPulseResponse, expectedGen: number) => {
      if (expectedGen !== getAuthGeneration()) return;

      if (actor && (actor.role === "manager" || actor.role === "admin")) {
        setAssignedCount(pulse.pending_approvals);
      }
      setUnreadNoticesCount(pulse.unread_notices);

      const seen = ensureSeenStore(expectedGen);
      const alreadyHydrated = hydratedGens.has(expectedGen);
      hydratedGens.add(expectedGen);
      const nowSec = Math.floor(Date.now() / 1000);

      // Process oldest-to-newest so assistant-store stays chronological
      const ordered = [...(pulse.latest_alerts ?? [])].sort(
        (a, b) => a.created_at - b.created_at,
      );

      for (const rawAlert of ordered) {
        const alert = normalizeAlertPayload(rawAlert);
        if (!alert) continue;
        if (seen.has(alert.id)) continue;
        seen.add(alert.id);

        const isRecent = nowSec - alert.created_at <= 300;
        const isFreshOnMount = nowSec - alert.created_at <= 20;

        if (alreadyHydrated) {
          pushProactiveAlert(expectedGen, alert);
          enqueueToast(alert);
        } else {
          if (isRecent) {
            pushProactiveAlert(expectedGen, alert);
          }
          if (isFreshOnMount) {
            enqueueToast(alert);
          }
        }
      }
    },
    [actor, enqueueToast, setAssignedCount, setUnreadNoticesCount],
  );

  const pollPulse = useCallback(
    async (expectedGen: number, signal?: AbortSignal) => {
      if (expectedGen !== getAuthGeneration()) return;
      try {
        const pulse = await fetchWorkPulse(signal);
        if (signal?.aborted || expectedGen !== getAuthGeneration()) return;
        applyPulse(pulse, expectedGen);
      } catch (err) {
        if (isStaleAuthError(err)) return;
        // Non-fatal: silently keep UI stable when offline or route unavailable
      }
    },
    [applyPulse],
  );

  // Immediately clear visible toasts & SSE connection on auth reset
  useEffect(() => {
    return onAuthReset(() => {
      setToasts([]);
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      if (fallbackTimerRef.current !== null) {
        window.clearInterval(fallbackTimerRef.current);
        fallbackTimerRef.current = null;
      }
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    });
  }, []);

  useEffect(() => {
    if (status !== "authenticated" || !actor) {
      setToasts([]);
      return;
    }

    const expectedGen = authGeneration;
    const abortController = new AbortController();
    let disposed = false;

    const clearTimers = () => {
      if (fallbackTimerRef.current !== null) {
        window.clearInterval(fallbackTimerRef.current);
        fallbackTimerRef.current = null;
      }
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    const startFallbackPoll = () => {
      if (disposed || fallbackTimerRef.current !== null) return;
      fallbackTimerRef.current = window.setInterval(() => {
        if (disposed || expectedGen !== getAuthGeneration()) return;
        void pollPulse(expectedGen);
      }, FALLBACK_POLL_MS);
    };

    const stopFallbackPoll = () => {
      if (fallbackTimerRef.current !== null) {
        window.clearInterval(fallbackTimerRef.current);
        fallbackTimerRef.current = null;
      }
    };

    const handleIncomingEvent = (rawData: string, fallbackKind?: string) => {
      if (disposed || expectedGen !== getAuthGeneration()) return;
      try {
        const parsed = JSON.parse(rawData) as Record<string, unknown>;
        const alert = normalizeAlertPayload(
          fallbackKind && !parsed.kind
            ? { ...parsed, kind: fallbackKind }
            : parsed,
        );
        if (!alert) return;

        const seen = ensureSeenStore(expectedGen);
        if (seen.has(alert.id)) return;
        seen.add(alert.id);

        pushProactiveAlert(expectedGen, alert);
        enqueueToast(alert);
        void pollPulse(expectedGen, abortController.signal);
      } catch {
        // Ignore malformed or heartbeat payloads
      }
    };

    const connectSse = () => {
      if (disposed || expectedGen !== getAuthGeneration()) return;
      if (typeof EventSource === "undefined") {
        startFallbackPoll();
        return;
      }

      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }

      const es = new EventSource("/v1/workbench/events/stream", {
        withCredentials: true,
      });
      eventSourceRef.current = es;

      es.onopen = () => {
        if (disposed) return;
        stopFallbackPoll();
      };

      es.addEventListener("work_alert", (ev) => {
        handleIncomingEvent((ev as MessageEvent<string>).data, "work_alert");
      });

      es.addEventListener("security_alert", (ev) => {
        handleIncomingEvent(
          (ev as MessageEvent<string>).data,
          "security_alert",
        );
      });

      es.onmessage = (ev) => {
        if (typeof ev.data === "string" && ev.data.trim()) {
          handleIncomingEvent(ev.data);
        }
      };

      es.onerror = () => {
        if (disposed) return;
        es.close();
        if (eventSourceRef.current === es) {
          eventSourceRef.current = null;
        }
        startFallbackPoll();
        if (reconnectTimerRef.current === null) {
          reconnectTimerRef.current = window.setTimeout(() => {
            reconnectTimerRef.current = null;
            if (!disposed && expectedGen === getAuthGeneration()) {
              connectSse();
            }
          }, SSE_RETRY_MS);
        }
      };
    };

    void pollPulse(expectedGen, abortController.signal);
    connectSse();

    return () => {
      disposed = true;
      abortController.abort();
      clearTimers();
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [status, actor, authGeneration, pollPulse, enqueueToast]);

  if (status !== "authenticated" || !actor || toasts.length === 0) {
    return null;
  }

  const trimmedAgentName = agentProfile?.display_name?.trim();
  const agentDisplayName =
    trimmedAgentName && !DEFAULT_AGENT_NAMES.has(trimmedAgentName)
      ? trimmedAgentName
      : t("brand.defaultAgentName");

  return (
    <div
      aria-live="polite"
      data-testid="proactive-agent-toast-stack"
      className="pointer-events-none fixed top-[66px] right-4 z-[45] flex w-[min(368px,calc(100vw-24px))] flex-col gap-2.5"
    >
      {toasts.map(({ alert }) => {
        const isSecurity =
          alert.kind === "security_alert" ||
          alert.severity === "critical" ||
          alert.severity === "high";

        return (
          <div
            key={alert.id}
            role="status"
            data-testid={`proactive-toast-${alert.id}`}
            onMouseEnter={() => setToastPaused(alert.id, true)}
            onMouseLeave={() => setToastPaused(alert.id, false)}
            onFocus={() => setToastPaused(alert.id, true)}
            onBlur={() => setToastPaused(alert.id, false)}
            className={[
              "aios-row-in pointer-events-auto overflow-hidden rounded-card border bg-[var(--bg-surface)]/96 p-3.5 shadow-[var(--shadow-floating)] backdrop-blur-md transition-all duration-[150ms]",
              isSecurity
                ? "border-[var(--status-crimson-border)]"
                : "border-[var(--hairline-strong)]",
            ].join(" ")}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <span className="inline-flex h-6 w-7 shrink-0 items-center justify-center rounded-sm border border-[var(--hairline)] bg-[var(--bg-surface-tint)]">
                  <TheodicMark height={8} />
                </span>
                <span
                  className={[
                    "inline-flex items-center gap-1 rounded-xs border px-2 py-0.5 text-[10.5px] font-semibold tracking-[0.02em]",
                    isSecurity
                      ? "border-[var(--status-crimson-border)] bg-[var(--status-crimson-wash)] text-[var(--status-crimson)]"
                      : "border-[var(--accent-border)] bg-[var(--accent-wash)] text-[var(--accent-ink)]",
                  ].join(" ")}
                >
                  {isSecurity ? (
                    <ShieldAlert className="h-3 w-3 shrink-0" strokeWidth={2} />
                  ) : (
                    <Bell className="h-3 w-3 shrink-0" strokeWidth={2} />
                  )}
                  <span className="truncate max-w-[140px]">
                    {isSecurity
                      ? tx({
                          "zh-CN": "安全实时告警",
                          "zh-HK": "安全即時告警",
                          en: "Security Alert",
                        })
                      : agentDisplayName}
                  </span>
                </span>
              </div>

              <div className="flex shrink-0 items-center gap-1.5">
                <span className="font-mono-code text-[10.5px] text-[var(--ink-muted)] tabular-nums">
                  {formatShortTime(alert.created_at) ||
                    tx({ "zh-CN": "刚刚", "zh-HK": "剛剛", en: "Just now" })}
                </span>
                <button
                  type="button"
                  onClick={() => dismissToast(alert.id)}
                  aria-label={t("common.close")}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-[var(--ink-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--ink-primary)] transition-colors cursor-pointer"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            <div className="mt-2.5 text-[13px] font-semibold tracking-[-0.01em] text-[var(--ink-primary)] leading-snug">
              {alert.title}
            </div>

            {alert.subtitle && (
              <p className="mt-1 line-clamp-2 text-[12px] text-[var(--ink-secondary)] leading-relaxed">
                {alert.subtitle}
              </p>
            )}

            <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-[var(--hairline-subtle)] pt-2">
              <span className="truncate font-mono-code text-[10.5px] text-[var(--ink-muted)] tabular-nums">
                {alert.reference || ""}
              </span>
              <Link
                href={alert.href || "/inbox/assistant"}
                onClick={() => dismissToast(alert.id)}
                className="inline-flex h-7 items-center gap-1 rounded-sm bg-[var(--accent-solid)] px-2.5 text-[11.5px] font-medium text-[var(--accent-fg)] hover:bg-[var(--accent-solid-hover)] transition-colors shrink-0"
              >
                <span>
                  {tx({
                    "zh-CN": "查看处理",
                    "zh-HK": "檢視處理",
                    en: "View & Handle",
                  })}
                </span>
                <ArrowUpRight className="h-3 w-3" strokeWidth={2} />
              </Link>
            </div>
          </div>
        );
      })}
    </div>
  );
}
