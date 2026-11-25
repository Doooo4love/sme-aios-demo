"""Pure httpx + pydantic multi-provider LLM client with pooled transport, prompt caching, and circuit breaker."""
from __future__ import annotations

from datetime import datetime, timezone
from hashlib import sha256
import importlib
import json
import os
from pathlib import Path
import random
import threading
import time
from typing import Any, Callable, Literal

import httpx
from pydantic import Field

from .contracts import Strict
from .providers import https_base

MAX_LLM_RESPONSE_BYTES = 524_288
ANTHROPIC_PROMPT_CACHE_MIN_CHARS = 3600
DEFAULT_LLM_MODEL = "deepseek-flash"
DEFAULT_PRICING_VERSION = "2026-11-official"
EffortLevel = Literal["none", "low", "medium", "high"]
AdapterKind = Literal["openai_compat", "anthropic", "gemini"]

_PRICING_OVERRIDE_LOCK = threading.Lock()
_PRICING_OVERRIDE_CACHE: tuple[str, dict[str, dict[str, Any]]] = ("", {})


def is_peak_pricing_window(now: float | datetime | None = None) -> bool:
    """Return True during Mon-Fri 01:00-04:00 & 06:00-10:00 UTC official peak windows."""
    if now is None:
        dt = datetime.now(timezone.utc)
    elif isinstance(now, datetime):
        dt = now.astimezone(timezone.utc) if now.tzinfo else now.replace(tzinfo=timezone.utc)
    else:
        dt = datetime.fromtimestamp(float(now), timezone.utc)
    if dt.weekday() >= 5:
        return False
    return (1 <= dt.hour < 4) or (6 <= dt.hour < 10)


def _load_pricing_overrides() -> dict[str, dict[str, Any]]:
    raw = (os.getenv("AIOS_MODEL_PRICING_JSON") or "").strip()
    if not raw:
        return {}
    with _PRICING_OVERRIDE_LOCK:
        cached_raw, cached_map = _PRICING_OVERRIDE_CACHE
        if cached_raw == raw:
            return cached_map
    parsed: dict[str, dict[str, Any]] = {}
    try:
        loaded = json.loads(raw)
        if isinstance(loaded, dict):
            for k, v in loaded.items():
                if isinstance(k, str) and isinstance(v, dict):
                    parsed[k.strip()] = dict(v)
    except (ValueError, TypeError):
        parsed = {}
    with _PRICING_OVERRIDE_LOCK:
        globals()["_PRICING_OVERRIDE_CACHE"] = (raw, parsed)
    return parsed

EFFORT_MAX_TOKENS: dict[str, int] = {
    "none": 1200,
    "low": 2400,
    "medium": 4096,
    "high": 8192,
}

EFFORT_TIMEOUT_SECONDS: dict[str, float] = {
    "none": 15.0,
    "low": 22.0,
    "medium": 35.0,
    "high": 55.0,
}

RETRYABLE_STATUS_CODES = frozenset({429, 502, 503, 504})


class LLMProviderError(RuntimeError):
    """Sanitized provider failure carrying non-secret status and error classification."""

    def __init__(self, message: str, *, error_code: str = "PROVIDER_ERROR", status_code: int | None = None):
        super().__init__(message)
        self.error_code = error_code
        self.status_code = status_code


class CircuitOpenError(LLMProviderError):
    """Raised when a provider endpoint circuit breaker is currently open."""

    def __init__(self, provider_key: str):
        super().__init__(f"Provider circuit open for {provider_key}", error_code="CIRCUIT_OPEN", status_code=503)


class NormalizedToolCall(Strict):
    id: str
    name: str
    arguments: dict[str, Any] = Field(default_factory=dict)
    raw_arguments: str = ""
    malformed_arguments: bool = False
    thought_signature: str | None = None


class UsageMetrics(Strict):
    prompt_tokens: int = 0
    cache_hit_tokens: int = 0
    reasoning_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    estimated_usd: float = 0.0


class ChatResult(Strict):
    provider: str
    model: str
    text: str = ""
    tool_calls: list[NormalizedToolCall] = Field(default_factory=list)
    reasoning_content: str | None = None
    thinking_blocks: list[dict[str, Any]] = Field(default_factory=list)
    usage: UsageMetrics = Field(default_factory=UsageMetrics)
    finish_reason: str | None = None
    latency_ms: float = 0.0
    failover_from: str | None = None


class ModelProfile(Strict):
    model_id: str
    provider: str
    adapter_kind: AdapterKind
    default_base_url: str
    context_window: int
    surcharge_cliff: int
    input_per_1m: float
    cached_input_per_1m: float
    output_per_1m: float
    supports_reasoning_effort: bool = True
    supports_prompt_cache: bool = True
    deprecated: bool = False
    region: str = "global"
    pricing_version: str = DEFAULT_PRICING_VERSION
    off_peak_input_per_1m: float | None = None
    off_peak_cached_input_per_1m: float | None = None
    off_peak_output_per_1m: float | None = None

    @property
    def safe_cap_tokens(self) -> int:
        return min(180_000, int(self.surcharge_cliff * 0.90), int(self.context_window * 0.60))

    @staticmethod
    def max_tokens_for_effort(effort: EffortLevel) -> int:
        return EFFORT_MAX_TOKENS[effort]

    @staticmethod
    def timeout_for_effort(effort: EffortLevel) -> float:
        return EFFORT_TIMEOUT_SECONDS[effort]

    def translate_reasoning_effort(self, effort: EffortLevel) -> dict[str, Any]:
        """Translate unified effort level into provider-native reasoning parameters."""
        if self.adapter_kind == "openai_compat":
            if not self.supports_reasoning_effort:
                return {}
            if self.provider == "openai":
                return {"reasoning_effort": effort}
            if effort == "none":
                return {}
            return {"reasoning_effort": effort}

        if self.adapter_kind == "anthropic":
            if effort == "none":
                return {"output_config": {"effort": "low"}}
            budgets = {"low": 1024, "medium": 2048, "high": 4096}
            return {
                "output_config": {"effort": effort},
                "thinking": {"type": "enabled", "budget_tokens": budgets[effort]},
            }

        # Gemini 2.5 Pro thinkingConfig budget mapping.
        gemini_budgets = {"none": 0, "low": 1024, "medium": 4096, "high": 8192}
        return {"thinkingConfig": {"thinkingBudget": gemini_budgets[effort]}}

    def effective_rates(self, now: float | datetime | None = None) -> tuple[float, float, float]:
        """Return (input_per_1m, cached_input_per_1m, output_per_1m) respecting peak/off-peak and env overrides."""
        ov = _load_pricing_overrides().get(self.model_id, {})
        in_rate = float(ov["input_per_1m"]) if "input_per_1m" in ov else self.input_per_1m
        cached_rate = float(ov["cached_input_per_1m"]) if "cached_input_per_1m" in ov else self.cached_input_per_1m
        out_rate = float(ov["output_per_1m"]) if "output_per_1m" in ov else self.output_per_1m

        if is_peak_pricing_window(now):
            return (in_rate, cached_rate, out_rate)

        if "off_peak_input_per_1m" in ov:
            off_in = float(ov["off_peak_input_per_1m"])
        elif "input_per_1m" in ov:
            off_in = in_rate
        else:
            off_in = self.off_peak_input_per_1m if self.off_peak_input_per_1m is not None else in_rate

        if "off_peak_cached_input_per_1m" in ov:
            off_cached = float(ov["off_peak_cached_input_per_1m"])
        elif "cached_input_per_1m" in ov:
            off_cached = cached_rate
        else:
            off_cached = (
                self.off_peak_cached_input_per_1m
                if self.off_peak_cached_input_per_1m is not None
                else cached_rate
            )

        if "off_peak_output_per_1m" in ov:
            off_out = float(ov["off_peak_output_per_1m"])
        elif "output_per_1m" in ov:
            off_out = out_rate
        else:
            off_out = self.off_peak_output_per_1m if self.off_peak_output_per_1m is not None else out_rate

        return (off_in, off_cached, off_out)

    def estimate_cost_usd(
        self,
        *,
        prompt_tokens: int,
        cache_hit_tokens: int,
        completion_tokens: int,
        now: float | datetime | None = None,
    ) -> float:
        in_rate, cached_rate, out_rate = self.effective_rates(now=now)
        uncached_prompt = max(0, prompt_tokens - max(0, cache_hit_tokens))
        cached_prompt = max(0, min(prompt_tokens, cache_hit_tokens))
        output_tokens = max(0, completion_tokens)
        usd = (
            uncached_prompt * in_rate
            + cached_prompt * cached_rate
            + output_tokens * out_rate
        ) / 1_000_000.0
        return round(usd, 8)

    def estimate_cost_micro_usd(
        self,
        *,
        prompt_tokens: int,
        cache_hit_tokens: int,
        completion_tokens: int,
        now: float | datetime | None = None,
    ) -> int:
        """Compute fixed-point integer micro-USD cost (1 USD = 1,000,000 micro-USD)."""
        usd = self.estimate_cost_usd(
            prompt_tokens=prompt_tokens,
            cache_hit_tokens=cache_hit_tokens,
            completion_tokens=completion_tokens,
            now=now,
        )
        return int(round(usd * 1_000_000))


