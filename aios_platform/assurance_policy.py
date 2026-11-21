"""Versioned rules and tenant/site-scoped cell projection for case reviews."""
from dataclasses import dataclass, field
from typing import Annotated, Literal, Protocol

from pydantic import Field, TypeAdapter
from aios_demo.storage import digest_of

from .contracts import Actor, Grant, Identifier, Strict

Kind = Literal["purchase", "incoming_quality", "contract"]
Track = Literal["procurement", "finance", "quality", "legal"]
TRACK_GRANTS: dict[Track, Grant] = {
    "procurement": "assurance.procurement", "finance": "assurance.finance",
    "quality": "assurance.quality", "legal": "assurance.legal",
}
KindGrant: dict[Kind, Grant] = {
    "purchase": "assurance.purchase", "incoming_quality": "assurance.incoming", "contract": "assurance.contract",
}
SCHEMA_VERSION = "assurance-1"
PositiveInt = Annotated[int, Field(strict=True, ge=0, le=10**12)]
Flag = Annotated[bool, Field(strict=True)]
ShortText = Annotated[str, Field(strict=True, min_length=1, max_length=200)]


class Case(Strict):
    tenant: Identifier
    site: Identifier
    id: Identifier
    revision: Identifier
    zone: Identifier
    kind: Kind
    values: dict[str, int | str | bool]
    submitted_at: Annotated[float, Field(ge=0, le=4_102_444_800)] | None = None


class CaseSource(Protocol):
    """Trusted, read-only connector. It receives a scope, never a user DSN or query."""

    def get(self, tenant: str, reference: str, sites: frozenset[str]) -> Case | None: ...


@dataclass(frozen=True)
class CellPolicy:
    schema: TypeAdapter
    model: bool = False
    employee_grant: Grant | None = None


def public(schema):
    return CellPolicy(TypeAdapter(schema), model=True)


POLICIES: dict[Kind, dict[str, CellPolicy]] = {
    "purchase": {
        "amount_minor": public(PositiveInt),
        "currency": public(Literal["HKD", "CNY", "USD"]),
        "supplier_approved": public(Flag),
        "quote_count": public(PositiveInt),
        "supplier_bank": CellPolicy(TypeAdapter(ShortText), employee_grant="assurance.finance"),
    },
    "incoming_quality": {
        "sample_size": public(PositiveInt), "defects": public(PositiveInt),
        "certificate_present": public(Flag), "critical_defect": public(Flag),
        "inspector_contact": CellPolicy(TypeAdapter(ShortText), employee_grant="assurance.quality"),
    },
    "contract": {
        "term_months": public(PositiveInt), "auto_renewal": public(Flag),
        "standard_template": public(Flag), "liability_cap_present": public(Flag),
        "counterparty_contact": CellPolicy(TypeAdapter(ShortText), employee_grant="assurance.legal"),
    },
}


@dataclass(frozen=True)
class CellRestrictions:
    # A trusted policy can add row-specific restrictions, never relax a field rule.
    employee_denied: frozenset[str] = field(default_factory=frozenset)
    model_denied: frozenset[str] = field(default_factory=frozenset)


class CaseRestrictions(Protocol):
    def __call__(self, actor: Actor, case: Case) -> CellRestrictions: ...


def may_read(actor: Actor, case: Case) -> bool:
    return (case.tenant == actor.tenant and case.site in actor.warehouses
            and KindGrant[case.kind] in actor.grants)


def project(actor: Actor, case: Case, *, audience: Literal["employee", "model"],
            restrictions: CellRestrictions | None = None) -> dict:
    if not may_read(actor, case):
        raise KeyError(case.id)
    restrictions = restrictions or CellRestrictions()
    denied = restrictions.employee_denied | (restrictions.model_denied if audience == "model" else frozenset())
    result = {}
    for name, policy in POLICIES[case.kind].items():
        if name in denied or name not in case.values or (
            policy.employee_grant is not None and policy.employee_grant not in actor.grants
        ) or (audience == "model" and not policy.model):
            continue
        result[name] = policy.schema.validate_python(case.values[name])
    return result


