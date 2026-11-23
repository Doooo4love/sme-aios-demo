"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, OctagonX, ShieldAlert, Terminal } from "lucide-react";
import { useLocale } from "@/lib/i18n";
import { Button, Modal } from "@/components/ui";

const EMERGENCY_STOP_EVENT = "aios://emergency-stop";
const ACTION_CONFIRMATION_EVENT = "aios://action-confirmation";
const STOP_BANNER_AUTO_HIDE_MS = 6000;

export interface EmergencyStopPayload {
  stopped: boolean;
  previous_active_run?: boolean;
  active_run: boolean;
  kill_switch_latch: boolean;
  sequence: number;
  reason: string;
  source: string;
  timestamp_ms: number;
}

export interface DesktopActionConfirmation {
  confirmation_id: string;
  action: string;
  tier: string;
  app_id: string;
  window_title: string;
  summary: string;
  created_at_epoch_s: number;
  expires_at_epoch_s: number;
  approved: boolean;
}

interface TauriEventMessage<T> {
  event?: string;
  id?: number;
  payload: T;
}

interface TauriInternals {
  invoke?: <T = unknown>(
    cmd: string,
    args?: Record<string, unknown>,
  ) => Promise<T>;
  transformCallback?: (
    callback: (response: unknown) => void,
    once?: boolean,
  ) => number;
  unregisterCallback?: (id: number) => void;
  metadata?: {
    currentWindow?: { label?: string };
  };
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: TauriInternals;
  }
}

function getTauriInternals(): TauriInternals | null {
  if (typeof window === "undefined") return null;
  const internals = window.__TAURI_INTERNALS__;
  if (!internals || typeof internals !== "object") return null;
  return internals;
}

function isEmergencyStopPayload(value: unknown): value is EmergencyStopPayload {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.stopped === "boolean";
}

function isActionConfirmationPayload(
  value: unknown,
): value is DesktopActionConfirmation {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.confirmation_id === "string" &&
    typeof record.action === "string" &&
    typeof record.summary === "string"
  );
}

function unwrapEventPayload<T>(
  raw: unknown,
  guard: (candidate: unknown) => candidate is T,
): T | null {
  if (guard(raw)) return raw;
  if (raw && typeof raw === "object" && "payload" in raw) {
    const inner = (raw as TauriEventMessage<unknown>).payload;
    if (guard(inner)) return inner;
  }
  return null;
}

async function subscribeTauriEvent<T>(
  internals: TauriInternals,
  eventName: string,
  guard: (candidate: unknown) => candidate is T,
  onPayload: (payload: T) => void,
  isDisposed: () => boolean,
): Promise<() => void> {
  if (
    typeof internals.invoke !== "function" ||
    typeof internals.transformCallback !== "function"
  ) {
    return () => {};
  }

  let callbackId: number | null = null;
  let eventId: number | null = null;

  try {
    callbackId = internals.transformCallback((rawMessage) => {
      if (isDisposed()) return;
      const parsed = unwrapEventPayload(rawMessage, guard);
      if (parsed) {
        onPayload(parsed);
      }
    });

    eventId = await internals.invoke<number>("plugin:event|listen", {
      event: eventName,
      target: { kind: "Any" },
      handler: callbackId,
    });

    if (isDisposed()) {
      void internals
        .invoke("plugin:event|unlisten", { event: eventName, eventId })
        .catch(() => undefined);
      if (callbackId !== null) {
        internals.unregisterCallback?.(callbackId);
      }
      return () => {};
    }

    return () => {
      if (eventId !== null) {
        void internals
          .invoke?.("plugin:event|unlisten", { event: eventName, eventId })
          .catch(() => undefined);
      }
      if (callbackId !== null) {
        internals.unregisterCallback?.(callbackId);
      }
    };
  } catch {
    if (callbackId !== null) {
      internals.unregisterCallback?.(callbackId);
    }
    return () => {};
  }
}