MODEL_PROFILES: dict[str, ModelProfile] = {
    "deepseek-chat": ModelProfile(
        model_id="deepseek-chat",
        provider="deepseek",
        adapter_kind="openai_compat",
        default_base_url="https://api.deepseek.com",
        context_window=128_000,
        surcharge_cliff=128_000,
        input_per_1m=0.27,
        cached_input_per_1m=0.07,
        output_per_1m=1.10,
        supports_reasoning_effort=True,
        deprecated=True,
        region="cn-hk",
        pricing_version=DEFAULT_PRICING_VERSION,
    ),
    "deepseek-flash": ModelProfile(
        model_id="deepseek-flash",
        provider="deepseek",
        adapter_kind="openai_compat",
        default_base_url="https://api.deepseek.com",
        context_window=1_000_000,
        surcharge_cliff=200_000,
        input_per_1m=0.30,
        cached_input_per_1m=0.006,
        output_per_1m=1.20,
        off_peak_input_per_1m=0.15,
        off_peak_cached_input_per_1m=0.003,
        off_peak_output_per_1m=0.60,
        supports_reasoning_effort=True,
        region="cn-hk",
        pricing_version=DEFAULT_PRICING_VERSION,
    ),
    "deepseek-v4-pro": ModelProfile(
        model_id="deepseek-v4-pro",
        provider="deepseek",
        adapter_kind="openai_compat",
        default_base_url="https://api.deepseek.com",
        context_window=1_000_000,
        surcharge_cliff=200_000,
        input_per_1m=1.32,
        cached_input_per_1m=0.044,
        output_per_1m=3.96,
        off_peak_input_per_1m=0.66,
        off_peak_cached_input_per_1m=0.022,
        off_peak_output_per_1m=1.98,
        supports_reasoning_effort=True,
        region="cn-hk",
        pricing_version=DEFAULT_PRICING_VERSION,
    ),
    "gpt-5.4-mini": ModelProfile(
        model_id="gpt-5.4-mini",
        provider="openai",
        adapter_kind="openai_compat",
        default_base_url="https://api.openai.com/v1",
        context_window=400_000,
        surcharge_cliff=200_000,
        input_per_1m=0.25,
        cached_input_per_1m=0.025,
        output_per_1m=2.00,
        supports_reasoning_effort=True,
        region="us",
    ),
    "claude-sonnet-4-6": ModelProfile(
        model_id="claude-sonnet-4-6",
        provider="anthropic",
        adapter_kind="anthropic",
        default_base_url="https://api.anthropic.com",
        context_window=200_000,
        surcharge_cliff=200_000,
        input_per_1m=3.00,
        cached_input_per_1m=0.30,
        output_per_1m=15.00,
        supports_reasoning_effort=True,
        region="us",
    ),
    "gemini-2.5-pro": ModelProfile(
        model_id="gemini-2.5-pro",
        provider="gemini",
        adapter_kind="gemini",
        default_base_url="https://generativelanguage.googleapis.com/v1beta",
        context_window=1_000_000,
        surcharge_cliff=200_000,
        input_per_1m=1.25,
        cached_input_per_1m=0.31,
        output_per_1m=10.00,
        supports_reasoning_effort=True,
        region="us",
    ),
    "qwen-plus": ModelProfile(
        model_id="qwen-plus",
        provider="qwen",
        adapter_kind="openai_compat",
        default_base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        context_window=1_000_000,
        surcharge_cliff=128_000,
        input_per_1m=0.40,
        cached_input_per_1m=0.10,
        output_per_1m=1.20,
        supports_reasoning_effort=True,
        region="ap-east-1",
    ),
}


def _apply_pricing_override(profile: ModelProfile) -> ModelProfile:
    ov = _load_pricing_overrides().get(profile.model_id)
    if not ov:
        return profile
    updates: dict[str, Any] = {}
    for field_name in (
        "input_per_1m",
        "cached_input_per_1m",
        "output_per_1m",
        "off_peak_input_per_1m",
        "off_peak_cached_input_per_1m",
        "off_peak_output_per_1m",
    ):
        if field_name in ov and ov[field_name] is not None:
            updates[field_name] = float(ov[field_name])
    if "pricing_version" in ov and ov["pricing_version"]:
        updates["pricing_version"] = str(ov["pricing_version"])
    if "region" in ov and ov["region"]:
        updates["region"] = str(ov["region"])
    return profile.model_copy(update=updates) if updates else profile


