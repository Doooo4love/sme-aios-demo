"""Employee workbench. Parsed language and typed calls share one enforcement path."""
import asyncio
import json
import re
import time
from typing import Annotated, Literal, Protocol

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import Field
from starlette.concurrency import run_in_threadpool

from aios_demo.storage import digest_of

from .agent_history import AgentHistory, TurnInProgress
from .assistant_agent import (
    AssistantAgent,
    AssistantMessage,
    ConversationTurn,
    PolicyRefusal,
    WorkAlertItem,
    WorkPulseResponse,
    skills_for_actor,
)
from .contracts import Actor, Clarify, Identifier, Plan, Strict
from .erp import ERPRejected, ERP_TRANSPORT_ERRORS
from .providers import approval_sites, can_approve, order_read_sites
from .service import Services
from .workbench_tools import CALL, OrderDraft, ShipmentChange, ToolCall, TOOLS, WorkData, scoped_data, local_turn
from .workflow import Conflict

IdempotencyKey = Annotated[str | None, Header(alias="Idempotency-Key", pattern=r"^[A-Za-z0-9._:-]{1,128}$")]


class WorkbenchPlanner(Protocol):
    def plan(self, text: str, offered_tools: tuple[str, ...]) -> dict: ...


class ActiveDocumentRef(Strict):
    doc_id: Annotated[str, Field(min_length=1, max_length=128)]
    title: Annotated[str, Field(min_length=1, max_length=240)]
    content: Annotated[str, Field(min_length=1, max_length=1_500_000)]


class Turn(Strict):
    text: Annotated[str, Field(min_length=1, max_length=2000)]
    client_id: Identifier | None = None
    locale: Literal["zh-CN", "zh-HK", "en"] = "zh-CN"
    conversation_context: Annotated[list[ConversationTurn], Field(max_length=40)] = Field(default_factory=list)
    session_id: Identifier | None = None
    active_document: ActiveDocumentRef | None = None
    task_switched: bool = False


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


TurnResult = Annotated[
    WorkResult | WorkProposal | ApprovalPreview | Clarification | AssistantMessage | PolicyRefusal,
    Field(discriminator="kind"),
]
APPROVAL_TEXT = re.compile(r"(?:approve proposal |(?:批准|审批)提案\s*)([A-Za-z0-9_-]{1,64})", re.IGNORECASE)


