import { apiFetch } from "@/lib/api-client";
import type { Profile } from "@/lib/types";

export type ProfileKind = "user" | "agent";

export const MAX_AVATAR_BYTES = 2 * 1024 * 1024; // 2 MiB strict backend limit
export const ALLOWED_AVATAR_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

function basePathFor(kind: ProfileKind): string {
  return kind === "agent" ? "/v1/agent-profile" : "/v1/profile";
}

export function patchProfileDisplayName(
  kind: ProfileKind,
  version: number,
  displayName: string | null,
) {
  return apiFetch<Profile>(basePathFor(kind), {
    method: "PATCH",
    body: {
      version,
      display_name: displayName,
    },
  });
}

export async function uploadProfileAvatar(
  kind: ProfileKind,
  version: number,
  file: File,
): Promise<Profile> {
  const bytes = await file.arrayBuffer();
  const sp = new URLSearchParams({ version: String(version) });
  return apiFetch<Profile>(`${basePathFor(kind)}/avatar?${sp.toString()}`, {
    method: "PUT",
    rawBody: bytes,
    contentType: "application/octet-stream",
  });
}

export function deleteProfileAvatar(kind: ProfileKind, version: number) {
  const sp = new URLSearchParams({ version: String(version) });
  return apiFetch<Profile>(`${basePathFor(kind)}/avatar?${sp.toString()}`, {
    method: "DELETE",
  });
}

export function validateAvatarFile(file: File): string | null {
  if (file.size <= 0) {
    return "所选图片文件为空，请重新选择。";
  }
  if (file.size > MAX_AVATAR_BYTES) {
    return "头像文件不能超过 2 MiB，请压缩后再上传。";
  }
  const type = (file.type || "").toLowerCase();
  const name = file.name.toLowerCase();
  const extOk =
    name.endsWith(".png") ||
    name.endsWith(".jpg") ||
    name.endsWith(".jpeg") ||
    name.endsWith(".webp");
  if (!ALLOWED_AVATAR_MIME_TYPES.has(type) && !extOk) {
    return "仅支持 PNG、JPEG 或 WEBP 格式的静态图片。";
  }
  return null;
}
