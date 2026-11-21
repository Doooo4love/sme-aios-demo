"use client";

import React, { useState } from "react";
import { UserMinus, UserPlus } from "lucide-react";
import {
  isApiError,
  isStaleAuthError,
  type ApiError,
} from "@/lib/api-client";
import { PERSONA_LOCALIZATIONS, useLocale } from "@/lib/i18n";
import { useSession } from "@/lib/session-context";
import { AccessNoticeCard } from "@/components/ui/AccessNoticeCard";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import {
  getRoomMemberAvatarUrl,
  updateRoomMember,
} from "@/features/chat/api";
import type { Profile } from "@/lib/types";

export interface RoomMembersPanelProps {
  roomId: string;
  roomOwner: string | null;
  members: string[];
  memberProfiles: Record<string, Profile>;
  onMembersChanged: (removedSubject?: string) => Promise<void> | void;
}

export function RoomMembersPanel({
  roomId,
  roomOwner,
  members,
  memberProfiles,
  onMembersChanged,
}: RoomMembersPanelProps) {
  const { actor, authGeneration, handleAccessChanged } = useSession();
  const { t, tp, tx, localizePersona } = useLocale();
  const [inviteSubject, setInviteSubject] = useState("");
  const [busySubject, setBusySubject] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const isOwner = Boolean(actor && roomOwner && actor.subject === roomOwner);

  const resolveMemberName = (subject: string, prof?: Profile) => {
    const raw = prof?.display_name?.trim();
    const known =
      PERSONA_LOCALIZATIONS[subject as keyof typeof PERSONA_LOCALIZATIONS];
    if (
      raw &&
      (!known ||
        (raw !== known["zh-CN"].displayName &&
          raw !== known["zh-HK"].displayName &&
          raw !== known.en.displayName))
    ) {
      return raw;
    }
    if (known) {
      return localizePersona(subject).displayName;
    }
    return raw || subject;
  };

  const handleAddMember = async (e: React.FormEvent) => {
    e.preventDefault();
    const target = inviteSubject.trim();
    if (!target || busySubject) return;
    setBusySubject(target);
    setError(null);
    setFeedback(null);
    try {
      await updateRoomMember(roomId, target, true);
      setInviteSubject("");
      setFeedback(
        tx(
          {
            "zh-CN": "已将 {target} 加入当前会话（仅可查看加入后的消息）。",
            "zh-HK": "已將 {target} 加入目前對話（僅可檢視加入後的訊息）。",
            en: "Added {target} to this room (can only view messages from now on).",
          },
          { target },
        ),
      );
      await onMembersChanged();
    } catch (err) {
      if (isStaleAuthError(err)) return;
      if (isApiError(err)) {
        if (err.code === "ACCESS_CHANGED") {
          void handleAccessChanged();
        }
        setError(err);
      }
    } finally {
      setBusySubject(null);
    }
  };

  const handleRemoveMember = async (subject: string) => {
    if (busySubject || subject === roomOwner) return;
    setBusySubject(subject);
    setError(null);
    setFeedback(null);
    try {
      await updateRoomMember(roomId, subject, false);
      setFeedback(
        tx(
          {
            "zh-CN": "已将 {subject} 移出会话。",
            "zh-HK": "已將 {subject} 移出對話。",
            en: "Removed {subject} from this room.",
          },
          { subject },
        ),
      );
      await onMembersChanged(subject);
    } catch (err) {
      if (isStaleAuthError(err)) return;
      if (isApiError(err)) {
        if (err.code === "ACCESS_CHANGED") {
          void handleAccessChanged();
        }
        setError(err);
      }
    } finally {
      setBusySubject(null);
    }
  };

  return (
    <div className="space-y-4" data-testid="room-members-panel">
      {isOwner ? (
        <form
          onSubmit={(e) => void handleAddMember(e)}
          className="rounded-card bg-[var(--bg-surface-tint)] p-3.5 space-y-2.5"
        >
          <label
            htmlFor="room-invite-subject"
            className="block text-[12px] font-medium text-[var(--ink-secondary)]"
          >
            {tx({
              "zh-CN": "添加同租户同事（按账号 subject）",
              "zh-HK": "新增同租戶同事（按帳號 subject）",
              en: "Invite same-tenant colleague (by account subject)",
            })}
          </label>
          <div className="flex gap-2">
            <input
              id="room-invite-subject"
              data-testid="room-invite-input"
              type="text"
              value={inviteSubject}
              onChange={(e) => {
                setInviteSubject(e.target.value);
                setError(null);
              }}
              placeholder={tx({
                "zh-CN": "例如：manager / finance",
                "zh-HK": "例如：manager / finance",
                en: "e.g. manager / finance",
              })}
              className="h-9 min-w-0 flex-1 rounded-sm bg-[var(--bg-surface)] px-3 font-mono-code text-[12.5px] text-[var(--ink-primary)] ring-1 ring-[var(--hairline-strong)] focus:ring-[1.5px] focus:ring-[var(--accent)] focus:outline-none"
            />
            <Button
              type="submit"
              size="sm"
              variant="primary"
              pill
              loading={
                busySubject === inviteSubject.trim() && busySubject !== null
              }
              disabled={!inviteSubject.trim() || busySubject !== null}
              data-testid="room-invite-submit"
              className="h-9"
            >
              <UserPlus className="h-3.5 w-3.5" strokeWidth={1.85} />
              <span>
                {tx({ "zh-CN": "添加", "zh-HK": "新增", en: "Add" })}
              </span>
            </Button>
          </div>
          <p className="text-[11.5px] text-[var(--ink-muted)]">
            {tx({
              "zh-CN": "新成员加入后仅能查看其加入时间点之后的消息。",
              "zh-HK": "新成員加入後僅能檢視其加入時間點之後的訊息。",
              en: "New members can only read messages posted after they join.",
            })}
          </p>
        </form>
      ) : (
        <div className="rounded-tile bg-[var(--bg-surface-tint)] px-3.5 py-2.5 text-[12px] text-[var(--ink-muted)]">
          {tx(
            {
              "zh-CN": "仅会话创建人（{owner}）可管理成员名单。",
              "zh-HK": "僅對話建立者（{owner}）可管理成員名單。",
              en: "Only the room owner ({owner}) can manage membership.",
            },
            {
              owner: roomOwner
                ? resolveMemberName(roomOwner, memberProfiles[roomOwner])
                : tx({ "zh-CN": "群主", "zh-HK": "群主", en: "Owner" }),
            },
          )}
        </div>
      )}

      {feedback && (
        <div
          role="status"
          className="rounded-sm bg-[var(--status-emerald-wash)] px-3.5 py-2.5 text-[12px] text-[var(--status-emerald)]"
        >
          {feedback}
        </div>
      )}

      {error && <AccessNoticeCard error={error} />}

      <div>
        <div className="mb-2 flex items-center justify-between text-[12px] text-[var(--ink-muted)]">
          <span>
            {tx({
              "zh-CN": "当前活跃成员",
              "zh-HK": "目前活躍成員",
              en: "Active Members",
            })}
          </span>
          <span className="tabular-nums">
            {tp(
              {
                "zh-CN": "{count} 人",
                "zh-HK": "{count} 人",
                en: {
                  one: "{count} member",
                  other: "{count} members",
                },
              },
              members.length,
            )}
          </span>
        </div>

        <ul className="divide-y divide-[var(--hairline-subtle)] rounded-card bg-[var(--bg-surface-tint)] overflow-hidden">
          {members.map((subject) => {
            const prof = memberProfiles[subject];
            const displayName = resolveMemberName(subject, prof);
            const avatarSrc = prof?.has_avatar
              ? getRoomMemberAvatarUrl(
                  roomId,
                  subject,
                  prof.version,
                  authGeneration,
                )
              : null;
            const isRoomOwner = subject === roomOwner;
            const isSelf = actor?.subject === subject;

            return (
              <li
                key={subject}
                data-testid={`room-member-row-${subject}`}
                className="flex items-center justify-between gap-2.5 px-3.5 py-3"
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <Avatar
                    src={avatarSrc}
                    name={displayName}
                    fallbackText={subject}
                    size="sm"
                  />
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[13px] font-medium text-[var(--ink-primary)]">
                        {displayName}
                      </span>
                      {isRoomOwner && (
                        <span className="rounded-full bg-[var(--accent-wash)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--accent-ink)] leading-none">
                          {tx({
                            "zh-CN": "群主",
                            "zh-HK": "群主",
                            en: "Owner",
                          })}
                        </span>
                      )}
                      {isSelf && (
                        <span className="text-[11px] text-[var(--ink-muted)]">
                          {tx({
                            "zh-CN": "(我)",
                            "zh-HK": "(我)",
                            en: "(You)",
                          })}
                        </span>
                      )}
                    </div>
                    <div className="font-mono-code text-[11px] text-[var(--ink-muted)]">
                      {subject}
                    </div>
                  </div>
                </div>

                {isOwner && !isRoomOwner && (
                  <Button
                    size="sm"
                    variant="danger"
                    pill
                    loading={busySubject === subject}
                    disabled={busySubject !== null}
                    data-testid={`room-remove-member-${subject}`}
                    onClick={() => void handleRemoveMember(subject)}
                  >
                    <UserMinus className="h-3.5 w-3.5" strokeWidth={1.85} />
                    <span>{t("chat.members.removeButton")}</span>
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
