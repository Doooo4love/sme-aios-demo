"""Minimal Agent activity journal. Only stable references survive a turn."""
import json
import time
from uuid import uuid4

from aios_demo.storage import canonical, digest_of

from .collaboration import MissingResource, subject_tx
from .workflow import Conflict

LEASE = 90
READ_REFERENCES = {
    "shipment.read": ("shipment_id", "warehouse"),
    "finance.invoice.read": ("invoice_id", "warehouse"),
    "decision.warehouse.summary": ("warehouse",),
}


class TurnInProgress(Conflict):
    pass


class AgentHistory:
    def __init__(self, workflow):
        self.workflow = workflow

    def begin(self, actor, identifier, text):
        fingerprint = digest_of([actor.tenant, actor.subject, identifier, text])
        attempt = uuid4().hex
        now = time.time()
        key = actor.tenant, actor.subject, identifier
        with subject_tx(self.workflow, actor, write=True) as run:
            inserted = run("""INSERT INTO aios_agent_activity VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)
                              ON CONFLICT DO NOTHING""", (*key, fingerprint, attempt, now, now + LEASE))
            if inserted.rowcount == 1:
                return attempt
            prior = run("""SELECT fingerprint, outcome, lease_until FROM aios_agent_activity
                           WHERE tenant = ? AND subject = ? AND id = ?""", key).fetchone()
            if prior["fingerprint"] != fingerprint:
                raise Conflict("Agent client ID is bound to a different request")
            if prior["outcome"] is not None:
                return None
            if prior["lease_until"] > now:
                raise TurnInProgress("The turn is already being processed")
            changed = run("""UPDATE aios_agent_activity SET attempt = ?, lease_until = ?
                             WHERE tenant = ? AND subject = ? AND id = ?
                               AND outcome IS NULL AND lease_until <= ?""", (attempt, now + LEASE, *key, now))
            if changed.rowcount != 1:
                raise TurnInProgress("The turn is already being processed")
            return attempt

    def complete(self, actor, identifier, attempt, *, result=None, status=None):
        reference = None
        if result is None:
            outcome = "unavailable" if status in {403, 404} else "failed" if status and status < 429 else None
        elif result.kind in {"proposal", "approval_preview"}:
            outcome = result.kind
            reference = {"proposal_id": result.proposal["id"]}
            if outcome == "proposal":
                reference["tool"] = result.tool
        elif result.kind == "result" and result.tool in READ_REFERENCES:
            outcome = "read"
            reference = {"tool": result.tool, **{field: result.data[field] for field in READ_REFERENCES[result.tool]}}
        elif result.kind == "clarification":
            outcome = "clarification"
        else:
            outcome = "ephemeral"
        with subject_tx(self.workflow, actor, write=True) as run:
            changed = run("""UPDATE aios_agent_activity SET outcome = ?, reference = ?, lease_until = 0
                             WHERE tenant = ? AND subject = ? AND id = ?
                               AND attempt = ? AND outcome IS NULL AND lease_until > ?""",
                          (outcome, canonical(reference) if reference else None,
                           actor.tenant, actor.subject, identifier, attempt, time.time()))
            if changed.rowcount != 1:
                raise TurnInProgress("The Agent turn lease has changed")

    def get(self, actor, identifier):
        with subject_tx(self.workflow, actor) as run:
            row = run("""SELECT outcome, reference FROM aios_agent_activity
                         WHERE tenant = ? AND subject = ? AND id = ?""",
                      (actor.tenant, actor.subject, identifier)).fetchone()
        if row is None:
            raise MissingResource(identifier)
        return row["outcome"], json.loads(row["reference"]) if row["reference"] else None

    def page(self, actor, limit, after):
        cursor = "AND (started_at, id) < (?, ?)" if after else ""
        with subject_tx(self.workflow, actor) as run:
            rows = run(f"""SELECT id, started_at FROM aios_agent_activity
                           WHERE tenant = ? AND subject = ? {cursor}
                           ORDER BY started_at DESC, id DESC LIMIT ?""",
                       (actor.tenant, actor.subject, *(after or ()), limit + 1)).fetchall()
        items = [dict(row) for row in rows[:limit]]
        last = items[-1] if len(rows) > limit else None
        return {"items": items, "next": {"before_at": last["started_at"], "before_id": last["id"]} if last else None}
