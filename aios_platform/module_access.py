"""Tenant-local module grants applied over existing, verified identity claims."""
from dataclasses import dataclass
import json
import time
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import Field, model_validator

from aios_demo.storage import canonical

from .contracts import Actor, Grant, Identifier, Strict
from .providers import APPROVAL_GRANTS


@dataclass(frozen=True)
class Module:
    grants: tuple[Grant, ...]
    roles: frozenset[str] | None = None
    scope: Literal["warehouse", "personal"] = "warehouse"


APPROVAL_ROLES = frozenset({"manager", "admin"})
MODULES = {
    "orders": Module(("order.read", "order.work")),
    "dispatch": Module(("shipment.read", "shipment.reschedule")),
    "invoice-review": Module(("finance.read",)),
    "warehouse-insights": Module(("decision.read",)),
    "approvals": Module(tuple(APPROVAL_GRANTS.values()), APPROVAL_ROLES),
    "agent-web": Module(("agent.web_search",), scope="personal"),
    "agent-collaboration": Module(("agent.calendar_read", "agent.tasks_read"), scope="personal"),
    "agent-knowledge": Module(("agent.knowledge_read",)),
    "agent-documents": Module(("agent.documents_parse", "agent.report_export"), scope="personal"),
}
MODULE_BY_GRANT = {grant: module for module, spec in MODULES.items() for grant in spec.grants}
Subject = Annotated[str, Field(min_length=1, max_length=150, pattern=r"^[A-Za-z0-9._:@-]+$")]


class Assignment(Strict):
    version: Annotated[int, Field(strict=True, ge=0, lt=2**31 - 1)]
    grants: Annotated[frozenset[Grant], Field(max_length=2)]
    warehouses: Annotated[frozenset[Identifier], Field(max_length=100)]
    expires_at: Annotated[float, Field(ge=0, le=4_102_444_800)] | None = None

    @model_validator(mode="after")
    def valid_scope(self):
        if not self.grants and (self.warehouses or self.expires_at is not None):
            raise ValueError("Revocation cannot include warehouses or an expiration")
        return self


class AssignmentConflict(ValueError):
    pass


def assignments(run, tenant, subject):
    rows = run("""SELECT module, grants, warehouses, expires_at, version FROM aios_module_access
                  WHERE tenant = ? AND subject = ? ORDER BY module""", (tenant, subject)).fetchall()
    return {row["module"]: Assignment(
        version=row["version"], grants=json.loads(row["grants"]),
        warehouses=json.loads(row["warehouses"]), expires_at=row["expires_at"],
    ) for row in rows}


def lock_employee(run, tenant, subject, *, exclusive: bool):
    lock = "pg_advisory_xact_lock" if exclusive else "pg_advisory_xact_lock_shared"
    key = canonical(["workbench-module-v1", tenant, subject])
    run(f"SELECT {lock}(hashtextextended(?, 0))", (key,))


class ModuleScopeChanged(PermissionError):
    pass


def refresh_scope(run, actor: Actor) -> Actor:
    now = time.time()
    rules = assignments(run, actor.tenant, actor.subject)
    scope = {}
    personal_grants = {}
    for name, rule in rules.items():
        module = MODULES[name]
        active = rule.expires_at is None or now < rule.expires_at
        eligible = module.roles is None or actor.role in module.roles
        for grant in module.grants:
            granted = active and eligible and grant in rule.grants
            if module.scope == "personal":
                personal_grants[grant] = granted
            else:
                scope[grant] = rule.warehouses & actor.warehouses if granted else frozenset()
    return actor.model_copy(update={"module_scopes": scope, "personal_module_grants": personal_grants})


def dispatch_permitted(run, tenant, subject, warehouse, grants, *, now, approval_grant=None):
    # An unconfigured module keeps the identity-based approval behavior of existing jobs.
    rules = assignments(run, tenant, subject)
    if approval_grant is not None and "approvals" in rules:
        grants = (approval_grant,)
    for grant in grants:
        rule = rules.get(MODULE_BY_GRANT[grant])
        if rule is not None and (grant not in rule.grants or warehouse not in rule.warehouses
                                 or (rule.expires_at is not None and now >= rule.expires_at)):
            return False
    return True


