import { apiFetch } from "@/lib/api-client";
import type {
  ChatMemberPage,
  ChatMessage,
  ChatMessagePage,
  Profile,
} from "@/lib/types";

export function fetchRoomMembers(
  roomId: string,
  params?: { limit?: number; after?: string },
  signal?: AbortSignal,
) {
  const sp = new URLSearchParams();
  if (params?.limit) sp.set("limit", String(params.limit));
  if (params?.after) sp.set("after", params.after);
  const q = sp.toString();
  return apiFetch<ChatMemberPage>(
    `/v1/chat/rooms/${encodeURIComponent(roomId)}/members${q ? `?${q}` : ""}`,
    { signal },
  );
}

export function updateRoomMember(
  roomId: string,
  subject: string,
  active: boolean,
) {
  return apiFetch<{ active: boolean }>(
    `/v1/chat/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(subject)}`,
    {
      method: "PUT",
      body: { active },
    },
  );
}

export function fetchRoomMessages(
  roomId: string,
  params?: { limit?: number; after?: number },
  signal?: AbortSignal,
) {
  const sp = new URLSearchParams();
  if (params?.limit) sp.set("limit", String(params.limit));
  if (params?.after !== undefined) sp.set("after", String(params.after));
  const q = sp.toString();
  return apiFetch<ChatMessagePage>(
    `/v1/chat/rooms/${encodeURIComponent(roomId)}/messages${q ? `?${q}` : ""}`,
    { signal },
  );
}

export function postRoomMessage(
  roomId: string,
  body: { client_id: string; text: string },
) {
  return apiFetch<ChatMessage>(
    `/v1/chat/rooms/${encodeURIComponent(roomId)}/messages`,
    {
      method: "POST",
      body,
    },
  );
}

export function fetchRoomMemberProfile(
  roomId: string,
  subject: string,
  signal?: AbortSignal,
) {
  return apiFetch<Profile>(
    `/v1/chat/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(subject)}/profile`,
    { signal },
  );
}

export function getRoomMemberAvatarUrl(
  roomId: string,
  subject: string,
  profileVersion: number,
  authGeneration: number,
): string {
  return `/v1/chat/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(subject)}/profile/avatar?v=${profileVersion}&g=${authGeneration}`;
}
