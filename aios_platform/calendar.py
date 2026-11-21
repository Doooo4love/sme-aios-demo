"""Transactional internal scheduling. External delivery is a separate integration."""
from datetime import timedelta
from typing import Annotated
import time

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import AwareDatetime, Field, model_validator

from aios_demo.storage import digest_of

from .collaboration import InvalidCollaborationRequest, MissingResource, lock_subjects, notify, subject_tx
from .contracts import Actor, Identifier, Strict
from .module_access import Subject
from .workflow import Conflict


class Meeting(Strict):
    title: Annotated[str, Field(min_length=1, max_length=120)]
    starts_at: AwareDatetime
    ends_at: AwareDatetime

    @model_validator(mode="after")
    def valid_duration(self):
        if not self.title.strip() or not self.title.isprintable():
            raise ValueError("Invalid meeting title")
        start, end = self.starts_at.timestamp(), self.ends_at.timestamp()
        if not 0 <= start < end <= 4_102_444_800 or end - start > 86_400:
            raise ValueError("Meeting must have a positive duration of at most one day")
        return self


class CreateMeeting(Meeting):
    client_id: Identifier
    attendees: Annotated[frozenset[Subject], Field(max_length=20)] = frozenset()
    room_id: Identifier | None = None


class Reschedule(Meeting):
    revision: Annotated[int, Field(strict=True, ge=1, lt=2**63 - 1)]


class MeetingRevision(Strict):
    revision: Annotated[int, Field(strict=True, ge=1, lt=2**63 - 1)]


class ScheduleConflict(Conflict):
    pass


class Calendar:
    def __init__(self, workflow, known_subject):
        self.workflow = workflow
        self.known_subject = known_subject

    @staticmethod
    def _member(run, actor, event_id):
        row = run("""SELECT e.id, e.organizer, e.title, e.starts_at, e.ends_at, e.revision, e.cancelled
                     FROM aios_calendar_event e JOIN aios_calendar_member m
                     ON m.tenant = e.tenant AND m.event_id = e.id
                     WHERE e.tenant = ? AND e.id = ? AND m.subject = ?""",
                  (actor.tenant, event_id, actor.subject)).fetchone()
        if row is None:
            raise MissingResource(event_id)
        return dict(row)

    @staticmethod
    def _attendees(run, tenant, identifier):
        return [row["subject"] for row in run("""SELECT subject FROM aios_calendar_member
                   WHERE tenant = ? AND event_id = ? ORDER BY subject""", (tenant, identifier)).fetchall()]

    @staticmethod
    def _room_members(run, tenant, room):
        return {row["subject"] for row in run("""SELECT subject FROM aios_chat_member
                    WHERE tenant = ? AND room_id = ?""", (tenant, room)).fetchall()}

    @staticmethod
    def _check_conflict(run, tenant, participants, start, end, *, ignore=""):
        marks = ",".join("?" for _ in participants)
        if run(f"""SELECT 1 FROM aios_calendar_member m JOIN aios_calendar_event e
                   ON e.tenant = m.tenant AND e.id = m.event_id WHERE m.tenant = ?
                   AND m.subject IN ({marks}) AND e.cancelled = 0 AND e.id <> ?
                   AND e.starts_at < ? AND e.ends_at > ? LIMIT 1""",
               (tenant, *participants, ignore, end, start)).fetchone():
            raise ScheduleConflict("At least one attendee is busy")

    @staticmethod
    def _view(event):
        return {**event, "cancelled": bool(event["cancelled"]), "source": "internal"}

    def create(self, actor, body):
        participants = sorted(body.attendees | {actor.subject})
        if len(participants) > 1 and body.room_id is None:
            raise InvalidCollaborationRequest("Use an authorized chat room to invite employees")
        identifier = digest_of([actor.subject, body.client_id])
        start, end = body.starts_at.timestamp(), body.ends_at.timestamp()
        fingerprint = digest_of([body.title.strip(), start, end, participants, body.room_id])
        # Check the idempotency record before contacting the directory. Recheck after locking.
        with subject_tx(self.workflow, actor) as run:
            prior = self._prior(run, actor, identifier, fingerprint)
            if prior:
                return prior
        for subject in body.attendees - {actor.subject}:
            if self.known_subject is None or not self.known_subject(actor.tenant, subject):
                raise MissingResource(subject)
        with subject_tx(self.workflow, actor, write=True) as run:
            lock_subjects(self.workflow, run, actor.tenant, "calendar-v1", participants)
            prior = self._prior(run, actor, identifier, fingerprint)
            if prior:
                return prior
            if body.room_id:
                if self.workflow.db.dsn:
                    run("SELECT id FROM aios_chat_room WHERE tenant = ? AND id = ? FOR UPDATE",
                        (actor.tenant, body.room_id)).fetchone()
                if not set(participants) <= self._room_members(run, actor.tenant, body.room_id):
                    raise MissingResource(body.room_id)
            if self.workflow._suspended(run, actor.tenant, *participants):
                raise MissingResource(identifier)
            if start < time.time():
                raise InvalidCollaborationRequest("Meeting must start in the future")
            self._check_conflict(run, actor.tenant, participants, start, end)
            run("INSERT INTO aios_calendar_event VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0)",
                (actor.tenant, identifier, actor.subject, body.title.strip(), start, end, fingerprint))
            for subject in participants:
                run("INSERT INTO aios_calendar_member VALUES (?, ?, ?)", (actor.tenant, identifier, subject))
            notify(run, actor.tenant, body.attendees - {actor.subject}, "meeting_created", identifier)
            return self._view(self._member(run, actor, identifier))

    def _prior(self, run, actor, identifier, fingerprint):
        stored = run("SELECT fingerprint FROM aios_calendar_event WHERE tenant = ? AND id = ? AND organizer = ?",
                     (actor.tenant, identifier, actor.subject)).fetchone()
        if stored is None:
            return None
        if stored["fingerprint"] != fingerprint:
            raise Conflict("Meeting client ID is bound to a different request")
        return self._view(self._member(run, actor, identifier))

    def get(self, actor, identifier):
        with subject_tx(self.workflow, actor) as run:
            event = self._member(run, actor, identifier)
            return {**self._view(event), "attendees": self._attendees(run, actor.tenant, identifier)}

    def change(self, actor, identifier, body, *, cancel=False):
        with subject_tx(self.workflow, actor, write=True) as run:
            event = self._member(run, actor, identifier)
            if event["organizer"] != actor.subject:
                raise PermissionError("Only the organizer may change the meeting")
            attendees = self._attendees(run, actor.tenant, identifier)
            lock_subjects(self.workflow, run, actor.tenant, "calendar-v1", attendees)
            event = self._member(run, actor, identifier)
            if event["cancelled"] and cancel:
                return self._view(event)
            if event["revision"] != body.revision or event["cancelled"]:
                raise Conflict("Meeting has changed")
            if cancel:
                title, start, end = event["title"], event["starts_at"], event["ends_at"]
            else:
                title, start, end = body.title.strip(), body.starts_at.timestamp(), body.ends_at.timestamp()
                if start < time.time():
                    raise InvalidCollaborationRequest("Meeting must start in the future")
                self._check_conflict(run, actor.tenant, attendees, start, end, ignore=identifier)
            changed = run("""UPDATE aios_calendar_event SET title = ?, starts_at = ?, ends_at = ?,
                            revision = revision + 1, cancelled = ?
                            WHERE tenant = ? AND id = ? AND revision = ? AND cancelled = 0""",
                          (title, start, end, int(cancel), actor.tenant, identifier, body.revision))
            if changed.rowcount != 1:
                raise Conflict("Meeting has changed")
            notify(run, actor.tenant, set(attendees) - {actor.subject},
                   "meeting_cancelled" if cancel else "meeting_changed", identifier)
            return self._view(self._member(run, actor, identifier))

    def agenda(self, actor, start, end, limit, after):
        cursor = " AND (e.starts_at, e.id) > (?, ?)" if after else ""
        with subject_tx(self.workflow, actor) as run:
            rows = run(f"""SELECT e.id, e.organizer, e.title, e.starts_at, e.ends_at, e.revision, e.cancelled
                           FROM aios_calendar_member m JOIN aios_calendar_event e
                           ON e.tenant = m.tenant AND e.id = m.event_id
                           WHERE m.tenant = ? AND m.subject = ? AND e.starts_at < ? AND e.ends_at > ?
                           {cursor} ORDER BY e.starts_at, e.id LIMIT ?""",
                       (actor.tenant, actor.subject, end, start, *(after or ()), limit + 1)).fetchall()
        items = [self._view(dict(row)) for row in rows[:limit]]
        last = items[-1] if len(rows) > limit else None
        return {"items": items, "next": {"after_start": last["starts_at"], "after_id": last["id"]} if last else None}


