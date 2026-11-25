"""Tests for pure httpx/pydantic multi-provider LLM client, EffortRouter, 4-zone ContextManager, MapReduce, Quota/Telemetry, and Multi-Step Harness."""
from __future__ import annotations

import ast
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import secrets
from tempfile import TemporaryDirectory
import time
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
import httpx

from aios_platform.api import build_app
from aios_platform.assistant_agent import (
    DEFAULT_LLM_MODEL,
    AssistantAgent,
    AssistantMessage,
    PendingWorkSnapshot,
    PolicyRefusal,
    resolve_llm_model,
)
from aios_platform.events import EventHub
from aios_platform.governance import GovernanceService
from aios_platform.identity import DemoIdentity
from aios_platform.llm_provider import (
    MAX_LLM_RESPONSE_BYTES,
    MODEL_PROFILES,
    AnthropicAdapter,
    CircuitOpenError,
    GeminiAdapter,
    LLMProvider,
    LLMProviderError,
    OpenAICompatAdapter,
    ProviderCircuitBreaker,
    resolve_model_profile,
)
from aios_platform.providers import DemoPlanner
from aios_platform.routing_context import (
    ZONE2_COMPACT_TARGET_TOKENS,
    ZONE2_TOOL_OUTPUT_MAX_TOKENS,
    ActiveDocumentInput,
    BudgetReservation,
    ContextManager,
    EffortRouter,
    MapReduceDocumentAnalyzer,
    QuotaManager,
    RoutingTelemetryStore,
    TenantProviderPolicyStore,
    approx_tokens,
)
from aios_platform.service import services

ROOT = Path(__file__).resolve().parents[1]


class _MockHttpResponse:
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


