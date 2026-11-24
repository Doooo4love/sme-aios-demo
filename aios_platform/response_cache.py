"""Bounded thread-safe L1 response cache and deterministic JSON tool-observation compactor."""
from __future__ import annotations

from collections import OrderedDict
import copy
from dataclasses import dataclass
from hashlib import sha256
import json
import re
import threading
import time
from typing import Any

ESSENTIAL_BUSINESS_KEYS: frozenset[str] = frozenset(
    {
        "id",
        "status",
        "warehouse",
        "delivery_date",
        "sku",
        "qty",
        "amount",
        "subject",
        "due",
        "proposal_id",
        "source",
    }
)

_OMIT = object()
_WHITESPACE_RE = re.compile(r"\s+")


def _scope_tag(tenant: str, subject: str) -> str:
    raw = json.dumps([str(tenant), str(subject)], separators=(",", ":"), ensure_ascii=False)
    return sha256(raw.encode("utf-8")).hexdigest()[:16]


def normalize_query_for_cache(query: str) -> str:
    """Normalize query whitespace/case and return its SHA-256 hex digest."""
    compact = _WHITESPACE_RE.sub(" ", (query or "").strip()).lower()
    return sha256(compact.encode("utf-8")).hexdigest()


@dataclass
class _CacheEntry:
    value: dict[str, Any]
    expires_at: float
    saved_tokens: int
    saved_usd: float


class BoundedResponseCache:
    """Thread-safe LRU + TTL L1 cache for pure read-only, zero-side-effect assistant replies."""

    def __init__(self, max_entries: int = 512, ttl_seconds: float = 180.0):
        self.max_entries = max(0, int(max_entries))
        self.ttl_seconds = max(0.0, float(ttl_seconds))
        self._lock = threading.Lock()
        self._entries: OrderedDict[str, _CacheEntry] = OrderedDict()
        self._hits = 0
        self._misses = 0
        self._tokens_saved = 0
        self._usd_saved = 0.0

    @staticmethod
    def make_key(
        tenant: str,
        subject: str,
        role: str = "",
        locale: str = "zh-CN",
        memory_version: int | str = 0,
        active_doc_sha: str = "",
        normalized_query_hash: str = "",
        *,
        query: str | None = None,
    ) -> str:
        """Build a tenant/subject/role/locale/memory/doc-isolated SHA-256 cache key."""
        q_hash = normalized_query_hash or (normalize_query_for_cache(query) if query is not None else "")
        payload = json.dumps(
            [
                str(tenant),
                str(subject),
                str(role),
                str(locale),
                str(memory_version),
                str(active_doc_sha or ""),
                str(q_hash),
            ],
            separators=(",", ":"),
            ensure_ascii=False,
        )
        digest = sha256(payload.encode("utf-8")).hexdigest()
        return f"{_scope_tag(tenant, subject)}:{digest}"

    def _purge_expired_locked(self, now: float) -> None:
        expired_keys = [k for k, entry in self._entries.items() if now >= entry.expires_at]
        for k in expired_keys:
            del self._entries[k]

    def get(self, key: str) -> dict[str, Any] | None:
        if self.max_entries <= 0 or self.ttl_seconds <= 0.0 or not key:
            with self._lock:
                self._misses += 1
            return None
        now = time.monotonic()
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                self._misses += 1
                return None
            if now >= entry.expires_at:
                del self._entries[key]
                self._misses += 1
                return None
            self._entries.move_to_end(key)
            self._hits += 1
            self._tokens_saved += entry.saved_tokens
            self._usd_saved += entry.saved_usd
            return copy.deepcopy(entry.value)

    def put(
        self,
        key: str,
        value: dict[str, Any],
        *,
        saved_tokens: int = 0,
        saved_usd: float = 0.0,
    ) -> None:
        if self.max_entries <= 0 or self.ttl_seconds <= 0.0 or not key:
            return
        now = time.monotonic()
        stored = _CacheEntry(
            value=copy.deepcopy(dict(value)),
            expires_at=now + self.ttl_seconds,
            saved_tokens=max(0, int(saved_tokens)),
            saved_usd=max(0.0, float(saved_usd)),
        )
        with self._lock:
            self._purge_expired_locked(now)
            self._entries[key] = stored
            self._entries.move_to_end(key)
            while len(self._entries) > self.max_entries:
                self._entries.popitem(last=False)

    def invalidate_subject(self, tenant: str, subject: str) -> int:
        prefix = f"{_scope_tag(tenant, subject)}:"
        with self._lock:
            targets = [k for k in self._entries if k.startswith(prefix)]
            for k in targets:
                del self._entries[k]
            return len(targets)

    def stats(self) -> dict[str, Any]:
        now = time.monotonic()
        with self._lock:
            self._purge_expired_locked(now)
            total = self._hits + self._misses
            return {
                "hits": self._hits,
                "misses": self._misses,
                "hit_ratio": round(self._hits / total, 4) if total > 0 else 0.0,
                "entries": len(self._entries),
                "max_entries": self.max_entries,
                "estimated_usd_saved": round(self._usd_saved, 6),
                "tokens_saved": self._tokens_saved,
            }


