"""Bound JSON payloads, enforce rate limits, propagate trace context, and export GenAI metrics."""
from __future__ import annotations

import asyncio
from collections import OrderedDict, deque
import contextvars
from hashlib import sha256
from hmac import compare_digest
import logging
import math
import os
import re
import threading
import time
from typing import Callable
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request, Response
from prometheus_client import CONTENT_TYPE_LATEST, CollectorRegistry, Counter, Gauge, Histogram, generate_latest
from starlette.responses import JSONResponse

from .document_service import INPUT_LIMIT as DOCUMENT_INPUT_LIMIT

LOG = logging.getLogger("aios.platform")
JSON_LIMIT = 65_536
WORKBENCH_TURN_JSON_LIMIT = 2_097_152
METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"}
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
BOUNDED_JSON_PATHS = ("/v1/",)
REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{8,128}$")
TRACEPARENT_RE = re.compile(r"^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$")
_CIRCUIT_STATES = {"closed": 0.0, "half_open": 1.0, "open": 2.0}

_REQUEST_ID_VAR: contextvars.ContextVar[str | None] = contextvars.ContextVar("aios_request_id", default=None)
_TRACEPARENT_VAR: contextvars.ContextVar[str | None] = contextvars.ContextVar("aios_traceparent", default=None)

_ACTIVE_METRICS_LOCK = threading.Lock()
_ACTIVE_METRICS: _MetricsBundle | None = None
_FALLBACK_RATE_LIMIT_REJECTIONS = 0


def current_request_id() -> str | None:
    return _REQUEST_ID_VAR.get()


def current_traceparent() -> str | None:
    return _TRACEPARENT_VAR.get()


def _otel_trace_mod():
    if os.getenv("AIOS_OTEL_GENAI", "1").strip() == "0":
        return None
    try:
        from opentelemetry import trace as otel_trace  # type: ignore[import-not-found]

        return otel_trace
    except ImportError:
        return None


def otel_genai_enabled() -> bool:
    return _otel_trace_mod() is not None


class _MetricsBundle:
    def __init__(self, registry: CollectorRegistry):
        self.registry = registry
        self.lock = threading.Lock()
        self.rate_limit_rejections = 0
        self.requests = Counter(
            "aios_http_requests",
            "Completed API requests",
            ("method", "route", "status"),
            registry=registry,
        )
        self.latency = Histogram(
            "aios_http_duration_seconds",
            "API request latency",
            ("method", "route"),
            registry=registry,
        )
        self.llm_calls = Counter(
            "aios_llm_calls_total",
            "Completed LLM provider calls",
            ("provider", "model", "tier", "status"),
            registry=registry,
        )
        self.llm_tokens = Counter(
            "aios_llm_tokens_total",
            "LLM tokens processed by kind",
            ("kind", "provider", "model"),
            registry=registry,
        )
        self.llm_cost_usd = Counter(
            "aios_llm_cost_usd_total",
            "Estimated LLM API spend in USD",
            ("provider", "model"),
            registry=registry,
        )
        self.llm_cache_events = Counter(
            "aios_llm_cache_events_total",
            "LLM cache lookup outcomes",
            ("cache_layer", "outcome"),
            registry=registry,
        )
        self.circuit_breaker_state = Gauge(
            "aios_circuit_breaker_state",
            "Provider circuit breaker state (0=closed, 1=half_open, 2=open)",
            ("provider",),
            registry=registry,
        )
        self.rate_limit_rejections_counter = Counter(
            "aios_rate_limit_rejections_total",
            "In-app rate limit rejections",
            ("bucket",),
            registry=registry,
        )


def _get_active_bundle() -> _MetricsBundle | None:
    with _ACTIVE_METRICS_LOCK:
        return _ACTIVE_METRICS


def _label(value: str | None, *, fallback: str = "unknown", max_len: int = 96) -> str:
    cleaned = (value or "").strip()
    return cleaned[:max_len] if cleaned else fallback


