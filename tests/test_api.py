from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase, mock

from fastapi.testclient import TestClient

from aios_demo import api
from aios_demo.storage import Database, Ledger
from aios_demo.worker import DemoERP


class APIJourneyTests(TestCase):
    def test_human_preview_approval_and_two_worker_steps(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            with (
                mock.patch.object(api, "ledger", Ledger(Database(root / "ledger.sqlite"))),
                mock.patch.object(api, "erp", DemoERP(Database(root / "erp.sqlite"))),
                mock.patch.dict("os.environ", {"AIOS_ENABLE_LIVE_VISION": "0"}),
                TestClient(api.app) as client,
            ):
                self.assertEqual(client.get("/").status_code, 200)
                intake = client.post("/api/intake", json={"sample": "review"})
                self.assertEqual(intake.status_code, 200)
                inputs = {"run_id": intake.json()["run_id"], "overrides": {"line.1.quantity": "8"}}
                self.assertEqual(client.post("/api/preview", json=inputs).status_code, 422)
                inputs["overrides"]["line.1.quantity"] = "2"
                preview = client.post("/api/preview", json=inputs)
                self.assertEqual(preview.status_code, 200)
                self.assertEqual(client.post("/api/approve", json={
                    **inputs, "digest": "0" * 64,
                }).status_code, 409)
                approved = client.post("/api/approve", json={
                    **inputs, "digest": preview.json()["digest"], "simulate_timeout": True,
                })
                self.assertEqual(approved.status_code, 202)
                path = "/api/commands/" + approved.json()["command_id"]
                self.assertEqual(client.get(path).json()["status"], "QUEUED")
                client.post("/api/worker/tick", json={})
                self.assertEqual(client.get(path).json()["status"], "OUTCOME_UNKNOWN")
                client.post("/api/worker/tick", json={})
                done = client.get(path).json()
                self.assertEqual(done["status"], "COMMITTED")
                self.assertEqual(done["matching_erp_drafts"], 1)
