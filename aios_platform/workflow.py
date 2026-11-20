"""Durable proposal/outbox state machine with tenant-scoped transactions."""
from contextlib import contextmanager
import json
from pathlib import Path
import sqlite3
import time
from uuid import uuid4

from aios_demo.storage import Database, canonical

from .contracts import Actor, Plan, Receipt
from .erp import ERP, ERPRejected, ERP_TRANSPORT_ERRORS, plan_digest
from .providers import can_approve


class Conflict(ValueError):
    pass


class Workflow:
    def __init__(self, database: Database):
        self.db = database

    def initialize(self):
        schema = Path(__file__).with_name("schema.sql").read_text()
        with self.db.transaction() as run:
            for statement in schema.split(";"):
                if statement.strip():
                    run(statement)

    @contextmanager
    def tx(self, tenant: str, *, write: bool = True):
        with self.db.transaction(write=write) as run:
            if self.db.dsn:
                run("SELECT set_config('aios.tenant', ?, true)", (tenant,))
            yield run

    @staticmethod
    def _audit(run, tenant: str, subject: str, target: str, event: str):
        run("INSERT INTO aios_audit VALUES (?, ?, ?, ?, ?, ?)",
            (tenant, uuid4().hex, subject, target, event, time.time()))

    def audit(self, actor: Actor, target: str, event: str):
        with self.tx(actor.tenant) as run:
            self._audit(run, actor.tenant, actor.subject, target, event)

    def add_intake(self, actor: Actor, warehouse: str, document: dict) -> str:
        intake_id = uuid4().hex
        with self.tx(actor.tenant) as run:
            run("INSERT INTO aios_intake VALUES (?, ?, ?, ?)",
                (actor.tenant, intake_id, warehouse, canonical(document)))
            self._audit(run, actor.tenant, actor.subject, intake_id, "PO_INTAKE")
        return intake_id

    def intake(self, tenant: str, intake_id: str) -> dict:
        with self.tx(tenant, write=False) as run:
            row = run("SELECT warehouse, document FROM aios_intake WHERE tenant = ? AND id = ?",
                      (tenant, intake_id)).fetchone()
        if not row:
            raise KeyError(intake_id)
        return {"warehouse": row["warehouse"], "evidence": json.loads(row["document"])}

    def propose(self, actor: Actor, plan: Plan) -> str:
        proposal_id = uuid4().hex
        now = time.time()
        with self.tx(actor.tenant) as run:
            run("""INSERT INTO aios_proposal
                   (tenant, id, warehouse, requester, digest, plan, state, due, expires)
                   VALUES (?, ?, ?, ?, ?, ?, 'PROPOSED', ?, ?)""",
                (actor.tenant, proposal_id, plan.warehouse, actor.subject, plan_digest(plan),
                 plan.model_dump_json(), now, now + 900))
            self._audit(run, actor.tenant, actor.subject, proposal_id, "PROPOSED")
        return proposal_id

    def get(self, tenant: str, proposal_id: str) -> dict:
        with self.tx(tenant, write=False) as run:
            row = run("SELECT * FROM aios_proposal WHERE tenant = ? AND id = ?",
                      (tenant, proposal_id)).fetchone()
            if not row:
                raise KeyError(proposal_id)
            events = run("""SELECT subject, event, at FROM aios_audit
                            WHERE tenant = ? AND target = ? ORDER BY at, id""",
                         (tenant, proposal_id)).fetchall()
        return {**dict(row), "plan": json.loads(row["plan"]),
                "receipt": json.loads(row["receipt"]) if row["receipt"] else None,
                "events": [dict(event) for event in events]}

    def summary(self, actor: Actor) -> dict[str, int]:
        if not actor.warehouses:
            return {}
        warehouses = sorted(actor.warehouses)
        marks = ",".join("?" for _ in warehouses)
        with self.tx(actor.tenant, write=False) as run:
            rows = run(
                f"""SELECT state, COUNT(*) AS count FROM aios_proposal
                    WHERE tenant = ? AND warehouse IN ({marks}) GROUP BY state""",
                (actor.tenant, *warehouses),
            ).fetchall()
        return {row["state"]: row["count"] for row in rows}

    def approve(self, actor: Actor, proposal_id: str, digest: str):
        with self.tx(actor.tenant) as run:
            row = run("SELECT * FROM aios_proposal WHERE tenant = ? AND id = ?",
                      (actor.tenant, proposal_id)).fetchone()
            if not row:
                raise KeyError(proposal_id)
            plan = Plan.model_validate_json(row["plan"])
            if not can_approve(actor, row["requester"], plan):
                raise PermissionError("This action requires an independent warehouse approver")
            if digest != row["digest"] or digest != plan_digest(plan):
                raise Conflict("Preview digest changed")
            if row["approver"] == actor.subject:
                return
            now = time.time()
            result = run("""UPDATE aios_proposal SET state = 'QUEUED', approver = ?, due = ?, expires = ?
                            WHERE tenant = ? AND id = ? AND state = 'PROPOSED' AND expires > ?""",
                         (actor.subject, now, now + 900, actor.tenant, proposal_id, now))
            if result.rowcount != 1:
                raise Conflict("Proposal expired or was already acted on")
            self._audit(run, actor.tenant, actor.subject, proposal_id, "APPROVED_AND_QUEUED")

    def claim(self, tenant: str) -> dict | None:
        now = time.time()
        with self.tx(tenant) as run:
            # A stranded send becomes read-only recovery. Its prior epoch cannot finalize the row.
            recovered = run(
                """UPDATE aios_proposal SET state = 'OUTCOME_UNKNOWN', due = ?
                   WHERE tenant = ? AND state IN ('SENDING', 'CHECKING') AND due <= ? RETURNING id""",
                (now, tenant, now),
            ).fetchall()
            for row in recovered:
                self._audit(run, tenant, "worker", row["id"], "LEASE_EXPIRED_VERIFY_ONLY")
            lock = " FOR UPDATE SKIP LOCKED" if self.db.dsn else ""
            row = run("""SELECT * FROM aios_proposal WHERE tenant = ? AND due <= ?
                         AND state IN ('QUEUED','VERIFYING','OUTCOME_UNKNOWN')
                         ORDER BY due, id LIMIT 1""" + lock, (tenant, now)).fetchone()
            if not row:
                return None
            sending = row["state"] == "QUEUED"
            if sending and row["expires"] <= now:
                run("UPDATE aios_proposal SET state = 'REJECTED' WHERE tenant = ? AND id = ?",
                    (tenant, row["id"]))
                self._audit(run, tenant, "worker", row["id"], "APPROVAL_EXPIRED_BEFORE_SEND")
                return None
            if not sending and row["checks"] >= 3:
                run("UPDATE aios_proposal SET state = 'NEEDS_OPERATOR' WHERE tenant = ? AND id = ?",
                    (tenant, row["id"]))
                self._audit(run, tenant, "worker", row["id"], "READBACK_LIMIT_REACHED")
                return None
            state = "SENDING" if sending else "CHECKING"
            epoch = row["epoch"] + 1
            checks = row["checks"] + (not sending)
            run("UPDATE aios_proposal SET state = ?, due = ?, epoch = ?, checks = ? WHERE tenant = ? AND id = ?",
                (state, now + 45, epoch, checks, tenant, row["id"]))
            self._audit(run, tenant, "worker", row["id"], state)
            return {**dict(row), "state": state, "epoch": epoch, "checks": checks, "due": now + 45}

    def finish(self, job: dict, state: str, *, receipt: Receipt | None = None, delay: int = 0):
        with self.tx(job["tenant"]) as run:
            now = time.time()
            result = run(
                """UPDATE aios_proposal SET state = ?, receipt = ?, due = ?
                   WHERE tenant = ? AND id = ? AND state = ? AND epoch = ? AND due > ?""",
                (state, receipt.model_dump_json() if receipt else None, now + delay,
                 job["tenant"], job["id"], job["state"], job["epoch"], now),
            )
            if result.rowcount == 1:
                self._audit(run, job["tenant"], "worker", job["id"], state)