def _truncate_text(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    if limit <= 16:
        return text[:limit]
    marker = "...[truncated]"
    if limit <= len(marker) + 4:
        return text[: max(1, limit - 3)] + "..."
    return text[: limit - 3] + "..."


def _clean_node(
    node: Any,
    *,
    list_cap: int | None,
    str_cap: int | None,
    essential_only: bool,
    current_key: str | None = None,
) -> Any:
    if node is None:
        return _OMIT
    if isinstance(node, bool):
        return node
    if isinstance(node, (int, float)):
        return node
    if isinstance(node, str):
        if node == "":
            return _OMIT
        if str_cap is not None and len(node) > str_cap:
            # Allow slightly longer essential strings unless severely constrained.
            cap = str_cap if current_key not in ESSENTIAL_BUSINESS_KEYS else max(str_cap, min(len(node), str_cap * 2))
            if len(node) > cap:
                return _truncate_text(node, cap)
        return node
    if isinstance(node, (list, tuple)):
        cleaned_items: list[Any] = []
        for item in node:
            cleaned = _clean_node(
                item,
                list_cap=list_cap,
                str_cap=str_cap,
                essential_only=essential_only,
                current_key=current_key,
            )
            if cleaned is not _OMIT:
                cleaned_items.append(cleaned)
        if not cleaned_items:
            return _OMIT
        if list_cap is not None and len(cleaned_items) > list_cap:
            omitted = len(cleaned_items) - list_cap
            kept = cleaned_items[:list_cap]
            kept.append({"_omitted_items": omitted})
            return kept
        return cleaned_items
    if isinstance(node, dict):
        out: dict[str, Any] = {}
        for k in sorted(node.keys(), key=lambda x: str(x)):
            k_str = str(k)
            val = node[k]
            if essential_only and k_str not in ESSENTIAL_BUSINESS_KEYS and k_str != "_omitted_items":
                if not isinstance(val, (dict, list, tuple)):
                    continue
            cleaned = _clean_node(
                val,
                list_cap=list_cap,
                str_cap=str_cap,
                essential_only=essential_only,
                current_key=k_str,
            )
            if cleaned is not _OMIT:
                out[k_str] = cleaned
        if not out:
            return _OMIT
        return out
    text = str(node)
    if not text:
        return _OMIT
    if str_cap is not None and len(text) > str_cap:
        return _truncate_text(text, str_cap)
    return text


def _dump_json(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _extract_essential_scalars(node: Any, out: dict[str, Any], limit: int = 8) -> None:
    if len(out) >= limit:
        return
    if isinstance(node, dict):
        for k in sorted(node.keys(), key=lambda x: str(x)):
            k_str = str(k)
            v = node[k]
            if k_str in ESSENTIAL_BUSINESS_KEYS and not isinstance(v, (dict, list, tuple)):
                if v is not None and v != "" and k_str not in out:
                    out[k_str] = v
                    if len(out) >= limit:
                        return
            elif isinstance(v, (dict, list, tuple)):
                _extract_essential_scalars(v, out, limit)
    elif isinstance(node, (list, tuple)):
        for item in node:
            _extract_essential_scalars(item, out, limit)
            if len(out) >= limit:
                return


def compact_tool_observation(data: Any, *, max_chars: int = 2400) -> str:
    """Deterministically compact tool results (stripping empty values, capping lists, keeping business keys)."""
    budget = max(32, int(max_chars))
    parsed: Any = data
    if isinstance(data, str):
        stripped = data.strip()
        if not stripped:
            return ""
        if stripped.startswith(("{", "[")):
            try:
                loaded = json.loads(stripped)
                if isinstance(loaded, (dict, list)):
                    parsed = loaded
                else:
                    return _truncate_text(stripped, budget)
            except ValueError:
                return _truncate_text(stripped, budget)
        else:
            return _truncate_text(stripped, budget)

    if not isinstance(parsed, (dict, list, tuple)):
        if parsed is None:
            return "{}"
        if isinstance(parsed, bool):
            return "true" if parsed else "false"
        if isinstance(parsed, (int, float)):
            return str(parsed)
        return _truncate_text(str(parsed), budget)

    # Progressive compaction schedule: try retaining full detail first, tightening deterministically until <= max_chars.
    schedules: tuple[tuple[int | None, int | None, bool], ...] = (
        (12, None, False),
        (8, 320, False),
        (5, 200, False),
        (3, 140, False),
        (3, 140, True),
        (2, 96, True),
        (1, 64, True),
        (0, 48, True),
    )

    last_valid_json = "{}"
    for list_cap, str_cap, essential_only in schedules:
        cleaned = _clean_node(parsed, list_cap=list_cap, str_cap=str_cap, essential_only=essential_only)
        if cleaned is _OMIT:
            if essential_only:
                continue
            return "[]" if isinstance(parsed, (list, tuple)) else "{}"
        serialized = _dump_json(cleaned)
        last_valid_json = serialized
        if len(serialized) <= budget:
            return serialized

    # Extreme budget fallback: preserve first essential scalar fields inside a valid JSON object.
    summary_obj: dict[str, Any] = {}
    _extract_essential_scalars(parsed, summary_obj, limit=6)
    summary_obj["_truncated"] = True
    while True:
        candidate = _dump_json(summary_obj)
        if len(candidate) <= budget:
            return candidate
        removable = [k for k in summary_obj if k != "_truncated"]
        if not removable:
            break
        # Trim longest string field or pop last non-essential/oldest key until it fits.
        longest_k = max(removable, key=lambda k: len(str(summary_obj[k])))
        val = summary_obj[longest_k]
        if isinstance(val, str) and len(val) > 20:
            summary_obj[longest_k] = _truncate_text(val, max(12, len(val) // 2))
        else:
            summary_obj.pop(longest_k, None)

    return _truncate_text(last_valid_json, budget)
