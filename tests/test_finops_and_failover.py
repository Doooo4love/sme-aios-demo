"""Unit and integration tests for Wave 1A FinOps controls, caching, compaction, circuit snapshots, and multi-provider failover."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
import json
import os
from pathlib import Path
import secrets
from tempfile import TemporaryDirectory
import threading
import time
import unittest
from unittest.mock import patch

from aios_platform.assistant_agent import AssistantAgent, AssistantMessage, PendingWorkSnapshot
from aios_platform.events import EventHub
from aios_platform.governance import GovernanceService
from aios_platform.identity import DemoIdentity
from aios_platform.llm_provider import (
    ANTHROPIC_PROMPT_CACHE_MIN_CHARS,
    MODEL_PROFILES,
    AnthropicAdapter,
    CircuitOpenError,
    LLMProvider,
    LLMProviderError,
    OpenAICompatAdapter,
    ProviderCircuitBreaker,
    resolve_fallback_llm_configs,
)
from aios_platform.response_cache import (
    ESSENTIAL_BUSINESS_KEYS,
    BoundedResponseCache,
    compact_tool_observation,
)
from aios_platform.routing_context import (
    ActiveDocumentInput,
    QuotaManager,
    RoutingTelemetryStore,
)
from aios_platform.service import services
from aios_platform.workbench import WorkResult


class _MockStreamResponse:
    def __init__(self, payload: dict | bytes, status_code: int = 200, headers: dict[str, str] | None = None):
        self._bytes = payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8")
        self.status_code = status_code
        self.headers = headers or {}

    def iter_bytes(self, chunk_size: int = 8192):
        for i in range(0, len(self._bytes), chunk_size):
            yield self._bytes[i:i + chunk_size]

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False


class FinOpsAndFailoverTests(unittest.TestCase):
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
        self.operator = self.identity.directory_actor("harbour", "operator")
        self.manager = self.identity.directory_actor("harbour", "manager")
        self.admin = self.identity.directory_actor("harbour", "admin")

    def test_prompt_cache_guards_and_openai_400_strip(self):
        # 1. Anthropic write-penalty guard: skip cache_control when len(system_text) < 3600
        ant = AnthropicAdapter()
        ant_prof = MODEL_PROFILES["claude-sonnet-4-6"]
        short_sys = "S" * (ANTHROPIC_PROMPT_CACHE_MIN_CHARS - 1)
        short_payload = ant.build_payload(
            ant_prof,
            [{"role": "system", "content": short_sys}, {"role": "user", "content": "Hi"}],
            [],
            effort="none",
            max_tokens=1200,
            temperature=0.3,
        )
        self.assertNotIn("cache_control", short_payload["system"][0])

        long_sys = "L" * ANTHROPIC_PROMPT_CACHE_MIN_CHARS
        long_payload = ant.build_payload(
            ant_prof,
            [{"role": "system", "content": long_sys}, {"role": "user", "content": "Hi"}],
            [],
            effort="none",
            max_tokens=1200,
            temperature=0.3,
        )
        self.assertEqual(long_payload["system"][0]["cache_control"], {"type": "ephemeral"})

        # 2. OpenAI prompt_cache_key + HTTP 400 single-retry strip
        oai = OpenAICompatAdapter()
        oai_prof = MODEL_PROFILES["gpt-5.4-mini"]
        sys_msg = "Immutable system instructions for OpenAI caching."
        oai_payload = oai.build_payload(
            oai_prof,
            [{"role": "system", "content": sys_msg}, {"role": "user", "content": "Hello"}],
            [],
            effort="low",
            max_tokens=1200,
            temperature=0.3,
        )
        expected_key = f"aios:{sha256(sys_msg.encode('utf-8')).hexdigest()[:24]}"
        self.assertEqual(oai_payload["prompt_cache_key"], expected_key)

        # DeepSeek provider should not emit OpenAI prompt_cache_key
        ds_payload = oai.build_payload(
            MODEL_PROFILES["deepseek-chat"],
            [{"role": "system", "content": sys_msg}, {"role": "user", "content": "Hello"}],
            [],
            effort="low",
            max_tokens=1200,
            temperature=0.3,
        )
        self.assertNotIn("prompt_cache_key", ds_payload)

        # HTTP 400 retry strips prompt_cache_key & reasoning_effort together once
        provider = LLMProvider(api_key="sk-oai-test", model="gpt-5.4-mini", retry_backoff_base=0.0)
        self.addCleanup(provider.close)
        seen_payloads: list[dict] = []

        def fake_stream(_self, _method, _url, **kwargs):
            seen_payloads.append(dict(kwargs["json"]))
            if len(seen_payloads) == 1:
                return _MockStreamResponse({"error": "unsupported param"}, status_code=400)
            return _MockStreamResponse(
                {
                    "model": "gpt-5.4-mini",
                    "choices": [{"message": {"role": "assistant", "content": "Retried ok"}}],
                    "usage": {"prompt_tokens": 50, "completion_tokens": 10},
                }
            )

        with patch("httpx.Client.stream", autospec=True, side_effect=fake_stream):
            res = provider.chat([{"role": "system", "content": sys_msg}, {"role": "user", "content": "Hello"}], effort="low")
        self.assertEqual(res.text, "Retried ok")
        self.assertEqual(len(seen_payloads), 2)
        self.assertIn("prompt_cache_key", seen_payloads[0])
        self.assertIn("reasoning_effort", seen_payloads[0])
        self.assertNotIn("prompt_cache_key", seen_payloads[1])
        self.assertNotIn("reasoning_effort", seen_payloads[1])

    def test_circuit_breaker_snapshot_and_multi_provider_failover(self):
        events: list[tuple[str, str]] = []

        class _ObsStub:
            @staticmethod
            def set_circuit_breaker_metric(*, provider: str, state: str):
                events.append((provider, state))

        breaker = ProviderCircuitBreaker(failure_threshold=2, recovery_timeout_s=0.2)
        with patch.dict("sys.modules", {"aios_platform.observability": _ObsStub()}):
            breaker.record_failure("z-prov:https://z.example")
            breaker.record_failure("z-prov:https://z.example")
            breaker.record_success("a-prov:https://a.example")
            snap = breaker.snapshot()

        self.assertEqual([s["provider"] for s in snap], ["a-prov:https://a.example", "z-prov:https://z.example"])
        self.assertEqual(snap[0]["state"], "closed")
        self.assertEqual(snap[1]["state"], "open")
        self.assertEqual(snap[1]["failures"], 2)
        self.assertGreater(snap[1]["retry_in_seconds"], 0.0)
        self.assertIn(("z-prov:https://z.example", "open"), events)
        self.assertIn(("a-prov:https://a.example", "closed"), events)

        # Failover: primary returns 503 -> skips open fallback 1 -> succeeds on fallback 2
        primary_breaker = ProviderCircuitBreaker(failure_threshold=1, recovery_timeout_s=30.0)
        fb1_breaker = ProviderCircuitBreaker(failure_threshold=1, recovery_timeout_s=30.0)
        fb1_breaker.record_failure("anthropic:https://api.anthropic.com")  # open circuit on fb1

        fb1 = LLMProvider(api_key="sk-ant", model="claude-sonnet-4-6", circuit_breaker=fb1_breaker, max_retries=0)
        fb2 = LLMProvider(api_key="sk-oai", model="gpt-5.4-mini", max_retries=0)
        primary = LLMProvider(
            api_key="sk-ds",
            model="deepseek-chat",
            circuit_breaker=primary_breaker,
            max_retries=0,
            retry_backoff_base=0.0,
        ).with_fallbacks([fb1, fb2])
        self.addCleanup(primary.close)

        urls_called: list[str] = []

        def fake_failover_stream(_self, _method, url, **kwargs):
            urls_called.append(url)
            if "deepseek.com" in url:
                return _MockStreamResponse({"error": "upstream down"}, status_code=503)
            if "openai.com" in url:
                return _MockStreamResponse(
                    {
                        "model": "gpt-5.4-mini",
                        "choices": [{"message": {"role": "assistant", "content": "Served by OpenAI fallback"}}],
                        "usage": {"prompt_tokens": 40, "completion_tokens": 12},
                    }
                )
            raise AssertionError(f"Unexpected URL called (open fb1 must be skipped): {url}")

        with patch("httpx.Client.stream", autospec=True, side_effect=fake_failover_stream):
            res1 = primary.chat([{"role": "user", "content": "Status"}], effort="none")
            # Second call hits CircuitOpenError on primary directly and still fails over seamlessly
            res2 = primary.chat([{"role": "user", "content": "Status again"}], effort="none")

        self.assertEqual(res1.text, "Served by OpenAI fallback")
        self.assertEqual(res1.provider, "openai")
        self.assertEqual(res1.failover_from, "deepseek/deepseek-chat")
        self.assertEqual(res2.failover_from, "deepseek/deepseek-chat")
        self.assertEqual(urls_called.count("https://api.deepseek.com/chat/completions"), 1)
        self.assertEqual(urls_called.count("https://api.openai.com/v1/chat/completions"), 2)

        # resolve_fallback_llm_configs reads env and file cleanly
        key_file = Path(self.state.name) / "fb-key.txt"
        key_file.write_text("sk-fb-secret-file\n", encoding="utf-8")
        with patch.dict(
            os.environ,
            {
                "AIOS_LLM_FALLBACK_API_KEY_FILE": str(key_file),
                "AIOS_LLM_FALLBACK_PROVIDER": "openai",
                "AIOS_LLM_FALLBACK_MODEL": "gpt-5.4-mini",
                "AIOS_LLM_FALLBACK_BASE_URL": "https://api.openai.com/v1",
            },
            clear=False,
        ):
            cfgs = resolve_fallback_llm_configs()
        self.assertEqual(len(cfgs), 1)
        self.assertEqual(cfgs[0]["api_key"], "sk-fb-secret-file")
        self.assertEqual(cfgs[0]["model"], "gpt-5.4-mini")
        self.assertEqual(cfgs[0]["provider"], "openai")

    def test_bounded_response_cache_lru_ttl_isolation_and_concurrency(self):
        cache = BoundedResponseCache(max_entries=2, ttl_seconds=0.12)
        k_op = cache.make_key("harbour", "operator", "operator", "en", 1, "doc1", "qhash1")
        k_mgr = cache.make_key("harbour", "manager", "manager", "en", 1, "doc1", "qhash1")
        k_mem2 = cache.make_key("harbour", "operator", "operator", "en", 2, "doc1", "qhash1")
        k_doc2 = cache.make_key("harbour", "operator", "operator", "en", 1, "doc2", "qhash1")
        k_other_tenant = cache.make_key("island", "operator", "operator", "en", 1, "doc1", "qhash1")
        self.assertEqual(len({k_op, k_mgr, k_mem2, k_doc2, k_other_tenant}), 5)

        cache.put(k_op, {"reply": "op answer"}, saved_tokens=150, saved_usd=0.0025)
        cache.put(k_mgr, {"reply": "mgr answer"}, saved_tokens=100, saved_usd=0.001)
        # Touch k_op so k_mgr becomes LRU
        hit = cache.get(k_op)
        self.assertEqual(hit, {"reply": "op answer"})
        # Mutating caller dict must not mutate cache contents
        hit["reply"] = "mutated"
        self.assertEqual(cache.get(k_op)["reply"], "op answer")

        # Insert 3rd entry -> evicts k_mgr
        cache.put(k_mem2, {"reply": "mem2 answer"})
        self.assertIsNone(cache.get(k_mgr))
        self.assertIsNotNone(cache.get(k_op))

        # Invalidate subject clears only operator in harbour (test with capacity >= 4)
        inv_cache = BoundedResponseCache(max_entries=4, ttl_seconds=0.12)
        inv_cache.put(k_op, {"reply": "op 1"})
        inv_cache.put(k_mem2, {"reply": "op 2"})
        k_isl = inv_cache.make_key("island", "operator", "operator", "en", 1, "doc1", "qhash1")
        inv_cache.put(k_isl, {"reply": "island answer"})
        removed = inv_cache.invalidate_subject("harbour", "operator")
        self.assertEqual(removed, 2)
        self.assertIsNone(inv_cache.get(k_op))
        self.assertIsNone(inv_cache.get(k_mem2))
        self.assertIsNotNone(inv_cache.get(k_isl))

        # TTL expiration
        time.sleep(0.15)
        self.assertIsNone(inv_cache.get(k_isl))

        st = cache.stats()
        self.assertEqual(st["hits"], 3)
        self.assertEqual(st["tokens_saved"], 450)
        self.assertAlmostEqual(st["estimated_usd_saved"], 0.0075, places=6)
        self.assertEqual(st["max_entries"], 2)

        # Thread-safety smoke check
        conc_cache = BoundedResponseCache(max_entries=32, ttl_seconds=10.0)

        def worker(idx: int):
            k = conc_cache.make_key("harbour", f"u{idx % 5}", "operator", "en", 0, "", f"q{idx % 10}")
            conc_cache.put(k, {"reply": f"ans-{idx}"}, saved_tokens=10, saved_usd=0.0001)
            conc_cache.get(k)

        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(worker, range(80)))
        self.assertLessEqual(conc_cache.stats()["entries"], 32)

    def test_compact_tool_observation_rules_and_bounds(self):
        payload = {
            "id": "SHP-1001",
            "status": "OPEN",
            "warehouse": "HK01",
            "delivery_date": "2026-12-01",
            "sku": "SKU-9",
            "qty": 0,
            "amount": 0.0,
            "approved": False,
            "empty_str": "",
            "none_field": None,
            "empty_list": [],
            "empty_dict": {"nested_empty": None, "blank": ""},
            "rows": [
                {
                    "id": f"ROW-{i}",
                    "status": "PENDING",
                    "proposal_id": f"PROP-{i}",
                    "due": "2026-12-05",
                    "subject": f"Order {i}",
                    "source": "erp",
                    "noise": "verbose-filler-" + ("x" * 180),
                }
                for i in range(30)
            ],
        }
        compacted_str = compact_tool_observation(payload, max_chars=2400)
        self.assertLessEqual(len(compacted_str), 2400)
        parsed = json.loads(compacted_str)
        self.assertEqual(parsed["qty"], 0)
        self.assertEqual(parsed["amount"], 0.0)
        self.assertIs(parsed["approved"], False)
        self.assertNotIn("empty_str", parsed)
        self.assertNotIn("none_field", parsed)
        self.assertNotIn("empty_list", parsed)
        self.assertNotIn("empty_dict", parsed)
        self.assertEqual(parsed["rows"][-1], {"_omitted_items": 30 - (len(parsed["rows"]) - 1)})
        for key in ("id", "status", "warehouse", "delivery_date", "sku", "qty", "amount"):
            self.assertIn(key, parsed)

        # Strict tight budget still yields valid JSON preserving essential keys
        tight = compact_tool_observation(payload, max_chars=420)
        self.assertLessEqual(len(tight), 420)
        tight_parsed = json.loads(tight)
        for key in ("id", "status", "warehouse", "delivery_date", "sku", "qty", "amount"):
            self.assertIn(key, tight_parsed)
        self.assertTrue(all(isinstance(k, str) for k in ESSENTIAL_BUSINESS_KEYS))

    def test_single_query_quota_soft_cap_ddl_skip_and_telemetry_percentiles(self):
        telemetry = RoutingTelemetryStore(self.runtime.workflow)
        quota = QuotaManager(self.runtime.workflow)

        # Record calls across success/failure/failover/cache hits
        latencies = [50.0, 100.0, 200.0, 400.0, 900.0]
        for idx, lat in enumerate(latencies):
            telemetry.record(
                self.operator,
                provider="deepseek" if idx != 4 else "openai",
                model="deepseek-chat" if idx != 4 else "gpt-5.4-mini",
                tier="T1" if idx < 3 else "T3",
                reasoning_effort="none" if idx < 3 else "high",
                prompt_tokens=1000,
                cache_hit_tokens=500 if idx < 4 else 0,
                completion_tokens=100,
                estimated_usd=0.001,
                latency_ms=lat,
                success=(idx != 2),
                error_code=("UPSTREAM_503" if idx == 2 else ("FAILOVER:deepseek/deepseek-chat" if idx == 4 else None)),
            )

        summary = telemetry.summary("harbour", hours=24)
        self.assertEqual(summary["total_calls"], 5)
        self.assertEqual(summary["p50_latency_ms"], 200.0)
        self.assertAlmostEqual(summary["p95_latency_ms"], 800.0, places=2)
        self.assertAlmostEqual(summary["error_rate"], 0.2, places=4)
        self.assertEqual(summary["failover_count"], 1)
        # 4 rows * 500 cache_hit_tokens * (0.27 - 0.07) / 1e6 = 0.0004
        self.assertAlmostEqual(summary["estimated_cache_savings_usd"], 0.0004, places=6)

        # Set policies across tenant, role, and subject so operator hits 85% utilization on subject USD
        # Total operator spend so far = 5 * 0.001 = 0.005 USD; limit = 0.00588 -> 0.8503
        quota.upsert_policy(self.admin, "tenant", "harbour", daily_usd_limit=1.0, daily_token_limit=500_000)
        quota.upsert_policy(self.admin, "role", "operator", daily_usd_limit=1.0, daily_token_limit=500_000)
        quota.upsert_policy(self.admin, "subject", "operator", daily_usd_limit=0.00588, daily_token_limit=500_000)

        # Verify at most 1 telemetry SQL aggregation query and 0 DDL CREATE TABLE calls on hot path
        executed_sql: list[str] = []
        orig_tx = self.runtime.workflow.tx

        from contextlib import contextmanager

        @contextmanager
        def spy_tx(tenant, *, write=True, bounded=False):
            with orig_tx(tenant, write=write, bounded=bounded) as run:
                def wrapped(sql, params=()):
                    executed_sql.append(" ".join(sql.split()))
                    return run(sql, params)
                yield wrapped

        with patch.object(self.runtime.workflow, "tx", side_effect=spy_tx):
            qc = quota.check_quota(self.operator)

        self.assertTrue(qc.allowed)
        self.assertTrue(qc.soft_cap_active)
        self.assertEqual(qc.recommended_max_tier, "T1")
        self.assertGreaterEqual(qc.utilization_ratio, 0.80)
        self.assertLess(qc.utilization_ratio, 1.0)
        ddl_calls = [s for s in executed_sql if s.upper().startswith("CREATE TABLE")]
        agg_calls = [s for s in executed_sql if "FROM AIOS_LLM_TELEMETRY" in s.upper()]
        self.assertEqual(len(ddl_calls), 0)
        self.assertEqual(len(agg_calls), 1)

        # Verify soft-budget auto-downgrade in AssistantAgent: T3 conflict query caps to T1 (effort=none, max_tokens=1200)
        agent = AssistantAgent(self.runtime.workflow, self.governance, self.hub, api_key="sk-soft", model="deepseek-chat")
        self.addCleanup(agent.close)
        captured_opts: list[dict] = []

        def fake_chat_with_raw(messages, **kwargs):
            captured_opts.append({"effort": kwargs.get("effort"), "max_tokens": kwargs.get("max_tokens")})
            from aios_platform.llm_provider import ChatResult, UsageMetrics
            res = ChatResult(
                provider="deepseek",
                model="deepseek-chat",
                text="Short T1 reply under budget.",
                usage=UsageMetrics(prompt_tokens=20, completion_tokens=8, estimated_usd=0.00002),
                latency_ms=25.0,
            )
            return res, {"choices": [{"message": {"content": res.text}}]}

        with patch.object(agent.llm_provider, "chat_with_raw", side_effect=fake_chat_with_raw):
            msg = agent.handle_turn(
                self.operator,
                text="Compare all clauses for contract conflict review in HK01",
                locale="en",
                execute_call=lambda *_a: None,
                preview_approval=lambda *_a: None,
            )
        self.assertIsInstance(msg, AssistantMessage)
        self.assertEqual(captured_opts[0], {"effort": "none", "max_tokens": 1200})

    def test_assistant_l1_cache_memory_invalidation_harness_compaction_and_snapshot(self):
        cache_events: list[tuple[str, str]] = []
        llm_events: list[dict] = []

        class _ObsStub:
            @staticmethod
            def record_cache_metric(*, cache_layer: str, outcome: str):
                cache_events.append((cache_layer, outcome))

            @staticmethod
            def record_llm_metric(**kwargs):
                llm_events.append(kwargs)

        fb = LLMProvider(api_key="sk-fb-test", model="gpt-5.4-mini", max_retries=0)
        primary = LLMProvider(api_key="sk-pri-test", model="deepseek-chat", max_retries=0).with_fallbacks([fb])
        agent = AssistantAgent(
            self.runtime.workflow,
            self.governance,
            self.hub,
            llm_provider=primary,
        )
        self.addCleanup(agent.close)

        llm_calls = {"n": 0}

        def plain_reply(messages, **kwargs):
            llm_calls["n"] += 1
            from aios_platform.llm_provider import ChatResult, UsageMetrics
            res = ChatResult(
                provider="deepseek",
                model="deepseek-chat",
                text=f"SLA answer #{llm_calls['n']}",
                usage=UsageMetrics(
                    prompt_tokens=100,
                    cache_hit_tokens=80,
                    completion_tokens=20,
                    total_tokens=120,
                    estimated_usd=0.0005,
                ),
                latency_ms=42.0,
            )
            return res, {"choices": [{"message": {"content": res.text}}]}

        with patch.dict("sys.modules", {"aios_platform.observability": _ObsStub()}), patch.object(
            agent.llm_provider, "chat_with_raw", side_effect=plain_reply
        ):
            r1 = agent.handle_turn(
                self.operator,
                text="What is our standard SLA?",
                locale="en",
                execute_call=lambda *_a: None,
                preview_approval=lambda *_a: None,
            )
            r2 = agent.handle_turn(
                self.operator,
                text="  What   is our standard SLA? ",
                locale="en",
                execute_call=lambda *_a: None,
                preview_approval=lambda *_a: None,
            )
            # Active document change isolates cache key
            r_doc = agent.handle_turn(
                self.operator,
                text="What is our standard SLA?",
                locale="en",
                active_document=ActiveDocumentInput(doc_id="d1", title="Addendum", content="SLA is 24h"),
                execute_call=lambda *_a: None,
                preview_approval=lambda *_a: None,
            )
            # Memory mutation invalidates L1 cache for operator
            agent.handle_turn(
                self.operator,
                text="/memory add Prefer bullet points",
                locale="en",
                execute_call=lambda *_a: None,
                preview_approval=lambda *_a: None,
            )
            r3 = agent.handle_turn(
                self.operator,
                text="What is our standard SLA?",
                locale="en",
                execute_call=lambda *_a: None,
                preview_approval=lambda *_a: None,
            )

        self.assertEqual(r1.reply, "SLA answer #1")
        self.assertEqual(r2.reply, "SLA answer #1")  # L1 cache hit!
        self.assertEqual(r_doc.reply, "SLA answer #2")
        self.assertEqual(r3.reply, "SLA answer #3")  # Invalidated by /memory add!
        self.assertEqual(llm_calls["n"], 3)
        self.assertIn(("l1", "miss"), cache_events)
        self.assertIn(("l1", "hit"), cache_events)
        self.assertIn(("provider_kv", "hit"), cache_events)
        self.assertEqual(len(llm_events), 3)

        # Verify T0 cache-l1 telemetry row written
        with self.runtime.workflow.tx("harbour", write=False) as run:
            l1_rows = run(
                "SELECT provider, tier, estimated_usd FROM aios_llm_telemetry WHERE tenant = ? AND provider = 'cache-l1'",
                ("harbour",),
            ).fetchall()
        self.assertEqual(len(l1_rows), 1)
        self.assertEqual(l1_rows[0]["tier"], "T0")
        self.assertEqual(float(l1_rows[0]["estimated_usd"]), 0.0)

        # Multi-step T3 harness loop compacts large tool observations via compact_tool_observation
        observed_tool_msgs: list[str] = []

        def harness_calls(messages, **kwargs):
            from aios_platform.llm_provider import ChatResult, NormalizedToolCall, UsageMetrics
            if len(observed_tool_msgs) == 0 and not any(m.get("role") == "tool" for m in messages):
                return (
                    ChatResult(
                        provider="deepseek",
                        model="deepseek-chat",
                        tool_calls=[
                            NormalizedToolCall(
                                id="tc_1",
                                name="shipment_read",
                                arguments={"shipment_id": "SHP-1001", "warehouse": "HK01"},
                                raw_arguments='{"shipment_id":"SHP-1001","warehouse":"HK01"}',
                            )
                        ],
                        usage=UsageMetrics(prompt_tokens=50, completion_tokens=15),
                    ),
                    {},
                )
            for m in messages:
                if m.get("role") == "tool":
                    observed_tool_msgs.append(str(m.get("content") or ""))
            return (
                ChatResult(
                    provider="deepseek",
                    model="deepseek-chat",
                    text="Synthesized SHP-1001 report.",
                    usage=UsageMetrics(prompt_tokens=80, completion_tokens=20),
                ),
                {},
            )

        huge_data = {
            "id": "SHP-1001",
            "status": "OPEN",
            "warehouse": "HK01",
            "empty": "",
            "nothing": None,
            "items": [{"sku": f"S-{i}", "qty": i, "pad": "x" * 200} for i in range(25)],
        }

        def fake_exec(actor_arg, tool_call, key_arg):
            return WorkResult(
                tool=tool_call.tool,
                source="erp",
                data=huge_data,
            )

        with patch.object(agent.llm_provider, "chat_with_raw", side_effect=harness_calls):
            synth = agent.handle_turn(
                self.operator,
                text="Check shipment SHP-1001 and summarize warehouse status across HK01",
                locale="en",
                offered_tools=("shipment.read", "decision.warehouse.summary"),
                execute_call=fake_exec,
                preview_approval=lambda *_a: None,
            )
        self.assertEqual(synth.reply, "Synthesized SHP-1001 report.")
        self.assertEqual(len(observed_tool_msgs), 1)
        self.assertLessEqual(len(observed_tool_msgs[0]), 2400)
        tool_json = json.loads(observed_tool_msgs[0])
        self.assertIn("_omitted_items", json.dumps(tool_json))

        # Tool-calling plain turns are NOT cached in L1
        tool_calls_count = {"n": 0}

        def tool_then_reply(messages, **kwargs):
            tool_calls_count["n"] += 1
            from aios_platform.llm_provider import ChatResult, NormalizedToolCall, UsageMetrics
            if not any(m.get("role") == "tool" for m in messages):
                return (
                    ChatResult(
                        provider="deepseek",
                        model="deepseek-chat",
                        tool_calls=[
                            NormalizedToolCall(
                                id="tc_nocache",
                                name="shipment_read",
                                arguments={"shipment_id": "SHP-1001", "warehouse": "HK01"},
                                raw_arguments='{"shipment_id":"SHP-1001","warehouse":"HK01"}',
                            )
                        ],
                        usage=UsageMetrics(prompt_tokens=30, completion_tokens=10),
                    ),
                    {},
                )
            return (
                ChatResult(
                    provider="deepseek",
                    model="deepseek-chat",
                    text=f"Fresh tool synthesis #{tool_calls_count['n']}",
                    usage=UsageMetrics(prompt_tokens=40, completion_tokens=10),
                ),
                {},
            )

        with patch.object(agent.llm_provider, "chat_with_raw", side_effect=tool_then_reply):
            t_res1 = agent.handle_turn(
                self.operator,
                text="Check shipment SHP-1001 and summarize warehouse status in HK01",
                locale="en",
                offered_tools=("shipment.read", "decision.warehouse.summary"),
                execute_call=fake_exec,
                preview_approval=lambda *_a: None,
            )
            t_res2 = agent.handle_turn(
                self.operator,
                text="Check shipment SHP-1001 and summarize warehouse status in HK01",
                locale="en",
                offered_tools=("shipment.read", "decision.warehouse.summary"),
                execute_call=fake_exec,
                preview_approval=lambda *_a: None,
            )
        self.assertNotEqual(t_res1.reply, t_res2.reply)
        self.assertEqual(tool_calls_count["n"], 4)

        # Verify resilience_snapshot and close()
        snap = agent.resilience_snapshot()
        self.assertTrue(snap["fallback_configured"])
        self.assertIsInstance(snap["provider_circuits"], list)
        self.assertEqual(
            {c["provider"] for c in snap["provider_circuits"]},
            {"deepseek:https://api.deepseek.com", "openai:https://api.openai.com/v1"},
        )
        self.assertIn("hit_ratio", snap["l1_cache"])
        self.assertGreaterEqual(snap["l1_cache"]["hits"], 1)

        # Force client creation then close cleanly
        _ = primary._get_client()
        _ = fb._get_client()
        agent.close()
        self.assertIsNone(primary._client)
        self.assertIsNone(fb._client)

    def test_real_observability_metrics_integration(self):
        from fastapi.testclient import TestClient
        import aios_platform.observability as obs_mod
        from aios_platform.api import build_app
        from aios_platform.providers import DemoPlanner

        prev_bundle = getattr(obs_mod, "_ACTIVE_METRICS", None)

        def restore_bundle():
            with obs_mod._ACTIVE_METRICS_LOCK:
                obs_mod._ACTIVE_METRICS = prev_bundle

        self.addCleanup(restore_bundle)

        agent = AssistantAgent(self.runtime.workflow, self.governance, self.hub, api_key="sk-obs-test", model="deepseek-chat")
        self.addCleanup(agent.close)
        app = build_app(
            self.runtime,
            self.identity,
            DemoPlanner(),
            assistant_agent=agent,
            event_hub=self.hub,
            governance=self.governance,
        )
        metrics_token = "m" * 32
        obs_mod.instrument(app, metrics_token)
        client = TestClient(app, base_url="https://app.example.test")
        self.addCleanup(client.close)

        def ok_chat(messages, **kwargs):
            from aios_platform.llm_provider import ChatResult, UsageMetrics
            return (
                ChatResult(
                    provider="deepseek",
                    model="deepseek-chat",
                    text="Telemetry ok",
                    usage=UsageMetrics(prompt_tokens=100, cache_hit_tokens=60, completion_tokens=15, estimated_usd=0.0002),
                ),
                {},
            )

        with patch.object(agent.llm_provider, "chat_with_raw", side_effect=ok_chat):
            # Miss then hit
            agent.handle_turn(
                self.operator,
                text="Explain warehouse cutoff time",
                locale="en",
                execute_call=lambda *_a: None,
                preview_approval=lambda *_a: None,
            )
            agent.handle_turn(
                self.operator,
                text="Explain warehouse cutoff time",
                locale="en",
                execute_call=lambda *_a: None,
                preview_approval=lambda *_a: None,
            )

        agent.llm_provider.circuit_breaker.record_failure("deepseek:https://api.deepseek.com")

        m_resp = client.get("/metrics", headers={"Authorization": f"Bearer {metrics_token}"})
        self.assertEqual(m_resp.status_code, 200)
        body = m_resp.text
        self.assertIn("aios_llm_calls_total", body)
        self.assertIn("aios_llm_cache_events_total", body)
        self.assertIn("aios_circuit_breaker_state", body)

        health_resp = client.get(
            "/v1/operations/system-health",
            headers={"Authorization": f"Bearer {self.secret}.admin"},
        )
        self.assertEqual(health_resp.status_code, 200)
        health_json = health_resp.json()
        self.assertEqual(health_json["l1_cache"]["hits"], 1)
        self.assertTrue(len(health_json["provider_circuits"]) >= 1)

    def test_concurrent_8_thread_budget_reservation_enforces_hard_cap(self):
        quota = QuotaManager(self.runtime.workflow)
        quota.upsert_policy(self.admin, "tenant", "harbour", daily_usd_limit=0.010, daily_token_limit=100_000)

        # Warm up SQLite schema via single reservation-release cycle? No, let all 8 threads race cold!
        barrier = threading.Barrier(8)
        now_ts = time.time()

        def worker(_idx: int):
            barrier.wait(timeout=5.0)
            return quota.reserve_budget(
                self.operator,
                estimated_micro_usd=3_000,
                estimated_tokens=1_000,
                ttl_s=120.0,
                now=now_ts,
            )

        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(worker, range(8)))

        allowed = [r for r in results if r.allowed]
        denied = [r for r in results if not r.allowed]
        self.assertEqual(len(allowed), 3)
        self.assertEqual(len(denied), 5)
        self.assertTrue(all(r.reservation_id for r in allowed))

        # Settle two of the approved reservations (2,000 each -> 4,000) and release the third -> 6,000 remaining
        quota.settle_budget("harbour", allowed[0].reservation_id, actual_micro_usd=2_000, actual_tokens=600, now=now_ts + 1.0)
        quota.settle_budget("harbour", allowed[1].reservation_id, actual_micro_usd=2_000, actual_tokens=600, now=now_ts + 1.0)
        quota.release_budget("harbour", allowed[2].reservation_id)

        # Second 8-thread concurrent race with 3,000 each -> at most 2 more fit (4,000 + 6,000 = 10,000)
        barrier2 = threading.Barrier(8)

        def worker2(_idx: int):
            barrier2.wait(timeout=5.0)
            res = quota.reserve_budget(
                self.operator,
                estimated_micro_usd=3_000,
                estimated_tokens=1_000,
                ttl_s=120.0,
                now=now_ts + 2.0,
            )
            if res.allowed and res.reservation_id:
                quota.settle_budget("harbour", res.reservation_id, actual_micro_usd=3_000, actual_tokens=1_000, now=now_ts + 3.0)
            return res

        with ThreadPoolExecutor(max_workers=8) as pool:
            results2 = list(pool.map(worker2, range(8)))

        allowed2 = [r for r in results2 if r.allowed]
        self.assertLessEqual(len(allowed2), 2)

        with self.runtime.workflow.tx("harbour", write=False) as run:
            agg = run(
                """SELECT COALESCE(SUM(CASE WHEN status = 'settled' THEN actual_micro_usd ELSE 0 END), 0) AS settled_micro,
                          COALESCE(SUM(CASE WHEN status = 'reserved' THEN reserved_micro_usd ELSE 0 END), 0) AS reserved_micro
                   FROM aios_budget_reservation
                   WHERE tenant = ?""",
                ("harbour",),
            ).fetchone()
        total_micro = int(agg["settled_micro"] or 0) + int(agg["reserved_micro"] or 0)
        self.assertLessEqual(total_micro, 10_000)

        # Expired reservations no longer block fresh capacity
        expired_res = quota.reserve_budget(
            self.operator,
            estimated_micro_usd=500,
            estimated_tokens=100,
            ttl_s=1.0,
            now=now_ts + 10.0,
        )
        self.assertFalse(expired_res.allowed)  # settled spend already at 10,000!

    def test_fail_closed_quota_l1_cache_skips_budget_and_mapreduce_semaphore(self):
        quota = QuotaManager(self.runtime.workflow)
        quota.upsert_policy(self.admin, "subject", "operator", daily_usd_limit=0.50, daily_token_limit=100_000)

        agent = AssistantAgent(self.runtime.workflow, self.governance, self.hub, api_key="sk-fail-closed")
        self.addCleanup(agent.close)
        self.assertEqual(agent.llm_provider.profile.model_id, "deepseek-flash")

        # 1. Fail-closed on DB exception during quota check: zero external LLM call
        with (
            patch.object(agent.quota_manager, "check_quota", side_effect=RuntimeError("DB offline")),
            patch.object(agent.llm_provider, "chat_with_raw", side_effect=AssertionError("Must fail closed without LLM call")),
        ):
            fc_msg = agent.handle_turn(
                self.operator,
                text="Summarize warehouse cutoff rules",
                locale="en",
                execute_call=lambda *_a: None,
                preview_approval=lambda *_a: None,
            )
        self.assertIsInstance(fc_msg, AssistantMessage)
        self.assertEqual(fc_msg.mode, "workflow_guidance")

        # 2. L1 cache hit runs BEFORE take_planner_budget & reserve_budget (planner_limit=1 never exhausts on L1 hits!)
        calls = {"n": 0}

        def fake_chat(messages, **kwargs):
            calls["n"] += 1
            from aios_platform.llm_provider import ChatResult, UsageMetrics
            res = ChatResult(
                provider="deepseek",
                model="deepseek-flash",
                text=f"Cutoff is 17:00 HKT #{calls['n']}",
                usage=UsageMetrics(prompt_tokens=120, completion_tokens=15, estimated_usd=0.0001),
            )
            return res, {"choices": [{"message": {"content": res.text}}]}

        with patch.object(agent.llm_provider, "chat_with_raw", side_effect=fake_chat):
            cold = agent.handle_turn(
                self.operator,
                text="Explain HK01 cutoff time",
                locale="en",
                planner_limit=2,
                execute_call=lambda *_a: None,
                preview_approval=lambda *_a: None,
            )
            # 3 immediate hits with planner_limit=2 in same minute must all hit L1 without 429 or new reservations!
            for _ in range(3):
                hit = agent.handle_turn(
                    self.operator,
                    text="  Explain   HK01 cutoff time ",
                    locale="en",
                    planner_limit=2,
                    execute_call=lambda *_a: None,
                    preview_approval=lambda *_a: None,
                )
                self.assertEqual(hit.reply, cold.reply)

            # Role/grant/warehouse change must miss stale L1 cache immediately
            expanded_grants_actor = self.operator.model_copy(
                update={"grants": frozenset({*self.operator.grants, "finance.read"})}
            )
            miss_grants = agent.handle_turn(
                expanded_grants_actor,
                text="Explain HK01 cutoff time",
                locale="en",
                planner_limit=5,
                execute_call=lambda *_a: None,
                preview_approval=lambda *_a: None,
            )
            self.assertNotEqual(miss_grants.reply, cold.reply)

            expanded_wh_actor = self.operator.model_copy(
                update={"warehouses": frozenset({*self.operator.warehouses, "HK02"})}
            )
            miss_wh = agent.handle_turn(
                expanded_wh_actor,
                text="Explain HK01 cutoff time",
                locale="en",
                planner_limit=5,
                execute_call=lambda *_a: None,
                preview_approval=lambda *_a: None,
            )
            self.assertNotEqual(miss_wh.reply, cold.reply)
            self.assertNotEqual(miss_wh.reply, miss_grants.reply)

        self.assertEqual(calls["n"], 3)
        with self.runtime.workflow.tx("harbour", write=False) as run:
            res_rows = run("SELECT status FROM aios_budget_reservation WHERE tenant = 'harbour'").fetchall()
        # Only the 3 cold LLM turns created budget reservations (0 for the 3 L1 hits!)
        self.assertEqual(len(res_rows), 3)
        self.assertTrue(all(r["status"] == "settled" for r in res_rows))

        # 3. MapReduce per-tenant Semaphore(2) bounds concurrency cleanly and releases unused reservation
        quota.upsert_policy(self.admin, "subject", "operator", daily_usd_limit=1.0, daily_token_limit=500_000)
        sem = agent._get_mapreduce_semaphore("harbour")
        self.assertTrue(sem.acquire(timeout=0.5))
        self.assertTrue(sem.acquire(timeout=0.5))
        try:
            huge_doc = ActiveDocumentInput(doc_id="big-1", title="Big Pack", content=("word " * 160_000))
            with patch.object(agent.mapreduce, "analyze", side_effect=AssertionError("Semaphore full must skip analyze")):
                busy_msg = agent.handle_turn(
                    self.operator,
                    text="Analyze contract clauses",
                    locale="en",
                    active_document=huge_doc,
                    execute_call=lambda *_a: None,
                    preview_approval=lambda *_a: None,
                )
            self.assertEqual(busy_msg.mode, "workflow_guidance")
            self.assertIn("busy", busy_msg.reply.lower())
            with self.runtime.workflow.tx("harbour", write=False) as run:
                released_rows = run(
                    "SELECT status FROM aios_budget_reservation WHERE tenant = 'harbour' AND status = 'released'"
                ).fetchall()
            self.assertEqual(len(released_rows), 1)
        finally:
            sem.release()
            sem.release()


if __name__ == "__main__":
    unittest.main()
