"""Work-bench entry-point, outbound contract, and search outage regression tests."""
from concurrent.futures import ThreadPoolExecutor
import json
import os
import secrets
from tempfile import TemporaryDirectory
from threading import Barrier, Event
import unittest
from unittest.mock import patch
from uuid import uuid4

from fastapi.testclient import TestClient
import httpx

from aios_platform.api import build_app
from aios_platform.identity import DemoIdentity
from aios_platform.providers import DemoPlanner
from aios_platform.public_search import DEEPSEEK_SEARCH_URL, PublicWebSearch
from aios_platform.security_guard import evaluate_work_boundary
from aios_platform.service import services
from scripts.work_boundary_eval import load_cases

QUERY = "香港冷链物流公开供应商"
SEARCH = "/web " + QUERY
SEARCH_RESPONSE = {
    "results": [
        {"url": "https://example.com/supplier(1)", "title": "HK cold chain", "snippet": "Public directory."},
        {"url": "https://user@example.com", "title": "Credential in URL"},
        {"url": "https://127.0.0.1/", "title": "Private host"},
    ]
}


class PublicSearchTests(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        with patch.dict(os.environ, {
            "AIOS_PROFILE": "demo", "AIOS_PLATFORM_STATE_DIR": directory.name,
            "AIOS_PLATFORM_DSN": "", "AIOS_PLATFORM_DSN_FILE": "",
        }):
            runtime = services()
        self.secret = secrets.token_urlsafe(32)
        self.backend = PublicWebSearch("synthetic-key", frozenset({"harbour"}))
        self.app = build_app(
            runtime, DemoIdentity(self.secret), DemoPlanner(), public_web_search=self.backend, planner_limit=12,
        )
        self.assistant = self.app.state.active_assistant
        self.client = TestClient(self.app)
        self.addCleanup(self.client.close)
        self.requests = []
        self.handler = lambda _request: httpx.Response(200, json=SEARCH_RESPONSE)
        transport = httpx.Client(transport=httpx.MockTransport(self.capture))
        self.addCleanup(transport.close)
        fake_pool = patch("aios_platform.http_pool.get_http_client", return_value=transport)
        fake_pool.start()
        self.addCleanup(fake_pool.stop)

    def capture(self, request):
        self.requests.append(request)
        return self.handler(request)

    def send(self, text, *, subject="access-admin", **options):
        response = self.client.post(
            "/v1/workbench/turns",
            headers={"Authorization": f"Bearer {self.secret}.{subject}"},
            json={"text": text, "client_id": uuid4().hex, **options},
        )
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_classifier_corpus_does_not_regress_across_roles(self):
        identity = DemoIdentity(self.secret)
        for subject in ("viewer", "operator", "manager", "access-admin"):
            false_negatives = 0
            actor = identity.directory_actor("harbour", subject)
            for expected, language, message, previous in load_cases():
                result = evaluate_work_boundary(actor, message, previous_user_text=previous).is_off_topic
                with self.subTest(subject=subject, language=language, message=message):
                    self.assertFalse(result and not expected, "Unexpected work or greeting refusal")
                false_negatives += int(expected and not result)
            self.assertLessEqual(false_negatives, 1, subject)

    def test_access_admin_screenshot_thread_respects_work_boundary(self):
        texts = (
            "我想去买个新的ps5，帮我深度搜索哪里比较便宜？",
            "主要是想玩gta6",
            "你觉得我买光驱版还是数字版比较好？",
        )
        history = []
        with patch.object(self.assistant, "_call_model", side_effect=AssertionError("Model call on personal turn")):
            results = []
            for message in texts:
                results.append(self.send(message, conversation_context=history))
                history.append({"role": "user", "text": message})
        self.assertIn("私人闲聊", results[0]["reply"])
        self.assertIn("私人闲聊", results[1]["reply"])
        self.assertEqual(results[2]["category"], "OFF_TOPIC_PERSONAL_CHAT")
        self.assertEqual(self.requests, [])

    def test_search_response_only_sends_normalized_query_and_is_ephemeral(self):
        client_id = uuid4().hex
        body = {
            "text": "帮我联网搜索 " + QUERY,
            "client_id": client_id,
            "conversation_context": [{"role": "user", "text": "Private customer details"}],
        }
        auth = {"Authorization": f"Bearer {self.secret}.access-admin"}
        with patch.object(self.assistant, "_call_model", side_effect=AssertionError("Model call on public search")):
            response = self.client.post("/v1/workbench/turns", headers=auth, json=body)
            replay = self.client.post("/v1/workbench/turns", headers=auth, json=body)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(replay.status_code, 200, replay.text)
        self.assertEqual(replay.json()["kind"], "clarification")
        result = response.json()
        self.assertEqual(result["mode"], "public_search")
        self.assertIn("https://example.com/supplier%281%29", result["reply"])
        self.assertNotIn("127.0.0.1", result["reply"])
        self.assertEqual(len(self.requests), 1)
        request = self.requests[0]
        self.assertEqual(str(request.url), DEEPSEEK_SEARCH_URL)
        self.assertEqual(request.method, "POST")
        self.assertEqual(json.loads(request.content), {"query": QUERY, "count": 3, "need_content": False})
        self.assertEqual(request.headers["Authorization"], "Bearer synthetic-key")

    def test_policy_denials_do_not_call_search_or_model(self):
        private = (
            SEARCH + "及运单号SHP-1001",
            SEARCH + "及客户邮箱 name@example.com",
            SEARCH + "加上 HK02 的记录",
            SEARCH + "公司内部资料",
            SEARCH + "a" * 129,
        )
        document = {"doc_id": "doc1", "title": "Internal agreement", "content": "private"}
        with patch.object(self.assistant, "_call_model", side_effect=AssertionError("Model fallback on search")):
            self.assertIn("未开通", self.send(SEARCH, subject="admin")["reply"])
            self.assertIn("未开通", self.send(SEARCH, subject="island-manager")["reply"])
            self.assertIn("公开业务检索词", self.send(SEARCH, active_document=document)["reply"])
            for message in private:
                with self.subTest(message=message):
                    self.assertIn("公开业务检索词", self.send(message)["reply"])
            self.assistant.provider_policy_store.upsert_policy("harbour", max_tier="T0")
            self.assertIn("企业策略", self.send(SEARCH)["reply"])
        self.assertEqual(self.requests, [])

    def test_quota_denial_never_calls_search(self):
        with patch.object(self.assistant.workflow, "take_planner_budget", return_value=False):
            self.assertIn("用量限制", self.send(SEARCH)["reply"])
        self.assertEqual(self.requests, [])

    def test_upstream_failure_opens_circuit_and_does_not_invent_sources(self):
        self.handler = lambda _request: httpx.Response(503)
        for _ in range(4):
            self.assertIn("未取得可核对的来源", self.send(SEARCH)["reply"])
        self.assertEqual(len(self.requests), 3)

    def test_redirect_timeout_invalid_and_oversized_responses_fail_closed(self):
        cases = (
            lambda _request: httpx.Response(302, headers={"Location": "https://example.com"}),
            lambda _request: httpx.Response(200, json={"results": "invalid"}),
            lambda _request: httpx.Response(200, content=b"0" * 65_537),
        )
        for handler in cases:
            self.handler = handler
            self.assertIn("未取得可核对的来源", self.send(SEARCH)["reply"])
        self.assertEqual(len(self.requests), 3)

        def timeout(request):
            raise httpx.ReadTimeout("mock timeout", request=request)
        self.handler = timeout
        self.assistant.public_web_search = PublicWebSearch("synthetic-key", frozenset({"harbour"}))
        self.assertIn("未取得可核对的来源", self.send(SEARCH)["reply"])
        self.assertEqual(len(self.requests), 4)

    def test_concurrent_search_limit_fail_fast(self):
        arrived = Barrier(5, timeout=5)
        release = Event()

        def hold(_request):
            arrived.wait()
            if not release.wait(5):
                raise AssertionError("Concurrent search test timed out")
            return httpx.Response(200, json={"results": []})

        self.handler = hold
        with ThreadPoolExecutor(max_workers=4) as executor:
            running = [executor.submit(self.backend.search, QUERY, admit=lambda: None) for _ in range(4)]
            try:
                arrived.wait()
                for _ in range(100):
                    reject = self.backend.search(QUERY, admit=lambda: self.fail("Busy request consumed quota"))
                    self.assertEqual(reject.error, "SEARCH_BUSY")
            finally:
                release.set()
            self.assertTrue(all(request.result(timeout=5).billable for request in running))
        self.assertEqual(len(self.requests), 4)
