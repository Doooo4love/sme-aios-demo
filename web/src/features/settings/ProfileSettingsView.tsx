"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  RotateCcw,
  Trash2,
  Upload,
  User,
} from "lucide-react";
import {
  fetchAgentProfile,
  fetchProfile,
  isApiError,
  isStaleAuthError,
  type ApiError,
} from "@/lib/api-client";
import { formatRoleLabel } from "@/lib/format";
import { useSession } from "@/lib/session-context";
import { AccessNoticeCard } from "@/components/ui/AccessNoticeCard";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import {
  deleteProfileAvatar,
  patchProfileDisplayName,
  uploadProfileAvatar,
  validateAvatarFile,
  type ProfileKind,
} from "@/features/settings/api";
import type { Profile } from "@/lib/types";

export interface ProfileSettingsViewProps {
  kind: ProfileKind;
}

export function ProfileSettingsView({ kind }: ProfileSettingsViewProps) {
  const {
    status,
    actor,
    profile: ctxProfile,
    agentProfile: ctxAgentProfile,
    avatarVersion,
    agentAvatarVersion,
    authGeneration,
    refreshProfiles,
    updateProfileState,
    updateAgentProfileState,
    handleAccessChanged,
  } = useSession();

  const isAgent = kind === "agent";
  const prefix = isAgent ? "agent" : "profile";
  const currentCtxProfile = isAgent ? ctxAgentProfile : ctxProfile;
  const currentAvatarVersion = isAgent ? agentAvatarVersion : avatarVersion;

  const [record, setRecord] = useState<Profile | null>(currentCtxProfile);
  const [displayNameInput, setDisplayNameInput] = useState<string>(
    currentCtxProfile?.display_name ?? "",
  );
  const [loading, setLoading] = useState(false);
  const [savingName, setSavingName] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [deletingAvatar, setDeletingAvatar] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [apiError, setApiError] = useState<ApiError | null>(null);
  const [conflictNotice, setConflictNotice] = useState<string | null>(null);
  const [successNotice, setSuccessNotice] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const loadLatestProfile = useCallback(
    async (preserveDraft = false) => {
      if (status !== "authenticated") return null;
      setLoading(true);
      setApiError(null);
      try {
        const fresh = isAgent
          ? await fetchAgentProfile()
          : await fetchProfile();
        setRecord(fresh);
        if (!preserveDraft) {
          setDisplayNameInput(fresh.display_name ?? "");
        }
        return fresh;
      } catch (err) {
        if (isStaleAuthError(err)) return null;
        if (isApiError(err)) {
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
    [status, isAgent, handleAccessChanged],
  );

  useEffect(() => {
    setInlineError(null);
    setApiError(null);
    setConflictNotice(null);
    setSuccessNotice(null);
    void loadLatestProfile(false);
  }, [kind, authGeneration, loadLatestProfile]);

  const syncGlobalSession = useCallback(
    async (updated: Profile) => {
      setRecord(updated);
      if (isAgent) {
        updateAgentProfileState(updated);
      } else {
        updateProfileState(updated);
      }
      await refreshProfiles().catch(() => null);
    },
    [isAgent, updateAgentProfileState, updateProfileState, refreshProfiles],
  );

  const handleVersionConflict = useCallback(
    async (preserveDraft: boolean) => {
      const latest = await loadLatestProfile(preserveDraft);
      if (latest) {
        setConflictNotice(
          `资料版本已在其他会话中更新，已同步最新版本 v${latest.version}，请核对后重新保存。`,
        );
      } else {
        setConflictNotice("资料版本已变更，请刷新页面后重新保存。");
      }
    },
    [loadLatestProfile],
  );

  const handleSaveName = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!record || savingName) return;
    const trimmed = displayNameInput.trim();
    if (!trimmed) {
      setInlineError("请输入显示名称，或点击“恢复默认名称”清除自定义名称。");
      return;
    }
    if (trimmed.length > 80) {
      setInlineError("显示名称不能超过 80 个字符。");
      return;
    }

    setSavingName(true);
    setInlineError(null);
    setApiError(null);
    setConflictNotice(null);
    setSuccessNotice(null);

    try {
      const updated = await patchProfileDisplayName(kind, record.version, trimmed);
      setDisplayNameInput(updated.display_name ?? "");
      await syncGlobalSession(updated);
      setSuccessNotice(
        isAgent
          ? `个人 Agent 名称已更新为“${updated.display_name}”，会话列表与对话头部已同步生效。`
          : `个人显示名称已更新为“${updated.display_name}”，全站视图已同步生效。`,
      );
    } catch (err) {
      if (isStaleAuthError(err)) return;
      if (isApiError(err)) {
        if (err.status === 409) {
          await handleVersionConflict(true);
          return;
        }
        setApiError(err);
      }
    } finally {
      setSavingName(false);
    }
  };

  const handleResetDefaultName = async () => {
    if (!record || savingName) return;
    setSavingName(true);
    setInlineError(null);
    setApiError(null);
    setConflictNotice(null);
    setSuccessNotice(null);

    try {
      const updated = await patchProfileDisplayName(kind, record.version, null);
      setDisplayNameInput("");
      await syncGlobalSession(updated);
      setSuccessNotice("已恢复默认显示名称，全站视图已同步刷新。");
    } catch (err) {
      if (isStaleAuthError(err)) return;
      if (isApiError(err)) {
        if (err.status === 409) {
          await handleVersionConflict(false);
          return;
        }
        setApiError(err);
      }
    } finally {
      setSavingName(false);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset input value so re-selecting same file triggers change again
    e.target.value = "";
    if (!file || !record || uploadingAvatar) return;

    const validationMsg = validateAvatarFile(file);
    if (validationMsg) {
      setInlineError(validationMsg);
      return;
    }

    setUploadingAvatar(true);
    setInlineError(null);
    setApiError(null);
    setConflictNotice(null);
    setSuccessNotice(null);

    try {
      const updated = await uploadProfileAvatar(kind, record.version, file);
      await syncGlobalSession(updated);
      setSuccessNotice("头像已上传并经服务端安全转码（≤256×256 PNG），全站已同步刷新。");
    } catch (err) {
      if (isStaleAuthError(err)) return;
      if (isApiError(err)) {
        if (err.status === 409) {
          await handleVersionConflict(true);
          return;
        }
        setApiError(err);
      } else {
        setInlineError("头像上传失败，请稍后重试。");
      }
    } finally {
      setUploadingAvatar(false);
    }
  };

  const handleDeleteAvatar = async () => {
    if (!record || !record.has_avatar || deletingAvatar) return;
    setDeletingAvatar(true);
    setInlineError(null);
    setApiError(null);
    setConflictNotice(null);
    setSuccessNotice(null);

    try {
      const updated = await deleteProfileAvatar(kind, record.version);
      await syncGlobalSession(updated);
      setSuccessNotice("已移除自定义头像，恢复为默认图形标识。");
    } catch (err) {
      if (isStaleAuthError(err)) return;
      if (isApiError(err)) {
        if (err.status === 409) {
          await handleVersionConflict(true);
          return;
        }
        setApiError(err);
      }
    } finally {
      setDeletingAvatar(false);
    }
  };

  const fallbackLabel = isAgent ? "个人业务助手" : actor?.subject || "员工";
  const effectiveName = record?.display_name || fallbackLabel;
  const avatarSrc = record?.has_avatar
    ? `${isAgent ? "/v1/agent-profile/avatar" : "/v1/profile/avatar"}?v=${currentAvatarVersion}&r=${record.version}`
    : null;

  return (
    <div
      data-testid={`${prefix}-settings-page`}
      className="min-h-full bg-[var(--bg-canvas)] px-4 py-6 sm:px-6"
    >
      <div className="mx-auto max-w-[720px] space-y-4">
        {/* Settings Sub-Navigation Tabs */}
        <div className="flex items-center gap-1 border-b border-[var(--hairline)]">
          <Link
            href="/settings/profile"
            aria-current={!isAgent ? "page" : undefined}
            className={[
              "inline-flex items-center gap-1.5 border-b-2 -mb-px px-3.5 py-2 text-[13px] font-medium transition-colors duration-[120ms]",
              !isAgent
                ? "border-[var(--accent)] text-[var(--ink-primary)]"
                : "border-transparent text-[var(--ink-muted)] hover:text-[var(--ink-primary)]",
            ].join(" ")}
          >
            <User className="h-3.5 w-3.5" strokeWidth={1.75} />
            <span>个人资料</span>
          </Link>
          <Link
            href="/settings/agent"
            aria-current={isAgent ? "page" : undefined}
            className={[
              "inline-flex items-center gap-1.5 border-b-2 -mb-px px-3.5 py-2 text-[13px] font-medium transition-colors duration-[120ms]",
              isAgent
                ? "border-[var(--accent)] text-[var(--ink-primary)]"
                : "border-transparent text-[var(--ink-muted)] hover:text-[var(--ink-primary)]",
            ].join(" ")}
          >
            <Bot className="h-3.5 w-3.5" strokeWidth={1.75} />
            <span>个人 Agent 资料</span>
          </Link>
        </div>

        {/* Main Profile Sheet */}
        <section className="rounded-[6px] border border-[var(--hairline)] bg-[var(--bg-sheet)]">
          {/* Header */}
          <div className="border-b border-[var(--hairline)] px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-[16px] font-semibold text-[var(--ink-primary)]">
                  {isAgent ? "个人 Agent 资料" : "个人员工资料"}
                </h2>
                <p className="mt-1 text-[12.5px] text-[var(--ink-muted)] leading-relaxed">
                  {isAgent
                    ? "此名称和头像仅用于您在会话列表置顶入口及个人助手对话头部，与您的个人员工资料相互独立。"
                    : "您的显示名称与头像将同步展示在工作台侧边栏及已加入协作房间的成员头部。"}
                </p>
              </div>
              {record && (
                <span
                  data-testid={`${prefix}-version-badge`}
                  className="rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-subtle)] px-2 py-0.5 font-mono-code text-[11px] text-[var(--ink-muted)]"
                >
                  version v{record.version}
                </span>
              )}
            </div>

            {/* Read-only Identity Context for Employee Profile */}
            {!isAgent && actor && (
              <dl className="mt-4 grid grid-cols-2 gap-2 rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] px-3.5 py-2.5 text-[12px] sm:grid-cols-4">
                <div>
                  <dt className="text-[11px] text-[var(--ink-muted)]">账号主体</dt>
                  <dd className="mt-0.5 font-mono-code font-semibold text-[var(--ink-primary)]">
                    {actor.subject}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] text-[var(--ink-muted)]">所属租户</dt>
                  <dd className="mt-0.5 font-mono-code text-[var(--ink-primary)]">
                    {actor.tenant}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] text-[var(--ink-muted)]">角色</dt>
                  <dd className="mt-0.5 text-[var(--ink-primary)]">
                    {formatRoleLabel(actor.role)}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] text-[var(--ink-muted)]">授权仓库</dt>
                  <dd className="mt-0.5 font-mono-code text-[var(--ink-primary)]">
                    {actor.warehouses.join(", ") || "无"}
                  </dd>
                </div>
              </dl>
            )}

            {/* Live Pinned-Row Preview for Agent Profile */}
            {isAgent && (
              <div className="mt-4 rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-plane)] p-3">
                <div className="mb-1.5 font-mono-code text-[10.5px] uppercase tracking-[0.04em] text-[var(--ink-muted)]">
                  会话列表置顶效果预览
                </div>
                <div className="flex items-center gap-2.5 rounded-[4px] border border-[var(--accent-border)] bg-[var(--bg-sheet)] px-2.5 py-2 max-w-[280px]">
                  <Avatar
                    src={avatarSrc}
                    name={effectiveName}
                    fallbackText="AG"
                    size="md"
                    kind="agent"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[13px] font-semibold text-[var(--ink-primary)]">
                        {displayNameInput.trim() || "个人业务助手"}
                      </span>
                      <span className="rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-subtle)] px-1.5 py-0.5 font-mono-code text-[10px] uppercase text-[var(--ink-secondary)] leading-none">
                        Agent
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-[var(--ink-muted)]">
                      自然语言指令 · 业务查询与草稿
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="divide-y divide-[var(--hairline)] px-5">
            {/* Feedback & Conflict Banners */}
            {(successNotice || conflictNotice || inlineError || apiError) && (
              <div className="py-4 space-y-2.5">
                {successNotice && (
                  <div
                    role="status"
                    data-testid={`${prefix}-save-success`}
                    className="flex items-center gap-2 rounded-[4px] border border-[var(--status-emerald-border)] bg-[var(--status-emerald-wash)] px-3 py-2 text-[12.5px] text-[var(--status-emerald)]"
                  >
                    <CheckCircle2 className="h-4 w-4 shrink-0" strokeWidth={1.75} />
                    <span>{successNotice}</span>
                  </div>
                )}

                {conflictNotice && (
                  <div
                    role="alert"
                    data-testid={`${prefix}-conflict-banner`}
                    className="flex items-center gap-2 rounded-[4px] border border-[var(--status-amber-border)] bg-[var(--status-amber-wash)] px-3 py-2 text-[12.5px] text-[var(--status-amber-ink)]"
                  >
                    <AlertTriangle className="h-4 w-4 shrink-0" strokeWidth={1.75} />
                    <span>{conflictNotice}</span>
                  </div>
                )}

                {inlineError && (
                  <div
                    role="alert"
                    data-testid={`${prefix}-inline-error`}
                    className="rounded-[4px] border border-[var(--status-crimson-border)] bg-[var(--status-crimson-wash)] px-3 py-2 text-[12.5px] text-[var(--status-crimson)]"
                  >
                    {inlineError}
                  </div>
                )}

                {apiError && <AccessNoticeCard error={apiError} />}
              </div>
            )}

            {/* Avatar Section */}
            <div className="py-5">
              <h3 className="text-[13.5px] font-semibold text-[var(--ink-primary)]">
                {isAgent ? "Agent 头像" : "个人头像"}
              </h3>
              <p className="mt-0.5 text-[12px] text-[var(--ink-muted)]">
                支持静态 PNG / JPEG / WEBP，大小不超过 2 MiB；服务端自动剥离元数据并缩放至 256×256 PNG。
              </p>

              <div className="mt-3.5 flex flex-wrap items-center gap-4">
                <Avatar
                  src={avatarSrc}
                  name={effectiveName}
                  fallbackText={isAgent ? "AG" : actor?.subject || "U"}
                  size="lg"
                  kind={isAgent ? "agent" : "user"}
                />

                <div className="flex flex-wrap items-center gap-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    data-testid={`${prefix}-avatar-input`}
                    onChange={(e) => void handleFileChange(e)}
                    className="sr-only"
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    loading={uploadingAvatar}
                    disabled={loading || !record || deletingAvatar}
                    data-testid={`${prefix}-avatar-upload-btn`}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Upload className="h-3.5 w-3.5" strokeWidth={1.75} />
                    <span>{uploadingAvatar ? "上传中…" : "上传新头像"}</span>
                  </Button>

                  <Button
                    type="button"
                    size="sm"
                    variant="danger"
                    loading={deletingAvatar}
                    disabled={
                      loading || !record?.has_avatar || uploadingAvatar
                    }
                    data-testid={`${prefix}-avatar-delete-btn`}
                    onClick={() => void handleDeleteAvatar()}
                  >
                    <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                    <span>移除头像</span>
                  </Button>
                </div>
              </div>
            </div>

            {/* Display Name Section */}
            <form
              onSubmit={(e) => void handleSaveName(e)}
              className="py-5 space-y-3"
            >
              <div>
                <label
                  htmlFor={`${prefix}-display-name`}
                  className="block text-[13.5px] font-semibold text-[var(--ink-primary)]"
                >
                  {isAgent ? "Agent 显示名称" : "显示名称"}
                </label>
                <p className="mt-0.5 text-[12px] text-[var(--ink-muted)]">
                  长度 1–80 个可打印字符；清空请点击“恢复默认名称”。
                </p>
                <input
                  id={`${prefix}-display-name`}
                  data-testid={`${prefix}-display-name-input`}
                  type="text"
                  maxLength={80}
                  value={displayNameInput}
                  onChange={(e) => {
                    setDisplayNameInput(e.target.value);
                    if (inlineError) setInlineError(null);
                  }}
                  placeholder={
                    isAgent
                      ? "默认：个人业务助手"
                      : `默认：${actor?.subject || "账号主体"}`
                  }
                  className="mt-2 h-9 w-full max-w-[420px] rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-3 text-[13.5px] text-[var(--ink-primary)] placeholder:text-[var(--ink-faint)] focus:border-[var(--accent)] focus:outline-none"
                />
              </div>

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  loading={savingName}
                  disabled={loading || !record || savingName}
                  data-testid={`${prefix}-save-btn`}
                  className="h-9 px-4"
                >
                  {savingName ? "保存中…" : "保存名称"}
                </Button>

                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={
                    loading ||
                    !record ||
                    savingName ||
                    record.display_name === null
                  }
                  data-testid={`${prefix}-reset-name-btn`}
                  onClick={() => void handleResetDefaultName()}
                  className="h-9"
                >
                  <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.75} />
                  <span>恢复默认名称</span>
                </Button>
              </div>
            </form>
          </div>
        </section>
      </div>
    </div>
  );
}
