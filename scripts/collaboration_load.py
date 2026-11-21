"""Synthetic contention probe for profile CAS, meeting overlaps and Agent replay."""
from argparse import ArgumentParser
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import secrets
import sys
from tempfile import TemporaryDirectory
import time
from unittest.mock import patch

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from aios_platform.api import create_app


def burst(app, calls, concurrency, send):
    def measured(index):
        started = time.monotonic()
        with TestClient(app, raise_server_exceptions=False) as client:
            reply = send(client, index)
        return reply.status_code, (time.monotonic() - started) * 1000

    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        results = list(pool.map(measured, range(calls)))
    timing = sorted(ms for _, ms in results)
    return Counter(status for status, _ in results), round(timing[(len(timing) * 95 + 99) // 100 - 1], 2)


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("--clients", type=int, default=20)
    parser.add_argument("--requests", type=int, default=120, help="Requests per scenario")
    args = parser.parse_args()
    if not 1 <= args.clients <= 40 or not 1 <= args.requests <= 1000:
        parser.error("Use 1–40 clients and 1–1000 requests per scenario")
    with TemporaryDirectory() as state, patch.dict("os.environ", {
        "AIOS_PROFILE": "demo", "AIOS_PLANNER": "demo", "AIOS_WORKBENCH_PLANNER": "local",
        "AIOS_DEMO_SECRET": secrets.token_urlsafe(32), "AIOS_PLATFORM_STATE_DIR": state,
        "AIOS_PLATFORM_DSN": os.getenv("AIOS_COLLABORATION_LOAD_DSN", ""),
        "AIOS_PLATFORM_DSN_FILE": "",
    }, clear=True):
        app = create_app()
        auth = {"Authorization": "Bearer " + os.environ["AIOS_DEMO_SECRET"] + ".operator"}
        start = datetime.now(timezone.utc) + timedelta(hours=2)
        event = {"title": "Synthetic scheduling race", "starts_at": start.isoformat(),
                 "ends_at": (start + timedelta(minutes=30)).isoformat()}

        def profile(client, i):
            return client.patch("/v1/profile", headers=auth, json={"version": 0, "display_name": f"Probe {i}"})

        def calendar(client, i):
            return client.post("/v1/calendar/events", headers=auth, json={**event, "client_id": f"probe-{i}"})

        def history(client, _index):
            return client.post("/v1/workbench/turns", headers=auth,
                               json={"text": "Show shipment SHP-1001 in HK01", "client_id": "probe-history"})

        output = {}
        for name, send, accepted in (("profile", profile, 200), ("calendar", calendar, 201), ("history", history, 200)):
            statuses, p95 = burst(app, args.requests, args.clients, send)
            if set(statuses) - {accepted, 409, 503} or statuses[accepted] < 1:
                raise RuntimeError(f"{name}: unexpected outcomes {dict(statuses)}")
            if name != "history" and statuses[accepted] != 1:
                raise RuntimeError(f"{name}: concurrent writes succeeded more than once")
            output[name] = {"statuses": dict(statuses), "p95_ms": p95}
        with TestClient(app) as client:
            history_rows = client.get("/v1/workbench/history", headers=auth).json()["items"]
            if len(history_rows) != 1:
                raise RuntimeError("History replay created duplicate records")
            verified = client.get("/v1/workbench/history/probe-history", headers=auth)
            if verified.status_code != 200 or verified.json().get("kind") != "result":
                raise RuntimeError("History did not recover")
        print(json.dumps({"requests_per_scenario": args.requests, "clients": args.clients,
                          "history_records": len(history_rows), "results": output}, indent=2))


if __name__ == "__main__":
    main()
