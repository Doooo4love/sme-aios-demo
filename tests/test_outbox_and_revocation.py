"""Tests for reserve-first external outbox, durable cross-process EventHub, provider policy routes, and SSE revocation."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
import json
import os
from pathlib import Path
import secrets
import socket
from tempfile import TemporaryDirectory
import threading
import time
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
import httpx
import uvicorn

from aios_platform.api import build_app
from aios_platform.browser import BrowserConfig
from aios_platform.events import EventHub, WorkEvent
from aios_platform.governance import GovernanceService
from aios_platform.identity import DemoIdentity
from aios_platform.providers import DemoPlanner
from aios_platform.service import services
from aios_platform.workflow import Conflict


class OutboxAndRevocationTests(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.secret = secrets.token_urlsafe(32)
        self.identity = DemoIdentity(self.secret)
        env = {
            "AIOS_PROFILE": "demo",
            "AIOS_PLATFORM_STATE_DIR": self._tmp.name,
            "AIOS_PLATFORM_DSN": "",
            "AIOS_PLATFORM_DSN_FILE": "",
        }
        with patch.dict(os.environ, env):
            self.runtime = services()
        self.addCleanup(self.runtime.workflow.db.close)
        self.addCleanup(self.runtime.erp.db.close)
        self.workflow = self.runtime.workflow
        self.hub = EventHub()
        self.governance = GovernanceService(
            self.workflow,
            self.hub,
            known_subject=self.identity.known_subject,
        )
        self.operator = self.identity.directory_actor("harbour", "operator")
        self.manager = self.identity.directory_actor("harbour", "manager")
        self.admin = self.identity.directory_actor("harbour", "admin")
        self.island_operator = self.identity.directory_actor("island", "island-operator")

    def _auth(self, subject: str) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.secret}.{subject}"}

    def test_concurrent_reserve_first_idempotency_blocks_second_thread_with_409(self):
        payload_hash = sha256(b"concurrent-email-payload").hexdigest()
        barrier = threading.Barrier(2)
        results: list[tuple[str, object]] = []
        lock = threading.Lock()

        def worker():
            barrier.wait(timeout=5.0)
            try:
                res = self.governance.reserve_external_action(
                    self.operator,
                    action_kind="email.send",
                    client_id="conc-email-1",
                    request_sha256=payload_hash,
                    lease_s=60.0,
                )
                with lock:
                    results.append(("ok", res))
            except Conflict as exc:
                with lock:
                    results.append(("conflict", str(exc)))

        with ThreadPoolExecutor(max_workers=2) as pool:
            f1 = pool.submit(worker)
            f2 = pool.submit(worker)
            f1.result(timeout=5.0)
            f2.result(timeout=5.0)

        statuses = sorted(kind for kind, _ in results)
        self.assertEqual(statuses, ["conflict", "ok"])
        ok_res = dict(results)["ok"]
        self.assertEqual(ok_res["status"], "reserved")
        self.assertEqual(ok_res["attempt"], 1)
        self.assertIsNone(ok_res["cached_result"])
        self.assertIn("already in progress", dict(results)["conflict"])

    def test_reserve_replay_payload_mismatch_unknown_and_failed_retry_lifecycle(self):
        app = build_app(
            self.runtime,
            self.identity,
            DemoPlanner(),
            event_hub=self.hub,
            governance=self.governance,
        )
        email_sha = sha256(b"email-body-v1").hexdigest()
        other_sha = sha256(b"email-body-v2").hexdigest()

        with TestClient(app) as client:
            # 1. Reserve first email action
            r1 = client.post(
                "/v1/workbench/external-outbox/reserve",
                headers=self._auth("operator"),
                json={
                    "action_kind": "email.send",
                    "client_id": "mail-idem-1",
                    "request_sha256": email_sha,
                },
            )
            self.assertEqual(r1.status_code, 200, r1.text)
            d1 = r1.json()
            self.assertEqual(d1["status"], "reserved")
            self.assertEqual(d1["attempt"], 1)
            outbox_id = d1["outbox_id"]

            # 2. While RESERVED & in-lease, same payload returns 409 DISPATCH_IN_PROGRESS
            in_prog = client.post(
                "/v1/workbench/external-outbox/reserve",
                headers=self._auth("operator"),
                json={
                    "action_kind": "email.send",
                    "client_id": "mail-idem-1",
                    "request_sha256": email_sha,
                },
            )
            self.assertEqual(in_prog.status_code, 409, in_prog.text)
            self.assertEqual(in_prog.json()["detail"]["code"], "DISPATCH_IN_PROGRESS")

            # 3. Payload mismatch returns 409 IDEMPOTENCY_CONFLICT
            mismatch = client.post(
                "/v1/workbench/external-outbox/reserve",
                headers=self._auth("operator"),
                json={
                    "action_kind": "email.send",
                    "client_id": "mail-idem-1",
                    "request_sha256": other_sha,
                },
            )
            self.assertEqual(mismatch.status_code, 409, mismatch.text)
            self.assertEqual(mismatch.json()["detail"]["code"], "IDEMPOTENCY_CONFLICT")

            # 4. Another non-admin subject cannot finalize someone else's outbox item
            forbid = client.post(
                f"/v1/workbench/external-outbox/{outbox_id}/finalize",
                headers=self._auth("manager"),
                json={"state": "SUCCEEDED"},
            )
            self.assertEqual(forbid.status_code, 403)

            # 5. Finalize SUCCEEDED with cached receipt
            cached_receipt = {
                "phase": "sent",
                "message_id": "<msg-001@harbour.theodic.local>",
                "delivery_status": "sent",
                "receipt": {"id": "rec-1", "client_id": "mail-idem-1"},
            }
            fin = client.post(
                f"/v1/workbench/external-outbox/{outbox_id}/finalize",
                headers=self._auth("operator"),
                json={
                    "state": "SUCCEEDED",
                    "external_id": "<msg-001@harbour.theodic.local>",
                    "result": cached_receipt,
                },
            )
            self.assertEqual(fin.status_code, 200, fin.text)
            self.assertEqual(fin.json()["state"], "SUCCEEDED")

            # 6. Same-key replay returns cached_result without duplicate dispatch
            replay = client.post(
                "/v1/workbench/external-outbox/reserve",
                headers=self._auth("operator"),
                json={
                    "action_kind": "email.send",
                    "client_id": "mail-idem-1",
                    "request_sha256": email_sha,
                },
            )
            self.assertEqual(replay.status_code, 200, replay.text)
            self.assertEqual(replay.json()["status"], "replay")
            self.assertEqual(replay.json()["outbox_id"], outbox_id)
            self.assertEqual(replay.json()["cached_result"], cached_receipt)

            # 7. Payload mismatch even after SUCCEEDED returns 409 IDEMPOTENCY_CONFLICT
            mismatch_after = client.post(
                "/v1/workbench/external-outbox/reserve",
                headers=self._auth("operator"),
                json={
                    "action_kind": "email.send",
                    "client_id": "mail-idem-1",
                    "request_sha256": other_sha,
                },
            )
            self.assertEqual(mismatch_after.status_code, 409)
            self.assertEqual(mismatch_after.json()["detail"]["code"], "IDEMPOTENCY_CONFLICT")

            # 8. UNKNOWN outcome blocks retry permanently (409 OUTCOME_UNKNOWN) even with expired lease
            zoom_sha = sha256(b"zoom-meeting-v1").hexdigest()
            zr = client.post(
                "/v1/workbench/external-outbox/reserve",
                headers=self._auth("operator"),
                json={
                    "action_kind": "zoom.book",
                    "client_id": "zoom-idem-1",
                    "request_sha256": zoom_sha,
                },
            )
            self.assertEqual(zr.status_code, 200)
            zoom_outbox_id = zr.json()["outbox_id"]
            zf = client.post(
                f"/v1/workbench/external-outbox/{zoom_outbox_id}/finalize",
                headers=self._auth("operator"),
                json={"state": "UNKNOWN", "external_id": "cal-evt-99"},
            )
            self.assertEqual(zf.status_code, 200)
            self.assertEqual(zf.json()["state"], "UNKNOWN")

            with self.workflow.tx("harbour", write=True) as run:
                run(
                    "UPDATE aios_external_action_outbox SET lease_until = ? WHERE tenant = ? AND id = ?",
                    (time.time() - 60.0, "harbour", zoom_outbox_id),
                )

            retry_unknown = client.post(
                "/v1/workbench/external-outbox/reserve",
                headers=self._auth("operator"),
                json={
                    "action_kind": "zoom.book",
                    "client_id": "zoom-idem-1",
                    "request_sha256": zoom_sha,
                },
            )
            self.assertEqual(retry_unknown.status_code, 409, retry_unknown.text)
            self.assertEqual(retry_unknown.json()["detail"]["code"], "OUTCOME_UNKNOWN")

            # 9. FAILED state allows safe retry and increments attempt
            fail_sha = sha256(b"zoom-fail-then-retry").hexdigest()
            fr = client.post(
                "/v1/workbench/external-outbox/reserve",
                headers=self._auth("operator"),
                json={
                    "action_kind": "zoom.book",
                    "client_id": "zoom-fail-1",
                    "request_sha256": fail_sha,
                },
            )
            self.assertEqual(fr.status_code, 200)
            fail_id = fr.json()["outbox_id"]
            self.assertEqual(
                client.post(
                    f"/v1/workbench/external-outbox/{fail_id}/finalize",
                    headers=self._auth("operator"),
                    json={"state": "FAILED"},
                ).status_code,
                200,
            )
            retry_ok = client.post(
                "/v1/workbench/external-outbox/reserve",
                headers=self._auth("operator"),
                json={
                    "action_kind": "zoom.book",
                    "client_id": "zoom-fail-1",
                    "request_sha256": fail_sha,
                },
            )
            self.assertEqual(retry_ok.status_code, 200, retry_ok.text)
            self.assertEqual(retry_ok.json()["status"], "reserved")
            self.assertEqual(retry_ok.json()["outbox_id"], fail_id)
            self.assertEqual(retry_ok.json()["attempt"], 2)

    def test_durable_cross_hub_replay_and_eviction_fallback(self):
        hub_a = EventHub(history_limit=3, workflow=self.workflow)
        e1 = hub_a.publish(
            "harbour",
            ["operator"],
            WorkEvent(id="dur-1", kind="work_alert", title="First"),
        )
        e2 = hub_a.publish(
            "harbour",
            ["manager"],
            WorkEvent(id="dur-2", kind="work_alert", title="Manager Only"),
        )
        e3 = hub_a.publish(
            "harbour",
            ["operator"],
            WorkEvent(id="dur-3", kind="security_alert", title="Admin + Operator", severity="high"),
            include_admins=True,
        )
        e4 = hub_a.publish(
            "harbour",
            ["operator"],
            WorkEvent(id="dur-4", kind="work_alert", title="Fourth"),
        )
        e5 = hub_a.publish(
            "harbour",
            ["operator"],
            WorkEvent(id="dur-5", kind="work_alert", title="Fifth"),
        )
        self.assertEqual([e["seq"] for e in (e1, e2, e3, e4, e5)], [1, 2, 3, 4, 5])

        # Hub A evicted dur-1 from its history_limit=3 ring buffer, yet durable replay still works
        replayed_from_a = hub_a.since_event("harbour", "operator", "dur-1")
        self.assertEqual([e["id"] for e in replayed_from_a], ["dur-3", "dur-4", "dur-5"])

        # Separate worker process Hub B with empty in-memory ring buffer shares the same DB
        hub_b = EventHub(history_limit=20)
        hub_b.bind_workflow(self.workflow)

        replayed_b_op = hub_b.since_event("harbour", "operator", "dur-1")
        self.assertEqual([e["id"] for e in replayed_b_op], ["dur-3", "dur-4", "dur-5"])

        replayed_b_admin = hub_b.since_event("harbour", "admin", "dur-1", is_admin=True)
        self.assertEqual([e["id"] for e in replayed_b_admin], ["dur-3"])

        recent_b_op = hub_b.recent("harbour", "operator", limit=10)
        self.assertEqual([e["id"] for e in recent_b_op], ["dur-5", "dur-4", "dur-3", "dur-1"])

        # Tenant isolation in durable store
        self.assertEqual(hub_b.since_event("island", "island-operator", "dur-1"), [])
        self.assertEqual(hub_b.recent("island", "island-operator", limit=10), [])

    def test_pg_notify_emitted_when_postgres_dsn_present(self):
        executed: list[tuple[str, tuple]] = []

        class _FakeCursor:
            def __init__(self, row=None):
                self._row = row

            def fetchone(self):
                return self._row

        class _FakeWorkflow:
            class db:
                dsn = "postgresql://user:pass@127.0.0.1:5432/aios"

            from contextlib import contextmanager

            @contextmanager
            def tx(self, tenant: str, *, write: bool = True, bounded: bool = False):
                def run(query: str, args: tuple = ()):
                    executed.append((query.strip(), args))
                    if "FROM aios_durable_event WHERE tenant = ? AND id = ?" in query:
                        return _FakeCursor(None)
                    if "COALESCE(MAX(seq), 0) + 1" in query:
                        return _FakeCursor({"next_seq": 7})
                    return _FakeCursor(None)

                yield run

        pg_hub = EventHub(workflow=_FakeWorkflow())
        published = pg_hub.publish(
            "harbour",
            ["admin"],
            {"id": "pg-evt-7", "kind": "security_alert", "title": "PG Notify Test"},
            include_admins=True,
        )
        self.assertEqual(published["seq"], 7)
        self.assertTrue(any("pg_advisory_xact_lock" in q for q, _ in executed))
        notify_calls = [(q, args) for q, args in executed if "pg_notify('aios_events'" in q]
        self.assertEqual(len(notify_calls), 1)
        notify_payload = json.loads(notify_calls[0][1][0])
        self.assertEqual(notify_payload["id"], "pg-evt-7")
        self.assertEqual(notify_payload["seq"], 7)

    def _start_uvicorn(self, app):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        server = uvicorn.Server(
            uvicorn.Config(
                app,
                host="127.0.0.1",
                port=port,
                log_level="error",
                timeout_graceful_shutdown=1,
            )
        )
        thread = threading.Thread(target=server.run, daemon=True)
        thread.start()
        deadline = time.monotonic() + 5.0
        while not server.started:
            if time.monotonic() > deadline:
                self.fail("Uvicorn test server failed to start")
            time.sleep(0.02)
        return server, thread, f"http://127.0.0.1:{port}"

    def test_sse_stream_emits_session_revoked_and_closes_on_suspension(self):
        app = build_app(
            self.runtime,
            self.identity,
            DemoPlanner(),
            event_hub=self.hub,
            governance=self.governance,
        )
        server, thread, base_url = self._start_uvicorn(app)
        try:
            with (
                patch.dict(os.environ, {"AIOS_SSE_HEARTBEAT_SECONDS": "0.1"}),
                httpx.Client(base_url=base_url, trust_env=False, timeout=5.0) as stream_client,
            ):
                with stream_client.stream(
                    "GET",
                    "/v1/workbench/events/stream",
                    headers=self._auth("operator"),
                ) as sse_resp:
                    self.assertEqual(sse_resp.status_code, 200)
                    lines = sse_resp.iter_lines()
                    self.assertEqual(next(lines), ": connected")
                    self.assertEqual(next(lines), "")

                    # Revoke operator access mid-stream
                    self.workflow.set_suspension(self.admin, "operator", True)

                    collected: list[str] = []
                    for line in lines:
                        collected.append(line)
                    joined = "\n".join(collected)
                    self.assertIn("event: session_revoked", joined)
                    self.assertIn('"ACCESS_REVOKED"', joined)
        finally:
            server.should_exit = True
            thread.join(timeout=3.0)

    def test_sse_stream_revoked_before_delivering_queued_sensitive_event(self):
        app = build_app(
            self.runtime,
            self.identity,
            DemoPlanner(),
            event_hub=self.hub,
            governance=self.governance,
        )
        server, thread, base_url = self._start_uvicorn(app)
        try:
            with (
                patch.dict(os.environ, {"AIOS_SSE_HEARTBEAT_SECONDS": "15.0"}),
                httpx.Client(base_url=base_url, trust_env=False, timeout=5.0) as stream_client,
            ):
                with stream_client.stream(
                    "GET",
                    "/v1/workbench/events/stream",
                    headers=self._auth("operator"),
                ) as sse_resp:
                    self.assertEqual(sse_resp.status_code, 200)
                    lines = sse_resp.iter_lines()
                    self.assertEqual(next(lines), ": connected")
                    self.assertEqual(next(lines), "")

                    # Suspend first, then publish a sensitive event to operator
                    self.workflow.set_suspension(self.admin, "operator", True)
                    self.hub.publish(
                        "harbour",
                        ["operator"],
                        {"id": "sensitive-evt-1", "kind": "work_alert", "title": "Confidential Order"},
                    )

                    collected = list(lines)
                    joined = "\n".join(collected)
                    self.assertIn("event: session_revoked", joined)
                    self.assertNotIn("Confidential Order", joined)
        finally:
            server.should_exit = True
            thread.join(timeout=3.0)

    def test_sse_stream_browser_session_logout_revokes_stream(self):
        browser_cfg = BrowserConfig(
            origin="http://127.0.0.1:3000",
            encryption_key=b"0123456789abcdef0123456789abcdef",
            demo=True,
        )
        app = build_app(
            self.runtime,
            self.identity,
            DemoPlanner(),
            browser=browser_cfg,
            event_hub=self.hub,
            governance=self.governance,
        )
        sessions = app.state.browser_sessions
        self.assertIsNotNone(sessions)
        server, thread, base_url = self._start_uvicorn(app)
        try:
            with (
                patch.dict(os.environ, {"AIOS_SSE_HEARTBEAT_SECONDS": "0.1"}),
                httpx.Client(base_url=base_url, trust_env=False, timeout=5.0) as client,
            ):
                login = client.post(
                    "/v1/session",
                    headers={
                        "Origin": "http://127.0.0.1:3000",
                        **self._auth("operator"),
                    },
                )
                self.assertEqual(login.status_code, 200, login.text)
                csrf_token = login.json()["csrf_token"]
                cookies = dict(client.cookies)

                with client.stream(
                    "GET",
                    "/v1/workbench/events/stream",
                    cookies=cookies,
                ) as sse_resp:
                    self.assertEqual(sse_resp.status_code, 200)
                    lines = sse_resp.iter_lines()
                    self.assertEqual(next(lines), ": connected")
                    self.assertEqual(next(lines), "")

                    # Delete browser session (logout) while SSE stream is open
                    with httpx.Client(base_url=base_url, trust_env=False, timeout=5.0) as logout_client:
                        logout = logout_client.delete(
                            "/v1/session",
                            cookies=cookies,
                            headers={
                                "Origin": "http://127.0.0.1:3000",
                                "X-CSRF-Token": csrf_token,
                            },
                        )
                        self.assertEqual(logout.status_code, 204, logout.text)

                    collected = list(lines)
                    joined = "\n".join(collected)
                    self.assertIn("event: session_revoked", joined)
        finally:
            server.should_exit = True
            thread.join(timeout=3.0)

    def test_provider_policy_routes_and_system_health_wiring(self):
        app = build_app(
            self.runtime,
            self.identity,
            DemoPlanner(),
            event_hub=self.hub,
            governance=self.governance,
        )
        with TestClient(app) as client:
            # Non-admin denied
            self.assertEqual(
                client.get("/v1/operations/provider-policy", headers=self._auth("operator")).status_code,
                403,
            )
            self.assertEqual(
                client.get("/v1/operations/provider-policy", headers=self._auth("manager")).status_code,
                403,
            )

            # Health includes schema_security & provider_policy cleanly
            health = client.get("/v1/operations/system-health", headers=self._auth("admin"))
            self.assertEqual(health.status_code, 200, health.text)
            hjson = health.json()
            self.assertIn("schema_security", hjson)
            self.assertIn("provider_policy", hjson)
            self.assertIn("status", hjson["schema_security"])
            self.assertIn("allowed_providers", hjson["provider_policy"])

            # Exercise GET/PUT provider-policy and verify reflected in system-health
            g = client.get("/v1/operations/provider-policy", headers=self._auth("admin"))
            self.assertEqual(g.status_code, 200, g.text)
            self.assertEqual(g.json()["tenant"], "harbour")
            p = client.put(
                "/v1/operations/provider-policy",
                headers=self._auth("admin"),
                json={
                    "allowed_providers": ["deepseek"],
                    "allowed_regions": ["cn-hk"],
                    "allow_failover": False,
                    "max_tier": "T2",
                },
            )
            self.assertEqual(p.status_code, 200, p.text)
            self.assertEqual(p.json()["allowed_providers"], ["deepseek"])
            self.assertEqual(p.json()["allowed_regions"], ["cn-hk"])
            self.assertFalse(p.json()["allow_failover"])
            self.assertEqual(p.json()["max_tier"], "T2")

            health_after = client.get("/v1/operations/system-health", headers=self._auth("admin"))
            self.assertEqual(health_after.status_code, 200)
            self.assertEqual(health_after.json()["provider_policy"]["allowed_providers"], ["deepseek"])
            self.assertFalse(health_after.json()["provider_policy"]["allow_failover"])


if __name__ == "__main__":
    unittest.main()
