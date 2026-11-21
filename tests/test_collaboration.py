"""Collaboration integration, contention and negative authorization cases."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from io import BytesIO
import os
from pathlib import Path
import secrets
from tempfile import TemporaryDirectory
from threading import Event
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

from fastapi.testclient import TestClient
import httpx
from PIL import Image, PngImagePlugin

from aios_platform.api import build_app
from aios_platform.browser import BrowserConfig, BrowserOIDC
from aios_platform.identity import DemoIdentity
from aios_platform.providers import DemoPlanner
from aios_platform.service import services
from aios_platform.workspace_source import WorkspaceSource

DSN = os.getenv("AIOS_PLATFORM_TEST_DSN")
ORIGIN = "https://app.example.test"


class CollaborationTests(unittest.TestCase):
    def setUp(self):
        state = TemporaryDirectory()
        self.addCleanup(state.cleanup)
        self.secret = secrets.token_urlsafe(32)
        self.identity = DemoIdentity(self.secret)
        dsn = self.schema() if DSN else ""
        config = {"AIOS_PROFILE": "demo", "AIOS_PLATFORM_STATE_DIR": state.name,
                  "AIOS_PLATFORM_DSN": dsn, "AIOS_PLATFORM_DSN_FILE": ""}
        with patch.dict(os.environ, config):
            self.runtime = services()
        self.client = self.app()

    def schema(self):
        import psycopg
        from psycopg import sql
        from psycopg.conninfo import make_conninfo

        name = "aios_collaboration_" + uuid4().hex
        table = sql.Identifier(name)
        with psycopg.connect(DSN) as connection:
            connection.execute(sql.SQL("CREATE SCHEMA {}").format(table))

        def drop():
            with psycopg.connect(DSN) as connection:
                connection.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(table))

        self.addCleanup(drop)
        return make_conninfo(DSN, options="-c search_path=" + name)

    def app(self, **configuration):
        client = TestClient(build_app(self.runtime, self.identity, DemoPlanner(), **configuration), base_url=ORIGIN)
        self.addCleanup(client.close)
        return client

    def auth(self, employee):
        return {"Authorization": f"Bearer {self.secret}.{employee}"}

    def room(self, participants=("manager",)):
        room = self.client.post("/v1/chat/rooms", headers=self.auth("operator"),
                                json={"client_id": uuid4().hex, "title": "Dispatch"}).json()["id"]
        for employee in participants:
            reply = self.client.put(f"/v1/chat/rooms/{room}/members/{employee}", headers=self.auth("operator"),
                                    json={"active": True})
            self.assertEqual(reply.status_code, 200, reply.text)
        return room

    def proposal(self):
        day = (datetime.now(timezone.utc).date() + timedelta(days=14)).isoformat()
        request = {"tool": "shipment.reschedule", "warehouse": "HK01", "shipment_id": "SHP-1001",
                   "delivery_date": day}
        reply = self.client.post("/v1/workbench/calls", headers={**self.auth("operator"),
                                 "Idempotency-Key": uuid4().hex}, json=request)
        self.assertEqual(reply.status_code, 200, reply.text)
        return reply.json()["proposal"]

    def future_meeting(self, **extra):
        start = datetime.now(timezone.utc).replace(microsecond=0) + timedelta(hours=1)
        return {"client_id": uuid4().hex, "title": "Private handover",
                "starts_at": start.isoformat(), "ends_at": (start + timedelta(minutes=30)).isoformat(), **extra}

    def test_profile_versions_metadata_strip_and_room_revocation(self):
        room = self.room()
        own = self.auth("operator")
        person = "/v1/profile"
        agent = "/v1/agent-profile"
        self.assertEqual(self.client.patch(person, headers=own,
                                          json={"version": 0, "display_name": "阿明"}).status_code, 200)
        self.assertEqual(self.client.patch(agent, headers=own,
                                          json={"version": 0, "display_name": "晨星"}).status_code, 200)
        self.assertEqual(self.client.patch(person, headers=own,
                                          json={"version": 0, "display_name": "旧写入"}).status_code, 409)
        image = BytesIO()
        meta = PngImagePlugin.PngInfo()
        meta.add_text("private", "SECRET-METADATA")
        Image.new("RGB", (500, 300), "blue").save(image, "PNG", pnginfo=meta)
        avatar = person + "/avatar?version=1"
        header = {**own, "Content-Type": "application/octet-stream"}
        self.assertEqual(self.client.put(avatar, headers=header, content=image.getvalue()).status_code, 200)
        self.assertEqual(self.client.put(avatar, headers=header, content=b"<svg/>").status_code, 422)
        self.assertEqual(self.client.put(avatar, headers=header, content=b"X" * (2 * 1024 * 1024 + 1)).status_code, 413)
        profile = f"/v1/chat/rooms/{room}/members/operator/profile"
        self.assertEqual(self.client.get(profile, headers=self.auth("manager")).json()["display_name"], "阿明")
        read = self.client.get(profile + "/avatar", headers=self.auth("manager"))
        self.assertEqual(read.headers["content-type"], "image/png")
        self.assertEqual(read.headers["cache-control"], "no-store")
        self.assertNotIn(b"SECRET-METADATA", read.content)
        with Image.open(BytesIO(read.content)) as sanitized:
            self.assertEqual(max(sanitized.size), 256)
        self.client.put(f"/v1/chat/rooms/{room}/members/manager", headers=own, json={"active": False})
        for employee in ("manager", "finance", "island-manager"):
            self.assertEqual(self.client.get(profile + "/avatar", headers=self.auth(employee)).status_code, 404)
        self.assertEqual(self.client.get(agent, headers=own).json()["display_name"], "晨星")

    def test_session_is_opaque_csrf_bound_and_revoked(self):
        client = self.app(browser=BrowserConfig(ORIGIN, b"b" * 32, demo=True))
        source = {**self.auth("operator"), "Origin": ORIGIN}
        established = client.post("/v1/session", headers=source)
        self.assertEqual(established.status_code, 200, established.text)
        cookie = established.headers["set-cookie"]
        self.assertIn("__Host-aios_session", cookie)
        self.assertIn("Secure", cookie)
        self.assertIn("HttpOnly", cookie)
        self.assertNotIn(self.secret, cookie)
        csrf = established.json()["csrf_token"]
        self.assertEqual(client.get("/v1/me").json()["subject"], "operator")
        self.assertNotIn("planner", client.get("/v1/workbench/capabilities").json())
        self.assertEqual(client.get("/v1/session").json()["csrf_token"], csrf)
        body = {"version": 0, "display_name": "Browser"}
        self.assertEqual(client.patch("/v1/profile", json=body).status_code, 403)
        self.assertEqual(client.patch("/v1/profile", headers={"Origin": ORIGIN}, json=body).status_code, 403)
        self.assertEqual(client.patch("/v1/profile", headers={"Origin": "https://other.example.test",
                                "X-CSRF-Token": csrf}, json=body).status_code, 403)
        safe = {"Origin": ORIGIN, "X-CSRF-Token": csrf}
        self.assertEqual(client.patch("/v1/profile", headers=safe, json=body).status_code, 200)
        with self.runtime.workflow.tx("harbour", write=False) as run:
            record = run("SELECT encrypted FROM aios_browser_session").fetchone()
            self.assertNotIn(self.secret.encode(), bytes(record["encrypted"]))
        stolen = client.cookies.get("__Host-aios_session")
        self.assertEqual(client.delete("/v1/session", headers=safe).status_code, 204)
        self.assertEqual(client.get("/v1/me", headers={"Cookie": "__Host-aios_session=" + stolen}).status_code, 401)

    def test_browser_oidc_flow_checks_state_before_token_exchange(self):
        keycloak = BrowserOIDC("https://keycloak.example.test/realms/work", "aios-browser", "synthetic-secret")
        client = self.app(browser=BrowserConfig(ORIGIN, b"a" * 32, demo=True, oidc=keycloak))
        response = client.get("/v1/session/login", follow_redirects=False)
        self.assertEqual(response.status_code, 303)
        location = urlsplit(response.headers["location"])
        fields = parse_qs(location.query)
        self.assertEqual(location.netloc, "keycloak.example.test")
        self.assertEqual(fields["code_challenge_method"], ["S256"])
        self.assertEqual(fields["redirect_uri"], [ORIGIN + "/v1/session/callback"])
        self.assertIn("__Host-aios_oauth", response.headers["set-cookie"])
        callback = "/v1/session/callback"
        with patch.object(BrowserOIDC, "exchange", return_value=self.secret + ".operator") as exchange:
            self.assertEqual(client.get(callback, params={"code": "synthetic", "state": "wrong"}).status_code, 401)
            exchange.assert_not_called()
            reply = client.get(callback, params={"code": "synthetic", "state": fields["state"][0]},
                               follow_redirects=False)
            self.assertEqual(reply.headers["location"], "/inbox")
            self.assertEqual(client.get("/v1/me").json()["subject"], "operator")
            self.assertEqual(client.get(callback, params={"code": "synthetic", "state": fields["state"][0]}).status_code, 401)
            self.assertEqual(exchange.call_count, 1)

    def test_history_contended_replay_and_revocation(self):
        start, release = Event(), Event()

        def plan(_text, _offered):
            start.set()
            if not release.wait(6):
                raise ValueError("test timed out")
            return {"tool": "shipment.read", "shipment_id": "SHP-1001", "warehouse": "HK01"}

        planner = Mock(side_effect=plan)
        client = self.app(workbench_planner=SimpleNamespace(plan=planner))
        path = "/v1/workbench/turns"
        body = {"text": "Please find the synthetic shipment, contact NEVER-SAVE@example.test", "client_id": "turn-1"}
        auth = self.auth("operator")

        def post():
            return client.post(path, headers=auth, json=body)

        with ThreadPoolExecutor(max_workers=12) as pool:
            first = pool.submit(post)
            self.assertTrue(start.wait(5))
            try:
                replies = list(pool.map(lambda _index: post(), range(10)))
                self.assertEqual({response.status_code for response in replies}, {409})
                self.assertTrue(all(reply.json()["detail"]["code"] == "TURN_IN_PROGRESS" for reply in replies))
            finally:
                release.set()
            self.assertEqual(first.result().status_code, 200)
        self.assertEqual(post().status_code, 200)
        self.assertEqual(planner.call_count, 1)
        self.assertEqual(client.post(path, headers=auth, json={**body, "text": "New text"}).status_code, 409)
        history = "/v1/workbench/history"
        self.assertEqual(client.get(history, headers=auth).json()["items"][0]["id"], "turn-1")
        self.assertEqual(client.get(history + "/turn-1", headers=self.auth("manager")).status_code, 404)
        self.assertEqual(client.get(history + "/turn-1", headers=self.auth("island-manager")).status_code, 404)
        with self.runtime.workflow.tx("harbour", write=False) as run:
            row = run("SELECT * FROM aios_agent_activity WHERE id = ?", ("turn-1",)).fetchone()
            self.assertNotIn("NEVER-SAVE", repr(dict(row)))
            self.assertNotIn("delivery_date", repr(dict(row)))
        denied = client.put("/v1/workbench/module-access/employees/operator/dispatch",
                            headers=self.auth("access-admin"),
                            json={"version": 0, "grants": [], "warehouses": []})
        self.assertEqual(denied.status_code, 200)
        self.assertEqual(client.get(history + "/turn-1", headers=auth).status_code, 404)
        self.assertEqual(post().status_code, 404)

    def test_history_temporary_failure_retries_bound_request(self):
        fake = Mock(side_effect=[ValueError("mock upstream failure"),
                                  {"tool": "shipment.read", "shipment_id": "SHP-1001", "warehouse": "HK01"}])
        client = self.app(workbench_planner=SimpleNamespace(plan=fake))
        auth = self.auth("operator")
        route = "/v1/workbench/turns"
        body = {"client_id": "recovery", "text": "Find the estimated delivery of the synthetic shipment"}
        self.assertEqual(client.post(route, headers=auth, json=body).status_code, 503)
        self.assertEqual(client.post(route, headers=auth, json=dict(body, text="Different")).status_code, 409)
        self.assertEqual(client.post(route, headers=auth, json=body).status_code, 200)
        self.assertEqual(client.post(route, headers=auth, json=body).status_code, 200)
        self.assertEqual(fake.call_count, 2)

    def test_profile_retries_after_storage_contention_without_partial_write(self):
        from aios_platform.collaboration import lock_subjects

        workflow = self.runtime.workflow
        auth = self.auth("operator")
        self.client.get("/v1/me", headers=auth)
        body = {"version": 0, "display_name": "After recovery"}
        with workflow.tx("harbour") as run:
            lock_subjects(workflow, run, "harbour", "profile-v1", ["operator"])
            stalled = self.client.patch("/v1/profile", headers=auth, json=body)
            self.assertEqual(stalled.status_code, 503, stalled.text)
            self.assertEqual(stalled.headers["retry-after"], "2")
        reply = self.client.patch("/v1/profile", headers=auth, json=body)
        self.assertEqual(reply.json()["version"], 1)

    def test_meeting_race_idempotency_acl_and_notice(self):
        room = self.room()
        path = "/v1/calendar/events"
        meeting = self.future_meeting(attendees=["manager"], room_id=room)
        own, attendee = self.auth("operator"), self.auth("manager")
        with ThreadPoolExecutor(max_workers=12) as pool:
            replies = list(pool.map(lambda i: self.client.post(path, headers=own,
                               json={**meeting, "client_id": f"race-{i}"}), range(24)))
        self.assertEqual(sum(reply.status_code == 201 for reply in replies), 1)
        self.assertEqual({reply.status_code for reply in replies}, {201, 409})
        winner = next(reply.json() for reply in replies if reply.status_code == 201)
        self.assertEqual(sum(reply.status_code == 409 for reply in replies), 23)
        index = next(i for i, reply in enumerate(replies) if reply.status_code == 201)
        duplicate = self.client.post(path, headers=own, json={**meeting, "client_id": f"race-{index}"})
        self.assertEqual(duplicate.json()["id"], winner["id"])
        detail = path + "/" + winner["id"]
        self.assertEqual(self.client.get(detail, headers=self.auth("finance")).status_code, 404)
        self.assertEqual(self.client.get(detail, headers=self.auth("island-manager")).status_code, 404)
        self.assertEqual(self.client.get(detail, headers=attendee).json()["attendees"], ["manager", "operator"])
        self.assertEqual(self.client.post(detail + "/cancel", headers=attendee, json={"revision": 1}).status_code, 403)
        self.assertEqual(self.client.post(detail + "/cancel", headers=own, json={"revision": 1}).status_code, 200)
        self.assertEqual(self.client.post(detail + "/cancel", headers=own, json={"revision": 1}).json()["revision"], 2)
        inbox = "/v1/workbench/notices"
        notices = self.client.get(inbox, headers=attendee).json()["items"]
        self.assertEqual(len(notices), 2)
        self.assertNotIn("reference", notices[0])
        self.assertEqual(self.client.get(f"{inbox}/{notices[0]['id']}", headers=attendee).json()["kind"],
                         "meeting_cancelled")

    def test_room_scheduling_requires_current_chat_grant(self):
        room = self.room()
        route = "/v1/calendar/events"
        meeting = self.future_meeting(attendees=["manager"], room_id=room)
        authenticate = self.identity.authenticate

        def without_chat(token):
            actor = authenticate(token)
            if actor.subject == "operator":
                return actor.model_copy(update={"grants": actor.grants - {"chat.use"}})
            return actor

        with patch.object(self.identity, "authenticate", side_effect=without_chat):
            denied = self.client.post(route, headers=self.auth("operator"), json=meeting)
            self.assertEqual(denied.status_code, 403, denied.text)
            private_meeting = self.future_meeting()
            self.assertEqual(self.client.post(route, headers=self.auth("operator"),
                                              json=private_meeting).status_code, 201)
        self.assertEqual(self.client.get("/v1/workbench/notices", headers=self.auth("manager")).json()["items"], [])

    def test_review_assignment_return_and_approval_conflict(self):
        proposal = self.proposal()
        path = f"/v1/proposals/{proposal['id']}"
        tasks = "/v1/workbench/tasks?lane=assigned"
        digest = proposal["digest"]
        manager, admin = self.auth("manager"), self.auth("admin")
        body = {"action": "assign", "assignee": "admin", "digest": digest}
        self.assertEqual(self.client.post(path + "/review", headers=manager, json=body).status_code, 200)
        self.assertFalse(self.client.get(tasks, headers=manager).json()["items"])
        self.assertEqual(self.client.get(tasks, headers=admin).json()["items"][0]["id"], proposal["id"])
        self.assertEqual(self.client.post(path + "/approve", headers=manager, json={"digest": digest}).status_code, 409)
        actions = [
            ("/approve", {"digest": digest}),
            ("/review", {"digest": digest, "action": "return", "reason": "Please check the delivery window"}),
        ]
        with ThreadPoolExecutor(max_workers=2) as pool:
            replies = list(pool.map(lambda a: self.client.post(path + a[0], headers=admin, json=a[1]), actions))
        self.assertEqual(sum(reply.status_code in {200, 202} for reply in replies), 1)
        final = self.client.get(path, headers=self.auth("operator")).json()
        self.assertIn(final["state"], {"QUEUED", "REJECTED"})
        if final["state"] == "REJECTED":
            self.assertEqual(final["review"]["decision"], "returned")
        submitted = self.client.get("/v1/workbench/tasks?lane=submitted", headers=self.auth("operator"))
        self.assertEqual(submitted.json()["items"][0]["id"], proposal["id"])

    def test_production_source_rejects_wrong_tenant_and_fails_closed_on_timeout(self):
        source = WorkspaceSource("https://bridge.example.test", "synthetic-token", "harbour")
        client = self.app(workbench_data=source, chat_directory=source.known_subject,
                          directory_actor=source.directory_actor)
        producer = {"tenant": "island", "view": {"invoice_id": "INV-100", "warehouse": "HK01",
                    "currency": "HKD", "amount": "20.00", "state": "OPEN"}}
        with patch("aios_platform.workspace_source.post_json", return_value={"result": producer}) as bridge:
            request = {"tool": "finance.invoice.read", "warehouse": "HK01", "invoice_id": "INV-100"}
            reply = client.post("/v1/workbench/calls", headers=self.auth("finance"), json=request)
            self.assertEqual(reply.status_code, 404)
            self.assertEqual(bridge.call_args.args[1]["subject"], "finance")
            self.assertIsNone(source.directory_actor("island", "finance"))
            self.assertEqual(bridge.call_count, 1)
        room = client.post("/v1/chat/rooms", headers=self.auth("operator"),
                           json={"client_id": "room-timeout", "title": "Timeout"}).json()["id"]
        with patch("aios_platform.workspace_source.post_json", side_effect=httpx.ConnectTimeout("PRIVATE TRACE")):
            reply = client.put(f"/v1/chat/rooms/{room}/members/manager", headers=self.auth("operator"),
                               json={"active": True})
            self.assertEqual(reply.status_code, 503)
            self.assertEqual(reply.headers["retry-after"], "2")
            self.assertNotIn("PRIVATE TRACE", reply.text)
