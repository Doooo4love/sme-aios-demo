"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  BookOpen,
  Building2,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Hash,
  Lock,
  Mail,
  MapPin,
  Phone,
  Settings2,
  ShieldCheck,
  Users,
  Video,
  Warehouse,
} from "lucide-react";
import {
  fetchCompanyContacts,
  getAuthGeneration,
  isStaleAuthError,
  onAuthReset,
} from "@/lib/api-client";
import { sortWarehouses } from "@/lib/format";
import {
  PERSONA_LOCALIZATIONS,
  localizeContactDepartment,
  localizeContactJobTitle,
  useLocale,
} from "@/lib/i18n";
import { useSession } from "@/lib/session-context";
import { Avatar, type AvatarStatus } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { getRoomMemberAvatarUrl } from "@/features/chat/api";
import type { CompanyContact, Profile } from "@/lib/types";

interface DirectoryCacheState {
  generation: number;
  items: CompanyContact[] | null;
  inFlight: Promise<CompanyContact[]> | null;
}

let directoryCache: DirectoryCacheState = {
  generation: getAuthGeneration(),
  items: null,
  inFlight: null,
};

onAuthReset((_reason, nextGen) => {
  directoryCache = {
    generation: nextGen,
    items: null,
    inFlight: null,
  };
});

export async function loadDirectoryContactsCached(
  expectedGen: number,
): Promise<CompanyContact[]> {
  if (expectedGen !== getAuthGeneration()) return [];
  if (
    directoryCache.generation === expectedGen &&
    directoryCache.items !== null
  ) {
    return directoryCache.items;
  }
  if (
    directoryCache.generation === expectedGen &&
    directoryCache.inFlight !== null
  ) {
    return directoryCache.inFlight;
  }

  const reqGen = expectedGen;
  const promise = fetchCompanyContacts(undefined, {
    includeSelf: true,
    limit: 100,
  })
    .then((res) => {
      const items = res.items ?? [];
      if (reqGen === getAuthGeneration()) {
        directoryCache = {
          generation: reqGen,
          items,
          inFlight: null,
        };
      }
      return items;
    })
    .catch((err) => {
      if (reqGen === getAuthGeneration()) {
        directoryCache = {
          generation: reqGen,
          items: null,
          inFlight: null,
        };
      }
      if (isStaleAuthError(err)) return [];
      return [];
    });

  directoryCache = {
    generation: reqGen,
    items: null,
    inFlight: promise,
  };
  return promise;
}

export function mapContactAvailabilityToAvatarStatus(
  availability?: string | null,
): AvatarStatus | undefined {
  if (availability === "online") return "online";
  if (availability === "busy" || availability === "away") return "busy";
  if (availability === "offline") return "offline";
  return undefined;
}

export type ContactProfileDialogTarget =
  | {
      kind: "colleague";
      subject: string;
      displayName?: string;
      avatarSrc?: string | null;
    }
  | {
      kind: "group";
      roomId: string;
      roomTitle: string;
      roomOwner?: string | null;
      members: string[];
      memberProfiles: Record<string, Profile>;
    }
  | {
      kind: "agent";
      displayName: string;
      avatarSrc?: string | null;
    };

export interface ContactProfileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: ContactProfileDialogTarget | null;
  onSendEmail?: (info: {
    subject: string;
    email: string;
    displayName: string;
  }) => void;
  onScheduleMeeting?: (subject?: string) => void;
  onViewMembers?: () => void;
}

