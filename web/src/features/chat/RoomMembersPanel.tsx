"use client";

import React, { useState } from "react";
import { UserMinus, UserPlus } from "lucide-react";
import {
  isApiError,
  isStaleAuthError,
  type ApiError,
} from "@/lib/api-client";
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
  const [inviteSubject, setInviteSubject] = useState("");
  const [busySubject, setBusySubject] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const isOwner = Boolean(actor && roomOwner && actor.subject === roomOwner);

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
      setFeedback(`已将 ${target} 加入当前房间（仅可查看加入后的消息）。`);
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
      setFeedback(`已将 ${subject} 移出房间。`);
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
          className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] p-3 space-y-2"
        >
          <label
            htmlFor="room-invite-subject"
            className="block text-[12px] font-medium text-[var(--ink-secondary)]"
          >
            添加同租户同事（按 subject）
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
              placeholder="例如：manager / finance"
              className="h-8 min-w-0 flex-1 rounded-[4px] border border-[var(--hairline-strong)] bg-[var(--bg-sheet)] px-2.5 font-mono-code text-[12.5px] text-[var(--ink-primary)] focus:border-[var(--accent)] focus:outline-none"
            />
            <Button
              type="submit"
              size="sm"
              variant="primary"
              loading={busySubject === inviteSubject.trim() && busySubject !== null}
              disabled={!inviteSubject.trim() || busySubject !== null}
              data-testid="room-invite-submit"
            >
              <UserPlus className="h-3.5 w-3.5" strokeWidth={1.75} />
              <span>添加</span>
            </Button>
          </div>
          <p className="text-[11px] text-[var(--ink-muted)]">
            新成员加入后仅能读取其加入序号（from_seq）之后的消息。
          </p>
        </form>
      ) : (
        <div className="rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-subtle)] px-3 py-2 text-[12px] text-[var(--ink-muted)]">
          仅房间创建人（{roomOwner || "群主"}）可管理成员名单。
        </div>
      )}

      {feedback && (
        <div
          role="status"
          className="rounded-[4px] border border-[var(--status-emerald-border)] bg-[var(--status-emerald-wash)] px-3 py-2 text-[12px] text-[var(--status-emerald)]"
        >
          {feedback}
        </div>
      )}

      {error && <AccessNoticeCard error={error} />}

      <div>
        <div className="mb-2 flex items-center justify-between text-[11.5px] text-[var(--ink-muted)]">
          <span>当前活跃成员</span>
          <span className="font-mono-code">{members.length} 人</span>
        </div>

        <ul className="divide-y divide-[var(--hairline)] rounded-[4px] border border-[var(--hairline)] bg-[var(--bg-sheet)]">
          {members.map((subject) => {
            const prof = memberProfiles[subject];
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
                className="flex items-center justify-between gap-2.5 px-3 py-2.5"
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <Avatar
                    src={avatarSrc}
                    name={prof?.display_name || subject}
                    fallbackText={subject}
                    size="sm"
                  />
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[13px] font-medium text-[var(--ink-primary)]">
                        {prof?.display_name || subject}
                      </span>
                      {isRoomOwner && (
                        <span className="rounded-[2px] border border-[var(--accent-border)] bg-[var(--accent-wash)] px-1 py-0.5 font-mono-code text-[10px] text-[var(--accent)] leading-none">
                          群主
                        </span>
                      )}
                      {isSelf && (
                        <span className="font-mono-code text-[10px] text-[var(--ink-muted)]">
                          (我)
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
                    loading={busySubject === subject}
                    disabled={busySubject !== null}
                    data-testid={`room-remove-member-${subject}`}
                    onClick={() => void handleRemoveMember(subject)}
                  >
                    <UserMinus className="h-3.5 w-3.5" strokeWidth={1.75} />
                    <span>移除</span>
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
