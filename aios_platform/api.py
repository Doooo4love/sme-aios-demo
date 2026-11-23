"""Factory for the production-shaped gateway. The existing PO demo is separate."""
from pathlib import Path
from typing import Annotated
import asyncio
import os
import sqlite3
import subprocess

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
import httpx
from psycopg import Error as PostgresError
from psycopg import OperationalError as PostgresUnavailable
from psycopg.errors import DeadlockDetected, LockNotAvailable, QueryCanceled, SerializationFailure
from pydantic import Field, JsonValue, ValidationError
from starlette.concurrency import run_in_threadpool

from aios_demo.extract_po import analyze_upload
from aios_demo.parsing import MAX_UPLOAD_BYTES
from aios_demo.storage import business_key, digest_of

from .assistant_agent import (
    AssistantAgent,
    resolve_llm_api_key,
    resolve_llm_base_url,
    resolve_llm_model,
    resolve_llm_provider,
)
from .assurance import Assurance, assurance_routes
from .assurance_audit import AuditKeys, SignedAudit
from .assurance_gateway import ReviewGateway
from .assurance_policy import DemoCaseSource
from .browser import BrowserConfig, BrowserOIDC, BrowserSessions, browser_routes
from .calendar import calendar_routes
from .channels import channel_routes
from .chat import DirectoryLookup, chat_routes
from .collaboration import InvalidCollaborationRequest, MissingResource
from .contracts import Actor, Clarify, DraftSalesOrder, Identifier, Plan, ShipmentRead, Strict
from .erp import ERPRejected
from .events import EventHub
from .governance import GovernanceService, governance_routes
from .identity import Identity
from .module_access import ModuleAccess, ModuleScopeChanged, module_routes
from .observability import instrument
from .providers import (
    DemoPlanner, OPA, Planner, action_sites, allowed, approval_sites, can_approve, can_use_action,
    order_read_sites,
)
from .profile import profile_routes
from .purchase import OrderIssue, PurchaseOrder, draft_order, from_ocr
from .service import Services, identity_for, optional_opa, planner_for, services, setting
from .tasks import task_routes
from .user_memory import MemoryBudgetError, MemoryPolicyError, memory_routes
from .workflow import Conflict, tick
from .workspace_source import DirectoryUnavailable, WorkspaceSource
from .workbench import WorkbenchPlanner, workbench_routes
from .workbench_tools import SyntheticWorkData, WorkData


class ActionRequest(Strict):
    text: Annotated[str, Field(min_length=1, max_length=500)]
    overrides: dict[Annotated[str, Field(max_length=40)], Annotated[str, Field(max_length=40)]] = Field(
        default_factory=dict, max_length=155,
    )


class ApprovalRequest(Strict):
    digest: Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]


class PurchaseBatch(Strict):
    orders: Annotated[list[JsonValue], Field(min_length=1, max_length=50)]


class BatchApprovalItem(ApprovalRequest):
    proposal_id: Identifier


class BatchApproval(Strict):
    proposals: Annotated[list[BatchApprovalItem], Field(min_length=1, max_length=50)]


class PauseRequest(Strict):
    paused: bool


class SuspensionRequest(Strict):
    suspended: bool


