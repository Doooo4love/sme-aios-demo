"""Typed, bounded workbench calls and synthetic provider projection."""
from dataclasses import dataclass
from datetime import date, timedelta
import re
from typing import Annotated, Literal, Protocol

from pydantic import AwareDatetime, Field, StringConstraints, TypeAdapter, model_validator

from .contracts import Actor, Clarify, Grant, Identifier, Strict
from .providers import action_sites
from .purchase import Currency, Money


class ShipmentLookup(Strict):
    tool: Literal["shipment.read"]
    warehouse: Identifier
    shipment_id: Identifier


class ShipmentChange(Strict):
    tool: Literal["shipment.reschedule"]
    warehouse: Identifier
    shipment_id: Identifier
    delivery_date: date


class OrderDraft(Strict):
    tool: Literal["order.draft.prepare"]
    warehouse: Identifier
    intake_id: Identifier


class InvoiceLookup(Strict):
    tool: Literal["finance.invoice.read"]
    warehouse: Identifier
    invoice_id: Identifier


class InboxLookup(Strict):
    tool: Literal["mail.inbox.read"]
    limit: Annotated[int, Field(ge=1, le=20, strict=True)] = 10


class WarehouseSummary(Strict):
    tool: Literal["decision.warehouse.summary"]
    warehouse: Identifier


class Calculate(Strict):
    tool: Literal["utility.calculate"]
    expression: Annotated[str, Field(min_length=1, max_length=160)]


class ZonedTime(Strict):
    tool: Literal["utility.time"]
    timezone: Annotated[str, Field(min_length=1, max_length=64)]
    instant: AwareDatetime | None = None


class CalendarAgenda(Strict):
    tool: Literal["calendar.agenda.read"]
    start: AwareDatetime
    end: AwareDatetime

    @model_validator(mode="after")
    def valid_window(self):
        if not timedelta(0) < self.end - self.start <= timedelta(days=14):
            raise ValueError("Choose a calendar interval of up to 14 days")
        return self


class SubmittedProposals(Strict):
    tool: Literal["tasks.submitted.read"]
    limit: Annotated[int, Field(ge=1, le=10, strict=True)] = 5


class KnowledgeSearch(Strict):
    tool: Literal["knowledge.search"]
    warehouse: Identifier
    query: Annotated[str, StringConstraints(min_length=1, max_length=160, strip_whitespace=True)]
    limit: Annotated[int, Field(ge=1, le=5, strict=True)] = 5


ToolCall = Annotated[
    ShipmentLookup | ShipmentChange | OrderDraft | InvoiceLookup | InboxLookup | WarehouseSummary
    | Calculate | ZonedTime | CalendarAgenda | SubmittedProposals | KnowledgeSearch,
    Field(discriminator="tool"),
]
CALL = TypeAdapter(ToolCall)


@dataclass(frozen=True)
class Tool:
    model: type[Strict]
    description: str
    grant: Grant | None
    mode: Literal["read", "proposal"] = "read"
    domain: Literal["erp", "finance", "mail", "decision", "internal", "knowledge"] = "erp"
    action: str | None = None
    personal: bool = False

    def allowed(self, actor: Actor, *, warehouse: str | None = None) -> bool:
        if self.grant is None:
            return True
        if self.personal:
            return actor.has_personal_grant(self.grant)
        sites = self.sites(actor)
        return bool(sites) if warehouse is None else warehouse in sites

    def sites(self, actor: Actor) -> frozenset[str]:
        if self.action is not None:
            return action_sites(actor, self.action)
        return actor.sites_for(self.grant) if self.grant is not None and not self.personal else frozenset()

    def model_schema(self, name: str) -> dict:
        schema = self.model.model_json_schema()
        schema.pop("title", None)
        schema["properties"].pop("tool")
        required = [field for field in schema.pop("required", []) if field != "tool"]
        if required:
            schema["required"] = required
        return {"type": "function", "function": {"name": name, "description": self.description, "parameters": schema}}


