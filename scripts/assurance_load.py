"""Exercise concurrent synthetic assurance requests without a network or a model."""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
import json
from math import ceil
from pathlib import Path
import secrets
import sys
from tempfile import TemporaryDirectory
from time import perf_counter
from unittest.mock import patch

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from aios_platform.api import build_app
from aios_platform.assurance import Assurance
from aios_platform.assurance_audit import AuditKeys, SignedAudit, verify_chain
from aios_platform.assurance_gateway import ReviewGateway
from aios_platform.assurance_policy import DemoCaseSource
from aios_platform.identity import DemoIdentity
from aios_platform.providers import DemoPlanner
from aios_platform.service import services

ENDPOINT = "/v1/assurance/cases/PO-100/reviews"
RETRYABLE = {"ASSURANCE_OVERLOADED", "STORAGE_UNAVAILABLE"}


def run_load(clients: int, reviews: int) -> dict:
    with TemporaryDirectory() as state, patch.dict("os.environ", {
        "AIOS_PROFILE": "demo", "AIOS_PLATFORM_STATE_DIR": state,
        "AIOS_PLATFORM_DSN": "", "AIOS_PLATFORM_DSN_FILE": "",
        "AIOS_TENANT_PROFILES": str(ROOT / "deploy/platform/demo-profiles.json"),
    }):
        runtime = services()
        keys = AuditKeys(Ed25519PrivateKey.generate(), AESGCM(AESGCM.generate_key(bit_length=256)))
        audit = SignedAudit(runtime.workflow, keys)
        assurance = Assurance(DemoCaseSource(), ReviewGateway(audit, "hk-factory"))
        secret = secrets.token_urlsafe(32)
        app = build_app(runtime, DemoIdentity(secret), DemoPlanner(), assurance=assurance)
        headers = {"Authorization": f"Bearer {secret}.operator"}
        verified = {}
        pending = set()
        with TestClient(app) as client:
            def submit(index):
                start = perf_counter()
                response = client.post(ENDPOINT, headers=headers, json={"client_id": f"load-{index}"})
                return index, response, perf_counter() - start

            def record(index, response):
                response.raise_for_status()
                identifier = response.json()["id"]
                if verified.setdefault(index, identifier) != identifier:
                    raise RuntimeError(f"Replay returned a different review for input {index}")

            start = perf_counter()
            with ThreadPoolExecutor(max_workers=clients) as pool:
                results = list(pool.map(submit, (index // 2 for index in range(reviews * 2))))
            elapsed = perf_counter() - start
            outcomes = Counter()
            for index, response, _ in results:
                if response.status_code == 201:
                    record(index, response)
                    outcomes["201"] += 1
                else:
                    code = response.json()["detail"]["code"]
                    if response.status_code != 503 or code not in RETRYABLE or "Retry-After" not in response.headers:
                        response.raise_for_status()
                    outcomes[code] += 1
                    pending.add(index)
            for index in sorted(pending):
                _, response, _ = submit(index)
                record(index, response)

        with runtime.workflow.tx("harbour", write=False) as query:
            rows = query("SELECT * FROM aios_assurance_audit ORDER BY seq").fetchall()
        checkpoint = audit.checkpoint("harbour")
        verify_chain(rows, "harbour", {audit.key_id: keys.signer.public_key()}, checkpoint)
        if len(set(verified.values())) != reviews or checkpoint["seq"] != reviews:
            raise RuntimeError("Expected one finalized review and one signed event per input")
        samples = sorted(seconds * 1000 for _, _, seconds in results)
        return {"clients": clients, "requests": len(results), "outcomes": outcomes,
                "retried_keys_after_burst": len(pending), "finalized_reviews": len(verified),
                "signed_events": checkpoint["seq"], "seconds": round(elapsed, 3),
                "latency_ms": {f"p{q}": round(samples[ceil(len(samples) * q / 100) - 1], 2) for q in (50, 95, 99)}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--clients", type=int, default=16)
    parser.add_argument("--reviews", type=int, default=100)
    args = parser.parse_args()
    if not 1 <= args.clients <= 64 or not 1 <= args.reviews <= 1000:
        parser.error("clients must be between 1 and 64 and reviews between 1 and 1000")
    print(json.dumps(run_load(args.clients, args.reviews), indent=2))


if __name__ == "__main__":
    main()
