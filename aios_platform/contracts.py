"""Typed language and ERP boundaries. Each executable action is explicit."""
from datetime import date
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter

Identifier = Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")]
Capability = Literal["shipment.read", "shipment.reschedule", "sales_order.create_draft"]
Grant = Literal[
    "shipment.read", "shipment.reschedule", "order.read", "order.work", "finance.read",
    "mail.read", "decision.read", "chat.use", "operations.manage",
    "agent.web_search", "agent.calendar_read", "agent.tasks_read", "agent.knowledge_read",
    "agent.documents_parse", "agent.report_export",
    "workbench.access.manage", "workbench.approve.orders", "workbench.approve.shipments",
    "assurance.purchase", "assurance.incoming", "assurance.contract", "assurance.procurement",
    "assurance.finance", "assurance.quality", "assurance.legal", "assurance.audit",
]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class Actor(Strict):
    subject: Annotated[str, Field(min_length=1, max_length=150)]
    tenant: Identifier
    role: Literal["viewer", "operator", "manager", "admin"]
    warehouses: frozenset[Identifier]
    grants: frozenset[Grant] = frozenset()
    module_scopes: dict[Grant, frozenset[Identifier]] = Field(default_factory=dict, exclude=True)

    personal_module_grants: dict[Grant, bool] = Field(default_factory=dict, exclude=True)

    def has_personal_grant(self, grant: Grant) -> bool:
        return self.personal_module_grants.get(grant, grant in self.grants)

    def sites_for(self, grant: Grant) -> frozenset[str]:
        if grant in self.module_scopes:
            return self.module_scopes[grant]
        if grant in self.grants or (grant in {"workbench.approve.orders", "workbench.approve.shipments"}
                                    and self.role in {"manager", "admin"}):
            return self.warehouses
        return frozenset()


class ShipmentRead(Strict):
    action: Literal["shipment.read"]
    shipment_id: Identifier


class ShipmentReschedule(Strict):
    action: Literal["shipment.reschedule"]
    shipment_id: Identifier
    delivery_date: date


class DraftSalesOrder(Strict):
    action: Literal["sales_order.create_draft"]
    intake_id: Identifier


class Clarify(Strict):
    action: Literal["clarify"]
    question: Annotated[str, Field(min_length=1, max_length=300)]


Intent = Annotated[
    ShipmentRead | ShipmentReschedule | DraftSalesOrder | Clarify,
    Field(discriminator="action"),
]
INTENT = TypeAdapter(Intent)


class Shipment(Strict):
    shipment_id: Identifier
    warehouse: Identifier
    delivery_date: date
    version: Annotated[int, Field(ge=1)]
    status: Literal["OPEN", "CLOSED"]


class Plan(Strict):
    tenant: Identifier
    warehouse: Identifier
    action: Literal["shipment.reschedule", "sales_order.create_draft"]
    target: Annotated[str, Field(min_length=1, max_length=194)]
    expected_version: int | None
    before: dict
    after: dict


class Receipt(Strict):
    tenant: Identifier
    operation_id: Identifier
    plan_digest: Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
    target: str
    remote_id: str