def build_app(runtime: Services, identity: Identity, planner: Planner, opa: OPA | None = None,
              *, planner_limit: int = 60, metrics_token: str | None = None,
              chat_directory: DirectoryLookup | None = None,
              workbench_data: WorkData | None = None, workbench_planner: WorkbenchPlanner | None = None,
              assurance: Assurance | None = None, assurance_concurrency: int = 8,
              browser: BrowserConfig | None = None, directory_actor=None,
              assistant_agent: AssistantAgent | None = None,
              event_hub: EventHub | None = None,
              governance: GovernanceService | None = None) -> FastAPI:
    if assurance is not None:
        if not isinstance(planner, DemoPlanner) or workbench_planner is not None or assistant_agent is not None:
            raise ValueError("Assurance requires disabling planners outside the governed provider gateway")
        if assurance.workflow is not runtime.workflow:
            raise ValueError("Assurance must use the current tenant workflow")
        if not runtime.demo and isinstance(assurance.source, DemoCaseSource):
            raise ValueError("Synthetic assurance sources require the demo profile")
    app = FastAPI(title="SME AIOS Platform", version="0.1.0", docs_url="/docs" if runtime.demo else None,
                  redoc_url=None, openapi_url="/openapi.json" if runtime.demo else None)
    if not 1 <= planner_limit <= 10000:
        raise ValueError("Planner limit must be between 1 and 10000 per tenant per minute")
    instrument(app, metrics_token)
    workflow = runtime.workflow
    erp = runtime.erp
    bearer = HTTPBearer(auto_error=False)
    module_access = ModuleAccess(workflow)
    hub = event_hub if event_hub is not None else EventHub()
    workflow.event_hub = hub
    known_actors: dict[tuple[str, str], Actor] = {}
    if browser is not None and browser.demo != runtime.demo:
        raise ValueError("Browser session profile must match the service profile")
    sessions = BrowserSessions(workflow, browser, runtime.profiles) if browser else None

    @app.exception_handler(MissingResource)
    async def missing_resource(_request: Request, _error: MissingResource):
        return JSONResponse(status_code=404, content={"detail": {"code": "RECORD_UNAVAILABLE"}})

    @app.exception_handler(InvalidCollaborationRequest)
    async def invalid_collaboration(_request: Request, error: InvalidCollaborationRequest):
        return JSONResponse(status_code=422, content={"detail": str(error)})

    @app.exception_handler(MemoryPolicyError)
    async def memory_policy_error(_request: Request, error: MemoryPolicyError):
        return JSONResponse(
            status_code=422,
            content={"detail": error.detail, "code": error.code, "reason": error.reason},
        )

    @app.exception_handler(MemoryBudgetError)
    async def memory_budget_error(_request: Request, error: MemoryBudgetError):
        return JSONResponse(
            status_code=422,
            content={
                "detail": error.detail,
                "code": error.code,
                "reason": error.reason,
                "token_count": error.token_count,
                "char_count": error.char_count,
                "max_tokens": error.max_tokens,
                "max_chars": error.max_chars,
            },
        )

    @app.exception_handler(Conflict)
    async def conflict(_request: Request, error: Conflict):
        return JSONResponse(status_code=409, content={"detail": str(error)})

    @app.exception_handler(DirectoryUnavailable)
    async def directory_unavailable(_request: Request, _error: DirectoryUnavailable):
        return JSONResponse(status_code=503, headers={"Retry-After": "2"},
                            content={"detail": {"code": "DIRECTORY_UNAVAILABLE"}})

    @app.exception_handler(PermissionError)
    async def permission_error(_request: Request, _error: PermissionError):
        return JSONResponse(status_code=403, content={"detail": {"code": "ACCESS_RESTRICTED"}})

    @app.exception_handler(ModuleScopeChanged)
    async def scope_changed(_request: Request, _error: ModuleScopeChanged):
        return JSONResponse(status_code=403, content={"detail": {"code": "ACCESS_CHANGED"}})

    def refresh_actor(actor: Actor) -> Actor:
        try:
            return module_access.refresh(actor)
        except PermissionError as error:
            raise ModuleScopeChanged from error

    @app.exception_handler(RequestValidationError)
    async def invalid_request(_request: Request, error: RequestValidationError):
        issues = [{"loc": item["loc"], "type": item["type"]} for item in error.errors()[:20]]
        return JSONResponse(status_code=422, content={"detail": issues})

    @app.exception_handler(PostgresUnavailable)
    @app.exception_handler(DeadlockDetected)
    @app.exception_handler(LockNotAvailable)
    @app.exception_handler(QueryCanceled)
    @app.exception_handler(SerializationFailure)
    @app.exception_handler(sqlite3.OperationalError)
    async def storage_unavailable(_request: Request, error: Exception):
        if isinstance(error, sqlite3.OperationalError):
            if (getattr(error, "sqlite_errorcode", 0) & 255) not in {sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED}:
                raise error
        return JSONResponse(status_code=503, headers={"Retry-After": "2"},
                            content={"detail": {"code": "STORAGE_UNAVAILABLE"}})

    def identify(token, *, cookie_tenant=None):
        try:
            actor = identity.authenticate(token)
            if cookie_tenant is not None and actor.tenant != cookie_tenant:
                raise ValueError("Browser session tenant changed")
            profile = runtime.profiles.get(actor.tenant)
            if profile is None:
                raise ValueError("Tenant is unavailable")
            actor = actor.model_copy(update={"warehouses": actor.warehouses.intersection(profile.warehouses)})
        except (ValueError, OSError) as error:
            raise HTTPException(401, "A valid access token is required",
                                headers={"WWW-Authenticate": "Bearer"}) from error
        try:
            scoped_actor = module_access.authenticate(actor)
            if len(known_actors) < 1000:
                known_actors[(scoped_actor.tenant, scoped_actor.subject)] = scoped_actor
            return scoped_actor
        except PermissionError as error:
            raise HTTPException(403, "AIOS access is suspended") from error

    def authenticate(request: Request, credentials: HTTPAuthorizationCredentials | None = Depends(bearer)) -> Actor:
        if credentials is not None:
            return identify(credentials.credentials)
        if sessions is not None:
            tenant, token = sessions.credentials(request)
            request.state.browser_session = True
            return identify(token, cookie_tenant=tenant)
        raise HTTPException(401, "A valid access token is required", headers={"WWW-Authenticate": "Bearer"})

    def require_scope(actor: Actor, action: str, warehouse: str):
        if warehouse not in runtime.profiles[actor.tenant].warehouses or not allowed(actor, action, warehouse):
            workflow.audit(actor, warehouse, "SCOPE_DENIED")
            raise HTTPException(403, "Action outside your role or warehouse scope")

    def require_policy(actor: Actor, plan: Plan, requester: str, stage: str):
        if opa is not None and not opa.permits(actor, plan, requester, stage):
            workflow.audit(actor, plan.warehouse, "EXTERNAL_POLICY_DENIED")
            raise HTTPException(403, "Policy denied this action")

    def visible_proposal(actor: Actor, proposal_id: str, *, include_events: bool = True) -> dict:
        try:
            result = workflow.get(actor.tenant, proposal_id, include_events=include_events)
            action, warehouse = result["plan"]["action"], result["warehouse"]
            if action == "sales_order.create_draft":
                sites = order_read_sites(actor)
            elif "shipment.read" in actor.module_scopes:
                sites = actor.sites_for("shipment.read")
            else:
                sites = action_sites(actor, action)
            can_read = warehouse in sites and (result["requester"] == actor.subject or actor.role in {"manager", "admin"})
            if not can_read and warehouse not in approval_sites(actor, action):
                raise KeyError(proposal_id)
            return result
        except KeyError as error:
            raise HTTPException(404, "Proposal not found") from error

    def visible_intake(actor: Actor, intake_id: str) -> dict:
        try:
            record = workflow.intake(actor.tenant, intake_id)
            if record["warehouse"] not in order_read_sites(actor):
                raise KeyError(intake_id)
            return record
        except KeyError as error:
            raise HTTPException(404, "Intake not found") from error

    def structured_evidence(order: PurchaseOrder) -> dict:
        document = order.model_dump(mode="json")
        return {"kind": "structured", "order": document, "artifact_sha256": digest_of(document)}

    def order_plan(actor: Actor, warehouse: str, intake_id: str, evidence: dict, order: PurchaseOrder) -> Plan:
        payload = draft_order(order, warehouse, runtime.profiles[actor.tenant])
        return Plan(tenant=actor.tenant, warehouse=warehouse, action="sales_order.create_draft",
                    target=business_key(payload), expected_version=None,
                    before={"intake_id": intake_id, "source_sha256": evidence["artifact_sha256"]}, after=payload)

    def prepare_order(actor: Actor, intake_id: str, overrides=None, *, expected_warehouse=None) -> Plan:
        record = visible_intake(actor, intake_id)
        warehouse = record["warehouse"]
        if expected_warehouse is not None and warehouse != expected_warehouse:
            raise HTTPException(404, "Intake not found")
        try:
            evidence = record["evidence"]
            if evidence["kind"] == "structured":
                if overrides:
                    raise ValueError("Submit a new structured record to correct an order")
                order = PurchaseOrder.model_validate(evidence["order"])
            else:
                order = from_ocr(evidence, overrides or {})
            return order_plan(actor, warehouse, intake_id, evidence, order)
        except ValueError as error:
            raise HTTPException(422, str(error)) from error

    def operator_grant(actor: Actor):
        if "operations.manage" not in actor.grants or actor.role not in {"manager", "admin"}:
            raise HTTPException(403, "Operational management permission required")

    @app.get("/healthz")
    def health():
        return {"status": "up"}

    @app.get("/readyz")
    def readiness():
        try:
            workflow.ping(next(iter(runtime.profiles)))
        except (sqlite3.Error, PostgresError, OSError) as error:
            raise HTTPException(503, "Database unavailable") from error
        return {"status": "ready"}

    if runtime.demo:
        @app.post("/v1/demo/worker-tick")
        def demo_worker(actor: Actor = Depends(authenticate)):
            operator_grant(actor)
            if actor.role != "admin":
                raise HTTPException(403, "Demo administrator required")
            return {"worked": tick(workflow, erp, actor.tenant)}

    @app.get("/v1/me")
    def me(actor: Actor = Depends(authenticate)):
        grants = (actor.grants - actor.module_scopes.keys()) | {
            grant for grant, sites in actor.module_scopes.items() if sites
        }
        return actor.model_copy(update={"grants": frozenset(grants)})

    @app.get("/v1/operations/summary")
    def operations(actor: Actor = Depends(authenticate)):
        operator_grant(actor)
        return {"proposals_by_state": workflow.summary(actor), "writes_paused": workflow.write_paused(actor.tenant)}

    @app.get("/v1/operations/exceptions")
    def exceptions(
        actor: Actor = Depends(authenticate),
        limit: Annotated[int, Query(ge=1, le=100)] = 50,
        after_due: Annotated[float | None, Query(ge=0, le=1e12)] = None,
        after_id: Identifier | None = None,
    ):
        operator_grant(actor)
        if (after_due is None) != (after_id is None):
            raise HTTPException(422, "Both cursor values are required")
        rows = workflow.exceptions(actor, limit + 1, None if after_due is None else (after_due, after_id))
        page = rows[:limit]
        next_page = {"after_due": page[-1]["due"], "after_id": page[-1]["proposal_id"]} if len(rows) > limit else None
        return {"items": page, "next": next_page}

    @app.put("/v1/operations/write-control")
    def control(body: PauseRequest, actor: Actor = Depends(authenticate)):
        operator_grant(actor)
        try:
            workflow.set_write_pause(actor, body.paused)
        except PermissionError as error:
            raise HTTPException(403, str(error)) from error
        return {"paused": body.paused}

    @app.put("/v1/operations/subjects/{subject}/suspension")
    def suspend(subject: Annotated[str, Field(min_length=1, max_length=150)],
                body: SuspensionRequest, actor: Actor = Depends(authenticate)):
        operator_grant(actor)
        try:
            workflow.set_suspension(actor, subject, body.suspended)
        except PermissionError as error:
            raise HTTPException(403, str(error)) from error
        return {"suspended": body.suspended}

    @app.post("/v1/intakes/{warehouse}", status_code=201)
    async def upload(warehouse: Identifier, request: Request, actor: Actor = Depends(authenticate)):
        await run_in_threadpool(require_scope, actor, "sales_order.create_draft", warehouse)
        if runtime.profiles[actor.tenant].ocr_template != "demo-wholesale-v1":
            raise HTTPException(422, "No image template configured for this tenant")
        if request.headers.get("content-type") != "application/octet-stream":
            raise HTTPException(415, "Send PNG/JPEG bytes as application/octet-stream")
        data = bytearray()
        try:
            async with asyncio.timeout(15):
                async for chunk in request.stream():
                    if len(data) + len(chunk) > MAX_UPLOAD_BYTES:
                        raise HTTPException(413, "Image exceeds 8 MB")
                    data.extend(chunk)
        except TimeoutError as error:
            raise HTTPException(408, "Upload timed out") from error
        try:
            evidence, _ = await run_in_threadpool(analyze_upload, bytes(data))
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        except (OSError, subprocess.SubprocessError) as error:
            raise HTTPException(503, "Local OCR unavailable") from error
        intake_id = await run_in_threadpool(workflow.add_intake, actor, warehouse, {"kind": "image", **evidence})
        return {"intake_id": intake_id, "warehouse": warehouse, "evidence": evidence}

    @app.post("/v1/intakes/{warehouse}/structured", status_code=201)
    def structured_intake(warehouse: Identifier, order: PurchaseOrder, actor: Actor = Depends(authenticate)):
        require_scope(actor, "sales_order.create_draft", warehouse)
        intake_id = workflow.add_intake(actor, warehouse, structured_evidence(order))
        return {"intake_id": intake_id, "warehouse": warehouse}

    @app.post("/v1/intakes/{warehouse}/structured/batch")
    def structured_batch(warehouse: Identifier, body: PurchaseBatch, actor: Actor = Depends(authenticate)):
        require_scope(actor, "sales_order.create_draft", warehouse)
        unique = {}
        versions = {}
        results = []
        entity = runtime.profiles[actor.tenant].warehouses[warehouse].legal_entity
        for position, raw in enumerate(body.orders):
            try:
                order = PurchaseOrder.model_validate(raw)
            except ValidationError as error:
                fields = [{"field": ".".join(map(str, issue["loc"])), "code": issue["type"]}
                          for issue in error.errors(include_input=False, include_url=False, include_context=False)[:10]]
                results.append({"position": position, "status": "review", "code": "INVALID_ORDER", "fields": fields})
                continue
            evidence = structured_evidence(order)
            intake_id = workflow.structured_intake_id(warehouse, evidence)
            unique[intake_id] = (evidence, order)
            versions.setdefault((entity, order.buyer, order.po), set()).add(intake_id)
            results.append({"position": position, "intake_id": intake_id})

        issues = {intake_id: "CONFLICTING_ORDER_REVISIONS"
                  for ids in versions.values() if len(ids) > 1 for intake_id in ids}
        entries = []
        for intake_id, (evidence, order) in unique.items():
            plan = None
            if intake_id not in issues:
                try:
                    candidate = order_plan(actor, warehouse, intake_id, evidence, order)
                    require_policy(actor, candidate, actor.subject, "propose")
                except OrderIssue as error:
                    issues[intake_id] = error.code
                except HTTPException as error:
                    if error.status_code != 403:
                        raise
                    issues[intake_id] = "POLICY_DENIED"
                else:
                    plan = candidate
            entries.append((evidence, plan))
        prepared = workflow.prepare_orders(actor, warehouse, entries) if entries else {}
        for result in results:
            intake_id = result.get("intake_id")
            if intake_id in issues:
                result.update(status="review", code=issues[intake_id])
            elif intake_id in prepared:
                result.update(prepared[intake_id], status="prepared")
        return {"items": results}

    @app.get("/v1/intakes/{intake_id}")
    def get_intake(intake_id: Identifier, actor: Actor = Depends(authenticate)):
        return visible_intake(actor, intake_id)

    @app.post("/v1/actions")
    def interpret(
        body: ActionRequest, actor: Actor = Depends(authenticate),
        key: Annotated[str | None, Header(alias="Idempotency-Key", pattern=r"^[A-Za-z0-9._:-]{1,128}$")] = None,
    ):
        if not any(can_use_action(actor, action) for action in ("shipment.read", "sales_order.create_draft")):
            raise HTTPException(403, "Operational action permission required")
        fingerprint = digest_of(body.model_dump(mode="json"))
        if key is not None:
            try:
                prior = workflow.find_request(actor, key, fingerprint)
            except Conflict as error:
                raise HTTPException(409, str(error)) from error
            if prior:
                return {"status": "proposed", **visible_proposal(actor, prior)}
        if not workflow.take_planner_budget(actor.tenant, planner_limit):
            raise HTTPException(429, "Tenant planner budget exhausted", headers={"Retry-After": "60"})
        try:
            intent = planner.plan(body.text)
        except (httpx.HTTPError, OSError, ValueError, KeyError, TypeError, IndexError) as error:
            raise HTTPException(503, "Planner unavailable") from error
        actor = refresh_actor(actor)
        if isinstance(intent, Clarify):
            return {"status": "clarify", "question": intent.question}
        if not can_use_action(actor, intent.action):
            workflow.audit(actor, intent.action, "ACTION_GRANT_DENIED")
            raise HTTPException(403, "Action permission required")
        if isinstance(intent, DraftSalesOrder):
            plan = prepare_order(actor, intent.intake_id, body.overrides)
        else:
            try:
                shipment = erp.shipment(actor.tenant, intent.shipment_id)
            except ERPRejected as error:
                raise HTTPException(404, "Shipment not found") from error
            except (httpx.HTTPError, OSError, ValueError) as error:
                raise HTTPException(503, "ERP read unavailable") from error
            actor = refresh_actor(actor)
            if shipment is None or shipment.shipment_id != intent.shipment_id or (
                not allowed(actor, "shipment.read", shipment.warehouse)
            ):
                workflow.audit(actor, intent.shipment_id, "SHIPMENT_NOT_VISIBLE")
                raise HTTPException(404, "Shipment not found")
            current = shipment.model_dump(mode="json")
            if isinstance(intent, ShipmentRead):
                workflow.audit(actor, shipment.shipment_id, "SHIPMENT_READ")
                return {"status": "read", "shipment": current}
            require_scope(actor, intent.action, shipment.warehouse)
            if shipment.status != "OPEN" or shipment.delivery_date == intent.delivery_date:
                raise HTTPException(409, "Select an open shipment and a changed delivery date")
            plan = Plan(tenant=actor.tenant, warehouse=shipment.warehouse, action=intent.action,
                        target=shipment.shipment_id, expected_version=shipment.version, before=current,
                        after={"delivery_date": intent.delivery_date.isoformat()})
        require_policy(actor, plan, actor.subject, "propose")
        try:
            proposal_id = workflow.propose(actor, plan, idempotency=(key, fingerprint) if key else None)
        except Conflict as error:
            raise HTTPException(409, str(error)) from error
        return {"status": "proposed", **visible_proposal(actor, proposal_id)}

    @app.get("/v1/proposals/{proposal_id}")
    def get_proposal(proposal_id: Identifier, actor: Actor = Depends(authenticate)):
        return visible_proposal(actor, proposal_id)

    def approve_proposal(proposal_id: str, digest: str, actor: Actor):
        current = visible_proposal(actor, proposal_id, include_events=False)
        plan = Plan.model_validate(current["plan"])
        if not can_approve(actor, current["requester"], plan):
            workflow.audit(actor, proposal_id, "APPROVAL_DENIED")
            raise HTTPException(403, "An independent warehouse manager must approve")
        require_policy(actor, plan, current["requester"], "approve")
        try:
            workflow.approve(actor, proposal_id, digest)
        except Conflict as error:
            raise HTTPException(409, str(error)) from error
        except PermissionError as error:
            raise HTTPException(403, str(error)) from error

    @app.post("/v1/proposals/approve-batch")
    def approve_batch(body: BatchApproval, actor: Actor = Depends(authenticate)):
        if actor.role not in {"manager", "admin"}:
            raise HTTPException(403, "Manager access required")
        items = []
        for entry in body.proposals:
            try:
                approve_proposal(entry.proposal_id, entry.digest, actor)
            except HTTPException as error:
                if error.status_code not in {403, 404, 409}:
                    raise
                items.append({"proposal_id": entry.proposal_id, "status": error.status_code, "detail": error.detail})
            else:
                items.append({"proposal_id": entry.proposal_id, "status": 202})
        return {"items": items}

    @app.post("/v1/proposals/{proposal_id}/approve", status_code=202)
    def approve(proposal_id: Identifier, body: ApprovalRequest, actor: Actor = Depends(authenticate)):
        approve_proposal(proposal_id, body.digest, actor)
        return visible_proposal(actor, proposal_id)

    @app.post("/v1/proposals/{proposal_id}/reconcile", status_code=202)
    def reconcile(proposal_id: Identifier, actor: Actor = Depends(authenticate)):
        operator_grant(actor)
        visible_proposal(actor, proposal_id)
        try:
            workflow.reopen_verification(actor, proposal_id)
        except Conflict as error:
            raise HTTPException(409, str(error)) from error
        except PermissionError as error:
            raise HTTPException(403, str(error)) from error
        return visible_proposal(actor, proposal_id)

    if runtime.demo:
        if chat_directory is None:
            chat_directory = getattr(identity, "known_subject", None)
        if directory_actor is None:
            directory_actor = getattr(identity, "directory_actor", None)
    if runtime.demo and workbench_data is None:
        workbench_data = SyntheticWorkData()
    if not runtime.demo and isinstance(workbench_data, SyntheticWorkData):
        raise ValueError("Synthetic workbench data requires the demo profile")

    def resolve_approvers(tenant: str, plan: Plan, requester: str) -> list[str]:
        candidates: set[str] = set()
        if hasattr(identity, "PEOPLE"):
            for name, (person_tenant, role, _wh) in identity.PEOPLE.items():
                if person_tenant == tenant and role in {"manager", "admin"}:
                    candidates.add(name)
        with workflow.tx(tenant, write=False) as run:
            rows = run("SELECT subject FROM aios_employee WHERE tenant = ?", (tenant,)).fetchall()
            for row in rows:
                candidates.add(row["subject"])
        for cached_tenant, cached_subject in list(known_actors):
            if cached_tenant == tenant:
                candidates.add(cached_subject)
        candidates.discard(requester)
        lookup = directory_actor or getattr(identity, "directory_actor", None)
        eligible: list[str] = []
        for subject in sorted(candidates):
            candidate = lookup(tenant, subject) if lookup is not None else known_actors.get((tenant, subject))
            if candidate is None:
                continue
            try:
                scoped = module_access.refresh(candidate)
            except PermissionError:
                continue
            if can_approve(scoped, requester, plan):
                eligible.append(subject)
        return eligible

    workflow.approver_resolver = resolve_approvers
    governance_service = governance if governance is not None else GovernanceService(
        workflow, hub, known_subject=chat_directory,
    )
    active_assistant = assistant_agent
    if assurance is None and active_assistant is None and workbench_planner is None:
        active_assistant = AssistantAgent(workflow, governance_service, hub, api_key=None, demo=runtime.demo)

    app.include_router(module_routes(module_access, authenticate, runtime.profiles))
    app.include_router(workbench_routes(runtime, authenticate, refresh_actor, require_policy, visible_proposal, prepare_order,
                                       data=workbench_data, chat_available=chat_directory is not None,
                                       planner=workbench_planner, planner_limit=planner_limit,
                                       assistant=active_assistant, event_hub=hub))
    app.include_router(governance_routes(governance_service, workflow, authenticate, refresh_actor))
    app.include_router(channel_routes(workflow, authenticate, refresh_actor, governance=governance_service,
                                      known_subject=chat_directory, allowed_tenants=frozenset(runtime.profiles)))
    app.include_router(chat_routes(workflow, authenticate, known_subject=chat_directory))
    app.include_router(assurance_routes(authenticate, assurance, concurrency=assurance_concurrency))
    app.include_router(profile_routes(workflow, authenticate, chat_available=chat_directory is not None))
    app.include_router(
        memory_routes(
            workflow,
            authenticate,
            llm_provider=active_assistant.llm_provider if active_assistant is not None else None,
            telemetry=active_assistant.telemetry if active_assistant is not None else None,
        )
    )
    app.include_router(calendar_routes(workflow, authenticate, chat_directory))
    app.include_router(task_routes(workflow, authenticate, visible_proposal, require_policy, directory_actor))
    if sessions is not None:
        app.include_router(browser_routes(sessions, authenticate, bearer, identify))
    return app