def resolve_model_profile(
    model_id: str,
    *,
    provider: str | None = None,
    base_url: str | None = None,
) -> ModelProfile:
    """Look up a registered ModelProfile or synthesize a safe OpenAI-compatible gateway profile."""
    clean_model = (model_id or "").strip() or DEFAULT_LLM_MODEL
    clean_base = https_base(base_url) if base_url else None
    is_external_gateway = bool(
        clean_base
        and not any(
            host in clean_base
            for host in ("api.anthropic.com", "generativelanguage.googleapis.com", "api.deepseek.com", "api.openai.com")
        )
    )
    if clean_model in MODEL_PROFILES:
        base_profile = _apply_pricing_override(MODEL_PROFILES[clean_model])
        if is_external_gateway and base_profile.adapter_kind != "openai_compat":
            return base_profile.model_copy(
                update={
                    "provider": provider or "openai_compat",
                    "adapter_kind": "openai_compat",
                    "default_base_url": clean_base or base_profile.default_base_url,
                }
            )
        return base_profile

    low = clean_model.lower()
    if not is_external_gateway and (provider == "anthropic" or ("claude" in low and (clean_base is None or "anthropic" in clean_base))):
        return _apply_pricing_override(
            ModelProfile(
                model_id=clean_model,
                provider=provider or "anthropic",
                adapter_kind="anthropic",
                default_base_url=clean_base or "https://api.anthropic.com",
                context_window=200_000,
                surcharge_cliff=200_000,
                input_per_1m=3.00,
                cached_input_per_1m=0.30,
                output_per_1m=15.00,
                region="us",
            )
        )
    if not is_external_gateway and (provider == "gemini" or ("gemini" in low and (clean_base is None or "googleapis" in clean_base))):
        return _apply_pricing_override(
            ModelProfile(
                model_id=clean_model,
                provider=provider or "gemini",
                adapter_kind="gemini",
                default_base_url=clean_base or "https://generativelanguage.googleapis.com/v1beta",
                context_window=1_000_000,
                surcharge_cliff=200_000,
                input_per_1m=1.25,
                cached_input_per_1m=0.31,
                output_per_1m=10.00,
                region="us",
            )
        )
    inferred_provider = provider or ("qwen" if "qwen" in low else ("deepseek" if "deepseek" in low else "openai_compat"))
    inferred_region = (
        "ap-east-1"
        if inferred_provider == "qwen"
        else ("cn-hk" if inferred_provider == "deepseek" else ("us" if inferred_provider == "openai" else "global"))
    )
    return _apply_pricing_override(
        ModelProfile(
            model_id=clean_model,
            provider=inferred_provider,
            adapter_kind="openai_compat",
            default_base_url=clean_base or "https://api.deepseek.com",
            context_window=128_000,
            surcharge_cliff=128_000,
            input_per_1m=0.40,
            cached_input_per_1m=0.10,
            output_per_1m=1.20,
            region=inferred_region,
        )
    )


def _emit_circuit_breaker_metric(provider: str, state: str) -> None:
    try:
        obs_mod = importlib.import_module("aios_platform.observability")
        fn = getattr(obs_mod, "set_circuit_breaker_metric", None)
        if callable(fn):
            fn(provider=provider, state=state)
    except Exception:
        pass


class ProviderCircuitBreaker:
    """Thread-safe consecutive-failure circuit breaker per provider/endpoint key."""

    def __init__(self, *, failure_threshold: int = 5, recovery_timeout_s: float = 30.0):
        self.failure_threshold = max(1, failure_threshold)
        self.recovery_timeout_s = max(0.1, recovery_timeout_s)
        self._lock = threading.Lock()
        self._states: dict[str, dict[str, Any]] = {}

    def state(self, key: str) -> Literal["closed", "open", "half_open"]:
        now = time.monotonic()
        transition: str | None = None
        with self._lock:
            entry = self._states.get(key)
            if entry is None:
                return "closed"
            opened_until = entry.get("opened_until", 0.0)
            if entry["state"] == "open":
                if now >= opened_until:
                    entry["state"] = "half_open"
                    transition = "half_open"
                    result: Literal["closed", "open", "half_open"] = "half_open"
                else:
                    result = "open"
            else:
                result = entry["state"]
        if transition is not None:
            _emit_circuit_breaker_metric(key, transition)
        return result

    def allow_request(self, key: str) -> bool:
        now = time.monotonic()
        transition: str | None = None
        allowed = True
        with self._lock:
            entry = self._states.get(key)
            if entry is None:
                return True
            if entry["state"] == "open":
                if now >= entry["opened_until"]:
                    entry["state"] = "half_open"
                    entry["half_open_inflight"] = True
                    transition = "half_open"
                    allowed = True
                else:
                    allowed = False
            elif entry["state"] == "half_open":
                if entry.get("half_open_inflight"):
                    allowed = False
                else:
                    entry["half_open_inflight"] = True
                    allowed = True
            else:
                allowed = True
        if transition is not None:
            _emit_circuit_breaker_metric(key, transition)
        return allowed

    def record_success(self, key: str) -> None:
        changed = False
        with self._lock:
            prev = self._states.get(key)
            if prev is None or prev.get("state") != "closed":
                changed = True
            self._states[key] = {"state": "closed", "failures": 0, "opened_until": 0.0, "half_open_inflight": False}
        if changed:
            _emit_circuit_breaker_metric(key, "closed")

    def record_failure(self, key: str) -> None:
        now = time.monotonic()
        transition: str | None = None
        with self._lock:
            entry = self._states.setdefault(
                key,
                {"state": "closed", "failures": 0, "opened_until": 0.0, "half_open_inflight": False},
            )
            prev_state = entry["state"]
            entry["half_open_inflight"] = False
            if prev_state == "half_open":
                entry["state"] = "open"
                entry["opened_until"] = now + self.recovery_timeout_s
                entry["failures"] = self.failure_threshold
                transition = "open"
            else:
                entry["failures"] += 1
                if entry["failures"] >= self.failure_threshold:
                    entry["state"] = "open"
                    entry["opened_until"] = now + self.recovery_timeout_s
                    if prev_state != "open":
                        transition = "open"
        if transition is not None:
            _emit_circuit_breaker_metric(key, transition)

    def snapshot(self) -> list[dict[str, Any]]:
        now = time.monotonic()
        transitions: list[tuple[str, str]] = []
        items: list[dict[str, Any]] = []
        with self._lock:
            for key in sorted(self._states.keys()):
                entry = self._states[key]
                cur_state = entry["state"]
                retry_in = 0.0
                if cur_state == "open":
                    opened_until = float(entry.get("opened_until") or 0.0)
                    if now >= opened_until:
                        entry["state"] = "half_open"
                        cur_state = "half_open"
                        transitions.append((key, "half_open"))
                    else:
                        retry_in = round(max(0.0, opened_until - now), 2)
                items.append(
                    {
                        "provider": key,
                        "state": cur_state,
                        "failures": int(entry.get("failures") or 0),
                        "retry_in_seconds": retry_in,
                    }
                )
        for key, new_state in transitions:
            _emit_circuit_breaker_metric(key, new_state)
        return items


def _stream_json_response(
    client: httpx.Client,
    url: str,
    *,
    payload: dict[str, Any],
    headers: dict[str, str],
    timeout_s: float,
    max_bytes: int = MAX_LLM_RESPONSE_BYTES,
) -> tuple[int, dict[str, Any] | None, dict[str, str]]:
    """POST JSON using pooled httpx.Client streaming with a strict response byte ceiling."""
    with client.stream("POST", url, json=payload, headers=headers, timeout=timeout_s) as response:
        status_code = int(response.status_code)
        resp_headers = {str(k).lower(): str(v) for k, v in getattr(response, "headers", {}).items()}
        chunks = bytearray()
        for chunk in response.iter_bytes(8192):
            chunks.extend(chunk)
            if len(chunks) > max_bytes:
                raise LLMProviderError(
                    f"Provider response exceeded {max_bytes} bytes limit",
                    error_code="RESPONSE_TOO_LARGE",
                    status_code=502,
                )
        if status_code >= 400:
            body_preview = bytes(chunks[:512]).decode("utf-8", errors="replace")
            try:
                err_obj = json.loads(body_preview) if body_preview.strip() else None
            except ValueError:
                err_obj = None
            return status_code, err_obj if isinstance(err_obj, dict) else {"raw": body_preview}, resp_headers
        data = json.loads(chunks)
        if not isinstance(data, dict):
            raise LLMProviderError("Expected JSON object from LLM provider", error_code="INVALID_JSON", status_code=502)
        return status_code, data, resp_headers


