"""Tenant-local employee rooms. External connectors and model context are separate."""
from collections.abc import Callable
from contextlib import contextmanager
from time import time
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import Field

from aios_demo.storage import digest_of

from .contracts import Actor, Identifier, Strict
from .workflow import Conflict, Workflow

DirectoryLookup = Callable[[str, str], bool]
Subject = Annotated[str, Field(min_length=1, max_length=150, pattern=r"^[^\x00-\x1f\x7f]+$")]


class CreateRoom(Strict):
    client_id: Identifier
    title: Annotated[str, Field(min_length=1, max_length=100)]


class MemberChange(Strict):
    active: bool


class PostMessage(Strict):
    client_id: Identifier
    text: Annotated[str, Field(min_length=1, max_length=4000)]


class Chat:
    def __init__(self, workflow: Workflow, known_subject: DirectoryLookup):
        self.workflow = workflow
        self.known_subject = known_subject

    @contextmanager
    def tx(self, actor: Actor, *, write: bool = True):
        with self.workflow.tx(actor.tenant, write=write) as run:
            if self.workflow.db.dsn:
                run("SELECT set_config('aios.subject', ?, true)", (actor.subject,))
            yield run

    def create(self, actor: Actor, request: CreateRoom) -> dict:
        title = request.title.strip()
        if not title:
            raise ValueError("Room title is required")
        room_id = digest_of({"owner": actor.subject, "client_id": request.client_id})
        with self.tx(actor) as run:
            created = run("""INSERT INTO aios_chat_room (tenant, id, owner, title) VALUES (?, ?, ?, ?)
                            ON CONFLICT (tenant, id) DO NOTHING""",
                          (actor.tenant, room_id, actor.subject, title)).rowcount
            if created:
                run("INSERT INTO aios_chat_member VALUES (?, ?, ?, 1)", (actor.tenant, room_id, actor.subject))
                self.workflow._audit(run, actor.tenant, actor.subject, room_id, "CHAT_ROOM_CREATED")
            else:
                original = self._room(run, actor, room_id)
                if original["owner"] != actor.subject or original["title"] != title:
                    raise Conflict("Room client ID is already in use")
        return {"id": room_id, "title": title, "owner": actor.subject}

    def _room(self, run, actor: Actor, room_id: str, *, lock: bool = False):
        # Membership changes and sends serialize on the same room row.
        if lock and self.workflow.db.dsn:
            run("SELECT id FROM aios_chat_room WHERE tenant = ? AND id = ? FOR UPDATE",
                (actor.tenant, room_id)).fetchone()
        # Evaluate membership in a new statement after acquiring the PostgreSQL lock.
        row = run("""SELECT r.id, r.title, r.owner, r.next_seq FROM aios_chat_room AS r
                     WHERE r.tenant = ? AND r.id = ? AND EXISTS (
                       SELECT 1 FROM aios_chat_member AS m
                       WHERE m.tenant = r.tenant AND m.room_id = r.id AND m.subject = ?
                     )""", (actor.tenant, room_id, actor.subject)).fetchone()
        if row is None:
            raise KeyError(room_id)
        return row

    def rooms(self, actor: Actor, limit: int, after: str) -> list[dict]:
        with self.tx(actor, write=False) as run:
            rows = run("""SELECT r.id, r.title, r.owner FROM aios_chat_member AS m
                          JOIN aios_chat_room AS r ON r.tenant = m.tenant AND r.id = m.room_id
                          WHERE m.tenant = ? AND m.subject = ? AND m.room_id > ?
                          ORDER BY m.room_id LIMIT ?""", (actor.tenant, actor.subject, after, limit)).fetchall()
        return [dict(row) for row in rows]

    def member(self, actor: Actor, room_id: str, subject: str, active: bool) -> bool:
        with self.tx(actor) as run:
            room = self._room(run, actor, room_id, lock=True)
            if room["owner"] != actor.subject:
                raise PermissionError("Room owner required")
            if subject == room["owner"]:
                raise ValueError("Room owner membership is permanent")
            key = (actor.tenant, room_id, subject)
            if active:
                if not self.known_subject(actor.tenant, subject) or self.workflow._suspended(run, actor.tenant, subject):
                    raise PermissionError("This subject cannot be admitted")
                delta = run("INSERT INTO aios_chat_member VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
                            (*key, room["next_seq"]))
            else:
                delta = run("DELETE FROM aios_chat_member WHERE tenant = ? AND room_id = ? AND subject = ?", key)
            if delta.rowcount:
                event = "CHAT_MEMBER_ADDED" if active else "CHAT_MEMBER_REMOVED"
                self.workflow._audit(run, actor.tenant, actor.subject, room_id, event)
        return active

    def members(self, actor: Actor, room_id: str, limit: int, after: str) -> list[str]:
        with self.tx(actor, write=False) as run:
            self._room(run, actor, room_id)
            rows = run("""SELECT m.subject FROM aios_chat_member AS m
                          WHERE m.tenant = ? AND m.room_id = ? AND m.subject > ? AND EXISTS (
                            SELECT 1 FROM aios_chat_member AS own
                            WHERE own.tenant = m.tenant AND own.room_id = m.room_id AND own.subject = ?
                          ) ORDER BY m.subject LIMIT ?""", (actor.tenant, room_id, after, actor.subject, limit))
            return [row["subject"] for row in rows.fetchall()]

    def messages(self, actor: Actor, room_id: str, limit: int, after: int) -> list[dict]:
        with self.tx(actor, write=False) as run:
            self._room(run, actor, room_id)
            rows = run("""SELECT p.seq, p.author, p.body AS text, p.created_at
                          FROM aios_chat_message AS p WHERE p.tenant = ? AND p.room_id = ? AND p.seq > ?
                          AND EXISTS (
                            SELECT 1 FROM aios_chat_member AS m
                            WHERE m.tenant = p.tenant AND m.room_id = p.room_id AND m.subject = ? AND p.seq >= m.from_seq
                          ) ORDER BY p.seq LIMIT ?""", (actor.tenant, room_id, after, actor.subject, limit)).fetchall()
        return [dict(row) for row in rows]

    def post(self, actor: Actor, room_id: str, request: PostMessage) -> dict:
        if not request.text.strip():
            raise ValueError("Message text is required")
        with self.tx(actor) as run:
            room = self._room(run, actor, room_id, lock=True)
            if self.workflow._suspended(run, actor.tenant, actor.subject):
                raise PermissionError("This subject cannot post")
            key = (actor.tenant, room_id, actor.subject, request.client_id)
            prior = run("""SELECT seq, author, body AS text, created_at FROM aios_chat_message
                           WHERE tenant = ? AND room_id = ? AND author = ? AND client_id = ?
                           AND seq >= (SELECT from_seq FROM aios_chat_member
                                       WHERE tenant = ? AND room_id = ? AND subject = ?)""",
                        (*key, *key[:3])).fetchone()
            if prior:
                if prior["text"] != request.text:
                    raise Conflict("Message client ID is already in use")
                return dict(prior)
            seq, created = room["next_seq"], time()
            run("UPDATE aios_chat_room SET next_seq = ? WHERE tenant = ? AND id = ?",
                (seq + 1, actor.tenant, room_id))
            stored = run("""INSERT INTO aios_chat_message (tenant, room_id, author, client_id, seq, body, created_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (tenant, room_id, author, client_id) DO NOTHING""",
                         (*key, seq, request.text, created))
            if stored.rowcount != 1:
                raise Conflict("Message client ID is already in use")
        return {"seq": seq, "author": actor.subject, "text": request.text, "created_at": created}


