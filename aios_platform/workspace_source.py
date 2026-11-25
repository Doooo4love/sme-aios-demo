"""Fixed read-only contracts for the customer directory and business projections."""
from typing import Annotated

from httpx import HTTPError
from pydantic import Field

from .assurance_policy import Case
from .contracts import Actor, Strict
from .providers import https_base, post_json
from .workbench_tools import DecisionRecord, InboxRecord, InvoiceRecord, KnowledgeRecord


class DirectoryUnavailable(ConnectionError):
    pass


class DirectoryEntry(Strict):
    active: Annotated[bool, Field(strict=True)]
    actor: Actor


class WorkspaceSource:
    def __init__(self, origin: str, token: str, tenant: str, *, knowledge_enabled: bool = False):
        self.origin = https_base(origin)
        self.headers = {"Authorization": "Bearer " + token}
        self.tenant = tenant
        self.knowledge_enabled = knowledge_enabled

    def read(self, resource, tenant, **parameters):
        if tenant != self.tenant:
            return None
        body = post_json(self.origin + "/workspace/" + resource, {"tenant": tenant, **parameters},
                         self.headers, timeout=5)
        if set(body) != {"result"}:
            raise ValueError("Invalid workspace projection envelope")
        return body["result"]

    def directory_actor(self, tenant, subject):
        try:
            item = self.read("employee", tenant, subject=subject)
            if item is None:
                return None
            employee = DirectoryEntry.model_validate(item)
        except (HTTPError, ValueError, OSError) as error:
            raise DirectoryUnavailable from error
        actor = employee.actor.model_copy(update={"module_scopes": {}, "personal_module_grants": {}})
        return actor if employee.active and (actor.tenant, actor.subject) == (tenant, subject) else None

    def known_subject(self, tenant, subject):
        return self.directory_actor(tenant, subject) is not None

    def invoice(self, actor, call):
        item = self.read("invoice", actor.tenant, subject=actor.subject, warehouse=call.warehouse,
                         invoice_id=call.invoice_id)
        return InvoiceRecord.model_validate(item) if item is not None else None

    def inbox(self, actor, call):
        item = self.read("inbox", actor.tenant, subject=actor.subject, limit=call.limit)
        return InboxRecord.model_validate(item)

    def summary(self, actor, call):
        item = self.read("warehouse-summary", actor.tenant, subject=actor.subject, warehouse=call.warehouse)
        return DecisionRecord.model_validate(item) if item is not None else None

    def knowledge(self, actor, call):
        item = self.read("knowledge-search", actor.tenant, subject=actor.subject,
                         warehouse=call.warehouse, query=call.query, limit=call.limit)
        return KnowledgeRecord.model_validate(item)

    def cases(self, tenant, sites, kind, after, limit):
        if not sites:
            return []
        try:
            items = self.read("assurance-cases", tenant, sites=sorted(sites), kind=kind, after=after, limit=limit)
            if not isinstance(items, list) or len(items) > limit:
                raise ValueError("Invalid assurance page")
            return [Case.model_validate(item) for item in items]
        except (HTTPError, ValueError, OSError) as error:
            raise ConnectionError("Assurance list unavailable") from error

    def get(self, tenant, reference, sites):
        if not sites:
            return None
        try:
            item = self.read("assurance-case", tenant, reference=reference, sites=sorted(sites))
            return Case.model_validate(item) if item is not None else None
        except (HTTPError, ValueError) as error:
            raise ConnectionError("Assurance case projection unavailable") from error
