"""Proposal collaboration, scoped lists and on-demand employee summaries."""
from datetime import timedelta
from typing import Annotated, Literal
import time

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import AwareDatetime, Field

from .calendar import Calendar
from .collaboration import InvalidCollaborationRequest, MissingResource, notify, subject_tx
from .contracts import Actor, Identifier, Plan, Strict
from .erp import plan_digest
from .module_access import Subject
from .providers import action_sites, can_approve, order_read_sites
from .workflow import Conflict


class Decision(Strict):
    digest: Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
    action: Literal["return", "reject", "assign", "release"]
    reason: Annotated[str, Field(min_length=1, max_length=240)] | None = None
    assignee: Subject | None = None


def read_scope(actor, action):
    if action == "sales_order.create_draft":
        return order_read_sites(actor)
    return actor.sites_for("shipment.read") if "shipment.read" in actor.module_scopes else action_sites(actor, action)


class Tasks:
    def __init__(self, workflow, directory_actor):
        self.workflow = workflow
        self.directory_actor = directory_actor

    def review(self, actor, proposal, body):
        plan = Plan.model_validate(proposal["plan"])
        if not can_approve(actor, proposal["requester"], plan):
            raise PermissionError("Independent site approver required")
        assignee = None
        if body.action == "assign":
            if not body.assignee or self.directory_actor is None:
                raise InvalidCollaborationRequest("A verified assignee and a directory are required")
            assignee = self.directory_actor(actor.tenant, body.assignee)
            if assignee is None or (assignee.tenant, assignee.subject) != (actor.tenant, body.assignee):
                raise MissingResource(body.assignee)
        elif body.assignee is not None:
            raise InvalidCollaborationRequest("Assignee is only used when assigning")
        if body.action in {"return", "reject"} and (not body.reason or not body.reason.strip() or not body.reason.isprintable()):
            raise InvalidCollaborationRequest("A reason is required for this decision")
        if body.action in {"assign", "release"} and body.reason is not None:
            raise InvalidCollaborationRequest("A reason is only used for returning or rejecting")
        with subject_tx(self.workflow, actor, write=True) as run:
            row_lock = " FOR UPDATE" if self.workflow.db.dsn else ""
            row = run("SELECT * FROM aios_proposal WHERE tenant = ? AND id = ?" + row_lock,
                      (actor.tenant, proposal["id"])).fetchone()
            if row is None:
                raise MissingResource(proposal["id"])
            plan = Plan.model_validate_json(row["plan"])
            actor = self.workflow._lock_scope(run, actor)
            if not can_approve(actor, row["requester"], plan):
                raise PermissionError("Independent site approver required")
            if body.digest != row["digest"] or body.digest != plan_digest(plan):
                raise Conflict("Preview digest changed")
            key = (actor.tenant, row["id"])
            review = run("SELECT * FROM aios_proposal_review WHERE tenant = ? AND proposal_id = ?", key).fetchone()
            existing = review["assigned_to"] if review else None
            if row["state"] != "PROPOSED" or row["expires"] <= time.time():
                if (row["state"] == "REJECTED" and review and review["decided_by"] == actor.subject
                        and review["decision"] == {"return": "returned", "reject": "rejected"}.get(body.action)
                        and review["reason"] == body.reason):
                    return
                raise Conflict("Proposal expired or was already acted on")
            if existing not in {None, actor.subject} and not (actor.role == "admin" and body.action == "release"):
                raise Conflict("Proposal is assigned to another approver")
            if assignee:
                assignee = self.workflow._lock_scope(run, assignee)
                if not can_approve(assignee, row["requester"], plan):
                    raise PermissionError("Assignee does not have approval access for this site")
            if body.action in {"assign", "release"}:
                target = assignee.subject if assignee else None
                if target != existing:
                    run("""INSERT INTO aios_proposal_review (tenant, proposal_id, assigned_to)
                           VALUES (?, ?, ?) ON CONFLICT (tenant, proposal_id)
                           DO UPDATE SET assigned_to = excluded.assigned_to""", (*key, target))
                    if target and target != actor.subject:
                        notify(run, actor.tenant, [target], "proposal_assigned", row["id"])
                    self.workflow._audit(run, actor.tenant, actor.subject, row["id"],
                                         "REVIEW_ASSIGNED" if target else "REVIEW_RELEASED")
                return
            decision = "returned" if body.action == "return" else "rejected"
            run("""INSERT INTO aios_proposal_review (tenant, proposal_id, decided_by, decision, reason)
                   VALUES (?, ?, ?, ?, ?) ON CONFLICT (tenant, proposal_id)
                   DO UPDATE SET decided_by = excluded.decided_by, decision = excluded.decision,
                                 reason = excluded.reason""", (*key, actor.subject, decision, body.reason))
            run("UPDATE aios_proposal SET state = 'REJECTED' WHERE tenant = ? AND id = ?", key)
            notify(run, actor.tenant, [row["requester"]], "proposal_" + decision, row["id"])
            self.workflow._audit(run, actor.tenant, actor.subject, row["id"],
                                 "REVIEW_RETURNED" if decision == "returned" else "REVIEW_REJECTED")

    def submitted(self, actor, limit, after=None, *, window=None, count=False):
        action_field = self.workflow.proposal_action_field("p.plan")
        ways, params = [], []
        for action in ("sales_order.create_draft", "shipment.reschedule"):
            sites = sorted(read_scope(actor, action))
            if sites:
                slots = ",".join("?" for _ in sites)
                ways.append(f"({action_field} = ? AND p.warehouse IN ({slots}))")
                params.extend((action, *sites))
        if not ways:
            return {} if count else []
        scope = " OR ".join(ways)
        cursor = "AND (p.due, p.id) > (?, ?)" if after else ""
        period = """AND EXISTS (SELECT 1 FROM aios_audit a WHERE a.tenant = p.tenant AND a.target = p.id
                           AND a.event = 'PROPOSED' AND a.at >= ? AND a.at < ?)""" if window else ""
        with subject_tx(self.workflow, actor) as run:
            if count:
                rows = run(f"""SELECT p.state, COUNT(*) AS n FROM aios_proposal p
                               WHERE p.tenant = ? AND p.requester = ? AND ({scope}) {period}
                               GROUP BY p.state""", (actor.tenant, actor.subject, *params, *(window or ()))).fetchall()
                return {row["state"]: row["n"] for row in rows}
            rows = run(f"""SELECT p.id, p.warehouse, p.state, p.expires, p.due, {action_field} AS action,
                                  r.decision, r.assigned_to
                           FROM aios_proposal p LEFT JOIN aios_proposal_review r
                                ON r.tenant = p.tenant AND r.proposal_id = p.id
                           WHERE p.tenant = ? AND p.requester = ? AND ({scope}) {cursor}
                           ORDER BY p.due, p.id LIMIT ?""",
                       (actor.tenant, actor.subject, *params, *(after or ()), limit)).fetchall()
        return [dict(row) for row in rows]


