"""Run the pitch scenario against local OCR, a real outbox, and a mock ERP."""
from pathlib import Path
from tempfile import TemporaryDirectory
import json
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from aios_demo.parsing import parse_image
from aios_demo.routing import FixtureVision, order_payload, route
from aios_demo.storage import Database, Ledger, business_key, digest_of
from aios_demo.worker import DemoERP, Worker


def run() -> dict:
    filename = "harbour-review.png"
    evidence = route(parse_image(ROOT / "fixtures" / filename),
                     FixtureVision(filename), FixtureVision(filename, second=True))
    key = "line.1.quantity"
    disputed = evidence["fields"][key]
    corrections = {key: "2"}
    try:
        order_payload(evidence)
    except ValueError as error:
        blocked = str(error)
    else:
        raise AssertionError("Expected the disagreement to block the draft")
    payload = order_payload(evidence, corrections)
    with TemporaryDirectory() as directory:
        root = Path(directory)
        ledger = Ledger(Database(root / "ledger.sqlite"))
        erp = DemoERP(Database(root / "erp.sqlite"))
        ledger.initialize()
        erp.initialize()
        command = ledger.approve(payload, digest_of(payload), "Demo reviewer", corrections, True)
        worker = Worker(ledger, erp, "pitch-worker")
        assert worker.tick()
        after_dispatch = ledger.snapshot(command)["status"]
        assert worker.tick()
        snapshot = ledger.snapshot(command)
        assert after_dispatch == "OUTCOME_UNKNOWN" and snapshot["status"] == "COMMITTED"
        assert erp.count() == 1
        return {
            "artifact": filename,
            "observed": {"rows": evidence["rows"], "fields": len(evidence["fields"]),
                         "fields_data": evidence["fields"]},
            "conflict": disputed, "blocked": blocked, "correction": corrections,
            "payload": payload, "business_key": business_key(payload),
            "after_dispatch": after_dispatch, "after_readback": snapshot["status"],
            "erp_id": snapshot["erp_id"], "erp_draft_count": erp.count(),
            "events": [event["event"] for event in snapshot["events"]],
        }


if __name__ == "__main__":
    print(json.dumps(run(), indent=2, ensure_ascii=False))
