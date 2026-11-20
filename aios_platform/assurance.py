"""Governed case review, durable parallel tracks, and safe API projection."""
from hashlib import sha256
import json
from threading import BoundedSemaphore
from time import time
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import Field

from aios_demo.storage import canonical, digest_of

from .assurance_gateway import GateFailure, ReviewGateway
from .assurance_policy import (
    HARD_HOLDS, SCHEMA_VERSION, TRACK_GRANTS, Case, CaseRestrictions, CaseSource, Track,
    may_read, project, route, snapshot_digest,
)
from .contracts import Actor, Identifier, Strict
from .workflow import Conflict

Digest = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
REVIEW_PROJECTION = """SELECT r.*, a.expires_at FROM aios_assurance_review AS r
                       LEFT JOIN aios_assurance_attempt AS a ON a.tenant = r.tenant AND a.id = r.id"""
IN_FLIGHT_SECONDS = 120


class ReviewRequest(Strict):
    client_id: Identifier
    instruction: Annotated[str, Field(max_length=500)] = ""


class TrackDecision(Strict):
    track: Track
    action: Literal["approve", "reject"]
    snapshot: Digest


class Assurance:
    def __init__(self, source: CaseSource, gateway: ReviewGateway, *,
                 restrictions: CaseRestrictions | None = None, review_ttl: int = 3600):
        if not 1 <= review_ttl <= 86400:
            raise ValueError("Assurance review TTL must be between one second and one day")
        self.review_ttl = review_ttl
        self.source, self.gateway, self.restrictions = source, gateway, restrictions
        self.audit = gateway.audit
        self.workflow = self.audit.workflow

    def case(self, actor: Actor, reference: str) -> Case:
        try:
            case = self.source.get(actor.tenant, reference, actor.warehouses)
        except (TimeoutError, ConnectionError) as error:
            raise GateFailure("ASSURANCE_SOURCE_UNAVAILABLE", 503, retry_after=2) from error
        if not case or case.id != reference or case.zone != self.gateway.zone or not may_read(actor, case):
            raise KeyError(reference)
        return case

    def projection(self, actor: Actor, case: Case, *, audience):
        rule = self.restrictions(actor, case) if self.restrictions else None
        return project(actor, case, audience=audience, restrictions=rule)

    def case_view(self, actor: Actor, reference: str) -> dict:
        case = self.case(actor, reference)
        return {"id": case.id, "kind": case.kind, "site": case.site, "revision": case.revision,
                "policy": SCHEMA_VERSION, "fields": self.projection(actor, case, audience="employee")}

    @staticmethod
    def _review(run, tenant: str, identifier: str, *, required: bool = True, lock: str = ""):
        row = run(REVIEW_PROJECTION + " WHERE r.tenant = ? AND r.id = ?" + lock,
                  (tenant, identifier)).fetchone()
        if row is None and required:
            raise KeyError(identifier)
        return row

    @staticmethod
    def _expired(row):
        return row["state"] in {"PENDING", "HELD"} and (row["expires_at"] or 0) <= int(time())

    @staticmethod
    def _view(row, *, stale: bool):
        return {key: row[key] for key in ("id", "case_id", "site", "requester", "state", "snapshot")} | {
            **json.loads(row["report"]), "decisions": json.loads(row["decisions"]), "stale": stale,
            "expires_at": row["expires_at"], "expired": Assurance._expired(row),
        }

    def visible_snapshot(self, actor: Actor, case: Case) -> tuple[str, dict]:
        facts = self.projection(actor, case, audience="model")
        return snapshot_digest(case, facts), facts

    def expose(self, actor: Actor, row):
        case = self.case(actor, row["case_id"])
        if case.site != row["site"]:
            raise KeyError(row["id"])
        snapshot, facts = self.visible_snapshot(actor, case)
        try:
            route(case.kind, facts)
        except ValueError as error:
            raise KeyError(row["id"]) from error
        return self._view(row, stale=(snapshot != row["snapshot"]))

    def _claim(self, run, actor, identifier, binding, run_id):
        if self.workflow._suspended(run, actor.tenant, actor.subject):
            raise PermissionError("An active requester is required")
        now = int(time())
        changed = run("""INSERT INTO aios_assurance_attempt VALUES (?, ?, ?, ?, ?, ?, 'RUNNING')
                        ON CONFLICT (tenant, id) DO UPDATE
                          SET run_id = excluded.run_id, started_at = excluded.started_at,
                              expires_at = excluded.expires_at, state = 'RUNNING'
                        WHERE aios_assurance_attempt.binding = excluded.binding
                          AND aios_assurance_attempt.state = 'RETRYABLE'""",
                      (actor.tenant, identifier, binding, run_id, now, now + self.review_ttl)).rowcount
        if changed:
            return None
        attempt = run("""SELECT binding, run_id, started_at, state FROM aios_assurance_attempt
                         WHERE tenant = ? AND id = ?""", (actor.tenant, identifier)).fetchone()
        if attempt["binding"] != binding:
            raise GateFailure("REVIEW_REQUEST_CONFLICT", 409)
        if attempt["state"] == "COMPLETE":
            return self._review(run, actor.tenant, identifier)
        if attempt["state"] == "FAILED":
            raise GateFailure("REVIEW_ATTEMPT_FAILED", 409, run_id=attempt["run_id"])
        if attempt["state"] == "RUNNING" and now < attempt["started_at"] + IN_FLIGHT_SECONDS:
            raise GateFailure("REVIEW_IN_PROGRESS", 409, retry_after=2, run_id=attempt["run_id"])
        # A process may have sent a request before it died. A timeout never releases ownership.
        raise GateFailure("REVIEW_OUTCOME_UNKNOWN", 409, run_id=attempt["run_id"])

    def _finish(self, run, actor, case, identifier, binding, snapshot, report, initial_state):
        if self.workflow._suspended(run, actor.tenant, actor.subject):
            raise PermissionError("An active requester is required")
        run_id = report["run_id"]
        changed = run("""UPDATE aios_assurance_attempt SET state = 'COMPLETE'
                         WHERE tenant = ? AND id = ? AND run_id = ? AND state = 'RUNNING' AND expires_at > ?""",
                      (actor.tenant, identifier, run_id, int(time()))).rowcount
        if not changed:
            raise GateFailure("REVIEW_OUTCOME_UNKNOWN", 409, run_id=run_id)
        run("INSERT INTO aios_assurance_review VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", (
            actor.tenant, identifier, case.id, case.site, actor.subject, binding, snapshot,
            initial_state, canonical(report), "{}",
        ))
        self.audit.append(actor, run_id, "REVIEW_CREATED", canonical({
            "review": identifier, "snapshot": snapshot, "state": initial_state, "tracks": report["tracks"],
        }).encode(), transaction=run)
        return self._review(run, actor.tenant, identifier)

    def create(self, actor: Actor, reference: str, request: ReviewRequest):
        case = self.case(actor, reference)
        run_id = self.gateway.run_id()
        self.gateway.check_instruction(actor, case, run_id, request.instruction)
        identifier = digest_of({"case": reference, "actor": actor.subject, "client_id": request.client_id})
        snapshot, facts = self.visible_snapshot(actor, case)
        binding = digest_of({"snapshot": snapshot, "instruction": sha256(request.instruction.encode()).hexdigest()})
        with self.workflow.tx(actor.tenant, write=False, bounded=True) as run:
            existing = self._review(run, actor.tenant, identifier, required=False)
        if existing:
            if existing["binding"] != binding:
                raise GateFailure("REVIEW_REQUEST_CONFLICT", 409)
            return self._view(existing, stale=False)
        tracks, flags = route(case.kind, facts)
        initial_state = "HELD" if HARD_HOLDS.intersection(flags) else "PENDING"
        report = {"kind": case.kind, "revision": case.revision, "policy": SCHEMA_VERSION, "tracks": tracks,
                  "rule_findings": flags, "model_findings": [], "run_id": run_id}
        with self.workflow.tx(actor.tenant, bounded=True) as run:
            existing = self._claim(run, actor, identifier, binding, run_id)
            if existing:
                return self._view(existing, stale=False)
            if self.gateway.provider is None:
                row = self._finish(run, actor, case, identifier, binding, snapshot, report, initial_state)
                return self._view(row, stale=False)
        try:
            report["model_findings"] = self.gateway.suggestions(actor, case, run_id, facts)
            refreshed = self.case(actor, reference)
            if self.visible_snapshot(actor, refreshed)[0] != snapshot:
                raise GateFailure("REVIEW_SOURCE_CHANGED", 409)
            with self.workflow.tx(actor.tenant, bounded=True) as run:
                row = self._finish(run, actor, case, identifier, binding, snapshot, report, initial_state)
        except (GateFailure, PermissionError, KeyError) as error:
            safe_retry = isinstance(error, GateFailure) and error.code == "MODEL_BUDGET_EXHAUSTED"
            with self.workflow.tx(actor.tenant, bounded=True) as run:
                run("""UPDATE aios_assurance_attempt SET state = ? WHERE tenant = ? AND id = ?
                       AND run_id = ? AND state = 'RUNNING'""",
                    ("RETRYABLE" if safe_retry else "FAILED", actor.tenant, identifier, run_id))
            if isinstance(error, GateFailure):
                error.run_id = run_id
            raise
        return self._view(row, stale=False)

    def get(self, actor: Actor, identifier: str):
        with self.workflow.tx(actor.tenant, write=False, bounded=True) as run:
            row = self._review(run, actor.tenant, identifier)
        return self.expose(actor, row)

    def decide(self, actor: Actor, identifier: str, decision: TrackDecision):
        if TRACK_GRANTS[decision.track] not in actor.grants:
            raise PermissionError("Approval track is not assigned")
        # Read the external source before taking the short database lock.
        current = self.get(actor, identifier)
        if current["stale"] or current["snapshot"] != decision.snapshot:
            raise GateFailure("REVIEW_SNAPSHOT_CONFLICT", 409)
        with self.workflow.tx(actor.tenant, bounded=True) as run:
            lock = " FOR UPDATE OF r" if self.workflow.db.dsn else ""
            row = self._review(run, actor.tenant, identifier, lock=lock)
            report = json.loads(row["report"])
            decisions = json.loads(row["decisions"])
            if actor.subject == row["requester"] or decision.track not in report["tracks"] or (
                self.workflow._suspended(run, actor.tenant, actor.subject, row["requester"])
            ):
                raise PermissionError("An independent active approver is required")
            prior = decisions.get(decision.track)
            if prior == {"actor": actor.subject, "action": decision.action}:
                return self._view(row, stale=False)
            if self._expired(row):
                raise GateFailure("REVIEW_EXPIRED", 409)
            if prior or row["state"] not in {"PENDING", "HELD"} or (
                row["state"] == "HELD" and decision.action == "approve"
            ):
                raise Conflict("This review cannot accept the decision")
            if any(item["actor"] == actor.subject for item in decisions.values()):
                raise PermissionError("Approval tracks require distinct approvers")
            decisions[decision.track] = {"actor": actor.subject, "action": decision.action}
            state = ("REJECTED" if decision.action == "reject" else
                     "APPROVED" if set(decisions) == set(report["tracks"]) else "PENDING")
            run("UPDATE aios_assurance_review SET state = ?, decisions = ? WHERE tenant = ? AND id = ?",
                (state, canonical(decisions), actor.tenant, identifier))
            self.audit.append(actor, report["run_id"], "TRACK_DECIDED", canonical({
                "review": identifier, "snapshot": decision.snapshot, "track": decision.track,
                "action": decision.action, "state": state,
            }).encode(), transaction=run)
            return self._view(self._review(run, actor.tenant, identifier), stale=False)

    def case_reviews(self, actor: Actor, reference: str, limit: int, after: str):
        case = self.case(actor, reference)
        snapshot, facts = self.visible_snapshot(actor, case)
        try:
            route(case.kind, facts)
        except ValueError as error:
            raise KeyError(reference) from error
        with self.workflow.tx(actor.tenant, write=False, bounded=True) as run:
            rows = run(REVIEW_PROJECTION + """ WHERE r.tenant = ? AND r.case_id = ? AND r.site = ? AND r.id > ?
                                             ORDER BY r.id LIMIT ?""",
                       (actor.tenant, reference, case.site, after, limit)).fetchall()
        return [self._view(row, stale=(snapshot != row["snapshot"])) for row in rows]


