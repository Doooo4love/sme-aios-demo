"""Deterministic <2ms effort router, 4-zone dual-bucket context manager, MapReduce doc analyzer, telemetry, and quota."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
import math
from pathlib import Path
import re
import threading
import time
from typing import Any, Callable, Literal
from uuid import uuid4
import weakref

from pydantic import Field

from aios_demo.storage import canonical

from .contracts import Actor, Strict
from .security_guard import normalize_user_text, scrub_secrets
from .llm_provider import (
    EFFORT_MAX_TOKENS,
    EFFORT_TIMEOUT_SECONDS,
    ChatResult,
    EffortLevel,
    LLMProvider,
    ModelProfile,
    UsageMetrics,
    resolve_model_profile,
)

RoutingTier = Literal["T0", "T1", "T2", "T3"]
HK_TZ = timezone(timedelta(hours=8))

ZONE1_5_HARD_MAX_TOKENS = 140_000
ZONE1_2_MAX_TOKENS = 1_200
ZONE1_5_SAFETY_RESERVE_TOKENS = 38_000
ZONE1_5_UNMOUNT_SUMMARY_MAX_TOKENS = 2_000
ZONE2_TOOL_OUTPUT_MAX_TOKENS = 1_500
ZONE2_COMPACT_TRIGGER_TOKENS = 28_000
ZONE2_COMPACT_TARGET_TOKENS = 7_000
ZONE2_COMPACT_MAX_TOKENS = 8_000
ZONE2_VERBATIM_KEEP_TURNS = 6
IDLE_COMPACTION_SECONDS = 3_600.0
MAPREDUCE_CHUNK_MAX_TOKENS = 24_000
MAPREDUCE_REDUCE_MAX_TOKENS = 80_000

_CASUAL_GREETING_RE = re.compile(
    r"^(?:hi|hello|hey|good\s+(?:morning|afternoon|evening)|morning|thanks?|thank\s+you|"
    r"你好|您好|早安|早上好|下午好|晚上好|哈喽|嗨|谢谢|多谢|辛苦了|收到|好的|ok|okay)[!！。.,，\s]*$",
    re.IGNORECASE,
)
_STATUS_PULSE_RE = re.compile(
    r"(?:待办|工作简报|今日工作|工作脉冲|有什么需要处理|有什么任务|待处理|审批有多少|pending|anything\s+waiting|"
    r"what(?:'s|\s+is)\s+waiting|today(?:'s)?\s+(?:brief|tasks|work|pulse)|todo)",
    re.IGNORECASE,
)
_T3_CONFLICT_RE = re.compile(
    r"(?:contract\s+conflict|clause\s+conflict|cross[- ]?module|multi[- ]?step|reconcile\s+discrepancy|"
    r"compare\s+all|conflict\s+(?:review|analysis)|risk\s+audit|compliance\s+review|"
    r"合同冲突|条款冲突|条款对比|冲突核查|风险审查|跨模块|多步骤|多方核对|全面对比|深度分析|异常溯源)",
    re.IGNORECASE,
)
_T2_WORK_RE = re.compile(
    r"(?:发邮件|發郵件|写邮件|寫郵件|起草|总结|總結|汇总|匯總|整理|对比|對比|分析|解释|解釋|"
    r"为什么|為什麼|如何|怎么|怎麼|改期|销售草稿|銷售草稿|准备.*草稿|準備.*草稿|安排会议|安排會議|"
    r"draft|compose|send\s+(?:an\s+)?email|email\s+to|summar(?:ize|ise|y)|compare|clarify|explain|"
    r"reschedule|prepare\s+order|create\s+draft|schedule\s+meeting|report|review)",
    re.IGNORECASE,
)
_SIMPLE_READ_RE = re.compile(
    r"(?:查看|查询|查一下|看看|显示|列出|读一下|看下|look\s*up|check|show|get|list|read)\s*"
    r"(?:运单|運單|发票|發票|收件箱|邮件|郵件|仓库|倉庫|shipment|invoice|inbox|mail|warehouse)",
    re.IGNORECASE,
)
_CLAUSE_REF_RE = re.compile(
    r"(?:(?:page|p\.?|section|clause|article|appendix|第)\s*[0-9A-Za-z一二三四五六七八九十百]+(?:\.[0-9]+)*"
    r"(?:[页頁条條款节節章])?)",
    re.IGNORECASE,
)


def approx_tokens(value: Any) -> int:
    """Fast O(n) heuristic token counter supporting mixed CJK and ASCII text/objects."""
    if value is None:
        return 0
    if isinstance(value, str):
        text = value
    elif isinstance(value, (dict, list, tuple)):
        text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    else:
        text = str(value)
    if not text:
        return 0
    if text.isascii():
        return max(1, (len(text) + 3) // 4)
    char_len = len(text)
    byte_len = len(text.encode("utf-8", errors="ignore"))
    non_ascii_approx = max(0, (byte_len - char_len) // 2)
    ascii_approx = max(0, char_len - non_ascii_approx)
    return max(1, (ascii_approx + 3) // 4 + non_ascii_approx)


def truncate_to_tokens(text: str, max_tokens: int, *, marker: str = "\n...[truncated]...\n") -> str:
    """Clamp text cleanly to fit within max_tokens using head+tail preservation."""
    if max_tokens <= 0 or not text:
        return ""
    if approx_tokens(text) <= max_tokens:
        return text
    marker_tokens = approx_tokens(marker)
    budget = max(8, max_tokens - marker_tokens)
    head_ratio = 0.65
    # Estimate safe character budget conservatively for mixed CJK/ASCII text.
    avg_chars_per_token = max(1.0, len(text) / max(1, approx_tokens(text)))
    target_chars = max(16, int(budget * avg_chars_per_token * 0.90))
    head_chars = max(8, int(target_chars * head_ratio))
    tail_chars = max(8, target_chars - head_chars)
    result = text[:head_chars].rstrip() + marker + text[-tail_chars:].lstrip()
    while approx_tokens(result) > max_tokens and (head_chars > 8 or tail_chars > 8):
        head_chars = max(4, int(head_chars * 0.8))
        tail_chars = max(4, int(tail_chars * 0.8))
        result = text[:head_chars].rstrip() + marker + text[-tail_chars:].lstrip()
    return result


class RoutingDecision(Strict):
    tier: RoutingTier
    effort: Literal["none", "low", "high"]
    max_tokens: int
    timeout_s: float
    reason: str
    escalated_from_tier: RoutingTier | None = None
    keep_warm_same_model: bool = True


class EffortRouter:
    """Deterministic <2ms effort router assigning T0-T3 without extra LLM calls."""

    def route(
        self,
        text: str,
        *,
        security_blocked: bool = False,
        is_slash: bool = False,
        local_turn_hit: bool = False,
        off_topic_level: str | None = None,
        active_doc_tokens: int = 0,
        doc_pack_tokens: int = 0,
        conversation_turns: int = 0,
        cascade_from_tier: RoutingTier | None = None,
        session_active: bool = False,
    ) -> RoutingDecision:
        if security_blocked:
            return self._build("T0", "none", "security_guard_block", session_active=session_active)
        if is_slash or text.strip().startswith("/"):
            return self._build("T0", "none", "deterministic_slash_command", session_active=session_active)
        if local_turn_hit:
            return self._build("T0", "none", "deterministic_local_turn", session_active=session_active)
        if off_topic_level is not None:
            return self._build("T0", "none", f"off_topic_{off_topic_level.lower()}", session_active=session_active)

        if cascade_from_tier in {"T1", "T2"}:
            return self._build(
                "T3",
                "high",
                "cascade_escalation_tool_failure",
                escalated_from_tier=cascade_from_tier,
                session_active=session_active,
            )

        compact = re.sub(r"\s+", " ", text or "").strip()
        toks = approx_tokens(compact)

        # T3 triggers: conflict review, multi-step cross-module queries, large document pack, or heavy prompt.
        module_hits = sum(
            1
            for pat in (
                r"(?:shipment|运单|運單)",
                r"(?:invoice|发票|發票|billing|账单|賬單)",
                r"(?:order|订单|訂單|intake|草稿)",
                r"(?:warehouse|仓库|倉庫|summary|汇总|匯總)",
                r"(?:approval|approve|提案|审批|審批)",
                r"(?:email|mail|邮件|郵件)",
            )
            if re.search(pat, compact, re.IGNORECASE)
        )
        has_sequence_connector = bool(
            re.search(r"(?:and\s+then|after\s+that|同时|並且|并且|先.{1,25}再|然后|然後)", compact, re.IGNORECASE)
        )
        if (
            doc_pack_tokens > ZONE1_5_HARD_MAX_TOKENS
            or active_doc_tokens >= 16_000
            or _T3_CONFLICT_RE.search(compact)
            or (module_hits >= 2 and (has_sequence_connector or len(compact) >= 40))
            or toks >= 1_200
        ):
            return self._build("T3", "high", "complex_reasoning_or_document_conflict", session_active=session_active)

        # T1 triggers: casual greetings, pulse queries, or clear single-read inquiries.
        if _CASUAL_GREETING_RE.fullmatch(compact):
            return self._build("T1", "none", "casual_greeting", session_active=session_active)
        if _STATUS_PULSE_RE.search(compact) and module_hits <= 1 and not _T2_WORK_RE.search(compact):
            return self._build("T1", "none", "status_pulse_query", session_active=session_active)
        if _SIMPLE_READ_RE.search(compact) and module_hits <= 1 and not has_sequence_connector and not _T2_WORK_RE.search(compact):
            return self._build("T1", "none", "single_read_query", session_active=session_active)

        # T2 triggers: email drafting, clarifications, summaries, single proposals, or active medium context.
        if _T2_WORK_RE.search(compact) or active_doc_tokens > 0 or toks >= 60 or conversation_turns >= 4:
            return self._build("T2", "low", "structured_draft_or_clarification", session_active=session_active)

        return self._build("T1", "none", "lightweight_chat", session_active=session_active)

    @staticmethod
    def _build(
        tier: RoutingTier,
        effort: Literal["none", "low", "high"],
        reason: str,
        *,
        escalated_from_tier: RoutingTier | None = None,
        session_active: bool = False,
    ) -> RoutingDecision:
        return RoutingDecision(
            tier=tier,
            effort=effort,
            max_tokens=EFFORT_MAX_TOKENS[effort],
            timeout_s=EFFORT_TIMEOUT_SECONDS[effort],
            reason=reason,
            escalated_from_tier=escalated_from_tier,
            keep_warm_same_model=True if session_active or tier in {"T1", "T2", "T3"} else False,
        )


_ROUTING_TABLES_LOCK = threading.Lock()
_ROUTING_TABLES_READY: weakref.WeakKeyDictionary[Any, tuple[Any, ...]] = weakref.WeakKeyDictionary()
_ENTERPRISE_FINOPS_LOCK = threading.Lock()
_ENTERPRISE_FINOPS_READY: weakref.WeakKeyDictionary[Any, tuple[Any, ...]] = weakref.WeakKeyDictionary()


def _sqlite_workflow_sig(workflow) -> tuple[Any, ...]:
    db = getattr(workflow, "db", None)
    sqlite_path = getattr(db, "sqlite_path", None)
    if sqlite_path is not None and str(sqlite_path) != ":memory:":
        p = Path(sqlite_path)
        try:
            st = p.stat()
            return ("file", str(p.resolve()), int(st.st_dev), int(st.st_ino))
        except OSError:
            return ("missing", str(p))
    return ("mem", id(db) if db is not None else id(workflow))


def _ensure_routing_tables_sqlite(workflow, run) -> None:
    if getattr(workflow.db, "dsn", None):
        return
    sig = _sqlite_workflow_sig(workflow)
    with _ROUTING_TABLES_LOCK:
        try:
            if _ROUTING_TABLES_READY.get(workflow) == sig:
                return
        except TypeError:
            pass
    run(
        """CREATE TABLE IF NOT EXISTS aios_llm_telemetry (
               tenant TEXT NOT NULL, id TEXT NOT NULL, subject TEXT NOT NULL, role TEXT NOT NULL,
               provider TEXT NOT NULL, model TEXT NOT NULL, tier TEXT NOT NULL,
               reasoning_effort TEXT NOT NULL, prompt_tokens INTEGER NOT NULL DEFAULT 0,
               cache_hit_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0,
               completion_tokens INTEGER NOT NULL DEFAULT 0, estimated_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
               latency_ms DOUBLE PRECISION NOT NULL DEFAULT 0, escalated_from_tier TEXT,
               success INTEGER NOT NULL DEFAULT 1, error_code TEXT, created_at DOUBLE PRECISION NOT NULL,
               PRIMARY KEY (tenant, id)
           )"""
    )
    run(
        """CREATE TABLE IF NOT EXISTS aios_quota_policy (
               tenant TEXT NOT NULL, scope_type TEXT NOT NULL, scope_key TEXT NOT NULL,
               daily_usd_limit DOUBLE PRECISION, daily_token_limit BIGINT,
               updated_by TEXT NOT NULL, updated_at DOUBLE PRECISION NOT NULL,
               PRIMARY KEY (tenant, scope_type, scope_key)
           )"""
    )
    run(
        """CREATE TABLE IF NOT EXISTS aios_agent_session_state (
               tenant TEXT NOT NULL, subject TEXT NOT NULL, session_id TEXT NOT NULL,
               rolling_summary TEXT NOT NULL DEFAULT '', active_doc_id TEXT, active_doc_title TEXT,
               active_doc_summary TEXT, active_doc_tokens INTEGER NOT NULL DEFAULT 0,
               last_turn_at DOUBLE PRECISION NOT NULL, compacted_at DOUBLE PRECISION,
               PRIMARY KEY (tenant, subject, session_id)
           )"""
    )
    sig_after = _sqlite_workflow_sig(workflow)
    with _ROUTING_TABLES_LOCK:
        try:
            _ROUTING_TABLES_READY[workflow] = sig_after
        except TypeError:
            pass


def _ensure_enterprise_finops_tables_sqlite(workflow, run) -> None:
    if getattr(workflow.db, "dsn", None):
        return
    sig = _sqlite_workflow_sig(workflow)
    with _ENTERPRISE_FINOPS_LOCK:
        try:
            if _ENTERPRISE_FINOPS_READY.get(workflow) == sig:
                return
        except TypeError:
            pass
    run(
        """CREATE TABLE IF NOT EXISTS aios_budget_reservation (
               tenant TEXT NOT NULL,
               id TEXT NOT NULL,
               subject TEXT NOT NULL,
               role TEXT NOT NULL,
               day_key TEXT NOT NULL,
               reserved_micro_usd BIGINT NOT NULL DEFAULT 0 CHECK (reserved_micro_usd >= 0),
               actual_micro_usd BIGINT NOT NULL DEFAULT 0 CHECK (actual_micro_usd >= 0),
               reserved_tokens BIGINT NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0),
               actual_tokens BIGINT NOT NULL DEFAULT 0 CHECK (actual_tokens >= 0),
               status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'settled', 'released')),
               expires_at DOUBLE PRECISION NOT NULL,
               created_at DOUBLE PRECISION NOT NULL,
               settled_at DOUBLE PRECISION,
               PRIMARY KEY (tenant, id)
           )"""
    )
    run(
        """CREATE INDEX IF NOT EXISTS aios_budget_reservation_active
               ON aios_budget_reservation(tenant, day_key, status, expires_at)"""
    )
    run(
        """CREATE TABLE IF NOT EXISTS aios_tenant_provider_policy (
               tenant TEXT PRIMARY KEY,
               allowed_providers_json TEXT NOT NULL,
               allowed_regions_json TEXT NOT NULL,
               blocked_data_classes_json TEXT NOT NULL,
               allow_failover INTEGER NOT NULL DEFAULT 1 CHECK (allow_failover IN (0, 1)),
               max_tier TEXT NOT NULL DEFAULT 'T3' CHECK (max_tier IN ('T0', 'T1', 'T2', 'T3')),
               pricing_version TEXT NOT NULL DEFAULT '2026-11-official',
               updated_by TEXT NOT NULL,
               updated_at DOUBLE PRECISION NOT NULL
           )"""
    )
    sig_after = _sqlite_workflow_sig(workflow)
    with _ENTERPRISE_FINOPS_LOCK:
        try:
            _ENTERPRISE_FINOPS_READY[workflow] = sig_after
        except TypeError:
            pass


class ActiveDocumentInput(Strict):
    doc_id: str
    title: str
    content: str


class ZoneAssembly(Strict):
    messages: list[dict[str, Any]]
    sorted_tool_schemas: list[dict[str, Any]]
    zone1_tokens: int
    zone1_2_tokens: int = 0
    zone1_5_tokens: int
    zone2_tokens: int
    zone3_tokens: int
    compacted: bool = False
    idle_compacted: bool = False
    active_doc_mounted: str | None = None
    unmounted_doc_summary: str | None = None
    requires_mapreduce: bool = False


class ContextManager:
    """Four-Zone Dual-Bucket prompt context manager preserving Zone 1 KV cache invariance."""

    def __init__(self, workflow=None):
        self.workflow = workflow

    @staticmethod
    def zone1_tool_schemas(tool_schemas: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Sort tool schemas deterministically by function name so Zone 1 prefix stays byte-identical."""
        def sort_key(item: dict[str, Any]) -> str:
            fn = item.get("function") if isinstance(item, dict) else None
            if isinstance(fn, dict):
                return str(fn.get("name") or "")
            return str(item.get("name") or "")

        ordered = sorted(tool_schemas, key=sort_key)
        # Round-trip canonical JSON ordering inside each schema for strict byte invariance.
        return json.loads(json.dumps(ordered, sort_keys=True, ensure_ascii=False))

    @staticmethod
    def clamp_tool_output(output: Any, max_tokens: int = ZONE2_TOOL_OUTPUT_MAX_TOKENS) -> str:
        """Clamp stored tool observations to <=1,500 tokens BEFORE insertion into Zone 2."""
        if isinstance(output, str):
            raw = output
        else:
            raw = json.dumps(output, ensure_ascii=False, sort_keys=True)
        return truncate_to_tokens(raw, max_tokens)

    @staticmethod
    def active_doc_budget(profile: ModelProfile) -> int:
        return min(ZONE1_5_HARD_MAX_TOKENS, max(0, profile.safe_cap_tokens - ZONE1_5_SAFETY_RESERVE_TOKENS))

    @staticmethod
    def summarize_document_for_unmount(
        doc_id: str,
        title: str,
        content: str,
        *,
        max_tokens: int = ZONE1_5_UNMOUNT_SUMMARY_MAX_TOKENS,
    ) -> str:
        """Produce a <=2,000-token structured review summary preserving page/clause references."""
        lines = [line.strip() for line in (content or "").splitlines() if line.strip()]
        ref_lines: list[str] = []
        key_lines: list[str] = []
        for line in lines:
            if _CLAUSE_REF_RE.search(line) or line.startswith("#"):
                ref_lines.append(line)
            elif len(key_lines) < 18:
                key_lines.append(line)

        chosen = ref_lines[:30]
        if len(chosen) < 12:
            for item in key_lines:
                if item not in chosen:
                    chosen.append(item)
                if len(chosen) >= 24:
                    break
        if not chosen:
            chosen = [content[:800].strip()] if content.strip() else ["(empty document)"]

        header = f"[Unmounted Document Summary] {title} (id={doc_id})"
        bullets = "\n".join(f"- {item[:280]}" for item in chosen)
        return truncate_to_tokens(f"{header}\n{bullets}", max_tokens)

    @staticmethod
    def _compact_turns_summary(
        existing_summary: str,
        dropped_turns: list[dict[str, Any]],
        *,
        max_tokens: int = 2_000,
    ) -> str:
        bullets: list[str] = []
        if existing_summary.strip():
            bullets.append(existing_summary.strip())
        for turn in dropped_turns:
            role = str(turn.get("role") or "user")
            raw = str(turn.get("content") or turn.get("text") or "").strip()
            if not raw:
                continue
            compact_line = re.sub(r"\s+", " ", raw)[:240]
            bullets.append(f"[{role}] {compact_line}")
        merged = "\n".join(bullets)
        return truncate_to_tokens(merged, max_tokens)

    def get_session_state(self, actor: Actor, session_id: str) -> dict[str, Any] | None:
        if self.workflow is None:
            return None
        with self.workflow.tx(actor.tenant, write=False, bounded=True) as run:
            _ensure_routing_tables_sqlite(self.workflow, run)
            row = run(
                """SELECT * FROM aios_agent_session_state
                   WHERE tenant = ? AND subject = ? AND session_id = ?""",
                (actor.tenant, actor.subject, session_id),
            ).fetchone()
            return dict(row) if row else None

    def _save_session_state(
        self,
        actor: Actor,
        session_id: str,
        *,
        rolling_summary: str,
        active_doc_id: str | None,
        active_doc_title: str | None,
        active_doc_summary: str | None,
        active_doc_tokens: int,
        last_turn_at: float,
        compacted_at: float | None,
    ) -> dict[str, Any] | None:
        if self.workflow is None:
            return None
        with self.workflow.tx(actor.tenant, write=True, bounded=True) as run:
            _ensure_routing_tables_sqlite(self.workflow, run)
            run(
                """INSERT INTO aios_agent_session_state
                   (tenant, subject, session_id, rolling_summary, active_doc_id, active_doc_title,
                    active_doc_summary, active_doc_tokens, last_turn_at, compacted_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT (tenant, subject, session_id) DO UPDATE SET
                       rolling_summary = excluded.rolling_summary,
                       active_doc_id = excluded.active_doc_id,
                       active_doc_title = excluded.active_doc_title,
                       active_doc_summary = excluded.active_doc_summary,
                       active_doc_tokens = excluded.active_doc_tokens,
                       last_turn_at = excluded.last_turn_at,
                       compacted_at = excluded.compacted_at""",
                (
                    actor.tenant,
                    actor.subject,
                    session_id,
                    rolling_summary,
                    active_doc_id,
                    active_doc_title,
                    active_doc_summary,
                    max(0, int(active_doc_tokens)),
                    float(last_turn_at),
                    compacted_at,
                ),
            )
            row = run(
                """SELECT * FROM aios_agent_session_state
                   WHERE tenant = ? AND subject = ? AND session_id = ?""",
                (actor.tenant, actor.subject, session_id),
            ).fetchone()
            return dict(row) if row else None

    def mount_document(
        self,
        actor: Actor,
        session_id: str,
        *,
        doc_id: str,
        title: str,
        content: str,
        profile: ModelProfile,
        now: float | None = None,
    ) -> dict[str, Any]:
        """Mount a single document into Zone 1.5, auto-unmounting any prior document first."""
        ts = time.time() if now is None else now
        prior = self.get_session_state(actor, session_id)
        rolling_summary = str((prior or {}).get("rolling_summary") or "")
        unmounted_summary: str | None = None

        if prior and prior.get("active_doc_id") and prior["active_doc_id"] != doc_id:
            prior_summary = str(prior.get("active_doc_summary") or "").strip()
            if prior_summary:
                unmounted_summary = truncate_to_tokens(prior_summary, ZONE1_5_UNMOUNT_SUMMARY_MAX_TOKENS)
                rolling_summary = truncate_to_tokens(
                    (rolling_summary + "\n\n" + unmounted_summary).strip(),
                    ZONE2_COMPACT_TARGET_TOKENS // 2,
                )

        doc_tokens = approx_tokens(content)
        budget = self.active_doc_budget(profile)
        requires_mapreduce = doc_tokens > ZONE1_5_HARD_MAX_TOKENS or doc_tokens > max(1, budget)
        review_summary = self.summarize_document_for_unmount(doc_id, title, content)

        saved = self._save_session_state(
            actor,
            session_id,
            rolling_summary=rolling_summary,
            active_doc_id=doc_id,
            active_doc_title=title[:240],
            active_doc_summary=review_summary,
            active_doc_tokens=doc_tokens,
            last_turn_at=ts,
            compacted_at=prior.get("compacted_at") if prior else None,
        )
        return {
            "session_state": saved,
            "doc_tokens": doc_tokens,
            "slot_budget": budget,
            "requires_mapreduce": requires_mapreduce,
            "unmounted_doc_summary": unmounted_summary,
            "active_doc_summary": review_summary,
        }

    def unmount_document(
        self,
        actor: Actor,
        session_id: str,
        *,
        content: str | None = None,
        now: float | None = None,
    ) -> str | None:
        """Unmount the active Zone 1.5 document, persisting <=2,000-token structured review summary."""
        ts = time.time() if now is None else now
        prior = self.get_session_state(actor, session_id)
        if not prior or not prior.get("active_doc_id"):
            return prior.get("active_doc_summary") if prior else None
        if content:
            summary = self.summarize_document_for_unmount(
                str(prior["active_doc_id"]),
                str(prior.get("active_doc_title") or prior["active_doc_id"]),
                content,
            )
        else:
            summary = truncate_to_tokens(
                str(prior.get("active_doc_summary") or f"[Unmounted Document] {prior['active_doc_id']}"),
                ZONE1_5_UNMOUNT_SUMMARY_MAX_TOKENS,
            )
        rolling = str(prior.get("rolling_summary") or "")
        if summary and summary not in rolling:
            rolling = truncate_to_tokens((rolling + "\n\n" + summary).strip(), ZONE2_COMPACT_TARGET_TOKENS // 2)
        self._save_session_state(
            actor,
            session_id,
            rolling_summary=rolling,
            active_doc_id=None,
            active_doc_title=None,
            active_doc_summary=summary,
            active_doc_tokens=0,
            last_turn_at=ts,
            compacted_at=prior.get("compacted_at"),
        )
        return summary

    def assemble(
        self,
        actor: Actor,
        *,
        session_id: str | None,
        system_prompt: str,
        tool_schemas: list[dict[str, Any]],
        history_turns: list[dict[str, Any]],
        user_text: str,
        pulse_summary: str,
        profile: ModelProfile,
        user_memory: str | None = None,
        active_document: ActiveDocumentInput | None = None,
        task_switched: bool = False,
        now: float | None = None,
    ) -> ZoneAssembly:
        """Assemble Zone 1 (immutable) + Zone 1.2 (MEMORY.md) + Zone 1.5 (doc slot) + Zone 2 (trajectory) + Zone 3 (ephemeral pulse)."""
        ts = time.time() if now is None else now
        sorted_schemas = self.zone1_tool_schemas(tool_schemas)
        zone1_tokens = approx_tokens(system_prompt) + approx_tokens(sorted_schemas)

        # Zone 1.2: Per-user long-term MEMORY.md wrapped in untrusted user-facts XML fence (after Zone 1).
        zone1_2_messages: list[dict[str, Any]] = []
        zone1_2_tokens = 0
        raw_memory = (user_memory or "").strip()
        if raw_memory:
            safe_memory = scrub_secrets(normalize_user_text(raw_memory)[0]).strip()
            if safe_memory:
                safe_memory = truncate_to_tokens(safe_memory, ZONE1_2_MAX_TOKENS).strip()
            if safe_memory:
                memory_block = (
                    '<user_long_term_memory trust="user_editable_facts_only">\n'
                    f"{safe_memory}\n"
                    "</user_long_term_memory>"
                )
                zone1_2_tokens = approx_tokens(memory_block)
                zone1_2_messages = [
                    {"role": "user", "content": memory_block},
                    {
                        "role": "assistant",
                        "content": "Noted user long-term memory facts and preferences (non-authoritative).",
                    },
                ]

        prior_state = self.get_session_state(actor, session_id) if session_id else None
        rolling_summary = str((prior_state or {}).get("rolling_summary") or "")
        compacted_at = prior_state.get("compacted_at") if prior_state else None
        last_turn_at = float(prior_state.get("last_turn_at") or ts) if prior_state else ts
        unmounted_summary: str | None = None

        # Zone 1.5 management: mount single doc or auto-unmount on doc/task switch.
        zone1_5_messages: list[dict[str, Any]] = []
        zone1_5_tokens = 0
        requires_mapreduce = False
        active_doc_id: str | None = prior_state.get("active_doc_id") if prior_state else None
        active_doc_title: str | None = prior_state.get("active_doc_title") if prior_state else None
        active_doc_summary: str | None = prior_state.get("active_doc_summary") if prior_state else None
        active_doc_tokens = int(prior_state.get("active_doc_tokens") or 0) if prior_state else 0

        if task_switched and active_doc_id and session_id:
            unmounted_summary = self.unmount_document(actor, session_id, now=ts)
            prior_state = self.get_session_state(actor, session_id)
            rolling_summary = str((prior_state or {}).get("rolling_summary") or "")
            active_doc_id = None
            active_doc_title = None
            active_doc_tokens = 0

        if active_document is not None:
            if session_id:
                mount_info = self.mount_document(
                    actor,
                    session_id,
                    doc_id=active_document.doc_id,
                    title=active_document.title,
                    content=active_document.content,
                    profile=profile,
                    now=ts,
                )
                unmounted_summary = mount_info["unmounted_doc_summary"]
                active_doc_id = active_document.doc_id
                active_doc_title = active_document.title
                active_doc_summary = mount_info["active_doc_summary"]
                active_doc_tokens = mount_info["doc_tokens"]
                requires_mapreduce = mount_info["requires_mapreduce"]
                slot_budget = mount_info["slot_budget"]
                rolling_summary = str((mount_info["session_state"] or {}).get("rolling_summary") or rolling_summary)
            else:
                slot_budget = self.active_doc_budget(profile)
                active_doc_tokens = approx_tokens(active_document.content)
                requires_mapreduce = active_doc_tokens > ZONE1_5_HARD_MAX_TOKENS or active_doc_tokens > max(1, slot_budget)

            doc_body = (
                truncate_to_tokens(active_document.content, max(1_500, min(slot_budget, ZONE1_5_HARD_MAX_TOKENS)))
                if not requires_mapreduce
                else self.summarize_document_for_unmount(
                    active_document.doc_id,
                    active_document.title,
                    active_document.content,
                )
            )
            doc_block = f"[Active Document Slot: {active_document.title} ({active_document.doc_id})]\n{doc_body}"
            zone1_5_tokens = approx_tokens(doc_block)
            zone1_5_messages.append({"role": "user", "content": doc_block})
            zone1_5_messages.append({"role": "assistant", "content": "Document loaded into active review slot."})

        # Zone 2: Append-Only Trajectory with clamped tool outputs + hysteresis stepped compaction + >60m idle compaction.
        normalized_turns: list[dict[str, Any]] = []
        for turn in history_turns:
            role = str(turn.get("role") or "user")
            item = dict(turn)
            if role == "tool":
                item["content"] = self.clamp_tool_output(turn.get("content") or "")
            else:
                item["content"] = str(turn.get("content") or turn.get("text") or "")
            normalized_turns.append(item)

        idle_compacted = False
        compacted = False
        trajectory_tokens = sum(approx_tokens(t) for t in normalized_turns) + approx_tokens(rolling_summary)

        idle_elapsed = ts - last_turn_at if prior_state is not None else 0.0
        if idle_elapsed > IDLE_COMPACTION_SECONDS and len(normalized_turns) > ZONE2_VERBATIM_KEEP_TURNS:
            keep_n = min(len(normalized_turns), ZONE2_VERBATIM_KEEP_TURNS)
            dropped = normalized_turns[:-keep_n]
            normalized_turns = normalized_turns[-keep_n:]
            rolling_summary = self._compact_turns_summary(rolling_summary, dropped)
            compacted_at = ts
            idle_compacted = True
            compacted = True
            trajectory_tokens = sum(approx_tokens(t) for t in normalized_turns) + approx_tokens(rolling_summary)

        if trajectory_tokens >= ZONE2_COMPACT_TRIGGER_TOKENS:
            for keep_n in (8, 7, 6):
                if len(normalized_turns) < keep_n:
                    continue
                kept = normalized_turns[-keep_n:]
                dropped = normalized_turns[:-keep_n]
                candidate_summary = self._compact_turns_summary(rolling_summary, dropped, max_tokens=2_000)
                candidate_tokens = sum(approx_tokens(t) for t in kept) + approx_tokens(candidate_summary)
                if candidate_tokens <= ZONE2_COMPACT_MAX_TOKENS:
                    normalized_turns = kept
                    rolling_summary = candidate_summary
                    compacted = True
                    compacted_at = ts
                    break
            if not compacted and normalized_turns:
                keep_n = min(len(normalized_turns), ZONE2_VERBATIM_KEEP_TURNS)
                dropped = normalized_turns[:-keep_n]
                normalized_turns = normalized_turns[-keep_n:]
                rolling_summary = self._compact_turns_summary(rolling_summary, dropped, max_tokens=2_000)
                available_for_turns = max(1_200, ZONE2_COMPACT_MAX_TOKENS - approx_tokens(rolling_summary) - 64)
                per_turn_cap = max(150, available_for_turns // max(1, len(normalized_turns)))
                for turn in normalized_turns:
                    if approx_tokens(turn) > per_turn_cap:
                        turn["content"] = truncate_to_tokens(str(turn.get("content") or ""), max(64, per_turn_cap - 12))
                compacted = True
                compacted_at = ts
            trajectory_tokens = sum(approx_tokens(t) for t in normalized_turns) + approx_tokens(rolling_summary)

        if session_id:
            self._save_session_state(
                actor,
                session_id,
                rolling_summary=rolling_summary,
                active_doc_id=active_doc_id,
                active_doc_title=active_doc_title,
                active_doc_summary=active_doc_summary,
                active_doc_tokens=active_doc_tokens,
                last_turn_at=ts,
                compacted_at=compacted_at,
            )

        zone2_messages: list[dict[str, Any]] = []
        if rolling_summary.strip():
            zone2_messages.append({"role": "user", "content": f"[Session Rolling Summary]\n{rolling_summary.strip()}"})
            zone2_messages.append({"role": "assistant", "content": "Understood; continuing with preserved session context."})
        zone2_messages.extend(normalized_turns)

        # Zone 3: Ephemeral tail attached ONLY to the current user request payload (never saved to history).
        clean_pulse = (pulse_summary or "").strip()
        zone3_content = f"{user_text}\n\n{clean_pulse}" if clean_pulse else user_text
        zone3_tokens = approx_tokens(clean_pulse)

        messages: list[dict[str, Any]] = [{"role": "system", "content": system_prompt}]
        messages.extend(zone1_2_messages)
        messages.extend(zone1_5_messages)
        messages.extend(zone2_messages)
        messages.append({"role": "user", "content": zone3_content})

        return ZoneAssembly(
            messages=messages,
            sorted_tool_schemas=sorted_schemas,
            zone1_tokens=zone1_tokens,
            zone1_2_tokens=zone1_2_tokens,
            zone1_5_tokens=zone1_5_tokens,
            zone2_tokens=trajectory_tokens,
            zone3_tokens=zone3_tokens,
            compacted=compacted,
            idle_compacted=idle_compacted,
            active_doc_mounted=active_doc_id,
            unmounted_doc_summary=unmounted_summary,
            requires_mapreduce=requires_mapreduce,
        )


class DocumentChunk(Strict):
    index: int
    heading: str
    text: str
    tokens: int


class MapReduceAnalysisResult(Strict):
    chunk_count: int
    map_input_tokens: int
    reduce_input_tokens: int
    summary: str
    map_outputs: list[str]
    usage: UsageMetrics


class MapReduceDocumentAnalyzer:
    """Split >140K doc packs into <=24K chunks for concurrent T1/T2 map extraction -> T3 synthesis."""

    def __init__(
        self,
        provider: LLMProvider | None = None,
        *,
        chunk_max_tokens: int = MAPREDUCE_CHUNK_MAX_TOKENS,
        reduce_max_tokens: int = MAPREDUCE_REDUCE_MAX_TOKENS,
        max_workers: int = 4,
    ):
        self.provider = provider
        self.chunk_max_tokens = min(MAPREDUCE_CHUNK_MAX_TOKENS, max(512, chunk_max_tokens))
        self.reduce_max_tokens = min(MAPREDUCE_REDUCE_MAX_TOKENS, max(2_000, reduce_max_tokens))
        self.max_workers = max(1, min(max_workers, 8))

    def split_sections(self, text: str) -> list[DocumentChunk]:
        """Split a large document pack into chunks strictly <=24K tokens along headings/paragraphs."""
        raw = (text or "").strip()
        if not raw:
            return []

        blocks = re.split(r"(?m)(?=^#{1,4}\s+)", raw)
        segments: list[tuple[str, str]] = []
        for block in blocks:
            part = block.strip()
            if not part:
                continue
            first_line = part.splitlines()[0].strip()
            heading = first_line[:120] if first_line.startswith("#") else "Section"
            if approx_tokens(part) <= self.chunk_max_tokens:
                segments.append((heading, part))
            else:
                # Split oversized section by paragraphs, then hard-slice if a single paragraph exceeds budget.
                sub_parts = part.split("\n\n")
                for para in sub_parts:
                    p = para.strip()
                    if not p:
                        continue
                    if approx_tokens(p) <= self.chunk_max_tokens:
                        segments.append((heading, p))
                    else:
                        step = max(256, int(len(p) * (self.chunk_max_tokens / max(1, approx_tokens(p))) * 0.85))
                        for idx in range(0, len(p), step):
                            piece = p[idx:idx + step].strip()
                            if piece:
                                while approx_tokens(piece) > self.chunk_max_tokens and len(piece) > 64:
                                    piece = piece[: int(len(piece) * 0.85)]
                                segments.append((heading, piece))

        chunks: list[DocumentChunk] = []
        buf: list[str] = []
        buf_heading = "Section"
        buf_tokens = 0
        for heading, seg in segments:
            seg_tokens = approx_tokens(seg)
            if buf and buf_tokens + seg_tokens > self.chunk_max_tokens:
                joined = "\n\n".join(buf)
                chunks.append(
                    DocumentChunk(
                        index=len(chunks),
                        heading=buf_heading,
                        text=joined,
                        tokens=approx_tokens(joined),
                    )
                )
                buf = [seg]
                buf_heading = heading
                buf_tokens = seg_tokens
            else:
                if not buf:
                    buf_heading = heading
                buf.append(seg)
                buf_tokens += seg_tokens + 2
        if buf:
            joined = "\n\n".join(buf)
            chunks.append(
                DocumentChunk(
                    index=len(chunks),
                    heading=buf_heading,
                    text=joined,
                    tokens=approx_tokens(joined),
                )
            )
        return chunks

    def analyze(
        self,
        text: str,
        *,
        question: str,
        map_effort: Literal["none", "low"] = "low",
        map_caller: Callable[[DocumentChunk], ChatResult] | None = None,
        reduce_caller: Callable[[str], ChatResult] | None = None,
    ) -> MapReduceAnalysisResult:
        """Run concurrent T1/T2 map extraction followed by T3 conflict synthesis on <=80K summary."""
        chunks = self.split_sections(text)
        if not chunks:
            return MapReduceAnalysisResult(
                chunk_count=0,
                map_input_tokens=0,
                reduce_input_tokens=0,
                summary="",
                map_outputs=[],
                usage=UsageMetrics(),
            )

        def default_map(chunk: DocumentChunk) -> ChatResult:
            if self.provider is None:
                raise RuntimeError("LLMProvider or custom map_caller required for MapReduceDocumentAnalyzer")
            messages = [
                {
                    "role": "system",
                    "content": (
                        "Extract obligations, figures, dates, clause/page references, and potential conflicts "
                        "concisely as Markdown bullets. Never fabricate facts."
                    ),
                },
                {
                    "role": "user",
                    "content": f"Question: {question}\n\n[Chunk {chunk.index + 1}: {chunk.heading}]\n{chunk.text}",
                },
            ]
            return self.provider.chat(
                messages,
                effort=map_effort,
                max_tokens=EFFORT_MAX_TOKENS[map_effort],
                timeout_s=EFFORT_TIMEOUT_SECONDS[map_effort],
            )

        def default_reduce(combined_maps: str) -> ChatResult:
            if self.provider is None:
                raise RuntimeError("LLMProvider or custom reduce_caller required for MapReduceDocumentAnalyzer")
            messages = [
                {
                    "role": "system",
                    "content": (
                        "Synthesize extracted section summaries, highlight cross-document/clause conflicts, "
                        "cite exact clause/page references, and summarize actionable recommendations in GFM."
                    ),
                },
                {
                    "role": "user",
                    "content": f"Task: {question}\n\n[Extracted Section Summaries]\n{combined_maps}",
                },
            ]
            return self.provider.chat(
                messages,
                effort="high",
                max_tokens=EFFORT_MAX_TOKENS["high"],
                timeout_s=EFFORT_TIMEOUT_SECONDS["high"],
            )

        run_map = map_caller or default_map
        run_reduce = reduce_caller or default_reduce

        if len(chunks) == 1 or self.max_workers == 1:
            map_results = [run_map(chunk) for chunk in chunks]
        else:
            with ThreadPoolExecutor(max_workers=min(self.max_workers, len(chunks))) as pool:
                map_results = list(pool.map(run_map, chunks))

        map_outputs = [
            f"### Chunk {chunk.index + 1} ({chunk.heading})\n{res.text.strip()}"
            for chunk, res in zip(chunks, map_results)
        ]
        combined_summary = truncate_to_tokens("\n\n".join(map_outputs), self.reduce_max_tokens)
        reduce_input_tokens = approx_tokens(combined_summary)
        reduce_result = run_reduce(combined_summary)

        all_results = [*map_results, reduce_result]
        total_prompt = sum(r.usage.prompt_tokens for r in all_results)
        total_cache = sum(r.usage.cache_hit_tokens for r in all_results)
        total_reason = sum(r.usage.reasoning_tokens for r in all_results)
        total_comp = sum(r.usage.completion_tokens for r in all_results)
        total_usd = round(sum(r.usage.estimated_usd for r in all_results), 8)

        return MapReduceAnalysisResult(
            chunk_count=len(chunks),
            map_input_tokens=sum(c.tokens for c in chunks),
            reduce_input_tokens=reduce_input_tokens,
            summary=reduce_result.text,
            map_outputs=map_outputs,
            usage=UsageMetrics(
                prompt_tokens=total_prompt,
                cache_hit_tokens=total_cache,
                reasoning_tokens=total_reason,
                completion_tokens=total_comp,
                total_tokens=total_prompt + total_comp,
                estimated_usd=total_usd,
            ),
        )


class RoutingTelemetryStore:
    """Tenant-scoped LLM routing, KV cache hit, cost, and latency telemetry ledger."""

    def __init__(self, workflow):
        self.workflow = workflow

    def record(
        self,
        actor: Actor,
        *,
        provider: str,
        model: str,
        tier: RoutingTier,
        reasoning_effort: str,
        prompt_tokens: int = 0,
        cache_hit_tokens: int = 0,
        reasoning_tokens: int = 0,
        completion_tokens: int = 0,
        estimated_usd: float = 0.0,
        latency_ms: float = 0.0,
        escalated_from_tier: RoutingTier | None = None,
        success: bool = True,
        error_code: str | None = None,
        created_at: float | None = None,
    ) -> dict[str, Any]:
        ts = time.time() if created_at is None else float(created_at)
        entry_id = uuid4().hex
        with self.workflow.tx(actor.tenant, write=True, bounded=True) as run:
            _ensure_routing_tables_sqlite(self.workflow, run)
            run(
                """INSERT INTO aios_llm_telemetry
                   (tenant, id, subject, role, provider, model, tier, reasoning_effort,
                    prompt_tokens, cache_hit_tokens, reasoning_tokens, completion_tokens,
                    estimated_usd, latency_ms, escalated_from_tier, success, error_code, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    actor.tenant,
                    entry_id,
                    actor.subject,
                    actor.role,
                    provider[:64],
                    model[:128],
                    tier,
                    reasoning_effort[:32],
                    max(0, int(prompt_tokens)),
                    max(0, int(cache_hit_tokens)),
                    max(0, int(reasoning_tokens)),
                    max(0, int(completion_tokens)),
                    max(0.0, float(estimated_usd)),
                    max(0.0, float(latency_ms)),
                    escalated_from_tier,
                    1 if success else 0,
                    error_code[:64] if error_code else None,
                    ts,
                ),
            )
        return {
            "id": entry_id,
            "tenant": actor.tenant,
            "subject": actor.subject,
            "tier": tier,
            "provider": provider,
            "model": model,
            "created_at": ts,
        }

    @staticmethod
    def _percentile(sorted_vals: list[float], q: float) -> float:
        if not sorted_vals:
            return 0.0
        if len(sorted_vals) == 1:
            return round(sorted_vals[0], 2)
        pos = q * (len(sorted_vals) - 1)
        lo = int(math.floor(pos))
        hi = int(math.ceil(pos))
        if lo == hi:
            return round(sorted_vals[lo], 2)
        frac = pos - lo
        return round(sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * frac, 2)

    def summary(self, tenant: str, hours: int = 24) -> dict[str, Any]:
        window_hours = max(1, min(int(hours), 720))
        since = time.time() - window_hours * 3600.0
        with self.workflow.tx(tenant, write=False, bounded=True) as run:
            _ensure_routing_tables_sqlite(self.workflow, run)
            totals_row = run(
                """SELECT COUNT(*) AS total_calls,
                          COALESCE(SUM(prompt_tokens), 0) AS total_prompt,
                          COALESCE(SUM(cache_hit_tokens), 0) AS total_cache,
                          COALESCE(SUM(reasoning_tokens), 0) AS total_reasoning,
                          COALESCE(SUM(completion_tokens), 0) AS total_completion,
                          COALESCE(SUM(estimated_usd), 0.0) AS total_usd,
                          COALESCE(SUM(latency_ms), 0.0) AS total_latency,
                          COALESCE(SUM(CASE WHEN COALESCE(success, 1) = 0 THEN 1 ELSE 0 END), 0) AS error_calls,
                          COALESCE(SUM(CASE WHEN error_code = 'FAILOVER' OR error_code LIKE 'FAILOVER:%' THEN 1 ELSE 0 END), 0) AS failover_count
                   FROM aios_llm_telemetry
                   WHERE tenant = ? AND created_at >= ?""",
                (tenant, since),
            ).fetchone()
            tier_rows = run(
                """SELECT tier, COUNT(*) AS calls
                   FROM aios_llm_telemetry
                   WHERE tenant = ? AND created_at >= ?
                   GROUP BY tier""",
                (tenant, since),
            ).fetchall()
            provider_rows = run(
                """SELECT provider,
                          COUNT(*) AS calls,
                          COALESCE(SUM(estimated_usd), 0.0) AS estimated_usd,
                          COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                          COALESCE(SUM(cache_hit_tokens), 0) AS cache_hit_tokens,
                          COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
                          COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
                          COALESCE(SUM(latency_ms), 0.0) AS latency_sum
                   FROM aios_llm_telemetry
                   WHERE tenant = ? AND created_at >= ?
                   GROUP BY provider
                   ORDER BY provider ASC""",
                (tenant, since),
            ).fetchall()
            subject_rows = run(
                """SELECT subject,
                          COUNT(*) AS calls,
                          COALESCE(SUM(estimated_usd), 0.0) AS estimated_usd,
                          COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                          COALESCE(SUM(cache_hit_tokens), 0) AS cache_hit_tokens,
                          COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
                          COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
                          COALESCE(SUM(latency_ms), 0.0) AS latency_sum
                   FROM aios_llm_telemetry
                   WHERE tenant = ? AND created_at >= ?
                   GROUP BY subject
                   ORDER BY subject ASC""",
                (tenant, since),
            ).fetchall()
            savings_rows = run(
                """SELECT provider, model, COALESCE(SUM(cache_hit_tokens), 0) AS cache_hit_tokens
                   FROM aios_llm_telemetry
                   WHERE tenant = ? AND created_at >= ? AND cache_hit_tokens > 0
                   GROUP BY provider, model""",
                (tenant, since),
            ).fetchall()
            latency_rows = run(
                """SELECT latency_ms
                   FROM aios_llm_telemetry
                   WHERE tenant = ? AND created_at >= ?
                   ORDER BY created_at DESC
                   LIMIT 2000""",
                (tenant, since),
            ).fetchall()

        total_calls = int(totals_row["total_calls"] or 0) if totals_row else 0
        total_prompt = int(totals_row["total_prompt"] or 0) if totals_row else 0
        total_cache = int(totals_row["total_cache"] or 0) if totals_row else 0
        total_reasoning = int(totals_row["total_reasoning"] or 0) if totals_row else 0
        total_completion = int(totals_row["total_completion"] or 0) if totals_row else 0
        total_usd = float(totals_row["total_usd"] or 0.0) if totals_row else 0.0
        total_latency = float(totals_row["total_latency"] or 0.0) if totals_row else 0.0
        error_calls = int(totals_row["error_calls"] or 0) if totals_row else 0
        failover_count = int(totals_row["failover_count"] or 0) if totals_row else 0

        by_tier: dict[str, int] = {"T0": 0, "T1": 0, "T2": 0, "T3": 0}
        for row in tier_rows:
            tier_key = str(row["tier"])
            if tier_key in by_tier:
                by_tier[tier_key] = int(row["calls"] or 0)

        total_cache_savings_usd = 0.0
        for row in savings_rows:
            ch = int(row["cache_hit_tokens"] or 0)
            if ch <= 0:
                continue
            prof = resolve_model_profile(
                str(row["model"] or ""),
                provider=str(row["provider"] or "") or None,
            )
            savings_rate = max(0.0, prof.input_per_1m - prof.cached_input_per_1m) / 1_000_000.0
            total_cache_savings_usd += ch * savings_rate

        latencies = sorted(float(r["latency_ms"] or 0.0) for r in latency_rows)

        def _format_buckets(rows: list[Any], key_col: str) -> dict[str, dict[str, Any]]:
            out: dict[str, dict[str, Any]] = {}
            for row in rows:
                k = str(row[key_col])
                calls = int(row["calls"] or 0)
                b_prompt = int(row["prompt_tokens"] or 0)
                b_cache = int(row["cache_hit_tokens"] or 0)
                lat_sum = float(row["latency_sum"] or 0.0)
                out[k] = {
                    "calls": calls,
                    "estimated_usd": round(float(row["estimated_usd"] or 0.0), 6),
                    "prompt_tokens": b_prompt,
                    "cache_hit_tokens": b_cache,
                    "reasoning_tokens": int(row["reasoning_tokens"] or 0),
                    "completion_tokens": int(row["completion_tokens"] or 0),
                    "avg_latency_ms": round(lat_sum / calls, 2) if calls > 0 else 0.0,
                    "cache_hit_ratio": round(b_cache / b_prompt, 4) if b_prompt > 0 else 0.0,
                }
            return out

        return {
            "window_hours": window_hours,
            "total_calls": total_calls,
            "cache_hit_ratio": round(total_cache / total_prompt, 4) if total_prompt > 0 else 0.0,
            "total_prompt_tokens": total_prompt,
            "total_cache_hit_tokens": total_cache,
            "total_reasoning_tokens": total_reasoning,
            "total_completion_tokens": total_completion,
            "total_estimated_usd": round(total_usd, 6),
            "avg_latency_ms": round(total_latency / total_calls, 2) if total_calls > 0 else 0.0,
            "p50_latency_ms": self._percentile(latencies, 0.50),
            "p95_latency_ms": self._percentile(latencies, 0.95),
            "error_rate": round(error_calls / total_calls, 4) if total_calls > 0 else 0.0,
            "failover_count": failover_count,
            "estimated_cache_savings_usd": round(total_cache_savings_usd, 6),
            "by_tier": by_tier,
            "by_provider": _format_buckets(provider_rows, "provider"),
            "by_subject": _format_buckets(subject_rows, "subject"),
        }


class BudgetReservation(Strict):
    tenant: str
    id: str
    subject: str
    role: str
    day_key: str
    reserved_micro_usd: int = 0
    actual_micro_usd: int = 0
    reserved_tokens: int = 0
    actual_tokens: int = 0
    status: Literal["reserved", "settled", "released"] = "reserved"
    expires_at: float
    created_at: float
    settled_at: float | None = None


class QuotaCheckResult(Strict):
    allowed: bool
    exceeded_scope: str | None = None
    limit_kind: Literal["usd", "tokens"] | None = None
    used: float = 0.0
    limit: float | None = None
    soft_cap_active: bool = False
    utilization_ratio: float = 0.0
    recommended_max_tier: RoutingTier | None = None
    reservation_id: str | None = None


class TenantProviderPolicyStore:
    """Tenant-scoped LLM provider allowlist, data residency region, and tier policy store."""

    DEFAULT_ALLOWED_PROVIDERS: tuple[str, ...] = ("deepseek", "qwen", "openai", "anthropic", "gemini")
    DEFAULT_ALLOWED_REGIONS: tuple[str, ...] = ("global", "cn-hk", "ap-east-1", "us")
    DEFAULT_BLOCKED_DATA_CLASSES: tuple[str, ...] = ("restricted_pii",)
    VALID_PROVIDERS: frozenset[str] = frozenset({"deepseek", "qwen", "openai", "anthropic", "gemini", "openai_compat"})
    VALID_TIERS: frozenset[str] = frozenset({"T0", "T1", "T2", "T3"})
    _REGION_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")
    _DATA_CLASS_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")

    def __init__(self, workflow):
        self.workflow = workflow

    @classmethod
    def _default_policy(cls, tenant: str) -> dict[str, Any]:
        return {
            "tenant": str(tenant),
            "allowed_providers": list(cls.DEFAULT_ALLOWED_PROVIDERS),
            "allowed_regions": list(cls.DEFAULT_ALLOWED_REGIONS),
            "blocked_data_classes": list(cls.DEFAULT_BLOCKED_DATA_CLASSES),
            "allow_failover": True,
            "max_tier": "T3",
            "pricing_version": "2026-11-official",
            "updated_by": "default",
            "updated_at": None,
        }

    @staticmethod
    def _row_to_policy(row: Any) -> dict[str, Any]:
        return {
            "tenant": str(row["tenant"]),
            "allowed_providers": [str(x) for x in json.loads(row["allowed_providers_json"] or "[]")],
            "allowed_regions": [str(x) for x in json.loads(row["allowed_regions_json"] or "[]")],
            "blocked_data_classes": [str(x) for x in json.loads(row["blocked_data_classes_json"] or "[]")],
            "allow_failover": bool(int(row["allow_failover"] if row["allow_failover"] is not None else 1)),
            "max_tier": str(row["max_tier"] or "T3"),
            "pricing_version": str(row["pricing_version"] or "2026-11-official"),
            "updated_by": str(row["updated_by"] or "admin"),
            "updated_at": float(row["updated_at"]) if row["updated_at"] is not None else None,
        }

    def get_policy(self, tenant_or_actor: str | Actor) -> dict[str, Any]:
        tenant = tenant_or_actor.tenant if isinstance(tenant_or_actor, Actor) else str(tenant_or_actor)
        with self.workflow.tx(tenant, write=False, bounded=True) as run:
            _ensure_enterprise_finops_tables_sqlite(self.workflow, run)
            row = run(
                """SELECT tenant, allowed_providers_json, allowed_regions_json,
                          blocked_data_classes_json, allow_failover, max_tier,
                          pricing_version, updated_by, updated_at
                   FROM aios_tenant_provider_policy
                   WHERE tenant = ?""",
                (tenant,),
            ).fetchone()
        if row is None:
            return self._default_policy(tenant)
        return self._row_to_policy(row)

    def upsert_policy(
        self,
        actor_or_tenant: Actor | str,
        *,
        allowed_providers: list[str] | tuple[str, ...] | set[str] | None = None,
        allowed_regions: list[str] | tuple[str, ...] | set[str] | None = None,
        blocked_data_classes: list[str] | tuple[str, ...] | set[str] | None = None,
        allow_failover: bool | None = None,
        max_tier: str | None = None,
        pricing_version: str | None = None,
        updated_by: str | None = None,
    ) -> dict[str, Any]:
        if isinstance(actor_or_tenant, Actor):
            tenant = actor_or_tenant.tenant
            updater = updated_by or actor_or_tenant.subject
        else:
            tenant = str(actor_or_tenant)
            updater = updated_by or "admin"

        current = self.get_policy(tenant)

        if allowed_providers is not None:
            providers_clean = list(dict.fromkeys(str(p).strip().lower() for p in allowed_providers if str(p).strip()))
            if not providers_clean:
                raise ValueError("allowed_providers must not be empty")
            for p in providers_clean:
                if p not in self.VALID_PROVIDERS:
                    raise ValueError(f"Unsupported provider '{p}' in allowed_providers")
        else:
            providers_clean = list(current["allowed_providers"])

        if allowed_regions is not None:
            regions_clean = list(dict.fromkeys(str(r).strip().lower() for r in allowed_regions if str(r).strip()))
            if not regions_clean:
                raise ValueError("allowed_regions must not be empty")
            for r in regions_clean:
                if not self._REGION_RE.fullmatch(r):
                    raise ValueError(f"Invalid region '{r}' in allowed_regions")
        else:
            regions_clean = list(current["allowed_regions"])

        if blocked_data_classes is not None:
            classes_clean = list(dict.fromkeys(str(c).strip().lower() for c in blocked_data_classes if str(c).strip()))
            for c in classes_clean:
                if not self._DATA_CLASS_RE.fullmatch(c):
                    raise ValueError(f"Invalid data class '{c}' in blocked_data_classes")
        else:
            classes_clean = list(current["blocked_data_classes"])

        resolved_failover = bool(current["allow_failover"]) if allow_failover is None else bool(allow_failover)
        resolved_tier = str(current["max_tier"]) if max_tier is None else str(max_tier).strip().upper()
        if resolved_tier not in self.VALID_TIERS:
            raise ValueError("max_tier must be one of T0, T1, T2, T3")

        resolved_pricing = str(current["pricing_version"]) if pricing_version is None else str(pricing_version).strip()
        if not resolved_pricing or len(resolved_pricing) > 64:
            raise ValueError("pricing_version must be between 1 and 64 characters")

        now_ts = time.time()
        with self.workflow.tx(tenant, write=True, bounded=True) as run:
            _ensure_enterprise_finops_tables_sqlite(self.workflow, run)
            run(
                """INSERT INTO aios_tenant_provider_policy
                   (tenant, allowed_providers_json, allowed_regions_json, blocked_data_classes_json,
                    allow_failover, max_tier, pricing_version, updated_by, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT (tenant) DO UPDATE SET
                       allowed_providers_json = excluded.allowed_providers_json,
                       allowed_regions_json = excluded.allowed_regions_json,
                       blocked_data_classes_json = excluded.blocked_data_classes_json,
                       allow_failover = excluded.allow_failover,
                       max_tier = excluded.max_tier,
                       pricing_version = excluded.pricing_version,
                       updated_by = excluded.updated_by,
                       updated_at = excluded.updated_at""",
                (
                    tenant,
                    json.dumps(providers_clean),
                    json.dumps(regions_clean),
                    json.dumps(classes_clean),
                    1 if resolved_failover else 0,
                    resolved_tier,
                    resolved_pricing,
                    updater,
                    now_ts,
                ),
            )
        return {
            "tenant": tenant,
            "allowed_providers": providers_clean,
            "allowed_regions": regions_clean,
            "blocked_data_classes": classes_clean,
            "allow_failover": resolved_failover,
            "max_tier": resolved_tier,
            "pricing_version": resolved_pricing,
            "updated_by": updater,
            "updated_at": now_ts,
        }

    def is_provider_allowed(
        self,
        tenant: str,
        profile: ModelProfile,
        *,
        data_class: str = "internal",
        is_failover: bool = False,
    ) -> bool:
        policy = self.get_policy(tenant)
        if is_failover and not bool(policy.get("allow_failover", True)):
            return False
        dc = (data_class or "internal").strip().lower()
        if dc in {str(c).lower() for c in policy.get("blocked_data_classes", ())}:
            return False
        prov = (profile.provider or "").strip().lower()
        if prov not in {str(p).lower() for p in policy.get("allowed_providers", ())}:
            return False
        region = (getattr(profile, "region", None) or "global").strip().lower()
        if region not in {str(r).lower() for r in policy.get("allowed_regions", ())}:
            return False
        return True


class QuotaManager:
    """Tenant-, role-, and subject-scoped daily cost and token budget policy manager."""

    def __init__(self, workflow):
        self.workflow = workflow

    def list_policies(self, tenant_or_actor: str | Actor) -> list[dict[str, Any]]:
        tenant = tenant_or_actor.tenant if isinstance(tenant_or_actor, Actor) else str(tenant_or_actor)
        with self.workflow.tx(tenant, write=False, bounded=True) as run:
            _ensure_routing_tables_sqlite(self.workflow, run)
            rows = run(
                """SELECT tenant, scope_type, scope_key, daily_usd_limit,
                          daily_token_limit, updated_by, updated_at
                   FROM aios_quota_policy
                   WHERE tenant = ?
                   ORDER BY scope_type, scope_key""",
                (tenant,),
            ).fetchall()
        return [
            {
                "tenant": r["tenant"],
                "scope_type": r["scope_type"],
                "scope_key": r["scope_key"],
                "daily_usd_limit": float(r["daily_usd_limit"]) if r["daily_usd_limit"] is not None else None,
                "daily_token_limit": int(r["daily_token_limit"]) if r["daily_token_limit"] is not None else None,
                "updated_by": r["updated_by"],
                "updated_at": float(r["updated_at"]),
            }
            for r in rows
        ]

    def upsert_policy(
        self,
        actor_or_tenant: Actor | str,
        scope_type: str,
        scope_key: str,
        daily_usd_limit: float | None = None,
        daily_token_limit: int | None = None,
        updated_by: str | None = None,
    ) -> dict[str, Any]:
        if scope_type not in {"tenant", "role", "subject"}:
            raise ValueError("scope_type must be one of tenant, role, subject")
        clean_key = (scope_key or "").strip()
        if not clean_key or len(clean_key) > 150:
            raise ValueError("scope_key must be between 1 and 150 characters")
        if daily_usd_limit is not None and float(daily_usd_limit) < 0:
            raise ValueError("daily_usd_limit cannot be negative")
        if daily_token_limit is not None and int(daily_token_limit) < 0:
            raise ValueError("daily_token_limit cannot be negative")

        if isinstance(actor_or_tenant, Actor):
            tenant = actor_or_tenant.tenant
            updater = updated_by or actor_or_tenant.subject
        else:
            tenant = str(actor_or_tenant)
            updater = updated_by or "admin"

        now = time.time()
        usd_val = float(daily_usd_limit) if daily_usd_limit is not None else None
        tok_val = int(daily_token_limit) if daily_token_limit is not None else None

        with self.workflow.tx(tenant, write=True, bounded=True) as run:
            _ensure_routing_tables_sqlite(self.workflow, run)
            _ensure_enterprise_finops_tables_sqlite(self.workflow, run)
            run(
                """INSERT INTO aios_quota_policy
                   (tenant, scope_type, scope_key, daily_usd_limit, daily_token_limit, updated_by, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT (tenant, scope_type, scope_key) DO UPDATE SET
                       daily_usd_limit = excluded.daily_usd_limit,
                       daily_token_limit = excluded.daily_token_limit,
                       updated_by = excluded.updated_by,
                       updated_at = excluded.updated_at""",
                (tenant, scope_type, clean_key, usd_val, tok_val, updater, now),
            )
        return {
            "tenant": tenant,
            "scope_type": scope_type,
            "scope_key": clean_key,
            "daily_usd_limit": usd_val,
            "daily_token_limit": tok_val,
            "updated_by": updater,
            "updated_at": now,
        }

    @staticmethod
    def _fetch_matching_policies(run, actor: Actor) -> list[Any]:
        return run(
            """SELECT scope_type, scope_key, daily_usd_limit, daily_token_limit
               FROM aios_quota_policy
               WHERE tenant = ?
                 AND ((scope_type = 'tenant' AND scope_key = ?)
                   OR (scope_type = 'role' AND scope_key = ?)
                   OR (scope_type = 'subject' AND scope_key = ?))""",
            (actor.tenant, actor.tenant, actor.role, actor.subject),
        ).fetchall()

    @staticmethod
    def _fetch_telemetry_usage(run, actor: Actor, day_start: float) -> dict[str, tuple[int, int]]:
        agg = run(
            """SELECT COALESCE(SUM(estimated_usd), 0) AS tenant_usd,
                      COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tenant_toks,
                      COALESCE(SUM(CASE WHEN role = ? THEN estimated_usd ELSE 0 END), 0) AS role_usd,
                      COALESCE(SUM(CASE WHEN role = ? THEN prompt_tokens + completion_tokens ELSE 0 END), 0) AS role_toks,
                      COALESCE(SUM(CASE WHEN subject = ? THEN estimated_usd ELSE 0 END), 0) AS subject_usd,
                      COALESCE(SUM(CASE WHEN subject = ? THEN prompt_tokens + completion_tokens ELSE 0 END), 0) AS subject_toks
               FROM aios_llm_telemetry
               WHERE tenant = ? AND created_at >= ?""",
            (actor.role, actor.role, actor.subject, actor.subject, actor.tenant, day_start),
        ).fetchone()
        return {
            "tenant": (int(round(float(agg["tenant_usd"] or 0.0) * 1_000_000)), int(agg["tenant_toks"] or 0)),
            "role": (int(round(float(agg["role_usd"] or 0.0) * 1_000_000)), int(agg["role_toks"] or 0)),
            "subject": (int(round(float(agg["subject_usd"] or 0.0) * 1_000_000)), int(agg["subject_toks"] or 0)),
        }

    @staticmethod
    def _fetch_reservation_usage(
        run, actor: Actor, day_key: str, now_ts: float
    ) -> tuple[dict[str, tuple[int, int]], dict[str, tuple[int, int]]]:
        row = run(
            """SELECT COALESCE(SUM(CASE WHEN status = 'reserved' AND expires_at > ? THEN reserved_micro_usd ELSE 0 END), 0) AS tenant_res_micro,
                      COALESCE(SUM(CASE WHEN status = 'reserved' AND expires_at > ? THEN reserved_tokens ELSE 0 END), 0) AS tenant_res_toks,
                      COALESCE(SUM(CASE WHEN status = 'settled' THEN actual_micro_usd ELSE 0 END), 0) AS tenant_set_micro,
                      COALESCE(SUM(CASE WHEN status = 'settled' THEN actual_tokens ELSE 0 END), 0) AS tenant_set_toks,
                      COALESCE(SUM(CASE WHEN status = 'reserved' AND expires_at > ? AND role = ? THEN reserved_micro_usd ELSE 0 END), 0) AS role_res_micro,
                      COALESCE(SUM(CASE WHEN status = 'reserved' AND expires_at > ? AND role = ? THEN reserved_tokens ELSE 0 END), 0) AS role_res_toks,
                      COALESCE(SUM(CASE WHEN status = 'settled' AND role = ? THEN actual_micro_usd ELSE 0 END), 0) AS role_set_micro,
                      COALESCE(SUM(CASE WHEN status = 'settled' AND role = ? THEN actual_tokens ELSE 0 END), 0) AS role_set_toks,
                      COALESCE(SUM(CASE WHEN status = 'reserved' AND expires_at > ? AND subject = ? THEN reserved_micro_usd ELSE 0 END), 0) AS subject_res_micro,
                      COALESCE(SUM(CASE WHEN status = 'reserved' AND expires_at > ? AND subject = ? THEN reserved_tokens ELSE 0 END), 0) AS subject_res_toks,
                      COALESCE(SUM(CASE WHEN status = 'settled' AND subject = ? THEN actual_micro_usd ELSE 0 END), 0) AS subject_set_micro,
                      COALESCE(SUM(CASE WHEN status = 'settled' AND subject = ? THEN actual_tokens ELSE 0 END), 0) AS subject_set_toks
               FROM aios_budget_reservation
               WHERE tenant = ? AND day_key = ?""",
            (
                now_ts,
                now_ts,
                now_ts,
                actor.role,
                now_ts,
                actor.role,
                actor.role,
                actor.role,
                now_ts,
                actor.subject,
                now_ts,
                actor.subject,
                actor.subject,
                actor.subject,
                actor.tenant,
                day_key,
            ),
        ).fetchone()
        reserved = {
            "tenant": (int(row["tenant_res_micro"] or 0), int(row["tenant_res_toks"] or 0)),
            "role": (int(row["role_res_micro"] or 0), int(row["role_res_toks"] or 0)),
            "subject": (int(row["subject_res_micro"] or 0), int(row["subject_res_toks"] or 0)),
        }
        settled = {
            "tenant": (int(row["tenant_set_micro"] or 0), int(row["tenant_set_toks"] or 0)),
            "role": (int(row["role_set_micro"] or 0), int(row["role_set_toks"] or 0)),
            "subject": (int(row["subject_set_micro"] or 0), int(row["subject_set_toks"] or 0)),
        }
        return reserved, settled

    @staticmethod
    def _evaluate_policies(
        policies: list[Any],
        usage_by_scope: dict[str, tuple[int, int]],
        *,
        est_micro_usd: int = 0,
        est_tokens: int = 0,
    ) -> QuotaCheckResult:
        max_ratio = 0.0
        for pol in policies:
            stype, skey = str(pol["scope_type"]), str(pol["scope_key"])
            used_micro, used_toks = usage_by_scope[stype]
            usd_limit = pol["daily_usd_limit"]
            tok_limit = pol["daily_token_limit"]
            if usd_limit is not None:
                lim_usd = float(usd_limit)
                lim_micro = int(round(lim_usd * 1_000_000))
                if used_micro >= lim_micro or (est_micro_usd > 0 and (used_micro + est_micro_usd) > lim_micro):
                    ratio = round(used_micro / lim_micro, 4) if lim_micro > 0 else 1.0
                    return QuotaCheckResult(
                        allowed=False,
                        exceeded_scope=f"{stype}:{skey}",
                        limit_kind="usd",
                        used=round(used_micro / 1_000_000.0, 6),
                        limit=lim_usd,
                        utilization_ratio=ratio,
                    )
                if lim_micro > 0:
                    max_ratio = max(max_ratio, used_micro / lim_micro)
            if tok_limit is not None:
                lim_tok = int(tok_limit)
                if used_toks >= lim_tok or (est_tokens > 0 and (used_toks + est_tokens) > lim_tok):
                    ratio = round(used_toks / lim_tok, 4) if lim_tok > 0 else 1.0
                    return QuotaCheckResult(
                        allowed=False,
                        exceeded_scope=f"{stype}:{skey}",
                        limit_kind="tokens",
                        used=float(used_toks),
                        limit=float(lim_tok),
                        utilization_ratio=ratio,
                    )
                if lim_tok > 0:
                    max_ratio = max(max_ratio, used_toks / lim_tok)

        soft_cap = max_ratio >= 0.80
        return QuotaCheckResult(
            allowed=True,
            soft_cap_active=soft_cap,
            utilization_ratio=round(max_ratio, 4),
            recommended_max_tier="T1" if soft_cap else None,
        )

    def check_quota(self, actor: Actor, *, now: float | None = None) -> QuotaCheckResult:
        now_ts = time.time() if now is None else float(now)
        day_start = datetime.fromtimestamp(now_ts, HK_TZ).replace(
            hour=0, minute=0, second=0, microsecond=0
        ).timestamp()

        with self.workflow.tx(actor.tenant, write=False, bounded=True) as run:
            _ensure_routing_tables_sqlite(self.workflow, run)
            policies = self._fetch_matching_policies(run, actor)
            if not policies:
                return QuotaCheckResult(allowed=True)
            usage_by_scope = self._fetch_telemetry_usage(run, actor, day_start)
        return self._evaluate_policies(policies, usage_by_scope)

    def reserve_budget(
        self,
        actor: Actor,
        *,
        estimated_micro_usd: int,
        estimated_tokens: int,
        ttl_s: float = 120.0,
        now: float | None = None,
    ) -> QuotaCheckResult:
        """Atomically check daily quota + active reservations and insert a bounded reservation."""
        now_ts = time.time() if now is None else float(now)
        dt_hk = datetime.fromtimestamp(now_ts, HK_TZ)
        day_start = dt_hk.replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
        day_key = dt_hk.strftime("%Y-%m-%d")
        est_micro = max(0, int(estimated_micro_usd))
        est_toks = max(0, int(estimated_tokens))

        with self.workflow.tx(actor.tenant, write=True, bounded=False) as run:
            _ensure_routing_tables_sqlite(self.workflow, run)
            _ensure_enterprise_finops_tables_sqlite(self.workflow, run)
            if getattr(self.workflow.db, "dsn", None):
                run("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", (canonical(["quota-reserve", actor.tenant]),))

            policies = self._fetch_matching_policies(run, actor)
            if not policies:
                return QuotaCheckResult(allowed=True)

            tel_usage = self._fetch_telemetry_usage(run, actor, day_start)
            res_usage, set_usage = self._fetch_reservation_usage(run, actor, day_key, now_ts)
            combined_usage: dict[str, tuple[int, int]] = {}
            for scope in ("tenant", "role", "subject"):
                t_micro, t_tok = tel_usage[scope]
                s_micro, s_tok = set_usage[scope]
                r_micro, r_tok = res_usage[scope]
                combined_usage[scope] = (max(t_micro, s_micro) + r_micro, max(t_tok, s_tok) + r_tok)

            verdict = self._evaluate_policies(
                policies,
                combined_usage,
                est_micro_usd=est_micro,
                est_tokens=est_toks,
            )
            if not verdict.allowed:
                return verdict

            res_id = uuid4().hex
            expires_at = now_ts + max(1.0, float(ttl_s))
            run(
                """INSERT INTO aios_budget_reservation
                   (tenant, id, subject, role, day_key, reserved_micro_usd, actual_micro_usd,
                    reserved_tokens, actual_tokens, status, expires_at, created_at, settled_at)
                   VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0, 'reserved', ?, ?, NULL)""",
                (
                    actor.tenant,
                    res_id,
                    actor.subject,
                    actor.role,
                    day_key,
                    est_micro,
                    est_toks,
                    expires_at,
                    now_ts,
                ),
            )
            return verdict.model_copy(update={"reservation_id": res_id})

    def settle_budget(
        self,
        tenant: str,
        reservation_id: str | None,
        *,
        actual_micro_usd: int,
        actual_tokens: int,
        now: float | None = None,
    ) -> None:
        if not reservation_id:
            return
        now_ts = time.time() if now is None else float(now)
        with self.workflow.tx(tenant, write=True, bounded=False) as run:
            _ensure_enterprise_finops_tables_sqlite(self.workflow, run)
            run(
                """UPDATE aios_budget_reservation
                   SET status = 'settled',
                       actual_micro_usd = ?,
                       actual_tokens = ?,
                       settled_at = ?
                   WHERE tenant = ? AND id = ? AND status = 'reserved'""",
                (
                    max(0, int(actual_micro_usd)),
                    max(0, int(actual_tokens)),
                    now_ts,
                    tenant,
                    reservation_id,
                ),
            )

    def release_budget(self, tenant: str, reservation_id: str | None) -> None:
        if not reservation_id:
            return
        now_ts = time.time()
        with self.workflow.tx(tenant, write=True, bounded=False) as run:
            _ensure_enterprise_finops_tables_sqlite(self.workflow, run)
            run(
                """UPDATE aios_budget_reservation
                   SET status = 'released',
                       settled_at = ?
                   WHERE tenant = ? AND id = ? AND status = 'reserved'""",
                (now_ts, tenant, reservation_id),
            )