def _retry_sleep_seconds(attempt: int, base_backoff: float, resp_headers: dict[str, str]) -> float:
    retry_after = resp_headers.get("retry-after")
    if retry_after:
        try:
            parsed = float(retry_after)
            if 0.0 <= parsed <= 2.0:
                return parsed
        except ValueError:
            pass
    exp = base_backoff * (2 ** attempt)
    return min(1.5, exp * random.uniform(0.5, 1.25))


def _sanitize_gemini_schema(node: Any) -> Any:
    """Remove JSON Schema fields unsupported by Gemini functionDeclarations."""
    if isinstance(node, dict):
        return {
            k: _sanitize_gemini_schema(v)
            for k, v in node.items()
            if k not in {"additionalProperties", "$schema"}
        }
    if isinstance(node, list):
        return [_sanitize_gemini_schema(item) for item in node]
    return node


def _extract_system_and_turns(messages: list[dict[str, Any]]) -> tuple[str, list[dict[str, Any]]]:
    system_parts: list[str] = []
    turns: list[dict[str, Any]] = []
    for msg in messages:
        role = str(msg.get("role") or "user")
        if role == "system":
            content = str(msg.get("content") or "").strip()
            if content:
                system_parts.append(content)
        else:
            turns.append(msg)
    return "\n\n".join(system_parts), turns


class BaseAdapter:
    adapter_kind: AdapterKind

    def build_payload(
        self,
        profile: ModelProfile,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        *,
        effort: EffortLevel,
        max_tokens: int,
        temperature: float,
        user_tag: str | None = None,
        cached_content: str | None = None,
    ) -> dict[str, Any]:
        raise NotImplementedError

    def endpoint_url(self, base_url: str, profile: ModelProfile) -> str:
        raise NotImplementedError

    def build_headers(self, api_key: str) -> dict[str, str]:
        raise NotImplementedError

    def parse_response(
        self,
        data: dict[str, Any],
        profile: ModelProfile,
        *,
        latency_ms: float = 0.0,
    ) -> ChatResult:
        raise NotImplementedError