def record_llm_metric(
    *,
    provider: str,
    model: str,
    tier: str,
    status: str,
    prompt_tokens: int = 0,
    cache_hit_tokens: int = 0,
    completion_tokens: int = 0,
    estimated_usd: float = 0.0,
) -> None:
    try:
        p = _label(provider, max_len=64)
        m = _label(model, max_len=96)
        t = _label(tier, max_len=16)
        s = _label(status, max_len=32)
        p_toks = max(0, int(prompt_tokens))
        ch_toks = max(0, int(cache_hit_tokens))
        c_toks = max(0, int(completion_tokens))
        cost = max(0.0, float(estimated_usd))

        bundle = _get_active_bundle()
        if bundle is not None:
            bundle.llm_calls.labels(provider=p, model=m, tier=t, status=s).inc()
            if p_toks:
                bundle.llm_tokens.labels(kind="prompt", provider=p, model=m).inc(p_toks)
            if ch_toks:
                bundle.llm_tokens.labels(kind="cache_hit", provider=p, model=m).inc(ch_toks)
            if c_toks:
                bundle.llm_tokens.labels(kind="completion", provider=p, model=m).inc(c_toks)
            if cost > 0.0:
                bundle.llm_cost_usd.labels(provider=p, model=m).inc(cost)

        LOG.info(
            "gen_ai.call provider=%s model=%s tier=%s status=%s prompt_tokens=%d "
            "cache_hit_tokens=%d completion_tokens=%d estimated_usd=%.6f request_id=%s traceparent=%s",
            p,
            m,
            t,
            s,
            p_toks,
            ch_toks,
            c_toks,
            cost,
            current_request_id() or "-",
            current_traceparent() or "-",
        )

        otel_trace = _otel_trace_mod()
        if otel_trace is not None:
            span = otel_trace.get_current_span()
            if span is not None and getattr(span, "is_recording", lambda: False)():
                span.set_attribute("gen_ai.system", p)
                span.set_attribute("gen_ai.request.model", m)
                span.set_attribute("gen_ai.usage.input_tokens", p_toks)
                span.set_attribute("gen_ai.usage.cache_read_input_tokens", ch_toks)
                span.set_attribute("gen_ai.usage.output_tokens", c_toks)
                span.set_attribute("aios.llm.tier", t)
                span.set_attribute("aios.llm.status", s)
                span.set_attribute("aios.llm.estimated_usd", cost)
            else:
                tracer = otel_trace.get_tracer("aios.genai")
                with tracer.start_as_current_span("gen_ai.client.inference") as child:
                    child.set_attribute("gen_ai.system", p)
                    child.set_attribute("gen_ai.request.model", m)
                    child.set_attribute("gen_ai.usage.input_tokens", p_toks)
                    child.set_attribute("gen_ai.usage.cache_read_input_tokens", ch_toks)
                    child.set_attribute("gen_ai.usage.output_tokens", c_toks)
                    child.set_attribute("aios.llm.tier", t)
                    child.set_attribute("aios.llm.status", s)
                    child.set_attribute("aios.llm.estimated_usd", cost)
    except Exception:
        pass


def record_cache_metric(*, cache_layer: str, outcome: str) -> None:
    try:
        layer = _label(cache_layer, max_len=32)
        out = _label(outcome, max_len=16)
        bundle = _get_active_bundle()
        if bundle is not None:
            bundle.llm_cache_events.labels(cache_layer=layer, outcome=out).inc()
        LOG.info(
            "gen_ai.cache cache_layer=%s outcome=%s request_id=%s",
            layer,
            out,
            current_request_id() or "-",
        )
    except Exception:
        pass


def set_circuit_breaker_metric(*, provider: str, state: str) -> None:
    try:
        p = _label(provider, max_len=64)
        normalized = _label(state, fallback="closed", max_len=16).lower()
        numeric = _CIRCUIT_STATES.get(normalized, 0.0)
        bundle = _get_active_bundle()
        if bundle is not None:
            bundle.circuit_breaker_state.labels(provider=p).set(numeric)
        LOG.info(
            "gen_ai.circuit_breaker provider=%s state=%s request_id=%s",
            p,
            normalized,
            current_request_id() or "-",
        )
    except Exception:
        pass


def record_rate_limit_metric(*, bucket: str) -> None:
    global _FALLBACK_RATE_LIMIT_REJECTIONS
    try:
        b = _label(bucket, max_len=32)
        with _ACTIVE_METRICS_LOCK:
            bundle = _ACTIVE_METRICS
            if bundle is None:
                _FALLBACK_RATE_LIMIT_REJECTIONS += 1
        if bundle is not None:
            bundle.rate_limit_rejections_counter.labels(bucket=b).inc()
            with bundle.lock:
                bundle.rate_limit_rejections += 1
        LOG.info(
            "http.rate_limited bucket=%s request_id=%s",
            b,
            current_request_id() or "-",
        )
    except Exception:
        pass


