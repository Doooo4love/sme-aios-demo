"""Comprehensive tests for migration 0010, chat read receipts, SSE push, and 8 enterprise channels."""
from __future__ import annotations

import base64
from hashlib import sha1, sha256
import hmac
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
from uuid import uuid4

from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
import httpx
import jwt as pyjwt
from sqlalchemy import create_engine, text
import uvicorn

from aios_platform.api import build_app
from aios_platform.events import EventHub
from aios_platform.governance import GovernanceService
from aios_platform.identity import DemoIdentity
from aios_platform.providers import DemoPlanner
from aios_platform.service import services

ROOT = Path(__file__).resolve().parents[1]
ORIGIN = "https://app.example.test"

FORBIDDEN_BFF_KEYS = frozenset({
    "planner", "reasoning", "chain_of_thought", "thought", "raw_tokens",
    "prompt", "system_prompt", "directive", "guardrail_rules",
    "default_directive", "default_guardrail_rules", "soul", "system_instructions",
    "tool_args", "internal_args", "model_name", "llm_model", "provider",
    "usage", "token_usage", "api_key", "secret", "traceback", "stack",
})

ALL_CHANNELS = ("whatsapp", "wecom", "feishu", "dingtalk", "slack", "teams", "telegram", "line")


class _FakeChannelResponse:
    def __init__(self, payload: dict, status_code: int = 200):
        self._bytes = json.dumps(payload).encode("utf-8")
        self.status_code = status_code
        self.headers = {"content-type": "application/json"}

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            req = httpx.Request("POST", "https://channel.example.test")
            res = httpx.Response(self.status_code, request=req)
            raise httpx.HTTPStatusError("Upstream error", request=req, response=res)

    def iter_bytes(self, chunk_size: int = 8192):
        for idx in range(0, len(self._bytes), chunk_size):
            yield self._bytes[idx:idx + chunk_size]

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False