class OpenAICompatAdapter(BaseAdapter):
    """Adapter for DeepSeek, OpenAI, Qwen DashScope, OpenRouter, vLLM, and enterprise gateways."""

    adapter_kind: AdapterKind = "openai_compat"

    def endpoint_url(self, base_url: str, profile: ModelProfile) -> str:
        clean = base_url.rstrip("/")
        if clean.endswith("/chat/completions"):
            return clean
        return f"{clean}/chat/completions"

    def build_headers(self, api_key: str) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

    def build_payload(
        self,
        profile: ModelProfile,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        *,
        effort: EffortLevel,
        max_tokens: int,
        temperature: float,
        user_tag: str | None = None,
        cached_content: str | None = None,
    ) -> dict[str, Any]:
        del cached_content
        formatted_messages: list[dict[str, Any]] = []
        for msg in messages:
            role = str(msg.get("role") or "user")
            item: dict[str, Any] = {"role": role}
            if "content" in msg:
                item["content"] = msg["content"]
            elif role == "assistant" and msg.get("tool_calls"):
                item["content"] = ""
            if role == "assistant":
                if msg.get("reasoning_content") is not None:
                    item["reasoning_content"] = str(msg["reasoning_content"])
                if msg.get("tool_calls"):
                    item["tool_calls"] = msg["tool_calls"]
            if role == "tool" and msg.get("tool_call_id"):
                item["tool_call_id"] = str(msg["tool_call_id"])
            if role == "tool" and msg.get("name"):
                item["name"] = str(msg["name"])
            formatted_messages.append(item)

        payload: dict[str, Any] = {
            "model": profile.model_id,
            "messages": formatted_messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if user_tag:
            payload["user"] = user_tag
        if profile.provider == "openai" and profile.supports_prompt_cache:
            sys_text, _ = _extract_system_and_turns(messages)
            if sys_text:
                payload["prompt_cache_key"] = f"aios:{sha256(sys_text.encode('utf-8')).hexdigest()[:24]}"
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"
        payload.update(profile.translate_reasoning_effort(effort))
        return payload

    def parse_response(
        self,
        data: dict[str, Any],
        profile: ModelProfile,
        *,
        latency_ms: float = 0.0,
    ) -> ChatResult:
        choices = data.get("choices") or []
        if not choices or not isinstance(choices[0], dict):
            raise LLMProviderError("Empty LLM choices", error_code="EMPTY_CHOICES", status_code=502)
        choice = choices[0]
        message = choice.get("message")
        if not isinstance(message, dict):
            raise LLMProviderError("Malformed assistant message", error_code="MALFORMED_MESSAGE", status_code=502)

        raw_content = message.get("content")
        if isinstance(raw_content, list):
            text = "\n".join(
                str(part.get("text") or "")
                for part in raw_content
                if isinstance(part, dict) and part.get("type") == "text"
            ).strip()
        else:
            text = str(raw_content or "").strip()

        reasoning_content = message.get("reasoning_content")
        if reasoning_content is not None:
            reasoning_content = str(reasoning_content)

        parsed_calls: list[NormalizedToolCall] = []
        raw_tool_calls = message.get("tool_calls") or []
        if isinstance(raw_tool_calls, list):
            for idx, tc in enumerate(raw_tool_calls):
                if not isinstance(tc, dict):
                    continue
                fn = tc.get("function")
                if not isinstance(fn, dict) or not isinstance(fn.get("name"), str):
                    continue
                raw_args_val = fn.get("arguments")
                malformed = False
                raw_args_str = ""
                parsed_args: dict[str, Any] = {}
                if isinstance(raw_args_val, dict):
                    parsed_args = raw_args_val
                    raw_args_str = json.dumps(raw_args_val, ensure_ascii=False)
                else:
                    raw_args_str = "" if raw_args_val is None else str(raw_args_val)
                    if raw_args_str.strip():
                        try:
                            loaded = json.loads(raw_args_str)
                            if isinstance(loaded, dict):
                                parsed_args = loaded
                            else:
                                malformed = True
                        except ValueError:
                            malformed = True
                parsed_calls.append(
                    NormalizedToolCall(
                        id=str(tc.get("id") or f"call_{idx}"),
                        name=fn["name"],
                        arguments=parsed_args,
                        raw_arguments=raw_args_str,
                        malformed_arguments=malformed,
                    )
                )

        usage_raw = data.get("usage") if isinstance(data.get("usage"), dict) else {}
        prompt_details = usage_raw.get("prompt_tokens_details") if isinstance(usage_raw.get("prompt_tokens_details"), dict) else {}
        comp_details = usage_raw.get("completion_tokens_details") if isinstance(usage_raw.get("completion_tokens_details"), dict) else {}
        prompt_tokens = int(usage_raw.get("prompt_tokens") or 0)
        cache_hit_tokens = int(
            usage_raw.get("prompt_cache_hit_tokens")
            or prompt_details.get("cached_tokens")
            or 0
        )
        reasoning_tokens = int(
            comp_details.get("reasoning_tokens")
            or usage_raw.get("reasoning_tokens")
            or 0
        )
        completion_tokens = int(usage_raw.get("completion_tokens") or 0)
        total_tokens = int(usage_raw.get("total_tokens") or (prompt_tokens + completion_tokens))

        return ChatResult(
            provider=profile.provider,
            model=str(data.get("model") or profile.model_id),
            text=text,
            tool_calls=parsed_calls,
            reasoning_content=reasoning_content,
            thinking_blocks=[],
            usage=UsageMetrics(
                prompt_tokens=prompt_tokens,
                cache_hit_tokens=cache_hit_tokens,
                reasoning_tokens=reasoning_tokens,
                completion_tokens=completion_tokens,
                total_tokens=total_tokens,
                estimated_usd=profile.estimate_cost_usd(
                    prompt_tokens=prompt_tokens,
                    cache_hit_tokens=cache_hit_tokens,
                    completion_tokens=completion_tokens,
                ),
            ),
            finish_reason=str(choice.get("finish_reason")) if choice.get("finish_reason") is not None else None,
            latency_ms=round(latency_ms, 2),
        )


class AnthropicAdapter(BaseAdapter):
    """Native Anthropic Messages API adapter with ephemeral prompt caching and thinking block replay."""

    adapter_kind: AdapterKind = "anthropic"

    def endpoint_url(self, base_url: str, profile: ModelProfile) -> str:
        clean = base_url.rstrip("/")
        if clean.endswith("/v1/messages"):
            return clean
        if clean.endswith("/v1"):
            return f"{clean}/messages"
        return f"{clean}/v1/messages"

    def build_headers(self, api_key: str) -> dict[str, str]:
        return {
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        }

    def build_payload(
        self,
        profile: ModelProfile,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        *,
        effort: EffortLevel,
        max_tokens: int,
        temperature: float,
        user_tag: str | None = None,
        cached_content: str | None = None,
    ) -> dict[str, Any]:
        del user_tag, cached_content
        system_text, turns = _extract_system_and_turns(messages)

        anthropic_messages: list[dict[str, Any]] = []
        pending_tool_results: list[dict[str, Any]] = []

        def flush_tool_results() -> None:
            if pending_tool_results:
                anthropic_messages.append({"role": "user", "content": list(pending_tool_results)})
                pending_tool_results.clear()

        for msg in turns:
            role = str(msg.get("role") or "user")
            if role == "tool":
                pending_tool_results.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": str(msg.get("tool_call_id") or "tool_call"),
                        "content": str(msg.get("content") or ""),
                    }
                )
                continue
            flush_tool_results()
            if role == "assistant":
                blocks: list[dict[str, Any]] = []
                for tb in msg.get("thinking_blocks") or []:
                    if isinstance(tb, dict):
                        blocks.append(dict(tb))
                text_val = str(msg.get("content") or "").strip()
                if text_val:
                    blocks.append({"type": "text", "text": text_val})
                for tc in msg.get("tool_calls") or []:
                    if not isinstance(tc, dict):
                        continue
                    fn = tc.get("function") if isinstance(tc.get("function"), dict) else tc
                    raw_args = fn.get("arguments", {})
                    if isinstance(raw_args, str):
                        try:
                            tool_input = json.loads(raw_args or "{}")
                        except ValueError:
                            tool_input = {}
                    elif isinstance(raw_args, dict):
                        tool_input = raw_args
                    else:
                        tool_input = {}
                    blocks.append(
                        {
                            "type": "tool_use",
                            "id": str(tc.get("id") or "tool_call"),
                            "name": str(fn.get("name") or ""),
                            "input": tool_input if isinstance(tool_input, dict) else {},
                        }
                    )
                if not blocks:
                    blocks.append({"type": "text", "text": ""})
                anthropic_messages.append({"role": "assistant", "content": blocks})
            else:
                anthropic_messages.append(
                    {
                        "role": "user",
                        "content": [{"type": "text", "text": str(msg.get("content") or "")}],
                    }
                )
        flush_tool_results()

        payload: dict[str, Any] = {
            "model": profile.model_id,
            "max_tokens": max_tokens,
            "messages": anthropic_messages,
        }
        if system_text:
            sys_block: dict[str, Any] = {
                "type": "text",
                "text": system_text,
            }
            if len(system_text) >= ANTHROPIC_PROMPT_CACHE_MIN_CHARS:
                sys_block["cache_control"] = {"type": "ephemeral"}
            payload["system"] = [sys_block]
        if tools:
            ant_tools: list[dict[str, Any]] = []
            for item in tools:
                fn = item.get("function") if isinstance(item, dict) else None
                if not isinstance(fn, dict):
                    continue
                ant_tools.append(
                    {
                        "name": str(fn.get("name") or ""),
                        "description": str(fn.get("description") or ""),
                        "input_schema": fn.get("parameters") or {"type": "object", "properties": {}},
                    }
                )
            if ant_tools:
                ant_tools[-1]["cache_control"] = {"type": "ephemeral"}
                payload["tools"] = ant_tools

        effort_params = profile.translate_reasoning_effort(effort)
        if "thinking" in effort_params:
            thinking_cfg = dict(effort_params["thinking"])
            if thinking_cfg.get("type") == "enabled":
                thinking_cfg["budget_tokens"] = min(
                    int(thinking_cfg["budget_tokens"]),
                    max(1024, max_tokens - 512),
                )
                if max_tokens <= 1024:
                    thinking_cfg = None
            if thinking_cfg is not None:
                payload["thinking"] = thinking_cfg
        if "output_config" in effort_params:
            payload["output_config"] = effort_params["output_config"]
        if "thinking" not in payload:
            payload["temperature"] = temperature
        return payload

    def parse_response(
        self,
        data: dict[str, Any],
        profile: ModelProfile,
        *,
        latency_ms: float = 0.0,
    ) -> ChatResult:
        content = data.get("content") or []
        if not isinstance(content, list):
            raise LLMProviderError("Malformed Anthropic content blocks", error_code="MALFORMED_MESSAGE", status_code=502)

        text_parts: list[str] = []
        thinking_blocks: list[dict[str, Any]] = []
        reasoning_parts: list[str] = []
        parsed_calls: list[NormalizedToolCall] = []

        for idx, block in enumerate(content):
            if not isinstance(block, dict):
                continue
            btype = block.get("type")
            if btype in {"thinking", "redacted_thinking"}:
                thinking_blocks.append(dict(block))
                if block.get("thinking"):
                    reasoning_parts.append(str(block["thinking"]))
            elif btype == "text":
                if block.get("text"):
                    text_parts.append(str(block["text"]))
            elif btype == "tool_use":
                raw_input = block.get("input")
                malformed = not isinstance(raw_input, dict)
                args_dict = raw_input if isinstance(raw_input, dict) else {}
                parsed_calls.append(
                    NormalizedToolCall(
                        id=str(block.get("id") or f"toolu_{idx}"),
                        name=str(block.get("name") or ""),
                        arguments=args_dict,
                        raw_arguments=json.dumps(args_dict, ensure_ascii=False),
                        malformed_arguments=malformed,
                    )
                )

        usage_raw = data.get("usage") if isinstance(data.get("usage"), dict) else {}
        input_tokens = int(usage_raw.get("input_tokens") or 0)
        cache_read = int(usage_raw.get("cache_read_input_tokens") or 0)
        cache_create = int(usage_raw.get("cache_creation_input_tokens") or 0)
        prompt_tokens = input_tokens + cache_read + cache_create
        completion_tokens = int(usage_raw.get("output_tokens") or 0)
        reasoning_tokens = int(usage_raw.get("thinking_tokens") or 0)

        return ChatResult(
            provider=profile.provider,
            model=str(data.get("model") or profile.model_id),
            text="\n".join(text_parts).strip(),
            tool_calls=parsed_calls,
            reasoning_content="\n".join(reasoning_parts).strip() or None,
            thinking_blocks=thinking_blocks,
            usage=UsageMetrics(
                prompt_tokens=prompt_tokens,
                cache_hit_tokens=cache_read,
                reasoning_tokens=reasoning_tokens,
                completion_tokens=completion_tokens,
                total_tokens=prompt_tokens + completion_tokens,
                estimated_usd=profile.estimate_cost_usd(
                    prompt_tokens=prompt_tokens,
                    cache_hit_tokens=cache_read,
                    completion_tokens=completion_tokens,
                ),
            ),
            finish_reason=str(data.get("stop_reason")) if data.get("stop_reason") is not None else None,
            latency_ms=round(latency_ms, 2),
        )


