"""Configuration shared by the API and by the separately run ERP worker."""
from dataclasses import dataclass
from datetime import date, timedelta
import os
from pathlib import Path

from aios_demo.storage import Database

from .contracts import Shipment
from .erp import ERP, ERPNext, LocalERP, OdooERP
from .identity import DemoIdentity, Identity, OIDCIdentity
from .providers import CompatiblePlanner, DemoPlanner, OPA, Planner
from .purchase import TenantProfile, load_profiles
from .workflow import Workflow


def setting(name: str, default: str | None = None) -> str:
    file = os.getenv(name + "_FILE")
    value = Path(file).read_text().strip() if file else os.getenv(name, default)
    if not value:
        raise ValueError(f"Configure {name} or {name}_FILE")
    return value


@dataclass(frozen=True)
class Services:
    workflow: Workflow
    erp: ERP
    demo: bool
    profiles: dict[str, TenantProfile]


def services(*, worker: bool = False) -> Services:
    profile = os.getenv("AIOS_PROFILE", "oidc")
    if profile not in {"demo", "oidc"}:
        raise ValueError("AIOS_PROFILE must be demo or oidc")
    demo = profile == "demo"
    path = Path(os.getenv("AIOS_PLATFORM_STATE_DIR", ".state/platform"))
    dsn = setting("AIOS_PLATFORM_DSN") if not demo or os.getenv("AIOS_PLATFORM_DSN_FILE") else (
        os.getenv("AIOS_PLATFORM_DSN") or None
    )
    workflow = Workflow(Database(path / "store.sqlite", dsn))
    if demo:
        config = Path(__file__).resolve().parents[1] / "deploy/platform/demo-profiles.json"
        profiles = load_profiles(Path(os.getenv("AIOS_TENANT_PROFILES", str(config))))
        workflow.initialize()
        erp = LocalERP(Database(path / "erp.sqlite"))
        erp.initialize()
        if not worker:
            for tenant in ("harbour", "island"):
                erp.seed_shipment(tenant, Shipment(
                    shipment_id="SHP-1001", warehouse="HK01", delivery_date=date.today() + timedelta(days=7),
                    version=1, status="OPEN",
                ))
            erp.seed_shipment("harbour", Shipment(
                shipment_id="SHP-2001", warehouse="HK02", delivery_date=date.today() + timedelta(days=7),
                version=1, status="OPEN",
            ))
    else:
        if not dsn.startswith(("postgresql://", "postgres://")):
            raise ValueError("OIDC mode requires a PostgreSQL URL")
        key_name = "AIOS_ERP_WRITE_CREDENTIAL" if worker else "AIOS_ERP_READ_CREDENTIAL"
        tenant = setting("AIOS_CONNECTOR_TENANT")
        profiles = load_profiles(Path(setting("AIOS_TENANT_PROFILES")))
        if tenant not in profiles:
            raise ValueError("Configured connector tenant has no profile")
        profiles = {tenant: profiles[tenant]}
        kind = setting("AIOS_ERP_KIND", "odoo")
        url, credential = setting("AIOS_ERP_URL"), setting(key_name)
        if kind == "odoo":
            erp = OdooERP(url, credential, setting("AIOS_ODOO_DATABASE"), tenant, write=worker)
        elif kind == "erpnext":
            erp = ERPNext(url, credential, tenant, write=worker)
        else:
            raise ValueError("Unsupported ERP connector")
    return Services(workflow, erp, demo, profiles)


def identity_for(demo: bool) -> Identity:
    if demo:
        return DemoIdentity(setting("AIOS_DEMO_SECRET"))
    return OIDCIdentity(setting("AIOS_OIDC_ISSUER"), setting("AIOS_OIDC_AUDIENCE"))


def planner_for(demo: bool) -> Planner:
    kind = os.getenv("AIOS_PLANNER", "demo" if demo else "compatible")
    if kind == "demo":
        return DemoPlanner()
    if kind not in {"compatible", "pydantic-ai"}:
        raise ValueError("Unknown AIOS planner")
    origin, model, key = (setting(name) for name in ("AIOS_LLM_BASE_URL", "AIOS_LLM_MODEL", "AIOS_LLM_API_KEY"))
    if kind == "pydantic-ai":
        from .providers import PydanticPlanner

        return PydanticPlanner(origin, model, key)
    return CompatiblePlanner(origin, model, key)


def optional_opa() -> OPA | None:
    url = os.getenv("AIOS_OPA_URL")
    return OPA(url) if url else None