export function DesktopHarnessOverlay() {
  const { tx } = useLocale();

  const [isTauriDesktop, setIsTauriDesktop] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [lastStop, setLastStop] = useState<EmergencyStopPayload | null>(null);
  const [stopBannerVisible, setStopBannerVisible] = useState(false);

  const [confirmationQueue, setConfirmationQueue] = useState<
    DesktopActionConfirmation[]
  >([]);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [nowEpochSec, setNowEpochSec] = useState(() =>
    Math.floor(Date.now() / 1000),
  );

  const bannerTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  const clearBannerTimer = useCallback(() => {
    if (bannerTimerRef.current !== null) {
      window.clearTimeout(bannerTimerRef.current);
      bannerTimerRef.current = null;
    }
  }, []);

  const handleEmergencyStopEvent = useCallback(
    (payload: EmergencyStopPayload) => {
      if (!mountedRef.current) return;
      setLastStop(payload);
      setStopBannerVisible(true);
      setConfirmationQueue([]);
      setConfirmError(null);
      clearBannerTimer();
      bannerTimerRef.current = window.setTimeout(() => {
        if (mountedRef.current) {
          setStopBannerVisible(false);
        }
        bannerTimerRef.current = null;
      }, STOP_BANNER_AUTO_HIDE_MS);
    },
    [clearBannerTimer],
  );

  const handleActionConfirmationEvent = useCallback(
    (payload: DesktopActionConfirmation) => {
      if (!mountedRef.current) return;
      setConfirmError(null);
      setNowEpochSec(Math.floor(Date.now() / 1000));
      setConfirmationQueue((prev) => {
        if (
          prev.some((item) => item.confirmation_id === payload.confirmation_id)
        ) {
          return prev;
        }
        return [...prev, payload];
      });
    },
    [],
  );

  const triggerEmergencyStop = useCallback(
    async (source: "pill_button" | "webview_hotkey") => {
      const internals = getTauriInternals();
      if (!internals) return;
      setStopping(true);
      try {
        if (typeof internals.invoke === "function") {
          const payload = await internals.invoke<EmergencyStopPayload>(
            "trigger_emergency_stop",
            { reason: `ui:${source}` },
          );
          if (mountedRef.current && isEmergencyStopPayload(payload)) {
            handleEmergencyStopEvent(payload);
            return;
          }
        }
        if (mountedRef.current) {
          handleEmergencyStopEvent({
            stopped: true,
            active_run: false,
            kill_switch_latch: false,
            sequence: (lastStop?.sequence ?? 0) + 1,
            reason: `ui:${source}`,
            source,
            timestamp_ms: Date.now(),
          });
        }
      } catch {
        if (mountedRef.current) {
          handleEmergencyStopEvent({
            stopped: true,
            active_run: false,
            kill_switch_latch: false,
            sequence: (lastStop?.sequence ?? 0) + 1,
            reason: `ui:${source}`,
            source,
            timestamp_ms: Date.now(),
          });
        }
      } finally {
        if (mountedRef.current) {
          setStopping(false);
        }
      }
    },
    [handleEmergencyStopEvent, lastStop?.sequence],
  );

  useEffect(() => {
    mountedRef.current = true;
    const internals = getTauriInternals();
    if (!internals) {
      setIsTauriDesktop(false);
      return () => {
        mountedRef.current = false;
        clearBannerTimer();
      };
    }

    setIsTauriDesktop(true);
    let disposed = false;
    const unlisteners: Array<() => void> = [];

    void subscribeTauriEvent<EmergencyStopPayload>(
      internals,
      EMERGENCY_STOP_EVENT,
      isEmergencyStopPayload,
      handleEmergencyStopEvent,
      () => disposed,
    ).then((unlisten) => {
      if (disposed) {
        unlisten();
      } else {
        unlisteners.push(unlisten);
      }
    });

    void subscribeTauriEvent<DesktopActionConfirmation>(
      internals,
      ACTION_CONFIRMATION_EVENT,
      isActionConfirmationPayload,
      handleActionConfirmationEvent,
      () => disposed,
    ).then((unlisten) => {
      if (disposed) {
        unlisten();
      } else {
        unlisteners.push(unlisten);
      }
    });

    const onDomEmergencyStop = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      const parsed = unwrapEventPayload(detail, isEmergencyStopPayload);
      if (parsed) {
        handleEmergencyStopEvent(parsed);
      }
    };

    const onDomConfirmation = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      const parsed = unwrapEventPayload(detail, isActionConfirmationPayload);
      if (parsed) {
        handleActionConfirmationEvent(parsed);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Escape") {
        event.preventDefault();
        void triggerEmergencyStop("webview_hotkey");
      }
    };

    window.addEventListener(EMERGENCY_STOP_EVENT, onDomEmergencyStop);
    window.addEventListener(ACTION_CONFIRMATION_EVENT, onDomConfirmation);
    window.addEventListener("keydown", onKeyDown);

    return () => {
      disposed = true;
      mountedRef.current = false;
      clearBannerTimer();
      window.removeEventListener(EMERGENCY_STOP_EVENT, onDomEmergencyStop);
      window.removeEventListener(ACTION_CONFIRMATION_EVENT, onDomConfirmation);
      window.removeEventListener("keydown", onKeyDown);
      for (const unlisten of unlisteners) {
        try {
          unlisten();
        } catch {
          // ignore cleanup failure on teardown
        }
      }
    };
  }, [
    clearBannerTimer,
    handleActionConfirmationEvent,
    handleEmergencyStopEvent,
    triggerEmergencyStop,
  ]);

  const activeConfirmation = confirmationQueue[0] ?? null;

  // Countdown ticker active only while a Red-action modal is visible
  useEffect(() => {
    if (!isTauriDesktop || !activeConfirmation) return;
    const intervalId = window.setInterval(() => {
      setNowEpochSec(Math.floor(Date.now() / 1000));
    }, 1000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [isTauriDesktop, activeConfirmation]);

  const handleConfirmationDecision = async (approved: boolean) => {
    if (!activeConfirmation || confirmBusy) return;
    const internals = getTauriInternals();
    setConfirmBusy(true);
    setConfirmError(null);
    try {
      if (typeof internals?.invoke === "function") {
        await internals.invoke("request_action_confirmation", {
          request: {
            action: activeConfirmation.action,
            tier: activeConfirmation.tier,
            app_id: activeConfirmation.app_id,
            window_title: activeConfirmation.window_title,
            summary: activeConfirmation.summary,
            confirmation_id: activeConfirmation.confirmation_id,
            approved,
          },
        });
      }
      if (mountedRef.current) {
        setConfirmationQueue((prev) =>
          prev.filter(
            (item) => item.confirmation_id !== activeConfirmation.confirmation_id,
          ),
        );
      }
    } catch (err) {
      if (mountedRef.current) {
        setConfirmError(
          typeof err === "string"
            ? err
            : err instanceof Error
              ? err.message
              : tx({
                  "zh-CN": "提交桌面操作确认失败，请重试或按急停中止。",
                  "zh-HK": "提交桌面操作確認失敗，請重試或按急停中止。",
                  en: "Failed to submit desktop action decision.",
                }),
        );
      }
    } finally {
      if (mountedRef.current) {
        setConfirmBusy(false);
      }
    }
  };

  // Strictly return null outside Tauri 2 desktop runtime so standard web UI stays 100% clean
  if (!isTauriDesktop) {
    return null;
  }

  const remainingSec = activeConfirmation
    ? Math.max(0, activeConfirmation.expires_at_epoch_s - nowEpochSec)
    : 0;

  return (
    <>
      <div className="pointer-events-none fixed bottom-[72px] right-4 z-40 flex flex-col items-end gap-2 lg:bottom-4">
        {stopBannerVisible && lastStop && (
          <div
            role="status"
            data-testid="desktop-emergency-stop-banner"
            className="pointer-events-auto max-w-[300px] rounded-card border border-[var(--status-crimson-border)] bg-[var(--bg-surface)] px-3.5 py-2.5 shadow-[var(--shadow-floating)]"
          >
            <div className="flex items-center gap-1.5 text-[12px] font-semibold text-[var(--status-crimson)]">
              <OctagonX className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
              <span>
                {tx({
                  "zh-CN": "桌面执行已急停中断",
                  "zh-HK": "桌面執行已急停中斷",
                  en: "Desktop Execution Halted",
                })}
              </span>
            </div>
            <p className="mt-1 text-[11.5px] leading-snug text-[var(--ink-secondary)]">
              {tx({
                "zh-CN": "所有本地窗口操作与待确认任务已清除。",
                "zh-HK": "所有本地視窗操作與待確認任務已清除。",
                en: "Active local automation and pending confirmations have been cleared.",
              })}
            </p>
            <div className="mt-1 font-mono-code text-[10.5px] text-[var(--ink-muted)] tabular-nums">
              #{lastStop.sequence} · {lastStop.source}
            </div>
          </div>
        )}

        <button
          type="button"
          data-testid="desktop-emergency-stop-pill"
          disabled={stopping}
          onClick={() => void triggerEmergencyStop("pill_button")}
          aria-label={tx({
            "zh-CN": "触发桌面助手急停（Cmd 或 Ctrl + Esc）",
            "zh-HK": "觸發桌面助手急停（Cmd 或 Ctrl + Esc）",
            en: "Trigger desktop emergency stop (Cmd/Ctrl+Esc)",
          })}
          className="pointer-events-auto inline-flex h-8 items-center gap-2 rounded-full border border-[var(--hairline-strong)] bg-[var(--bg-surface)]/95 px-3 text-[11.5px] font-medium text-[var(--ink-primary)] shadow-[var(--shadow-floating)] backdrop-blur-md transition-[background-color,border-color,transform] duration-[150ms] hover:border-[var(--status-crimson-border)] hover:bg-[var(--status-crimson-wash)] hover:text-[var(--status-crimson)] active:scale-[0.98] disabled:opacity-60 cursor-pointer"
        >
          <span
            aria-hidden="true"
            className="h-2 w-2 rounded-full bg-[var(--status-crimson)]"
          />
          <kbd className="font-mono-code text-[10.5px] text-[var(--ink-muted)]">
            Cmd/Ctrl+Esc
          </kbd>
          <span className="font-semibold">
            {tx({
              "zh-CN": "急停",
              "zh-HK": "急停",
              en: "Stop",
            })}
          </span>
        </button>
      </div>

      {/* Red-Tier Desktop Action Human Confirmation Modal */}
      <Modal
        open={activeConfirmation !== null}
        onOpenChange={(open) => {
          if (!open && !confirmBusy) {
            void handleConfirmationDecision(false);
          }
        }}
        title={tx({
          "zh-CN": "高风险本地操作确认（RED 级）",
          "zh-HK": "高風險本地操作確認（RED 級）",
          en: "High-Risk Desktop Action Confirmation (RED)",
        })}
        subtitle={
          activeConfirmation
            ? `${activeConfirmation.app_id} · ${activeConfirmation.window_title}`
            : undefined
        }
        size="sm"
        footer={
          <>
            <Button
              variant="secondary"
              disabled={confirmBusy}
              data-testid="desktop-confirm-reject-btn"
              onClick={() => void handleConfirmationDecision(false)}
            >
              {tx({
                "zh-CN": "拒绝并中止",
                "zh-HK": "拒絕並中止",
                en: "Reject",
              })}
            </Button>
            <Button
              variant="danger-solid"
              loading={confirmBusy}
              disabled={remainingSec <= 0}
              data-testid="desktop-confirm-approve-btn"
              onClick={() => void handleConfirmationDecision(true)}
            >
              <ShieldAlert className="h-3.5 w-3.5" />
              <span>
                {tx({
                  "zh-CN": "人工批准执行",
                  "zh-HK": "人工批准執行",
                  en: "Approve Action",
                })}
              </span>
            </Button>
          </>
        }
      >
        {activeConfirmation && (
          <div
            data-testid="desktop-red-action-modal"
            className="space-y-3.5 text-[12.5px]"
          >
            <div className="flex items-center justify-between gap-2 rounded-tile border border-[var(--status-crimson-border)] bg-[var(--status-crimson-wash)] px-3 py-2">
              <span className="inline-flex items-center gap-1.5 font-semibold text-[var(--status-crimson)]">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                <span>
                  {tx({
                    "zh-CN": "需要人类明确批准",
                    "zh-HK": "需要人類明確批准",
                    en: "Explicit Human Approval Required",
                  })}
                </span>
              </span>
              <span className="font-mono-code text-[11px] font-semibold text-[var(--status-crimson)] tabular-nums">
                {remainingSec}s
              </span>
            </div>

            <div className="rounded-tile border border-[var(--hairline)] bg-[var(--bg-surface-tint)] p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="aios-micro-label">
                  {tx({
                    "zh-CN": "请求动作",
                    "zh-HK": "請求動作",
                    en: "Requested Action",
                  })}
                </span>
                <span className="inline-flex items-center gap-1 rounded-xs border border-[var(--hairline)] bg-[var(--bg-surface)] px-2 py-0.5 font-mono-code text-[11px] font-semibold text-[var(--ink-primary)]">
                  <Terminal className="h-3 w-3 text-[var(--ink-muted)]" />
                  {activeConfirmation.action}
                </span>
              </div>

              <div className="flex items-center justify-between gap-2">
                <span className="aios-micro-label">
                  {tx({
                    "zh-CN": "目标窗口",
                    "zh-HK": "目標視窗",
                    en: "Target Window",
                  })}
                </span>
                <span className="truncate max-w-[240px] font-mono-code text-[11px] text-[var(--ink-secondary)]">
                  {activeConfirmation.app_id} · {activeConfirmation.window_title}
                </span>
              </div>

              <div className="border-t border-[var(--hairline-subtle)] pt-2 text-[12.5px] leading-relaxed text-[var(--ink-primary)]">
                {activeConfirmation.summary}
              </div>
            </div>

            <p className="text-[11.5px] leading-relaxed text-[var(--ink-muted)]">
              {tx({
                "zh-CN":
                  "此操作涉及外部提交、删除或高敏写入。核对目标应用与操作摘要后点击批准，或随时按 Cmd/Ctrl+Esc 立即急停。",
                "zh-HK":
                  "此操作涉及外部提交、刪除或高敏寫入。核對目標應用與操作摘要後點擊批准，或隨時按 Cmd/Ctrl+Esc 立即急停。",
                en: "This RED-tier action affects external submissions, deletion, or sensitive writes. Verify the target window before approving, or press Cmd/Ctrl+Esc at any time.",
              })}
            </p>

            {confirmError && (
              <div
                role="alert"
                className="rounded-sm border border-[var(--status-crimson-border)] bg-[var(--status-crimson-wash)] px-3 py-2 text-[12px] text-[var(--status-crimson)]"
              >
                {confirmError}
              </div>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}
