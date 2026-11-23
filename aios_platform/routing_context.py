"""Deterministic <2ms effort router, 4-zone dual-bucket context manager, MapReduce doc analyzer, telemetry, and quota."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
import re
import time
from typing import Any, Callable, Literal
from uuid import uuid4

from pydantic import Field

from .contracts import Actor, Strict
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


def _ensure_routing_tables_sqlite(workflow, run) -> None:
    if getattr(workflow.db, "dsn", None):
        return
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


class ActiveDocumentInput(Strict):
    doc_id: str
    title: str
    content: str


class ZoneAssembly(Strict):
    messages: list[dict[str, Any]]
    sorted_tool_schemas: list[dict[str, Any]]
    zone1_tokens: int
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
        active_document: ActiveDocumentInput | None = None,
        task_switched: bool = False,
        now: float | None = None,
    ) -> ZoneAssembly:
        """Assemble Zone 1 (immutable) + Zone 1.5 (doc slot) + Zone 2 (trajectory) + Zone 3 (ephemeral pulse)."""
        ts = time.time() if now is None else now
        sorted_schemas = self.zone1_tool_schemas(tool_schemas)
        zone1_tokens = approx_tokens(system_prompt) + approx_tokens(sorted_schemas)

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
        messages.extend(zone1_5_messages)
        messages.extend(zone2_messages)
        messages.append({"role": "user", "content": zone3_content})

        return ZoneAssembly(
            messages=messages,
            sorted_tool_schemas=sorted_schemas,
            zone1_tokens=zone1_tokens,
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

    def summary(self, tenant: str, hours: int = 24) -> dict[str, Any]:
        window_hours = max(1, min(int(hours), 720))
        since = time.time() - window_hours * 3600.0
        with self.workflow.tx(tenant, write=False, bounded=True) as run:
            _ensure_routing_tables_sqlite(self.workflow, run)
            rows = run(
                """SELECT subject, provider, tier, prompt_tokens, cache_hit_tokens,
                          reasoning_tokens, completion_tokens, estimated_usd, latency_ms
                   FROM aios_llm_telemetry
                   WHERE tenant = ? AND created_at >= ?""",
                (tenant, since),
            ).fetchall()

        total_calls = len(rows)
        total_prompt = 0
        total_cache = 0
        total_reasoning = 0
        total_completion = 0
        total_usd = 0.0
        total_latency = 0.0
        by_tier: dict[str, int] = {"T0": 0, "T1": 0, "T2": 0, "T3": 0}
        provider_buckets: dict[str, dict[str, Any]] = {}
        subject_buckets: dict[str, dict[str, Any]] = {}

        def _acc(bucket: dict[str, dict[str, Any]], key: str, row_dict: dict[str, Any]) -> None:
            entry = bucket.setdefault(
                key,
                {
                    "calls": 0,
                    "estimated_usd": 0.0,
                    "prompt_tokens": 0,
                    "cache_hit_tokens": 0,
                    "reasoning_tokens": 0,
                    "completion_tokens": 0,
                    "_latency_sum": 0.0,
                },
            )
            entry["calls"] += 1
            entry["prompt_tokens"] += int(row_dict["prompt_tokens"] or 0)
            entry["cache_hit_tokens"] += int(row_dict["cache_hit_tokens"] or 0)
            entry["reasoning_tokens"] += int(row_dict["reasoning_tokens"] or 0)
            entry["completion_tokens"] += int(row_dict["completion_tokens"] or 0)
            entry["estimated_usd"] += float(row_dict["estimated_usd"] or 0.0)
            entry["_latency_sum"] += float(row_dict["latency_ms"] or 0.0)

        for row in rows:
            rd = dict(row)
            pt = int(rd["prompt_tokens"] or 0)
            ch = int(rd["cache_hit_tokens"] or 0)
            rt = int(rd["reasoning_tokens"] or 0)
            ct = int(rd["completion_tokens"] or 0)
            usd = float(rd["estimated_usd"] or 0.0)
            lat = float(rd["latency_ms"] or 0.0)
            total_prompt += pt
            total_cache += ch
            total_reasoning += rt
            total_completion += ct
            total_usd += usd
            total_latency += lat
            tier = str(rd["tier"])
            if tier in by_tier:
                by_tier[tier] += 1
            _acc(provider_buckets, str(rd["provider"]), rd)
            _acc(subject_buckets, str(rd["subject"]), rd)

        def _finalize(buckets: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
            out: dict[str, dict[str, Any]] = {}
            for k, v in sorted(buckets.items()):
                calls = v["calls"]
                b_prompt = v["prompt_tokens"]
                b_cache = v["cache_hit_tokens"]
                out[k] = {
                    "calls": calls,
                    "estimated_usd": round(v["estimated_usd"], 6),
                    "prompt_tokens": b_prompt,
                    "cache_hit_tokens": b_cache,
                    "reasoning_tokens": v["reasoning_tokens"],
                    "completion_tokens": v["completion_tokens"],
                    "avg_latency_ms": round(v["_latency_sum"] / calls, 2) if calls > 0 else 0.0,
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
            "by_tier": by_tier,
            "by_provider": _finalize(provider_buckets),
            "by_subject": _finalize(subject_buckets),
        }


class QuotaCheckResult(Strict):
    allowed: bool
    exceeded_scope: str | None = None
    limit_kind: Literal["usd", "tokens"] | None = None
    used: float = 0.0
    limit: float | None = None


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

    def check_quota(self, actor: Actor, *, now: float | None = None) -> QuotaCheckResult:
        now_ts = time.time() if now is None else now
        day_start = datetime.fromtimestamp(now_ts, HK_TZ).replace(
            hour=0, minute=0, second=0, microsecond=0
        ).timestamp()

        with self.workflow.tx(actor.tenant, write=False, bounded=True) as run:
            _ensure_routing_tables_sqlite(self.workflow, run)
            policies = run(
                """SELECT scope_type, scope_key, daily_usd_limit, daily_token_limit
                   FROM aios_quota_policy
                   WHERE tenant = ?
                     AND ((scope_type = 'tenant' AND scope_key = ?)
                       OR (scope_type = 'role' AND scope_key = ?)
                       OR (scope_type = 'subject' AND scope_key = ?))""",
                (actor.tenant, actor.tenant, actor.role, actor.subject),
            ).fetchall()
            if not policies:
                return QuotaCheckResult(allowed=True)

            usage_by_scope: dict[tuple[str, str], tuple[float, int]] = {}
            for pol in policies:
                stype, skey = pol["scope_type"], pol["scope_key"]
                if stype == "tenant":
                    agg = run(
                        """SELECT COALESCE(SUM(estimated_usd), 0) AS usd,
                                  COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS toks
                           FROM aios_llm_telemetry
                           WHERE tenant = ? AND created_at >= ?""",
                        (actor.tenant, day_start),
                    ).fetchone()
                elif stype == "role":
                    agg = run(
                        """SELECT COALESCE(SUM(estimated_usd), 0) AS usd,
                                  COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS toks
                           FROM aios_llm_telemetry
                           WHERE tenant = ? AND role = ? AND created_at >= ?""",
                        (actor.tenant, skey, day_start),
                    ).fetchone()
                else:
                    agg = run(
                        """SELECT COALESCE(SUM(estimated_usd), 0) AS usd,
                                  COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS toks
                           FROM aios_llm_telemetry
                           WHERE tenant = ? AND subject = ? AND created_at >= ?""",
                        (actor.tenant, skey, day_start),
                    ).fetchone()
                usage_by_scope[(stype, skey)] = (float(agg["usd"] or 0.0), int(agg["toks"] or 0))

        for pol in policies:
            stype, skey = pol["scope_type"], pol["scope_key"]
            usd_used, toks_used = usage_by_scope[(stype, skey)]
            usd_limit = pol["daily_usd_limit"]
            tok_limit = pol["daily_token_limit"]
            if usd_limit is not None and usd_used >= float(usd_limit):
                return QuotaCheckResult(
                    allowed=False,
                    exceeded_scope=f"{stype}:{skey}",
                    limit_kind="usd",
                    used=round(usd_used, 6),
                    limit=float(usd_limit),
                )
            if tok_limit is not None and toks_used >= int(tok_limit):
                return QuotaCheckResult(
                    allowed=False,
                    exceeded_scope=f"{stype}:{skey}",
                    limit_kind="tokens",
                    used=float(toks_used),
                    limit=float(tok_limit),
                )
        return QuotaCheckResult(allowed=True)
