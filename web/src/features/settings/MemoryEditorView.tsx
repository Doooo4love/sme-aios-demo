"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  BookOpen,
  Bot,
  CheckCircle2,
  Columns2,
  Eraser,
  Eye,
  FilePlus2,
  PencilLine,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldAlert,
  Sparkles,
  Trash2,
  User,
} from "lucide-react";
import { isStaleAuthError, type ApiError } from "@/lib/api-client";
import { useLocale } from "@/lib/i18n";
import { useSession } from "@/lib/session-context";
import { AccessNoticeCard } from "@/components/ui/AccessNoticeCard";
import { Button } from "@/components/ui/Button";
import { MarkdownMessage } from "@/components/ui/MarkdownMessage";
import {
  clearUserMemory,
  fetchUserMemory,
  forgetUserMemory,
  isMemoryApiError,
  revertUserMemory,
  tidyUserMemory,
  updateUserMemory,
} from "@/features/settings/api";
import type { UserMemoryState } from "@/lib/types";

type EditorMode = "edit" | "split" | "preview";

interface PolicyFeedbackState {
  code: string;
  title: string;
  reason: string;
}

const DEFAULT_MAX_TOKENS = 1200;
const DEFAULT_MAX_CHARS = 6000;

const STRUCTURED_MEMORY_TEMPLATE = `# MEMORY.md

## Identity & Role
- Role & primary responsibilities:
- Warehouse / scope focus:

## Communication Preferences
- Preferred language & tone:
- Summary format & detail level:

## Working Context
- Recurring counterparties / routes / SOPs:

## Ongoing Commitments & Habits
- Standing workflows & reminders:
`;

function estimateMemoryTokens(text: string): number {
  if (!text) return 0;
  const charLen = [...text].length;
  const byteLen = new TextEncoder().encode(text).length;
  if (byteLen === charLen) {
    return Math.max(1, Math.floor((charLen + 3) / 4));
  }
  const nonAsciiApprox = Math.max(0, Math.floor((byteLen - charLen) / 2));
  const asciiApprox = Math.max(0, charLen - nonAsciiApprox);
  return Math.max(1, Math.floor((asciiApprox + 3) / 4) + nonAsciiApprox);
}