export function ContactProfileDialog({
  open,
  onOpenChange,
  target,
  onSendEmail,
  onScheduleMeeting,
  onViewMembers,
}: ContactProfileDialogProps) {
  const { actor, capabilities, authGeneration } = useSession();
  const { locale, t, tx, tp, localizePersona, localizeRole, localizeTool } =
    useLocale();

  const [contacts, setContacts] = useState<CompanyContact[]>([]);
  const [loadingDirectory, setLoadingDirectory] = useState(false);
  const [copiedField, setCopiedField] = useState<"phone" | "email" | null>(
    null,
  );
  const [inspectedGroupMember, setInspectedGroupMember] = useState<
    string | null
  >(null);

  useEffect(() => {
    setInspectedGroupMember(null);
    setCopiedField(null);
  }, [open, target]);

  const needsDirectory =
    open &&
    target !== null &&
    (target.kind === "colleague" || target.kind === "group");

  useEffect(() => {
    if (!needsDirectory) return;
    let cancelled = false;
    const expectedGen = authGeneration;
    setLoadingDirectory(true);
    void loadDirectoryContactsCached(expectedGen).then((items) => {
      if (cancelled || expectedGen !== getAuthGeneration()) return;
      setContacts(items);
      setLoadingDirectory(false);
    });
    return () => {
      cancelled = true;
    };
  }, [needsDirectory, authGeneration]);

  const handleCopy = async (field: "phone" | "email", value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedField(field);
      window.setTimeout(() => setCopiedField(null), 1800);
    } catch {
      // ignore clipboard restriction
    }
  };

  const activeColleagueSubject = useMemo(() => {
    if (!target) return null;
    if (target.kind === "colleague") return target.subject;
    if (target.kind === "group" && inspectedGroupMember) {
      return inspectedGroupMember;
    }
    return null;
  }, [target, inspectedGroupMember]);

  const contactBySubject = useMemo(() => {
    const map = new Map<string, CompanyContact>();
    for (const c of contacts) {
      map.set(c.subject, c);
    }
    return map;
  }, [contacts]);

  const resolvedColleague = useMemo(() => {
    if (!activeColleagueSubject) return null;
    const dir = contactBySubject.get(activeColleagueSubject);
    const known =
      PERSONA_LOCALIZATIONS[
        activeColleagueSubject as keyof typeof PERSONA_LOCALIZATIONS
      ];
    const persona = localizePersona(activeColleagueSubject, {
      display_name: dir?.display_name,
      label: dir?.job_title,
      department: dir?.department,
    });
    const rawName =
      dir?.display_name ||
      (target?.kind === "colleague" ? target.displayName : undefined);
    const isCustomName =
      Boolean(rawName) &&
      rawName !== activeColleagueSubject &&
      (!known ||
        (rawName !== known["zh-CN"].displayName &&
          rawName !== known["zh-HK"].displayName &&
          rawName !== known.en.displayName));

    const displayName = isCustomName
      ? (rawName as string)
      : persona.displayName;
    const jobTitle = dir?.job_title
      ? localizeContactJobTitle(dir.job_title, activeColleagueSubject, locale)
      : known
        ? persona.label
        : localizeRole(dir?.role || "");
    const department = dir?.department
      ? localizeContactDepartment(
          dir.department,
          activeColleagueSubject,
          locale,
        )
      : known
        ? persona.department
        : "";
    const warehouses = dir?.warehouses ?? [];
    const email = dir?.email || "";
    const phone = dir?.phone || "";
    const ext = dir?.ext || "";
    const office = dir?.office || "";
    const avatarStatus = mapContactAvailabilityToAvatarStatus(dir?.availability);

    let avatarSrc: string | null = dir?.avatar_url ?? null;
    if (!avatarSrc && target?.kind === "colleague" && target.avatarSrc) {
      avatarSrc = target.avatarSrc;
    } else if (!avatarSrc && target?.kind === "group") {
      const prof = target.memberProfiles[activeColleagueSubject];
      if (prof?.has_avatar) {
        avatarSrc = getRoomMemberAvatarUrl(
          target.roomId,
          activeColleagueSubject,
          prof.version,
          authGeneration,
        );
      }
    }

    return {
      subject: activeColleagueSubject,
      displayName,
      jobTitle,
      department,
      role: dir?.role || "",
      warehouses: sortWarehouses(warehouses),
      email,
      phone,
      ext,
      office,
      avatarSrc,
      avatarStatus,
    };
  }, [
    activeColleagueSubject,
    authGeneration,
    contactBySubject,
    locale,
    localizePersona,
    localizeRole,
    target,
  ]);

  const modalTitle = !target
    ? ""
    : target.kind === "agent"
      ? tx({
          "zh-CN": "个人业务助手信息",
          "zh-HK": "個人業務助手資訊",
          en: "Personal Agent Profile",
        })
      : activeColleagueSubject
        ? tx({
            "zh-CN": "同事名片与协作资料",
            "zh-HK": "同事名片與協作資料",
            en: "Colleague Profile",
          })
        : tx({
            "zh-CN": "协作群组概览",
            "zh-HK": "協作群組概覽",
            en: "Conversation Details",
          });

  const authorizedToolNames = useMemo(() => {
    const tools = (capabilities?.tools ?? []).filter((tool) => tool.available);
    return tools.map((tool) => localizeTool(tool.id));
  }, [capabilities, localizeTool]);

  return (
    <Modal
      open={open && target !== null}
      onOpenChange={onOpenChange}
      title={modalTitle}
      size="sm"
    >
      {target?.kind === "agent" && (
        <div
          data-testid="contact-profile-dialog-agent"
          className="space-y-4"
        >
          <div className="flex flex-col items-center text-center">
            <Avatar
              src={target.avatarSrc}
              name={target.displayName}
              fallbackText="AG"
              size="xl"
              kind="agent"
              status="online"
              className="shadow-[var(--shadow-card)]"
            />
            <h3 className="mt-3 text-[17px] font-semibold tracking-[-0.015em] text-[var(--ink-primary)]">
              {target.displayName}
            </h3>
            <p className="mt-1 max-w-[320px] text-[12.5px] leading-relaxed text-[var(--ink-secondary)]">
              {tx({
                "zh-CN":
                  "受类型化业务工具与实时权限交集约束，为您提供查询、提案草拟、受控邮件与会议日程协助。",
                "zh-HK":
                  "受型別化業務工具與即時權限交集約束，為您提供查詢、提案草擬、受控電郵與會議行程協助。",
                en: "Scoped by typed tools and live permission intersections for lookups, proposal drafts, governed mail, and scheduling.",
              })}
            </p>
          </div>

          <dl className="divide-y divide-[var(--hairline-subtle)] rounded-tile border border-[var(--hairline)] bg-[var(--bg-surface-tint)] text-[12.5px]">
            <div className="flex items-center justify-between gap-3 px-3.5 py-2.5">
              <dt className="flex items-center gap-1.5 text-[var(--ink-muted)]">
                <Building2 className="h-3.5 w-3.5" />
                <span>
                  {tx({ "zh-CN": "所属租户", "zh-HK": "所屬租戶", en: "Tenant" })}
                </span>
              </dt>
              <dd className="font-mono-code font-medium text-[var(--ink-primary)]">
                {actor?.tenant || "—"}
              </dd>
            </div>

            <div className="flex items-center justify-between gap-3 px-3.5 py-2.5">
              <dt className="flex items-center gap-1.5 text-[var(--ink-muted)]">
                <Warehouse className="h-3.5 w-3.5" />
                <span>
                  {tx({
                    "zh-CN": "授权仓库范围",
                    "zh-HK": "授權倉庫範圍",
                    en: "Warehouse Scope",
                  })}
                </span>
              </dt>
              <dd className="font-mono-code font-medium text-[var(--ink-primary)]">
                {actor?.warehouses.length
                  ? sortWarehouses(actor.warehouses).join(" / ")
                  : t("shell.noWarehouse")}
              </dd>
            </div>

            <div className="px-3.5 py-2.5 space-y-1.5">
              <dt className="text-[var(--ink-muted)]">
                {tx({
                  "zh-CN": "当前可用业务域",
                  "zh-HK": "目前可用業務域",
                  en: "Active Capability Domains",
                })}
              </dt>
              <dd className="flex flex-wrap gap-1.5">
                {authorizedToolNames.length > 0 ? (
                  authorizedToolNames.map((name) => (
                    <span
                      key={name}
                      className="rounded-xs border border-[var(--hairline)] bg-[var(--bg-surface)] px-2 py-0.5 text-[11px] font-medium text-[var(--ink-secondary)]"
                    >
                      {name}
                    </span>
                  ))
                ) : (
                  <span className="text-[11.5px] text-[var(--ink-muted)]">
                    {tx({
                      "zh-CN": "基础日常对话与日程预约",
                      "zh-HK": "基礎日常對話與行程預約",
                      en: "General collaboration & scheduling",
                    })}
                  </span>
                )}
              </dd>
            </div>
          </dl>

          {/* Sealed Policy Integrity Badge — ZERO prompt or SOUL.md disclosure */}
          <div
            data-testid="agent-sealed-policy-badge"
            className="flex items-start gap-2.5 rounded-tile border border-[var(--status-emerald-border)] bg-[var(--status-emerald-wash)] px-3.5 py-3 text-[12px]"
          >
            <ShieldCheck
              className="mt-0.5 h-4 w-4 shrink-0 text-[var(--status-emerald)]"
              strokeWidth={2}
            />
            <div className="min-w-0 space-y-0.5">
              <div className="flex items-center gap-1.5 font-semibold text-[var(--ink-primary)]">
                <Lock className="h-3 w-3 text-[var(--status-emerald)]" />
                <span>
                  {tx({
                    "zh-CN": "核心策略已密封保护",
                    "zh-HK": "核心策略已密封保護",
                    en: "Sealed Policy Integrity Verified",
                  })}
                </span>
              </div>
              <p className="text-[11.5px] leading-relaxed text-[var(--ink-secondary)]">
                {tx({
                  "zh-CN":
                    "助手行为规范与安全边界由 Theodic 核心团队签名密封维护，任何租户用户或对话模型均不可读取或篡改。",
                  "zh-HK":
                    "助手行為規範與安全邊界由 Theodic 核心團隊簽章密封維護，任何租戶用戶或對話模型均不可讀取或篡改。",
                  en: "Behavior boundaries are cryptographically sealed by the Theodic Core Team and cannot be inspected or altered by tenants or models.",
                })}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
            <Link
              href="/settings/memory"
              data-testid="contact-dialog-edit-memory"
              onClick={() => onOpenChange(false)}
              className="inline-flex h-8 items-center gap-1.5 rounded-full border border-[var(--hairline)] bg-[var(--bg-surface-subtle)] px-3.5 text-[12px] font-medium text-[var(--ink-secondary)] hover:border-[var(--hairline-strong)] hover:text-[var(--ink-primary)] transition-colors"
            >
              <BookOpen className="h-3.5 w-3.5 text-[var(--ink-muted)]" />
              <span>
                {tx({
                  "zh-CN": "查看/编辑 MEMORY.md",
                  "zh-HK": "查看/編輯 MEMORY.md",
                  en: "Edit MEMORY.md",
                })}
              </span>
            </Link>
            <Link
              href="/settings/agent"
              onClick={() => onOpenChange(false)}
              className="inline-flex h-8 items-center gap-1.5 rounded-full border border-[var(--hairline-strong)] bg-[var(--bg-surface)] px-3.5 text-[12px] font-medium text-[var(--ink-primary)] hover:border-[var(--accent-border)] hover:text-[var(--accent-ink)] transition-colors"
            >
              <Settings2 className="h-3.5 w-3.5 text-[var(--accent)]" />
              <span>
                {tx({
                  "zh-CN": "编辑助手名称与头像",
                  "zh-HK": "編輯助手名稱與頭像",
                  en: "Customize Agent Profile",
                })}
              </span>
            </Link>
          </div>
        </div>
      )}

      {target?.kind === "group" && !activeColleagueSubject && (
        <div
          data-testid="contact-profile-dialog-group"
          className="space-y-4"
        >
          <div className="flex flex-col items-center text-center">
            <Avatar
              name={target.roomTitle}
              fallbackText={target.roomOwner || "RM"}
              size="xl"
              className="shadow-[var(--shadow-card)]"
            />
            <h3 className="mt-3 text-[17px] font-semibold tracking-[-0.015em] text-[var(--ink-primary)]">
              {target.roomTitle}
            </h3>
            <p className="mt-1 text-[12px] text-[var(--ink-muted)]">
              {tp(
                {
                  "zh-CN": "{count} 位同租户成员",
                  "zh-HK": "{count} 位同租戶成員",
                  en: {
                    one: "{count} tenant member",
                    other: "{count} tenant members",
                  },
                },
                target.members.length,
              )}
            </p>
          </div>

          <div className="space-y-1.5">
            <div className="aios-micro-label px-1">
              {tx({
                "zh-CN": "点击同事查看完整名片",
                "zh-HK": "點擊同事檢視完整名片",
                en: "Select a colleague to view details",
              })}
            </div>
            <ul className="max-h-[240px] divide-y divide-[var(--hairline-subtle)] overflow-y-auto rounded-tile border border-[var(--hairline)] bg-[var(--bg-surface-tint)]">
              {target.members.map((sub) => {
                const dir = contactBySubject.get(sub);
                const prof = target.memberProfiles[sub];
                const known =
                  PERSONA_LOCALIZATIONS[
                    sub as keyof typeof PERSONA_LOCALIZATIONS
                  ];
                const name =
                  dir?.display_name ||
                  prof?.display_name ||
                  (known ? localizePersona(sub).displayName : sub);
                const roleLabel = dir?.job_title
                  ? localizeContactJobTitle(dir.job_title, sub, locale)
                  : known
                    ? localizePersona(sub).label
                    : sub;
                const avatarSrc =
                  dir?.avatar_url ||
                  (prof?.has_avatar
                    ? getRoomMemberAvatarUrl(
                        target.roomId,
                        sub,
                        prof.version,
                        authGeneration,
                      )
                    : null);
                return (
                  <li key={sub}>
                    <button
                      type="button"
                      onClick={() => setInspectedGroupMember(sub)}
                      className="flex w-full items-center justify-between gap-2.5 px-3.5 py-2.5 text-left hover:bg-[var(--bg-surface-hover)] transition-colors cursor-pointer"
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        <Avatar
                          src={avatarSrc}
                          name={name}
                          fallbackText={sub}
                          size="sm"
                          status={mapContactAvailabilityToAvatarStatus(
                            dir?.availability,
                          )}
                        />
                        <div className="min-w-0">
                          <div className="truncate text-[13px] font-medium text-[var(--ink-primary)]">
                            {name}
                          </div>
                          <div className="truncate text-[11.5px] text-[var(--ink-muted)]">
                            {roleLabel}
                          </div>
                        </div>
                      </div>
                      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--ink-muted)]" />
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
            {onScheduleMeeting && (
              <Button
                size="sm"
                variant="secondary"
                pill
                onClick={() => {
                  onOpenChange(false);
                  onScheduleMeeting();
                }}
              >
                <Video className="h-3.5 w-3.5 text-[var(--accent)]" />
                <span>
                  {tx({
                    "zh-CN": "预约 Zoom 会议",
                    "zh-HK": "預約 Zoom 會議",
                    en: "Schedule Zoom",
                  })}
                </span>
              </Button>
            )}
            {onViewMembers && (
              <Button
                size="sm"
                variant="primary"
                pill
                onClick={() => {
                  onOpenChange(false);
                  onViewMembers();
                }}
              >
                <Users className="h-3.5 w-3.5" />
                <span>
                  {tx({
                    "zh-CN": "查看会话成员",
                    "zh-HK": "檢視對話成員",
                    en: "View Members",
                  })}
                </span>
              </Button>
            )}
          </div>
        </div>
      )}

      {resolvedColleague && (
        <div
          data-testid={`contact-profile-dialog-${resolvedColleague.subject}`}
          className="space-y-4"
        >
          {target?.kind === "group" && (
            <button
              type="button"
              onClick={() => setInspectedGroupMember(null)}
              className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[12px] font-medium text-[var(--accent)] hover:bg-[var(--accent-wash)] transition-colors cursor-pointer"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              <span>
                {tx({
                  "zh-CN": "返回群组成员",
                  "zh-HK": "返回群組成員",
                  en: "Back to room",
                })}
              </span>
            </button>
          )}

          {/* Hero Identity */}
          <div className="flex flex-col items-center text-center">
            <Avatar
              src={resolvedColleague.avatarSrc}
              name={resolvedColleague.displayName}
              fallbackText={resolvedColleague.subject}
              size="xl"
              status={resolvedColleague.avatarStatus}
              className="shadow-[var(--shadow-card)]"
            />
            <h3 className="mt-3 text-[17.5px] font-semibold tracking-[-0.015em] text-[var(--ink-primary)]">
              {resolvedColleague.displayName}
            </h3>
            <div className="mt-1.5 flex flex-wrap items-center justify-center gap-1.5">
              {resolvedColleague.jobTitle && (
                <span className="inline-flex items-center rounded-full border border-[var(--accent-border)] bg-[var(--accent-wash)] px-2.5 py-0.5 text-[11.5px] font-medium text-[var(--accent-ink)]">
                  {resolvedColleague.jobTitle}
                </span>
              )}
              {resolvedColleague.department && (
                <span className="inline-flex items-center gap-1 rounded-full border border-[var(--hairline)] bg-[var(--bg-surface-subtle)] px-2.5 py-0.5 text-[11.5px] text-[var(--ink-secondary)]">
                  <Building2 className="h-3 w-3 text-[var(--ink-muted)]" />
                  <span>{resolvedColleague.department}</span>
                </span>
              )}
            </div>
            <div className="mt-1 font-mono-code text-[11px] text-[var(--ink-muted)]">
              @{resolvedColleague.subject}
            </div>
          </div>

          {/* Directory Metadata Card */}
          <dl className="divide-y divide-[var(--hairline-subtle)] rounded-tile border border-[var(--hairline)] bg-[var(--bg-surface-tint)] text-[12.5px]">
            {/* Direct Phone */}
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3.5 py-2.5">
              <dt className="flex items-center gap-1.5 font-medium text-[var(--ink-muted)] shrink-0">
                <Phone className="h-3.5 w-3.5" />
                <span>
                  {tx({ "zh-CN": "直线电话", "zh-HK": "直線電話", en: "Phone" })}
                </span>
              </dt>
              <dd className="flex items-center gap-1.5 min-w-0">
                {resolvedColleague.phone ? (
                  <>
                    <a
                      href={`tel:${resolvedColleague.phone.replace(/\s+/g, "")}`}
                      className="truncate font-mono-code tabular-nums font-medium text-[var(--accent-ink)] hover:underline"
                    >
                      {resolvedColleague.phone}
                    </a>
                    <button
                      type="button"
                      onClick={() =>
                        void handleCopy("phone", resolvedColleague.phone)
                      }
                      aria-label={tx({
                        "zh-CN": "复制电话",
                        "zh-HK": "複製電話",
                        en: "Copy phone",
                      })}
                      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-[var(--ink-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--ink-primary)] cursor-pointer"
                    >
                      {copiedField === "phone" ? (
                        <Check className="h-3 w-3 text-[var(--status-emerald)]" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                    </button>
                  </>
                ) : (
                  <span className="text-[var(--ink-muted)]">
                    {loadingDirectory ? "…" : "—"}
                  </span>
                )}
              </dd>
            </div>

            {/* Extension */}
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3.5 py-2.5">
              <dt className="flex items-center gap-1.5 font-medium text-[var(--ink-muted)] shrink-0">
                <Hash className="h-3.5 w-3.5" />
                <span>
                  {tx({ "zh-CN": "内线分机", "zh-HK": "內線分機", en: "Ext." })}
                </span>
              </dt>
              <dd className="font-mono-code tabular-nums font-medium text-[var(--ink-primary)]">
                {resolvedColleague.ext || (loadingDirectory ? "…" : "—")}
              </dd>
            </div>

            {/* Corporate Email */}
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3.5 py-2.5">
              <dt className="flex items-center gap-1.5 font-medium text-[var(--ink-muted)] shrink-0">
                <Mail className="h-3.5 w-3.5" />
                <span>
                  {tx({ "zh-CN": "企业邮箱", "zh-HK": "企業電郵", en: "Email" })}
                </span>
              </dt>
              <dd className="flex items-center gap-1.5 min-w-0 max-w-full">
                {resolvedColleague.email ? (
                  <>
                    <a
                      href={`mailto:${resolvedColleague.email}`}
                      className="min-w-0 break-all sm:truncate font-mono-code font-medium text-[var(--accent-ink)] hover:underline"
                    >
                      {resolvedColleague.email}
                    </a>
                    <button
                      type="button"
                      onClick={() =>
                        void handleCopy("email", resolvedColleague.email)
                      }
                      aria-label={tx({
                        "zh-CN": "复制邮箱",
                        "zh-HK": "複製電郵",
                        en: "Copy email",
                      })}
                      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-[var(--ink-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--ink-primary)] cursor-pointer"
                    >
                      {copiedField === "email" ? (
                        <Check className="h-3 w-3 text-[var(--status-emerald)]" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                    </button>
                  </>
                ) : (
                  <span className="text-[var(--ink-muted)]">
                    {loadingDirectory ? "…" : "—"}
                  </span>
                )}
              </dd>
            </div>

            {/* Office Location */}
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-3.5 py-2.5">
              <dt className="flex items-center gap-1.5 font-medium text-[var(--ink-muted)] shrink-0">
                <MapPin className="h-3.5 w-3.5" />
                <span>
                  {tx({
                    "zh-CN": "办公地点",
                    "zh-HK": "辦公地點",
                    en: "Office",
                  })}
                </span>
              </dt>
              <dd className="min-w-0 max-w-full break-words text-right text-[var(--ink-primary)]">
                {resolvedColleague.office || (loadingDirectory ? "…" : "—")}
              </dd>
            </div>

            {/* Authorized Warehouses */}
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3.5 py-2.5">
              <dt className="flex items-center gap-1.5 font-medium text-[var(--ink-muted)] shrink-0">
                <Warehouse className="h-3.5 w-3.5" />
                <span>
                  {tx({
                    "zh-CN": "授权仓库",
                    "zh-HK": "授權倉庫",
                    en: "Warehouses",
                  })}
                </span>
              </dt>
              <dd className="font-mono-code font-medium text-right text-[var(--ink-primary)]">
                {resolvedColleague.warehouses.length > 0
                  ? resolvedColleague.warehouses.join(" / ")
                  : loadingDirectory
                    ? "…"
                    : "—"}
              </dd>
            </div>
          </dl>

          {/* 1-Click Actions */}
          <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
            {(onSendEmail || resolvedColleague.email) && (
              <Button
                size="sm"
                variant="secondary"
                pill
                data-testid="contact-profile-email-btn"
                onClick={() => {
                  if (onSendEmail) {
                    onOpenChange(false);
                    onSendEmail({
                      subject: resolvedColleague.subject,
                      email: resolvedColleague.email,
                      displayName: resolvedColleague.displayName,
                    });
                  } else if (resolvedColleague.email) {
                    window.location.href = `mailto:${resolvedColleague.email}`;
                  }
                }}
              >
                <Mail className="h-3.5 w-3.5 text-[var(--accent)]" />
                <span>
                  {tx({
                    "zh-CN": "发送邮件",
                    "zh-HK": "發送電郵",
                    en: "Send Email",
                  })}
                </span>
              </Button>
            )}

            {onScheduleMeeting && (
              <Button
                size="sm"
                variant="secondary"
                pill
                data-testid="contact-profile-zoom-btn"
                onClick={() => {
                  onOpenChange(false);
                  onScheduleMeeting(resolvedColleague.subject);
                }}
              >
                <Video className="h-3.5 w-3.5 text-[var(--accent)]" />
                <span>
                  {tx({
                    "zh-CN": "预约 Zoom 会议",
                    "zh-HK": "預約 Zoom 會議",
                    en: "Book Zoom",
                  })}
                </span>
              </Button>
            )}

            {onViewMembers && (
              <Button
                size="sm"
                variant="primary"
                pill
                data-testid="contact-profile-members-btn"
                onClick={() => {
                  onOpenChange(false);
                  onViewMembers();
                }}
              >
                <Users className="h-3.5 w-3.5" />
                <span>
                  {tx({
                    "zh-CN": "查看会话成员",
                    "zh-HK": "檢視對話成員",
                    en: "View Members",
                  })}
                </span>
              </Button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