def assurance_routes(authenticate, service: Assurance | None, *, concurrency: int = 8) -> APIRouter:
    if not 1 <= concurrency <= 32:
        raise ValueError("Assurance concurrency must be between one and 32 per process")
    router = APIRouter(prefix="/v1/assurance", tags=["Governed assurance"])
    slots = BoundedSemaphore(concurrency)

    def current() -> Assurance:
        if service is None:
            raise HTTPException(503, "Assurance connectors are unconfigured")
        return service

    def call(action, *args):
        if not slots.acquire(blocking=False):
            raise HTTPException(503, {"code": "ASSURANCE_OVERLOADED"}, headers={"Retry-After": "2"})
        try:
            return action(*args)
        except GateFailure as error:
            headers = {"Retry-After": str(error.retry_after)} if error.retry_after else None
            detail = {"code": error.code}
            if error.run_id is not None:
                detail["run_id"] = error.run_id
            raise HTTPException(error.status, detail, headers=headers) from error
        except KeyError as error:
            raise HTTPException(404, "Assurance object is unavailable") from error
        except PermissionError as error:
            raise HTTPException(403, str(error)) from error
        except Conflict as error:
            raise HTTPException(409, str(error)) from error
        except ValueError as error:
            raise HTTPException(422, {"code": "EVIDENCE_INVALID_OR_RESTRICTED"}) from error
        finally:
            slots.release()

    @router.get("/cases/{reference}")
    def case_view(reference: Identifier, actor: Actor = Depends(authenticate)):
        return call(current().case_view, actor, reference)

    @router.post("/cases/{reference}/reviews", status_code=201)
    def create(reference: Identifier, body: ReviewRequest, actor: Actor = Depends(authenticate)):
        return call(current().create, actor, reference, body)

    @router.get("/cases/{reference}/reviews")
    def reviews(reference: Identifier, actor: Actor = Depends(authenticate),
                limit: Annotated[int, Query(ge=1, le=100)] = 50, after: Identifier | None = None):
        rows = call(current().case_reviews, actor, reference, limit + 1, after or "")
        return {"items": rows[:limit], "next": rows[limit - 1]["id"] if len(rows) > limit else None}

    @router.get("/reviews/{identifier}")
    def review(identifier: Identifier, actor: Actor = Depends(authenticate)):
        return call(current().get, actor, identifier)

    @router.post("/reviews/{identifier}/decisions")
    def decide(identifier: Identifier, body: TrackDecision, actor: Actor = Depends(authenticate)):
        return call(current().decide, actor, identifier, body)

    @router.get("/audit/checkpoint")
    def checkpoint(actor: Actor = Depends(authenticate)):
        if "assurance.audit" not in actor.grants:
            raise HTTPException(403, "Audit permission required")
        return call(current().audit.checkpoint, actor.tenant)

    return router