FINDINGS: dict[Kind, frozenset[str]] = {
    "purchase": frozenset({"SUPPLIER_UNAPPROVED", "QUOTES_INSUFFICIENT", "FINANCE_THRESHOLD", "CURRENCY_REVIEW"}),
    "incoming_quality": frozenset({"CERTIFICATE_MISSING", "DEFECTS_FOUND", "CRITICAL_DEFECT", "SMALL_SAMPLE"}),
    "contract": frozenset({"NONSTANDARD_TEMPLATE", "AUTO_RENEWAL", "LIABILITY_CAP_MISSING", "LONG_TERM"}),
}


def route(kind: Kind, facts: dict) -> tuple[list[Track], list[str]]:
    missing = {name for name, policy in POLICIES[kind].items() if policy.model} - facts.keys()
    if missing:
        raise ValueError("Required evidence is unavailable under the active policy")
    if kind == "purchase":
        tracks: list[Track] = ["procurement"]
        flags = []
        if not facts["supplier_approved"]:
            flags.append("SUPPLIER_UNAPPROVED")
        if facts["quote_count"] < 2:
            flags.append("QUOTES_INSUFFICIENT")
        if facts["currency"] != "HKD":
            flags.append("CURRENCY_REVIEW")
        elif facts["amount_minor"] >= 1_000_000:
            flags.append("FINANCE_THRESHOLD")
        if flags:
            tracks.append("finance")
        return tracks, flags
    if kind == "incoming_quality":
        if facts["sample_size"] < 1 or not 0 <= facts["defects"] <= facts["sample_size"] or (
            facts["critical_defect"] and facts["defects"] == 0
        ):
            raise ValueError("Incoming inspection sample is inconsistent")
        flags = []
        if not facts["certificate_present"]:
            flags.append("CERTIFICATE_MISSING")
        if facts["defects"]:
            flags.append("DEFECTS_FOUND")
        if facts["critical_defect"]:
            flags.append("CRITICAL_DEFECT")
        if facts["sample_size"] < 10:
            flags.append("SMALL_SAMPLE")
        return ["quality", "procurement"] if flags else ["quality"], flags
    flags = []
    if not facts["standard_template"]:
        flags.append("NONSTANDARD_TEMPLATE")
    if facts["auto_renewal"]:
        flags.append("AUTO_RENEWAL")
    if not facts["liability_cap_present"]:
        flags.append("LIABILITY_CAP_MISSING")
    if facts["term_months"] > 24:
        flags.append("LONG_TERM")
    return ["legal", "procurement"] if flags else ["legal"], flags


HARD_HOLDS = frozenset({"SUPPLIER_UNAPPROVED", "CERTIFICATE_MISSING", "CRITICAL_DEFECT", "LIABILITY_CAP_MISSING"})


def snapshot_digest(case: Case, facts: dict) -> str:
    return digest_of({"id": case.id, "kind": case.kind, "revision": case.revision, "site": case.site,
                      "zone": case.zone, "policy": SCHEMA_VERSION, "facts": facts})


class DemoCaseSource:
    references = ("CT-300", "PO-100", "PO-401", "QA-200")

    def cases(self, tenant, sites, kind, after, limit):
        visible = [case for identifier in self.references if identifier > after
                   and (case := self.get(tenant, identifier, sites)) is not None and case.kind == kind]
        return visible[:limit]

    def get(self, tenant: str, reference: str, sites: frozenset[str]) -> Case | None:
        fixtures = {
            "PO-100": ("HK01", "purchase", {"amount_minor": 1_200_000, "currency": "HKD",
                       "quote_count": 2, "supplier_approved": True, "supplier_bank": "SYNTHETIC-BANK-ONLY"}),
            "QA-200": ("HK01", "incoming_quality", {"sample_size": 12, "defects": 1,
                       "certificate_present": True, "critical_defect": True, "inspector_contact": "qa@example.test"}),
            "CT-300": ("HK01", "contract", {"term_months": 18, "auto_renewal": True, "standard_template": False,
                       "liability_cap_present": True, "counterparty_contact": "legal@example.test"}),
            "PO-401": ("HK02", "purchase", {"amount_minor": 21_000, "currency": "HKD",
                       "quote_count": 3, "supplier_approved": True}),
        }
        item = fixtures.get(reference)
        if tenant != "harbour" or item is None or item[0] not in sites:
            return None
        site, kind, values = item
        return Case(tenant=tenant, site=site, id=reference, kind=kind, revision="v1", zone="hk-factory", values=values)
