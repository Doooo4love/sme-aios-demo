"""Durable proposal/outbox state machine with tenant-scoped transactions."""
from contextlib import contextmanager
import json
from pathlib import Path
import sqlite3
import time
from uuid import uuid4

from aios_demo.storage import Database, canonical, digest_of

from .contracts import Actor, Plan, Receipt
from .erp import ERP, ERPRejected, ERP_TRANSPORT_ERRORS, plan_digest
from .module_access import ModuleScopeChanged, dispatch_permitted, lock_employee, refresh_scope
from .providers import ACTION_GRANTS, APPROVAL_GRANTS, allowed, approval_sites, can_approve


class Conflict(ValueError):
    pass


class Workflow:
    def __init__(self, database: Database):
        self.db = database

    def initialize(self):
        with self.db.transaction() as run:
            sources = ("schema.sql", "hardening.sql", "operations.sql", "chat.sql", "assurance.sql",
                       "assurance_runtime.sql", "module_access.sql")
            for name in sources:
                for statement in Path(__file__).with_name(name).read_text().split(";"):
                    if statement.strip():
                        run(statement)

    @contextmanager
    def tx(self, tenant: str, *, write: bool = True, bounded: bool = False):
        with self.db.transaction(write=write, sqlite_timeout=0.5 if bounded else 10) as run:
            if self.db.dsn:
                if bounded:
                    run("SET LOCAL lock_timeout = '1500ms'")
                    run("SET LOCAL statement_timeout = '5s'")
                run("SELECT set_config('aios.tenant', ?, true)", (tenant,))
            yield run

    @staticmethod
    def _suspended(run, tenant: str, *subjects: str) -> bool:
        marks = ",".join("?" for _ in subjects)
        return run(
            f"""SELECT 1 FROM aios_suspension WHERE tenant = ? AND subject IN ({marks})
                AND suspended = 1 LIMIT 1""",
            (tenant, *subjects),
        ).fetchone() is not None

    def is_suspended(self, actor: Actor) -> bool:
        with self.tx(actor.tenant, write=False) as run:
            return self._suspended(run, actor.tenant, actor.subject)

    def _lock_scope(self, run, actor):
        if self.db.dsn:
            lock_employee(run, actor.tenant, actor.subject, exclusive=False)
        if self._suspended(run, actor.tenant, actor.subject):
            raise ModuleScopeChanged
        return refresh_scope(run, actor)

    @staticmethod
    def _paused(run, tenant: str) -> bool:
        row = run("SELECT paused FROM aios_write_control WHERE tenant = ?", (tenant,)).fetchone()
        return bool(row and row["paused"])

    def write_paused(self, tenant: str) -> bool:
        with self.tx(tenant, write=False) as run:
            return self._paused(run, tenant)

    def set_write_pause(self, actor: Actor, paused: bool):
        if actor.role != "admin":
            raise PermissionError("Tenant administrator required")
        with self.tx(actor.tenant) as run:
            run("""INSERT INTO aios_write_control VALUES (?, ?) ON CONFLICT (tenant)
                   DO UPDATE SET paused = excluded.paused""", (actor.tenant, int(paused)))
            self._audit(run, actor.tenant, actor.subject, "write-control",
                        "WRITES_PAUSED" if paused else "WRITES_RESUMED")

    def set_suspension(self, actor: Actor, subject: str, suspended: bool):
        if actor.role != "admin" or actor.subject == subject:
            raise PermissionError("An administrator must manage another subject")
        with self.tx(actor.tenant) as run:
            run("""INSERT INTO aios_suspension VALUES (?, ?, ?) ON CONFLICT (tenant, subject)
                   DO UPDATE SET suspended = excluded.suspended""", (actor.tenant, subject, int(suspended)))
            self._audit(run, actor.tenant, actor.subject, subject,
                        "ACCESS_SUSPENDED" if suspended else "ACCESS_RESTORED")

    def take_planner_budget(self, tenant: str, limit: int, *, bounded: bool = False) -> bool:
        window = int(time.time()) // 60
        with self.tx(tenant, bounded=bounded) as run:
            return run(
                """INSERT INTO aios_planner_budget VALUES (?, ?, 1)
                   ON CONFLICT (tenant) DO UPDATE SET window_id = excluded.window_id,
                   calls = CASE WHEN aios_planner_budget.window_id = excluded.window_id
                                THEN aios_planner_budget.calls + 1 ELSE 1 END
                   WHERE aios_planner_budget.window_id < excluded.window_id
                      OR (aios_planner_budget.window_id = excluded.window_id
                          AND aios_planner_budget.calls < ?)
                   RETURNING calls""", (tenant, window, limit),
            ).fetchone() is not None

    @staticmethod
    def _find_request(run, actor: Actor, key: str, fingerprint: str) -> str | None:
        row = run("""SELECT fingerprint, proposal_id FROM aios_request_key
                     WHERE tenant = ? AND subject = ? AND request_key = ?""",
                  (actor.tenant, actor.subject, key)).fetchone()
        if row is None:
            return None
        if row["fingerprint"] != fingerprint:
            raise Conflict("Idempotency key already used for a different request")
        return row["proposal_id"]

    def find_request(self, actor: Actor, key: str, fingerprint: str) -> str | None:
        with self.tx(actor.tenant, write=False) as run:
            return self._find_request(run, actor, key, fingerprint)

    def ping(self, tenant: str):
        with self.tx(tenant, write=False) as run:
            run("SELECT paused FROM aios_write_control WHERE tenant = ?", (tenant,)).fetchone()

    @staticmethod
    def _audit(run, tenant: str, subject: str, target: str, event: str):
        run("INSERT INTO aios_audit VALUES (?, ?, ?, ?, ?, ?)",
            (tenant, uuid4().hex, subject, target, event, time.time()))

    def audit(self, actor: Actor, target: str, event: str):
        with self.tx(actor.tenant) as run:
            self._audit(run, actor.tenant, actor.subject, target, event)

    @staticmethod
    def structured_intake_id(warehouse: str, document: dict) -> str:
        return digest_of({"warehouse": warehouse, "artifact_sha256": document["artifact_sha256"]})

    def _store_intake(self, run, actor: Actor, warehouse: str, document: dict, intake_id: str):
        inserted = run("""INSERT INTO aios_intake VALUES (?, ?, ?, ?)
                         ON CONFLICT (tenant, id) DO NOTHING""",
                       (actor.tenant, intake_id, warehouse, canonical(document)))
        if inserted.rowcount == 1:
            self._audit(run, actor.tenant, actor.subject, intake_id, "PO_INTAKE")

    def add_intake(self, actor: Actor, warehouse: str, document: dict) -> str:
        intake_id = (self.structured_intake_id(warehouse, document)
                     if document["kind"] == "structured" else uuid4().hex)
        with self.tx(actor.tenant, bounded=True) as run:
            if not allowed(self._lock_scope(run, actor), "sales_order.create_draft", warehouse):
                raise ModuleScopeChanged
            self._store_intake(run, actor, warehouse, document, intake_id)
        return intake_id

    def prepare_orders(
        self, actor: Actor, warehouse: str, entries: list[tuple[dict, Plan | None]],
    ) -> dict[str, dict]:
        prepared = {}
        # Consistent lock acquisition for concurrent submissions containing the same items.
        ordered = sorted(entries, key=lambda entry: self.structured_intake_id(warehouse, entry[0]))
        with self.tx(actor.tenant, bounded=True) as run:
            if not allowed(self._lock_scope(run, actor), "sales_order.create_draft", warehouse):
                raise ModuleScopeChanged
            for document, plan in ordered:
                intake_id = self.structured_intake_id(warehouse, document)
                self._store_intake(run, actor, warehouse, document, intake_id)
                if plan is not None:
                    # Slash is reserved for internal keys and excluded by the public key schema.
                    key = ("batch/" + intake_id, document["artifact_sha256"])
                    proposal_id = self._store_proposal(run, actor, plan, key)
                    row = run("""SELECT id AS proposal_id, digest, state FROM aios_proposal
                                 WHERE tenant = ? AND id = ?""", (actor.tenant, proposal_id)).fetchone()
                    prepared[intake_id] = dict(row)
        return prepared

    def intake(self, tenant: str, intake_id: str) -> dict:
        with self.tx(tenant, write=False) as run:
            row = run("SELECT warehouse, document FROM aios_intake WHERE tenant = ? AND id = ?",
                      (tenant, intake_id)).fetchone()
        if not row:
            raise KeyError(intake_id)
        return {"warehouse": row["warehouse"], "evidence": json.loads(row["document"])}

    def propose(self, actor: Actor, plan: Plan, *, idempotency: tuple[str, str] | None = None) -> str:
        with self.tx(actor.tenant, bounded=True) as run:
            if actor.tenant != plan.tenant or not allowed(self._lock_scope(run, actor), plan.action, plan.warehouse):
                raise ModuleScopeChanged
            return self._store_proposal(run, actor, plan, idempotency)

    def _store_proposal(self, run, actor: Actor, plan: Plan, idempotency: tuple[str, str] | None) -> str:
        proposal_id = uuid4().hex
        now = time.time()
        if idempotency is not None:
            key, fingerprint = idempotency
            inserted = run("""INSERT INTO aios_request_key VALUES (?, ?, ?, ?, ?)
                              ON CONFLICT (tenant, subject, request_key) DO NOTHING
                              RETURNING proposal_id""",
                           (actor.tenant, actor.subject, key, fingerprint, proposal_id)).fetchone()
            if not inserted:
                prior = self._find_request(run, actor, key, fingerprint)
                if prior is None:
                    raise Conflict("The original request is unavailable")
                return prior
        run("""INSERT INTO aios_proposal
               (tenant, id, warehouse, requester, digest, plan, state, due, expires)
               VALUES (?, ?, ?, ?, ?, ?, 'PROPOSED', ?, ?)""",
            (actor.tenant, proposal_id, plan.warehouse, actor.subject, plan_digest(plan),
             plan.model_dump_json(), now, now + 900))
        self._audit(run, actor.tenant, actor.subject, proposal_id, "PROPOSED")
        return proposal_id

    def get(self, tenant: str, proposal_id: str, *, include_events: bool = True) -> dict:
        with self.tx(tenant, write=False) as run:
            row = run("SELECT * FROM aios_proposal WHERE tenant = ? AND id = ?",
                      (tenant, proposal_id)).fetchone()
            if not row:
                raise KeyError(proposal_id)
            events = []
            if include_events:
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

    def exceptions(self, actor: Actor, limit: int, after: tuple[float, str] | None) -> list[dict]:
        if not actor.warehouses:
            return []
        warehouses = sorted(actor.warehouses)
        marks = ",".join("?" for _ in warehouses)
        cursor = " AND (p.due, p.id) > (?, ?)" if after else ""
        with self.tx(actor.tenant, write=False) as run:
            rows = run(
                f"""SELECT p.id AS proposal_id, p.warehouse, p.state, p.due, p.checks,
                           (SELECT a.event FROM aios_audit AS a WHERE a.tenant = p.tenant AND a.target = p.id
                            AND a.event IN ('OUTCOME_UNKNOWN', 'READBACK_REOPENED', 'READBACK_LIMIT_REACHED',
                                'LEASE_EXPIRED_VERIFY_ONLY', 'LEASE_LOST_BEFORE_SEND', 'INVALID_STORED_PLAN',
                                'PLAN_DIGEST_OR_TENANT_MISMATCH', 'ERP_RECEIPT_MISMATCH', 'NEEDS_OPERATOR')
                            ORDER BY a.at DESC, a.id DESC LIMIT 1) AS last_event
                    FROM aios_proposal AS p WHERE p.tenant = ? AND p.warehouse IN ({marks})
                    AND p.state IN ('NEEDS_OPERATOR', 'OUTCOME_UNKNOWN')
                    {cursor} ORDER BY p.due, p.id LIMIT ?""",
                (actor.tenant, *warehouses, *(after or ()), limit),
            ).fetchall()
        return [dict(row) for row in rows]

    def pending_approvals(self, actor: Actor, limit: int, after: tuple[float, str] | None) -> list[dict]:
        scopes = [(action, sorted(approval_sites(actor, action)))
                  for action in ("shipment.reschedule", "sales_order.create_draft")]
        action_field = ("CASE WHEN plan IS JSON THEN CAST(plan AS JSONB) ->> 'action' END" if self.db.dsn
                        else "CASE WHEN json_valid(plan) THEN json_extract(plan, '$.action') END")
        predicates, params = [], []
        for action, warehouses in scopes:
            if warehouses:
                marks = ",".join("?" for _ in warehouses)
                predicates.append(f"({action_field} = ? AND warehouse IN ({marks}))")
                params.extend([action, *warehouses])
        if not predicates:
            return []
        action_scope = " OR ".join(predicates)
        cursor = "AND (due, id) > (?, ?)" if after else ""
        with self.tx(actor.tenant, write=False) as run:
            rows = run(
                f"""SELECT id, warehouse, state, expires, due, {action_field} AS action
                    FROM aios_proposal WHERE tenant = ? AND state = 'PROPOSED'
                      AND requester != ? AND expires > ? AND ({action_scope}) {cursor}
                    ORDER BY due, id LIMIT ?""",
                (actor.tenant, actor.subject, time.time(), *params, *(after or ()), limit),
            ).fetchall()
        return [dict(row) for row in rows]

    def approve(self, actor: Actor, proposal_id: str, digest: str):
        with self.tx(actor.tenant, bounded=True) as run:
            row = run("SELECT * FROM aios_proposal WHERE tenant = ? AND id = ?",
                      (actor.tenant, proposal_id)).fetchone()
            if not row:
                raise KeyError(proposal_id)
            plan = Plan.model_validate_json(row["plan"])
            current_actor = self._lock_scope(run, actor)
            if not can_approve(current_actor, row["requester"], plan):
                raise PermissionError("This action requires an independent warehouse approver")
            if self._suspended(run, actor.tenant, actor.subject, row["requester"]):
                raise PermissionError("Requester or approver access is suspended")
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

    def reopen_verification(self, actor: Actor, proposal_id: str):
        if actor.role not in {"manager", "admin"}:
            raise PermissionError("Warehouse manager access required")
        with self.tx(actor.tenant) as run:
            row = run("SELECT warehouse FROM aios_proposal WHERE tenant = ? AND id = ?",
                      (actor.tenant, proposal_id)).fetchone()
            if not row or row["warehouse"] not in actor.warehouses:
                raise KeyError(proposal_id)
            changed = run("""UPDATE aios_proposal SET state = 'OUTCOME_UNKNOWN', checks = 0, due = ?
                             WHERE tenant = ? AND id = ? AND state = 'NEEDS_OPERATOR'""",
                          (time.time(), actor.tenant, proposal_id))
            if changed.rowcount != 1:
                raise Conflict("Only an operator-held proposal can be rechecked")
            self._audit(run, actor.tenant, actor.subject, proposal_id, "READBACK_REOPENED")

    def claim(self, tenant: str) -> dict | None:
        now = time.time()
        with self.tx(tenant) as run:
            lock = " FOR UPDATE SKIP LOCKED" if self.db.dsn else ""
            # Recover leases in small batches. Use verification only after an abandoned send.
            recovered = run(
                """SELECT id FROM aios_proposal WHERE tenant = ? AND due <= ?
                   AND state IN ('SENDING', 'CHECKING') ORDER BY due, id LIMIT 25""" + lock,
                (tenant, now),
            ).fetchall()
            for abandoned in recovered:
                run("UPDATE aios_proposal SET state = 'OUTCOME_UNKNOWN', due = ? WHERE tenant = ? AND id = ?",
                    (now, tenant, abandoned["id"]))
                self._audit(run, tenant, "worker", abandoned["id"], "LEASE_EXPIRED_VERIFY_ONLY")
            paused = self._paused(run, tenant)
            row = run("""SELECT * FROM aios_proposal WHERE tenant = ? AND due <= ?
                         AND (state IN ('VERIFYING','OUTCOME_UNKNOWN') OR (state = 'QUEUED' AND ? = 0))
                         ORDER BY due, id LIMIT 1""" + lock, (tenant, now, int(paused))).fetchone()
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

    def dispatch_gate(self, job: dict) -> tuple[str, str] | None:
        """Recheck just before ERP I/O. None means a still-valid lease may send."""
        tenant = job["tenant"]
        with self.tx(tenant, write=False) as run:
            if not run("""SELECT 1 FROM aios_proposal WHERE tenant = ? AND id = ? AND epoch = ?
                          AND state = 'SENDING' AND due > ?""",
                       (tenant, job["id"], job["epoch"], time.time())).fetchone():
                return "OUTCOME_UNKNOWN", "LEASE_LOST_BEFORE_SEND"
            if self._suspended(run, tenant, job["requester"], job["approver"]):
                return "REJECTED", "ACCESS_SUSPENDED_BEFORE_SEND"
            now = time.time()
            if job["expires"] <= now:
                return "REJECTED", "APPROVAL_EXPIRED_BEFORE_SEND"
            plan = Plan.model_validate_json(job["plan"])
            required = ACTION_GRANTS[plan.action]
            if not (dispatch_permitted(run, tenant, job["requester"], plan.warehouse, required, now=now)
                    and dispatch_permitted(run, tenant, job["approver"], plan.warehouse, required,
                                           now=now, approval_grant=APPROVAL_GRANTS[plan.action])):
                return "REJECTED", "MODULE_ACCESS_REVOKED_BEFORE_SEND"
            if self._paused(run, tenant):
                return "QUEUED", "WRITES_PAUSED_BEFORE_SEND"
        return None

    def finish(self, job: dict, state: str, *, receipt: Receipt | None = None, delay: int = 0,
               event: str | None = None):
        with self.tx(job["tenant"]) as run:
            now = time.time()
            result = run(
                """UPDATE aios_proposal SET state = ?, receipt = ?, due = ?
                   WHERE tenant = ? AND id = ? AND state = ? AND epoch = ? AND due > ?""",
                (state, receipt.model_dump_json() if receipt else None, now + delay,
                 job["tenant"], job["id"], job["state"], job["epoch"], now),
            )
            if result.rowcount == 1:
                self._audit(run, job["tenant"], "worker", job["id"], event or state)


