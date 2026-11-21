"""Shared subject-scoped transaction and reliable in-product references."""
from contextlib import contextmanager
import time
from uuid import uuid4

from aios_demo.storage import canonical


class MissingResource(LookupError):
    pass


class InvalidCollaborationRequest(ValueError):
    pass


@contextmanager
def subject_tx(workflow, actor, *, write=False):
    with workflow.tx(actor.tenant, write=write, bounded=True) as run:
        if workflow.db.dsn:
            run("SELECT set_config('aios.subject', ?, true)", (actor.subject,))
        if workflow._suspended(run, actor.tenant, actor.subject):
            raise PermissionError("Account access is suspended")
        yield run


def lock_subjects(workflow, run, tenant, namespace, subjects):
    if workflow.db.dsn:
        for subject in sorted(set(subjects)):
            key = canonical([namespace, tenant, subject])
            run("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", (key,))


def notify(run, tenant, subjects, kind, reference):
    for subject in sorted(set(subjects)):
        run("INSERT INTO aios_internal_notice VALUES (?, ?, ?, ?, ?, ?, NULL)",
            (tenant, subject, uuid4().hex, kind, reference, time.time()))