export function MemoryEditorView() {
  const { status, authGeneration, handleAccessChanged } = useSession();
  const { t, tx, formatDateTime } = useLocale();

  const [record, setRecord] = useState<UserMemoryState | null>(null);
  const [draftContent, setDraftContent] = useState<string>("");
  const [viewMode, setViewMode] = useState<EditorMode>("split");
  const [loading, setLoading] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [reverting, setReverting] = useState<boolean>(false);
  const [tidyingMode, setTidyingMode] = useState<"none" | "deterministic" | "llm">("none");
  const [forgetting, setForgetting] = useState<boolean>(false);
  const [clearing, setClearing] = useState<boolean>(false);
  const [confirmClearOpen, setConfirmClearOpen] = useState<boolean>(false);
  const [clearPermanent, setClearPermanent] = useState<boolean>(false);
  const [forgetQuery, setForgetQuery] = useState<string>("");
  const [forgetPermanent, setForgetPermanent] = useState<boolean>(false);

  const [successNotice, setSuccessNotice] = useState<string | null>(null);
  const [conflictNotice, setConflictNotice] = useState<string | null>(null);
  const [policyFeedback, setPolicyFeedback] =
    useState<PolicyFeedbackState | null>(null);
  const [apiError, setApiError] = useState<ApiError | null>(null);

  const editorRef = useRef<HTMLTextAreaElement | null>(null);

  const clearBanners = useCallback(() => {
    setSuccessNotice(null);
    setConflictNotice(null);
    setPolicyFeedback(null);
    setApiError(null);
  }, []);

  const applyServerState = useCallback((next: UserMemoryState) => {
    setRecord(next);
    setDraftContent(next.content);
  }, []);

  const loadMemory = useCallback(
    async (signal?: AbortSignal): Promise<UserMemoryState | null> => {
      if (status !== "authenticated") return null;
      setLoading(true);
      setApiError(null);
      try {
        const fresh = await fetchUserMemory(signal);
        applyServerState(fresh);
        setConflictNotice(null);
        setConfirmClearOpen(false);
        setClearPermanent(false);
        return fresh;
      } catch (err) {
        if (isStaleAuthError(err)) return null;
        if (err instanceof DOMException && err.name === "AbortError") {
          return null;
        }
        if (isMemoryApiError(err)) {
          if (err.code === "ACCESS_CHANGED") {
            void handleAccessChanged();
          }
          setApiError(err);
        }
        return null;
      } finally {
        setLoading(false);
      }
    },
    [status, applyServerState, handleAccessChanged],
  );

  useEffect(() => {
    const controller = new AbortController();
    clearBanners();
    void loadMemory(controller.signal);
    return () => controller.abort();
  }, [authGeneration, loadMemory, clearBanners]);

  const maxTokens = record?.max_tokens ?? DEFAULT_MAX_TOKENS;
  const maxChars = record?.max_chars ?? DEFAULT_MAX_CHARS;
  const liveTokens = useMemo(
    () => estimateMemoryTokens(draftContent),
    [draftContent],
  );
  const liveChars = draftContent.length;
  const tokenRatioPct = Math.min(100, (liveTokens / Math.max(1, maxTokens)) * 100);
  const charRatioPct = Math.min(100, (liveChars / Math.max(1, maxChars)) * 100);
  const usagePct = Math.max(tokenRatioPct, charRatioPct);

  const isOverTokenLimit = liveTokens > maxTokens;
  const isOverCharLimit = liveChars > maxChars;
  const isOverLimit = isOverTokenLimit || isOverCharLimit;
  const isDirty = record !== null && draftContent !== record.content;
  const isBusy =
    loading ||
    saving ||
    reverting ||
    tidyingMode !== "none" ||
    forgetting ||
    clearing;

  const handleServerError = useCallback(
    (err: unknown) => {
      if (isStaleAuthError(err)) return;
      if (!isMemoryApiError(err)) {
        setPolicyFeedback({
          code: "REQUEST_FAILED",
          title: tx({
            "zh-CN": "操作未能完成",
            "zh-HK": "操作未能完成",
            en: "Request failed",
          }),
          reason: tx({
            "zh-CN": "请求处理失败，请稍后重试。",
            "zh-HK": "請求處理失敗，請稍後重試。",
            en: "Unable to complete the memory request. Please try again.",
          }),
        });
        return;
      }

      if (err.code === "ACCESS_CHANGED") {
        void handleAccessChanged();
      }

      if (err.status === 409) {
        setConflictNotice(
          tx({
            "zh-CN":
              "MEMORY.md 已在其他会话或对话轮次中更新，当前草稿与最新版本存在版本冲突。请先重新加载最新版本核对后再保存。",
            "zh-HK":
              "MEMORY.md 已於其他工作階段或對話輪次更新，目前草稿與最新版本存在版本衝突。請先重新載入最新版本核對後再儲存。",
            en: "MEMORY.md changed in another session or chat turn (409 version conflict). Reload the latest version before saving.",
          }),
        );
        return;
      }

      if (err.status === 422) {
        const isBudget = err.code === "MEMORY_TOKEN_LIMIT_EXCEEDED";
        const isPolicy = err.code === "MEMORY_POLICY_VIOLATION";
        const title = isBudget
          ? tx({
              "zh-CN": "超出长期记忆容量上限",
              "zh-HK": "超出長期記憶容量上限",
              en: "Memory budget limit exceeded",
            })
          : isPolicy
            ? tx({
                "zh-CN": "安全护栏拦截了此次写入",
                "zh-HK": "安全護欄攔截了此次寫入",
                en: "Memory policy guardrail blocked save",
              })
            : tx({
                "zh-CN": "记忆内容未通过校验",
                "zh-HK": "記憶內容未通過校驗",
                en: "Memory validation failed",
              });

        const fallbackReason = isBudget
          ? tx(
              {
                "zh-CN":
                  "MEMORY.md 严格限制在 {maxTok} tokens 与 {maxChar} 字符以内，请精简后再保存。",
                "zh-HK":
                  "MEMORY.md 嚴格限制於 {maxTok} tokens 與 {maxChar} 字元以內，請精簡後再儲存。",
                en: "MEMORY.md is capped at {maxTok} tokens and {maxChar} characters. Trim content before saving.",
              },
              { maxTok: maxTokens, maxChar: maxChars },
            )
          : tx({
              "zh-CN":
                "包含受保护的系统指令（SOUL.md）、权限提权、敏感凭证或提示词注入片段的内容禁止写入 MEMORY.md。",
              "zh-HK":
                "包含受保護的系統指令（SOUL.md）、權限提權、敏感憑證或提示詞注入片段的內容禁止寫入 MEMORY.md。",
              en: "Sealed SOUL.md directives, RBAC escalation, secrets, and prompt-injection delimiters cannot enter MEMORY.md.",
            });

        setPolicyFeedback({
          code: err.code || "HTTP_422",
          title,
          reason: err.reason || err.detail || err.message || fallbackReason,
        });
        return;
      }

      setApiError(err);
    },
    [tx, handleAccessChanged, maxTokens, maxChars],
  );

  const handleSave = useCallback(async () => {
    if (!record || !isDirty || isOverLimit || isBusy) return;
    setSaving(true);
    clearBanners();
    try {
      const updated = await updateUserMemory({
        version: record.version,
        content: draftContent,
      });
      applyServerState(updated);
      setSuccessNotice(
        tx(
          {
            "zh-CN": "已保存 MEMORY.md（v{ver} · {tok} tokens），新对话将自动生效。",
            "zh-HK": "已儲存 MEMORY.md（v{ver} · {tok} tokens），新對話將自動生效。",
            en: "Saved MEMORY.md (v{ver} · {tok} tokens). Active for upcoming conversations.",
          },
          { ver: updated.version, tok: updated.token_count },
        ),
      );
    } catch (err) {
      handleServerError(err);
    } finally {
      setSaving(false);
    }
  }, [
    record,
    isDirty,
    isOverLimit,
    isBusy,
    clearBanners,
    draftContent,
    applyServerState,
    tx,
    handleServerError,
  ]);

  const handleRevert = useCallback(async () => {
    if (!record || !record.has_previous || isBusy) return;
    setReverting(true);
    clearBanners();
    setConfirmClearOpen(false);
    try {
      const updated = await revertUserMemory(record.version);
      applyServerState(updated);
      setSuccessNotice(
        tx(
          {
            "zh-CN": "已撤销并恢复至上一版本快照（当前 v{ver}）。",
            "zh-HK": "已撤銷並恢復至上一版本快照（目前 v{ver}）。",
            en: "Restored previous MEMORY.md snapshot (now v{ver}).",
          },
          { ver: updated.version },
        ),
      );
    } catch (err) {
      handleServerError(err);
    } finally {
      setReverting(false);
    }
  }, [record, isBusy, clearBanners, applyServerState, tx, handleServerError]);

  const handleTidy = useCallback(
    async (useLlm: boolean) => {
      if (!record || isBusy) return;
      setTidyingMode(useLlm ? "llm" : "deterministic");
      clearBanners();
      setConfirmClearOpen(false);
      try {
        const res = await tidyUserMemory(useLlm);
        applyServerState(res.memory);
        setSuccessNotice(
          res.used_llm
            ? tx(
                {
                  "zh-CN":
                    "已完成 AI 整理合并（T2）：合并 {merged} 条待整理事实，移除 {dedup} 条重复项。",
                  "zh-HK":
                    "已完成 AI 整理合併（T2）：合併 {merged} 條待整理事實，移除 {dedup} 條重複項。",
                  en: "AI consolidation (T2) complete: merged {merged} staged item(s), removed {dedup} duplicate(s).",
                },
                {
                  merged: res.merged_count,
                  dedup: res.removed_duplicates,
                },
              )
            : tx(
                {
                  "zh-CN":
                    "已完成零 Token 自动整理：合并 {merged} 条待整理事实，去重 {dedup} 条。",
                  "zh-HK":
                    "已完成零 Token 自動整理：合併 {merged} 條待整理事實，去重 {dedup} 條。",
                  en: "0-token tidy complete: merged {merged} staged item(s), removed {dedup} duplicate(s).",
                },
                {
                  merged: res.merged_count,
                  dedup: res.removed_duplicates,
                },
              ),
        );
      } catch (err) {
        handleServerError(err);
      } finally {
        setTidyingMode("none");
      }
    },
    [record, isBusy, clearBanners, applyServerState, tx, handleServerError],
  );

  const handleForget = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!record || isBusy) return;
      const trimmed = forgetQuery.trim();
      if (!trimmed) {
        setPolicyFeedback({
          code: "QUERY_REQUIRED",
          title: tx({
            "zh-CN": "请输入需要遗忘的关键词",
            "zh-HK": "請輸入需要遺忘的關鍵詞",
            en: "Enter a keyword or phrase to forget",
          }),
          reason: tx({
            "zh-CN": "请输入要从 MEMORY.md 与待整理队列中移除的关键词或事实片段。",
            "zh-HK": "請輸入要從 MEMORY.md 與待整理佇列中移除的關鍵詞或事實片段。",
            en: "Specify a term or line snippet to purge from MEMORY.md and pending cues.",
          }),
        });
        return;
      }

      setForgetting(true);
      clearBanners();
      setConfirmClearOpen(false);
      setClearPermanent(false);
      try {
        const res = await forgetUserMemory(trimmed, forgetPermanent);
        applyServerState(res.memory);
        setForgetQuery("");
        setForgetPermanent(false);
        setSuccessNotice(
          res.removed_lines > 0
            ? forgetPermanent
              ? tx(
                  {
                    "zh-CN": "已永久擦除 {count} 条匹配的记忆记录（不可撤销）。",
                    "zh-HK": "已永久抹除 {count} 條符合的記憶紀錄（不可撤銷）。",
                    en: "Permanently erased {count} matching memory entry/entries (no Undo).",
                  },
                  { count: res.removed_lines },
                )
              : tx(
                  {
                    "zh-CN": "已遗忘并移除 {count} 条匹配的记忆记录。",
                    "zh-HK": "已遺忘並移除 {count} 條符合的記憶紀錄。",
                    en: "Forgot and removed {count} matching memory entry/entries.",
                  },
                  { count: res.removed_lines },
                )
            : tx({
                "zh-CN": "未找到匹配的记忆条目，MEMORY.md 保持不变。",
                "zh-HK": "未找到符合的記憶條目，MEMORY.md 保持不變。",
                en: "No matching lines or staged cues found; MEMORY.md unchanged.",
              }),
        );
      } catch (err) {
        handleServerError(err);
      } finally {
        setForgetting(false);
      }
    },
    [
      record,
      isBusy,
      forgetQuery,
      forgetPermanent,
      clearBanners,
      applyServerState,
      tx,
      handleServerError,
    ],
  );

  const handleConfirmClear = useCallback(async () => {
    if (!record || isBusy) return;
    setClearing(true);
    clearBanners();
    try {
      const updated = await clearUserMemory(record.version, clearPermanent);
      applyServerState(updated);
      setConfirmClearOpen(false);
      setClearPermanent(false);
      setSuccessNotice(
        clearPermanent
          ? tx(
              {
                "zh-CN":
                  "已永久清除 MEMORY.md（v{ver}），历史快照与待整理队列已彻底移除（不可撤回）。",
                "zh-HK":
                  "已永久清除 MEMORY.md（v{ver}），歷史快照與待整理佇列已徹底移除（不可撤回）。",
                en: "Permanently cleared MEMORY.md (v{ver}); previous snapshot and pending cues were erased.",
              },
              { ver: updated.version },
            )
          : tx(
              {
                "zh-CN": "已清空 MEMORY.md（v{ver}），您仍可通过“撤销上一版”恢复。",
                "zh-HK": "已清空 MEMORY.md（v{ver}），您仍可透過「撤銷上一版」恢復。",
                en: "Cleared MEMORY.md (v{ver}). You can still restore the previous snapshot via Undo.",
              },
              { ver: updated.version },
            ),
      );
    } catch (err) {
      handleServerError(err);
    } finally {
      setClearing(false);
    }
  }, [
    record,
    isBusy,
    clearPermanent,
    clearBanners,
    applyServerState,
    tx,
    handleServerError,
  ]);

  const handleInsertTemplate = useCallback(() => {
    setDraftContent(STRUCTURED_MEMORY_TEMPLATE);
    if (viewMode === "preview") {
      setViewMode("split");
    }
    setPolicyFeedback(null);
    window.requestAnimationFrame(() => {
      editorRef.current?.focus();
    });
  }, [viewMode]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (record && isDirty && !isOverLimit && !isBusy) {
          void handleSave();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [record, isDirty, isOverLimit, isBusy, handleSave]);

  const progressBarClass =
    usagePct >= 100
      ? "bg-[var(--status-crimson)]"
      : usagePct >= 80
        ? "bg-[var(--status-amber)]"
        : "bg-[var(--ink-muted)]";

  const canClear = Boolean(
    record &&
      (record.content.trim().length > 0 || record.pending_staged_count > 0),
  );

  return (
    <div
      data-testid="memory-settings-page"
      className="min-h-full bg-[var(--bg-app)] px-4 py-8 sm:px-6"
    >
      <div className="mx-auto max-w-[960px] space-y-5">
        {/* Clean Pill Sub-Navigation Switcher */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex flex-wrap items-center gap-0.5 rounded-2xl sm:rounded-full bg-[var(--bg-inset)] p-1 ring-1 ring-[var(--hairline)]">
            <Link
              href="/settings/profile"
              className="inline-flex h-8 items-center gap-1.5 rounded-full px-4 text-[13px] font-medium text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] transition-all duration-[150ms]"
            >
              <User className="h-3.5 w-3.5" strokeWidth={1.85} />
              <span>{t("shell.menu.profile")}</span>
            </Link>
            <Link
              href="/settings/agent"
              className="inline-flex h-8 items-center gap-1.5 rounded-full px-4 text-[13px] font-medium text-[var(--ink-secondary)] hover:text-[var(--ink-primary)] transition-all duration-[150ms]"
            >
              <Bot className="h-3.5 w-3.5" strokeWidth={1.85} />
              <span>
                {tx({
                  "zh-CN": "助手设定",
                  "zh-HK": "助手設定",
                  en: "Agent Settings",
                })}
              </span>
            </Link>
            <Link
              href="/settings/memory"
              aria-current="page"
              className="inline-flex h-8 items-center gap-1.5 rounded-full bg-[var(--bg-surface)] px-4 text-[13px] font-semibold text-[var(--accent-ink)] shadow-[var(--shadow-subtle)] ring-1 ring-[var(--hairline)] transition-all duration-[150ms]"
            >
              <BookOpen className="h-3.5 w-3.5" strokeWidth={1.85} />
              <span>
                {tx({
                  "zh-CN": "长期记忆 · MEMORY.md",
                  "zh-HK": "長期記憶 · MEMORY.md",
                  en: "Long-Term Memory",
                })}
              </span>
            </Link>
          </div>

          <div className="flex items-center gap-2">
            {isDirty && (
              <span
                data-testid="memory-unsaved-badge"
                className="inline-flex items-center gap-1.5 rounded-full border border-[var(--status-amber-border)] bg-[var(--status-amber-wash)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--status-amber-ink)]"
              >
                <span
                  aria-hidden="true"
                  className="h-1.5 w-1.5 rounded-full bg-[var(--status-amber)]"
                />
                {tx({
                  "zh-CN": "未保存修改",
                  "zh-HK": "未儲存變更",
                  en: "Unsaved changes",
                })}
              </span>
            )}
            {record && (
              <span
                data-testid="memory-version-badge"
                className="rounded-full bg-[var(--bg-surface)] px-3 py-1 text-[11.5px] text-[var(--ink-muted)] shadow-[var(--shadow-subtle)]"
              >
                {tx({
                  "zh-CN": "版本 ",
                  "zh-HK": "版本 ",
                  en: "Version ",
                })}
                <span className="font-mono-code">v{record.version}</span>
              </span>
            )}
          </div>
        </div>

        {/* Main Porcelain / Obsidian Memory Editor Sheet */}
        <section className="overflow-hidden rounded-card border border-[var(--hairline)] bg-[var(--bg-surface)] shadow-[var(--shadow-card)]">
          {/* Header & Muse-Inspired Editorial Explainer */}
          <div className="border-b border-[var(--hairline)] px-6 py-5 space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2.5">
                  <h2 className="aios-display text-[18px] font-semibold text-[var(--ink-primary)]">
                    {tx({
                      "zh-CN": "个人长期记忆",
                      "zh-HK": "個人長期記憶",
                      en: "Personal Long-Term Memory",
                    })}
                  </h2>
                  <span className="rounded-full border border-[var(--hairline)] bg-[var(--bg-surface-subtle)] px-2.5 py-0.5 font-mono-code text-[11.5px] text-[var(--ink-secondary)]">
                    {record?.filename ?? "MEMORY.md"}
                  </span>
                </div>
                <p className="mt-1 text-[13px] text-[var(--ink-muted)]">
                  {tx({
                    "zh-CN": "透明可控的跨会话 Markdown 记忆文件，按租户与员工账号严格隔离。",
                    "zh-HK": "透明可控的跨對話 Markdown 記憶檔案，按租戶與員工帳號嚴格隔離。",
                    en: "Transparent, user-editable Markdown memory scoped strictly to your account.",
                  })}
                </p>
              </div>

              <Button
                type="button"
                variant="secondary"
                size="sm"
                pill
                loading={loading}
                disabled={isBusy}
                data-testid="memory-refresh-btn"
                onClick={() => void loadMemory()}
              >
                <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.85} />
                <span>
                  {tx({
                    "zh-CN": "刷新",
                    "zh-HK": "重新整理",
                    en: "Refresh",
                  })}
                </span>
              </Button>
            </div>

            {/* Muse-inspired Editorial Explainer Banner */}
            <aside
              data-testid="memory-muse-note"
              className="rounded-tile border border-[var(--hairline)] bg-[var(--bg-surface-tint)] px-4 py-3.5 text-[12.5px] leading-[1.65] text-[var(--ink-secondary)]"
            >
              <div className="flex items-start gap-2.5">
                <BookOpen
                  className="mt-0.5 h-4 w-4 shrink-0 text-[var(--ink-muted)]"
                  strokeWidth={1.85}
                />
                <p className="min-w-0">
                  {tx({
                    "zh-CN": "这是助手的长期记忆文件（",
                    "zh-HK": "這是助手的長期記憶檔案（",
                    en: "This is your assistant's long-term memory (",
                  })}
                  <code className="rounded-xs border border-[var(--hairline)] bg-[var(--bg-surface)] px-1 py-[1px] font-mono-code text-[11.5px] text-[var(--ink-primary)]">
                    MEMORY.md
                  </code>
                  {tx({
                    "zh-CN":
                      "），记录助手在长期对话中认为值得保留的、关于您与工作的关键事实及偏好。每次新对话开始时助手都会读取这份文件，夜间例行整理任务也会定期梳理去重。它仅代表助手当前对您工作偏好的理解，部分内容可能随时间变化而过时。您可以直接在此编辑任何内容，或在对话中让助手记住或忘掉特定事项。",
                    "zh-HK":
                      "），記錄助手在長期對話中認為值得保留的、關於您與工作的關鍵事實及偏好。每次新對話開始時助手都會讀取這份檔案，夜間例行整理任務亦會定期梳理去重。它僅代表助手目前對您工作偏好的理解，部分內容可能隨時間變化而過時。您可以直接在此編輯任何內容，或在對話中讓助手記住或忘掉特定事項。",
                    en: "). It holds the facts and preferences your assistant has decided are worth keeping about you and your work, gathered from your conversations over time. It reads this file at the start of each conversation, and a nightly pass keeps it tidy. It reflects your assistant's current understanding and can be out of date. You can edit anything here directly, or ask your assistant in chat to remember or forget something. ",
                  })}
                  <strong className="font-semibold text-[var(--ink-primary)]">
                    {tx({
                      "zh-CN": "此说明并非文件内容本身。",
                      "zh-HK": "此說明並非文件內容本身。",
                      en: "This note is not part of the file.",
                    })}
                  </strong>
                </p>
              </div>
            </aside>

            {/* Metadata & Token Budget Strip */}
            <div className="rounded-tile border border-[var(--hairline)] bg-[var(--bg-surface-subtle)] px-4 py-3.5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-[var(--ink-primary)]">
                    {tx({
                      "zh-CN": "记忆容量预算",
                      "zh-HK": "記憶容量預算",
                      en: "Memory Budget",
                    })}
                  </span>
                  <span
                    data-testid="memory-token-meter"
                    className={[
                      "font-mono-code tabular-nums",
                      isOverLimit
                        ? "font-semibold text-[var(--status-crimson)]"
                        : usagePct >= 80
                          ? "font-medium text-[var(--status-amber)]"
                          : "text-[var(--ink-secondary)]",
                    ].join(" ")}
                  >
                    {isDirty ? `~${liveTokens}` : (record?.token_count ?? liveTokens)}{" "}
                    / {maxTokens} tok
                  </span>
                  <span className="text-[var(--ink-faint)]">·</span>
                  <span
                    className={[
                      "font-mono-code tabular-nums",
                      isOverCharLimit
                        ? "font-semibold text-[var(--status-crimson)]"
                        : "text-[var(--ink-muted)]",
                    ].join(" ")}
                  >
                    {liveChars} / {maxChars}{" "}
                    {tx({ "zh-CN": "字符", "zh-HK": "字元", en: "chars" })}
                  </span>
                  {record && isDirty && (
                    <span className="font-mono-code text-[11px] text-[var(--ink-muted)]">
                      ({tx({
                        "zh-CN": "已存",
                        "zh-HK": "已存",
                        en: "saved",
                      })}{" "}
                      {record.token_count}/{maxTokens} tok)
                    </span>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <span
                    data-testid="memory-has-previous-pill"
                    className="inline-flex items-center gap-1 rounded-full border border-[var(--hairline)] bg-[var(--bg-surface)] px-2.5 py-0.5 text-[11px] text-[var(--ink-secondary)]"
                  >
                    <span
                      aria-hidden="true"
                      className={[
                        "h-1.5 w-1.5 rounded-full",
                        record?.has_previous
                          ? "bg-[var(--status-emerald)]"
                          : "bg-[var(--ink-faint)]",
                      ].join(" ")}
                    />
                    {record?.has_previous
                      ? tx({
                          "zh-CN": "可撤销上一版",
                          "zh-HK": "可撤銷上一版",
                          en: "Undo available",
                        })
                      : tx({
                          "zh-CN": "暂无历史快照",
                          "zh-HK": "暫無歷史快照",
                          en: "No previous snapshot",
                        })}
                  </span>

                  <span
                    data-testid="memory-staged-count-pill"
                    className={[
                      "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium tabular-nums",
                      (record?.pending_staged_count ?? 0) > 0
                        ? "border-[var(--accent-border)] bg-[var(--accent-wash)] text-[var(--accent-ink)]"
                        : "border-[var(--hairline)] bg-[var(--bg-surface)] text-[var(--ink-muted)]",
                    ].join(" ")}
                  >
                    {tx(
                      {
                        "zh-CN": "待整理 {count} 条",
                        "zh-HK": "待整理 {count} 條",
                        en: "{count} staged",
                      },
                      { count: record?.pending_staged_count ?? 0 },
                    )}
                  </span>
                </div>
              </div>

              {/* Subtle Neutral Budget Bar (Amber >= 80%, Crimson >= 100%) */}
              <div
                aria-hidden="true"
                className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--hairline-strong)]"
              >
                <div
                  className={[
                    "h-full rounded-full transition-all duration-[200ms]",
                    progressBarClass,
                  ].join(" ")}
                  style={{ width: `${Math.max(0, Math.min(100, usagePct))}%` }}
                />
              </div>

              {/* Compact Provenance Row */}
              <dl className="grid grid-cols-2 gap-3 pt-0.5 text-[11.5px] sm:grid-cols-3">
                <div>
                  <dt className="text-[var(--ink-muted)]">
                    {tx({
                      "zh-CN": "最近更新",
                      "zh-HK": "最近更新",
                      en: "Last Updated",
                    })}
                  </dt>
                  <dd className="mt-0.5 font-mono-code text-[var(--ink-primary)] tabular-nums">
                    {record?.updated_at ? formatDateTime(record.updated_at) : "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-[var(--ink-muted)]">
                    {tx({
                      "zh-CN": "更新来源",
                      "zh-HK": "更新來源",
                      en: "Updated By",
                    })}
                  </dt>
                  <dd className="mt-0.5 font-mono-code text-[var(--ink-primary)] truncate">
                    {record?.updated_by || "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-[var(--ink-muted)]">
                    {tx({
                      "zh-CN": "最近整理时间",
                      "zh-HK": "最近整理時間",
                      en: "Last Tidy Pass",
                    })}
                  </dt>
                  <dd className="mt-0.5 font-mono-code text-[var(--ink-primary)] tabular-nums">
                    {record?.last_tidy_at
                      ? formatDateTime(record.last_tidy_at)
                      : "—"}
                  </dd>
                </div>
              </dl>
            </div>
          </div>

          {/* Feedback Banners */}
          {(successNotice ||
            conflictNotice ||
            policyFeedback ||
            isOverLimit ||
            apiError) && (
            <div className="border-b border-[var(--hairline)] px-6 py-4 space-y-2.5">
              {successNotice && (
                <div
                  role="status"
                  data-testid="memory-save-success"
                  className="flex items-center gap-2 rounded-sm border border-[var(--status-emerald-border)] bg-[var(--status-emerald-wash)] px-3.5 py-2.5 text-[12.5px] text-[var(--status-emerald)]"
                >
                  <CheckCircle2
                    className="h-4 w-4 shrink-0"
                    strokeWidth={1.9}
                  />
                  <span>{successNotice}</span>
                </div>
              )}

              {conflictNotice && (
                <div
                  role="alert"
                  data-testid="memory-conflict-banner"
                  className="flex flex-wrap items-center justify-between gap-3 rounded-sm border border-[var(--status-amber-border)] bg-[var(--status-amber-wash)] px-3.5 py-2.5 text-[12.5px] text-[var(--status-amber-ink)]"
                >
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <AlertTriangle
                      className="h-4 w-4 shrink-0"
                      strokeWidth={1.9}
                    />
                    <span>{conflictNotice}</span>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    pill
                    loading={loading}
                    data-testid="memory-reload-latest-btn"
                    onClick={() => void loadMemory()}
                  >
                    <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.85} />
                    <span>
                      {tx({
                        "zh-CN": "重新加载最新 MEMORY.md",
                        "zh-HK": "重新載入最新 MEMORY.md",
                        en: "Reload Latest MEMORY.md",
                      })}
                    </span>
                  </Button>
                </div>
              )}

              {policyFeedback && (
                <div
                  role="alert"
                  data-testid="memory-policy-error"
                  className="rounded-sm border border-[var(--status-crimson-border)] bg-[var(--status-crimson-wash)] px-3.5 py-2.5 text-[12.5px] text-[var(--status-crimson)]"
                >
                  <div className="flex items-start gap-2.5">
                    <ShieldAlert
                      className="mt-0.5 h-4 w-4 shrink-0"
                      strokeWidth={1.9}
                    />
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">
                          {policyFeedback.title}
                        </span>
                        <span className="rounded-xs border border-[var(--status-crimson-border)] bg-[var(--bg-surface)] px-1.5 py-0.5 font-mono-code text-[11px]">
                          {policyFeedback.code}
                        </span>
                      </div>
                      <p className="leading-relaxed opacity-95">
                        {policyFeedback.reason}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {isOverLimit && !policyFeedback && (
                <div
                  role="alert"
                  data-testid="memory-budget-warning"
                  className="flex items-center gap-2 rounded-sm border border-[var(--status-crimson-border)] bg-[var(--status-crimson-wash)] px-3.5 py-2.5 text-[12.5px] text-[var(--status-crimson)]"
                >
                  <AlertTriangle
                    className="h-4 w-4 shrink-0"
                    strokeWidth={1.9}
                  />
                  <span>
                    {tx(
                      {
                        "zh-CN":
                          "当前草稿已超出上限（~{tok}/{maxTok} tokens，{chars}/{maxChars} 字符），请精简或点击整理后再保存。",
                        "zh-HK":
                          "目前草稿已超出上限（~{tok}/{maxTok} tokens，{chars}/{maxChars} 字元），請精簡或點擊整理後再儲存。",
                        en: "Draft exceeds budget (~{tok}/{maxTok} tokens, {chars}/{maxChars} chars). Trim content before saving.",
                      },
                      {
                        tok: liveTokens,
                        maxTok: maxTokens,
                        chars: liveChars,
                        maxChars,
                      },
                    )}
                  </span>
                </div>
              )}

              {apiError && (
                <AccessNoticeCard
                  error={apiError}
                  onRetry={() => void loadMemory()}
                />
              )}
            </div>
          )}

          {/* Editor Toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--hairline)] bg-[var(--bg-surface-tint)] px-6 py-3">
            {/* Edit / Split / Preview Segmented Toggle */}
            <div
              role="group"
              aria-label={tx({
                "zh-CN": "视图模式",
                "zh-HK": "檢視模式",
                en: "Editor View Mode",
              })}
              data-testid="memory-view-mode"
              className="inline-flex rounded-sm bg-[var(--bg-inset)] p-0.5"
            >
              <button
                type="button"
                onClick={() => setViewMode("edit")}
                data-testid="memory-mode-edit"
                className={[
                  "inline-flex h-7 items-center gap-1.5 rounded-xs px-2.5 text-[12px] font-medium transition-all cursor-pointer",
                  viewMode === "edit"
                    ? "bg-[var(--bg-surface)] text-[var(--ink-primary)] shadow-[var(--shadow-subtle)]"
                    : "text-[var(--ink-muted)] hover:text-[var(--ink-primary)]",
                ].join(" ")}
              >
                <PencilLine className="h-3.5 w-3.5" strokeWidth={1.85} />
                <span>
                  {tx({ "zh-CN": "编辑", "zh-HK": "編輯", en: "Edit" })}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setViewMode("split")}
                data-testid="memory-mode-split"
                className={[
                  "inline-flex h-7 items-center gap-1.5 rounded-xs px-2.5 text-[12px] font-medium transition-all cursor-pointer",
                  viewMode === "split"
                    ? "bg-[var(--bg-surface)] text-[var(--ink-primary)] shadow-[var(--shadow-subtle)]"
                    : "text-[var(--ink-muted)] hover:text-[var(--ink-primary)]",
                ].join(" ")}
              >
                <Columns2 className="h-3.5 w-3.5" strokeWidth={1.85} />
                <span>
                  {tx({ "zh-CN": "分栏", "zh-HK": "分欄", en: "Split" })}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setViewMode("preview")}
                data-testid="memory-mode-preview"
                className={[
                  "inline-flex h-7 items-center gap-1.5 rounded-xs px-2.5 text-[12px] font-medium transition-all cursor-pointer",
                  viewMode === "preview"
                    ? "bg-[var(--bg-surface)] text-[var(--ink-primary)] shadow-[var(--shadow-subtle)]"
                    : "text-[var(--ink-muted)] hover:text-[var(--ink-primary)]",
                ].join(" ")}
              >
                <Eye className="h-3.5 w-3.5" strokeWidth={1.85} />
                <span>
                  {tx({ "zh-CN": "预览", "zh-HK": "預覽", en: "Preview" })}
                </span>
              </button>
            </div>

            {/* Action Buttons */}
            <div className="flex flex-wrap items-center gap-2">
              {draftContent.trim().length === 0 && viewMode === "edit" && (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  pill
                  disabled={isBusy}
                  data-testid="memory-insert-template-btn"
                  onClick={handleInsertTemplate}
                >
                  <FilePlus2 className="h-3.5 w-3.5" strokeWidth={1.85} />
                  <span>
                    {tx({
                      "zh-CN": "插入结构化模板",
                      "zh-HK": "插入結構化範本",
                      en: "Insert Structured Template",
                    })}
                  </span>
                </Button>
              )}

              <Button
                type="button"
                size="sm"
                variant="secondary"
                pill
                loading={reverting}
                disabled={!record?.has_previous || isBusy}
                data-testid="memory-revert-btn"
                onClick={() => void handleRevert()}
              >
                <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.85} />
                <span>
                  {tx({
                    "zh-CN": "撤销上一版",
                    "zh-HK": "撤銷上一版",
                    en: "Undo Last Version",
                  })}
                </span>
              </Button>

              <Button
                type="button"
                size="sm"
                variant="secondary"
                pill
                loading={tidyingMode === "deterministic"}
                disabled={!record || isBusy}
                data-testid="memory-tidy-btn"
                onClick={() => void handleTidy(false)}
              >
                <Sparkles className="h-3.5 w-3.5" strokeWidth={1.85} />
                <span>
                  {tx({
                    "zh-CN": "立即整理",
                    "zh-HK": "立即整理",
                    en: "Tidy Now",
                  })}
                </span>
              </Button>

              {!confirmClearOpen ? (
                <Button
                  type="button"
                  size="sm"
                  variant="danger"
                  pill
                  disabled={!canClear || isBusy}
                  data-testid="memory-clear-btn"
                  onClick={() => setConfirmClearOpen(true)}
                >
                  <Trash2 className="h-3.5 w-3.5" strokeWidth={1.85} />
                  <span>
                    {tx({
                      "zh-CN": "清空",
                      "zh-HK": "清空",
                      en: "Clear",
                    })}
                  </span>
                </Button>
              ) : (
                <div className="inline-flex flex-wrap items-center gap-1.5 rounded-full border border-[var(--status-crimson-border)] bg-[var(--status-crimson-wash)] px-2.5 py-0.5">
                  <span className="pl-1 text-[11.5px] font-medium text-[var(--status-crimson)]">
                    {tx({
                      "zh-CN": "确认清空？",
                      "zh-HK": "確認清空？",
                      en: "Confirm clear?",
                    })}
                  </span>
                  <label className="inline-flex cursor-pointer items-center gap-1 px-1 text-[11px] font-medium text-[var(--status-crimson)] select-none">
                    <input
                      type="checkbox"
                      checked={clearPermanent}
                      disabled={clearing}
                      data-testid="memory-clear-permanent-checkbox"
                      onChange={(e) => setClearPermanent(e.target.checked)}
                      className="h-4 w-4 rounded-xs border border-[var(--hairline-strong)] bg-[var(--bg-surface-tint)] accent-[var(--accent-solid)] cursor-pointer"
                    />
                    <span>
                      {tx({
                        "zh-CN": "永久清除（不可撤回）",
                        "zh-HK": "永久清除（不可撤回）",
                        en: "Permanent erase (no Undo)",
                      })}
                    </span>
                  </label>
                  <Button
                    type="button"
                    size="sm"
                    variant="danger-solid"
                    pill
                    loading={clearing}
                    disabled={isBusy}
                    data-testid="memory-clear-confirm-btn"
                    className="h-6 px-2.5 text-[11.5px]"
                    onClick={() => void handleConfirmClear()}
                  >
                    {tx({
                      "zh-CN": "确认清空",
                      "zh-HK": "確認清空",
                      en: "Clear All",
                    })}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    pill
                    disabled={clearing}
                    data-testid="memory-clear-cancel-btn"
                    className="h-6 px-2 text-[11.5px]"
                    onClick={() => {
                      setConfirmClearOpen(false);
                      setClearPermanent(false);
                    }}
                  >
                    {t("common.cancel")}
                  </Button>
                </div>
              )}

              <Button
                type="button"
                size="sm"
                variant="primary"
                pill
                loading={saving}
                disabled={!record || !isDirty || isOverLimit || isBusy}
                data-testid="memory-save-btn"
                className="px-4"
                onClick={() => void handleSave()}
              >
                {isDirty ? (
                  <span
                    aria-hidden="true"
                    className="h-2 w-2 rounded-full bg-[var(--status-amber)]"
                  />
                ) : (
                  <Save className="h-3.5 w-3.5" strokeWidth={1.85} />
                )}
                <span>
                  {saving
                    ? tx({
                        "zh-CN": "保存中…",
                        "zh-HK": "儲存中…",
                        en: "Saving…",
                      })
                    : tx({
                        "zh-CN": "保存",
                        "zh-HK": "儲存",
                        en: "Save",
                      })}
                </span>
                <kbd className="hidden sm:inline-block rounded-xs bg-[var(--bg-surface)]/15 px-1 py-[1px] font-mono-code text-[10px] opacity-80">
                  ⌘S
                </kbd>
              </Button>
            </div>
          </div>

          {/* Editor / Split / Live Markdown Preview Body */}
          <div
            className={
              viewMode === "split"
                ? "grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-[var(--hairline)]"
                : ""
            }
          >
            {viewMode !== "preview" && (
              <div className="flex flex-col bg-[var(--bg-surface)]">
                <div className="flex items-center justify-between border-b border-[var(--hairline-subtle)] px-4 py-2 text-[11.5px] text-[var(--ink-muted)]">
                  <span className="font-mono-code">MEMORY.md · Markdown</span>
                  <span>
                    {tx({
                      "zh-CN": "支持 Cmd/Ctrl + S 保存",
                      "zh-HK": "支援 Cmd/Ctrl + S 儲存",
                      en: "Press Cmd/Ctrl + S to save",
                    })}
                  </span>
                </div>
                <textarea
                  ref={editorRef}
                  data-testid="memory-editor-textarea"
                  aria-label={tx({
                    "zh-CN": "MEMORY.md 长期记忆编辑器",
                    "zh-HK": "MEMORY.md 長期記憶編輯器",
                    en: "MEMORY.md Long-Term Memory Editor",
                  })}
                  value={draftContent}
                  disabled={!record && loading}
                  spellCheck={false}
                  onChange={(e) => {
                    setDraftContent(e.target.value);
                    if (policyFeedback) setPolicyFeedback(null);
                  }}
                  placeholder={tx({
                    "zh-CN":
                      "在此编辑助手需要跨会话记住的工作背景、沟通偏好与长期习惯…",
                    "zh-HK":
                      "在此編輯助手需要跨對話記住的工作背景、溝通偏好與長期習慣…",
                    en: "Write facts, preferences, and ongoing commitments for your assistant to remember across conversations…",
                  })}
                  className="min-h-[380px] w-full flex-1 resize-y bg-transparent px-5 py-4 font-mono-code text-[13px] leading-[1.65] text-[var(--ink-primary)] placeholder:text-[var(--ink-faint)] focus:outline-none"
                />
              </div>
            )}

            {viewMode !== "edit" && (
              <div className="flex flex-col bg-[var(--bg-surface-tint)]/55">
                <div className="flex items-center justify-between border-b border-[var(--hairline-subtle)] px-4 py-2 text-[11.5px] text-[var(--ink-muted)]">
                  <span>
                    {tx({
                      "zh-CN": "实时 Markdown 预览",
                      "zh-HK": "即時 Markdown 預覽",
                      en: "Live Markdown Preview",
                    })}
                  </span>
                  <span className="font-mono-code tabular-nums">
                    {draftContent.trim().length > 0
                      ? `Markdown · ${liveChars} ${tx({
                          "zh-CN": "字符",
                          "zh-HK": "字元",
                          en: "chars",
                        })}`
                      : "Markdown"}
                  </span>
                </div>
                <div
                  data-testid="memory-preview-pane"
                  className="min-h-[380px] max-h-[560px] flex-1 overflow-y-auto px-5 py-4"
                >
                  {draftContent.trim().length > 0 ? (
                    <MarkdownMessage tone="surface" content={draftContent} />
                  ) : (
                    <div className="flex h-full min-h-[280px] flex-col items-center justify-center text-center px-4">
                      <BookOpen
                        className="h-6 w-6 text-[var(--ink-faint)]"
                        strokeWidth={1.6}
                      />
                      <p className="mt-2.5 text-[13px] text-[var(--ink-muted)]">
                        {tx({
                          "zh-CN":
                            "MEMORY.md 当前为空。助手将按常规工作规则与您协作。",
                          "zh-HK":
                            "MEMORY.md 目前為空。助手將按常規工作規則與您協作。",
                          en: "MEMORY.md is currently empty. Your assistant starts sessions without extra memory notes.",
                        })}
                      </p>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        pill
                        disabled={isBusy}
                        data-testid="memory-insert-template-btn"
                        className="mt-3"
                        onClick={handleInsertTemplate}
                      >
                        <FilePlus2 className="h-3.5 w-3.5" strokeWidth={1.85} />
                        <span>
                          {tx({
                            "zh-CN": "插入结构化模板",
                            "zh-HK": "插入結構化範本",
                            en: "Insert Structured Template",
                          })}
                        </span>
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </section>

        {/* Secondary Cards: Pending Staged Capture Queue & Quick Forget */}
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
          {/* Pending Staged Capture Queue */}
          <section
            data-testid="memory-staged-card"
            className="lg:col-span-7 overflow-hidden rounded-card border border-[var(--hairline)] bg-[var(--bg-surface)] shadow-[var(--shadow-card)]"
          >
            <div className="border-b border-[var(--hairline)] px-5 py-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <h3 className="text-[14.5px] font-semibold text-[var(--ink-primary)]">
                    {tx({
                      "zh-CN": "待整理记忆队列",
                      "zh-HK": "待整理記憶佇列",
                      en: "Pending Staged Capture Queue",
                    })}
                  </h3>
                  <span className="rounded-full bg-[var(--bg-surface-subtle)] px-2 py-0.5 font-mono-code text-[11px] font-medium text-[var(--ink-secondary)] tabular-nums">
                    {record?.pending_staged_count ?? 0}
                  </span>
                </div>
              </div>
              <p className="text-[12.5px] leading-relaxed text-[var(--ink-muted)]">
                {tx({
                  "zh-CN":
                    "对话过程中通过零 Token 规则被动捕获的偏好与事实线索，待整理合并进 MEMORY.md。",
                  "zh-HK":
                    "對話過程中透過零 Token 規則被動捕獲的偏好與事實線索，待整理合併進 MEMORY.md。",
                  en: "Passive facts and preferences staged from chat at zero LLM cost, waiting to be consolidated into MEMORY.md.",
                })}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  pill
                  loading={tidyingMode === "deterministic"}
                  disabled={!record || isBusy}
                  data-testid="memory-tidy-deterministic-btn"
                  onClick={() => void handleTidy(false)}
                >
                  <Sparkles className="h-3.5 w-3.5" strokeWidth={1.85} />
                  <span>
                    {tx({
                      "zh-CN": "合并至 MEMORY.md（0-Token）",
                      "zh-HK": "合併至 MEMORY.md（0-Token）",
                      en: "Tidy Into MEMORY.md (0-Token)",
                    })}
                  </span>
                </Button>

                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  pill
                  loading={tidyingMode === "llm"}
                  disabled={!record || isBusy}
                  data-testid="memory-tidy-llm-btn"
                  onClick={() => void handleTidy(true)}
                >
                  <Bot className="h-3.5 w-3.5" strokeWidth={1.85} />
                  <span>
                    {tx({
                      "zh-CN": "AI 智能归并（T2）",
                      "zh-HK": "AI 智能歸併（T2）",
                      en: "AI Consolidate (T2)",
                    })}
                  </span>
                </Button>
              </div>
            </div>

            <div className="divide-y divide-[var(--hairline-subtle)]">
              {record && record.pending_staged_items.length > 0 ? (
                record.pending_staged_items.map((item) => (
                  <div
                    key={item.id}
                    data-testid="memory-staged-item"
                    className="px-5 py-3.5 space-y-1.5"
                  >
                    <p className="text-[13px] leading-relaxed text-[var(--ink-primary)] break-words">
                      {item.fact_text}
                    </p>
                    <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--ink-muted)]">
                      <span className="rounded-xs border border-[var(--hairline)] bg-[var(--bg-surface-subtle)] px-1.5 py-0.5 font-mono-code text-[var(--ink-secondary)]">
                        {item.section_hint}
                      </span>
                      <span className="rounded-xs bg-[var(--bg-surface-tint)] px-1.5 py-0.5 font-mono-code">
                        {item.source_kind}
                      </span>
                      <span className="font-mono-code tabular-nums">
                        {formatDateTime(item.created_at)}
                      </span>
                    </div>
                  </div>
                ))
              ) : (
                <div className="px-5 py-6 text-center text-[12.5px] text-[var(--ink-muted)]">
                  {tx({
                    "zh-CN":
                      "暂无待整理记忆线索。您也可在对话中使用 /memory 或说“记住…”直接记录。",
                    "zh-HK":
                      "暫無待整理記憶線索。您亦可在對話中使用 /memory 或說「記住…」直接記錄。",
                    en: "No pending staged cues right now. Use /memory or say “remember that…” in chat anytime.",
                  })}
                </div>
              )}
            </div>
          </section>

          {/* Quick Forget Card */}
          <section
            data-testid="memory-forget-card"
            className="lg:col-span-5 overflow-hidden rounded-card border border-[var(--hairline)] bg-[var(--bg-surface)] shadow-[var(--shadow-card)]"
          >
            <div className="border-b border-[var(--hairline)] px-5 py-4">
              <div className="flex items-center gap-2">
                <Eraser
                  className="h-4 w-4 text-[var(--ink-muted)]"
                  strokeWidth={1.85}
                />
                <h3 className="text-[14.5px] font-semibold text-[var(--ink-primary)]">
                  {tx({
                    "zh-CN": "快速遗忘",
                    "zh-HK": "快速遺忘",
                    en: "Quick Forget",
                  })}
                </h3>
              </div>
              <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--ink-muted)]">
                {tx({
                  "zh-CN":
                    "输入关键词，立即从 MEMORY.md 与待整理队列中精确剔除匹配条目（并保留上一版以备撤销）。",
                  "zh-HK":
                    "輸入關鍵詞，立即從 MEMORY.md 與待整理佇列中精確剔除符合的條目（並保留上一版以備撤銷）。",
                  en: "Purge matching lines from MEMORY.md and pending cues instantly while keeping the previous snapshot for Undo.",
                })}
              </p>
            </div>

            <form
              onSubmit={(e) => void handleForget(e)}
              className="p-5 space-y-3"
            >
              <div>
                <label
                  htmlFor="memory-forget-query"
                  className="block text-[12px] font-medium text-[var(--ink-secondary)]"
                >
                  {tx({
                    "zh-CN": "关键词或短语",
                    "zh-HK": "關鍵詞或短語",
                    en: "Keyword or phrase",
                  })}
                </label>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    id="memory-forget-query"
                    data-testid="memory-forget-input"
                    type="text"
                    value={forgetQuery}
                    disabled={!record || isBusy}
                    onChange={(e) => setForgetQuery(e.target.value)}
                    placeholder={tx({
                      "zh-CN": "例如：供应商 B、周报格式…",
                      "zh-HK": "例如：供應商 B、週報格式…",
                      en: "e.g. Supplier B, report format…",
                    })}
                    className="aios-input min-w-0 flex-1"
                  />
                  <Button
                    type="submit"
                    size="md"
                    variant="secondary"
                    pill
                    loading={forgetting}
                    disabled={!record || isBusy || forgetQuery.trim().length === 0}
                    data-testid="memory-forget-btn"
                  >
                    <Eraser className="h-3.5 w-3.5" strokeWidth={1.85} />
                    <span>
                      {tx({
                        "zh-CN": "遗忘",
                        "zh-HK": "遺忘",
                        en: "Forget",
                      })}
                    </span>
                  </Button>
                </div>
              </div>

              <label className="inline-flex cursor-pointer items-center gap-2 text-[12px] text-[var(--ink-secondary)] select-none">
                <input
                  type="checkbox"
                  checked={forgetPermanent}
                  disabled={!record || isBusy}
                  data-testid="memory-forget-permanent-checkbox"
                  onChange={(e) => setForgetPermanent(e.target.checked)}
                  className="h-4 w-4 rounded-xs border border-[var(--hairline-strong)] bg-[var(--bg-surface-tint)] accent-[var(--accent-solid)] cursor-pointer"
                />
                <span
                  className={
                    forgetPermanent
                      ? "font-medium text-[var(--status-crimson)]"
                      : ""
                  }
                >
                  {tx({
                    "zh-CN": "永久擦除（不可撤销）",
                    "zh-HK": "永久抹除（不可撤銷）",
                    en: "Permanent erase (no Undo)",
                  })}
                </span>
              </label>

              <p className="text-[11.5px] leading-relaxed text-[var(--ink-muted)]">
                {tx({
                  "zh-CN":
                    "提示：在助手对话中也可直接发送 /memory forget <关键词>。",
                  "zh-HK":
                    "提示：在助手對話中亦可直接傳送 /memory forget <關鍵詞>。",
                  en: "Tip: you can also run /memory forget <query> directly inside Assistant chat.",
                })}
              </p>
            </form>
          </section>
        </div>
      </div>
    </div>
  );
}