def tick(workflow: Workflow, erp: ERP, tenant: str) -> bool:
    job = workflow.claim(tenant)
    if not job:
        return False
    try:
        plan = Plan.model_validate_json(job["plan"])
    except ValueError:
        workflow.finish(job, "NEEDS_OPERATOR", event="INVALID_STORED_PLAN")
        return True
    if plan_digest(plan) != job["digest"] or plan.tenant != tenant:
        workflow.finish(job, "NEEDS_OPERATOR", event="PLAN_DIGEST_OR_TENANT_MISMATCH")
        return True
    if job["state"] == "SENDING":
        stop = workflow.dispatch_gate(job)
        if stop:
            workflow.finish(job, stop[0], event=stop[1])
            return True
        try:
            erp.apply(job["id"], plan)
        except ERPRejected:
            workflow.finish(job, "REJECTED", event="ERP_PRE_WRITE_REJECTION")
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
            workflow.finish(job, "NEEDS_OPERATOR", event="ERP_RECEIPT_MISMATCH")
    elif job["checks"] >= 3:
        workflow.finish(job, "NEEDS_OPERATOR", event="READBACK_LIMIT_REACHED")
    else:
        workflow.finish(job, "OUTCOME_UNKNOWN", delay=2 ** (job["checks"] - 1))
    return True