def workbench_routes(runtime: Services, authenticate, refresh_actor, require_policy, visible_proposal, prepare_order,
                     *, data: WorkData | None, chat_available: bool, planner: WorkbenchPlanner | None,
                     planner_limit: int, assistant: AssistantAgent | None = None,
                     event_hub=None) -> APIRouter:
    router = APIRouter(prefix="/v1/workbench", tags=["Employee workbench"])
    workflow = runtime.workflow
    history = AgentHistory(workflow)

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
    def capabilities(request: Request, actor: Actor = Depends(authenticate)):
        result = {"tools": [
            {"id": name, "mode": TOOLS[name].mode, "available": source(name) != "unconfigured",
             "source": source(name),
             "warehouses": sorted(TOOLS[name].sites(actor)) if TOOLS[name].domain != "mail" else []}
            for name in offered_tools(actor)
        ], "order_read_warehouses": sorted(order_read_sites(actor)), "approval_warehouses": {
            action: sorted(approval_sites(actor, action)) for action in ("sales_order.create_draft", "shipment.reschedule")
        }, "chat_available": chat_available and "chat.use" in actor.grants}
        if not getattr(request.state, "browser_session", False):
            has_llm = planner is not None or (assistant is not None and assistant.llm_enabled)
            result["planner"] = "configured" if has_llm else "local_rules"
        return result

    @router.get("/skills")
    def skills(actor: Actor = Depends(authenticate)):
        current = refresh_actor(actor)
        return {"items": [item.model_dump(mode="json") for item in skills_for_actor(current)]}

    @router.get("/work-pulse", response_model=WorkPulseResponse)
    def work_pulse(actor: Actor = Depends(authenticate)):
        current = refresh_actor(actor)
        if assistant is not None:
            return assistant.work_pulse(current)
        pending = workflow.pending_approvals(current, 50, None)
        alerts: list[WorkAlertItem] = []
        if event_hub is not None:
            for item in event_hub.recent(current.tenant, current.subject, is_admin=(current.role == "admin"), limit=20):
                alerts.append(
                    WorkAlertItem(
                        id=str(item.get("id", "")),
                        kind=str(item.get("kind", "work_alert")),
                        title=str(item.get("title", "")),
                        subtitle=str(item.get("subtitle", "")),
                        reference=item.get("reference") or None,
                        href=str(item.get("href", "/inbox/assistant")),
                        severity=item.get("severity", "info"),
                        created_at=float(item.get("created_at", time.time())),
                    )
                )
        return WorkPulseResponse(
            pending_approvals=len(pending),
            returned_proposals=0,
            open_submitted=0,
            meetings_today=0,
            unread_notices=0,
            open_security_alerts=None,
            latest_alerts=alerts,
            as_of=time.time(),
        )

    @router.get("/events/stream")
    async def events_stream(request: Request, actor: Actor = Depends(authenticate)):
        current = await run_in_threadpool(refresh_actor, actor)
        raw_last_id = request.headers.get("last-event-id", "").strip()
        if raw_last_id and (len(raw_last_id) > 128 or any(ord(ch) < 32 for ch in raw_last_id)):
            raise HTTPException(422, "Invalid Last-Event-ID header")
        if event_hub is None:
            async def empty_stream():
                yield ": unavailable\n\n"
            return StreamingResponse(empty_stream(), media_type="text/event-stream")
        event_hub.bind_loop(asyncio.get_running_loop())
        is_admin = current.role == "admin"
        sub = event_hub.subscribe(current.tenant, current.subject, is_admin=is_admin)
        replayed = (
            event_hub.since_event(current.tenant, current.subject, raw_last_id, is_admin=is_admin)
            if raw_last_id
            else []
        )

        def format_frame(payload: dict) -> str:
            event_name = (
                "security_alert"
                if str(payload.get("kind", "")).startswith("security_")
                else "work_alert"
            )
            event_id = str(payload.get("id", ""))
            prefix = f"id: {event_id}\n" if event_id else ""
            return f"{prefix}event: {event_name}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"

        async def generator():
            replayed_ids: set[str] = set()
            try:
                yield ": connected\n\n"
                for item in replayed:
                    item_id = str(item.get("id", ""))
                    if item_id:
                        if item_id in replayed_ids:
                            continue
                        replayed_ids.add(item_id)
                    yield format_frame(item)
                while True:
                    if await request.is_disconnected():
                        break
                    try:
                        payload = await asyncio.wait_for(sub.queue.get(), timeout=15.0)
                        event_id = str(payload.get("id", ""))
                        if event_id and event_id in replayed_ids:
                            replayed_ids.discard(event_id)
                            continue
                        yield format_frame(payload)
                    except asyncio.TimeoutError:
                        if await request.is_disconnected():
                            break
                        yield f"event: heartbeat\ndata: {json.dumps({'ts': time.time()})}\n\n"
            except asyncio.CancelledError:
                pass
            finally:
                sub.close()

        return StreamingResponse(
            generator(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "X-Accel-Buffering": "no",
            },
        )

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

    def may_preview_approval(actor, proposal):
        review = proposal.get("review") or {}
        return (proposal["state"] == "PROPOSED" and review.get("assigned_to") in {None, actor.subject}
                and can_approve(actor, proposal["requester"], Plan.model_validate(proposal["plan"])))

    def preview_approval_for_actor(current_actor: Actor, proposal_id: str) -> ApprovalPreview:
        proposal = visible_proposal(current_actor, proposal_id, include_events=False)
        if not may_preview_approval(current_actor, proposal):
            workflow.audit(current_actor, "approval.preview", "WORKBENCH_DENIED")
            raise HTTPException(403, {"code": "ACTION_NOT_ALLOWED", "next_step": "view_proposal"})
        return ApprovalPreview(proposal=proposal)

    def perform_turn(body: Turn, actor: Actor, key: str | None):
        match = APPROVAL_TEXT.fullmatch(body.text.strip())
        request = ApprovalIntent(kind="approval_intent", proposal_id=match[1]) if match else local_turn(body.text)
        if isinstance(request, Clarify):
            if planner is not None:
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
            elif assistant is not None:
                offered = tuple(name for name in offered_tools(actor) if source(name) != "unconfigured")
                try:
                    return assistant.handle_turn(
                        actor,
                        text=body.text,
                        locale=body.locale,
                        conversation_context=body.conversation_context,
                        offered_tools=offered,
                        key=key,
                        execute_call=execute,
                        preview_approval=preview_approval_for_actor,
                        planner_limit=planner_limit,
                        session_id=body.session_id,
                        active_document=body.active_document,
                        task_switched=body.task_switched,
                    )
                except HTTPException as error:
                    if error.status_code == 404:
                        raise HTTPException(404, {"code": "RECORD_UNAVAILABLE"}) from error
                    raise
            else:
                return Clarification(question=request.question)
        try:
            if isinstance(request, ApprovalIntent):
                return preview_approval_for_actor(actor, request.proposal_id)
            return execute(actor, request, key)
        except HTTPException as error:
            if error.status_code == 404:
                raise HTTPException(404, {"code": "RECORD_UNAVAILABLE"}) from error
            raise

    def historical_result(actor, identifier):
        outcome, reference = history.get(actor, identifier)
        try:
            if outcome == "read":
                # A historical entry can only reissue a typed read, never a proposal.
                request = CALL.validate_python(reference)
                if TOOLS[request.tool].mode == "read":
                    return execute(actor, request, None)
            if outcome in {"proposal", "approval_preview"}:
                proposal = visible_proposal(actor, reference["proposal_id"], include_events=False)
                if outcome == "proposal":
                    return WorkProposal(tool=reference["tool"], proposal=proposal)
                if may_preview_approval(actor, proposal):
                    return ApprovalPreview(proposal=proposal)
        except HTTPException as error:
            if error.status_code not in {403, 404}:
                raise
        if outcome in {"proposal", "approval_preview", "read", "unavailable"}:
            raise HTTPException(404, {"code": "RECORD_UNAVAILABLE"})
        if outcome is None:
            raise HTTPException(409, {"code": "TURN_IN_PROGRESS"}, headers={"Retry-After": "2"})
        if outcome == "clarification":
            return Clarification(question="Choose an available operation and include the reference or warehouse.")
        return Clarification(question="This activity has no saved result. Start a new request to continue.")

    @router.get("/history")
    def list_history(actor: Actor = Depends(authenticate), limit: Annotated[int, Query(ge=1, le=100)] = 50,
                     before_at: Annotated[float | None, Query(ge=0, le=1e12)] = None,
                     before_id: Identifier | None = None):
        if (before_at is None) != (before_id is None):
            raise HTTPException(422, "Both cursor values are required")
        after = None if before_at is None else (before_at, before_id)
        return history.page(actor, limit, after)

    @router.get("/history/{identifier}", response_model=TurnResult)
    def get_history(identifier: Identifier, actor: Actor = Depends(authenticate)):
        return historical_result(refresh_actor(actor), identifier)

    @router.post("/turns", response_model=TurnResult)
    def turns(body: Turn, actor: Actor = Depends(authenticate), key: IdempotencyKey = None):
        if body.client_id is None:
            return perform_turn(body, actor, key)
        if key is not None:
            raise HTTPException(422, "Persistent turns use client_id as their idempotency key")
        try:
            attempt = history.begin(actor, body.client_id, body.text)
            if attempt is None:
                return historical_result(refresh_actor(actor), body.client_id)
            reserved_key = "activity/" + digest_of([actor.subject, body.client_id])
            try:
                result = perform_turn(body, actor, reserved_key)
            except HTTPException as error:
                history.complete(actor, body.client_id, attempt, status=error.status_code)
                raise
            history.complete(actor, body.client_id, attempt, result=result)
            return result
        except TurnInProgress as error:
            raise HTTPException(409, {"code": "TURN_IN_PROGRESS"}, headers={"Retry-After": "2"}) from error

    return router