class ModuleAccess:
    def __init__(self, workflow):
        self.workflow = workflow

    def authenticate(self, actor: Actor) -> Actor:
        with self.workflow.tx(actor.tenant, write=False) as run:
            if self.workflow._suspended(run, actor.tenant, actor.subject):
                raise PermissionError
            known = run("SELECT 1 FROM aios_employee WHERE tenant = ? AND subject = ?",
                        (actor.tenant, actor.subject)).fetchone()
            scoped = refresh_scope(run, actor)
        if not known:
            with self.workflow.tx(actor.tenant, bounded=True) as run:
                run("INSERT INTO aios_employee VALUES (?, ?) ON CONFLICT DO NOTHING", (actor.tenant, actor.subject))
        return scoped

    def refresh(self, actor: Actor) -> Actor:
        with self.workflow.tx(actor.tenant, write=False) as run:
            if self.workflow._suspended(run, actor.tenant, actor.subject):
                raise PermissionError
            return refresh_scope(run, actor)

    def people(self, actor, after, limit):
        with self.workflow.tx(actor.tenant, write=False) as run:
            rows = run("""SELECT subject FROM aios_employee WHERE tenant = ? AND subject > ?
                          ORDER BY subject LIMIT ?""", (actor.tenant, after, limit)).fetchall()
        return [row["subject"] for row in rows]

    def get(self, actor, subject):
        with self.workflow.tx(actor.tenant, write=False) as run:
            self._employee(run, actor.tenant, subject)
            return {name: rule for name, rule in assignments(run, actor.tenant, subject).items()
                    if rule.warehouses <= actor.warehouses}

    @staticmethod
    def _employee(run, tenant, subject):
        if not run("SELECT 1 FROM aios_employee WHERE tenant = ? AND subject = ?", (tenant, subject)).fetchone():
            raise KeyError(subject)

    def put(self, actor, subject, module, update):
        spec = MODULES[module]
        if spec.scope == "personal" and update.warehouses:
            raise ValueError("Personal agent permissions do not accept a warehouse scope")
        if spec.scope == "warehouse" and update.grants and not update.warehouses:
            raise ValueError("Select at least one warehouse for this module")
        prerequisites = {"shipment.reschedule": "shipment.read", "order.work": "order.read"}
        if (not update.warehouses <= actor.warehouses or not update.grants <= set(spec.grants)
                or any(grant in update.grants and required not in update.grants
                       for grant, required in prerequisites.items())):
            raise ValueError("Select permitted module actions and warehouses within your scope")
        if update.expires_at is not None and update.expires_at <= time.time():
            raise ValueError("Choose a future expiration")
        with self.workflow.tx(actor.tenant, bounded=True) as run:
            if self.workflow.db.dsn:
                lock_employee(run, actor.tenant, subject, exclusive=True)
            self._employee(run, actor.tenant, subject)
            prior = assignments(run, actor.tenant, subject).get(module)
            if prior is not None and not prior.warehouses <= actor.warehouses:
                raise ValueError("The existing assignment is outside your administrative scope")
            if self.workflow._suspended(run, actor.tenant, actor.subject):
                raise PermissionError
            args = (canonical(sorted(update.grants)), canonical(sorted(update.warehouses)), update.expires_at)
            if update.version == 0:
                result = run("""INSERT INTO aios_module_access
                                (tenant, subject, module, grants, warehouses, expires_at, version)
                                VALUES (?, ?, ?, ?, ?, ?, 1) ON CONFLICT DO NOTHING""",
                             (actor.tenant, subject, module, *args))
            else:
                result = run("""UPDATE aios_module_access SET grants = ?, warehouses = ?, expires_at = ?,
                                version = version + 1
                                WHERE tenant = ? AND subject = ? AND module = ? AND version = ?""",
                             (*args, actor.tenant, subject, module, update.version))
            if result.rowcount != 1:
                raise AssignmentConflict
            saved = update.model_copy(update={"version": update.version + 1})
            self.workflow._audit(
                run, actor.tenant, actor.subject, "module-access:" + subject, canonical({
                    "type": "MODULE_ACCESS_CHANGED", "module": module,
                    "version": saved.version, "grants": sorted(saved.grants),
                    "warehouses": sorted(saved.warehouses), "expires_at": saved.expires_at,
                }),
            )
        return saved


def module_routes(access: ModuleAccess, authenticate, profiles) -> APIRouter:
    router = APIRouter(prefix="/v1/workbench/module-access", tags=["Employee module access"])

    def administrator(actor: Actor = Depends(authenticate)):
        if (actor.role != "admin" or "workbench.access.manage" not in actor.grants
                or actor.warehouses != frozenset(profiles[actor.tenant].warehouses)):
            raise HTTPException(403, "Module administration permission required")
        return actor

    @router.get("/catalog")
    def catalog(actor: Actor = Depends(administrator)):
        return {"modules": MODULES, "warehouses": sorted(actor.warehouses)}

    @router.get("/employees")
    def employees(actor: Actor = Depends(administrator), after: Subject | None = None,
                  limit: Annotated[int, Query(ge=1, le=100)] = 50):
        rows = access.people(actor, after or "", limit + 1)
        return {"items": rows[:limit], "next": rows[limit - 1] if len(rows) > limit else None}

    @router.get("/employees/{subject}")
    def employee(subject: Subject, actor: Actor = Depends(administrator)):
        try:
            return {"assignments": access.get(actor, subject)}
        except KeyError as error:
            raise HTTPException(404, "Employee unavailable") from error

    @router.put("/employees/{subject}/{module}", response_model=Assignment)
    def assign(subject: Subject, module: Identifier, update: Assignment, actor: Actor = Depends(administrator)):
        if subject == actor.subject:
            raise HTTPException(403, "An administrator must manage another employee")
        if module not in MODULES:
            raise HTTPException(404, "Module unavailable")
        try:
            return access.put(actor, subject, module, update)
        except KeyError as error:
            raise HTTPException(404, "Employee unavailable") from error
        except AssignmentConflict as error:
            raise HTTPException(409, "Assignment changed. Reload and review before saving.") from error
        except PermissionError as error:
            raise HTTPException(403, "Module administration permission required") from error
        except ValueError as error:
            raise HTTPException(422, str(error)) from error

    return router
