"""Typed, bounded workbench calls and synthetic provider projection."""
from dataclasses import dataclass
from datetime import date
import re
from typing import Annotated, Literal, Protocol

from pydantic import Field, TypeAdapter

from .contracts import Actor, Clarify, Grant, Identifier, Strict
from .providers import can_use_action
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


ToolCall = Annotated[ShipmentLookup | ShipmentChange | OrderDraft | InvoiceLookup | InboxLookup | WarehouseSummary,
                     Field(discriminator="tool")]
CALL = TypeAdapter(ToolCall)


@dataclass(frozen=True)
class Tool:
    grant: Grant
    mode: Literal["read", "proposal"]
    domain: Literal["erp", "finance", "mail", "decision"] = "erp"
    action: str | None = None

    def allowed(self, actor: Actor, *, warehouse: str | None = None) -> bool:
        return (
            self.grant in actor.grants
            and (warehouse is None or warehouse in actor.warehouses)
            and (self.action is None or can_use_action(actor, self.action))
        )


TOOLS = {
    "shipment.read": Tool("shipment.read", "read"),
    "shipment.reschedule": Tool("shipment.reschedule", "proposal", action="shipment.reschedule"),
    "order.draft.prepare": Tool("order.work", "proposal", action="sales_order.create_draft"),
    "finance.invoice.read": Tool("finance.read", "read", "finance"),
    "mail.inbox.read": Tool("mail.read", "read", "mail"),
    "decision.warehouse.summary": Tool("decision.read", "read", "decision"),
}

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
