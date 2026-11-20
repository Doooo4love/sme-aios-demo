"""Factory for the production-shaped gateway. The existing PO demo is separate."""
from typing import Annotated
import subprocess

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
import httpx
from pydantic import Field
from starlette.concurrency import run_in_threadpool

from aios_demo.extract_po import analyze_upload
from aios_demo.parsing import MAX_UPLOAD_BYTES
from aios_demo.storage import business_key, digest_of

from .contracts import Actor, Clarify, DraftSalesOrder, Identifier, Plan, ShipmentRead, Strict
from .erp import ERPRejected
from .identity import Identity
from .providers import OPA, Planner, allowed, can_approve
from .purchase import PurchaseOrder, draft_order, from_ocr
from .service import Services, identity_for, optional_opa, planner_for, services
from .workflow import Conflict, tick


class ActionRequest(Strict):
    text: Annotated[str, Field(min_length=1, max_length=500)]
    overrides: dict[Annotated[str, Field(max_length=40)], Annotated[str, Field(max_length=40)]] = Field(
        default_factory=dict, max_length=155,
    )


class ApprovalRequest(Strict):
    digest: Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]


def build_app(runtime: Services, identity: Identity, planner: Planner, opa: OPA | None = None) -> FastAPI:
    app = FastAPI(title="SME AIOS Platform", version="0.1.0", docs_url="/docs" if runtime.demo else None,
                  redoc_url=None, openapi_url="/openapi.json" if runtime.demo else None)
    workflow = runtime.workflow
    erp = runtime.erp
    bearer = HTTPBearer(auto_error=False)

    def authenticate(credentials: HTTPAuthorizationCredentials | None = Depends(bearer)) -> Actor:
        try:
            if credentials is None:
                raise ValueError("Missing access token")
            actor = identity.authenticate(credentials.credentials)
            if actor.tenant not in runtime.profiles:
                raise ValueError("Tenant is unavailable")
            return actor
        except (ValueError, OSError) as error:
            raise HTTPException(401, "A valid access token is required",
                                headers={"WWW-Authenticate": "Bearer"}) from error

    def require_scope(actor: Actor, action: str, warehouse: str):
        if warehouse not in runtime.profiles[actor.tenant].warehouses or not allowed(actor, action, warehouse):
            workflow.audit(actor, warehouse, "SCOPE_DENIED")
            raise HTTPException(403, "Action outside your role or warehouse scope")

    def require_policy(actor: Actor, plan: Plan, requester: str, stage: str):
        if opa is not None and not opa.permits(actor, plan, requester, stage):
            workflow.audit(actor, plan.warehouse, "EXTERNAL_POLICY_DENIED")
            raise HTTPException(403, "Policy denied this action")

    def visible_proposal(actor: Actor, proposal_id: str) -> dict:
        try:
            result = workflow.get(actor.tenant, proposal_id)
            if result["warehouse"] not in actor.warehouses or (
                result["requester"] != actor.subject and actor.role not in {"manager", "admin"}
            ):
                raise KeyError(proposal_id)
            return result
        except KeyError as error:
            raise HTTPException(404, "Proposal not found") from error

    def visible_intake(actor: Actor, intake_id: str) -> dict:
        try:
            record = workflow.intake(actor.tenant, intake_id)
            if not allowed(actor, "shipment.read", record["warehouse"]):
                raise KeyError(intake_id)
            return record
        except KeyError as error:
            raise HTTPException(404, "Intake not found") from error

    @app.get("/healthz")
    def health():
        return {"status": "up"}

    if runtime.demo:
        @app.post("/v1/demo/worker-tick")
        def demo_worker(actor: Actor = Depends(authenticate)):
            if actor.role != "admin":
                raise HTTPException(403, "Demo administrator required")
            return {"worked": tick(workflow, erp, actor.tenant)}

    @app.get("/v1/me")
    def me(actor: Actor = Depends(authenticate)):
        return actor

    @app.get("/v1/operations/summary")
    def operations(actor: Actor = Depends(authenticate)):
        if actor.role not in {"manager", "admin"}:
            raise HTTPException(403, "Manager access required")
        return {"proposals_by_state": workflow.summary(actor)}

    @app.post("/v1/intakes/{warehouse}", status_code=201)
    async def upload(warehouse: Identifier, request: Request, actor: Actor = Depends(authenticate)):
        await run_in_threadpool(require_scope, actor, "sales_order.create_draft", warehouse)
        if runtime.profiles[actor.tenant].ocr_template != "demo-wholesale-v1":
            raise HTTPException(422, "No image template configured for this tenant")
        if request.headers.get("content-type") != "application/octet-stream":
            raise HTTPException(415, "Send PNG/JPEG bytes as application/octet-stream")
        data = bytearray()
        async for chunk in request.stream():
            if len(data) + len(chunk) > MAX_UPLOAD_BYTES:
                raise HTTPException(413, "Image exceeds 8 MB")
            data.extend(chunk)
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
        document = order.model_dump(mode="json")
        intake_id = workflow.add_intake(actor, warehouse, {
            "kind": "structured", "order": document, "artifact_sha256": digest_of(document),
        })
        return {"intake_id": intake_id, "warehouse": warehouse}

    @app.get("/v1/intakes/{intake_id}")
    def get_intake(intake_id: Identifier, actor: Actor = Depends(authenticate)):
        return visible_intake(actor, intake_id)

    @app.post("/v1/actions")
    def interpret(body: ActionRequest, actor: Actor = Depends(authenticate)):
        try:
            intent = planner.plan(body.text)
        except (httpx.HTTPError, OSError, ValueError, KeyError, TypeError, IndexError) as error:
            raise HTTPException(503, "Planner unavailable") from error
        if isinstance(intent, Clarify):
            return {"status": "clarify", "question": intent.question}
        if not isinstance(intent, ShipmentRead) and actor.role == "viewer":
            workflow.audit(actor, intent.action, "ROLE_DENIED")
            raise HTTPException(403, "Viewer access is read-only")
        if isinstance(intent, DraftSalesOrder):
            record = visible_intake(actor, intent.intake_id)
            warehouse = record["warehouse"]
            require_scope(actor, intent.action, warehouse)
            try:
                evidence = record["evidence"]
                if evidence["kind"] == "structured":
                    if body.overrides:
                        raise ValueError("Submit a new structured record to correct an order")
                    order = PurchaseOrder.model_validate(evidence["order"])
                else:
                    order = from_ocr(evidence, body.overrides)
                payload = draft_order(order, warehouse, runtime.profiles[actor.tenant])
            except ValueError as error:
                raise HTTPException(422, str(error)) from error
            plan = Plan(tenant=actor.tenant, warehouse=warehouse, action=intent.action,
                        target=business_key(payload), expected_version=None,
                        before={"intake_id": intent.intake_id,
                                "source_sha256": record["evidence"]["artifact_sha256"]}, after=payload)
        else:
            try:
                shipment = erp.shipment(actor.tenant, intent.shipment_id)
            except ERPRejected as error:
                raise HTTPException(404, "Shipment not found") from error
            except (httpx.HTTPError, OSError, ValueError) as error:
                raise HTTPException(503, "ERP read unavailable") from error
            if shipment is None or shipment.warehouse not in runtime.profiles[actor.tenant].warehouses or (
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
        proposal_id = workflow.propose(actor, plan)
        return {"status": "proposed", **visible_proposal(actor, proposal_id)}

    @app.get("/v1/proposals/{proposal_id}")
    def get_proposal(proposal_id: Identifier, actor: Actor = Depends(authenticate)):
        return visible_proposal(actor, proposal_id)

    @app.post("/v1/proposals/{proposal_id}/approve", status_code=202)
    def approve(proposal_id: Identifier, body: ApprovalRequest, actor: Actor = Depends(authenticate)):
        current = visible_proposal(actor, proposal_id)
        plan = Plan.model_validate(current["plan"])
        if not can_approve(actor, current["requester"], plan):
            workflow.audit(actor, proposal_id, "APPROVAL_DENIED")
            raise HTTPException(403, "An independent warehouse manager must approve")
        require_policy(actor, plan, current["requester"], "approve")
        try:
            workflow.approve(actor, proposal_id, body.digest)
        except Conflict as error:
            raise HTTPException(409, str(error)) from error
        return visible_proposal(actor, proposal_id)

    return app


def create_app() -> FastAPI:
    runtime = services()
    return build_app(runtime, identity_for(runtime.demo), planner_for(runtime.demo), optional_opa())
