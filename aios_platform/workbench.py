"""Employee workbench. Parsed language and typed calls share one enforcement path."""
import re
from typing import Annotated, Literal, Protocol

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import Field

from aios_demo.storage import digest_of

from .contracts import Actor, Clarify, Identifier, Plan, Strict
from .erp import ERPRejected, ERP_TRANSPORT_ERRORS
from .providers import approval_sites, can_approve, order_read_sites
from .service import Services
from .workbench_tools import OrderDraft, ShipmentChange, ToolCall, TOOLS, WorkData, scoped_data, local_turn
from .workflow import Conflict

IdempotencyKey = Annotated[str | None, Header(alias="Idempotency-Key", pattern=r"^[A-Za-z0-9._:-]{1,128}$")]


class WorkbenchPlanner(Protocol):
    def plan(self, text: str, offered_tools: tuple[str, ...]) -> dict: ...


class Turn(Strict):
    text: Annotated[str, Field(min_length=1, max_length=500)]


class WorkResult(Strict):
    kind: Literal["result"] = "result"
    tool: str
    source: str
    data: dict


class WorkProposal(Strict):
    kind: Literal["proposal"] = "proposal"
    tool: str
    proposal: dict


class Clarification(Strict):
    kind: Literal["clarification"] = "clarification"
    question: Annotated[str, Field(min_length=1, max_length=300)]


class ApprovalIntent(Strict):
    kind: Literal["approval_intent"]
    proposal_id: Identifier


class ApprovalPreview(Strict):
    kind: Literal["approval_preview"] = "approval_preview"
    proposal: dict


class PlannedTurn(Strict):
    intent: ToolCall | ApprovalIntent | Clarification


TurnResult = Annotated[WorkResult | WorkProposal | ApprovalPreview | Clarification, Field(discriminator="kind")]
APPROVAL_TEXT = re.compile(r"(?:approve proposal |(?:批准|审批)提案\s*)([A-Za-z0-9_-]{1,64})", re.IGNORECASE)