def rate_limit_rejections_count() -> int:
    with _ACTIVE_METRICS_LOCK:
        bundle = _ACTIVE_METRICS
        fallback = _FALLBACK_RATE_LIMIT_REJECTIONS
    if bundle is not None:
        with bundle.lock:
            return bundle.rate_limit_rejections
    return fallback


class SlidingWindowRateLimiter:
    """Thread-safe per-key sliding-window rate limiter with bounded key LRU."""

    def __init__(
        self,
        limit: int,
        *,
        window_seconds: float = 60.0,
        max_keys: int = 10_000,
        clock: Callable[[], float] = time.monotonic,
    ):
        self.limit = max(0, int(limit))
        self.window_seconds = max(1.0, float(window_seconds))
        self.max_keys = max(1, int(max_keys))
        self._clock = clock
        self._lock = threading.Lock()
        self._buckets: OrderedDict[str, deque[float]] = OrderedDict()

    def allow(self, key: str) -> tuple[bool, int]:
        if self.limit <= 0:
            return True, 0
        now = self._clock()
        cutoff = now - self.window_seconds
        with self._lock:
            q = self._buckets.get(key)
            if q is not None:
                while q and q[0] <= cutoff:
                    q.popleft()
            else:
                q = deque()
            if len(q) >= self.limit:
                retry_after = max(1, int(math.ceil(self.window_seconds - (now - q[0]))))
                self._buckets[key] = q
                self._buckets.move_to_end(key)
                return False, retry_after
            q.append(now)
            self._buckets[key] = q
            self._buckets.move_to_end(key)
            while len(self._buckets) > self.max_keys:
                self._buckets.popitem(last=False)
            return True, 0