def create_app() -> FastAPI:
    runtime = services()
    metrics = (setting("AIOS_METRICS_TOKEN")
               if os.getenv("AIOS_METRICS_TOKEN") or os.getenv("AIOS_METRICS_TOKEN_FILE") else None)
    workspace_source = None
    if not runtime.demo and (os.getenv("AIOS_WORKSPACE_SOURCE_URL") or os.getenv("AIOS_WORKSPACE_SOURCE_URL_FILE")):
        workspace_source = WorkspaceSource(setting("AIOS_WORKSPACE_SOURCE_URL"),
                                           setting("AIOS_WORKSPACE_SOURCE_TOKEN"),
                                           setting("AIOS_CONNECTOR_TENANT"))
    assurance = None
    if not runtime.demo and os.getenv("AIOS_ASSURANCE_KEY_FILE"):
        if workspace_source is None:
            raise ValueError("Production Assurance requires a workspace source")
        audit = SignedAudit(runtime.workflow, AuditKeys.from_file(Path(os.environ["AIOS_ASSURANCE_KEY_FILE"])))
        assurance = Assurance(workspace_source, ReviewGateway(audit, setting("AIOS_ASSURANCE_ZONE")),
                              review_ttl=int(setting("AIOS_ASSURANCE_REVIEW_TTL", "3600")))
    if key_file := os.getenv("AIOS_ASSURANCE_DEMO_KEY_FILE"):
        if not runtime.demo:
            raise ValueError("Demo assurance keys require the demo profile")
        audit = SignedAudit(runtime.workflow, AuditKeys.from_file(Path(key_file)))
        assurance = Assurance(DemoCaseSource(), ReviewGateway(audit, "hk-factory"),
                              review_ttl=int(setting("AIOS_ASSURANCE_REVIEW_TTL", "3600")))
    workbench_planner = None
    assistant_agent = None
    planner_kind = os.getenv("AIOS_WORKBENCH_PLANNER", "local")
    if planner_kind not in {"local", "pydantic-ai", "deepseek", "llm"}:
        raise ValueError("Unknown AIOS workbench planner")
    identity = identity_for(runtime.demo)
    chat_dir = workspace_source.known_subject if workspace_source else (
        getattr(identity, "known_subject", None) if runtime.demo else None
    )
    hub = EventHub()
    governance_service = GovernanceService(runtime.workflow, hub, known_subject=chat_dir)
    if assurance is not None:
        if planner_kind != "local":
            raise ValueError("Assurance requires disabling planners outside the governed provider gateway")
    else:
        llm_api_key = resolve_llm_api_key()
        if planner_kind == "pydantic-ai" and not llm_api_key:
            raise ValueError("Configure AIOS_LLM_API_KEY or AIOS_LLM_API_KEY_FILE")
        if llm_api_key:
            resolved_model = resolve_llm_model()
            assistant_agent = AssistantAgent(
                runtime.workflow,
                governance_service,
                hub,
                api_key=llm_api_key,
                base_url=resolve_llm_base_url(resolved_model),
                model=resolved_model,
                provider=resolve_llm_provider(),
                demo=runtime.demo,
            )
    browser = None
    if os.getenv("AIOS_BROWSER_ORIGIN") or os.getenv("AIOS_BROWSER_ORIGIN_FILE"):
        oidc = None
        if not runtime.demo and (os.getenv("AIOS_BFF_OIDC_CLIENT_ID") or os.getenv("AIOS_BFF_OIDC_CLIENT_ID_FILE")):
            oidc = BrowserOIDC(setting("AIOS_OIDC_ISSUER"), setting("AIOS_BFF_OIDC_CLIENT_ID"),
                               setting("AIOS_BFF_OIDC_CLIENT_SECRET"))
        browser = BrowserConfig(setting("AIOS_BROWSER_ORIGIN"), bytes.fromhex(setting("AIOS_BROWSER_SESSION_KEY")),
                                demo=runtime.demo, oidc=oidc)
    return build_app(runtime, identity, planner_for(runtime.demo), optional_opa(),
                     planner_limit=int(setting("AIOS_PLANNER_CALLS_PER_MINUTE", "60")),
                     metrics_token=metrics, assurance=assurance, workbench_planner=workbench_planner,
                     assurance_concurrency=int(setting("AIOS_ASSURANCE_CONCURRENCY", "8")), browser=browser,
                     chat_directory=workspace_source.known_subject if workspace_source else None,
                     directory_actor=workspace_source.directory_actor if workspace_source else None,
                     workbench_data=workspace_source, assistant_agent=assistant_agent,
                     event_hub=hub, governance=governance_service)
