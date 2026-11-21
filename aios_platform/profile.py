"""Own profile management and authorized room-member profile projection."""
import asyncio
from io import BytesIO
from threading import BoundedSemaphore
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from PIL import Image, ImageOps, UnidentifiedImageError
from pydantic import Field
from starlette.concurrency import run_in_threadpool

from .collaboration import MissingResource, subject_tx, lock_subjects
from .contracts import Actor, Identifier, Strict
from .module_access import Subject
from .workflow import Conflict

AVATAR_LIMIT = 2 * 1024 * 1024
Version = Annotated[int, Field(strict=True, ge=0, lt=2**63 - 1)]


class ProfileUpdate(Strict):
    version: Version
    display_name: Annotated[str, Field(min_length=1, max_length=80)] | None


def avatar_bytes(data: bytes) -> bytes:
    try:
        with Image.open(BytesIO(data), formats=("PNG", "JPEG", "WEBP")) as image:
            if (min(image.size) < 1 or max(image.size) > 4096
                    or image.width * image.height > 8_000_000
                    or getattr(image, "n_frames", 1) != 1):
                raise ValueError("Unsupported avatar dimensions or frame count")
            image = ImageOps.exif_transpose(image).convert("RGBA")
            image.thumbnail((256, 256), Image.Resampling.LANCZOS)
            result = BytesIO()
            clean = Image.new("RGBA", image.size)
            clean.paste(image)
            clean.save(result, format="PNG")
            return result.getvalue()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as error:
        raise ValueError("Invalid avatar") from error


class Profiles:
    def __init__(self, workflow):
        self.workflow = workflow

    def get(self, actor, kind, *, target=None, room=None, avatar=False):
        subject = target or actor.subject
        with subject_tx(self.workflow, actor) as run:
            if room is not None:
                if self.workflow._suspended(run, actor.tenant, subject) or not run("""
                    SELECT 1 FROM aios_chat_member AS current_member
                    JOIN aios_chat_member AS profile_member
                      ON profile_member.tenant = current_member.tenant
                      AND profile_member.room_id = current_member.room_id
                    WHERE current_member.tenant = ? AND current_member.room_id = ?
                      AND current_member.subject = ? AND profile_member.subject = ?
                """, (actor.tenant, room, actor.subject, subject)).fetchone():
                    raise MissingResource(subject)
            fields = "avatar" if avatar else "display_name, version, avatar IS NOT NULL AS has_avatar"
            row = run(f"SELECT {fields} FROM aios_profile WHERE tenant = ? AND subject = ? AND kind = ?",
                      (actor.tenant, subject, kind)).fetchone()
        if avatar:
            if row is None or row["avatar"] is None:
                raise MissingResource(subject)
            return bytes(row["avatar"])
        return dict(row) if row is not None else {"display_name": None, "version": 0, "has_avatar": False}

    def change(self, actor, kind, field, value, version):
        with subject_tx(self.workflow, actor, write=True) as run:
            lock_subjects(self.workflow, run, actor.tenant, "profile-v1", [actor.subject])
            key = (actor.tenant, actor.subject, kind)
            if version == 0:
                changed = run(f"INSERT INTO aios_profile (tenant, subject, kind, {field}, version) "
                              "VALUES (?, ?, ?, ?, 1) ON CONFLICT DO NOTHING", (*key, value))
            else:
                changed = run(f"UPDATE aios_profile SET {field} = ?, version = version + 1 "
                              "WHERE tenant = ? AND subject = ? AND kind = ? AND version = ?", (value, *key, version))
            if changed.rowcount != 1:
                raise Conflict("Profile version changed")
            row = run("""SELECT display_name, version, avatar IS NOT NULL AS has_avatar
                         FROM aios_profile WHERE tenant = ? AND subject = ? AND kind = ?""", key).fetchone()
        return dict(row)


def profile_routes(workflow, authenticate, *, chat_available):
    profiles = Profiles(workflow)
    uploads = BoundedSemaphore(4)
    router = APIRouter(prefix="/v1", tags=["Profiles"])

    def png(data):
        return Response(data, media_type="image/png", headers={"X-Content-Type-Options": "nosniff"})

    def mount(path, kind):
        @router.get(path, operation_id=f"get_{kind}_profile")
        def get(actor: Actor = Depends(authenticate)):
            return profiles.get(actor, kind)

        @router.patch(path, operation_id=f"update_{kind}_profile")
        def update(body: ProfileUpdate, actor: Actor = Depends(authenticate)):
            name = body.display_name
            if name is not None:
                name = name.strip()
                if not name or not name.isprintable():
                    raise HTTPException(422, "Invalid display name")
            return profiles.change(actor, kind, "display_name", name, body.version)

        @router.get(path + "/avatar", operation_id=f"get_{kind}_avatar")
        def get_avatar(actor: Actor = Depends(authenticate)):
            return png(profiles.get(actor, kind, avatar=True))

        @router.put(path + "/avatar", operation_id=f"upload_{kind}_avatar")
        async def put_avatar(request: Request, version: Annotated[int, Field(ge=0, lt=2**63 - 1)],
                             actor: Actor = Depends(authenticate)):
            if request.headers.get("content-type") != "application/octet-stream":
                raise HTTPException(415, "Send image bytes as application/octet-stream")
            if not uploads.acquire(blocking=False):
                raise HTTPException(503, {"code": "AVATAR_BUSY"}, headers={"Retry-After": "1"})
            try:
                data = bytearray()
                try:
                    async with asyncio.timeout(10):
                        async for chunk in request.stream():
                            if len(data) + len(chunk) > AVATAR_LIMIT:
                                raise HTTPException(413, "Avatar exceeds 2 MiB")
                            data.extend(chunk)
                except TimeoutError as error:
                    raise HTTPException(408, "Avatar upload timed out") from error
                try:
                    image = await run_in_threadpool(avatar_bytes, bytes(data))
                except ValueError as error:
                    raise HTTPException(422, str(error)) from error
                return await run_in_threadpool(profiles.change, actor, kind, "avatar", image, version)
            finally:
                uploads.release()

        @router.delete(path + "/avatar", operation_id=f"remove_{kind}_avatar")
        def delete_avatar(version: Annotated[int, Field(ge=0, lt=2**63 - 1)], actor: Actor = Depends(authenticate)):
            return profiles.change(actor, kind, "avatar", None, version)

    mount("/profile", "employee")
    mount("/agent-profile", "agent")

    def require_chat(actor):
        if not chat_available or "chat.use" not in actor.grants:
            raise HTTPException(404, "Profile unavailable")

    member_path = "/chat/rooms/{room_id}/members/{subject}/profile"

    @router.get(member_path)
    def room_profile(room_id: Identifier, subject: Subject, actor: Actor = Depends(authenticate)):
        require_chat(actor)
        return profiles.get(actor, "employee", target=subject, room=room_id)

    @router.get(member_path + "/avatar")
    def room_avatar(room_id: Identifier, subject: Subject, actor: Actor = Depends(authenticate)):
        require_chat(actor)
        return png(profiles.get(actor, "employee", target=subject, room=room_id, avatar=True))

    return router
