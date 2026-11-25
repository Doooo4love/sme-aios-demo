"""Exercise tool discovery, employee grants, and projected data through the API."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import os
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from aios_platform.api import build_app
from aios_platform.assistant_utilities import calculate, csv_profile
from aios_platform.identity import DemoIdentity
from aios_platform.module_access import Assignment, ModuleAccess
from aios_platform.providers import DemoPlanner
from aios_platform.public_search import PublicWebSearch
from aios_platform.service import services
from aios_platform.workbench_tools import SyntheticWorkData


class HarnessToolsTests(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        with patch.dict(os.environ, {
            "AIOS_PROFILE": "demo", "AIOS_PLATFORM_STATE_DIR": directory.name,
            "AIOS_PLATFORM_DSN": "", "AIOS_PLATFORM_DSN_FILE": "",
        }):
            self.runtime = services()
        self.identity = DemoIdentity("x" * 32)
        self.data = SyntheticWorkData()
        self.backend = PublicWebSearch("synthetic", frozenset({"harbour"}))
        self.app = build_app(
            self.runtime, self.identity, DemoPlanner(), workbench_data=self.data, public_web_search=self.backend,
        )
        self.client = TestClient(self.app)
        self.addCleanup(self.client.close)
        model = patch.object(self.app.state.active_assistant, "_call_model",
                             side_effect=AssertionError("Unexpected LLM request"))
        model.start()
        self.addCleanup(model.stop)

    def request(self, method, path, *, subject="operator", **kwargs):
        return self.client.request(method, path, headers={"Authorization": f"Bearer {'x' * 32}.{subject}"}, **kwargs)

    def assign(self, module, grants, *, warehouses=(), version=0, subject="operator", expires=None):
        return self.request(
            "PUT", f"/v1/workbench/module-access/employees/{subject}/{module}", subject="access-admin",
            json={"version": version, "grants": grants, "warehouses": warehouses, "expires_at": expires},
        )

    def turn(self, text, **payload):
        response = self.request("POST", "/v1/workbench/turns", json={"text": text, **payload})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def skills(self):
        return {item["command"] for item in self.request("GET", "/v1/workbench/skills").json()["items"]}

    def test_local_tools_do_not_require_extra_employee_grants(self):
        self.assertTrue({"/calc", "/time", "/find", "/csv"} <= self.skills())
        self.assertIn("`0.3`", self.turn("/calc 0.1 + 0.2")["reply"])
        self.assertIn("2026-07-01T08:00:00-04:00",
                      self.turn("/time America/New_York 2026-07-01T12:00:00Z")["reply"])
        self.assertIn("检查工具参数", self.turn("/calc 1 / 0")["reply"])
        self.assertIn("检查工具参数", self.turn("/time Europe/London 2026-07-01T12:00:00")["reply"])
        self.assertNotIn("/agenda", self.skills())

    def test_attachment_search_and_csv_are_ephemeral_and_bound_to_request(self):
        attachment = {"doc_id": "example", "title": "shipping.csv", "content": "shipment,qty\nexample,\nsecondary,3"}
        self.assertIn("`L2`", self.turn("/find example", active_document=attachment)["reply"])
        self.assertIn("**2** 行", self.turn("/csv", active_document=attachment)["reply"])
        self.assertIn("qty", self.turn("/csv", active_document=attachment, client_id="table-1")["reply"])
        history = self.request("GET", "/v1/workbench/history/table-1").json()
        self.assertEqual(history["kind"], "clarification")
        self.assertNotIn("qty", str(history))
        different = self.request("POST", "/v1/workbench/turns", json={
            "text": "/csv", "active_document": {**attachment, "content": "a\nb"}, "client_id": "table-1",
        })
        self.assertEqual(different.status_code, 409)
        self.assertIn("添加上下文", self.turn("/find example")["reply"])

    def test_admin_assigns_revokes_and_cannot_self_authorize(self):
        self.assertNotIn("/web", self.skills())
        self.assertEqual(self.assign("agent-web", ["agent.web_search"], warehouses=["HK01"]).status_code, 422)
        self.assertEqual(self.assign("agent-web", ["agent.web_search"], subject="access-admin").status_code, 403)
        self.assertEqual(self.assign("agent-web", ["agent.web_search"], subject="island-manager").status_code, 404)
        self.assertEqual(self.assign("agent-web", ["agent.web_search"]).status_code, 200)
        self.assertIn("/web", self.skills())
        self.assertIn("/web", self.turn("/help")["reply"])
        self.assertEqual(self.assign("agent-web", [], version=1).status_code, 200)
        self.assertNotIn("/web", self.skills())
        with patch.object(self.backend, "search", side_effect=AssertionError("Revoked tool called")):
            self.assertIn("未开通", self.turn("/web 香港冷链供应商")["reply"])
        self.assertEqual(self.assign("agent-web", ["agent.web_search"], version=1).status_code, 409)

    def test_calendar_only_reads_memberships_and_task_grant_is_separate(self):
        starts = datetime.now(timezone.utc) + timedelta(days=2)
        day = starts.astimezone(timezone(timedelta(hours=8))).date().isoformat()
        for subject, title in (("manager", "manager-private"), ("operator", "operator-brief")):
            res = self.request("POST", "/v1/calendar/events", subject=subject, json={
                "client_id": "calendar-fixture", "title": title, "starts_at": starts.isoformat(),
                "ends_at": (starts + timedelta(hours=1)).isoformat(),
            })
            self.assertEqual(res.status_code, 201, res.text)
        self.assertEqual(self.turn("/agenda " + day)["kind"], "refusal")
        self.assertEqual(self.assign("agent-collaboration", ["agent.calendar_read"]).status_code, 200)
        self.assertIn("/agenda", self.skills())
        self.assertNotIn("/submitted", self.skills())
        output = self.turn("/agenda " + day)["reply"]
        self.assertIn(r"operator\-brief", output)
        self.assertNotIn("manager", output)
        self.assertEqual(self.turn("/submitted")["kind"], "refusal")
        self.assertEqual(self.assign("agent-collaboration", ["agent.tasks_read"], version=1).status_code, 200)
        self.assertNotIn("/agenda", self.skills())
        self.assertIn("/submitted", self.skills())
        self.assertIn("没有匹配", self.turn("/submitted")["reply"])

    def test_knowledge_scope_and_connector_projection_are_both_enforced(self):
        payload = {"tool": "knowledge.search", "warehouse": "HK01", "query": "冷链"}
        with patch.object(self.data, "knowledge", wraps=self.data.knowledge) as upstream:
            denied = self.request("POST", "/v1/workbench/calls", json=payload)
            self.assertEqual(denied.status_code, 403)
            self.assertEqual(self.assign("agent-knowledge", ["agent.knowledge_read"]).status_code, 422)
            self.assertEqual(self.assign("agent-knowledge", ["agent.knowledge_read"], warehouses=["HK01", "HK02"]).status_code, 200)
            other_site = self.request("POST", "/v1/workbench/calls", json={**payload, "warehouse": "HK02"})
            self.assertEqual(other_site.status_code, 403)
            upstream.assert_not_called()
            self.assertIn("/knowledge", self.skills())
            self.assertIn("SOP-HK01-01", self.turn("/knowledge HK01 冷链")["reply"])
            upstream.assert_called_once()
        data = self.data.knowledge(self.identity.directory_actor("harbour", "operator"),
                                   self._knowledge_call(payload))
        with patch.object(self.data, "knowledge", return_value=data.model_copy(update={
            "hits": [data.hits[0].model_copy(update={"warehouse": "HK02"})],
        })):
            res = self.request("POST", "/v1/workbench/calls", json=payload)
            self.assertEqual(res.status_code, 404)
            self.assertNotIn("SOP-HK01-01", res.text)

    def test_inflight_revoke_discards_connector_result(self):
        self.request("GET", "/v1/workbench/skills")
        self.assertEqual(self.assign("agent-knowledge", ["agent.knowledge_read"], warehouses=["HK01"]).status_code, 200)
        normal = self.data.knowledge

        def revoke(actor, request):
            ModuleAccess(self.runtime.workflow).put(
                self.identity.directory_actor("harbour", "access-admin"), "operator", "agent-knowledge",
                Assignment(version=1, grants=[], warehouses=[]),
            )
            return normal(actor, request)

        with patch.object(self.data, "knowledge", side_effect=revoke):
            response = self.request("POST", "/v1/workbench/calls",
                                    json={"tool": "knowledge.search", "warehouse": "HK01", "query": "冷链"})
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["detail"]["code"], "ACCESS_CHANGED")

    @staticmethod
    def _knowledge_call(payload):
        from aios_platform.workbench_tools import KnowledgeSearch
        return KnowledgeSearch.model_validate(payload)

    def test_concurrent_local_utilities_stay_consistent(self):
        def measure(_):
            return calculate("(804 + 120) / 2"), csv_profile("a,b\n1,\n2,3", ",")["missing"]
        with ThreadPoolExecutor(max_workers=16) as executor:
            results = list(executor.map(measure, range(2_000)))
        self.assertTrue(all(result == ("462", [("a", 0), ("b", 1)]) for result in results))
        with self.assertRaises(ValueError):
            csv_profile("a,b\n1,2,3", ",")
        for unsupported in ("2**10", "1//3", "(3+4", "9 ."):
            with self.assertRaises(ValueError):
                calculate(unsupported)
