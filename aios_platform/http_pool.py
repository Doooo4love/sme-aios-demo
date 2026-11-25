"""Thread-safe shared HTTP connection pooling for outbound platform adapters."""
from __future__ import annotations

import atexit
import json
import threading
import time
from typing import Any

import httpx

MAX_HTTP_RESPONSE_BYTES = 65_536
_DEFAULT_LIMITS = httpx.Limits(
    max_connections=32,
    max_keepalive_connections=16,
    keepalive_expiry=30.0,
)

_POOL_LOCK = threading.Lock()
_CLIENTS: dict[tuple[str, float], httpx.Client] = {}


def get_http_client(pool_name: str = "default", *, timeout: float = 8.0) -> httpx.Client:
    """Return a thread-safe pooled httpx.Client keyed by (pool_name, round(timeout, 2))."""
    normalized_timeout = round(float(timeout), 2)
    key = (pool_name, normalized_timeout)
    with _POOL_LOCK:
        client = _CLIENTS.get(key)
        if client is None or client.is_closed:
            client = httpx.Client(
                follow_redirects=False,
                trust_env=False,
                timeout=normalized_timeout,
                limits=_DEFAULT_LIMITS,
            )
            _CLIENTS[key] = client
        return client


def pooled_post_json(
    url: str,
    payload: dict[str, Any],
    headers: dict[str, str] | None = None,
    *,
    pool_name: str = "default",
    timeout: float = 8.0,
    max_bytes: int = MAX_HTTP_RESPONSE_BYTES,
    deadline_s: float | None = None,
) -> dict[str, Any]:
    """POST JSON via a pooled client with streaming response size enforcement."""
    client = get_http_client(pool_name, timeout=timeout)
    deadline = None if deadline_s is None else time.monotonic() + deadline_s
    with client.stream("POST", url, json=payload, headers=headers) as response:
        response.raise_for_status()
        if deadline is not None and time.monotonic() >= deadline:
            raise httpx.ReadTimeout("Provider response exceeded the time limit")
        if deadline is not None and response.headers.get("Content-Encoding", "identity").lower() != "identity":
            raise ValueError("Provider returned an unsupported content encoding")
        chunks = bytearray()
        # Process transport chunks directly for deadline-bound calls, including slow small chunks.
        for chunk in response.iter_bytes(None if deadline is not None else 8192):
            if deadline is not None and time.monotonic() >= deadline:
                raise httpx.ReadTimeout("Provider response exceeded the time limit")
            chunks.extend(chunk)
            if len(chunks) > max_bytes:
                raise ValueError("Provider response exceeded the size limit")
    data = json.loads(chunks)
    if not isinstance(data, dict):
        raise ValueError("Expected a provider response object")
    return data


def close_all_http_clients() -> None:
    """Close and clear all pooled httpx.Client instances cleanly."""
    with _POOL_LOCK:
        clients = list(_CLIENTS.values())
        _CLIENTS.clear()
    for client in clients:
        try:
            client.close()
        except Exception:
            pass


atexit.register(close_all_http_clients)