def task_routes(workflow, authenticate, visible_proposal, require_policy, directory_actor):
    tasks = Tasks(workflow, directory_actor)
    router = APIRouter(prefix="/v1", tags=["Tasks and notices"])

    @router.get("/workbench/tasks")
    def queue(lane: Literal["assigned", "submitted"], actor: Actor = Depends(authenticate),
              limit: Annotated[int, Query(ge=1, le=100)] = 50,
              after_due: Annotated[float | None, Query(ge=0, le=1e12)] = None, after_id: Identifier | None = None):
        if (after_due is None) != (after_id is None):
            raise HTTPException(422, "Both cursor values are required")
        after = None if after_due is None else (after_due, after_id)
        if lane == "assigned":
            rows = workflow.pending_approvals(actor, limit + 1, after)
        else:
            rows = tasks.submitted(actor, limit + 1, after)
        items = rows[:limit]
        last = items[-1] if len(rows) > limit else None
        return {"items": items, "next": {"after_due": last["due"], "after_id": last["id"]} if last else None}

    @router.post("/proposals/{identifier}/review")
    def review(identifier: Identifier, body: Decision, actor: Actor = Depends(authenticate)):
        proposal = visible_proposal(actor, identifier, include_events=False)
        require_policy(actor, Plan.model_validate(proposal["plan"]), proposal["requester"], "approve")
        tasks.review(actor, proposal, body)
        return visible_proposal(actor, identifier)

    @router.get("/workbench/notices")
    def notices(actor: Actor = Depends(authenticate), limit: Annotated[int, Query(ge=1, le=100)] = 50,
                before_at: Annotated[float | None, Query(ge=0, le=1e12)] = None, before_id: Identifier | None = None):
        if (before_at is None) != (before_id is None):
            raise HTTPException(422, "Both cursor values are required")
        cursor = "AND (created_at, id) < (?, ?)" if before_at is not None else ""
        params = (before_at, before_id) if before_at is not None else ()
        with subject_tx(workflow, actor) as run:
            rows = run(f"""SELECT id, created_at, read_at FROM aios_internal_notice
                           WHERE tenant = ? AND subject = ? {cursor}
                           ORDER BY created_at DESC, id DESC LIMIT ?""",
                       (actor.tenant, actor.subject, *params, limit + 1)).fetchall()
        items = [dict(row) for row in rows[:limit]]
        last = items[-1] if len(rows) > limit else None
        return {"items": items, "next": {"before_at": last["created_at"], "before_id": last["id"]} if last else None}

    @router.get("/workbench/notices/{identifier}")
    def notice(identifier: Identifier, actor: Actor = Depends(authenticate)):
        with subject_tx(workflow, actor) as run:
            row = run("""SELECT kind, reference, created_at, read_at FROM aios_internal_notice
                         WHERE tenant = ? AND subject = ? AND id = ?""",
                      (actor.tenant, actor.subject, identifier)).fetchone()
            if row is None:
                raise MissingResource(identifier)
            if row["kind"].startswith("meeting_"):
                Calendar._member(run, actor, row["reference"])
        if row["kind"].startswith("proposal_"):
            visible_proposal(actor, row["reference"], include_events=False)
        return dict(row)

    @router.put("/workbench/notices/{identifier}/read")
    def read_notice(identifier: Identifier, actor: Actor = Depends(authenticate)):
        with subject_tx(workflow, actor, write=True) as run:
            changed = run("""UPDATE aios_internal_notice SET read_at = COALESCE(read_at, ?)
                             WHERE tenant = ? AND subject = ? AND id = ? RETURNING read_at""",
                          (time.time(), actor.tenant, actor.subject, identifier)).fetchone()
            if changed is None:
                raise MissingResource(identifier)
            return dict(changed)

    @router.get("/workbench/brief")
    def brief(start: AwareDatetime, end: AwareDatetime, actor: Actor = Depends(authenticate)):
        if not timedelta(0) < end - start <= timedelta(days=8):
            raise HTTPException(422, "Select a daily or weekly window")
        window = start.timestamp(), end.timestamp()
        with subject_tx(workflow, actor) as run:
            meetings = run("""SELECT COUNT(*) AS n FROM aios_calendar_event e JOIN aios_calendar_member m
                              ON m.tenant = e.tenant AND m.event_id = e.id
                              WHERE m.tenant = ? AND m.subject = ? AND e.cancelled = 0
                              AND e.starts_at < ? AND e.ends_at > ?""",
                           (actor.tenant, actor.subject, window[1], window[0])).fetchone()["n"]
        pending = workflow.pending_approvals(actor, 101, None)
        return {"start": start, "end": end, "meetings": meetings, "pending_approvals": min(len(pending), 100),
                "pending_approvals_capped": len(pending) > 100,
                "submitted_current_states": tasks.submitted(actor, 0, window=window, count=True),
                "as_of": time.time()}

    return router
