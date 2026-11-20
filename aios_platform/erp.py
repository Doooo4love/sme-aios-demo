"""ERP adapter contract, durable sandbox, and Odoo JSON-2 transport."""
from typing import Protocol

import httpx

from aios_demo.storage import Database, canonical, digest_of

from .contracts import Plan, Receipt, Shipment
from .providers import https_base, post_json


class ERPRejected(ValueError):
    """An authoritative ERP rejected the action before any mutation."""


class ERP(Protocol):
    def shipment(self, tenant: str, reference: str) -> Shipment | None: ...
    def apply(self, operation_id: str, plan: Plan) -> None: ...
    def receipt(self, tenant: str, operation_id: str) -> Receipt | None: ...


def plan_digest(plan: Plan) -> str:
    return digest_of(plan.model_dump(mode="json"))


class LocalERP:
    """A separate transactional database stands in for a customer's ERP."""
    def __init__(self, database: Database):
        self.db = database

    def initialize(self) -> None:
        with self.db.transaction() as run:
            run("""CREATE TABLE IF NOT EXISTS shipment (
                tenant TEXT, id TEXT, warehouse TEXT, delivery_date TEXT, version INTEGER,
                status TEXT, PRIMARY KEY(tenant, id)
            )""")
            run("""CREATE TABLE IF NOT EXISTS sales_draft (
                tenant TEXT, reference TEXT, warehouse TEXT, document TEXT,
                PRIMARY KEY(tenant, reference)
            )""")
            run("""CREATE TABLE IF NOT EXISTS operation_receipt (
                tenant TEXT, operation_id TEXT, document TEXT,
                PRIMARY KEY(tenant, operation_id)
            )""")

    def seed_shipment(self, tenant: str, shipment: Shipment) -> None:
        with self.db.transaction() as run:
            run("INSERT INTO shipment VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
                (tenant, shipment.shipment_id, shipment.warehouse, shipment.delivery_date.isoformat(),
                 shipment.version, shipment.status))

    def shipment(self, tenant: str, reference: str) -> Shipment | None:
        with self.db.transaction(write=False) as run:
            row = run("""SELECT id AS shipment_id, warehouse, delivery_date, version, status
                         FROM shipment WHERE tenant = ? AND id = ?""", (tenant, reference)).fetchone()
        return Shipment.model_validate(dict(row)) if row else None

    def apply(self, operation_id: str, plan: Plan) -> None:
        digest = plan_digest(plan)
        with self.db.transaction() as run:
            previous = run("SELECT document FROM operation_receipt WHERE tenant = ? AND operation_id = ?",
                           (plan.tenant, operation_id)).fetchone()
            if previous:
                if Receipt.model_validate_json(previous["document"]).plan_digest != digest:
                    raise ERPRejected("Operation key is already bound to a different plan")
                return
            if plan.action == "shipment.reschedule":
                result = run(
                    """UPDATE shipment SET delivery_date = ?, version = version + 1
                       WHERE tenant = ? AND id = ? AND warehouse = ? AND version = ? AND status = 'OPEN'""",
                    (plan.after["delivery_date"], plan.tenant, plan.target, plan.warehouse, plan.expected_version),
                )
                if result.rowcount != 1:
                    raise ERPRejected("Shipment changed since preview or is closed")
            else:
                result = run(
                    """INSERT INTO sales_draft VALUES (?, ?, ?, ?)
                       ON CONFLICT (tenant, reference) DO NOTHING""",
                    (plan.tenant, plan.target, plan.warehouse, canonical(plan.after)),
                )
                if result.rowcount != 1:
                    raise ERPRejected("A draft already exists for this source order")
            receipt = Receipt(tenant=plan.tenant, operation_id=operation_id, plan_digest=digest,
                              target=plan.target, remote_id=plan.target)
            run("INSERT INTO operation_receipt VALUES (?, ?, ?)",
                (plan.tenant, operation_id, receipt.model_dump_json()))

    def receipt(self, tenant: str, operation_id: str) -> Receipt | None:
        with self.db.transaction(write=False) as run:
            row = run("SELECT document FROM operation_receipt WHERE tenant = ? AND operation_id = ?",
                      (tenant, operation_id)).fetchone()
        return Receipt.model_validate_json(row["document"]) if row else None


class GatewayERP:
    """Common receipt-bearing actions for ERP-specific HTTP bridges."""
    def __init__(self, tenant: str, *, write: bool = False):
        self.tenant = tenant
        self.write = write

    def _request(self, method: str, arguments: dict) -> dict:
        raise NotImplementedError

    def _call(self, tenant: str, method: str, data: dict):
        if tenant != self.tenant:
            raise ERPRejected("Tenant has no configured connector")
        response = self._request(method, {"tenant": tenant, **data})
        if response.get("status") == "rejected":
            raise ERPRejected("ERP rejected the request before mutation")
        if response.get("status") != "ok" or "result" not in response:
            raise ValueError("Invalid ERP bridge envelope")
        return response["result"]

    def shipment(self, tenant: str, reference: str) -> Shipment | None:
        value = self._call(tenant, "aios_read_shipment", {"shipment_id": reference})
        return Shipment.model_validate(value) if value is not None else None

    def apply(self, operation_id: str, plan: Plan) -> None:
        if not self.write:
            raise ERPRejected("ERP credential is read-only")
        self._call(plan.tenant, "aios_apply", {"operation_id": operation_id,
                   "digest": plan_digest(plan), "plan": plan.model_dump(mode="json")})

    def receipt(self, tenant: str, operation_id: str) -> Receipt | None:
        value = self._call(tenant, "aios_receipt", {"operation_id": operation_id})
        return Receipt.model_validate(value) if value is not None else None


class OdooERP(GatewayERP):
    """Odoo JSON-2 transport for the customer-installed ai.os.gateway model."""
    def __init__(self, base_url: str, token: str, database: str, tenant: str, *, write: bool = False):
        super().__init__(tenant, write=write)
        self.url = https_base(base_url) + "/json/2/ai.os.gateway/"
        self.headers = {"Authorization": "Bearer " + token, "X-Odoo-Database": database}

    def _request(self, method: str, arguments: dict) -> dict:
        return post_json(self.url + method, arguments, self.headers)


class ERPNext(GatewayERP):
    """Frappe RPC transport for whitelisted customer-side bridge methods."""
    def __init__(self, base_url: str, token: str, tenant: str, *, write: bool = False):
        super().__init__(tenant, write=write)
        key, _, secret = token.partition(":")
        if not key or not secret:
            raise ValueError("Frappe token must be configured as key:secret")
        self.url = https_base(base_url) + "/api/method/aios_bridge.api."
        self.headers = {"Authorization": "token " + token}

    def _request(self, method: str, arguments: dict) -> dict:
        response = post_json(self.url + method, arguments, self.headers).get("message")
        if not isinstance(response, dict):
            raise ValueError("Invalid Frappe bridge response")
        return response


ERP_TRANSPORT_ERRORS = (OSError, httpx.HTTPError, ValueError)
