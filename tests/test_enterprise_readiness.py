"""Regression tests for the deterministic Enterprise Readiness Evaluation Harness."""
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.enterprise_eval import main as eval_main, run_enterprise_eval


class EnterpriseReadinessTests(unittest.TestCase):
    """Verify all 7 enterprise readiness gates and CLI modes cleanly."""

    @classmethod
    def setUpClass(cls):
        cls.report = run_enterprise_eval()

    def test_overall_eval_passes_without_api_keys_or_litellm(self):
        self.assertTrue(self.report["all_passed"], self.report)
        self.assertTrue(self.report["zero_api_keys_required"])
        self.assertTrue(self.report["litellm_absent"])
        self.assertEqual(self.report["gates_passed"], 7)
        self.assertEqual(self.report["gates_total"], 7)
        self.assertNotIn("litellm", sys.modules)

    def test_gate1_security_seal_and_antipoisoning_recall(self):
        g1 = self.report["gates"]["security_seal_antipoisoning"]
        self.assertTrue(g1["passed"], g1)
        self.assertEqual(g1["block_recall"], 1.0)
        self.assertEqual(g1["missed_attacks"], 0)
        self.assertGreaterEqual(g1["total_attacks"], 40)
        self.assertEqual(g1["blocked_attacks"], g1["total_attacks"])
        self.assertTrue(g1["memory_persisted_empty"])
        self.assertTrue(g1["policy_immutable_enforced"])
        self.assertEqual(g1["false_positives"], 0)

    def test_gate2_kv_cache_zone1_prefix_byte_invariance(self):
        g2 = self.report["gates"]["kv_cache_zone1_invariance"]
        self.assertTrue(g2["passed"], g2)
        self.assertTrue(g2["zone1_sha256_invariant"])
        self.assertEqual(g2["prefix_mismatch_count"], 0)
        self.assertEqual(g2["tool_schema_mismatch_count"], 0)
        self.assertTrue(g2["cross_subject_same_role_sha256_match"])
        self.assertTrue(g2["zone1_2_ordering_ok"])
        self.assertTrue(g2["zone1_5_unmount_summary_ok"])
        self.assertGreaterEqual(g2["tenants_tested"], 2)
        self.assertGreaterEqual(g2["roles_tested"], 4)
        self.assertGreaterEqual(g2["assemblies_tested"], 60)

    def test_gate3_finops_cost_and_token_savings(self):
        g3 = self.report["gates"]["finops_cost_and_token_savings"]
        self.assertTrue(g3["passed"], g3)

        l1 = g3["l1_cache"]
        self.assertEqual(l1["marginal_usd_reduction_pct"], 100.0)
        self.assertGreater(l1["estimated_usd_saved"], 0.0)
        self.assertGreater(l1["tokens_saved"], 0)
        self.assertLess(l1["hit_latency_ms"], l1["cold_latency_ms"])

        comp = g3["compaction"]
        self.assertTrue(comp["business_keys_preserved"])
        self.assertGreaterEqual(comp["char_reduction_pct"], 50.0)
        self.assertGreaterEqual(comp["token_reduction_pct"], 50.0)

        sb = g3["soft_budget"]
        self.assertTrue(sb["soft_cap_active"])
        self.assertGreaterEqual(sb["utilization_ratio"], 0.80)
        self.assertLess(sb["utilization_ratio"], 1.0)
        self.assertEqual(sb["baseline_tier"], "T3")
        self.assertEqual(sb["downgraded_tier"], "T1")
        self.assertEqual(sb["downgraded_effort"], "none")
        self.assertEqual(sb["downgraded_max_tokens"], 1200)
        self.assertEqual(sb["single_query_path_sql_count"], 1)
        self.assertEqual(sb["hot_path_ddl_count"], 0)

        ant = g3["anthropic_cache_guard"]
        self.assertEqual(ant["threshold_chars"], 3600)
        self.assertTrue(ant["short_prompt_skips_cache_control"])
        self.assertTrue(ant["long_prompt_sets_ephemeral"])

    def test_gate4_multi_provider_failover_and_circuit_breaker(self):
        g4 = self.report["gates"]["multi_provider_failover_and_breaker"]
        self.assertTrue(g4["passed"], g4)
        self.assertEqual(g4["failover_from"], "deepseek/deepseek-chat")
        self.assertEqual(g4["fallback_provider"], "openai")
        self.assertTrue(g4["open_circuit_short_circuited"])
        self.assertTrue(g4["breaker_open_recorded"])
        self.assertTrue(g4["breaker_half_open_observed"])
        self.assertTrue(g4["recovered_to_closed"])

    def test_gate5_sqlite_wal_16_thread_contention(self):
        g5 = self.report["gates"]["sqlite_wal_16_thread_contention"]
        self.assertTrue(g5["passed"], g5)
        self.assertEqual(g5["engine_mode"], "sqlite-wal-pooled")
        self.assertEqual(g5["journal_mode"], "wal")
        self.assertEqual(g5["threads"], 16)
        self.assertEqual(g5["busy_errors"], 0)
        self.assertEqual(g5["other_errors"], 0)
        self.assertEqual(g5["rows_verified"], g5["write_ops"])
        self.assertGreaterEqual(g5["p50_ms"], 0.0)
        self.assertGreaterEqual(g5["p95_ms"], g5["p50_ms"])

    def test_gate6_observability_bounds_and_sse_replay(self):
        g6 = self.report["gates"]["observability_bounds_and_sse_replay"]
        self.assertTrue(g6["passed"], g6)
        self.assertGreater(g6["large_turn_payload_bytes"], 100_000)
        self.assertTrue(g6["large_turn_accepted_200"])
        self.assertTrue(g6["oversized_turn_rejected_413"])
        self.assertTrue(g6["standard_routes_413_enforced"])
        self.assertTrue(g6["trace_headers_and_contextvars_ok"])
        self.assertTrue(g6["event_hub_since_event_ok"])
        self.assertTrue(g6["sse_last_event_id_replay_ok"])
        self.assertEqual(g6["replayed_event_ids"], ["eval-evt-2", "eval-evt-3"])

    def test_gate7_p0_p1_enterprise_controls(self):
        g7 = self.report["gates"]["p0_p1_enterprise_controls"]
        self.assertTrue(g7["passed"], g7)

        cb = g7["concurrent_budget"]
        self.assertTrue(cb["ok"])
        self.assertEqual(cb["threads"], 8)
        self.assertEqual(cb["cap_micro_usd"], 10_000)
        self.assertLessEqual(cb["settled_micro_usd"], 10_000)
        self.assertEqual(cb["approved_threads"], 2)
        self.assertEqual(cb["rejected_threads"], 6)

        ob = g7["external_outbox"]
        self.assertTrue(ob["ok"])
        self.assertTrue(ob["in_flight_blocked"])
        self.assertEqual(ob["replay_status"], "replay")
        self.assertTrue(ob["unknown_retry_blocked"])

        pp = g7["provider_policy"]
        self.assertTrue(pp["ok"])
        self.assertTrue(pp["primary_allowed"])
        self.assertFalse(pp["failover_policy_allowed"])
        self.assertEqual(pp["policy_denied_code"], "PROVIDER_POLICY_DENIED")
        self.assertEqual(pp["blocked_failover_http_calls"], 0)

        ev = g7["durable_events_and_sse_revocation"]
        self.assertTrue(ev["ok"])
        self.assertEqual(ev["cross_hub_replayed_ids"], ["g7-evt-2", "g7-evt-3"])
        self.assertTrue(ev["cross_tenant_empty"])
        self.assertTrue(ev["sse_revoked_closed"])

        pm = g7["permanent_memory_purge"]
        self.assertTrue(pm["ok"])
        self.assertTrue(pm["staged_before_purge"])
        self.assertTrue(pm["previous_content_cleared"])
        self.assertEqual(pm["staging_rows_after_purge"], 0)
        self.assertGreaterEqual(pm["audit_events"], 1)

    def test_cli_json_and_summary_exit_zero(self):
        proc_json = subprocess.run(
            [sys.executable, str(ROOT / "scripts/enterprise_eval.py"), "--json"],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(proc_json.returncode, 0, proc_json.stderr)
        parsed = json.loads(proc_json.stdout)
        self.assertTrue(parsed["all_passed"])
        self.assertEqual(set(parsed["gates"].keys()), set(self.report["gates"].keys()))

        # Also exercise non-JSON summary exit code path directly in-process
        self.assertEqual(eval_main([]), 0)


if __name__ == "__main__":
    unittest.main()
