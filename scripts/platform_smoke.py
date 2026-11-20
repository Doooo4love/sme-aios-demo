"""Run both backend verticals with a disposable store and no external credentials."""
from datetime import date, timedelta
import json
from pathlib import Path
import secrets
import sys
from tempfile import TemporaryDirectory
from unittest.mock import patch

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from aios_platform.api import build_app
from aios_platform.identity import DemoIdentity
from aios_platform.providers import DemoPlanner
from aios_platform.service import services


def main():
    with TemporaryDirectory() as state, patch.dict("os.environ", {
        "AIOS_PROFILE": "demo", "AIOS_PLATFORM_STATE_DIR": state,
        "AIOS_PLATFORM_DSN": "", "AIOS_PLATFORM_DSN_FILE": "",
        "AIOS_TENANT_PROFILES": str(ROOT / "deploy/platform/demo-profiles.json"),
    }):
        secret = secrets.token_urlsafe(32)
        with TestClient(build_app(services(), DemoIdentity(secret), DemoPlanner())) as client:
            def call(method, route, actor, **kwargs):
                headers = {"Authorization": f"Bearer {secret}.{actor}"}
                response = client.request(method, route, headers={**headers, **kwargs.pop("headers", {})}, **kwargs)
                response.raise_for_status()
                return response.json()

            day = (date.today() + timedelta(days=14)).isoformat()
            upload = call("POST", "/v1/intakes/HK01", "operator",
                          content=(ROOT / "fixtures/harbour-po.png").read_bytes(),
                          headers={"Content-Type": "application/octet-stream"})
            results = []
            for text in (f"将运单 SHP-1001 改到 {day}", f"Create draft for intake {upload['intake_id']}"):
                proposal = call("POST", "/v1/actions", "operator", json={"text": text})
                path = "/v1/proposals/" + proposal["id"]
                call("POST", path + "/approve", "manager", json={"digest": proposal["digest"]})
                for _ in range(2):
                    call("POST", "/v1/demo/worker-tick", "admin")
                final = call("GET", path, "operator")
                if final["state"] != "VERIFIED":
                    raise RuntimeError(final["state"])
                results.append({"action": final["plan"]["action"], "state": final["state"],
                                "after": final["plan"]["after"], "events": final["events"]})
            print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