TOOLS = {
    "shipment.read": Tool(ShipmentLookup, "Read a shipment in an authorized warehouse.", "shipment.read"),
    "shipment.reschedule": Tool(ShipmentChange, "Propose rescheduling an open shipment to a YYYY-MM-DD date.",
                                "shipment.reschedule", "proposal", action="shipment.reschedule"),
    "order.draft.prepare": Tool(OrderDraft, "Prepare a governed sales order draft from an intake ID.",
                                "order.work", "proposal", action="sales_order.create_draft"),
    "finance.invoice.read": Tool(InvoiceLookup, "Read an invoice in an authorized warehouse.", "finance.read", domain="finance"),
    "mail.inbox.read": Tool(InboxLookup, "Read recent headers from the employee's own inbox.", "mail.read", domain="mail", personal=True),
    "decision.warehouse.summary": Tool(WarehouseSummary, "Read open shipment counts in an authorized warehouse.",
                                       "decision.read", domain="decision"),
    "utility.calculate": Tool(Calculate, "Compute decimal arithmetic with +, -, *, / and parentheses.", None, domain="internal"),
    "utility.time": Tool(ZonedTime, "Get current time or convert an offset-qualified instant to an IANA timezone.", None, domain="internal"),
    "calendar.agenda.read": Tool(CalendarAgenda, "Read the employee's own internal calendar in a window up to 14 days.",
                                 "agent.calendar_read", domain="internal", personal=True),
    "tasks.submitted.read": Tool(SubmittedProposals, "List the employee's own submitted proposals and their status.",
                                 "agent.tasks_read", domain="internal", personal=True),
    "knowledge.search": Tool(KnowledgeSearch, "Find internal sources in one explicitly selected authorized warehouse.",
                              "agent.knowledge_read", domain="knowledge"),
}
TOOL_IDS_BY_FUNCTION = {name.replace(".", "_"): name for name in TOOLS}

REF = r"([A-Za-z0-9_-]{1,64})"
PATTERNS = (
    (rf"(?:show|track) shipment {REF} (?:in|at) {REF}", "shipment.read", ("shipment_id", "warehouse")),
    (rf"(?:查询|查看)(?:运单|運單)\s*{REF}\s+(?:仓库|倉庫)\s*{REF}", "shipment.read", ("shipment_id", "warehouse")),
    (rf"(?:move|reschedule) shipment {REF} in {REF} to (\d{{4}}-\d{{2}}-\d{{2}})",
     "shipment.reschedule", ("shipment_id", "warehouse", "delivery_date")),
    (rf"(?:将|將)(?:运单|運單)\s*{REF}\s+(?:仓库|倉庫)\s*{REF}\s+改到\s*(\d{{4}}-\d{{2}}-\d{{2}})",
     "shipment.reschedule", ("shipment_id", "warehouse", "delivery_date")),
    (rf"create draft for intake {REF} in {REF}", "order.draft.prepare", ("intake_id", "warehouse")),
    (rf"为\s*{REF}\s+(?:仓库|倉庫)\s*{REF}\s+创建销售草稿", "order.draft.prepare", ("intake_id", "warehouse")),
    (rf"show invoice {REF} in {REF}", "finance.invoice.read", ("invoice_id", "warehouse")),
    (rf"(?:查询|查看)(?:发票|發票)\s*{REF}\s+(?:仓库|倉庫)\s*{REF}", "finance.invoice.read", ("invoice_id", "warehouse")),
    (r"(?:show my inbox|查看我的收件箱)", "mail.inbox.read", ()),
    (rf"(?:summary for warehouse|仓库汇总|倉庫匯總)\s+{REF}", "decision.warehouse.summary", ("warehouse",)),
)


def local_turn(text: str) -> ToolCall | Clarify:
    for pattern, tool, fields in PATTERNS:
        if match := re.fullmatch(pattern, text.strip(), re.IGNORECASE):
            try:
                return CALL.validate_python({"tool": tool, **dict(zip(fields, match.groups()))})
            except ValueError:
                break
    return Clarify(action="clarify", question="Choose a supported operation and specify its reference or warehouse.")


class InvoiceView(Strict):
    invoice_id: Identifier
    warehouse: Identifier
    currency: Currency
    amount: Money
    state: Literal["OPEN", "PAID", "VOID"]


class MailItem(Strict):
    id: Identifier
    sender: Annotated[str, Field(max_length=254)]
    subject: Annotated[str, Field(max_length=300)]


class DecisionView(Strict):
    warehouse: Identifier
    open_shipments: Annotated[int, Field(ge=0)]
    as_of: date


class InvoiceRecord(Strict):
    tenant: Identifier
    view: InvoiceView


class InboxRecord(Strict):
    tenant: Identifier
    owner: Annotated[str, Field(max_length=150)]
    messages: Annotated[list[MailItem], Field(max_length=20)]


class DecisionRecord(Strict):
    tenant: Identifier
    view: DecisionView


class KnowledgeHit(Strict):
    tenant: Identifier
    warehouse: Identifier
    source_id: Identifier
    title: Annotated[str, StringConstraints(min_length=1, max_length=120, strip_whitespace=True)]
    section: Annotated[str, StringConstraints(min_length=1, max_length=80, strip_whitespace=True)]
    excerpt: Annotated[str, StringConstraints(min_length=1, max_length=400, strip_whitespace=True)]