def tick(workflow: Workflow, erp: ERP, tenant: str) -> bool:
    job = workflow.claim(tenant)
    if not job:
        return False
    try:
        plan = Plan.model_validate_json(job["plan"])
    except ValueError:
        workflow.finish(job, "NEEDS_OPERATOR")
        return True
    if plan_digest(plan) != job["digest"] or plan.tenant != tenant:
        workflow.finish(job, "NEEDS_OPERATOR")
        return True
    if job["state"] == "SENDING":
        try:
            erp.apply(job["id"], plan)
        except ERPRejected:
            workflow.finish(job, "REJECTED")
        except (*ERP_TRANSPORT_ERRORS, sqlite3.Error):
            workflow.finish(job, "OUTCOME_UNKNOWN")
        else:
            workflow.finish(job, "VERIFYING")
        return True
    try:
        receipt = erp.receipt(tenant, job["id"])
    except (*ERP_TRANSPORT_ERRORS, sqlite3.Error):
        receipt = None
    if receipt is not None:
        if (receipt.tenant, receipt.operation_id, receipt.plan_digest, receipt.target) == (
            tenant, job["id"], job["digest"], plan.target
        ):
            workflow.finish(job, "VERIFIED", receipt=receipt)
        else:
            workflow.finish(job, "NEEDS_OPERATOR")
    elif job["checks"] >= 3:
        workflow.finish(job, "NEEDS_OPERATOR")
    else:
        workflow.finish(job, "OUTCOME_UNKNOWN", delay=2 ** (job["checks"] - 1))
    return True