class GeminiAdapter(BaseAdapter):
    """Native Google Gemini generateContent adapter with thinkingConfig and cachedContent hook."""

    adapter_kind: AdapterKind = "gemini"

    def endpoint_url(self, base_url: str, profile: ModelProfile) -> str:
        clean = base_url.rstrip("/")
        if clean.endswith(":generateContent"):
            return clean
        return f"{clean}/models/{profile.model_id}:generateContent"

    def build_headers(self, api_key: str) -> dict[str, str]:
        return {
            "x-goog-api-key": api_key,
            "Content-Type": "application/json",
        }

    def build_payload(
        self,
        profile: ModelProfile,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        *,
        effort: EffortLevel,
        max_tokens: int,
        temperature: float,
        user_tag: str | None = None,
        cached_content: str | None = None,
    ) -> dict[str, Any]:
        del user_tag
        system_text, turns = _extract_system_and_turns(messages)

        contents: list[dict[str, Any]] = []
        pending_fn_responses: list[dict[str, Any]] = []

        def flush_fn_responses() -> None:
            if pending_fn_responses:
                contents.append({"role": "user", "parts": list(pending_fn_responses)})
                pending_fn_responses.clear()

        for msg in turns:
            role = str(msg.get("role") or "user")
            if role == "tool":
                raw_content = str(msg.get("content") or "")
                try:
                    parsed_resp = json.loads(raw_content)
                    resp_obj = parsed_resp if isinstance(parsed_resp, dict) else {"result": parsed_resp}
                except ValueError:
                    resp_obj = {"result": raw_content}
                pending_fn_responses.append(
                    {
                        "functionResponse": {
                            "name": str(msg.get("name") or "tool"),
                            "response": resp_obj,
                        }
                    }
                )
                continue
            flush_fn_responses()
            if role == "assistant":
                parts: list[dict[str, Any]] = []
                text_val = str(msg.get("content") or "").strip()
                if text_val:
                    parts.append({"text": text_val})
                for tc in msg.get("tool_calls") or []:
                    if not isinstance(tc, dict):
                        continue
                    fn = tc.get("function") if isinstance(tc.get("function"), dict) else tc
                    raw_args = fn.get("arguments", {})
                    if isinstance(raw_args, str):
                        try:
                            args_obj = json.loads(raw_args or "{}")
                        except ValueError:
                            args_obj = {}
                    elif isinstance(raw_args, dict):
                        args_obj = raw_args
                    else:
                        args_obj = {}
                    fc_part: dict[str, Any] = {
                        "functionCall": {
                            "name": str(fn.get("name") or ""),
                            "args": args_obj if isinstance(args_obj, dict) else {},
                        }
                    }
                    if tc.get("thought_signature"):
                        fc_part["thoughtSignature"] = str(tc["thought_signature"])
                    parts.append(fc_part)
                if not parts:
                    parts.append({"text": ""})
                contents.append({"role": "model", "parts": parts})
            else:
                contents.append({"role": "user", "parts": [{"text": str(msg.get("content") or "")}]})
        flush_fn_responses()

        gen_config: dict[str, Any] = {
            "maxOutputTokens": max_tokens,
            "temperature": temperature,
            **profile.translate_reasoning_effort(effort),
        }
        payload: dict[str, Any] = {
            "contents": contents,
            "generationConfig": gen_config,
        }
        if cached_content:
            payload["cachedContent"] = cached_content
        elif system_text:
            payload["systemInstruction"] = {"parts": [{"text": system_text}]}

        if tools:
            declarations: list[dict[str, Any]] = []
            for item in tools:
                fn = item.get("function") if isinstance(item, dict) else None
                if not isinstance(fn, dict):
                    continue
                declarations.append(
                    {
                        "name": str(fn.get("name") or ""),
                        "description": str(fn.get("description") or ""),
                        "parameters": _sanitize_gemini_schema(
                            fn.get("parameters") or {"type": "object", "properties": {}}
                        ),
                    }
                )
            if declarations:
                payload["tools"] = [{"functionDeclarations": declarations}]
        return payload

    def parse_response(
        self,
        data: dict[str, Any],
        profile: ModelProfile,
        *,
        latency_ms: float = 0.0,
    ) -> ChatResult:
        candidates = data.get("candidates") or []
        if not candidates or not isinstance(candidates[0], dict):
            raise LLMProviderError("Empty Gemini candidates", error_code="EMPTY_CANDIDATES", status_code=502)
        candidate = candidates[0]
        content = candidate.get("content") if isinstance(candidate.get("content"), dict) else {}
        parts = content.get("parts") or []

        text_parts: list[str] = []
        reasoning_parts: list[str] = []
        parsed_calls: list[NormalizedToolCall] = []

        for idx, part in enumerate(parts):
            if not isinstance(part, dict):
                continue
            if part.get("thought") is True and part.get("text"):
                reasoning_parts.append(str(part["text"]))
            elif "text" in part and part.get("text") is not None:
                text_parts.append(str(part["text"]))
            elif isinstance(part.get("functionCall"), dict):
                fc = part["functionCall"]
                args = fc.get("args")
                malformed = args is not None and not isinstance(args, dict)
                args_dict = args if isinstance(args, dict) else {}
                parsed_calls.append(
                    NormalizedToolCall(
                        id=f"gemini_call_{idx}",
                        name=str(fc.get("name") or ""),
                        arguments=args_dict,
                        raw_arguments=json.dumps(args_dict, ensure_ascii=False),
                        malformed_arguments=malformed,
                        thought_signature=str(part["thoughtSignature"]) if part.get("thoughtSignature") else None,
                    )
                )

        meta = data.get("usageMetadata") if isinstance(data.get("usageMetadata"), dict) else {}
        prompt_tokens = int(meta.get("promptTokenCount") or 0)
        cache_hit_tokens = int(meta.get("cachedContentTokenCount") or 0)
        reasoning_tokens = int(meta.get("thoughtsTokenCount") or 0)
        candidates_tokens = int(meta.get("candidatesTokenCount") or 0)
        completion_tokens = candidates_tokens + reasoning_tokens
        total_tokens = int(meta.get("totalTokenCount") or (prompt_tokens + completion_tokens))

        return ChatResult(
            provider=profile.provider,
            model=str(data.get("modelVersion") or profile.model_id),
            text="\n".join(text_parts).strip(),
            tool_calls=parsed_calls,
            reasoning_content="\n".join(reasoning_parts).strip() or None,
            thinking_blocks=[],
            usage=UsageMetrics(
                prompt_tokens=prompt_tokens,
                cache_hit_tokens=cache_hit_tokens,
                reasoning_tokens=reasoning_tokens,
                completion_tokens=completion_tokens,
                total_tokens=total_tokens,
                estimated_usd=profile.estimate_cost_usd(
                    prompt_tokens=prompt_tokens,
                    cache_hit_tokens=cache_hit_tokens,
                    completion_tokens=completion_tokens,
                ),
            ),
            finish_reason=str(candidate.get("finishReason")) if candidate.get("finishReason") is not None else None,
            latency_ms=round(latency_ms, 2),
        )


