from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from types import SimpleNamespace
from uuid import uuid4
import time
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from aios_platform.api import build_app
from aios_platform.contracts import Plan
from aios_platform.erp import ERPNext, OdooERP, plan_digest
from aios_platform.identity import DemoIdentity, OIDCIdentity
from aios_platform.providers import DemoPlanner, OPA, checked_intent
from aios_platform.service import services
from aios_platform.workflow import tick


ROOT = Path(__file__).resolve().parents[1]
TEST_DSN = os.getenv("AIOS_PLATFORM_TEST_DSN")


class PlatformTests(unittest.TestCase):
    def setUp(self):
        scratch = TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.secret = "test-only-random-string-not-a-production-secret"
        dsn = self.postgres_schema() if TEST_DSN else ""
        with patch.dict(os.environ, {"AIOS_PROFILE": "demo", "AIOS_PLATFORM_STATE_DIR": scratch.name,
                                     "AIOS_PLATFORM_DSN": dsn, "AIOS_PLATFORM_DSN_FILE": ""}):
            self.runtime = services()
        self.identity = DemoIdentity(self.secret)
        self.app = build_app(self.runtime, self.identity, DemoPlanner())
        self.client = TestClient(self.app)
        self.addCleanup(self.client.close)
        self.day = (date.today() + timedelta(days=12)).isoformat()

    def postgres_schema(self):
        import psycopg
        from psycopg import sql
        from psycopg.conninfo import make_conninfo

        schema_name = "aios_test_" + uuid4().hex
        name = sql.Identifier(schema_name)
        with psycopg.connect(TEST_DSN) as conn:
            conn.execute(sql.SQL("CREATE SCHEMA {}").format(name))

        def drop():
            with psycopg.connect(TEST_DSN) as conn:
                conn.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(name))

        self.addCleanup(drop)
        return make_conninfo(TEST_DSN, options="-c search_path=" + schema_name)

    def auth(self, actor):
        return {"Authorization": f"Bearer {self.secret}.{actor}"}

    def action(self, text, actor="operator"):
        return self.client.post("/v1/actions", json={"text": text}, headers=self.auth(actor))

    def propose(self, actor="operator", reference="SHP-1001", target_date=None):
        response = self.action(f"将运单 {reference} 改到 {target_date or self.day}", actor)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["state"], "PROPOSED")
        return response.json()

    def approve(self, record, actor="manager", *, digest=None):
        return self.client.post(f"/v1/proposals/{record['id']}/approve",
                                json={"digest": digest or record["digest"]}, headers=self.auth(actor))

    def stored(self, record):
        return self.runtime.workflow.get("harbour", record["id"])

    def test_role_tenant_warehouse_and_digest_bound_approval(self):
        self.assertEqual(self.client.get("/v1/me").status_code, 401)
        self.assertEqual(self.action("Show shipment SHP-1001", "viewer").json()["status"], "read")
        self.assertEqual(self.action("Show shipment SHP-2001", "viewer").status_code, 404)
        self.assertEqual(self.action(f"Move shipment SHP-1001 to {self.day}", "viewer").status_code, 403)
        record = self.propose(actor="manager")
        self.assertEqual(self.approve(record).status_code, 403)
        self.assertEqual(self.approve(record, "other-manager").status_code, 404)
        self.assertEqual(self.approve(record, "island-manager").status_code, 404)
        self.assertEqual(self.approve(record, "admin", digest="0" * 64).status_code, 409)
        self.assertEqual(self.approve(record, "admin").json()["state"], "QUEUED")
        self.assertEqual(self.approve(record, "admin").status_code, 202)
        self.assertEqual(sum(e["event"] == "APPROVED_AND_QUEUED" for e in self.stored(record)["events"]), 1)

    def test_timeout_after_commit_is_verified_without_repeat_write(self):
        record = self.propose()
        self.assertEqual(self.approve(record).status_code, 202)
        erp = self.runtime.erp
        original = erp.apply

        def after_commit(*args):
            original(*args)
            raise TimeoutError("lost response after ERP commit")

        with patch.object(erp, "apply", side_effect=after_commit) as send:
            tick(self.runtime.workflow, erp, "harbour")
            self.assertEqual(self.stored(record)["state"], "OUTCOME_UNKNOWN")
            tick(self.runtime.workflow, erp, "harbour")
            self.assertEqual(send.call_count, 1)
        result = self.stored(record)
        self.assertEqual(result["state"], "VERIFIED")
        self.assertEqual(result["receipt"]["operation_id"], record["id"])
        self.assertEqual(erp.shipment("harbour", "SHP-1001").version, 2)
        self.assertEqual(erp.shipment("island", "SHP-1001").version, 1)

    def test_conflicting_preview_cannot_overwrite_newer_erp_version(self):
        first = self.propose()
        second = self.propose(target_date=(date.today() + timedelta(days=16)).isoformat())
        for record in (first, second):
            self.assertEqual(self.approve(record).status_code, 202)
        for _ in range(4):
            tick(self.runtime.workflow, self.runtime.erp, "harbour")
        self.assertEqual({self.stored(first)["state"], self.stored(second)["state"]}, {"VERIFIED", "REJECTED"})

    def test_proposed_erp_draft_uses_customer_catalogue_and_amount_checks(self):
        order = {"po": "W-150", "buyer": "ISL-10", "delivery": self.day, "currency": "HKD", "total": "50",
                 "lines": [{"sku": "SHIP-BOX", "unit": "PACK", "quantity": 2,
                            "unit_price": "25.00", "amount": "50.00"}]}
        path = "/v1/intakes/HK01/structured"
        headers = self.auth("island-manager")
        uploaded = self.client.post(path, json=order, headers=headers)
        self.assertEqual(uploaded.status_code, 201)
        action = f"Create draft for intake {uploaded.json()['intake_id']}"
        self.assertEqual(self.action(action).status_code, 404)
        result = self.action(action, "island-manager").json()
        self.assertEqual(result["plan"]["after"]["legal_entity"], "ISL")
        self.assertEqual(result["plan"]["after"]["items"][0]["erp_quantity"], 12)
        self.assertEqual(result["plan"]["after"]["items"][0]["sku"], "BOX-SM")
        order["total"] = "51"
        invalid = self.client.post(path, json=order, headers=headers).json()
        self.assertEqual(self.action(f"Create draft for intake {invalid['intake_id']}",
                                     "island-manager").status_code, 422)

    def test_document_to_approved_sales_draft(self):
        upload = self.client.post("/v1/intakes/HK01", content=(ROOT / "fixtures/harbour-po.png").read_bytes(),
                                  headers={**self.auth("operator"), "Content-Type": "application/octet-stream"})
        self.assertEqual(upload.status_code, 201, upload.text)
        record = self.action(f"Create draft for intake {upload.json()['intake_id']}").json()
        self.assertEqual(record["plan"]["after"]["items"][0]["erp_quantity"], 48)
        self.assertEqual(self.approve(record).status_code, 202)
        for _ in range(2):
            tick(self.runtime.workflow, self.runtime.erp, "harbour")
        self.assertEqual(self.stored(record)["state"], "VERIFIED")

    def test_model_output_cannot_expand_the_action_schema(self):
        for payload in ({"action": "shell.run", "code": "ignored"},
                        {"action": "shipment.read", "shipment_id": "SHP-1001", "role": "admin"}):
            self.assertEqual(checked_intent(payload).action, "clarify")

    def test_additional_policy_outage_denies(self):
        app = build_app(self.runtime, self.identity, DemoPlanner(), OPA("http://127.0.0.1:8181"))
        with TestClient(app) as client, patch("aios_platform.providers.post_json", side_effect=ValueError):
            result = client.post("/v1/actions", json={"text": f"Move shipment SHP-1001 to {self.day}"},
                                 headers=self.auth("operator"))
        self.assertEqual(result.status_code, 403)


    def test_retry_same_idempotency_key_keeps_one_approved_proposal(self):
        headers = {**self.auth("operator"), "Idempotency-Key": "external-123"}
        body = {"text": f"Move shipment SHP-1001 to {self.day}"}
        with ThreadPoolExecutor(max_workers=3) as pool:
            replies = list(pool.map(lambda _: self.client.post("/v1/actions", headers=headers, json=body), range(3)))
        self.assertEqual([reply.status_code for reply in replies], [200] * 3)
        proposals = [reply.json() for reply in replies]
        self.assertEqual(len({record["id"] for record in proposals}), 1)
        self.assertEqual(self.approve(proposals[0]).status_code, 202)
        replay = self.client.post("/v1/actions", headers=headers, json=body)
        self.assertEqual(replay.json()["state"], "QUEUED")
        different = self.client.post("/v1/actions", headers=headers, json={"text": "Show shipment SHP-1001"})
        self.assertEqual(different.status_code, 409)
        counts = self.client.get("/v1/operations/summary", headers=self.auth("manager")).json()
        self.assertEqual(counts["proposals_by_state"], {"QUEUED": 1})

    def test_pause_verifies_inflight_and_holds_new_dispatch(self):
        first = self.propose()
        self.assertEqual(self.approve(first).status_code, 202)
        tick(self.runtime.workflow, self.runtime.erp, "harbour")
        self.assertEqual(self.stored(first)["state"], "VERIFYING")
        second = self.propose(target_date=(date.today() + timedelta(days=16)).isoformat())
        self.assertEqual(self.approve(second).status_code, 202)
        path = "/v1/operations/write-control"
        self.assertEqual(self.client.put(path, json={"paused": True}, headers=self.auth("manager")).status_code, 403)
        self.assertEqual(self.client.put(path, json={"paused": True}, headers=self.auth("admin")).status_code, 200)
        self.assertTrue(tick(self.runtime.workflow, self.runtime.erp, "harbour"))
        self.assertEqual(self.stored(first)["state"], "VERIFIED")
        self.assertFalse(tick(self.runtime.workflow, self.runtime.erp, "harbour"))
        self.assertEqual(self.stored(second)["state"], "QUEUED")
        self.client.put(path, json={"paused": False}, headers=self.auth("admin")).raise_for_status()
        self.assertTrue(tick(self.runtime.workflow, self.runtime.erp, "harbour"))
        self.assertEqual(self.stored(second)["state"], "VERIFYING")

    def test_suspended_approver_prevents_dispatch(self):
        record = self.propose()
        self.assertEqual(self.approve(record).status_code, 202)
        endpoint = "/v1/operations/subjects/manager/suspension"
        suspended = self.client.put(endpoint, json={"suspended": True}, headers=self.auth("admin"))
        self.assertEqual(suspended.status_code, 200)
        self.assertEqual(self.client.get("/v1/me", headers=self.auth("manager")).status_code, 403)
        with patch.object(self.runtime.erp, "apply") as apply:
            self.assertTrue(tick(self.runtime.workflow, self.runtime.erp, "harbour"))
            apply.assert_not_called()
        self.assertEqual(self.stored(record)["state"], "REJECTED")
        self.assertEqual(self.stored(record)["events"][-1]["event"], "ACCESS_SUSPENDED_BEFORE_SEND")

    def test_operator_recheck_only_reads_receipt(self):
        record = self.propose()
        self.assertEqual(self.approve(record).status_code, 202)
        workflow, erp = self.runtime.workflow, self.runtime.erp
        tick(workflow, erp, "harbour")
        with patch.object(erp, "receipt", return_value=None):
            for delay in (0, 2, 4):
                with patch("aios_platform.workflow.time.time", return_value=time.time() + delay):
                    tick(workflow, erp, "harbour")
        self.assertEqual(self.stored(record)["state"], "NEEDS_OPERATOR")
        path = f"/v1/proposals/{record['id']}/reconcile"
        self.assertEqual(self.client.post(path, headers=self.auth("operator")).status_code, 403)
        self.assertEqual(self.client.post(path, headers=self.auth("manager")).status_code, 202)
        with patch.object(erp, "apply") as apply:
            tick(workflow, erp, "harbour")
            apply.assert_not_called()
        self.assertEqual(self.stored(record)["state"], "VERIFIED")

    def test_request_limits_and_metrics_do_not_expose_request_data(self):
        metrics = "dedicated-test-metrics-token-with-length"
        app = build_app(self.runtime, self.identity, DemoPlanner(), planner_limit=1, metrics_token=metrics)
        with TestClient(app) as client, patch("aios_platform.workflow.time.time", return_value=120):
            self.assertEqual(client.get("/readyz").json(), {"status": "ready"})
            path = "/v1/actions"
            response = client.post(path, headers=self.auth("operator"), content=b"x" * 70000)
            self.assertEqual(response.status_code, 413)
            self.assertIn("X-Request-ID", response.headers)
            body = {"text": "Show shipment SHP-1001"}
            self.assertEqual(client.post(path, headers=self.auth("operator"), json=body).status_code, 200)
            self.assertEqual(client.post(path, headers=self.auth("operator"), json=body).status_code, 429)
            self.assertEqual(client.post(path, headers=self.auth("island-manager"), json=body).status_code, 200)
            self.assertEqual(client.get("/metrics", headers=self.auth("admin")).status_code, 401)
            exposed = client.get("/metrics", headers={"Authorization": "Bearer " + metrics}).text
            self.assertIn('route="/v1/actions",status="429"', exposed)
            for value in (self.secret, metrics, "SHP-1001", "harbour", "island"):
                self.assertNotIn(value, exposed)

    @unittest.skipUnless(TEST_DSN, "PostgreSQL test DSN is not configured")
    def test_postgres_role_cannot_read_other_tenant_or_edit_audit(self):
        import psycopg
        from psycopg import errors, sql

        secure_sql = (ROOT / "deploy/platform/postgres-security.sql").read_text()
        suffix = uuid4().hex[:12]
        names = ("aios_api_" + suffix, "aios_worker_" + suffix)
        secure_sql = secure_sql.replace("aios_api", names[0]).replace("aios_worker", names[1])
        self.propose()
        self.propose(actor="island-manager")
        with psycopg.connect(self.runtime.workflow.db.dsn) as conn:
            with conn.transaction(force_rollback=True):
                for name in names:
                    conn.execute(sql.SQL("CREATE ROLE {} NOLOGIN").format(sql.Identifier(name)))
                schema = conn.execute("SELECT current_schema()").fetchone()[0]
                for name in names:
                    conn.execute(sql.SQL("GRANT USAGE ON SCHEMA {} TO {}").format(
                        sql.Identifier(schema), sql.Identifier(name)))
                for statement in secure_sql.split(";"):
                    if statement.strip():
                        conn.execute(statement)
                conn.execute(sql.SQL("SET LOCAL ROLE {}").format(sql.Identifier(names[0])))
                self.assertEqual(conn.execute("SELECT COUNT(*) FROM aios_proposal").fetchone()[0], 0)
                conn.execute("SELECT set_config('aios.tenant', 'harbour', true)")
                self.assertEqual(conn.execute("SELECT DISTINCT tenant FROM aios_proposal").fetchall(),
                                 [("harbour",)])
                with self.assertRaises(errors.InsufficientPrivilege), conn.transaction():
                    conn.execute("UPDATE aios_audit SET event = 'tampered'")
                with self.assertRaises(errors.InsufficientPrivilege), conn.transaction():
                    conn.execute("UPDATE aios_proposal SET receipt = 'tampered'")
                conn.execute(sql.SQL("SET LOCAL ROLE {}").format(sql.Identifier(names[1])))
                self.assertEqual(conn.execute("SELECT DISTINCT tenant FROM aios_proposal").fetchall(),
                                 [("harbour",)])
                with self.assertRaises(errors.InsufficientPrivilege), conn.transaction():
                    conn.execute("UPDATE aios_write_control SET paused = 0")
                with self.assertRaises(errors.InsufficientPrivilege), conn.transaction():
                    conn.execute("SELECT * FROM aios_intake")