class KnowledgeRecord(Strict):
    tenant: Identifier
    warehouse: Identifier
    subject: Annotated[str, Field(min_length=1, max_length=150)]
    hits: Annotated[list[KnowledgeHit], Field(max_length=5)]

class WorkData(Protocol):
    """Only implement with a scope-aware client and read-only delegated credentials."""

    def invoice(self, actor: Actor, call: InvoiceLookup) -> InvoiceRecord | None: ...
    def inbox(self, actor: Actor, call: InboxLookup) -> InboxRecord: ...
    def summary(self, actor: Actor, call: WarehouseSummary) -> DecisionRecord | None: ...


class SyntheticWorkData:
    def invoice(self, actor: Actor, call: InvoiceLookup) -> InvoiceRecord | None:
        if (actor.tenant, call.warehouse, call.invoice_id) != ("harbour", "HK01", "INV-100"):
            return None
        return InvoiceRecord(tenant=actor.tenant, view=InvoiceView(
            invoice_id=call.invoice_id, warehouse=call.warehouse, currency="HKD", amount="804.00", state="OPEN",
        ))

    def inbox(self, actor: Actor, call: InboxLookup) -> InboxRecord:
        messages = {
            ("harbour", "operator"): [
                MailItem(id="MAIL-101", sender="orders@example.test", subject="Order sample received"),
            ],
            ("harbour", "finance"): [
                MailItem(id="MAIL-102", sender="billing@example.test", subject="Invoice sample available"),
            ],
        }
        return InboxRecord(tenant=actor.tenant, owner=actor.subject,
                           messages=messages.get((actor.tenant, actor.subject), [])[:call.limit])

    def summary(self, actor: Actor, call: WarehouseSummary) -> DecisionRecord | None:
        figures = {("harbour", "HK01"): 23, ("harbour", "HK02"): 8, ("island", "HK01"): 4}
        key = (actor.tenant, call.warehouse)
        if key not in figures:
            return None
        return DecisionRecord(tenant=actor.tenant, view=DecisionView(
            warehouse=call.warehouse, open_shipments=figures[key], as_of=date(2026, 11, 20),
        ))

    def knowledge(self, actor: Actor, call: KnowledgeSearch) -> KnowledgeRecord:
        # Synthetic records exercise warehouse-scoped retrieval without a customer connector.
        sample = {
            ("harbour", "HK01"): KnowledgeHit(
                tenant="harbour", warehouse="HK01", source_id="SOP-HK01-01", title="HK01 冷链交接 Cold-chain handoff", section="Dispatch cut-off",
                excerpt="冷链交接须复核温度记录。The dispatch team closes handoff at 17:00 HKT.",
            ),
            ("harbour", "HK02"): KnowledgeHit(
                tenant="harbour", warehouse="HK02", source_id="SOP-HK02-01", title="HK02 冷链验收入库 Cold-chain receiving", section="Warehouse acceptance",
                excerpt="冷链入库需核对温度探头。Verify the probe before accepting chilled cargo.",
            ),
        }.get((actor.tenant, call.warehouse))
        query = call.query.casefold()
        hits = [sample] if sample and query in f"{sample.title} {sample.section} {sample.excerpt}".casefold() else []
        return KnowledgeRecord(tenant=actor.tenant, subject=actor.subject, warehouse=call.warehouse, hits=hits)


def scoped_data(data: WorkData, actor: Actor, call: InvoiceLookup | InboxLookup | WarehouseSummary) -> dict:
    # Verify connector stamps before returning a projected record to the caller.
    if isinstance(call, InboxLookup):
        result = InboxRecord.model_validate(data.inbox(actor, call))
        if (result.tenant, result.owner) != (actor.tenant, actor.subject):
            raise KeyError("inbox")
        return {"messages": [item.model_dump(mode="json") for item in result.messages[:call.limit]]}
    if isinstance(call, InvoiceLookup):
        record = data.invoice(actor, call)
        if record is not None:
            invoice = InvoiceRecord.model_validate(record)
            if (invoice.tenant, invoice.view.warehouse, invoice.view.invoice_id) == (
                actor.tenant, call.warehouse, call.invoice_id
            ):
                return invoice.view.model_dump(mode="json")
        raise KeyError("invoice")
    record = data.summary(actor, call)
    if record is not None:
        summary = DecisionRecord.model_validate(record)
        if (summary.tenant, summary.view.warehouse) == (actor.tenant, call.warehouse):
            return summary.view.model_dump(mode="json")
    raise KeyError("summary")