_ADAPTERS: dict[AdapterKind, BaseAdapter] = {
    "openai_compat": OpenAICompatAdapter(),
    "anthropic": AnthropicAdapter(),
    "gemini": GeminiAdapter(),
}


def resolve_fallback_llm_configs() -> list[dict[str, str | None]]:
    """Resolve optional fallback LLM provider configuration from env/secret file without logging secrets."""
    api_key: str | None = None
    key_file = (os.getenv("AIOS_LLM_FALLBACK_API_KEY_FILE") or "").strip()
    if key_file:
        path = Path(key_file)
        if path.is_file():
            val = path.read_text(encoding="utf-8").strip()
            if val:
                api_key = val
    if api_key is None:
        raw_key = (os.getenv("AIOS_LLM_FALLBACK_API_KEY") or "").strip()
        if raw_key:
            api_key = raw_key
    if not api_key:
        return []

    raw_provider = (os.getenv("AIOS_LLM_FALLBACK_PROVIDER") or "").strip() or None
    raw_base_url = (os.getenv("AIOS_LLM_FALLBACK_BASE_URL") or "").strip()
    base_url = https_base(raw_base_url) if raw_base_url else None
    raw_models = (os.getenv("AIOS_LLM_FALLBACK_MODEL") or "").strip()

    default_by_provider = {
        "openai": "gpt-5.4-mini",
        "anthropic": "claude-sonnet-4-6",
        "gemini": "gemini-2.5-pro",
        "qwen": "qwen-plus",
        "deepseek": DEFAULT_LLM_MODEL,
    }
    models = [m.strip() for m in raw_models.split(",") if m.strip()] if raw_models else []
    if not models:
        models = [default_by_provider.get(raw_provider or "", DEFAULT_LLM_MODEL)]

    return [
        {
            "api_key": api_key,
            "model": model,
            "provider": raw_provider,
            "base_url": base_url,
        }
        for model in models
    ]