class IdentityTests(unittest.TestCase):
    def test_keycloak_claims_require_signed_matching_access_token(self):
        import jwt
        from cryptography.hazmat.primitives.asymmetric import rsa

        signer = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        issuer = "https://identity.example/realms/demo"
        identity = OIDCIdentity(issuer, "aios-service")
        claims = {"iss": issuer, "aud": "aios-service", "sub": "user-27", "typ": "Bearer",
                  "exp": int(time.time()) + 30, "aios_tenant": "harbour",
                  "aios_role": "manager", "aios_warehouses": ["HK01"]}
        with patch.object(identity.keys, "get_signing_key_from_jwt",
                          return_value=SimpleNamespace(key=signer.public_key())):
            actor = identity.authenticate(jwt.encode(claims, signer, algorithm="RS256"))
            self.assertEqual((actor.tenant, actor.role, actor.warehouses),
                             ("harbour", "manager", {"HK01"}))
            for invalid in ({"aud": "other"}, {"typ": "ID"}, {"exp": int(time.time()) - 1}):
                with self.assertRaises(ValueError):
                    identity.authenticate(jwt.encode({**claims, **invalid}, signer, algorithm="RS256"))


class ConnectorTests(unittest.TestCase):
    def test_odoo_transport_binds_tenant_method_and_approved_digest(self):
        adapter = OdooERP("https://erp.example", "test-only", "company", "harbour", write=True)
        plan = Plan(tenant="harbour", warehouse="HK01", action="shipment.reschedule", target="SHP-1001",
                    before={}, after={"delivery_date": "2030-01-02"}, expected_version=1)
        with patch("aios_platform.erp.post_json", return_value={"status": "ok", "result": None}) as request:
            adapter.apply("op1", plan)
            url, body, headers = request.call_args.args
            self.assertTrue(url.endswith("/json/2/ai.os.gateway/aios_apply"))
            self.assertEqual((body["tenant"], body["operation_id"], body["digest"]),
                             ("harbour", "op1", plan_digest(plan)))
            self.assertEqual(headers["X-Odoo-Database"], "company")
            with self.assertRaisesRegex(ValueError, "no configured connector"):
                adapter.shipment("other", "SHP-1001")

    def test_erpnext_transport_unwraps_frappe_receipt(self):
        adapter = ERPNext("https://erp.example", "key:secret", "harbour", write=True)
        response = {"message": {"status": "ok", "result": {
            "tenant": "harbour", "operation_id": "op2", "plan_digest": "0" * 64,
            "target": "SHP-1001", "remote_id": "SHIP-0001",
        }}}
        with patch("aios_platform.erp.post_json", return_value=response) as request:
            self.assertEqual(adapter.receipt("harbour", "op2").remote_id, "SHIP-0001")
            url, body, headers = request.call_args.args
            self.assertTrue(url.endswith("/api/method/aios_bridge.api.aios_receipt"))
            self.assertEqual(body, {"tenant": "harbour", "operation_id": "op2"})
            self.assertEqual(headers["Authorization"], "token key:secret")
