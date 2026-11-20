"""Normalize partner purchase orders against a configured catalogue."""
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Annotated, Literal

from pydantic import Field, TypeAdapter, model_validator

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


class PurchaseOrder(Strict):
    po: Identifier
    buyer: Identifier
    currency: Currency
    delivery: date
    total: Money
    lines: Annotated[list[PurchaseLine], Field(min_length=1, max_length=150)]


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

    @model_validator(mode="after")
    def unique_catalogue_keys(self):
        keys = {(item.buyer, item.sku, item.unit) for item in self.catalogue}
        if len(keys) != len(self.catalogue):
            raise ValueError("Duplicate catalogue mapping")
        return self


def load_profiles(path: Path) -> dict[str, TenantProfile]:
    return TypeAdapter(dict[Identifier, TenantProfile]).validate_json(path.read_bytes())


def draft_order(order: PurchaseOrder, warehouse: str, profile: TenantProfile) -> dict:
    location = profile.warehouses.get(warehouse)
    if location is None or order.currency not in location.max_total:
        raise ValueError("Warehouse or currency is not enabled for this tenant")
    if order.total > location.max_total[order.currency]:
        raise ValueError("Order exceeds the configured limit for AIOS approval")
    catalogue = {(item.buyer, item.sku, item.unit): item for item in profile.catalogue}
    lines = []
    subtotal = Decimal(0)
    for row in order.lines:
        item = catalogue.get((order.buyer, row.sku, row.unit))
        if item is None:
            raise ValueError(f"No approved mapping for {row.sku} in {row.unit}")
        if row.quantity * row.unit_price != row.amount:
            raise ValueError(f"Line amount does not reconcile for {row.sku}")
        subtotal += row.amount
        lines.append({"sku": item.erp_sku, "source_sku": row.sku, "source_quantity": row.quantity,
                      "source_uom": row.unit, "erp_quantity": row.quantity * item.units_per_pack,
                      "erp_uom": item.erp_unit, "line_total": f"{row.amount:.2f}"})
    if subtotal != order.total:
        raise ValueError("Line amounts do not reconcile to the purchase-order total")
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
