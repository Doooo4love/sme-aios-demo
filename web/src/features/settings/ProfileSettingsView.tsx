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
import { sortWarehouses } from "@/lib/format";
import { useLocale } from "@/lib/i18n";
import { useSession } from "@/lib/session-context";
import { Interactive3DCard } from "@/components/kinetic";
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
  const { locale, t, tx, localizeRole } = useLocale();

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
          tx(
            {
              "zh-CN": "资料版本已在其他会话中更新，已同步最新版本 v{ver}，请核对后重新保存。",
              "zh-HK": "資料版本已於其他工作階段更新，已同步最新版本 v{ver}，請核對後再儲存。",
              en: "Profile was updated elsewhere. Reloaded latest version v{ver} — review and save again.",
            },
            { ver: latest.version },
          ),
        );
      } else {
        setConflictNotice(
          tx({
            "zh-CN": "资料版本已变更，请刷新页面后重新保存。",
            "zh-HK": "資料版本已變更，請重新整理頁面後再儲存。",
            en: "Profile version changed. Reload the page before saving.",
          }),
        );
      }
    },
    [loadLatestProfile, tx],
  );

  const handleSaveName = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!record || savingName) return;
    const trimmed = displayNameInput.trim();
    if (!trimmed) {
      setInlineError(
        tx({
          "zh-CN": "请输入显示名称，或点击“恢复默认名称”清除自定义名称。",
          "zh-HK": "請輸入顯示名稱，或點擊「恢復預設名稱」清除自訂名稱。",
          en: "Enter a display name, or click Reset to Default to clear your custom name.",
        }),
      );
      return;
    }
    if (trimmed.length > 80) {
      setInlineError(
        tx({
          "zh-CN": "显示名称不能超过 80 个字符。",
          "zh-HK": "顯示名稱不能超過 80 個字元。",
          en: "Display name cannot exceed 80 characters.",
        }),
      );
      return;
    }

    setSavingName(true);
    setInlineError(null);
    setApiError(null);
    setConflictNotice(null);
    setSuccessNotice(null);

    try {
      const updated = await patchProfileDisplayName(
        kind,
        record.version,
        trimmed,
      );
      setDisplayNameInput(updated.display_name ?? "");
      await syncGlobalSession(updated);
      setSuccessNotice(
        isAgent
          ? tx(
              {
                "zh-CN": "个人 Agent 名称已更新为“{name}”，会话置顶入口与对话头部已同步生效。",
                "zh-HK": "個人 Agent 名稱已更新為「{name}」，對話釘選入口與標頭已同步生效。",
                en: "Personal Agent name updated to “{name}” across sidebar and chat header.",
              },
              { name: updated.display_name ?? "" },
            )
          : tx(
              {
                "zh-CN": "个人显示名称已更新为“{name}”，全站视图已同步生效。",
                "zh-HK": "個人顯示名稱已更新為「{name}」，全站檢視已同步生效。",
                en: "Display name updated to “{name}” across the workspace.",
              },
              { name: updated.display_name ?? "" },
            ),
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
      setSuccessNotice(
        tx({
          "zh-CN": "已恢复默认显示名称，全站视图已同步刷新。",
          "zh-HK": "已恢復預設顯示名稱，全站檢視已同步重新整理。",
          en: "Restored default display name across the workspace.",
        }),
      );
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
    e.target.value = "";
    if (!file || !record || uploadingAvatar) return;

    const validationMsg = validateAvatarFile(file, locale);
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
      setSuccessNotice(
        tx({
          "zh-CN": "头像已上传并经服务端安全转码（≤256×256 PNG），全站已同步刷新。",
          "zh-HK": "頭像已上傳並經伺服器安全轉碼（≤256×256 PNG），全站已同步重新整理。",
          en: "Avatar uploaded and transcoded safely (≤256×256 PNG) across the workspace.",
        }),
      );
    } catch (err) {
      if (isStaleAuthError(err)) return;
      if (isApiError(err)) {
        if (err.status === 409) {
          await handleVersionConflict(true);
          return;
        }
        setApiError(err);
      } else {
        setInlineError(
          tx({
            "zh-CN": "头像上传失败，请稍后重试。",
            "zh-HK": "頭像上傳失敗，請稍後重試。",
            en: "Failed to upload avatar. Please try again.",
          }),
        );
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
      setSuccessNotice(
        tx({
          "zh-CN": "已移除自定义头像，恢复为默认图形标识。",
          "zh-HK": "已移除自訂頭像，恢復為預設圖形標誌。",
          en: "Custom avatar removed; restored default monogram.",
        }),
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
      setDeletingAvatar(false);
    }
  };

  const defaultAgentName = t("brand.defaultAgentName");
  const fallbackLabel = isAgent
    ? defaultAgentName
    : actor?.subject || tx({ "zh-CN": "员工", "zh-HK": "員工", en: "Employee" });
  const effectiveName = record?.display_name || fallbackLabel;
  const liveAgentPreviewName = displayNameInput.trim() || defaultAgentName;
  const showPreviewAgentSuffix = !liveAgentPreviewName
    .toLowerCase()
    .includes("agent");
  const avatarSrc = record?.has_avatar
    ? `${isAgent ? "/v1/agent-profile/avatar" : "/v1/profile/avatar"}?v=${currentAvatarVersion}&r=${record.version}`
    : null;

  return (
    <div
      data-testid={`${prefix}-settings-page`}
      className="min-h-full bg-[var(--bg-app)] px-4 py-8 sm:px-6"
    >
      <div className="mx-auto max-w-[740px] space-y-5">
        {/* Clean Pill Sub-Navigation Switcher */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex rounded-full bg-[var(--bg-surface)] p-1 shadow-[var(--shadow-subtle)]">
            <Link
              href="/settings/profile"
              aria-current={!isAgent ? "page" : undefined}
              className={[
                "inline-flex h-8 items-center gap-1.5 rounded-full px-4 text-[13px] font-medium transition-all duration-[150ms]",
                !isAgent
                  ? "bg-[var(--accent-solid)] text-[var(--accent-fg)] shadow-[var(--shadow-subtle)]"
                  : "text-[var(--ink-secondary)] hover:text-[var(--ink-primary)]",
              ].join(" ")}
            >
              <User className="h-3.5 w-3.5" strokeWidth={1.85} />
              <span>{t("shell.menu.profile")}</span>
            </Link>
            <Link
              href="/settings/agent"
              aria-current={isAgent ? "page" : undefined}
              className={[
                "inline-flex h-8 items-center gap-1.5 rounded-full px-4 text-[13px] font-medium transition-all duration-[150ms]",
                isAgent
                  ? "bg-[var(--accent-solid)] text-[var(--accent-fg)] shadow-[var(--shadow-subtle)]"
                  : "text-[var(--ink-secondary)] hover:text-[var(--ink-primary)]",
              ].join(" ")}
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
          </div>

          {record && (
            <span
              data-testid={`${prefix}-version-badge`}
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

        {/* Main Porcelain / Obsidian Sheet */}
        <section className="overflow-hidden rounded-card border border-[var(--hairline)] bg-[var(--bg-surface)] shadow-[var(--shadow-card)]">
          {/* Header Section */}
          <div className="border-b border-[var(--hairline)] px-6 py-5">
            <h2 className="aios-display text-[18px] font-semibold text-[var(--ink-primary)]">
              {isAgent
                ? tx({
                    "zh-CN": "个人 Agent 助手设定",
                    "zh-HK": "個人 Agent 助手設定",
                    en: "Personal Agent Settings",
                  })
                : tx({
                    "zh-CN": "个人员工资料",
                    "zh-HK": "個人員工資料",
                    en: "Employee Profile",
                  })}
            </h2>
            <p className="mt-1 text-[13px] leading-relaxed text-[var(--ink-muted)]">
              {isAgent
                ? tx({
                    "zh-CN": "自定义您的专属工作助手名称与圆形头像，将实时同步至消息侧边栏置顶入口与对话头部。",
                    "zh-HK": "自訂您的專屬工作助手名稱與圓形頭像，將即時同步至訊息側邊欄釘選入口與對話標頭。",
                    en: "Customize your personal agent's display name and avatar across the sidebar and chat header.",
                  })
                : tx({
                    "zh-CN": "您的显示名称与圆形头像将同步展示在消息通讯录、会话成员与顶部账号菜单。",
                    "zh-HK": "您的顯示名稱與圓形頭像將同步顯示於訊息聯絡人、對話成員與頂部帳號選單。",
                    en: "Your display name and avatar appear across the company directory, chat rooms, and account menu.",
                  })}
            </p>

            {/* Read-only Identity Context for Employee Profile */}
            {!isAgent && actor && (
              <dl className="mt-4 grid grid-cols-2 gap-3 rounded-tile bg-[var(--bg-surface-tint)] px-4 py-3 text-[12.5px] sm:grid-cols-4">
                <div>
                  <dt className="text-[11px] text-[var(--ink-muted)]">
                    {tx({
                      "zh-CN": "账号主体",
                      "zh-HK": "帳號主體",
                      en: "Account",
                    })}
                  </dt>
                  <dd className="mt-0.5 font-mono-code font-semibold text-[var(--ink-primary)]">
                    {actor.subject}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] text-[var(--ink-muted)]">
                    {tx({
                      "zh-CN": "所属企业",
                      "zh-HK": "所屬企業",
                      en: "Tenant",
                    })}
                  </dt>
                  <dd className="mt-0.5 font-mono-code text-[var(--ink-primary)]">
                    {actor.tenant}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] text-[var(--ink-muted)]">
                    {tx({ "zh-CN": "角色", "zh-HK": "角色", en: "Role" })}
                  </dt>
                  <dd className="mt-0.5 font-medium text-[var(--ink-primary)]">
                    {localizeRole(actor.role)}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] text-[var(--ink-muted)]">
                    {tx({
                      "zh-CN": "授权仓库",
                      "zh-HK": "授權倉庫",
                      en: "Warehouses",
                    })}
                  </dt>
                  <dd className="mt-0.5 text-[var(--ink-primary)]">
                    {actor.warehouses.length > 0 ? (
                      <span className="font-mono-code">
                        {sortWarehouses(actor.warehouses).join(" / ")}
                      </span>
                    ) : (
                      <span>
                        {tx({ "zh-CN": "无", "zh-HK": "無", en: "None" })}
                      </span>
                    )}
                  </dd>
                </div>
              </dl>
            )}

            {/* Live Interactive 3D Pinned Agent Sidebar Tile Preview */}
            {isAgent && (
              <div className="mt-4 rounded-tile bg-[var(--bg-surface-tint)] p-4">
                <div className="mb-2.5 text-[11.5px] font-medium text-[var(--ink-muted)]">
                  {tx({
                    "zh-CN": "消息侧边栏置顶卡片实时预览",
                    "zh-HK": "訊息側邊欄釘選卡片即時預覽",
                    en: "Pinned Sidebar Card Live Preview",
                  })}
                </div>
                <Interactive3DCard
                  maxTilt={2}
                  hoverLiftPx={-1}
                  sheenIntensity="subtle"
                  className="max-w-[296px] rounded-tile bg-[var(--bg-surface)] px-3 py-2.5 shadow-[var(--shadow-card)] ring-1 ring-[var(--accent-border)]"
                >
                  <div className="relative z-[3] flex items-center gap-3">
                    <span className="relative inline-flex shrink-0">
                      <Avatar
                        src={avatarSrc}
                        name={liveAgentPreviewName}
                        fallbackText="AG"
                        size="md"
                        kind="agent"
                      />
                      <span
                        aria-hidden="true"
                        className="absolute right-0 bottom-0 h-2.5 w-2.5 rounded-full bg-[var(--accent-solid)] ring-2 ring-[var(--bg-surface)]"
                      />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-1.5 min-w-0">
                        <span className="truncate text-[13.5px] font-semibold text-[var(--ink-primary)]">
                          {liveAgentPreviewName}
                        </span>
                        {showPreviewAgentSuffix && (
                          <span className="shrink-0 text-[11px] font-normal text-[var(--ink-muted)]">
                            Agent
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 truncate text-[12px] text-[var(--ink-muted)]">
                        {tx({
                          "zh-CN": "随时为你查询与起草",
                          "zh-HK": "隨時為你查詢與起草",
                          en: "Ready to query, draft & book",
                        })}
                      </p>
                    </div>
                  </div>
                </Interactive3DCard>
              </div>
            )}
          </div>

          <div className="divide-y divide-[var(--hairline-subtle)] px-6">
            {/* Feedback & Conflict Banners */}
            {(successNotice || conflictNotice || inlineError || apiError) && (
              <div className="py-4 space-y-2.5">
                {successNotice && (
                  <div
                    role="status"
                    data-testid={`${prefix}-save-success`}
                    className="flex items-center gap-2 rounded-sm bg-[var(--status-emerald-wash)] px-3.5 py-2.5 text-[12.5px] text-[var(--status-emerald)]"
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
                    data-testid={`${prefix}-conflict-banner`}
                    className="flex items-center gap-2 rounded-sm bg-[var(--status-amber-wash)] px-3.5 py-2.5 text-[12.5px] text-[var(--status-amber-ink)]"
                  >
                    <AlertTriangle
                      className="h-4 w-4 shrink-0"
                      strokeWidth={1.9}
                    />
                    <span>{conflictNotice}</span>
                  </div>
                )}

                {inlineError && (
                  <div
                    role="alert"
                    data-testid={`${prefix}-inline-error`}
                    className="rounded-sm bg-[var(--status-crimson-wash)] px-3.5 py-2.5 text-[12.5px] text-[var(--status-crimson)]"
                  >
                    {inlineError}
                  </div>
                )}

                {apiError && <AccessNoticeCard error={apiError} />}
              </div>
            )}

            {/* Circular Avatar Crop Preview & Upload */}
            <div className="py-6">
              <h3 className="text-[14px] font-semibold text-[var(--ink-primary)]">
                {isAgent
                  ? tx({
                      "zh-CN": "助手圆形头像",
                      "zh-HK": "助手圓形頭像",
                      en: "Agent Avatar",
                    })
                  : tx({
                      "zh-CN": "个人圆形头像",
                      "zh-HK": "個人圓形頭像",
                      en: "Profile Avatar",
                    })}
              </h3>
              <p className="mt-1 text-[12.5px] text-[var(--ink-muted)]">
                {tx({
                  "zh-CN": "支持静态 PNG / JPEG / WEBP（≤2 MiB）；服务端自动居中裁剪、剥离元数据并安全转码为 256×256 PNG。",
                  "zh-HK": "支援靜態 PNG / JPEG / WEBP（≤2 MiB）；伺服器自動置中裁切、移除中繼資料並安全轉碼為 256×256 PNG。",
                  en: "Supports static PNG, JPEG, or WEBP (≤2 MiB); automatically center-cropped, stripped of metadata, and transcoded to 256×256 PNG.",
                })}
              </p>

              <div className="mt-4 flex flex-wrap items-center gap-5">
                <div className="rounded-full p-1 bg-[var(--bg-surface-tint)] shadow-[var(--shadow-subtle)]">
                  <Avatar
                    src={avatarSrc}
                    name={effectiveName}
                    fallbackText={isAgent ? "AG" : actor?.subject || "U"}
                    size="xl"
                    kind={isAgent ? "agent" : "user"}
                    status="online"
                  />
                </div>

                <div className="flex flex-wrap items-center gap-2.5">
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
                    pill
                    loading={uploadingAvatar}
                    disabled={loading || !record || deletingAvatar}
                    data-testid={`${prefix}-avatar-upload-btn`}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Upload className="h-3.5 w-3.5" strokeWidth={1.85} />
                    <span>
                      {uploadingAvatar
                        ? tx({
                            "zh-CN": "上传中…",
                            "zh-HK": "上傳中…",
                            en: "Uploading…",
                          })
                        : t("settings.uploadAvatar")}
                    </span>
                  </Button>

                  <Button
                    type="button"
                    size="sm"
                    variant="danger"
                    pill
                    loading={deletingAvatar}
                    disabled={
                      loading || !record?.has_avatar || uploadingAvatar
                    }
                    data-testid={`${prefix}-avatar-delete-btn`}
                    onClick={() => void handleDeleteAvatar()}
                  >
                    <Trash2 className="h-3.5 w-3.5" strokeWidth={1.85} />
                    <span>{t("settings.removeAvatar")}</span>
                  </Button>
                </div>
              </div>
            </div>

            {/* Display Name Section */}
            <form
              onSubmit={(e) => void handleSaveName(e)}
              className="py-6 space-y-4"
            >
              <div>
                <label
                  htmlFor={`${prefix}-display-name`}
                  className="block text-[14px] font-semibold text-[var(--ink-primary)]"
                >
                  {isAgent
                    ? tx({
                        "zh-CN": "助手显示名称",
                        "zh-HK": "助手顯示名稱",
                        en: "Agent Display Name",
                      })
                    : tx({
                        "zh-CN": "个人显示名称",
                        "zh-HK": "個人顯示名稱",
                        en: "Display Name",
                      })}
                </label>
                <p className="mt-1 text-[12.5px] text-[var(--ink-muted)]">
                  {tx({
                    "zh-CN": "长度 1–80 个可打印字符；如需恢复默认请点击右侧“恢复默认名称”。",
                    "zh-HK": "長度 1–80 個可列印字元；如需恢復預設請點擊右側「恢復預設名稱」。",
                    en: "1–80 printable characters; click Reset to Default to restore the default name.",
                  })}
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
                      ? tx(
                          {
                            "zh-CN": "默认：{name}",
                            "zh-HK": "預設：{name}",
                            en: "Default: {name}",
                          },
                          { name: defaultAgentName },
                        )
                      : tx(
                          {
                            "zh-CN": "默认：{name}",
                            "zh-HK": "預設：{name}",
                            en: "Default: {name}",
                          },
                          {
                            name:
                              actor?.subject ||
                              tx({
                                "zh-CN": "账号主体",
                                "zh-HK": "帳號主體",
                                en: "Account",
                              }),
                          },
                        )
                  }
                  className="mt-2.5 h-10 w-full max-w-[420px] rounded-sm bg-[var(--bg-surface-tint)] px-3.5 text-[14px] text-[var(--ink-primary)] placeholder:text-[var(--ink-faint)] ring-1 ring-[var(--hairline-strong)] focus:bg-[var(--bg-surface)] focus:ring-[1.5px] focus:ring-[var(--accent)] focus:outline-none transition-all"
                />
              </div>

              <div className="flex flex-wrap items-center gap-2.5 pt-1">
                <Button
                  type="submit"
                  variant="primary"
                  size="md"
                  pill
                  loading={savingName}
                  disabled={loading || !record || savingName}
                  data-testid={`${prefix}-save-btn`}
                  className="px-5"
                >
                  {savingName
                    ? tx({
                        "zh-CN": "保存中…",
                        "zh-HK": "儲存中…",
                        en: "Saving…",
                      })
                    : tx({
                        "zh-CN": "保存名称",
                        "zh-HK": "儲存名稱",
                        en: "Save Name",
                      })}
                </Button>

                <Button
                  type="button"
                  variant="secondary"
                  size="md"
                  pill
                  disabled={
                    loading ||
                    !record ||
                    savingName ||
                    record.display_name === null
                  }
                  data-testid={`${prefix}-reset-name-btn`}
                  onClick={() => void handleResetDefaultName()}
                >
                  <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.85} />
                  <span>
                    {tx({
                      "zh-CN": "恢复默认名称",
                      "zh-HK": "恢復預設名稱",
                      en: "Reset to Default",
                    })}
                  </span>
                </Button>
              </div>
            </form>
          </div>
        </section>
      </div>
    </div>
  );
}