class LLMProvider:
    """Unified pure-httpx/pydantic multi-provider gateway with pooled client, retries, circuit breaker, and failover."""

    def __init__(
        self,
        *,
        api_key: str | None,
        model: str = DEFAULT_LLM_MODEL,
        base_url: str | None = None,
        provider: str | None = None,
        circuit_breaker: ProviderCircuitBreaker | None = None,
        fallback_providers: list[LLMProvider] | None = None,
        max_retries: int = 2,
        retry_backoff_base: float = 0.15,
        max_response_bytes: int = MAX_LLM_RESPONSE_BYTES,
    ):
        self.api_key = api_key.strip() if isinstance(api_key, str) and api_key.strip() else None
        self.profile = resolve_model_profile(model, provider=provider, base_url=base_url)
        self.base_url = https_base(base_url) if base_url else self.profile.default_base_url
        self.adapter = _ADAPTERS[self.profile.adapter_kind]
        self.circuit_breaker = circuit_breaker or ProviderCircuitBreaker()
        self.fallback_providers: list[LLMProvider] = [
            fb for fb in (fallback_providers or []) if fb is not None and fb is not self
        ]
        self.max_retries = max(0, max_retries)
        self.retry_backoff_base = max(0.0, retry_backoff_base)
        self.max_response_bytes = max_response_bytes
        self._client_lock = threading.Lock()
        self._client: httpx.Client | None = None

    @property
    def enabled(self) -> bool:
        return self.api_key is not None

    @property
    def breaker_key(self) -> str:
        return f"{self.profile.provider}:{self.base_url}"

    def with_fallbacks(self, fallback_providers: list[LLMProvider]) -> LLMProvider:
        """Attach ordered fallback providers cleanly and return self."""
        self.fallback_providers = [fb for fb in fallback_providers if fb is not None and fb is not self]
        return self

    def circuit_snapshots(self) -> list[dict[str, Any]]:
        """Return deterministic sorted circuit breaker snapshots across primary and configured fallbacks."""
        merged: dict[str, dict[str, Any]] = {}
        for item in self.circuit_breaker.snapshot():
            merged[item["provider"]] = item
        if self.enabled and self.breaker_key not in merged:
            merged[self.breaker_key] = {
                "provider": self.breaker_key,
                "state": self.circuit_breaker.state(self.breaker_key),
                "failures": 0,
                "retry_in_seconds": 0.0,
            }
        for fb in self.fallback_providers:
            for item in fb.circuit_snapshots():
                if item["provider"] not in merged:
                    merged[item["provider"]] = item
        return [merged[k] for k in sorted(merged.keys())]

    def _get_client(self) -> httpx.Client:
        with self._client_lock:
            if self._client is None or self._client.is_closed:
                self._client = httpx.Client(
                    follow_redirects=False,
                    trust_env=False,
                    limits=httpx.Limits(max_connections=32, max_keepalive_connections=16),
                )
            return self._client

    def close(self) -> None:
        with self._client_lock:
            if self._client is not None and not self._client.is_closed:
                self._client.close()
                self._client = None
        for fb in self.fallback_providers:
            fb.close()

    def _chat_single_with_raw(
        self,
        messages: list[dict[str, Any]],
        *,
        tools: list[dict[str, Any]] | None = None,
        effort: EffortLevel = "low",
        max_tokens: int | None = None,
        timeout_s: float | None = None,
        temperature: float = 0.35,
        user_tag: str | None = None,
        cached_content: str | None = None,
    ) -> tuple[ChatResult, dict[str, Any]]:
        if not self.api_key:
            raise LLMProviderError("LLM API key not configured", error_code="NO_API_KEY", status_code=503)

        breaker_key = self.breaker_key
        if not self.circuit_breaker.allow_request(breaker_key):
            raise CircuitOpenError(breaker_key)

        resolved_max_tokens = max_tokens if max_tokens is not None else self.profile.max_tokens_for_effort(effort)
        resolved_timeout = timeout_s if timeout_s is not None else self.profile.timeout_for_effort(effort)
        url = self.adapter.endpoint_url(self.base_url, self.profile)
        headers = self.adapter.build_headers(self.api_key)
        payload = self.adapter.build_payload(
            self.profile,
            messages,
            tools or [],
            effort=effort,
            max_tokens=resolved_max_tokens,
            temperature=temperature,
            user_tag=user_tag,
            cached_content=cached_content,
        )

        client = self._get_client()
        started = time.monotonic()
        stripped_reasoning_once = False
        attempt = 0

        while True:
            try:
                status_code, data, resp_headers = _stream_json_response(
                    client,
                    url,
                    payload=payload,
                    headers=headers,
                    timeout_s=resolved_timeout,
                    max_bytes=self.max_response_bytes,
                )
            except LLMProviderError as err:
                self.circuit_breaker.record_failure(breaker_key)
                raise err
            except (httpx.TransportError, OSError, ValueError) as err:
                if attempt < self.max_retries:
                    time.sleep(_retry_sleep_seconds(attempt, self.retry_backoff_base, {}))
                    attempt += 1
                    continue
                self.circuit_breaker.record_failure(breaker_key)
                raise LLMProviderError(
                    f"Provider transport error: {type(err).__name__}",
                    error_code=type(err).__name__.upper(),
                    status_code=503,
                ) from err

            # Strip unsupported reasoning/thinking/prompt-cache fields once on HTTP 400 and retry immediately.
            if status_code == 400 and not stripped_reasoning_once:
                stripped = False
                for field in ("reasoning_effort", "output_config", "thinking", "prompt_cache_key"):
                    if field in payload:
                        payload.pop(field, None)
                        stripped = True
                if stripped:
                    stripped_reasoning_once = True
                    continue

            if status_code in RETRYABLE_STATUS_CODES and attempt < self.max_retries:
                time.sleep(_retry_sleep_seconds(attempt, self.retry_backoff_base, resp_headers))
                attempt += 1
                continue

            if status_code >= 400:
                if status_code >= 500 or status_code == 429:
                    self.circuit_breaker.record_failure(breaker_key)
                raise LLMProviderError(
                    f"Upstream provider rejected request with HTTP {status_code}",
                    error_code=f"HTTP_{status_code}",
                    status_code=status_code,
                )

            assert data is not None
            elapsed_ms = (time.monotonic() - started) * 1000.0
            result = self.adapter.parse_response(data, self.profile, latency_ms=elapsed_ms)
            self.circuit_breaker.record_success(breaker_key)
            return result, data

    def _execute_chat_with_raw(
        self,
        messages: list[dict[str, Any]],
        *,
        tools: list[dict[str, Any]] | None = None,
        effort: EffortLevel = "low",
        max_tokens: int | None = None,
        timeout_s: float | None = None,
        temperature: float = 0.35,
        user_tag: str | None = None,
        cached_content: str | None = None,
        provider_policy_check: Callable[[ModelProfile, bool], bool] | None = None,
        is_failover: bool = False,
    ) -> tuple[ChatResult, dict[str, Any]]:
        if provider_policy_check is not None and not provider_policy_check(self.profile, is_failover):
            raise LLMProviderError(
                f"Provider '{self.profile.provider}' / model '{self.profile.model_id}' denied by tenant policy",
                error_code="PROVIDER_POLICY_DENIED",
                status_code=403,
            )
        try:
            return self._chat_single_with_raw(
                messages,
                tools=tools,
                effort=effort,
                max_tokens=max_tokens,
                timeout_s=timeout_s,
                temperature=temperature,
                user_tag=user_tag,
                cached_content=cached_content,
            )
        except LLMProviderError as primary_err:
            if is_failover or primary_err.error_code == "PROVIDER_POLICY_DENIED":
                raise
            failover_eligible = bool(self.fallback_providers) and (
                isinstance(primary_err, CircuitOpenError)
                or primary_err.error_code == "CIRCUIT_OPEN"
                or primary_err.status_code in RETRYABLE_STATUS_CODES
                or (primary_err.status_code is not None and primary_err.status_code >= 500)
            )
            if not failover_eligible:
                raise

            origin = f"{self.profile.provider}/{self.profile.model_id}"
            policy_denied_err: LLMProviderError | None = None
            for fb in self.fallback_providers:
                if not fb.enabled:
                    continue
                try:
                    fb_result, fb_raw = fb._execute_chat_with_raw(
                        messages,
                        tools=tools,
                        effort=effort,
                        max_tokens=max_tokens,
                        timeout_s=timeout_s,
                        temperature=temperature,
                        user_tag=user_tag,
                        cached_content=cached_content,
                        provider_policy_check=provider_policy_check,
                        is_failover=True,
                    )
                    if fb_result.failover_from is None:
                        fb_result = fb_result.model_copy(update={"failover_from": origin})
                    return fb_result, fb_raw
                except LLMProviderError as fb_err:
                    if fb_err.error_code == "PROVIDER_POLICY_DENIED":
                        policy_denied_err = fb_err
                    continue
            if policy_denied_err is not None:
                raise policy_denied_err
            raise primary_err

    def chat_with_raw(
        self,
        messages: list[dict[str, Any]],
        *,
        tools: list[dict[str, Any]] | None = None,
        effort: EffortLevel = "low",
        max_tokens: int | None = None,
        timeout_s: float | None = None,
        temperature: float = 0.35,
        user_tag: str | None = None,
        cached_content: str | None = None,
        provider_policy_check: Callable[[ModelProfile, bool], bool] | None = None,
    ) -> tuple[ChatResult, dict[str, Any]]:
        """Execute a provider chat completion with multi-provider failover, returning ChatResult and raw dict."""
        return self._execute_chat_with_raw(
            messages,
            tools=tools,
            effort=effort,
            max_tokens=max_tokens,
            timeout_s=timeout_s,
            temperature=temperature,
            user_tag=user_tag,
            cached_content=cached_content,
            provider_policy_check=provider_policy_check,
            is_failover=False,
        )

    def chat(
        self,
        messages: list[dict[str, Any]],
        *,
        tools: list[dict[str, Any]] | None = None,
        effort: EffortLevel = "low",
        max_tokens: int | None = None,
        timeout_s: float | None = None,
        temperature: float = 0.35,
        user_tag: str | None = None,
        cached_content: str | None = None,
        provider_policy_check: Callable[[ModelProfile, bool], bool] | None = None,
    ) -> ChatResult:
        """Execute a provider chat completion and return normalized ChatResult."""
        result, _ = self.chat_with_raw(
            messages,
            tools=tools,
            effort=effort,
            max_tokens=max_tokens,
            timeout_s=timeout_s,
            temperature=temperature,
            user_tag=user_tag,
            cached_content=cached_content,
            provider_policy_check=provider_policy_check,
        )
        return result
