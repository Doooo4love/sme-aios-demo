"""Tests for Wave 1A backend storage WAL/pooling, HTTP pool, observability, SSE replay, and worker resilience."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import configparser
from contextlib import contextmanager
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import signal
import socket
import sqlite3
import sys
import threading
from tempfile import TemporaryDirectory
import time
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch
from uuid import uuid4

from fastapi.testclient import TestClient
import httpx
import uvicorn

from aios_demo.storage import Database
from aios_platform.api import build_app
from aios_platform.browser import BrowserOIDC
from aios_platform.channels import ChannelOutboundRequest, ChannelService
from aios_platform.contracts import Actor
from aios_platform.events import EventHub, WorkEvent
from aios_platform.governance import GovernanceService
from aios_platform.http_pool import close_all_http_clients, get_http_client, pooled_post_json
from aios_platform.identity import DemoIdentity
from aios_platform.observability import (
    SlidingWindowRateLimiter,
    current_request_id,
    current_traceparent,
    otel_genai_enabled,
    rate_limit_rejections_count,
    record_cache_metric,
    record_llm_metric,
    record_rate_limit_metric,
    set_circuit_breaker_metric,
)
from aios_platform.providers import DemoPlanner, post_json
from aios_platform.run_worker import main as worker_main, run_worker_loop
from aios_platform.service import services
from aios_platform.workbench import ActiveDocumentRef

ROOT = Path(__file__).resolve().parents[1]


class StoragePoolTests(unittest.TestCase):
    def test_sqlite_wal_pragmas_and_memory_vs_file_engine_mode(self):
        mem_db = Database(Path(":memory:"))
        try:
            self.assertEqual(mem_db.engine_mode, "sqlite-memory")
            with mem_db.transaction(sqlite_timeout=2.5) as run:
                journal = run("PRAGMA journal_mode").fetchone()[0]
                fk = run("PRAGMA foreign_keys").fetchone()[0]
                timeout = run("PRAGMA busy_timeout").fetchone()[0]
                temp_store = run("PRAGMA temp_store").fetchone()[0]
                self.assertEqual(str(journal).lower(), "memory")
                self.assertEqual(fk, 1)
                self.assertEqual(timeout, 2500)
                self.assertEqual(temp_store, 2)
        finally:
            mem_db.close()

        with TemporaryDirectory() as tmp:
            db = Database(Path(tmp) / "wal.sqlite")
            try:
                self.assertEqual(db.engine_mode, "sqlite-wal-pooled")
                with db.transaction(sqlite_timeout=3.5) as run:
                    journal = run("PRAGMA journal_mode").fetchone()[0]
                    sync_mode = run("PRAGMA synchronous").fetchone()[0]
                    temp_store = run("PRAGMA temp_store").fetchone()[0]
                    cache_size = run("PRAGMA cache_size").fetchone()[0]
                    fk = run("PRAGMA foreign_keys").fetchone()[0]
                    busy_timeout = run("PRAGMA busy_timeout").fetchone()[0]
                self.assertEqual(str(journal).lower(), "wal")
                self.assertEqual(sync_mode, 1)  # NORMAL
                self.assertEqual(temp_store, 2)  # MEMORY
                self.assertEqual(cache_size, -16000)
                self.assertEqual(fk, 1)
                self.assertEqual(busy_timeout, 3500)
            finally:
                db.close()
                db.close()  # idempotent

    def test_sqlite_16_worker_concurrent_contention_and_close(self):
        with TemporaryDirectory() as tmp:
            db = Database(Path(tmp) / "contend.sqlite")
            with db.transaction() as run:
                run("CREATE TABLE items (worker INTEGER, seq INTEGER, PRIMARY KEY (worker, seq))")

            barrier = threading.Barrier(16)

            def worker_fn(wid: int) -> int:
                barrier.wait(timeout=5.0)
                for seq in range(10):
                    with db.transaction(write=True, sqlite_timeout=5.0) as run:
                        run("INSERT INTO items VALUES (?, ?)", (wid, seq))
                return 10

            with ThreadPoolExecutor(max_workers=16) as pool:
                counts = list(pool.map(worker_fn, range(16)))
            self.assertEqual(sum(counts), 160)

            with db.transaction(write=False) as run:
                total = run("SELECT COUNT(*) FROM items").fetchone()[0]
            self.assertEqual(total, 160)

            with db._lock:
                self.assertGreaterEqual(len(db._open_conns), 1)
            db.close()
            with db._lock:
                self.assertEqual(len(db._open_conns), 0)

    def test_sqlite_unlinked_file_reopen_never_writes_to_stale_inode(self):
        with TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "recreate.sqlite"
            db = Database(db_path)
            try:
                with db.transaction() as run:
                    run("CREATE TABLE t (v TEXT)")
                    run("INSERT INTO t VALUES ('old')")

                # Remove database and WAL sidecars while pooled connection is still cached on this thread.
                for suffix in ("", "-wal", "-shm"):
                    candidate = Path(str(db_path) + suffix)
                    if candidate.exists():
                        candidate.unlink()

                # Recreate via the SAME Database object on the SAME thread; must detect unlinked inode.
                with db.transaction() as run:
                    run("CREATE TABLE t (v TEXT)")
                    run("INSERT INTO t VALUES ('new')")

                fresh = Database(db_path)
                try:
                    with fresh.transaction(write=False) as run:
                        rows = [row["v"] for row in run("SELECT v FROM t").fetchall()]
                    self.assertEqual(rows, ["new"])
                finally:
                    fresh.close()
            finally:
                db.close()

    def test_postgres_pool_lazy_init_fallback_and_close(self):
        dsn = "postgresql://user:pass@127.0.0.1:5432/aios"

        # 1. Fallback when psycopg_pool is absent
        with patch.dict(sys.modules, {"psycopg_pool": None}):
            db_direct = Database(Path("unused.sqlite"), dsn)
            self.assertEqual(db_direct.engine_mode, "postgres-direct")
            fake_conn = MagicMock()
            fake_conn.__enter__.return_value = fake_conn
            fake_conn.__exit__.return_value = False
            with patch("psycopg.connect", return_value=fake_conn) as pg_connect:
                with db_direct.transaction() as run:
                    run("SELECT ?", (1,))
                pg_connect.assert_called_once()
                fake_conn.execute.assert_called_once_with("SELECT %s", (1,))
            db_direct.close()

        # 2. Pooled mode when psycopg_pool is importable
        created_pools = []

        class FakeConnectionPool:
            def __init__(self, conninfo, **kwargs):
                self.conninfo = conninfo
                self.kwargs = kwargs
                self.closed = False
                self.conn = MagicMock()
                self.conn.__enter__.return_value = self.conn
                self.conn.__exit__.return_value = False
                created_pools.append(self)

            @contextmanager
            def connection(self):
                yield self.conn

            def close(self):
                self.closed = True

        fake_mod = SimpleNamespace(ConnectionPool=FakeConnectionPool)
        with patch.dict(sys.modules, {"psycopg_pool": fake_mod}):
            db_pooled = Database(Path("unused.sqlite"), dsn)
            self.assertEqual(db_pooled.engine_mode, "postgres-pooled")
            self.assertEqual(len(created_pools), 0)  # lazy until first transaction
            with db_pooled.transaction() as run:
                run("SELECT ?", (42,))
            self.assertEqual(len(created_pools), 1)
            pool = created_pools[0]
            self.assertEqual(pool.kwargs["min_size"], 1)
            self.assertEqual(pool.kwargs["max_size"], 16)
            self.assertEqual(pool.kwargs["timeout"], 5.0)
            self.assertIn("row_factory", pool.kwargs["kwargs"])
            pool.conn.execute.assert_called_once_with("SELECT %s", (42,))
            db_pooled.close()
            self.assertTrue(pool.closed)


class HttpPoolTests(unittest.TestCase):
    def setUp(self):
        close_all_http_clients()

    def tearDown(self):
        close_all_http_clients()

    def test_http_pool_reuse_limits_and_close_all(self):
        c1 = get_http_client("providers", timeout=8.0)
        c2 = get_http_client("providers", timeout=8.001)
        c3 = get_http_client("providers", timeout=5.0)
        c4 = get_http_client("channels-mcp", timeout=8.0)
        self.assertIs(c1, c2)
        self.assertIsNot(c1, c3)
        self.assertIsNot(c1, c4)
        self.assertFalse(c1.follow_redirects)
        self.assertFalse(c1.trust_env)
        pool_limits = c1._transport._pool  # noqa: SLF001
        self.assertEqual(pool_limits._max_connections, 32)  # noqa: SLF001
        self.assertEqual(pool_limits._max_keepalive_connections, 16)  # noqa: SLF001

        close_all_http_clients()
        self.assertTrue(c1.is_closed)
        self.assertTrue(c3.is_closed)
        self.assertTrue(c4.is_closed)

        c5 = get_http_client("providers", timeout=8.0)
        self.assertIsNot(c5, c1)
        self.assertFalse(c5.is_closed)

    def test_pooled_post_json_and_callers_use_pool(self):
        @contextmanager
        def fake_stream(self, method, url, **kwargs):
            class _Resp:
                headers = {"content-type": "application/json"}

                def raise_for_status(self):
                    return None

                def iter_bytes(self, _chunk_size):
                    yield b'{"ok": true, "access_token": "tok-123", "external_message_id": "msg-9"}'

            yield _Resp()

        with patch("httpx.Client.stream", autospec=True, side_effect=fake_stream):
            res = pooled_post_json("https://example.invalid/api", {"a": 1}, pool_name="test", timeout=4.0)
            self.assertTrue(res["ok"])
            res2 = post_json("https://example.invalid/api", {"a": 2}, timeout=4.0)
            self.assertTrue(res2["ok"])
            oidc = BrowserOIDC("https://idp.example.invalid", "cid", "csec")
            self.assertEqual(oidc.exchange("code", "verifier", "https://app.example.invalid/cb"), "tok-123")

        @contextmanager
        def oversized_stream(self, method, url, **kwargs):
            class _Big:
                def raise_for_status(self):
                    return None

                def iter_bytes(self, _chunk_size):
                    yield b"x" * 70_000

            yield _Big()

        with patch("httpx.Client.stream", autospec=True, side_effect=oversized_stream):
            with self.assertRaises(ValueError):
                post_json("https://example.invalid/api", {"a": 1})

        # Channels outbound relay also uses pooled client
        with TemporaryDirectory() as tmp, patch.dict(
            os.environ,
            {
                "AIOS_PROFILE": "demo",
                "AIOS_PLATFORM_STATE_DIR": tmp,
                "AIOS_PLATFORM_DSN": "",
                "AIOS_PLATFORM_DSN_FILE": "",
                "AIOS_CHANNEL_SLACK_WEBHOOK_URL": "https://hooks.example.invalid/slack",
            },
        ):
            rt = services()
            try:
                svc = ChannelService(rt.workflow)
                actor = Actor(
                    subject="operator",
                    tenant="harbour",
                    role="operator",
                    warehouses=frozenset({"HK01"}),
                    grants=frozenset({"chat.use"}),
                )
                with patch("httpx.Client.stream", autospec=True, side_effect=fake_stream):
                    out = svc.send_outbound(
                        actor,
                        ChannelOutboundRequest(channel_id="slack", target_handle="#ops", text="hello"),
                    )
                self.assertEqual(out["transport_mode"], "connected_api")
                self.assertEqual(out["external_message_id"], "msg-9")
            finally:
                rt.workflow.db.close()
                rt.erp.db.close()

        # Governance off-topic relay uses pooled client
        with TemporaryDirectory() as tmp, patch.dict(
            os.environ,
            {
                "AIOS_PROFILE": "demo",
                "AIOS_PLATFORM_STATE_DIR": tmp,
                "AIOS_PLATFORM_DSN": "",
                "AIOS_PLATFORM_DSN_FILE": "",
                "AIOS_CHANNEL_SLACK_WEBHOOK_URL": "https://hooks.example.invalid/slack",
            },
        ):
            rt = services()
            try:
                gov = GovernanceService(rt.workflow, EventHub())
                with rt.workflow.tx("harbour") as run:
                    run(
                        """INSERT INTO aios_channel_binding
                           (tenant, channel_id, subject, external_user_id, display_handle, verified, updated_at)
                           VALUES (?, ?, ?, ?, ?, 1, ?)""",
                        ("harbour", "slack", "manager", "U-MGR", "@manager", time.time()),
                    )
                posted = []
                done = threading.Event()

                def fake_post(self, url, **kwargs):
                    posted.append((url, kwargs.get("json")))
                    done.set()

                with patch("httpx.Client.post", autospec=True, side_effect=fake_post):
                    gov._relay_off_topic_escalation_channels(
                        "harbour",
                        ["manager"],
                        WorkEvent(kind="security_alert", title="Off-topic alert", subtitle="Redacted"),
                    )
                    self.assertTrue(done.wait(3.0))
                self.assertEqual(len(posted), 1)
            finally:
                rt.workflow.db.close()
                rt.erp.db.close()


class ObservabilityAndApiResilienceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.secret = "test-only-random-string-not-a-production-secret"
        self.metrics_token = "dedicated-test-metrics-token-with-length"
        with patch.dict(
            os.environ,
            {
                "AIOS_PROFILE": "demo",
                "AIOS_PLATFORM_STATE_DIR": self.tmp.name,
                "AIOS_PLATFORM_DSN": "",
                "AIOS_PLATFORM_DSN_FILE": "",
            },
        ):
            self.runtime = services()
        self.identity = DemoIdentity(self.secret)

    def auth(self, subject: str) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.secret}.{subject}"}

    def test_bounded_json_limits_allow_2mb_turns_and_reject_oversized_other_routes(self):
        app = build_app(self.runtime, self.identity, DemoPlanner(), metrics_token=self.metrics_token)
        with TestClient(app) as client:
            # 1. > 65KB (~900 KB) on /v1/workbench/turns succeeds (not 413!)
            doc = ActiveDocumentRef(doc_id="doc-big", title="Large Spec", content="A" * 900_000)
            resp = client.post(
                "/v1/workbench/turns",
                headers=self.auth("operator"),
                json={"text": "/help", "locale": "en", "active_document": doc.model_dump()},
            )
            self.assertEqual(resp.status_code, 200, resp.text)

            # 2. > 2 MiB on /v1/workbench/turns returns 413
            oversized_turn = b'{"text":"' + (b"B" * 2_100_000) + b'"}'
            too_big = client.post(
                "/v1/workbench/turns",
                headers={**self.auth("operator"), "Content-Type": "application/json"},
                content=oversized_turn,
            )
            self.assertEqual(too_big.status_code, 413)

            # 3. Other /v1/ routes (including /v1/memory, /v1/tasks, /v1/actions) cap at 65_536
            for path in ("/v1/memory", "/v1/tasks", "/v1/actions"):
                r = client.post(
                    path,
                    headers={**self.auth("operator"), "Content-Type": "application/json"},
                    content=b'{"x":"' + (b"C" * 70_000) + b'"}',
                )
                self.assertEqual(r.status_code, 413, f"Expected 413 on {path}, got {r.status_code}")

            # 4. Binary application/octet-stream intake remains exempt from 65KB JSON cap
            r_bin = client.post(
                "/v1/intakes/HK01",
                headers={**self.auth("operator"), "Content-Type": "application/octet-stream"},
                content=b"\x89PNG" + (b"\x00" * 80_000),
            )
            self.assertNotEqual(r_bin.status_code, 413)

    def test_request_id_and_traceparent_echo_and_contextvars(self):
        app = build_app(self.runtime, self.identity, DemoPlanner(), metrics_token=self.metrics_token)
        seen: list[tuple[str | None, str | None]] = []

        @app.get("/v1/test-trace")
        def probe():
            seen.append((current_request_id(), current_traceparent()))
            return {"req_id": current_request_id(), "tp": current_traceparent()}

        valid_tp = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
        valid_req = "req_trace-1234.5:6"
        with TestClient(app) as client:
            ok = client.get(
                "/v1/test-trace",
                headers={"X-Request-Id": valid_req, "traceparent": valid_tp},
            )
            self.assertEqual(ok.status_code, 200)
            self.assertEqual(ok.headers.get("x-request-id"), valid_req)
            self.assertEqual(ok.headers.get("traceparent"), valid_tp)
            self.assertEqual(ok.json(), {"req_id": valid_req, "tp": valid_tp})
            self.assertEqual(seen[-1], (valid_req, valid_tp))
            self.assertIsNone(current_request_id())
            self.assertIsNone(current_traceparent())

            bad = client.get(
                "/v1/test-trace",
                headers={"X-Request-Id": "bad id!", "traceparent": "invalid-tp"},
            )
            self.assertEqual(bad.status_code, 200)
            gen_id = bad.headers.get("x-request-id", "")
            self.assertRegex(gen_id, r"^[0-9a-f]{32}$")
            self.assertNotIn("traceparent", bad.headers)
            self.assertEqual(seen[-1], (gen_id, None))

    def test_sliding_window_rate_limiter_unit_and_http_429(self):
        now = [100.0]
        limiter = SlidingWindowRateLimiter(2, window_seconds=60.0, clock=lambda: now[0])
        self.assertEqual(limiter.allow("k1"), (True, 0))
        self.assertEqual(limiter.allow("k1"), (True, 0))
        allowed, retry_after = limiter.allow("k1")
        self.assertFalse(allowed)
        self.assertGreaterEqual(retry_after, 1)
        self.assertEqual(limiter.allow("k2"), (True, 0))
        now[0] += 61.0
        self.assertEqual(limiter.allow("k1"), (True, 0))

        with patch.dict(os.environ, {"AIOS_API_RATE_LIMIT_RPM": "2", "AIOS_TURNS_RATE_LIMIT_RPM": "1"}):
            app = build_app(self.runtime, self.identity, DemoPlanner(), metrics_token=self.metrics_token)

        with TestClient(app) as client:
            # Turns limit = 1
            t1 = client.post("/v1/workbench/turns", headers=self.auth("operator"), json={"text": "/help"})
            self.assertEqual(t1.status_code, 200)
            t2 = client.post("/v1/workbench/turns", headers=self.auth("operator"), json={"text": "/help"})
            self.assertEqual(t2.status_code, 429)
            self.assertEqual(t2.json(), {"detail": {"code": "RATE_LIMITED"}})
            self.assertGreaterEqual(int(t2.headers["Retry-After"]), 1)

            # Safe GETs and health probes bypass limiter even after 429
            self.assertEqual(client.get("/healthz").status_code, 200)
            self.assertEqual(client.get("/readyz").status_code, 200)
            self.assertEqual(client.get("/v1/me", headers=self.auth("operator")).status_code, 200)

            # API mutating limit = 2
            a1 = client.post("/v1/actions", headers=self.auth("operator"), json={"text": "Show shipment SHP-1001"})
            a2 = client.post("/v1/actions", headers=self.auth("operator"), json={"text": "Show shipment SHP-1001"})
            a3 = client.post("/v1/actions", headers=self.auth("operator"), json={"text": "Show shipment SHP-1001"})
            self.assertEqual(a1.status_code, 200)
            self.assertEqual(a2.status_code, 200)
            self.assertEqual(a3.status_code, 429)
            self.assertEqual(a3.json(), {"detail": {"code": "RATE_LIMITED"}})

            metrics_text = client.get("/metrics", headers={"Authorization": f"Bearer {self.metrics_token}"}).text
            self.assertIn("aios_rate_limit_rejections_total", metrics_text)
            self.assertGreaterEqual(rate_limit_rejections_count(), 2)

    def test_prometheus_genai_collectors_and_optional_otel_bridge(self):
        # Must NEVER raise before instrument() or without opentelemetry installed
        record_llm_metric(
            provider="deepseek",
            model="deepseek-chat",
            tier="T1",
            status="ok",
            prompt_tokens=100,
            cache_hit_tokens=50,
            completion_tokens=20,
            estimated_usd=0.0012,
        )
        record_cache_metric(cache_layer="l1", outcome="hit")
        set_circuit_breaker_metric(provider="deepseek", state="open")
        record_rate_limit_metric(bucket="api")
        self.assertFalse(otel_genai_enabled())

        app = build_app(self.runtime, self.identity, DemoPlanner(), metrics_token=self.metrics_token)
        with TestClient(app) as client:
            record_llm_metric(
                provider="deepseek",
                model="deepseek-chat",
                tier="T2",
                status="ok",
                prompt_tokens=200,
                cache_hit_tokens=80,
                completion_tokens=40,
                estimated_usd=0.0042,
            )
            record_cache_metric(cache_layer="provider_kv", outcome="hit")
            set_circuit_breaker_metric(provider="deepseek", state="half_open")
            record_rate_limit_metric(bucket="workbench_turns")
            metrics_text = client.get("/metrics", headers={"Authorization": f"Bearer {self.metrics_token}"}).text
            for name in (
                "aios_llm_calls_total",
                "aios_llm_tokens_total",
                "aios_llm_cost_usd_total",
                "aios_llm_cache_events_total",
                "aios_circuit_breaker_state",
                "aios_rate_limit_rejections_total",
            ):
                self.assertIn(name, metrics_text)

        # Bridge to opentelemetry.trace when installed
        recorded_attrs = {}

        class FakeSpan:
            def is_recording(self):
                return True

            def set_attribute(self, key, val):
                recorded_attrs[key] = val

        fake_otel = SimpleNamespace(trace=SimpleNamespace(get_current_span=lambda: FakeSpan(), get_tracer=MagicMock()))
        with patch.dict(sys.modules, {"opentelemetry": fake_otel, "opentelemetry.trace": fake_otel.trace}):
            self.assertTrue(otel_genai_enabled())
            record_llm_metric(
                provider="openai",
                model="gpt-5-mini",
                tier="T1",
                status="ok",
                prompt_tokens=10,
                completion_tokens=5,
            )
            self.assertEqual(recorded_attrs["gen_ai.system"], "openai")
            self.assertEqual(recorded_attrs["gen_ai.request.model"], "gpt-5-mini")

    def test_lifespan_shutdown_system_health_rbac_and_known_actors_locking(self):
        fake_assistant = MagicMock()
        fake_assistant.resilience_snapshot.return_value = {
            "provider_circuits": [{"provider": "deepseek", "state": "closed", "failures": 0, "retry_in_seconds": 0.0}],
            "l1_cache": {
                "hits": 3,
                "misses": 1,
                "hit_ratio": 0.75,
                "entries": 2,
                "max_entries": 512,
                "estimated_usd_saved": 0.01,
                "tokens_saved": 1200,
            },
            "fallback_configured": True,
        }
        app = build_app(
            self.runtime,
            self.identity,
            DemoPlanner(),
            metrics_token=self.metrics_token,
            assistant_agent=fake_assistant,
        )
        with TestClient(app) as client:
            # RBAC: operator & manager get 403; admin gets 200
            self.assertEqual(client.get("/v1/operations/system-health", headers=self.auth("operator")).status_code, 403)
            self.assertEqual(client.get("/v1/operations/system-health", headers=self.auth("manager")).status_code, 403)
            health = client.get("/v1/operations/system-health", headers=self.auth("admin"))
            self.assertEqual(health.status_code, 200, health.text)
            payload = health.json()
            self.assertEqual(payload["status"], "ok")
            self.assertEqual(payload["db_engine_mode"], "sqlite-wal-pooled")
            self.assertTrue(payload["storage_ok"])
            self.assertTrue(payload["fallback_configured"])
            self.assertEqual(payload["l1_cache"]["hits"], 3)
            self.assertGreaterEqual(payload["uptime_seconds"], 0.0)

            # Degraded status when a provider circuit is open
            fake_assistant.resilience_snapshot.return_value = {
                "provider_circuits": [{"provider": "deepseek", "state": "open", "failures": 3, "retry_in_seconds": 25.0}],
                "l1_cache": {},
                "fallback_configured": False,
            }
            degraded = client.get("/v1/operations/system-health", headers=self.auth("admin")).json()
            self.assertEqual(degraded["status"], "degraded")

            # Concurrent /v1/me checks to exercise known_actors lock
            with ThreadPoolExecutor(max_workers=8) as pool:
                subjects = ["operator", "manager", "admin", "viewer"] * 4
                results = list(pool.map(lambda s: client.get("/v1/me", headers=self.auth(s)).status_code, subjects))
            self.assertTrue(all(code == 200 for code in results))

            # Ensure pooled HTTP client exists before shutdown
            pooled = get_http_client("lifespan-test", timeout=3.0)
            self.assertFalse(pooled.is_closed)

        # After lifespan exits, assistant, http pool, and DB pools must be closed
        fake_assistant.close.assert_called_once()
        self.assertTrue(pooled.is_closed)
        with self.runtime.workflow.db._lock:
            self.assertEqual(len(self.runtime.workflow.db._open_conns), 0)
        with self.runtime.erp.db._lock:
            self.assertEqual(len(self.runtime.erp.db._open_conns), 0)

        # Also verify integration with real AssistantAgent.resilience_snapshot() and .close()
        app_real = build_app(self.runtime, self.identity, DemoPlanner(), metrics_token=self.metrics_token)
        with TestClient(app_real) as client_real:
            real_health = client_real.get("/v1/operations/system-health", headers=self.auth("admin"))
            self.assertEqual(real_health.status_code, 200, real_health.text)
            body = real_health.json()
            self.assertEqual(body["status"], "ok")
            self.assertIn("hits", body["l1_cache"])
            self.assertIn("hit_ratio", body["l1_cache"])
            self.assertIsInstance(body["provider_circuits"], list)


class SSEReplayTests(unittest.TestCase):
    def test_event_hub_since_event_chronological_visibility_and_eviction(self):
        hub = EventHub(history_limit=3)
        e1 = hub.publish("harbour", ["operator"], {"id": "e1", "kind": "k", "title": "1"})
        e2 = hub.publish("harbour", ["manager"], {"id": "e2", "kind": "k", "title": "2"})
        e3 = hub.publish("harbour", ["operator"], {"id": "e3", "kind": "security_alert", "title": "3"}, include_admins=True)

        self.assertEqual(hub.since_event("harbour", "operator", ""), [])
        self.assertEqual([e["id"] for e in hub.since_event("harbour", "operator", e1["id"])], [e3["id"]])
        self.assertEqual(
            [e["id"] for e in hub.since_event("harbour", "admin", e1["id"], is_admin=True)],
            [e3["id"]],
        )
        self.assertEqual(hub.since_event("harbour", "manager", e2["id"]), [])

        # Evict e1 by exceeding history_limit=3
        e4 = hub.publish("harbour", ["operator"], {"id": "e4", "kind": "k", "title": "4"})
        self.assertEqual(hub.since_event("harbour", "operator", e1["id"]), [])
        self.assertEqual([e["id"] for e in hub.since_event("harbour", "operator", e3["id"])], [e4["id"]])

    def test_sse_stream_last_event_id_replay_and_validation(self):
        with TemporaryDirectory() as tmp:
            secret = "test-only-random-string-not-a-production-secret"
            with patch.dict(
                os.environ,
                {
                    "AIOS_PROFILE": "demo",
                    "AIOS_PLATFORM_STATE_DIR": tmp,
                    "AIOS_PLATFORM_DSN": "",
                    "AIOS_PLATFORM_DSN_FILE": "",
                },
            ):
                runtime = services()
            hub = EventHub()
            app = build_app(runtime, DemoIdentity(secret), DemoPlanner(), event_hub=hub)
            headers = {"Authorization": f"Bearer {secret}.manager"}

            # >128 char Last-Event-ID rejected with 422
            with TestClient(app) as client:
                bad = client.get("/v1/workbench/events/stream", headers={**headers, "Last-Event-ID": "x" * 129})
                self.assertEqual(bad.status_code, 422)

            e1 = hub.publish("harbour", ["manager"], {"id": "evt-1", "kind": "proposal_submitted", "title": "First"})
            e2 = hub.publish("harbour", ["manager"], {"id": "evt-2", "kind": "proposal_submitted", "title": "Second"})
            e3 = hub.publish("harbour", ["manager"], {"id": "evt-3", "kind": "security_alert", "title": "Third"})

            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]

            server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error", timeout_graceful_shutdown=1))
            thread = threading.Thread(target=server.run, daemon=True)
            thread.start()
            try:
                deadline = time.monotonic() + 5.0
                while not server.started:
                    if time.monotonic() > deadline:
                        self.fail("Uvicorn failed to start")
                    time.sleep(0.02)

                with httpx.Client(base_url=f"http://127.0.0.1:{port}", trust_env=False, timeout=5.0) as client:
                    with client.stream(
                        "GET",
                        "/v1/workbench/events/stream",
                        headers={**headers, "Last-Event-ID": e1["id"]},
                    ) as resp:
                        self.assertEqual(resp.status_code, 200)
                        lines = resp.iter_lines()
                        self.assertEqual(next(lines), ": connected")
                        self.assertEqual(next(lines), "")

                        frames = []
                        for _ in range(2):
                            frame = []
                            for line in lines:
                                if line == "":
                                    break
                                frame.append(line)
                            frames.append(frame)

                        self.assertIn(f"id: {e2['id']}", frames[0])
                        self.assertIn("event: work_alert", frames[0])
                        self.assertIn(f"id: {e3['id']}", frames[1])
                        self.assertIn("event: security_alert", frames[1])
            finally:
                server.should_exit = True
                thread.join(timeout=5)


class WorkerAndSystemdTests(unittest.TestCase):
    def test_run_worker_per_tenant_isolation_backoff_and_clean_close(self):
        workflow_db = MagicMock()
        erp_db = MagicMock()
        runtime = SimpleNamespace(workflow=SimpleNamespace(db=workflow_db), erp=SimpleNamespace(db=erp_db))
        stop_event = threading.Event()
        calls: list[str] = []
        harbour_attempts = 0

        def fake_tick(_wf, _erp, tenant: str) -> bool:
            nonlocal harbour_attempts
            calls.append(tenant)
            if tenant == "harbour":
                harbour_attempts += 1
                if harbour_attempts <= 2:
                    raise RuntimeError("transient error")
            if tenant == "island" and len([c for c in calls if c == "island"]) >= 3:
                stop_event.set()
            return True

        with patch("aios_platform.run_worker.tick", side_effect=fake_tick), patch.object(stop_event, "wait", return_value=False):
            # Override time.monotonic so harbour backoff expires promptly across iterations
            ticks = iter([0.0, 0.0, 0.1, 1.0, 1.0, 1.0, 3.0, 3.0, 3.0, 10.0, 10.0, 10.0])
            with patch("aios_platform.run_worker.time.monotonic", side_effect=lambda: next(ticks, 100.0)):
                run_worker_loop(runtime, ("harbour", "island"), stop_event=stop_event)

        self.assertGreaterEqual(calls.count("island"), 3)
        self.assertGreaterEqual(harbour_attempts, 2)
        workflow_db.close.assert_called_once()
        erp_db.close.assert_called_once()

    def test_run_worker_signal_handlers_stop_cleanly_and_close_dbs(self):
        with TemporaryDirectory() as tmp, patch.dict(
            os.environ,
            {
                "AIOS_PROFILE": "demo",
                "AIOS_PLATFORM_STATE_DIR": tmp,
                "AIOS_PLATFORM_DSN": "",
                "AIOS_PLATFORM_DSN_FILE": "",
                "AIOS_WORKER_TENANTS": "harbour",
            },
        ):
            def tick_and_sigterm(wf, _erp, _tenant):
                # Trigger SIGTERM on main thread and confirm loop exits and DBs close.
                signal.raise_signal(signal.SIGTERM)
                return False

            with patch("aios_platform.run_worker.tick", side_effect=tick_and_sigterm) as mocked_tick:
                worker_main([])
            mocked_tick.assert_called_once()

    def test_systemd_memory_tidy_units_present_and_hardened(self):
        svc_path = ROOT / "deploy/integrai/systemd/aios-memory-tidy.service"
        timer_path = ROOT / "deploy/integrai/systemd/aios-memory-tidy.timer"
        self.assertTrue(svc_path.is_file())
        self.assertTrue(timer_path.is_file())

        svc = configparser.ConfigParser(interpolation=None, strict=False)
        svc.optionxform = str
        svc.read_string(svc_path.read_text())
        self.assertEqual(svc["Service"]["Type"], "oneshot")
        self.assertEqual(svc["Service"]["ExecStart"], "/opt/aios/.venv/bin/python -m aios_platform.memory_tidy")
        self.assertEqual(svc["Service"]["NoNewPrivileges"], "yes")
        self.assertEqual(svc["Service"]["ProtectSystem"], "strict")
        self.assertEqual(svc["Service"]["ProtectHome"], "yes")
        self.assertEqual(svc["Service"]["PrivateTmp"], "yes")

        timer = configparser.ConfigParser(interpolation=None)
        timer.optionxform = str
        timer.read_string(timer_path.read_text())
        self.assertEqual(timer["Timer"]["OnCalendar"], "*-*-* 19:15:00 UTC")
        self.assertEqual(timer["Timer"]["RandomizedDelaySec"], "120")
        self.assertEqual(timer["Timer"]["Persistent"], "true")
        self.assertEqual(timer["Timer"]["Unit"], "aios-memory-tidy.service")


if __name__ == "__main__":
    unittest.main()
