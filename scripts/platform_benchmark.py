"""Measure synthetic structured intake and approval on the local API."""
from datetime import date, timedelta
import json
from pathlib import Path
from statistics import median
import secrets
import sys
from tempfile import TemporaryDirectory
from time import perf_counter
from unittest.mock import patch

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from aios_platform.api import build_app
from aios_platform.identity import DemoIdentity
from aios_platform.providers import DemoPlanner
from aios_platform.service import services
from aios_platform.workflow import tick

QUANTITY = 250
BATCH = 50
RUNS = 3
INTAKES = "/v1/intakes/HK01/structured"


def measure(orders: list[dict], *, batched: bool) -> dict:
    with TemporaryDirectory() as state, patch.dict("os.environ", {
        "AIOS_PROFILE": "demo", "AIOS_PLATFORM_STATE_DIR": state,
        "AIOS_PLATFORM_DSN": "", "AIOS_PLATFORM_DSN_FILE": "",
        "AIOS_TENANT_PROFILES": str(ROOT / "deploy/platform/demo-profiles.json"),
    }):
        runtime = services()
        planner = DemoPlanner()
        secret = secrets.token_urlsafe(32)
        api_requests = 0
        with TestClient(build_app(runtime, DemoIdentity(secret), planner, planner_limit=10000)) as client:
            def call(route, body, actor="operator"):
                nonlocal api_requests
                api_requests += 1
                response = client.post(route, json=body, headers={"Authorization": f"Bearer {secret}.{actor}"})
                response.raise_for_status()
                return response.json()

            start = perf_counter()
            if batched:
                for offset in range(0, len(orders), BATCH):
                    prepared = call(INTAKES + "/batch", {"orders": orders[offset:offset + BATCH]})["items"]
                    approvals = [{"proposal_id": item["proposal_id"], "digest": item["digest"]} for item in prepared]
                    result = call("/v1/proposals/approve-batch", {"proposals": approvals}, "manager")
                    if any(item["status"] != 202 for item in result["items"]):
                        raise RuntimeError(result)
            else:
                for order in orders:
                    intake = call(INTAKES, order)["intake_id"]
                    proposal = call("/v1/actions", {"text": "Create draft for intake " + intake})
                    call(f"/v1/proposals/{proposal['id']}/approve", {"digest": proposal["digest"]}, "manager")
            prepare_seconds = perf_counter() - start

        start = perf_counter()
        while tick(runtime.workflow, runtime.erp, "harbour"):
            pass
        dispatch_seconds = perf_counter() - start
        with runtime.workflow.tx("harbour", write=False) as run:
            verified = run("SELECT COUNT(*) AS count FROM aios_proposal WHERE state = 'VERIFIED'").fetchone()["count"]
        if verified != len(orders):
            raise RuntimeError(f"Expected {len(orders)} verified operations, received {verified}")
        return {"api_requests": api_requests, "prepare_seconds": prepare_seconds,
                "dispatch_seconds": dispatch_seconds, "verified": verified}


def main():
    day = (date.today() + timedelta(days=7)).isoformat()
    orders = [
        {"po": f"BENCH-{index}", "buyer": "HBR-47", "delivery": day, "currency": "HKD", "total": "50",
         "lines": [{"sku": "TEA-24", "unit": "CASE", "quantity": 2, "unit_price": "25", "amount": "50"}]}
        for index in range(QUANTITY)
    ]
    measurements = {mode: [] for mode in ("single", "batch")}
    for _ in range(RUNS):
        for mode in measurements:
            measurements[mode].append(measure(orders, batched=mode == "batch"))
    results = {
        mode: {key: round(median(run[key] for run in runs), 4) for key in runs[0]}
        for mode, runs in measurements.items()
    }
    print(json.dumps({"orders_per_run": QUANTITY, "runs": RUNS, "batch_size": BATCH, **results}, indent=2))


if __name__ == "__main__":
    main()