def _env_rpm(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    try:
        return max(0, int(raw.strip()))
    except ValueError:
        return default


def _rate_limit_key(scope: dict, headers: dict[bytes, bytes]) -> str:
    client = scope.get("client")
    ip = client[0] if isinstance(client, (tuple, list)) and client else "unknown"
    auth = headers.get(b"authorization", b"")
    if auth:
        return f"{ip}:auth:{sha256(auth).hexdigest()[:16]}"
    cookie = headers.get(b"cookie", b"")
    if cookie:
        return f"{ip}:cookie:{sha256(cookie).hexdigest()[:16]}"
    return f"{ip}:anon"


class RequestEnvelope:
    def __init__(
        self,
        app,
        requests,
        latency,
        *,
        api_limiter: SlidingWindowRateLimiter | None = None,
        turns_limiter: SlidingWindowRateLimiter | None = None,
        bundle: _MetricsBundle | None = None,
    ):
        self.app = app
        self.requests = requests
        self.latency = latency
        self.api_limiter = api_limiter
        self.turns_limiter = turns_limiter
        self.bundle = bundle

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = dict(scope.get("headers") or ())
        raw_req_id = headers.get(b"x-request-id", b"").decode("latin-1", errors="ignore").strip()
        request_id = raw_req_id if REQUEST_ID_RE.fullmatch(raw_req_id) else uuid4().hex
        raw_tp = headers.get(b"traceparent", b"").decode("latin-1", errors="ignore").strip()
        traceparent = raw_tp if TRACEPARENT_RE.fullmatch(raw_tp) else None

        req_token = _REQUEST_ID_VAR.set(request_id)
        tp_token = _TRACEPARENT_VAR.set(traceparent)
        started = time.monotonic()
        method = scope["method"] if scope["method"] in METHODS else "OTHER"
        raw_path = scope["path"]
        status = 500

        async def respond(message):
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
                out_headers = [
                    (name, value)
                    for name, value in message.get("headers", [])
                    if name not in {b"x-request-id", b"traceparent"}
                ]
                out_headers.append((b"x-request-id", request_id.encode("ascii")))
                if traceparent is not None:
                    out_headers.append((b"traceparent", traceparent.encode("ascii")))
                if raw_path.startswith("/v1/"):
                    out_headers = [(name, value) for name, value in out_headers if name != b"cache-control"]
                    out_headers.append((b"cache-control", b"no-store"))
                message = {**message, "headers": out_headers}
            await send(message)

        try:
            if (
                raw_path.startswith("/v1/")
                and raw_path not in {"/healthz", "/readyz", "/metrics"}
                and method not in SAFE_METHODS
            ):
                if raw_path == "/v1/workbench/turns":
                    limiter = self.turns_limiter
                    bucket = "workbench_turns"
                else:
                    limiter = self.api_limiter
                    bucket = "api"
                if limiter is not None:
                    allowed, retry_after = limiter.allow(_rate_limit_key(scope, headers))
                    if not allowed:
                        record_rate_limit_metric(bucket=bucket)
                        if self.bundle is not None and self.bundle is not _get_active_bundle():
                            self.bundle.rate_limit_rejections_counter.labels(bucket=bucket).inc()
                            with self.bundle.lock:
                                self.bundle.rate_limit_rejections += 1
                        reply = JSONResponse(
                            {"detail": {"code": "RATE_LIMITED"}},
                            status_code=429,
                            headers={"Retry-After": str(retry_after)},
                        )
                        return await reply(scope, receive, respond)

            content_type = headers.get(b"content-type", b"").split(b";", 1)[0].strip().lower()
            image = (
                content_type == b"application/octet-stream"
                and raw_path.startswith("/v1/intakes/")
                and raw_path.count("/") == 3
            )
            image = image or (
                content_type == b"application/octet-stream"
                and raw_path in {"/v1/profile/avatar", "/v1/agent-profile/avatar"}
            )
            if method in {"POST", "PUT", "PATCH"} and not image and raw_path.startswith(BOUNDED_JSON_PATHS):
                body_limit = {
                    "/v1/workbench/turns": WORKBENCH_TURN_JSON_LIMIT,
                    "/v1/workbench/documents/parse": DOCUMENT_INPUT_LIMIT,
                }.get(raw_path, JSON_LIMIT)
                body = bytearray()
                while True:
                    remaining = 15 - (time.monotonic() - started)
                    try:
                        async with asyncio.timeout(remaining):
                            chunk = await receive()
                    except TimeoutError:
                        reply = JSONResponse({"detail": "Request body timed out"}, status_code=408)
                        return await reply(scope, receive, respond)
                    if chunk["type"] == "http.disconnect":
                        status = 499
                        return
                    incoming = chunk.get("body", b"")
                    if len(body) + len(incoming) > body_limit:
                        reply = JSONResponse({"detail": "Request body too large"}, status_code=413)
                        return await reply(scope, receive, respond)
                    body.extend(incoming)
                    if not chunk.get("more_body", False):
                        break
                replayed = False

                async def replay():
                    nonlocal replayed
                    if replayed:
                        return await receive()
                    replayed = True
                    return {"type": "http.request", "body": bytes(body), "more_body": False}

                return await self.app(scope, replay, respond)
            return await self.app(scope, receive, respond)
        finally:
            try:
                route = getattr(scope.get("route"), "path", "unmatched")
                if route not in {"/healthz", "/readyz", "/metrics"}:
                    self.requests.labels(method, route, str(status)).inc()
                    self.latency.labels(method, route).observe(time.monotonic() - started)
                    LOG.info(
                        "request id=%s traceparent=%s method=%s route=%s status=%s",
                        request_id,
                        traceparent or "-",
                        method,
                        route,
                        status,
                    )
            finally:
                _REQUEST_ID_VAR.reset(req_token)
                _TRACEPARENT_VAR.reset(tp_token)


def instrument(app: FastAPI, token: str | None):
    global _ACTIVE_METRICS
    registry = CollectorRegistry()
    bundle = _MetricsBundle(registry)
    with _ACTIVE_METRICS_LOCK:
        _ACTIVE_METRICS = bundle
    app.state.observability = bundle

    api_limiter = SlidingWindowRateLimiter(_env_rpm("AIOS_API_RATE_LIMIT_RPM", 600))
    turns_limiter = SlidingWindowRateLimiter(_env_rpm("AIOS_TURNS_RATE_LIMIT_RPM", 120))
    app.add_middleware(
        RequestEnvelope,
        requests=bundle.requests,
        latency=bundle.latency,
        api_limiter=api_limiter,
        turns_limiter=turns_limiter,
        bundle=bundle,
    )
    if token:
        if len(token) < 32:
            raise ValueError("Configure a dedicated metrics token of at least 32 characters")

        @app.get("/metrics", include_in_schema=False)
        def metrics(request: Request):
            auth = request.headers.get("authorization", "")
            if not compare_digest(auth.encode(), ("Bearer " + token).encode()):
                raise HTTPException(401, "Metrics credentials required")
            return Response(
                generate_latest(registry),
                headers={"Content-Type": CONTENT_TYPE_LATEST, "Cache-Control": "no-store"},
            )
