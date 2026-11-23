"""Nightly consolidation CLI for per-user long-term MEMORY.md and passive staging queues."""
from __future__ import annotations

import argparse
import json
import sys
import time
from typing import Any

from .assistant_agent import (
    resolve_llm_api_key,
    resolve_llm_base_url,
    resolve_llm_model,
    resolve_llm_provider,
)
from .contracts import Actor
from .llm_provider import LLMProvider
from .routing_context import RoutingTelemetryStore, approx_tokens
from .service import services
from .user_memory import (
    UserMemoryStore,
    _ensure_user_memory_tables_sqlite,
    tidy_markdown_deterministic,
)


def _discover_candidates(
    workflow,
    *,
    tenant: str | None = None,
    subject: str | None = None,
    stale_cutoff: float,
) -> list[tuple[str, str]]:
    """Find (tenant, subject) pairs needing consolidation (pending cues, stale, or >900 tokens)."""
    candidates: set[tuple[str, str]] = set()
    with workflow.db.transaction(write=False) as run:
        _ensure_user_memory_tables_sqlite(workflow, run)
        if getattr(workflow.db, "dsn", None) and tenant:
            run("SELECT set_config('aios.tenant', ?, true)", (tenant,))

        staged_clauses = ["status = 'pending'"]
        staged_params: list[Any] = []
        if tenant:
            staged_clauses.append("tenant = ?")
            staged_params.append(tenant)
        if subject:
            staged_clauses.append("subject = ?")
            staged_params.append(subject)
        staged_rows = run(
            f"SELECT DISTINCT tenant, subject FROM aios_user_memory_staging WHERE {' AND '.join(staged_clauses)}",
            tuple(staged_params),
        ).fetchall()
        for row in staged_rows:
            candidates.add((str(row["tenant"]), str(row["subject"])))

        mem_clauses = ["(last_tidy_at IS NULL OR last_tidy_at < ? OR token_count > 900)"]
        mem_params: list[Any] = [stale_cutoff]
        if tenant:
            mem_clauses.append("tenant = ?")
            mem_params.append(tenant)
        if subject:
            mem_clauses.append("subject = ?")
            mem_params.append(subject)
        mem_rows = run(
            f"SELECT DISTINCT tenant, subject FROM aios_user_memory WHERE {' AND '.join(mem_clauses)}",
            tuple(mem_params),
        ).fetchall()
        for row in mem_rows:
            candidates.add((str(row["tenant"]), str(row["subject"])))

    return sorted(candidates)


def run_memory_tidy_batch(
    workflow,
    *,
    tenant: str | None = None,
    subject: str | None = None,
    dry_run: bool = False,
    use_llm: bool = False,
    stale_days: int = 7,
    llm_provider: LLMProvider | None = None,
    now: float | None = None,
) -> dict[str, Any]:
    """Scan eligible users and consolidate MEMORY.md deterministically (or gated T2 with use_llm)."""
    ts = time.time() if now is None else now
    stale_cutoff = ts - max(0, stale_days) * 86_400
    candidates = _discover_candidates(
        workflow,
        tenant=tenant,
        subject=subject,
        stale_cutoff=stale_cutoff,
    )
    store = UserMemoryStore(workflow)
    telemetry = RoutingTelemetryStore(workflow)
    results: list[dict[str, Any]] = []
    total_merged = 0
    total_removed_duplicates = 0
    llm_consolidated_users = 0

    for item_tenant, item_subject in candidates:
        actor = Actor(
            subject=item_subject,
            tenant=item_tenant,
            role="operator",
            warehouses=frozenset(),
        )
        try:
            if dry_run:
                state = store.get(actor)
                pending_pairs = [(p.fact_text, p.section_hint) for p in state.pending_staged_items]
                new_content, merged_count, removed_dupes = tidy_markdown_deterministic(state.content, pending_pairs)
                would_use_llm = bool(
                    use_llm
                    and llm_provider is not None
                    and llm_provider.enabled
                    and (len(pending_pairs) > 0 or state.token_count > 900)
                )
                entry = {
                    "tenant": item_tenant,
                    "subject": item_subject,
                    "merged_count": merged_count,
                    "removed_duplicates": removed_dupes,
                    "used_llm": False,
                    "would_use_llm": would_use_llm,
                    "token_count": approx_tokens(new_content) if new_content else 0,
                    "version": state.version,
                }
            else:
                res = store.tidy(
                    actor,
                    use_llm=use_llm,
                    llm_provider=llm_provider,
                    telemetry=telemetry,
                    now=ts,
                )
                entry = {
                    "tenant": item_tenant,
                    "subject": item_subject,
                    "merged_count": res.merged_count,
                    "removed_duplicates": res.removed_duplicates,
                    "used_llm": res.used_llm,
                    "token_count": res.memory.token_count,
                    "version": res.memory.version,
                }
                if res.used_llm:
                    llm_consolidated_users += 1
            total_merged += entry["merged_count"]
            total_removed_duplicates += entry["removed_duplicates"]
            results.append(entry)
        except PermissionError:
            # Skip suspended subjects safely during batch maintenance.
            continue

    return {
        "scanned_users": len(candidates),
        "tidied_users": len(results) if not dry_run else 0,
        "dry_run": dry_run,
        "use_llm": use_llm,
        "stale_days": stale_days,
        "total_merged": total_merged,
        "total_removed_duplicates": total_removed_duplicates,
        "llm_consolidated_users": llm_consolidated_users,
        "results": results,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m aios_platform.memory_tidy",
        description="Nightly consolidation for per-user MEMORY.md and passive staging queues.",
    )
    parser.add_argument("--tenant", help="Restrict consolidation to a single tenant ID.")
    parser.add_argument("--subject", help="Restrict consolidation to a single user subject.")
    parser.add_argument("--dry-run", action="store_true", help="Preview consolidation without writing changes.")
    parser.add_argument(
        "--use-llm",
        action="store_true",
        help="Enable gated T2 (effort='low') LLM consolidation when an LLM key is configured.",
    )
    parser.add_argument(
        "--stale-days",
        type=int,
        default=7,
        help="Tidy users whose last_tidy_at is older than this many days (default: 7).",
    )
    args = parser.parse_args(argv)

    runtime = services(worker=False)
    llm_provider: LLMProvider | None = None
    if args.use_llm:
        api_key = resolve_llm_api_key()
        if api_key:
            model = resolve_llm_model()
            llm_provider = LLMProvider(
                api_key=api_key,
                model=model,
                base_url=resolve_llm_base_url(model),
                provider=resolve_llm_provider(),
            )

    summary = run_memory_tidy_batch(
        runtime.workflow,
        tenant=args.tenant,
        subject=args.subject,
        dry_run=args.dry_run,
        use_llm=args.use_llm,
        stale_days=args.stale_days,
        llm_provider=llm_provider,
    )
    sys.stdout.write(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
