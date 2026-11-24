"""Thread-safe in-process event hub for SSE streams and work-pulse hydration."""
from __future__ import annotations

import asyncio
from collections import defaultdict, deque
from collections.abc import Iterable
from dataclasses import dataclass
import threading
import time
from typing import Annotated, Literal
from uuid import uuid4

from pydantic import Field

from .contracts import Strict

RING_BUFFER_LIMIT = 50
SUBSCRIBER_QUEUE_LIMIT = 100


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

    def __init__(self, *, history_limit: int = RING_BUFFER_LIMIT):
        self._lock = threading.RLock()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._history_limit = max(1, history_limit)
        self._recent: dict[str, deque[_BufferedEvent]] = defaultdict(
            lambda: deque(maxlen=self._history_limit)
        )
        self._subscribers: dict[str, set[_Subscriber]] = defaultdict(set)

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        with self._lock:
            self._loop = loop

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
            matches = (
                sub.subject in target_subjects
                or "*" in target_subjects
                or (include_admins and sub.is_admin)
            )
            if matches:
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
            entries = list(self._recent.get(tenant, ()))
        matched = [
            dict(entry.payload)
            for entry in reversed(entries)
            if subject in entry.subjects or "*" in entry.subjects or (is_admin and entry.include_admins)
        ]
        return matched[:capped]

    def since_event(
        self,
        tenant: str,
        subject: str,
        last_event_id: str,
        *,
        is_admin: bool = False,
    ) -> list[dict]:
        """Return visible events buffered strictly after last_event_id in chronological order."""
        if not isinstance(last_event_id, str) or not last_event_id:
            return []
        with self._lock:
            entries = list(self._recent.get(tenant, ()))
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
            if subject in entry.subjects or "*" in entry.subjects or (is_admin and entry.include_admins)
        ]
