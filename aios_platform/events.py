"""Thread-safe in-process event hub for SSE streams and work-pulse hydration."""
from __future__ import annotations

import asyncio
from collections import defaultdict, deque
from collections.abc import Iterable
from dataclasses import dataclass
import json
from pathlib import Path
import sqlite3
import threading
import time
from typing import Annotated, Any, Literal
from uuid import uuid4
from weakref import WeakKeyDictionary

from psycopg import IntegrityError as PgIntegrityError
from pydantic import Field

from .contracts import Strict

RING_BUFFER_LIMIT = 50
SUBSCRIBER_QUEUE_LIMIT = 100
_DURABLE_EVENTS_LOCK = threading.Lock()
_DURABLE_EVENTS_READY: WeakKeyDictionary[object, tuple[Any, ...]] = WeakKeyDictionary()


def _sqlite_workflow_sig(workflow) -> tuple[Any, ...]:
    db = getattr(workflow, "db", None)
    sqlite_path = getattr(db, "sqlite_path", None)
    if sqlite_path is not None and str(sqlite_path) != ":memory:":
        p = Path(sqlite_path)
        try:
            st = p.stat()
            return ("file", str(p.resolve()), int(st.st_dev), int(st.st_ino))
        except OSError:
            return ("missing", str(p))
    return ("mem", id(db) if db is not None else id(workflow))


def _ensure_durable_event_table_sqlite(workflow, run) -> None:
    if getattr(getattr(workflow, "db", None), "dsn", None):
        return
    sig = _sqlite_workflow_sig(workflow)
    with _DURABLE_EVENTS_LOCK:
        try:
            if _DURABLE_EVENTS_READY.get(workflow) == sig:
                return
        except TypeError:
            pass
    run(
        """CREATE TABLE IF NOT EXISTS aios_durable_event (
               tenant TEXT NOT NULL,
               seq INTEGER NOT NULL,
               id TEXT NOT NULL,
               subjects_json TEXT NOT NULL,
               include_admins INTEGER NOT NULL DEFAULT 0 CHECK (include_admins IN (0, 1)),
               event_kind TEXT NOT NULL,
               payload_json TEXT NOT NULL,
               created_at DOUBLE PRECISION NOT NULL,
               PRIMARY KEY (tenant, seq),
               UNIQUE (tenant, id)
           )"""
    )
    run(
        """CREATE INDEX IF NOT EXISTS aios_durable_event_recent
               ON aios_durable_event(tenant, created_at DESC, seq DESC)"""
    )
    sig_after = _sqlite_workflow_sig(workflow)
    with _DURABLE_EVENTS_LOCK:
        try:
            _DURABLE_EVENTS_READY[workflow] = sig_after
        except TypeError:
            pass


def _is_visible_to(subjects: Iterable[str], include_admins: bool, subject: str, is_admin: bool) -> bool:
    subject_set = subjects if isinstance(subjects, (set, frozenset)) else set(subjects)
    return subject in subject_set or "*" in subject_set or (is_admin and include_admins)


class WorkEvent(Strict):
    id: Annotated[str, Field(min_length=1, max_length=64)] = Field(default_factory=lambda: uuid4().hex)
    kind: Annotated[str, Field(min_length=1, max_length=64)]
    title: Annotated[str, Field(min_length=1, max_length=240)]
    subtitle: Annotated[str, Field(max_length=500)] = ""
    reference: Annotated[str, Field(max_length=128)] = ""
    href: Annotated[str, Field(max_length=256)] = ""
    severity: Literal["info", "medium", "high", "critical"] = "info"
    created_at: float = Field(default_factory=time.time)
    room_id: Annotated[str, Field(min_length=1, max_length=64)] | None = None
    seq: Annotated[int, Field(ge=0)] | None = None
    author: Annotated[str, Field(min_length=1, max_length=150)] | None = None
    subject: Annotated[str, Field(min_length=1, max_length=150)] | None = None
    last_read_seq: Annotated[int, Field(ge=0)] | None = None
    read_at: float | None = None


@dataclass(frozen=True)
class _BufferedEvent:
    subjects: frozenset[str]
    include_admins: bool
    payload: dict


@dataclass(eq=False)
class _Subscriber:
    tenant: str
    subject: str
    is_admin: bool
    loop: asyncio.AbstractEventLoop
    queue: asyncio.Queue[dict]


class EventSubscription:
    """Async subscription supporting both `async with sub as queue` and `async for`."""

    def __init__(self, hub: EventHub, subscriber: _Subscriber):
        self._hub = hub
        self._subscriber = subscriber
        self.queue = subscriber.queue
        self._closed = False

    async def __aenter__(self) -> asyncio.Queue[dict]:
        return self.queue

    async def __aexit__(self, exc_type, exc, tb) -> None:
        self.close()

    def close(self) -> None:
        if not self._closed:
            self._closed = True
            self._hub._unsubscribe(self._subscriber)

    async def aclose(self) -> None:
        self.close()

    def __aiter__(self) -> EventSubscription:
        return self

    async def __anext__(self) -> dict:
        if self._closed:
            raise StopAsyncIteration
        return await self.queue.get()