class RoutingProviderContextTests(unittest.TestCase):
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

    def test_zero_litellm_and_model_profile_registry(self):
        # Verify zero litellm imports or dependencies across platform modules and requirements.
        for rel in (
            "requirements-platform.txt",
            "aios_platform/llm_provider.py",
            "aios_platform/routing_context.py",
            "aios_platform/assistant_agent.py",
            "aios_platform/workbench.py",
            "aios_platform/api.py",
        ):
            text = (ROOT / rel).read_text(encoding="utf-8")
            self.assertNotIn("litellm", text.lower(), f"Forbidden litellm reference in {rel}")
            if rel.endswith(".py"):
                tree = ast.parse(text)
                for node in ast.walk(tree):
                    if isinstance(node, ast.Import):
                        for alias in node.names:
                            self.assertFalse(alias.name.startswith("litellm"))
                    elif isinstance(node, ast.ImportFrom) and node.module:
                        self.assertFalse(node.module.startswith("litellm"))

        expected_models = {
            "deepseek-chat",
            "deepseek-flash",
            "deepseek-v4-pro",
            "gpt-5.4-mini",
            "claude-sonnet-4-6",
            "gemini-2.5-pro",
            "qwen-plus",
        }
        self.assertEqual(set(MODEL_PROFILES.keys()), expected_models)
        for model_id, prof in MODEL_PROFILES.items():
            expected_cap = min(180_000, int(prof.surcharge_cliff * 0.90), int(prof.context_window * 0.60))
            self.assertEqual(prof.safe_cap_tokens, expected_cap, model_id)
            self.assertEqual(prof.max_tokens_for_effort("none"), 1200)
            self.assertEqual(prof.max_tokens_for_effort("low"), 2400)
            self.assertEqual(prof.max_tokens_for_effort("medium"), 4096)
            self.assertEqual(prof.max_tokens_for_effort("high"), 8192)
            self.assertEqual(prof.timeout_for_effort("none"), 15.0)
            self.assertEqual(prof.timeout_for_effort("low"), 22.0)
            self.assertEqual(prof.timeout_for_effort("medium"), 35.0)
            self.assertEqual(prof.timeout_for_effort("high"), 55.0)
            self.assertGreater(prof.output_per_1m, 0.0)
            self.assertGreaterEqual(prof.input_per_1m, prof.cached_input_per_1m)

        # External gateway routes even Claude model IDs through OpenAI-compatible adapter.
        gateway_prof = resolve_model_profile("claude-sonnet-4-6", base_url="https://openrouter.ai/api/v1")
        self.assertEqual(gateway_prof.adapter_kind, "openai_compat")
        self.assertEqual(MAX_LLM_RESPONSE_BYTES, 524_288)

    def test_openai_compat_adapter_reasoning_replay_400_fallback_and_cache_parsing(self):
        provider = LLMProvider(
            api_key="sk-test-openai-compat",
            model="deepseek-v4-pro",
            base_url="https://gateway.example.test/v1",
            retry_backoff_base=0.0,
        )
        self.addCleanup(provider.close)
        seen_calls: list[dict] = []

        def fake_stream(_self, method, url, **kwargs):
            seen_calls.append({"method": method, "url": url, "json": dict(kwargs["json"])})
            if len(seen_calls) == 1:
                return _MockHttpResponse({"error": "reasoning_effort unsupported"}, status_code=400)
            return _MockHttpResponse(
                {
                    "model": "deepseek-v4-pro",
                    "choices": [
                        {
                            "finish_reason": "tool_calls",
                            "message": {
                                "role": "assistant",
                                "content": "",
                                "reasoning_content": "Checking HK01 shipment before answering.",
                                "tool_calls": [
                                    {
                                        "id": "call_1",
                                        "type": "function",
                                        "function": {
                                            "name": "shipment_read",
                                            "arguments": '{"shipment_id":"SHP-1001","warehouse":"HK01"}',
                                        },
                                    }
                                ],
                            },
                        }
                    ],
                    "usage": {
                        "prompt_tokens": 1000,
                        "prompt_cache_hit_tokens": 800,
                        "completion_tokens": 120,
                        "completion_tokens_details": {"reasoning_tokens": 45},
                    },
                },
                status_code=200,
            )

        messages = [
            {"role": "system", "content": "Static Zone 1"},
            {
                "role": "assistant",
                "content": "",
                "reasoning_content": "Prior CoT step",
                "tool_calls": [{"id": "call_prev", "type": "function", "function": {"name": "brief_today", "arguments": "{}"}}],
            },
            {"role": "tool", "tool_call_id": "call_prev", "name": "brief_today", "content": '{"ok":true}'},
            {"role": "user", "content": "Check SHP-1001"},
        ]

        with patch("httpx.Client.stream", autospec=True, side_effect=fake_stream):
            res = provider.chat(messages, effort="high")

        self.assertEqual(len(seen_calls), 2)
        self.assertEqual(seen_calls[0]["url"], "https://gateway.example.test/v1/chat/completions")
        self.assertIn("reasoning_effort", seen_calls[0]["json"])
        self.assertNotIn("reasoning_effort", seen_calls[1]["json"])
        # Multi-turn reasoning_content preserved in outgoing payload
        self.assertEqual(seen_calls[1]["json"]["messages"][1]["reasoning_content"], "Prior CoT step")
        self.assertEqual(res.reasoning_content, "Checking HK01 shipment before answering.")
        self.assertEqual(res.usage.cache_hit_tokens, 800)
        self.assertEqual(res.usage.reasoning_tokens, 45)
        self.assertGreater(res.usage.estimated_usd, 0.0)
        self.assertEqual(res.tool_calls[0].name, "shipment_read")

        # OpenAI prompt_tokens_details.cached_tokens format also parsed
        openai_res = OpenAICompatAdapter().parse_response(
            {
                "choices": [{"message": {"role": "assistant", "content": "Done"}}],
                "usage": {
                    "prompt_tokens": 500,
                    "prompt_tokens_details": {"cached_tokens": 400},
                    "completion_tokens": 20,
                },
            },
            MODEL_PROFILES["gpt-5.4-mini"],
        )
        self.assertEqual(openai_res.usage.cache_hit_tokens, 400)

    def test_anthropic_and_gemini_adapters_payloads_and_response_parsing(self):
        # 1. AnthropicAdapter: cache_control ephemeral, output_config.effort, thinking blocks replay, cache_read_input_tokens
        ant = AnthropicAdapter()
        ant_profile = MODEL_PROFILES["claude-sonnet-4-6"]
        ant_messages = [
            {"role": "system", "content": "Immutable policy"},
            {"role": "user", "content": "Check SHP-1001"},
            {
                "role": "assistant",
                "content": "Looking it up.",
                "thinking_blocks": [{"type": "thinking", "thinking": "Need shipment_read", "signature": "sig-1"}],
                "tool_calls": [{"id": "toolu_1", "type": "function", "function": {"name": "shipment_read", "arguments": '{"shipment_id":"SHP-1001","warehouse":"HK01"}'}}],
            },
            {"role": "tool", "tool_call_id": "toolu_1", "name": "shipment_read", "content": '{"status":"OPEN"}'},
        ]
        tools = [
            {
                "type": "function",
                "function": {
                    "name": "shipment_read",
                    "description": "Read shipment",
                    "parameters": {"type": "object", "properties": {"shipment_id": {"type": "string"}}, "additionalProperties": False},
                },
            }
        ]
        ant_payload = ant.build_payload(ant_profile, ant_messages, tools, effort="high", max_tokens=8192, temperature=0.35)
        self.assertNotIn("cache_control", ant_payload["system"][0])
        long_ant_messages = [{"role": "system", "content": "Immutable policy " * 300}, *ant_messages[1:]]
        long_ant_payload = ant.build_payload(ant_profile, long_ant_messages, tools, effort="high", max_tokens=8192, temperature=0.35)
        self.assertEqual(long_ant_payload["system"][0]["cache_control"], {"type": "ephemeral"})
        self.assertEqual(ant_payload["tools"][-1]["cache_control"], {"type": "ephemeral"})
        self.assertEqual(ant_payload["output_config"]["effort"], "high")
        self.assertEqual(ant_payload["thinking"]["type"], "enabled")
        self.assertEqual(ant_payload["messages"][1]["content"][0]["type"], "thinking")
        self.assertEqual(ant_payload["messages"][2]["content"][0]["type"], "tool_result")

        ant_parsed = ant.parse_response(
            {
                "model": "claude-sonnet-4-6",
                "stop_reason": "tool_use",
                "content": [
                    {"type": "thinking", "thinking": "Checking invoice", "signature": "sig-2"},
                    {"type": "text", "text": "Checking now."},
                    {"type": "tool_use", "id": "toolu_2", "name": "shipment_read", "input": {"shipment_id": "SHP-1001"}},
                ],
                "usage": {"input_tokens": 200, "cache_read_input_tokens": 1800, "output_tokens": 90},
            },
            ant_profile,
        )
        self.assertEqual(ant_parsed.usage.cache_hit_tokens, 1800)
        self.assertEqual(ant_parsed.usage.prompt_tokens, 2000)
        self.assertEqual(len(ant_parsed.thinking_blocks), 1)
        self.assertEqual(ant_parsed.tool_calls[0].id, "toolu_2")

        # 2. GeminiAdapter: thinkingConfig, cachedContent hook, usageMetadata.cachedContentTokenCount
        gem = GeminiAdapter()
        gem_profile = MODEL_PROFILES["gemini-2.5-pro"]
        gem_payload = gem.build_payload(
            gem_profile,
            [{"role": "system", "content": "Ignored when cachedContent set"}, {"role": "user", "content": "Analyze"}],
            tools,
            effort="high",
            max_tokens=8192,
            temperature=0.35,
            cached_content="cachedContents/abc123",
        )
        self.assertEqual(gem_payload["cachedContent"], "cachedContents/abc123")
        self.assertNotIn("systemInstruction", gem_payload)
        self.assertEqual(gem_payload["generationConfig"]["thinkingConfig"]["thinkingBudget"], 8192)
        self.assertNotIn("additionalProperties", gem_payload["tools"][0]["functionDeclarations"][0]["parameters"])
        self.assertIn("x-goog-api-key", gem.build_headers("AIza-test"))

        gem_parsed = gem.parse_response(
            {
                "candidates": [
                    {
                        "finishReason": "STOP",
                        "content": {
                            "parts": [
                                {"thought": True, "text": "Comparing clauses"},
                                {"text": "No conflicts found."},
                            ]
                        },
                    }
                ],
                "usageMetadata": {
                    "promptTokenCount": 5000,
                    "cachedContentTokenCount": 4200,
                    "thoughtsTokenCount": 300,
                    "candidatesTokenCount": 150,
                    "totalTokenCount": 5450,
                },
            },
            gem_profile,
        )
        self.assertEqual(gem_parsed.text, "No conflicts found.")
        self.assertEqual(gem_parsed.usage.cache_hit_tokens, 4200)
        self.assertEqual(gem_parsed.usage.reasoning_tokens, 300)
        self.assertEqual(gem_parsed.usage.completion_tokens, 450)

    def test_pooled_client_retries_and_circuit_breaker(self):
        breaker = ProviderCircuitBreaker(failure_threshold=2, recovery_timeout_s=0.15)
        provider = LLMProvider(
            api_key="sk-test-retry",
            model="deepseek-chat",
            circuit_breaker=breaker,
            max_retries=1,
            retry_backoff_base=0.0,
        )
        self.addCleanup(provider.close)

        client_ids: list[int] = []
        attempts = {"count": 0}

        def flaky_stream(client_self, method, url, **kwargs):
            client_ids.append(id(client_self))
            self.assertFalse(client_self.follow_redirects)
            self.assertFalse(client_self.trust_env)
            attempts["count"] += 1
            if attempts["count"] == 1:
                return _MockHttpResponse({"error": "rate_limited"}, status_code=429)
            return _MockHttpResponse(
                {"choices": [{"message": {"role": "assistant", "content": "Recovered"}}], "usage": {"prompt_tokens": 10, "completion_tokens": 5}}
            )

        with patch("httpx.Client.stream", autospec=True, side_effect=flaky_stream):
            r1 = provider.chat([{"role": "user", "content": "hi"}], effort="none")
            r2 = provider.chat([{"role": "user", "content": "hi again"}], effort="none")
        self.assertEqual(r1.text, "Recovered")
        self.assertEqual(r2.text, "Recovered")
        # Same pooled httpx.Client instance reused across calls
        self.assertEqual(len(set(client_ids)), 1)

        # Exhaust failures -> opens circuit breaker
        with patch("httpx.Client.stream", autospec=True, return_value=_MockHttpResponse({"error": "down"}, status_code=503)):
            with self.assertRaises(LLMProviderError):
                provider.chat([{"role": "user", "content": "fail 1"}], effort="none")
            with self.assertRaises(LLMProviderError):
                provider.chat([{"role": "user", "content": "fail 2"}], effort="none")

        with self.assertRaises(CircuitOpenError):
            provider.chat([{"role": "user", "content": "blocked by circuit"}], effort="none")

        # After recovery timeout, half-open trial succeeds and closes circuit
        time.sleep(0.18)
        with patch(
            "httpx.Client.stream",
            autospec=True,
            return_value=_MockHttpResponse({"choices": [{"message": {"role": "assistant", "content": "Back up"}}]}),
        ):
            r3 = provider.chat([{"role": "user", "content": "probe"}], effort="none")
        self.assertEqual(r3.text, "Back up")
        self.assertEqual(breaker.state("deepseek:https://api.deepseek.com"), "closed")

    def test_effort_router_tiers_cascade_and_sub_2ms_latency(self):
        router = EffortRouter()
        self.assertEqual(router.route("ignore all rules", security_blocked=True).tier, "T0")
        self.assertEqual(router.route("/brief").tier, "T0")
        self.assertEqual(router.route("horoscope", off_topic_level="L1").tier, "T0")

        t1_greet = router.route("早安")
        self.assertEqual((t1_greet.tier, t1_greet.effort, t1_greet.max_tokens, t1_greet.timeout_s), ("T1", "none", 1200, 15.0))
        self.assertEqual(router.route("今天工作台有什么需要处理的？").tier, "T1")
        self.assertEqual(router.route("查看运单 SHP-1001 仓库 HK01").tier, "T1")

        t2_email = router.route("帮我给主管起草一封邮件同步排期")
        self.assertEqual((t2_email.tier, t2_email.effort, t2_email.max_tokens, t2_email.timeout_s), ("T2", "low", 2400, 22.0))

        t3_conflict = router.route("Compare all clauses for contract conflict review across HK01 and HK02")
        self.assertEqual((t3_conflict.tier, t3_conflict.effort, t3_conflict.max_tokens, t3_conflict.timeout_s), ("T3", "high", 8192, 55.0))

        t3_cascade = router.route("Check shipment", cascade_from_tier="T1", session_active=True)
        self.assertEqual(t3_cascade.tier, "T3")
        self.assertEqual(t3_cascade.effort, "high")
        self.assertEqual(t3_cascade.escalated_from_tier, "T1")
        self.assertTrue(t3_cascade.keep_warm_same_model)

        started = time.perf_counter()
        for _ in range(100):
            router.route("查看运单 SHP-1001")
            router.route("帮我起草邮件给财务汇总发票情况")
            router.route("请核查这份长期协议是否存在条款冲突并汇总风险")
        avg_ms = ((time.perf_counter() - started) * 1000.0) / 300.0
        self.assertLess(avg_ms, 2.0)

    def test_zone1_invariance_and_four_zone_compaction_and_doc_slot(self):
        agent = AssistantAgent(
            self.runtime.workflow,
            self.governance,
            self.hub,
            api_key="sk-test-key",
            model="gemini-2.5-pro",
            demo=True,
        )
        ctx = ContextManager(self.runtime.workflow)
        profile = MODEL_PROFILES["gemini-2.5-pro"]

        # 1. Zone 1 byte-identical invariance across changing pulse_summary
        sys_a, _ = agent._compile_system_prompt(self.manager, PendingWorkSnapshot(pending_approvals=0), "en")
        sys_b, _ = agent._compile_system_prompt(
            self.manager,
            PendingWorkSnapshot(pending_approvals=5, pending_approval_ids=["p1", "p2"], meetings_today=3, unread_notices=9),
            "en",
        )
        self.assertEqual(sys_a, sys_b)
        tools_sorted = agent._openai_tool_schemas(self.manager, ("shipment.read", "decision.warehouse.summary"))
        names = [t["function"]["name"] for t in tools_sorted]
        self.assertEqual(names, sorted(names))

        pulse_a = agent._compile_pulse_summary(self.manager, PendingWorkSnapshot(pending_approvals=0))
        pulse_b = agent._compile_pulse_summary(self.manager, PendingWorkSnapshot(pending_approvals=5))
        asm_a = ctx.assemble(
            self.manager,
            session_id="sess-inv",
            system_prompt=sys_a,
            tool_schemas=tools_sorted,
            history_turns=[],
            user_text="Hello",
            pulse_summary=pulse_a,
            profile=profile,
        )
        asm_b = ctx.assemble(
            self.manager,
            session_id="sess-inv",
            system_prompt=sys_b,
            tool_schemas=tools_sorted,
            history_turns=[],
            user_text="Hello",
            pulse_summary=pulse_b,
            profile=profile,
        )
        self.assertEqual(asm_a.messages[0]["content"], asm_b.messages[0]["content"])
        self.assertNotEqual(asm_a.messages[-1]["content"], asm_b.messages[-1]["content"])
        self.assertIn("Pending approvals awaiting this user's decision: 5", asm_b.messages[-1]["content"])

        # 2. Zone 1.5 mount/auto-unmount with <=2000-token structured review summary
        doc_a = ActiveDocumentInput(
            doc_id="doc-a",
            title="Supplier Master Agreement",
            content="\n".join(
                [f"Page {i} Clause {i}.1: Delivery window is {10 + i} days for HK01." for i in range(1, 200)]
            ),
        )
        doc_b = ActiveDocumentInput(
            doc_id="doc-b",
            title="Updated Addendum",
            content="Page 1 Clause 1.1: Liability cap adjusted to 500,000 HKD.",
        )
        m1 = ctx.mount_document(
            self.manager, "sess-doc", doc_id=doc_a.doc_id, title=doc_a.title, content=doc_a.content, profile=profile
        )
        self.assertEqual(m1["slot_budget"], 140_000)
        self.assertFalse(m1["requires_mapreduce"])

        m2 = ctx.mount_document(
            self.manager, "sess-doc", doc_id=doc_b.doc_id, title=doc_b.title, content=doc_b.content, profile=profile
        )
        self.assertIsNotNone(m2["unmounted_doc_summary"])
        self.assertLessEqual(approx_tokens(m2["unmounted_doc_summary"]), 2000)
        self.assertIn("Clause", m2["unmounted_doc_summary"])

        unmounted = ctx.unmount_document(self.manager, "sess-doc")
        self.assertIsNotNone(unmounted)
        state = ctx.get_session_state(self.manager, "sess-doc")
        self.assertIsNone(state["active_doc_id"])
        self.assertEqual(state["active_doc_tokens"], 0)
        self.assertLessEqual(approx_tokens(state["active_doc_summary"]), 2000)

        # 3. Zone 2 tool output clamping <= 1500 tokens & stepped compaction (>= 28K -> 6K-8K)
        huge_tool = "word " * 4000  # ~4000 tokens
        clamped = ctx.clamp_tool_output(huge_tool)
        self.assertLessEqual(approx_tokens(clamped), ZONE2_TOOL_OUTPUT_MAX_TOKENS)

        big_turns = [
            {"role": "user" if i % 2 == 0 else "assistant", "content": f"Turn {i}: " + ("clause detail " * 500)}
            for i in range(32)
        ]
        asm_compact = ctx.assemble(
            self.manager,
            session_id="sess-compact",
            system_prompt=sys_a,
            tool_schemas=tools_sorted,
            history_turns=big_turns,
            user_text="Summarize open issues",
            pulse_summary=pulse_a,
            profile=profile,
            now=10_000.0,
        )
        self.assertTrue(asm_compact.compacted)
        self.assertLessEqual(asm_compact.zone2_tokens, 8000)
        self.assertGreater(len(asm_compact.messages), 6)

        # >60m idle cold-cache compaction
        asm_idle = ctx.assemble(
            self.manager,
            session_id="sess-compact",
            system_prompt=sys_a,
            tool_schemas=tools_sorted,
            history_turns=[{"role": "user" if i % 2 == 0 else "assistant", "content": f"msg {i}"} for i in range(10)],
            user_text="Back after lunch",
            pulse_summary=pulse_a,
            profile=profile,
            now=10_000.0 + 3700.0,
        )
        self.assertTrue(asm_idle.idle_compacted)
        idle_state = ctx.get_session_state(self.manager, "sess-compact")
        self.assertIsNotNone(idle_state["compacted_at"])

    def test_mapreduce_over_140k_doc_pack(self):
        # Construct a >145K-token multi-section document pack.
        section_text = ("This clause specifies HK01 customs clearance SLA of 48 hours and demurrage liability. " * 220)
        large_doc = "\n\n".join(f"# Section {i}: Schedule {i}\nClause {i}.1: {section_text}" for i in range(1, 42))
        self.assertGreater(approx_tokens(large_doc), 140_000)

        analyzer = MapReduceDocumentAnalyzer(max_workers=4)
        chunks = analyzer.split_sections(large_doc)
        self.assertGreaterEqual(len(chunks), 6)
        for chunk in chunks:
            self.assertLessEqual(chunk.tokens, 24_000)

        map_calls: list[int] = []

        def fake_map(chunk):
            map_calls.append(chunk.index)
            from aios_platform.llm_provider import ChatResult, UsageMetrics

            return ChatResult(
                provider="deepseek",
                model="deepseek-chat",
                text=f"- Clause {chunk.index + 1}.1 SLA=48h",
                usage=UsageMetrics(prompt_tokens=chunk.tokens, completion_tokens=30, estimated_usd=0.002),
            )

        def fake_reduce(combined):
            from aios_platform.llm_provider import ChatResult, UsageMetrics

            self.assertLessEqual(approx_tokens(combined), 80_000)
            return ChatResult(
                provider="deepseek",
                model="deepseek-chat",
                text="Conflict summary: Clause 1.1 matches Schedule 41.",
                usage=UsageMetrics(prompt_tokens=approx_tokens(combined), completion_tokens=80, estimated_usd=0.01),
            )

        result = analyzer.analyze(large_doc, question="Check conflicts", map_caller=fake_map, reduce_caller=fake_reduce)
        self.assertEqual(result.chunk_count, len(chunks))
        self.assertEqual(sorted(map_calls), list(range(len(chunks))))
        self.assertIn("Conflict summary", result.summary)
        self.assertGreater(result.usage.estimated_usd, 0.01)

    def test_quota_telemetry_multistep_harness_offtopic_and_api_turns(self):
        telemetry = RoutingTelemetryStore(self.runtime.workflow)
        quota = QuotaManager(self.runtime.workflow)

        telemetry.record(
            self.operator,
            provider="deepseek",
            model="deepseek-chat",
            tier="T1",
            reasoning_effort="none",
            prompt_tokens=1000,
            cache_hit_tokens=800,
            completion_tokens=100,
            estimated_usd=0.0005,
            latency_ms=120.0,
        )
        telemetry.record(
            self.manager,
            provider="anthropic",
            model="claude-sonnet-4-6",
            tier="T3",
            reasoning_effort="high",
            prompt_tokens=2000,
            cache_hit_tokens=1000,
            reasoning_tokens=300,
            completion_tokens=400,
            estimated_usd=0.015,
            latency_ms=880.0,
            escalated_from_tier="T2",
        )
        summary = telemetry.summary("harbour", hours=24)
        self.assertEqual(summary["window_hours"], 24)
        self.assertEqual(summary["total_calls"], 2)
        self.assertAlmostEqual(summary["cache_hit_ratio"], 0.6, places=4)
        self.assertEqual(summary["by_tier"]["T1"], 1)
        self.assertEqual(summary["by_tier"]["T3"], 1)
        self.assertIn("deepseek", summary["by_provider"])
        self.assertIn("operator", summary["by_subject"])

        # Quota policy blocks further LLM calls when exceeded
        saved_pol = quota.upsert_policy(self.admin, "subject", "operator", daily_usd_limit=0.0001, daily_token_limit=5000)
        self.assertEqual(saved_pol["scope_key"], "operator")
        self.assertEqual(len(quota.list_policies("harbour")), 1)
        check = quota.check_quota(self.operator)
        self.assertFalse(check.allowed)
        self.assertEqual(check.limit_kind, "usd")

        agent = AssistantAgent(
            self.runtime.workflow,
            self.governance,
            self.hub,
            api_key="sk-test-harness",
            model="deepseek-chat",
            demo=True,
        )
        app = build_app(
            self.runtime,
            self.identity,
            DemoPlanner(),
            assistant_agent=agent,
            event_hub=self.hub,
            governance=self.governance,
        )
        client = TestClient(app, base_url="https://app.example.test")
        self.addCleanup(client.close)
        headers_op = {"Authorization": f"Bearer {self.secret}.operator"}
        headers_mgr = {"Authorization": f"Bearer {self.secret}.manager"}

        # Quota reached -> zero LLM call, clean workflow_guidance response
        with patch.object(agent, "_invoke_deepseek", side_effect=AssertionError("Quota exceeded must not call LLM")):
            q_resp = client.post("/v1/workbench/turns", headers=headers_op, json={"text": "Hi there", "locale": "en"})
        self.assertEqual(q_resp.status_code, 200)
        self.assertEqual(q_resp.json()["mode"], "workflow_guidance")
        self.assertIn("quota", q_resp.json()["reply"].lower())

        # Raise operator quota so harness tests can run
        quota.upsert_policy(self.admin, "subject", "operator", daily_usd_limit=10.0, daily_token_limit=1_000_000)

        # Off-topic L1 (gentle colleague nudge) & L2 (local automation refusal) at T0 without LLM
        with patch.object(agent, "_invoke_deepseek", side_effect=AssertionError("Off-topic must be T0 zero-LLM")):
            l1 = client.post("/v1/workbench/turns", headers=headers_op, json={"text": "Write me a love letter", "locale": "en"})
            self.assertEqual(l1.status_code, 200)
            self.assertEqual(l1.json()["kind"], "message")
            self.assertEqual(l1.json()["mode"], "chat")

            l2 = client.post(
                "/v1/workbench/turns",
                headers=headers_op,
                json={"text": "Automate a game bot to farm coins on Steam", "locale": "en"},
            )
            self.assertEqual(l2.status_code, 200)
            self.assertEqual(l2.json()["kind"], "refusal")
            self.assertEqual(l2.json()["decision"], "denied")

        # Cascade Escalation: Step 1 malformed JSON args at T1 -> escalates T1 -> T3 -> Step 2 valid read
        cascade_calls: list[dict] = []

        def cascade_llm(actor_arg, messages, tools):
            cascade_calls.append({"n": len(messages)})
            if len(cascade_calls) == 1:
                return {
                    "choices": [
                        {
                            "message": {
                                "role": "assistant",
                                "tool_calls": [
                                    {"id": "c_bad", "type": "function", "function": {"name": "shipment_read", "arguments": "{bad json"}}
                                ],
                            }
                        }
                    ],
                    "usage": {"prompt_tokens": 90, "completion_tokens": 15},
                }
            return {
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "tool_calls": [
                                {
                                    "id": "c_ok",
                                    "type": "function",
                                    "function": {
                                        "name": "shipment_read",
                                        "arguments": json.dumps({"shipment_id": "SHP-1001", "warehouse": "HK01"}),
                                    },
                                }
                            ],
                        }
                    }
                ],
                "usage": {"prompt_tokens": 140, "completion_tokens": 25},
            }

        with patch.object(agent, "_invoke_deepseek", side_effect=cascade_llm):
            casc_resp = client.post(
                "/v1/workbench/turns",
                headers=headers_op,
                json={"text": "Look up shipment in HK01", "locale": "en"},
            )
        self.assertEqual(casc_resp.status_code, 200, casc_resp.text)
        self.assertEqual(casc_resp.json()["kind"], "result")
        self.assertEqual(casc_resp.json()["data"]["shipment_id"], "SHP-1001")
        self.assertEqual(len(cascade_calls), 2)

        # Verify telemetry recorded cascade escalation from T1 -> T3
        with self.runtime.workflow.tx("harbour", write=False) as run:
            escalated_rows = run(
                "SELECT tier, escalated_from_tier FROM aios_llm_telemetry WHERE tenant = ? AND escalated_from_tier IS NOT NULL",
                ("harbour",),
            ).fetchall()
        self.assertGreaterEqual(len(escalated_rows), 1)
        self.assertEqual(escalated_rows[-1]["escalated_from_tier"], "T1")
        self.assertEqual(escalated_rows[-1]["tier"], "T3")

        # Multi-Step Harness (Plan-Act-Observe -> HITL email_draft stop + bounded MAX_HARNESS_STEPS = 4)
        calls_seen: list[dict] = []

        def harness_llm(actor_arg, messages, tools):
            calls_seen.append({"n": len(messages), "last": messages[-1]})
            if len(calls_seen) == 1:
                return {
                    "choices": [
                        {
                            "message": {
                                "role": "assistant",
                                "tool_calls": [
                                    {
                                        "id": "c2",
                                        "type": "function",
                                        "function": {
                                            "name": "shipment_read",
                                            "arguments": json.dumps({"shipment_id": "SHP-1001", "warehouse": "HK01"}),
                                        },
                                    }
                                ],
                            }
                        }
                    ],
                    "usage": {"prompt_tokens": 200, "completion_tokens": 30},
                }
            return {
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "tool_calls": [
                                {
                                    "id": "c3",
                                    "type": "function",
                                    "function": {
                                        "name": "email_compose_draft",
                                        "arguments": json.dumps(
                                            {
                                                "recipients": ["manager"],
                                                "cc": [],
                                                "subject": "SHP-1001 Status",
                                                "body": "SHP-1001 is OPEN in HK01.",
                                            }
                                        ),
                                    },
                                }
                            ],
                        }
                    }
                ],
                "usage": {"prompt_tokens": 260, "completion_tokens": 40},
            }

        with patch.object(agent, "_invoke_deepseek", side_effect=harness_llm):
            multi_resp = client.post(
                "/v1/workbench/turns",
                headers=headers_op,
                json={
                    "text": "Check shipment SHP-1001 in HK01 and then draft an email to manager with status",
                    "locale": "en",
                    "session_id": "sess-harness",
                    "conversation_context": [{"role": "user", "text": f"turn {i}"} for i in range(12)],
                    "active_document": {
                        "doc_id": "doc-sop",
                        "title": "SOP",
                        "content": "Clause 1: Notify manager on OPEN HK01 shipments.",
                    },
                },
            )
        self.assertEqual(multi_resp.status_code, 200, multi_resp.text)
        self.assertEqual(multi_resp.json()["kind"], "message")
        self.assertEqual(multi_resp.json()["mode"], "email_draft")
        self.assertEqual(len(calls_seen), 2)

        # Bounded MAX_HARNESS_STEPS = 4: looping tool calls cannot exceed 4 steps
        loop_count = {"n": 0}

        def looping_llm(actor_arg, messages, tools):
            loop_count["n"] += 1
            return {
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "tool_calls": [
                                {
                                    "id": f"loop_{loop_count['n']}",
                                    "type": "function",
                                    "function": {
                                        "name": "shipment_read",
                                        "arguments": json.dumps({"shipment_id": "SHP-1001", "warehouse": "HK01"}),
                                    },
                                },
                                {
                                    "id": f"loop_b_{loop_count['n']}",
                                    "type": "function",
                                    "function": {
                                        "name": "shipment_read",
                                        "arguments": json.dumps({"shipment_id": "SHP-1001", "warehouse": "HK01"}),
                                    },
                                },
                            ],
                        }
                    }
                ]
            }

        with patch.object(agent, "_invoke_deepseek", side_effect=looping_llm):
            bounded_resp = client.post(
                "/v1/workbench/turns",
                headers=headers_op,
                json={"text": "Check shipment SHP-1001 and compare with email draft", "locale": "en"},
            )
        self.assertEqual(bounded_resp.status_code, 200)
        self.assertEqual(loop_count["n"], 4)

        # Turn.conversation_context allows 40 turns and rejects 41 turns with 422
        with patch.object(agent, "_invoke_deepseek", return_value={"choices": [{"message": {"content": "OK"}}]}):
            ok_40 = client.post(
                "/v1/workbench/turns",
                headers=headers_mgr,
                json={
                    "text": "Hello",
                    "conversation_context": [{"role": "user", "text": f"m{i}"} for i in range(40)],
                },
            )
            self.assertEqual(ok_40.status_code, 200, ok_40.text)
            bad_41 = client.post(
                "/v1/workbench/turns",
                headers=headers_mgr,
                json={
                    "text": "Hello",
                    "conversation_context": [{"role": "user", "text": f"m{i}"} for i in range(41)],
                },
            )
            self.assertEqual(bad_41.status_code, 422)

    def test_deepseek_flash_default_2026_pricing_peak_offpeak_and_override(self):
        self.assertEqual(DEFAULT_LLM_MODEL, "deepseek-flash")
        self.assertTrue(MODEL_PROFILES["deepseek-chat"].deprecated)
        self.assertFalse(MODEL_PROFILES["deepseek-flash"].deprecated)
        self.assertEqual(MODEL_PROFILES["deepseek-flash"].context_window, 1_000_000)
        self.assertEqual(MODEL_PROFILES["deepseek-flash"].surcharge_cliff, 200_000)
        self.assertEqual(MODEL_PROFILES["deepseek-flash"].region, "cn-hk")
        self.assertEqual(MODEL_PROFILES["deepseek-v4-pro"].context_window, 1_000_000)
        self.assertEqual(MODEL_PROFILES["deepseek-v4-pro"].surcharge_cliff, 200_000)
        self.assertEqual(MODEL_PROFILES["deepseek-v4-pro"].region, "cn-hk")

        default_provider = LLMProvider(api_key="sk-def")
        self.addCleanup(default_provider.close)
        self.assertEqual(default_provider.profile.model_id, "deepseek-flash")
        self.assertEqual(resolve_model_profile("").model_id, "deepseek-flash")
        with patch.dict(os.environ, {"AIOS_LLM_MODEL": ""}, clear=False):
            self.assertEqual(resolve_llm_model(), "deepseek-flash")

        # Peak (Wed 02:00 UTC & 07:30 UTC) vs Off-Peak (Wed 04:30 UTC & Sat 02:00 UTC)
        peak_am = datetime(2026, 11, 25, 2, 0, tzinfo=timezone.utc)
        peak_pm = datetime(2026, 11, 25, 7, 30, tzinfo=timezone.utc)
        off_mid = datetime(2026, 11, 25, 4, 30, tzinfo=timezone.utc)
        off_wknd = datetime(2026, 11, 28, 2, 0, tzinfo=timezone.utc)

        flash = MODEL_PROFILES["deepseek-flash"]
        # 1M uncached input ($0.30) + 1M cached ($0.006) + 1M output ($1.20) = $1.506 = 1,506,000 micro_usd
        self.assertEqual(
            flash.estimate_cost_micro_usd(prompt_tokens=2_000_000, cache_hit_tokens=1_000_000, completion_tokens=1_000_000, now=peak_am),
            1_506_000,
        )
        self.assertEqual(
            flash.estimate_cost_micro_usd(prompt_tokens=2_000_000, cache_hit_tokens=1_000_000, completion_tokens=1_000_000, now=peak_pm),
            1_506_000,
        )
        # Off-Peak 50% discount: $0.15 + $0.003 + $0.60 = $0.753 = 753,000 micro_usd
        self.assertEqual(
            flash.estimate_cost_micro_usd(prompt_tokens=2_000_000, cache_hit_tokens=1_000_000, completion_tokens=1_000_000, now=off_mid),
            753_000,
        )
        self.assertEqual(
            flash.estimate_cost_micro_usd(prompt_tokens=2_000_000, cache_hit_tokens=1_000_000, completion_tokens=1_000_000, now=off_wknd),
            753_000,
        )

        pro = MODEL_PROFILES["deepseek-v4-pro"]
        # Peak: $1.32 + $0.044 + $3.96 = 5,324,000 micro_usd; Off-Peak: 2,662,000 micro_usd
        self.assertEqual(
            pro.estimate_cost_micro_usd(prompt_tokens=2_000_000, cache_hit_tokens=1_000_000, completion_tokens=1_000_000, now=peak_am),
            5_324_000,
        )
        self.assertEqual(
            pro.estimate_cost_micro_usd(prompt_tokens=2_000_000, cache_hit_tokens=1_000_000, completion_tokens=1_000_000, now=off_mid),
            2_662_000,
        )

        # AIOS_MODEL_PRICING_JSON override dynamically updates rates
        override_json = json.dumps(
            {
                "deepseek-flash": {
                    "input_per_1m": 0.40,
                    "cached_input_per_1m": 0.01,
                    "output_per_1m": 1.60,
                    "off_peak_input_per_1m": 0.20,
                    "off_peak_cached_input_per_1m": 0.005,
                    "off_peak_output_per_1m": 0.80,
                }
            }
        )
        with patch.dict(os.environ, {"AIOS_MODEL_PRICING_JSON": override_json}, clear=False):
            ov_prof = resolve_model_profile("deepseek-flash")
            self.assertEqual(ov_prof.input_per_1m, 0.40)
            self.assertEqual(
                flash.estimate_cost_micro_usd(prompt_tokens=1_000_000, cache_hit_tokens=0, completion_tokens=1_000_000, now=peak_am),
                2_000_000,
            )
            self.assertEqual(
                flash.estimate_cost_micro_usd(prompt_tokens=1_000_000, cache_hit_tokens=0, completion_tokens=1_000_000, now=off_mid),
                1_000_000,
            )

    def test_tenant_provider_policy_failover_block_pro_model_and_turn_deadline(self):
        policy_store = TenantProviderPolicyStore(self.runtime.workflow)
        defaults = policy_store.get_policy("harbour")
        self.assertTrue(defaults["allow_failover"])
        self.assertEqual(defaults["max_tier"], "T3")
        self.assertIn("restricted_pii", defaults["blocked_data_classes"])

        with self.assertRaises(ValueError):
            policy_store.upsert_policy(self.admin, allowed_providers=[])
        with self.assertRaises(ValueError):
            policy_store.upsert_policy(self.admin, max_tier="T9")

        # Restrict residency to cn-hk (allows deepseek-flash, blocks failover to US gpt-5.4-mini)
        policy_store.upsert_policy(
            self.admin,
            allowed_providers=["deepseek", "openai"],
            allowed_regions=["cn-hk"],
            allow_failover=True,
        )
        self.assertTrue(policy_store.is_provider_allowed("harbour", MODEL_PROFILES["deepseek-flash"], is_failover=False))
        self.assertFalse(policy_store.is_provider_allowed("harbour", MODEL_PROFILES["gpt-5.4-mini"], is_failover=True))
        self.assertFalse(
            policy_store.is_provider_allowed("harbour", MODEL_PROFILES["deepseek-flash"], data_class="restricted_pii")
        )

        fb = LLMProvider(api_key="sk-fb-us", model="gpt-5.4-mini", max_retries=0)
        primary = LLMProvider(api_key="sk-pri-hk", model="deepseek-flash", max_retries=0, retry_backoff_base=0.0).with_fallbacks([fb])
        self.addCleanup(primary.close)

        urls_hit: list[str] = []

        def fake_stream(_self, _method, url, **kwargs):
            urls_hit.append(url)
            return _MockHttpResponse({"error": "upstream unavailable"}, status_code=503)

        with patch("httpx.Client.stream", autospec=True, side_effect=fake_stream):
            with self.assertRaises(LLMProviderError) as ctx:
                primary.chat_with_raw(
                    [{"role": "user", "content": "Check status"}],
                    provider_policy_check=lambda prof, is_fb: policy_store.is_provider_allowed("harbour", prof, is_failover=is_fb),
                )
        self.assertEqual(ctx.exception.error_code, "PROVIDER_POLICY_DENIED")
        self.assertEqual(ctx.exception.status_code, 403)
        self.assertEqual(urls_hit, ["https://api.deepseek.com/chat/completions"])

        # Also test allow_failover=False blocking even cn-hk fallback
        policy_store.upsert_policy(self.admin, allowed_regions=["cn-hk", "us"], allow_failover=False)
        self.assertFalse(policy_store.is_provider_allowed("harbour", MODEL_PROFILES["gpt-5.4-mini"], is_failover=True))
        policy_store.upsert_policy(self.admin, allowed_regions=["global", "cn-hk", "ap-east-1", "us"], allow_failover=True)

        # Optional AIOS_LLM_PRO_MODEL routes T3 to deepseek-v4-pro while T1 uses deepseek-flash
        seen_models: list[str] = []

        def model_capture_stream(_self, _method, _url, **kwargs):
            seen_models.append(str(kwargs["json"]["model"]))
            return _MockHttpResponse({"choices": [{"message": {"role": "assistant", "content": "Pro reply"}}]})

        with patch.dict(os.environ, {"AIOS_LLM_PRO_MODEL": "deepseek-v4-pro"}, clear=False):
            pro_agent = AssistantAgent(self.runtime.workflow, self.governance, self.hub, api_key="sk-pro-test")
            self.addCleanup(pro_agent.close)
            with patch("aios_platform.llm_provider.httpx.Client.stream", autospec=True, side_effect=model_capture_stream):
                pro_agent.handle_turn(
                    self.operator,
                    text="早安",
                    locale="zh-CN",
                    execute_call=lambda *_a: None,
                    preview_approval=lambda *_a: None,
                )
                pro_agent.handle_turn(
                    self.operator,
                    text="Compare all clauses for contract conflict review in HK01",
                    locale="en",
                    execute_call=lambda *_a: None,
                    preview_approval=lambda *_a: None,
                )
        self.assertEqual(seen_models, ["deepseek-flash", "deepseek-v4-pro"])

        # Turn deadline ceiling halts tool loop cleanly once AIOS_TURN_DEADLINE_SECONDS elapses
        dl_agent = AssistantAgent(self.runtime.workflow, self.governance, self.hub, api_key="sk-dl-test")
        self.addCleanup(dl_agent.close)
        dl_calls = {"n": 0}

        def slow_tool_chat(messages, **kwargs):
            dl_calls["n"] += 1
            time.sleep(0.18)
            from aios_platform.llm_provider import ChatResult, NormalizedToolCall, UsageMetrics
            return (
                ChatResult(
                    provider="deepseek",
                    model="deepseek-flash",
                    tool_calls=[
                        NormalizedToolCall(
                            id=f"tc_dl_{dl_calls['n']}",
                            name="shipment_read",
                            arguments={"shipment_id": "SHP-1001", "warehouse": "HK01"},
                            raw_arguments='{"shipment_id":"SHP-1001","warehouse":"HK01"}',
                        )
                    ],
                    usage=UsageMetrics(prompt_tokens=30, completion_tokens=10),
                ),
                {},
            )

        with patch.dict(os.environ, {"AIOS_TURN_DEADLINE_SECONDS": "0.12"}, clear=False), patch.object(
            dl_agent.llm_provider, "chat_with_raw", side_effect=slow_tool_chat
        ):
            dl_resp = dl_agent.handle_turn(
                self.operator,
                text="Check shipment SHP-1001 in HK01 and then compare all email drafts",
                locale="en",
                offered_tools=("shipment.read", "decision.warehouse.summary"),
                execute_call=lambda *_a: {"ok": True},
                preview_approval=lambda *_a: None,
            )
        self.assertIsInstance(dl_resp, AssistantMessage)
        self.assertEqual(dl_calls["n"], 1)
        with self.runtime.workflow.tx("harbour", write=False) as run:
            dl_errs = run(
                "SELECT error_code FROM aios_llm_telemetry WHERE tenant = 'harbour' AND error_code = 'TURN_DEADLINE_EXCEEDED'"
            ).fetchall()
        self.assertEqual(len(dl_errs), 1)
        _ = BudgetReservation(
            tenant="harbour",
            id="br-1",
            subject="operator",
            role="operator",
            day_key="2026-11-25",
            reserved_micro_usd=100,
            expires_at=time.time() + 60,
            created_at=time.time(),
        )


if __name__ == "__main__":
    unittest.main()