class ChannelsAndReceiptsTests(unittest.TestCase):
    def setUp(self):
        self.state = TemporaryDirectory()
        self.addCleanup(self.state.cleanup)
        self.secret = secrets.token_urlsafe(32)
        self.identity = DemoIdentity(self.secret)
        with patch.dict(
            os.environ,
            {
                "AIOS_PROFILE": "demo",
                "AIOS_PLATFORM_STATE_DIR": self.state.name,
                "AIOS_PLATFORM_DSN": "",
                "AIOS_PLATFORM_DSN_FILE": "",
            },
        ):
            self.runtime = services()
        self.hub = EventHub()
        self.governance = GovernanceService(
            self.runtime.workflow,
            self.hub,
            known_subject=self.identity.known_subject,
        )
        self.app = build_app(
            self.runtime,
            self.identity,
            DemoPlanner(),
            event_hub=self.hub,
            governance=self.governance,
        )
        self.client = TestClient(self.app, base_url=ORIGIN)
        self.addCleanup(self.client.close)

    def auth(self, subject: str) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.secret}.{subject}"}

    def assert_no_forbidden_keys(self, payload) -> None:
        if isinstance(payload, dict):
            for key, value in payload.items():
                self.assertNotIn(str(key).lower(), FORBIDDEN_BFF_KEYS, f"Forbidden BFF key found: {key!r}")
                self.assert_no_forbidden_keys(value)
        elif isinstance(payload, list):
            for item in payload:
                self.assert_no_forbidden_keys(item)

    def test_migration_0010_upgrades_cleanly_and_is_repeatable(self):
        with TemporaryDirectory() as tmp:
            url = f"sqlite:///{tmp}/migrate10.sqlite"
            engine = create_engine(url)
            config = Config(str(ROOT / "alembic.ini"))
            try:
                with patch.dict(os.environ, {"AIOS_MIGRATION_DATABASE_URL": url, "AIOS_MIGRATION_DATABASE_URL_FILE": ""}):
                    command.upgrade(config, "0009_governance_and_mail")
                    command.upgrade(config, "0010_channels_and_read_receipts")
                    command.upgrade(config, "0010_channels_and_read_receipts")
                with engine.connect() as conn:
                    version = conn.execute(text("SELECT version_num FROM alembic_version")).scalar_one()
                    self.assertEqual(version, "0010_channels_and_read_receipts")
                    tables = {
                        row[0]
                        for row in conn.execute(
                            text("SELECT name FROM sqlite_master WHERE type='table'")
                        ).fetchall()
                    }
                    self.assertTrue(
                        {
                            "aios_chat_read_receipt",
                            "aios_channel_event_dedup",
                            "aios_channel_binding",
                            "aios_channel_outbound_log",
                        }
                        <= tables
                    )
            finally:
                engine.dispose()

    def test_chat_read_receipts_monotonic_clamping_and_live_sse_push(self):
        room = self.client.post(
            "/v1/chat/rooms",
            headers=self.auth("operator"),
            json={"client_id": "rcpt-room-1", "title": "HK01 Ops"},
        ).json()["id"]
        self.assertEqual(
            self.client.put(
                f"/v1/chat/rooms/{room}/members/manager",
                headers=self.auth("operator"),
                json={"active": True},
            ).status_code,
            200,
        )

        # Non-member cannot read receipts or mark read
        self.assertEqual(self.client.get(f"/v1/chat/rooms/{room}/receipts", headers=self.auth("finance")).status_code, 404)
        self.assertEqual(
            self.client.put(
                f"/v1/chat/rooms/{room}/read",
                headers=self.auth("finance"),
                json={"last_read_seq": 0},
            ).status_code,
            404,
        )

        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]

        config = uvicorn.Config(self.app, host="127.0.0.1", port=port, log_level="error", timeout_graceful_shutdown=1)
        server = uvicorn.Server(config)
        thread = threading.Thread(target=server.run, daemon=True)
        thread.start()
        try:
            deadline = time.monotonic() + 5.0
            while not server.started:
                if time.monotonic() > deadline:
                    self.fail("Uvicorn test server failed to start")
                time.sleep(0.02)

            base_url = f"http://127.0.0.1:{port}"
            with (
                httpx.Client(base_url=base_url, trust_env=False, timeout=5.0) as mgr_stream_client,
                httpx.Client(base_url=base_url, trust_env=False, timeout=5.0) as op_stream_client,
                httpx.Client(base_url=base_url, trust_env=False, timeout=5.0) as api_client,
            ):
                with (
                    mgr_stream_client.stream("GET", "/v1/workbench/events/stream", headers=self.auth("manager")) as mgr_sse,
                    op_stream_client.stream("GET", "/v1/workbench/events/stream", headers=self.auth("operator")) as op_sse,
                ):
                    mgr_lines = mgr_sse.iter_lines()
                    op_lines = op_sse.iter_lines()
                    self.assertEqual(next(mgr_lines), ": connected")
                    self.assertEqual(next(mgr_lines), "")
                    self.assertEqual(next(op_lines), ": connected")
                    self.assertEqual(next(op_lines), "")

                    # Operator posts two messages -> Manager receives SSE chat_message
                    p1 = api_client.post(
                        f"/v1/chat/rooms/{room}/messages",
                        headers=self.auth("operator"),
                        json={"client_id": "m1", "text": "Dispatch ready for SHP-1001"},
                    )
                    self.assertEqual(p1.status_code, 201)
                    p2 = api_client.post(
                        f"/v1/chat/rooms/{room}/messages",
                        headers=self.auth("operator"),
                        json={"client_id": "m2", "text": "Please review timeline"},
                    )
                    self.assertEqual(p2.status_code, 201)

                    msg_frame = []
                    for line in mgr_lines:
                        if line == "":
                            break
                        msg_frame.append(line)
                    msg_event = json.loads(next(x for x in msg_frame if x.startswith("data: "))[6:])
                    self.assertEqual(msg_event["kind"], "chat_message")
                    self.assertEqual(msg_event["room_id"], room)
                    self.assertEqual(msg_event["seq"], 1)
                    self.assertEqual(msg_event["author"], "operator")
                    self.assertEqual(msg_event["href"], f"/inbox/{room}")
                    self.assert_no_forbidden_keys(msg_event)

                    # Manager marks read with out-of-range seq 999 -> clamped to 2
                    r1 = api_client.put(
                        f"/v1/chat/rooms/{room}/read",
                        headers=self.auth("manager"),
                        json={"last_read_seq": 999},
                    )
                    self.assertEqual(r1.status_code, 200, r1.text)
                    r1_data = r1.json()
                    self.assertEqual(r1_data["room_id"], room)
                    self.assertEqual(r1_data["subject"], "manager")
                    self.assertEqual(r1_data["last_read_seq"], 2)
                    first_read_at = r1_data["read_at"]

                    # Operator receives SSE chat_read immediately
                    read_frame = []
                    for line in op_lines:
                        if line == "":
                            break
                        read_frame.append(line)
                    read_event = json.loads(next(x for x in read_frame if x.startswith("data: "))[6:])
                    self.assertEqual(read_event["kind"], "chat_read")
                    self.assertEqual(read_event["room_id"], room)
                    self.assertEqual(read_event["subject"], "manager")
                    self.assertEqual(read_event["last_read_seq"], 2)
                    self.assertEqual(read_event["title"], "已读回执")
                    self.assertEqual(read_event["subtitle"], "manager read #2")
                    self.assert_no_forbidden_keys(read_event)

                    # Stale out-of-order PUT (last_read_seq=1) MUST NOT move backwards
                    stale = api_client.put(
                        f"/v1/chat/rooms/{room}/read",
                        headers=self.auth("manager"),
                        json={"last_read_seq": 1},
                    )
                    self.assertEqual(stale.status_code, 200)
                    self.assertEqual(stale.json()["last_read_seq"], 2)
                    self.assertEqual(stale.json()["read_at"], first_read_at)

                    # Negative seq rejected with 422
                    bad = api_client.put(
                        f"/v1/chat/rooms/{room}/read",
                        headers=self.auth("manager"),
                        json={"last_read_seq": -1},
                    )
                    self.assertEqual(bad.status_code, 422)

                    # GET /messages preserves items & next and appends read_receipts
                    msgs = api_client.get(f"/v1/chat/rooms/{room}/messages", headers=self.auth("operator")).json()
                    self.assertEqual(len(msgs["items"]), 2)
                    self.assertIsNone(msgs["next"])
                    self.assertEqual(len(msgs["read_receipts"]), 1)
                    self.assertEqual(msgs["read_receipts"][0]["subject"], "manager")
                    self.assertEqual(msgs["read_receipts"][0]["last_read_seq"], 2)

                    # GET /receipts matches
                    rcpts = api_client.get(f"/v1/chat/rooms/{room}/receipts", headers=self.auth("operator")).json()
                    self.assertEqual(rcpts["items"], msgs["read_receipts"])

                    # Removing manager cleans up receipt from room receipts
                    self.assertEqual(
                        api_client.put(
                            f"/v1/chat/rooms/{room}/members/manager",
                            headers=self.auth("operator"),
                            json={"active": False},
                        ).status_code,
                        200,
                    )
                    after_remove = api_client.get(f"/v1/chat/rooms/{room}/receipts", headers=self.auth("operator")).json()
                    self.assertEqual(after_remove["items"], [])
        finally:
            server.should_exit = True
            thread.join(timeout=3.0)

    def test_channels_catalog_zero_provider_keys_and_zero_secret_leaks(self):
        env_patch = {
            "AIOS_MCP_CHANNEL_SLACK_URL": "http://127.0.0.1:3199/mcp",
            "AIOS_MCP_CHANNEL_SLACK_TOKEN": "mcp-super-secret-token-value",
            "AIOS_CHANNEL_WHATSAPP_WEBHOOK_URL": "https://graph.facebook.com/v21.0/123456/messages",
            "AIOS_CHANNEL_WHATSAPP_WEBHOOK_SECRET": "wa-super-secret-value-999",
            "AIOS_CHANNEL_TELEGRAM_WEBHOOK_SECRET": "tg-secret-token-xyz",
        }
        with patch.dict(os.environ, env_patch):
            resp = self.client.get("/v1/channels/catalog", headers=self.auth("admin"))
        self.assertEqual(resp.status_code, 200, resp.text)
        body = resp.json()
        self.assert_no_forbidden_keys(body)

        raw_text = resp.text
        for secret_val in (
            "127.0.0.1:3199",
            "mcp-super-secret-token-value",
            "graph.facebook.com",
            "wa-super-secret-value-999",
            "tg-secret-token-xyz",
        ):
            self.assertNotIn(secret_val, raw_text)

        items = body["items"]
        self.assertEqual([item["channel_id"] for item in items], list(ALL_CHANNELS))
        by_id = {item["channel_id"]: item for item in items}
        self.assertEqual(by_id["slack"]["transport_mode"], "connected_mcp")
        self.assertTrue(by_id["slack"]["configured"])
        self.assertEqual(by_id["whatsapp"]["transport_mode"], "connected_api")
        self.assertTrue(by_id["whatsapp"]["configured"])
        self.assertEqual(by_id["feishu"]["transport_mode"], "ready_to_bind")
        self.assertFalse(by_id["feishu"]["configured"])
        self.assertEqual(by_id["feishu"]["webhook_path"], "/v1/channels/webhooks/feishu")

    def test_channel_bindings_crud_and_tenant_isolation(self):
        # Operator binds own Slack handle
        res = self.client.put(
            "/v1/channels/bindings/slack",
            headers=self.auth("operator"),
            json={"external_user_id": "U07OP123", "display_handle": "@mingzhe.lin"},
        )
        self.assertEqual(res.status_code, 200, res.text)
        self.assert_no_forbidden_keys(res.json())
        self.assertEqual(res.json()["subject"], "operator")
        self.assertFalse(res.json()["verified"])

        # Operator cannot bind another subject
        self.assertEqual(
            self.client.put(
                "/v1/channels/bindings/slack",
                headers=self.auth("operator"),
                json={"subject": "manager", "external_user_id": "U07MGR", "display_handle": "@chen"},
            ).status_code,
            403,
        )

        # Admin binds verified WeCom handle for manager
        admin_bind = self.client.put(
            "/v1/channels/bindings/wecom",
            headers=self.auth("admin"),
            json={"subject": "manager", "external_user_id": "ZhangChen", "display_handle": "陈志远", "verified": True},
        )
        self.assertEqual(admin_bind.status_code, 200, admin_bind.text)
        self.assertTrue(admin_bind.json()["verified"])
        self.assertEqual(admin_bind.json()["subject"], "manager")

        # Tenant-wide bindings list permitted only for ops admin, isolated across tenants
        self.assertEqual(
            self.client.get("/v1/channels/bindings?scope=tenant", headers=self.auth("operator")).status_code,
            403,
        )
        tenant_list = self.client.get("/v1/channels/bindings?scope=tenant", headers=self.auth("admin")).json()
        self.assert_no_forbidden_keys(tenant_list)
        self.assertEqual(len(tenant_list["items"]), 2)

        island_list = self.client.get("/v1/channels/bindings", headers=self.auth("island-manager")).json()
        self.assertEqual(island_list["items"], [])

        # Unknown channel -> 404; control chars/secrets -> 422
        self.assertEqual(
            self.client.put(
                "/v1/channels/bindings/unknown",
                headers=self.auth("operator"),
                json={"external_user_id": "u1", "display_handle": "@u1"},
            ).status_code,
            404,
        )
        self.assertEqual(
            self.client.put(
                "/v1/channels/bindings/slack",
                headers=self.auth("operator"),
                json={"external_user_id": "u1\r\n", "display_handle": "@u1"},
            ).status_code,
            422,
        )

    def test_outbound_relay_idempotency_transports_and_security_blocks(self):
        # 1. Priority 3 governed_relay + idempotency
        cid = "ch-" + uuid4().hex[:12]
        req_body = {
            "channel_id": "feishu",
            "target_handle": "oc_harbour_ops",
            "text": "HK01 shipment SHP-1001 scheduled for inspection.",
            "client_id": cid,
        }
        r1 = self.client.post("/v1/channels/outbound", headers=self.auth("operator"), json=req_body)
        self.assertEqual(r1.status_code, 201, r1.text)
        out1 = r1.json()
        self.assert_no_forbidden_keys(out1)
        self.assertEqual(out1["transport_mode"], "governed_relay")
        self.assertEqual(out1["delivery_status"], "queued_governed")

        # Idempotent replay
        r2 = self.client.post("/v1/channels/outbound", headers=self.auth("operator"), json=req_body)
        self.assertEqual(r2.status_code, 201)
        self.assertEqual(r2.json()["id"], out1["id"])
        self.assertEqual(r2.json()["external_message_id"], out1["external_message_id"])

        # Conflicting body with same client_id -> 409
        conflict = self.client.post(
            "/v1/channels/outbound",
            headers=self.auth("operator"),
            json={**req_body, "text": "Altered message body"},
        )
        self.assertEqual(conflict.status_code, 409)

        # 2. Priority 1 Streamable HTTP MCP dispatch
        seen_mcp = []

        def fake_mcp_stream(_self_client, method, url, **kwargs):
            seen_mcp.append((method, url, kwargs.get("json")))
            return _FakeChannelResponse({"jsonrpc": "2.0", "id": 1, "result": {"external_message_id": "slack-mcp-msg-77"}})

        with (
            patch.dict(os.environ, {"AIOS_MCP_CHANNEL_SLACK_URL": "http://127.0.0.1:3199/mcp"}),
            patch("aios_platform.channels.httpx.Client.stream", autospec=True, side_effect=fake_mcp_stream),
        ):
            mcp_res = self.client.post(
                "/v1/channels/outbound",
                headers=self.auth("admin"),
                json={"channel_id": "slack", "target_handle": "#hk01-ops", "text": "MCP relay check", "client_id": "mcp-1"},
            )
        self.assertEqual(mcp_res.status_code, 201, mcp_res.text)
        self.assertEqual(mcp_res.json()["transport_mode"], "connected_mcp")
        self.assertEqual(mcp_res.json()["delivery_status"], "sent_mcp")
        self.assertEqual(mcp_res.json()["external_message_id"], "slack-mcp-msg-77")
        self.assertEqual(seen_mcp[0][2]["method"], "tools/call")

        # 3. Priority 2 Official HTTPS Webhook dispatch (and invalid http:// fails closed)
        with (
            patch.dict(os.environ, {"AIOS_CHANNEL_TELEGRAM_WEBHOOK_URL": "https://bot-relay.example.test/send"}),
            patch(
                "aios_platform.channels.httpx.Client.stream",
                autospec=True,
                return_value=_FakeChannelResponse({"message_id": "tg-api-991"}),
            ),
        ):
            api_res = self.client.post(
                "/v1/channels/outbound",
                headers=self.auth("admin"),
                json={"channel_id": "telegram", "target_handle": "@harbour_mgr", "text": "API check", "client_id": "api-1"},
            )
        self.assertEqual(api_res.status_code, 201, api_res.text)
        self.assertEqual(api_res.json()["transport_mode"], "connected_api")
        self.assertEqual(api_res.json()["delivery_status"], "sent_api")
        self.assertEqual(api_res.json()["external_message_id"], "tg-api-991")

        with patch.dict(os.environ, {"AIOS_CHANNEL_LINE_WEBHOOK_URL": "http://insecure.example.test/hook"}):
            bad_url = self.client.post(
                "/v1/channels/outbound",
                headers=self.auth("admin"),
                json={"channel_id": "line", "target_handle": "U123", "text": "Blocked http", "client_id": "bad-url"},
            )
        self.assertEqual(bad_url.status_code, 422)

        # 4. Security blocks: CRLF handle/header injection + secret exfiltration
        crlf_handle = self.client.post(
            "/v1/channels/outbound",
            headers=self.auth("operator"),
            json={"channel_id": "slack", "target_handle": "#ops\r\nBcc: evil@test", "text": "Hi", "client_id": "sec-1"},
        )
        self.assertEqual(crlf_handle.status_code, 403)
        self.assertEqual(crlf_handle.json()["detail"]["code"], "CHANNEL_POLICY_VIOLATION")

        secret_leak = self.client.post(
            "/v1/channels/outbound",
            headers=self.auth("operator"),
            json={
                "channel_id": "slack",
                "target_handle": "#ops",
                "text": "Export sk-secret1234567890abcdef and /etc/aios/env",
                "client_id": "sec-2",
            },
        )
        self.assertEqual(secret_leak.status_code, 403)
        self.assertEqual(secret_leak.json()["detail"]["category"], "SECRET_EXFILTRATION_ATTEMPT")

        events = self.client.get("/v1/operations/security-events", headers=self.auth("admin")).json()["items"]
        self.assertGreaterEqual(len(events), 2)

        # Outbox listing isolation
        op_out = self.client.get("/v1/channels/outbound", headers=self.auth("operator")).json()
        self.assertEqual(len(op_out["items"]), 1)
        admin_tenant_out = self.client.get("/v1/channels/outbound?scope=tenant", headers=self.auth("admin")).json()
        self.assertEqual(len(admin_tenant_out["items"]), 3)
        self.assertEqual(
            self.client.get("/v1/channels/outbound?scope=tenant", headers=self.auth("operator")).status_code,
            403,
        )

    def test_webhooks_fail_closed_verify_all_8_channels_and_dedup(self):
        # 1. Fail closed 503 when webhook secret is not configured
        for cid in ALL_CHANNELS:
            with self.subTest(unconfigured_channel=cid):
                resp = self.client.post(f"/v1/channels/webhooks/{cid}", json={"event_id": "e1", "text": "hello"})
                self.assertEqual(resp.status_code, 503)

        # 2. WhatsApp GET challenge & POST X-Hub-Signature-256 + dedup
        wa_secret = "wa-test-secret-001"
        with patch.dict(os.environ, {"AIOS_CHANNEL_WHATSAPP_WEBHOOK_SECRET": wa_secret}):
            bad_get = self.client.get(
                "/v1/channels/webhooks/whatsapp",
                params={"hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "98765"},
            )
            self.assertEqual(bad_get.status_code, 403)
            ok_get = self.client.get(
                "/v1/channels/webhooks/whatsapp",
                params={"hub.mode": "subscribe", "hub.verify_token": wa_secret, "hub.challenge": "98765"},
            )
            self.assertEqual(ok_get.status_code, 200)
            self.assertEqual(ok_get.text, "98765")

            wa_body = json.dumps(
                {
                    "entry": [
                        {
                            "changes": [
                                {
                                    "value": {
                                        "messages": [
                                            {"id": "wamid.001", "from": "85291234567", "text": {"body": "Confirm SHP-1001"}}
                                        ]
                                    }
                                }
                            ]
                        }
                    ]
                }
            ).encode("utf-8")
            wa_sig = "sha256=" + hmac.new(wa_secret.encode(), wa_body, sha256).hexdigest()
            self.assertEqual(
                self.client.post(
                    "/v1/channels/webhooks/whatsapp",
                    content=wa_body,
                    headers={"X-Hub-Signature-256": "sha256=deadbeef"},
                ).status_code,
                401,
            )
            first = self.client.post(
                "/v1/channels/webhooks/whatsapp",
                content=wa_body,
                headers={"X-Hub-Signature-256": wa_sig, "Content-Type": "application/json"},
            )
            self.assertEqual(first.status_code, 200, first.text)
            env1 = first.json()
            self.assert_no_forbidden_keys(env1)
            self.assertFalse(env1["deduplicated"])
            self.assertEqual(env1["external_event_id"], "wamid.001")
            self.assertEqual(env1["sender_handle"], "85291234567")

            replay = self.client.post(
                "/v1/channels/webhooks/whatsapp",
                content=wa_body,
                headers={"X-Hub-Signature-256": wa_sig, "Content-Type": "application/json"},
            )
            self.assertEqual(replay.status_code, 200)
            self.assertTrue(replay.json()["deduplicated"])
            self.assertEqual(replay.json()["received_at"], env1["received_at"])

        # 3. WeCom GET & POST SHA1
        wecom_secret = "wecom-token-secret"
        with patch.dict(os.environ, {"AIOS_CHANNEL_WECOM_WEBHOOK_SECRET": wecom_secret}):
            ts, nonce, echo = "1700000100", "nonce123", "echo_ok"
            get_sig = sha1("".join(sorted([wecom_secret, ts, nonce, echo])).encode()).hexdigest()
            self.assertEqual(
                self.client.get(
                    "/v1/channels/webhooks/wecom",
                    params={"msg_signature": get_sig, "timestamp": ts, "nonce": nonce, "echostr": echo},
                ).text,
                echo,
            )
            wc_body = json.dumps({"MsgId": "wc-101", "FromUserName": "lin_mz", "Content": "WeCom hello"}).encode()
            wc_sig = sha1("".join(sorted([wecom_secret, ts, nonce, wc_body.decode()])).encode()).hexdigest()
            self.assertEqual(
                self.client.post(
                    "/v1/channels/webhooks/wecom",
                    params={"msg_signature": "bad", "timestamp": ts, "nonce": nonce},
                    content=wc_body,
                ).status_code,
                401,
            )
            wc_ok = self.client.post(
                "/v1/channels/webhooks/wecom",
                params={"msg_signature": wc_sig, "timestamp": ts, "nonce": nonce},
                content=wc_body,
            )
            self.assertEqual(wc_ok.status_code, 200, wc_ok.text)
            self.assertEqual(wc_ok.json()["external_event_id"], "wc-101")

        # 4. Feishu url_verification + X-Lark-Signature
        feishu_secret = "feishu-encrypt-secret"
        with patch.dict(os.environ, {"AIOS_CHANNEL_FEISHU_WEBHOOK_SECRET": feishu_secret}):
            ch_res = self.client.post(
                "/v1/channels/webhooks/feishu",
                json={"type": "url_verification", "token": feishu_secret, "challenge": "lark-chal-88"},
            )
            self.assertEqual(ch_res.status_code, 200)
            self.assertEqual(ch_res.json(), {"challenge": "lark-chal-88"})

            fs_body = json.dumps(
                {
                    "header": {"event_id": "fs-evt-1"},
                    "event": {
                        "sender": {"sender_id": {"open_id": "ou_123"}},
                        "message": {"content": json.dumps({"text": "Feishu dispatch"})},
                    },
                }
            ).encode()
            fs_ts, fs_nonce = "1700000200", "n42"
            fs_sig = sha256((fs_ts + fs_nonce + feishu_secret + fs_body.decode()).encode()).hexdigest()
            fs_ok = self.client.post(
                "/v1/channels/webhooks/feishu",
                content=fs_body,
                headers={
                    "X-Lark-Request-Timestamp": fs_ts,
                    "X-Lark-Request-Nonce": fs_nonce,
                    "X-Lark-Signature": fs_sig,
                },
            )
            self.assertEqual(fs_ok.status_code, 200, fs_ok.text)
            self.assertEqual(fs_ok.json()["sender_handle"], "ou_123")
            self.assertEqual(fs_ok.json()["text_preview"], "Feishu dispatch")

        # 5. DingTalk timestamp + HMAC sign
        dt_secret = "dingtalk-hmac-secret"
        with patch.dict(os.environ, {"AIOS_CHANNEL_DINGTALK_WEBHOOK_SECRET": dt_secret}):
            dt_ts = str(int(time.time() * 1000))
            dt_sign = base64.b64encode(hmac.new(dt_secret.encode(), f"{dt_ts}\n{dt_secret}".encode(), sha256).digest()).decode()
            dt_body = {"msgId": "dt-900", "senderNick": "陈志远", "text": {"content": "DingTalk approval"}}
            self.assertEqual(
                self.client.post(
                    "/v1/channels/webhooks/dingtalk",
                    json=dt_body,
                    headers={"timestamp": dt_ts, "sign": "invalid"},
                ).status_code,
                401,
            )
            dt_ok = self.client.post(
                "/v1/channels/webhooks/dingtalk",
                json=dt_body,
                headers={"timestamp": dt_ts, "sign": dt_sign},
            )
            self.assertEqual(dt_ok.status_code, 200, dt_ok.text)
            self.assertEqual(dt_ok.json()["external_event_id"], "dt-900")

        # 6. Slack v0 HMAC + 5m timestamp replay guard + url_verification
        slack_secret = "slack-signing-secret"
        with patch.dict(os.environ, {"AIOS_CHANNEL_SLACK_WEBHOOK_SECRET": slack_secret}):
            stale_ts = str(int(time.time()) - 400)
            sl_chal = json.dumps({"type": "url_verification", "challenge": "sl-chal-99"}).encode()
            stale_sig = "v0=" + hmac.new(slack_secret.encode(), f"v0:{stale_ts}:".encode() + sl_chal, sha256).hexdigest()
            self.assertEqual(
                self.client.post(
                    "/v1/channels/webhooks/slack",
                    content=sl_chal,
                    headers={"X-Slack-Request-Timestamp": stale_ts, "X-Slack-Signature": stale_sig},
                ).status_code,
                401,
            )

            fresh_ts = str(int(time.time()))
            fresh_sig = "v0=" + hmac.new(slack_secret.encode(), f"v0:{fresh_ts}:".encode() + sl_chal, sha256).hexdigest()
            sl_chal_resp = self.client.post(
                "/v1/channels/webhooks/slack",
                content=sl_chal,
                headers={"X-Slack-Request-Timestamp": fresh_ts, "X-Slack-Signature": fresh_sig},
            )
            self.assertEqual(sl_chal_resp.status_code, 200)
            self.assertEqual(sl_chal_resp.json(), {"challenge": "sl-chal-99"})

            sl_body = json.dumps({"event_id": "EvSlack1", "event": {"user": "U123", "text": "Slack hello"}}).encode()
            sl_sig = "v0=" + hmac.new(slack_secret.encode(), f"v0:{fresh_ts}:".encode() + sl_body, sha256).hexdigest()
            sl_ok = self.client.post(
                "/v1/channels/webhooks/slack",
                content=sl_body,
                headers={"X-Slack-Request-Timestamp": fresh_ts, "X-Slack-Signature": sl_sig},
            )
            self.assertEqual(sl_ok.status_code, 200, sl_ok.text)
            self.assertEqual(sl_ok.json()["external_event_id"], "EvSlack1")

        # 7. Teams HMAC + Bearer JWT
        teams_secret = "teams-webhook-secret-32-bytes-minimum"
        with patch.dict(os.environ, {"AIOS_CHANNEL_TEAMS_WEBHOOK_SECRET": teams_secret}):
            tm_body = json.dumps({"id": "tm-1", "from": {"id": "29:teamsUser"}, "text": "Teams msg"}).encode()
            tm_hmac = base64.b64encode(hmac.new(teams_secret.encode(), tm_body, sha256).digest()).decode()
            self.assertEqual(
                self.client.post(
                    "/v1/channels/webhooks/teams",
                    content=tm_body,
                    headers={"Authorization": "HMAC bad"},
                ).status_code,
                401,
            )
            tm_ok = self.client.post(
                "/v1/channels/webhooks/teams",
                content=tm_body,
                headers={"Authorization": f"HMAC {tm_hmac}"},
            )
            self.assertEqual(tm_ok.status_code, 200, tm_ok.text)
            self.assertEqual(tm_ok.json()["external_event_id"], "tm-1")

            token = pyjwt.encode({"sub": "bot", "exp": int(time.time()) + 60}, teams_secret, algorithm="HS256")
            tm_jwt = self.client.post(
                "/v1/channels/webhooks/teams",
                content=json.dumps({"id": "tm-2", "from": {"id": "29:teamsUser"}, "text": "JWT msg"}).encode(),
                headers={"Authorization": f"Bearer {token}"},
            )
            self.assertEqual(tm_jwt.status_code, 200, tm_jwt.text)
            self.assertEqual(tm_jwt.json()["external_event_id"], "tm-2")

        # 8. Telegram secret token
        tg_secret = "tg-secret-token-xyz"
        with patch.dict(os.environ, {"AIOS_CHANNEL_TELEGRAM_WEBHOOK_SECRET": tg_secret}):
            self.assertEqual(
                self.client.post(
                    "/v1/channels/webhooks/telegram",
                    json={"update_id": 555, "message": {"from": {"username": "ops_tg"}, "text": "TG ping"}},
                    headers={"X-Telegram-Bot-Api-Secret-Token": "wrong"},
                ).status_code,
                401,
            )
            tg_ok = self.client.post(
                "/v1/channels/webhooks/telegram",
                json={"update_id": 555, "message": {"from": {"username": "ops_tg"}, "text": "TG ping"}},
                headers={"X-Telegram-Bot-Api-Secret-Token": tg_secret},
            )
            self.assertEqual(tg_ok.status_code, 200, tg_ok.text)
            self.assertEqual(tg_ok.json()["external_event_id"], "555")
            self.assertEqual(tg_ok.json()["sender_handle"], "ops_tg")

        # 9. LINE HMAC-SHA256
        line_secret = "line-channel-secret"
        with patch.dict(os.environ, {"AIOS_CHANNEL_LINE_WEBHOOK_SECRET": line_secret}):
            ln_body = json.dumps(
                {
                    "events": [
                        {
                            "webhookEventId": "ln-evt-1",
                            "source": {"userId": "Uline001"},
                            "message": {"id": "m1", "text": "LINE hello"},
                        }
                    ]
                }
            ).encode()
            ln_sig = base64.b64encode(hmac.new(line_secret.encode(), ln_body, sha256).digest()).decode()
            self.assertEqual(
                self.client.post(
                    "/v1/channels/webhooks/line",
                    content=ln_body,
                    headers={"X-Line-Signature": "wrong"},
                ).status_code,
                401,
            )
            ln_ok = self.client.post(
                "/v1/channels/webhooks/line",
                content=ln_body,
                headers={"X-Line-Signature": ln_sig},
            )
            self.assertEqual(ln_ok.status_code, 200, ln_ok.text)
            self.assertEqual(ln_ok.json()["external_event_id"], "ln-evt-1")
            self.assertEqual(ln_ok.json()["sender_handle"], "Uline001")

        # 10. Unknown channel, unsupported GET challenge, and >256 KiB payload limit
        self.assertEqual(self.client.post("/v1/channels/webhooks/unknown", json={"x": 1}).status_code, 404)
        with patch.dict(os.environ, {"AIOS_CHANNEL_SLACK_WEBHOOK_SECRET": "sl-sec"}):
            self.assertEqual(self.client.get("/v1/channels/webhooks/slack").status_code, 405)
            self.assertEqual(
                self.client.post("/v1/channels/webhooks/slack", content=b"x" * (262_144 + 1)).status_code,
                413,
            )

    def test_mcp_unreachable_falls_back_to_governed_relay_and_assurance_isolation(self):
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        from aios_platform.api import create_app
        from aios_platform.assurance_audit import AuditKeys, pack

        with (
            patch.dict(os.environ, {"AIOS_MCP_CHANNEL_SLACK_URL": "http://127.0.0.1:3199/mcp"}),
            patch("aios_platform.channels.httpx.Client.stream", side_effect=httpx.ConnectError("MCP offline")),
        ):
            fb = self.client.post(
                "/v1/channels/outbound",
                headers=self.auth("operator"),
                json={"channel_id": "slack", "target_handle": "#ops", "text": "Fallback test", "client_id": "fb-1"},
            )
        self.assertEqual(fb.status_code, 201, fb.text)
        self.assertEqual(fb.json()["transport_mode"], "governed_relay")
        self.assertEqual(fb.json()["delivery_status"], "queued_fallback")

        # Verify :8761 assurance process keeps channels active without violating planner/assistant isolation
        key_file = Path(self.state.name) / "assurance-key.json"
        keys = AuditKeys(Ed25519PrivateKey.generate(), AESGCM(AESGCM.generate_key(bit_length=256)))
        key_file.write_text(
            json.dumps(
                {
                    "key_id": "k1",
                    "signing": pack(keys.signer.private_bytes_raw()),
                    "encryption": pack(AESGCM.generate_key(bit_length=256)),
                }
            )
        )
        os.chmod(key_file, 0o600)
        demo_secret = secrets.token_urlsafe(32)
        env_8761 = {
            "AIOS_PROFILE": "demo",
            "AIOS_PLATFORM_STATE_DIR": self.state.name,
            "AIOS_PLATFORM_DSN": "",
            "AIOS_PLATFORM_DSN_FILE": "",
            "AIOS_DEMO_SECRET": demo_secret,
            "AIOS_PLANNER": "demo",
            "AIOS_WORKBENCH_PLANNER": "local",
            "AIOS_ASSURANCE_DEMO_KEY_FILE": str(key_file),
        }
        with patch.dict(os.environ, env_8761, clear=True):
            app_8761 = create_app()
            with TestClient(app_8761, base_url=ORIGIN) as client_8761:
                cat = client_8761.get(
                    "/v1/channels/catalog",
                    headers={"Authorization": f"Bearer {demo_secret}.operator"},
                )
                self.assertEqual(cat.status_code, 200)
                self.assertEqual(len(cat.json()["items"]), 8)
                self.assert_no_forbidden_keys(cat.json())
                caps = client_8761.get(
                    "/v1/workbench/capabilities",
                    headers={"Authorization": f"Bearer {demo_secret}.operator"},
                )
                self.assertEqual(caps.json()["planner"], "local_rules")


if __name__ == "__main__":
    unittest.main()
