"""Governed case review, durable parallel tracks, and safe API projection."""
from hashlib import sha256
import json
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


class ReviewRequest(Strict):
    client_id: Identifier
    instruction: Annotated[str, Field(max_length=500)] = ""


class TrackDecision(Strict):
    track: Track
    action: Literal["approve", "reject"]
    snapshot: Digest


class Assurance:
    def __init__(self, source: CaseSource, gateway: ReviewGateway, *, restrictions: CaseRestrictions | None = None):
        self.source, self.gateway, self.restrictions = source, gateway, restrictions
        self.audit = gateway.audit
        self.workflow = self.audit.workflow

    def case(self, actor: Actor, reference: str) -> Case:
        case = self.source.get(actor.tenant, reference, actor.warehouses)
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
    def _review(run, tenant: str, identifier: str, lock: str = ""):
        row = run("SELECT * FROM aios_assurance_review WHERE tenant = ? AND id = ?" + lock,
                  (tenant, identifier)).fetchone()
        if not row:
            raise KeyError(identifier)
        return row

    @staticmethod
    def _view(row, *, stale: bool):
        return {key: row[key] for key in ("id", "case_id", "site", "requester", "state", "snapshot")} | {
            **json.loads(row["report"]), "decisions": json.loads(row["decisions"]), "stale": stale,
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

    def create(self, actor: Actor, reference: str, request: ReviewRequest):
        case = self.case(actor, reference)
        run_id = self.gateway.run_id()
        self.gateway.check_instruction(actor, case, run_id, request.instruction)
        identifier = digest_of({"case": reference, "actor": actor.subject, "client_id": request.client_id})
        snapshot, facts = self.visible_snapshot(actor, case)
        binding = digest_of({"snapshot": snapshot,
                             "instruction": sha256(request.instruction.encode()).hexdigest()})
        with self.workflow.tx(actor.tenant, write=False) as run:
            try:
                existing = self._review(run, actor.tenant, identifier)
            except KeyError:
                existing = None
        if existing:
            if existing["binding"] != binding:
                raise Conflict("Review key or source snapshot changed")
            return self.expose(actor, existing)
        tracks, flags = route(case.kind, facts)
        model_findings = self.gateway.suggestions(actor, case, run_id, facts)
        initial_state = "HELD" if HARD_HOLDS.intersection(flags) else "PENDING"
        report = {"kind": case.kind, "revision": case.revision, "policy": SCHEMA_VERSION, "tracks": tracks,
                  "rule_findings": flags, "model_findings": model_findings, "run_id": run_id}
        with self.workflow.tx(actor.tenant) as run:
            inserted = run("""INSERT INTO aios_assurance_review VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                              ON CONFLICT (tenant, id) DO NOTHING""", (
                actor.tenant, identifier, reference, case.site, actor.subject, binding, snapshot,
                initial_state, canonical(report), "{}",
            )).rowcount
            if inserted:
                self.audit.append(actor, run_id, "REVIEW_CREATED", canonical({
                    "review": identifier, "snapshot": snapshot, "state": initial_state, "tracks": tracks,
                }).encode(), transaction=run)
            row = self._review(run, actor.tenant, identifier)
            if row["binding"] != binding:
                raise Conflict("Review key or source snapshot changed")
        return self.expose(actor, row)

    def get(self, actor: Actor, identifier: str):
        with self.workflow.tx(actor.tenant, write=False) as run:
            row = self._review(run, actor.tenant, identifier)
        return self.expose(actor, row)

    def decide(self, actor: Actor, identifier: str, decision: TrackDecision):
        if TRACK_GRANTS[decision.track] not in actor.grants:
            raise PermissionError("Approval track is not assigned")
        # Read the external source before taking the short database lock.
        current = self.get(actor, identifier)
        if current["stale"] or current["snapshot"] != decision.snapshot:
            raise Conflict("Source version or reviewed snapshot changed")
        with self.workflow.tx(actor.tenant) as run:
            lock = " FOR UPDATE" if self.workflow.db.dsn else ""
            row = self._review(run, actor.tenant, identifier, lock)
            report = json.loads(row["report"])
            decisions = json.loads(row["decisions"])
            if actor.subject == row["requester"] or decision.track not in report["tracks"] or (
                self.workflow._suspended(run, actor.tenant, actor.subject, row["requester"])
            ):
                raise PermissionError("An independent active approver is required")
            prior = decisions.get(decision.track)
            if prior == {"actor": actor.subject, "action": decision.action}:
                return self._view(row, stale=False)
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
        with self.workflow.tx(actor.tenant, write=False) as run:
            rows = run("""SELECT * FROM aios_assurance_review
                          WHERE tenant = ? AND case_id = ? AND site = ? AND id > ?
                          ORDER BY id LIMIT ?""", (actor.tenant, reference, case.site, after, limit)).fetchall()
        return [self._view(row, stale=(snapshot != row["snapshot"])) for row in rows]


def assurance_routes(authenticate, service: Assurance | None) -> APIRouter:
    router = APIRouter(prefix="/v1/assurance", tags=["Governed assurance"])

    def current() -> Assurance:
        if service is None:
            raise HTTPException(503, "Assurance connectors are unconfigured")
        return service

    def call(action, *args):
        try:
            return action(*args)
        except GateFailure as error:
            headers = {"Retry-After": "60"} if error.status == 429 else None
            raise HTTPException(error.status, {"code": error.code}, headers=headers) from error
        except KeyError as error:
            raise HTTPException(404, "Assurance object is unavailable") from error
        except PermissionError as error:
            raise HTTPException(403, str(error)) from error
        except Conflict as error:
            raise HTTPException(409, str(error)) from error
        except ValueError as error:
            raise HTTPException(422, {"code": "EVIDENCE_INVALID_OR_RESTRICTED"}) from error

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
        return current().audit.checkpoint(actor.tenant)

    return router
