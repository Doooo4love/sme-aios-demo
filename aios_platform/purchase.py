"""Normalize partner purchase orders against a configured catalogue."""
from datetime import date
from decimal import Decimal
from functools import cached_property
from pathlib import Path
from typing import Annotated, Literal

from pydantic import Field, TypeAdapter, field_serializer, model_validator

from .contracts import Identifier, Strict

Currency = Annotated[str, Field(pattern=r"^[A-Z]{3}$")]
Money = Annotated[Decimal, Field(ge=0, max_digits=15, decimal_places=2, allow_inf_nan=False)]
PositiveUnits = Annotated[int, Field(ge=1, le=10_000_000, strict=True)]


class PurchaseLine(Strict):
    sku: Identifier
    unit: Identifier
    quantity: PositiveUnits
    unit_price: Money
    amount: Money

    @field_serializer("unit_price", "amount", when_used="json")
    def serialize_amount(self, value: Decimal) -> str:
        return f"{value:.2f}"


class PurchaseOrder(Strict):
    po: Identifier
    buyer: Identifier
    currency: Currency
    delivery: date
    total: Money
    lines: Annotated[list[PurchaseLine], Field(min_length=1, max_length=150)]

    @field_serializer("total", when_used="json")
    def serialize_total(self, value: Decimal) -> str:
        return f"{value:.2f}"


class CatalogueItem(Strict):
    buyer: Identifier
    sku: Identifier
    unit: Identifier
    erp_sku: Identifier
    erp_unit: Identifier
    units_per_pack: PositiveUnits


class Warehouse(Strict):
    legal_entity: Identifier
    max_total: dict[Currency, Money]


class TenantProfile(Strict):
    warehouses: dict[Identifier, Warehouse]
    catalogue: list[CatalogueItem]
    ocr_template: Literal["demo-wholesale-v1", "disabled"] = "disabled"

    @cached_property
    def catalogue_index(self) -> dict[tuple[str, str, str], CatalogueItem]:
        return {(item.buyer, item.sku, item.unit): item for item in self.catalogue}

    @model_validator(mode="after")
    def unique_catalogue_keys(self):
        if len(self.catalogue_index) != len(self.catalogue):
            raise ValueError("Duplicate catalogue mapping")
        return self


def load_profiles(path: Path) -> dict[str, TenantProfile]:
    profiles = TypeAdapter(dict[Identifier, TenantProfile]).validate_json(path.read_bytes())
    if not profiles or any(not profile.warehouses for profile in profiles.values()):
        raise ValueError("Configure at least one tenant and a warehouse for each tenant")
    return profiles


class OrderIssue(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def draft_order(order: PurchaseOrder, warehouse: str, profile: TenantProfile) -> dict:
    location = profile.warehouses.get(warehouse)
    if location is None or order.currency not in location.max_total:
        raise OrderIssue("CURRENCY_OR_WAREHOUSE_UNSUPPORTED", "Warehouse or currency is not enabled")
    if order.total > location.max_total[order.currency]:
        raise OrderIssue("ORDER_LIMIT_EXCEEDED", "Order exceeds the configured limit for AIOS approval")
    lines = []
    subtotal = Decimal(0)
    for row in order.lines:
        item = profile.catalogue_index.get((order.buyer, row.sku, row.unit))
        if item is None:
            raise OrderIssue("MAPPING_MISSING", f"No approved mapping for {row.sku} in {row.unit}")
        if row.quantity * row.unit_price != row.amount:
            raise OrderIssue("LINE_AMOUNT_MISMATCH", f"Line amount does not reconcile for {row.sku}")
        subtotal += row.amount
        lines.append({"sku": item.erp_sku, "source_sku": row.sku, "source_quantity": row.quantity,
                      "source_uom": row.unit, "erp_quantity": row.quantity * item.units_per_pack,
                      "erp_uom": item.erp_unit, "line_total": f"{row.amount:.2f}"})
    if subtotal != order.total:
        raise OrderIssue("ORDER_TOTAL_MISMATCH", "Line amounts do not reconcile to the purchase-order total")
    return {"po": order.po, "buyer": order.buyer, "currency": order.currency,
            "legal_entity": location.legal_entity, "delivery": order.delivery.isoformat(),
            "total": f"{order.total:.2f}", "items": lines}


def from_ocr(evidence: dict, overrides: dict[str, str]) -> PurchaseOrder:
    """Convert the installed image template to the common purchase-order contract."""
    from aios_demo.parsing import valid

    if not evidence["complete"]:
        raise ValueError("The image does not match a supported template")
    fields = evidence["fields"]
    for key in overrides:
        if key not in fields or fields[key]["confirmed"] is not None:
            raise ValueError("Only unresolved fields can be reviewed")
    values = {}
    for key, field in fields.items():
        raw = overrides.get(key, field["confirmed"])
        if raw is None or not valid(key, raw):
            raise ValueError(f"Supply a reviewed value for {key}")
        values[key] = raw
    lines = []
    for number in range(1, evidence["rows"] + 1):
        prefix = f"line.{number}."
        lines.append({name: int(values[prefix + name]) if name == "quantity" else values[prefix + name]
                      for name in ("sku", "quantity", "unit", "unit_price", "amount")})
    return PurchaseOrder.model_validate({
        **{key: values[key] for key in ("po", "buyer", "currency", "delivery", "total")}, "lines": lines,
    })