def chat_routes(workflow: Workflow, authenticate, *,
                known_subject: DirectoryLookup | None = None) -> APIRouter:
    router = APIRouter(prefix="/v1/chat", tags=["Employee chat"])
    chat = Chat(workflow, known_subject) if known_subject is not None else None

    def participant(actor: Actor = Depends(authenticate)) -> Actor:
        if "chat.use" not in actor.grants:
            raise HTTPException(403, "Chat permission required")
        if chat is None:
            raise HTTPException(503, "Employee chat is unavailable")
        return actor

    def call(method, *args):
        try:
            return method(*args)
        except KeyError as error:
            raise HTTPException(404, "Room not found") from error
        except PermissionError as error:
            raise HTTPException(403, str(error)) from error
        except Conflict as error:
            raise HTTPException(409, str(error)) from error
        except ValueError as error:
            raise HTTPException(422, str(error)) from error

    def page(rows, limit, cursor):
        items = rows[:limit]
        return {"items": items, "next": cursor(items[-1]) if len(rows) > limit else None}

    @router.get("/rooms")
    def rooms(actor: Actor = Depends(participant), limit: Annotated[int, Query(ge=1, le=100)] = 50,
              after: Identifier | None = None):
        return page(chat.rooms(actor, limit + 1, after or ""), limit, lambda item: item["id"])

    @router.post("/rooms", status_code=201)
    def create(body: CreateRoom, actor: Actor = Depends(participant)):
        return call(chat.create, actor, body)

    @router.get("/rooms/{room_id}/members")
    def members(room_id: Identifier, actor: Actor = Depends(participant),
                limit: Annotated[int, Query(ge=1, le=100)] = 50, after: Subject | None = None):
        return page(call(chat.members, actor, room_id, limit + 1, after or ""), limit, lambda item: item)

    @router.put("/rooms/{room_id}/members/{subject}")
    def member(room_id: Identifier, subject: Subject, body: MemberChange, actor: Actor = Depends(participant)):
        return {"active": call(chat.member, actor, room_id, subject, body.active)}

    @router.get("/rooms/{room_id}/messages")
    def messages(room_id: Identifier, actor: Actor = Depends(participant),
                 limit: Annotated[int, Query(ge=1, le=100)] = 50,
                 after: Annotated[int, Query(ge=0, le=2**63 - 1)] = 0):
        return page(call(chat.messages, actor, room_id, limit + 1, after), limit, lambda item: item["seq"])

    @router.post("/rooms/{room_id}/messages", status_code=201)
    def post(room_id: Identifier, body: PostMessage, actor: Actor = Depends(participant)):
        return call(chat.post, actor, room_id, body)

    return router
