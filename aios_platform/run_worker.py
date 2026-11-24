"""Consume approvals as a separate process using the ERP write identity."""
from __future__ import annotations

import argparse
import logging
import os
import signal
import threading
import time

from pydantic import TypeAdapter

from .contracts import Identifier
from .service import services, setting
from .workflow import tick

LOG = logging.getLogger("aios.worker")
_IDLE_SLEEP_SECONDS = 0.5
_MIN_BACKOFF_SECONDS = 0.5
_MAX_BACKOFF_SECONDS = 5.0


def run_worker_loop(
    runtime,
    tenants: tuple[str, ...],
    *,
    once: bool = False,
    stop_event: threading.Event | None = None,
) -> None:
    """Run tenant tick loop with per-tenant exception isolation, backoff, and clean shutdown."""
    event = stop_event if stop_event is not None else threading.Event()
    backoff_by_tenant: dict[str, float] = {}
    next_retry_by_tenant: dict[str, float] = {}

    try:
        while not event.is_set():
            now = time.monotonic()
            worked = False
            for tenant in tenants:
                if event.is_set():
                    break
                retry_at = next_retry_by_tenant.get(tenant)
                if retry_at is not None and now < retry_at:
                    continue
                try:
                    if tick(runtime.workflow, runtime.erp, tenant):
                        worked = True
                    backoff_by_tenant.pop(tenant, None)
                    next_retry_by_tenant.pop(tenant, None)
                except Exception:
                    LOG.exception("Worker tick failed for tenant=%s", tenant)
                    prev = backoff_by_tenant.get(tenant, 0.0)
                    delay = _MIN_BACKOFF_SECONDS if prev <= 0.0 else min(_MAX_BACKOFF_SECONDS, prev * 2.0)
                    backoff_by_tenant[tenant] = delay
                    next_retry_by_tenant[tenant] = time.monotonic() + delay
            if once:
                return
            if not worked:
                if len(next_retry_by_tenant) == len(tenants) and next_retry_by_tenant:
                    wait_for = max(0.05, min(next_retry_by_tenant.values()) - time.monotonic())
                    event.wait(min(_MAX_BACKOFF_SECONDS, wait_for))
                else:
                    event.wait(_IDLE_SLEEP_SECONDS)
    finally:
        try:
            runtime.workflow.db.close()
        except Exception:
            LOG.exception("Failed closing workflow database on worker exit")
        erp_close = getattr(getattr(runtime.erp, "db", None), "close", None)
        if callable(erp_close):
            try:
                erp_close()
            except Exception:
                LOG.exception("Failed closing ERP database on worker exit")


def main(argv: list[str] | None = None, *, stop_event: threading.Event | None = None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args(argv)
    event = stop_event if stop_event is not None else threading.Event()

    def _handle_signal(_signum, _frame) -> None:
        event.set()

    previous_handlers: dict[int, object] = {}
    if threading.current_thread() is threading.main_thread():
        for sig in (signal.SIGTERM, signal.SIGINT):
            previous_handlers[sig] = signal.getsignal(sig)
            signal.signal(sig, _handle_signal)

    try:
        runtime = services(worker=True)
        configured = os.getenv("AIOS_WORKER_TENANTS", "harbour,island") if runtime.demo else setting("AIOS_CONNECTOR_TENANT")
        tenants = tuple(TypeAdapter(Identifier).validate_python(value.strip()) for value in configured.split(","))
        run_worker_loop(runtime, tenants, once=args.once, stop_event=event)
    finally:
        for sig, handler in previous_handlers.items():
            signal.signal(sig, handler)


if __name__ == "__main__":
    main()