def _deliver_to_queue(queue: asyncio.Queue[dict], payload: dict) -> None:
    if queue.full():
        try:
            queue.get_nowait()
        except asyncio.QueueEmpty:
            pass
    try:
        queue.put_nowait(payload)
    except asyncio.QueueFull:
        pass


class EventHub:
    """Thread-safe pub/sub bridge between sync worker-thread endpoints and async SSE streams."""

    def __init__(self, *, history_limit: int = RING_BUFFER_LIMIT, workflow=None):
        self._lock = threading.RLock()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._workflow = workflow
        self._history_limit = max(1, history_limit)
        self._recent: dict[str, deque[_BufferedEvent]] = defaultdict(
            lambda: deque(maxlen=self._history_limit)
        )
        self._subscribers: dict[str, set[_Subscriber]] = defaultdict(set)

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        with self._lock:
            self._loop = loop

    def bind_workflow(self, workflow) -> None:
        with self._lock:
            self._workflow = workflow

    def subscribe(self, tenant: str, subject: str, *, is_admin: bool = False) -> EventSubscription:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            with self._lock:
                loop = self._loop
            if loop is None:
                raise RuntimeError("EventHub requires an active asyncio loop or bind_loop() call")
        subscriber = _Subscriber(
            tenant=tenant,
            subject=subject,
            is_admin=is_admin,
            loop=loop,
            queue=asyncio.Queue(maxsize=SUBSCRIBER_QUEUE_LIMIT),
        )
        with self._lock:
            self._subscribers[tenant].add(subscriber)
        return EventSubscription(self, subscriber)

    def _unsubscribe(self, subscriber: _Subscriber) -> None:
        with self._lock:
            bucket = self._subscribers.get(subscriber.tenant)
            if bucket is not None:
                bucket.discard(subscriber)
                if not bucket:
                    self._subscribers.pop(subscriber.tenant, None)

    def subscriber_count(self, tenant: str | None = None) -> int:
        with self._lock:
            if tenant is not None:
                return len(self._subscribers.get(tenant, ()))
            return sum(len(bucket) for bucket in self._subscribers.values())

    def _persist_event(self, workflow, tenant: str, target_subjects: frozenset[str], include_admins: bool, payload: dict) -> dict:
        event_id = str(payload["id"])
        subjects_json = json.dumps(sorted(target_subjects), ensure_ascii=False, separators=(",", ":"))
        event_kind = str(payload.get("kind") or "work_alert")[:64]
        created_at = float(payload.get("created_at") or time.time())
        is_pg = bool(getattr(getattr(workflow, "db", None), "dsn", None))

        for attempt in range(5):
            try:
                with workflow.tx(tenant, write=True, bounded=True) as run:
                    _ensure_durable_event_table_sqlite(workflow, run)
                    if is_pg:
                        lock_key = json.dumps(["durable-event-v1", tenant], separators=(",", ":"))
                        run("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", (lock_key,))
                    existing = run(
                        "SELECT seq, payload_json FROM aios_durable_event WHERE tenant = ? AND id = ?",
                        (tenant, event_id),
                    ).fetchone()
                    if existing is not None:
                        stored_payload = json.loads(existing["payload_json"])
                        stored_payload["seq"] = int(existing["seq"])
                        return stored_payload
                    row = run(
                        "SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM aios_durable_event WHERE tenant = ?",
                        (tenant,),
                    ).fetchone()
                    next_seq = int(row["next_seq"])
                    persisted_payload = dict(payload)
                    persisted_payload["seq"] = next_seq
                    payload_json = json.dumps(persisted_payload, ensure_ascii=False, separators=(",", ":"))
                    run(
                        """INSERT INTO aios_durable_event
                           (tenant, seq, id, subjects_json, include_admins, event_kind, payload_json, created_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                        (
                            tenant,
                            next_seq,
                            event_id,
                            subjects_json,
                            int(bool(include_admins)),
                            event_kind,
                            payload_json,
                            created_at,
                        ),
                    )
                    if is_pg:
                        notify_payload = json.dumps(
                            {"tenant": tenant, "seq": next_seq, "id": event_id, "kind": event_kind},
                            ensure_ascii=False,
                            separators=(",", ":"),
                        )
                        run("SELECT pg_notify('aios_events', ?)", (notify_payload,))
                    return persisted_payload
            except (sqlite3.IntegrityError, PgIntegrityError):
                if attempt == 4:
                    raise
        return payload

    def publish(
        self,
        tenant: str,
        subjects: Iterable[str],
        event: dict | WorkEvent,
        *,
        include_admins: bool = False,
    ) -> dict:
        validated = event if isinstance(event, WorkEvent) else WorkEvent.model_validate(event)
        payload = validated.model_dump(mode="json", exclude_none=True)
        target_subjects = frozenset(subjects)

        with self._lock:
            workflow = self._workflow

        if workflow is not None and getattr(workflow, "db", None) is not None and hasattr(workflow, "tx"):
            payload = self._persist_event(workflow, tenant, target_subjects, include_admins, payload)

        record = _BufferedEvent(subjects=target_subjects, include_admins=include_admins, payload=payload)

        with self._lock:
            self._recent[tenant].append(record)
            candidates = list(self._subscribers.get(tenant, ()))
            fallback_loop = self._loop

        targets: list[_Subscriber] = []
        stale: list[_Subscriber] = []
        for sub in candidates:
            target_loop = sub.loop if not sub.loop.is_closed() else fallback_loop
            if target_loop is None or target_loop.is_closed():
                stale.append(sub)
                continue
            if _is_visible_to(target_subjects, include_admins, sub.subject, sub.is_admin):
                targets.append(sub)

        if stale:
            with self._lock:
                bucket = self._subscribers.get(tenant)
                if bucket is not None:
                    for sub in stale:
                        bucket.discard(sub)

        for sub in targets:
            target_loop = sub.loop if not sub.loop.is_closed() else fallback_loop
            if target_loop is None or target_loop.is_closed():
                continue
            try:
                target_loop.call_soon_threadsafe(_deliver_to_queue, sub.queue, dict(payload))
            except RuntimeError:
                self._unsubscribe(sub)

        return payload

    def recent(
        self,
        tenant: str,
        subject: str,
        *,
        is_admin: bool = False,
        limit: int = 20,
    ) -> list[dict]:
        capped = max(0, min(limit, self._history_limit))
        if capped == 0:
            return []
        with self._lock:
            workflow = self._workflow
            entries = list(self._recent.get(tenant, ()))

        matched_mem = [
            dict(entry.payload)
            for entry in reversed(entries)
            if _is_visible_to(entry.subjects, entry.include_admins, subject, is_admin)
        ]

        if workflow is not None and getattr(workflow, "db", None) is not None and hasattr(workflow, "tx"):
            scan_limit = max(capped * 8, 250)
            with workflow.tx(tenant, write=False, bounded=True) as run:
                _ensure_durable_event_table_sqlite(workflow, run)
                rows = run(
                    """SELECT seq, subjects_json, include_admins, payload_json
                       FROM aios_durable_event
                       WHERE tenant = ?
                       ORDER BY created_at DESC, seq DESC
                       LIMIT ?""",
                    (tenant, scan_limit),
                ).fetchall()
            matched_db: list[dict] = []
            seen_ids: set[str] = set()
            for row in rows:
                subjects = json.loads(row["subjects_json"])
                if not _is_visible_to(subjects, bool(row["include_admins"]), subject, is_admin):
                    continue
                payload = json.loads(row["payload_json"])
                payload.setdefault("seq", int(row["seq"]))
                eid = str(payload.get("id", ""))
                if eid:
                    seen_ids.add(eid)
                matched_db.append(payload)
                if len(matched_db) >= capped:
                    break
            if matched_db:
                for mem_item in matched_mem:
                    if len(matched_db) >= capped:
                        break
                    eid = str(mem_item.get("id", ""))
                    if not eid or eid not in seen_ids:
                        matched_db.append(mem_item)
                        if eid:
                            seen_ids.add(eid)
                return matched_db[:capped]

        return matched_mem[:capped]

    def since_event(
        self,
        tenant: str,
        subject: str,
        last_event_id: str,
        *,
        is_admin: bool = False,
    ) -> list[dict]:
        """Return visible events buffered or persisted strictly after last_event_id in chronological order."""
        if not isinstance(last_event_id, str) or not last_event_id:
            return []
        with self._lock:
            workflow = self._workflow
            entries = list(self._recent.get(tenant, ()))

        if workflow is not None and getattr(workflow, "db", None) is not None and hasattr(workflow, "tx"):
            with workflow.tx(tenant, write=False, bounded=True) as run:
                _ensure_durable_event_table_sqlite(workflow, run)
                anchor = run(
                    "SELECT seq FROM aios_durable_event WHERE tenant = ? AND id = ?",
                    (tenant, last_event_id),
                ).fetchone()
                if anchor is not None:
                    rows = run(
                        """SELECT seq, subjects_json, include_admins, payload_json
                           FROM aios_durable_event
                           WHERE tenant = ? AND seq > ?
                           ORDER BY seq ASC
                           LIMIT 500""",
                        (tenant, int(anchor["seq"])),
                    ).fetchall()
                    out: list[dict] = []
                    for row in rows:
                        subjects = json.loads(row["subjects_json"])
                        if not _is_visible_to(subjects, bool(row["include_admins"]), subject, is_admin):
                            continue
                        payload = json.loads(row["payload_json"])
                        payload.setdefault("seq", int(row["seq"]))
                        out.append(payload)
                    return out

        anchor_idx: int | None = None
        for idx, entry in enumerate(entries):
            if entry.payload.get("id") == last_event_id:
                anchor_idx = idx
                break
        if anchor_idx is None:
            return []
        return [
            dict(entry.payload)
            for entry in entries[anchor_idx + 1 :]
            if _is_visible_to(entry.subjects, entry.include_admins, subject, is_admin)
        ]