def workbench_routes(runtime: Services, authenticate, refresh_actor, require_policy, visible_proposal, prepare_order,
                     *, data: WorkData | None, chat_available: bool, planner: WorkbenchPlanner | None,
                     planner_limit: int) -> APIRouter:
    router = APIRouter(prefix="/v1/workbench", tags=["Employee workbench"])
    workflow = runtime.workflow

    def source(name):
        domain = TOOLS[name].domain
        if domain == "erp":
            return "synthetic" if runtime.demo else "erp"
        if data is None:
            return "unconfigured"
        return "synthetic" if runtime.demo else domain

    def read_or_preview(actor: Actor, request: ToolCall) -> dict | Plan:
        if isinstance(request, OrderDraft):
            return prepare_order(actor, request.intake_id, expected_warehouse=request.warehouse)
        if TOOLS[request.tool].domain != "erp":
            if data is None:
                raise HTTPException(503, "This connector is not configured")
            try:
                return scoped_data(data, actor, request)
            except KeyError as error:
                raise HTTPException(404, "Resource not found") from error
            except ERP_TRANSPORT_ERRORS as error:
                raise HTTPException(503, "Connector unavailable") from error
        try:
            shipment = runtime.erp.shipment(actor.tenant, request.shipment_id)
        except ERPRejected as error:
            raise HTTPException(404, "Resource not found") from error
        except ERP_TRANSPORT_ERRORS as error:
            raise HTTPException(503, "Shipment lookup unavailable") from error
        if shipment is None or (shipment.warehouse, shipment.shipment_id) != (request.warehouse, request.shipment_id):
            raise HTTPException(404, "Resource not found")
        current = shipment.model_dump(mode="json")
        if not isinstance(request, ShipmentChange):
            return current
        if shipment.status != "OPEN" or shipment.delivery_date == request.delivery_date:
            raise HTTPException(409, "Select an open shipment and a changed delivery date")
        return Plan(tenant=actor.tenant, warehouse=request.warehouse, action="shipment.reschedule",
                    target=shipment.shipment_id, expected_version=shipment.version,
                    before=current, after={"delivery_date": request.delivery_date.isoformat()})

    def propose(actor: Actor, request: ToolCall, key: str | None) -> WorkProposal:
        if key is None:
            raise HTTPException(422, "Idempotency-Key is required for proposals")
        binding = ("workbench/" + key, digest_of(request.model_dump(mode="json")))
        try:
            proposal_id = workflow.find_request(actor, *binding)
            if proposal_id is None:
                plan = read_or_preview(actor, request)
                if not isinstance(plan, Plan):
                    raise RuntimeError("Proposal tools must produce a plan")
                require_policy(actor, plan, actor.subject, "propose")
                proposal_id = workflow.propose(actor, plan, idempotency=binding)
        except Conflict as error:
            raise HTTPException(409, str(error)) from error
        return WorkProposal(tool=request.tool, proposal=visible_proposal(actor, proposal_id))

    def execute(actor: Actor, request: ToolCall, key: str | None) -> WorkResult | WorkProposal:
        spec = TOOLS[request.tool]
        warehouse = getattr(request, "warehouse", None)
        if not spec.allowed(actor, warehouse=warehouse):
            workflow.audit(actor, request.tool, "WORKBENCH_DENIED")
            raise HTTPException(403, {"code": "ACCESS_RESTRICTED"})
        if spec.mode == "proposal":
            return propose(actor, request, key)
        result = read_or_preview(actor, request)
        if isinstance(result, Plan):
            raise RuntimeError("Read tools cannot produce a plan")
        if not spec.allowed(refresh_actor(actor), warehouse=warehouse):
            workflow.audit(actor, request.tool, "WORKBENCH_DENIED")
            raise HTTPException(403, {"code": "ACCESS_CHANGED"})
        workflow.audit(actor, request.tool, "WORKBENCH_READ")
        return WorkResult(tool=request.tool, source=source(request.tool), data=result)

    def offered_tools(actor):
        return [name for name, spec in TOOLS.items() if spec.allowed(actor)]

    @router.get("/capabilities")
    def capabilities(actor: Actor = Depends(authenticate)):
        return {"tools": [
            {"id": name, "mode": TOOLS[name].mode, "available": source(name) != "unconfigured",
             "source": source(name),
             "warehouses": sorted(TOOLS[name].sites(actor)) if TOOLS[name].domain != "mail" else []}
            for name in offered_tools(actor)
        ], "order_read_warehouses": sorted(order_read_sites(actor)), "approval_warehouses": {
            action: sorted(approval_sites(actor, action)) for action in ("sales_order.create_draft", "shipment.reschedule")
        }, "planner": "local_rules" if planner is None else "configured",
           "chat_available": chat_available and "chat.use" in actor.grants}

    @router.get("/approvals")
    def approvals(actor: Actor = Depends(authenticate), limit: Annotated[int, Query(ge=1, le=100)] = 50,
                  after_due: Annotated[float | None, Query(ge=0, le=1e12)] = None,
                  after_id: Identifier | None = None):
        if actor.role not in {"manager", "admin"}:
            raise HTTPException(403, "Approver role required")
        if (after_due is None) != (after_id is None):
            raise HTTPException(422, "Both cursor values are required")
        after = None if after_due is None else (after_due, after_id)
        rows = workflow.pending_approvals(actor, limit + 1, after)
        items = rows[:limit]
        next_page = {"after_due": items[-1]["due"], "after_id": items[-1]["id"]} if len(rows) > limit else None
        return {"items": items, "next": next_page}

    @router.post("/calls", response_model=WorkResult | WorkProposal)
    def calls(body: ToolCall, actor: Actor = Depends(authenticate), key: IdempotencyKey = None):
        return execute(actor, body, key)

    @router.post("/turns", response_model=TurnResult)
    def turns(body: Turn, actor: Actor = Depends(authenticate), key: IdempotencyKey = None):
        match = APPROVAL_TEXT.fullmatch(body.text.strip())
        request = ApprovalIntent(kind="approval_intent", proposal_id=match[1]) if match else local_turn(body.text)
        if isinstance(request, Clarify):
            if planner is None:
                return Clarification(question=request.question)
            offered = tuple(name for name in offered_tools(actor) if source(name) != "unconfigured")
            if any(approval_sites(actor, action) for action in ("shipment.reschedule", "sales_order.create_draft")):
                offered += ("approval.preview",)
            if not offered:
                return Clarification(question="No workbench tools are available for this account.")
            if not workflow.take_planner_budget(actor.tenant, planner_limit):
                raise HTTPException(429, "Tenant planner budget exhausted", headers={"Retry-After": "60"})
            try:
                proposed = planner.plan(body.text, offered)
                request = PlannedTurn.model_validate({"intent": proposed}).intent
            except (*ERP_TRANSPORT_ERRORS, TypeError, AttributeError) as error:
                raise HTTPException(503, "Workbench planner could not return a valid intent") from error
            actor = refresh_actor(actor)
            if isinstance(request, Clarification):
                return Clarification(question="Choose an available operation and include the reference or warehouse.")
        try:
            if isinstance(request, ApprovalIntent):
                proposal = visible_proposal(actor, request.proposal_id, include_events=False)
                plan = Plan.model_validate(proposal["plan"])
                if not can_approve(actor, proposal["requester"], plan):
                    workflow.audit(actor, "approval.preview", "WORKBENCH_DENIED")
                    raise HTTPException(403, {"code": "ACTION_NOT_ALLOWED", "next_step": "view_proposal"})
                return ApprovalPreview(proposal=proposal)
            return execute(actor, request, key)
        except HTTPException as error:
            if error.status_code == 404:
                raise HTTPException(404, {"code": "RECORD_UNAVAILABLE"}) from error
            raise

    return router