def calendar_routes(workflow, authenticate, known_subject):
    calendar = Calendar(workflow, known_subject)
    router = APIRouter(prefix="/v1/calendar", tags=["Internal calendar"])

    @router.get("/events")
    def agenda(start: AwareDatetime, end: AwareDatetime, actor: Actor = Depends(authenticate),
               limit: Annotated[int, Query(ge=1, le=100)] = 50,
               after_start: Annotated[float | None, Query(ge=0, le=4_102_444_800)] = None,
               after_id: Identifier | None = None):
        if not timedelta(0) < end - start <= timedelta(days=93) or (after_start is None) != (after_id is None):
            raise HTTPException(422, "Select a window of up to 93 days and a complete cursor")
        after = None if after_start is None else (after_start, after_id)
        return calendar.agenda(actor, start.timestamp(), end.timestamp(), limit, after)

    @router.post("/events", status_code=201)
    def create(body: CreateMeeting, actor: Actor = Depends(authenticate)):
        return calendar.create(actor, body)

    @router.get("/events/{identifier}")
    def get(identifier: Identifier, actor: Actor = Depends(authenticate)):
        return calendar.get(actor, identifier)

    @router.patch("/events/{identifier}")
    def change(identifier: Identifier, body: Reschedule, actor: Actor = Depends(authenticate)):
        return calendar.change(actor, identifier, body)

    @router.post("/events/{identifier}/cancel")
    def cancel(identifier: Identifier, body: MeetingRevision, actor: Actor = Depends(authenticate)):
        return calendar.change(actor, identifier, body, cancel=True)

    return router
