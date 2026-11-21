from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase, mock

from fastapi.testclient import TestClient
from PIL import Image

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
                evidence = intake.json()
                conflict = evidence["fields"]["line.1.quantity"]
                self.assertEqual(conflict["initial_reading"], "8")
                self.assertEqual(conflict["calculated_amount"], "1920.00")
                self.assertEqual(conflict["printed_amount"], "480.00")
                self.assertEqual(evidence["metrics"]["rules_blocked_count"], 1)
                self.assertIsNone(conflict["confirmed"])
                inputs = {"run_id": evidence["run_id"], "overrides": {"line.1.quantity": "2"}}
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
                self.assertEqual(done["verified_payload"], preview.json()["payload"])
                self.assertEqual(done["metrics"]["rules_blocked_count"], 1)
                self.assertEqual(done["metrics"]["disputed_fields"], 1)
                self.assertEqual(done["metrics"]["auto_passed_fields"], 14)
                self.assertEqual(done["metrics"]["vision_calls"], 16)

    def test_alias_preview_remember_upload_replay_and_reset(self):
        fixture = Path(__file__).resolve().parents[1] / "fixtures" / "harbour-shorthand.png"
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            with (
                mock.patch.object(api, "ledger", Ledger(Database(root / "ledger.sqlite"))),
                mock.patch.object(api, "erp", DemoERP(Database(root / "erp.sqlite"))),
                mock.patch.dict("os.environ", {"AIOS_ENABLE_LIVE_VISION": "0"}),
                TestClient(api.app) as client,
            ):
                intake = client.post("/api/intake", json={"sample": "shorthand"}).json()
                key = "line.1.sku"
                self.assertEqual(intake["review_fields"], [key])
                self.assertEqual(len(intake["fields"][key]["candidates"]), 3)
                body = {"run_id": intake["run_id"], "overrides": {}, "mappings": {key: "BAD"}}
                self.assertEqual(client.post("/api/preview", json={**body, "remember": True}).status_code, 422)
                body["mappings"][key] = "SKU-1061"
                preview = client.post("/api/preview", json=body).json()
                self.assertEqual(preview["payload"]["items"][0]["erp_quantity"], 24)
                self.assertEqual(api.ledger.sku_memory(), {})
                preview = client.post("/api/preview", json={**body, "remember": True}).json()
                self.assertEqual(preview["payload"]["total"], "684.00")
                self.assertEqual(preview["payload"]["items"][0]["source_sku"], "LEMON-CTN")
                result = client.post("/api/approve", json={**body, "digest": preview["digest"]})
                self.assertEqual(result.status_code, 202)
                self.assertEqual(client.get("/api/commands/" + result.json()["command_id"]).json()
                                 ["metrics"]["memories_saved"], 1)
                upload = client.post("/api/intakes/upload?filename=forward.png", content=fixture.read_bytes(),
                                     headers={"Content-Type": "application/octet-stream"}).json()
                self.assertEqual(upload["review_fields"], [])
                self.assertEqual(upload["fields"][key]["mapping"]["erp_sku"], "SKU-1061")
                self.assertEqual(upload["metrics"]["vision_calls"], 0)
                replay = client.post("/api/intake", json={"sample": "shorthand"}).json()
                self.assertEqual(replay["status"], "ready_for_preview")
                self.assertEqual(client.post("/api/demo/reset").json()["cleared"], 1)
                reset = client.post("/api/intake", json={"sample": "shorthand"}).json()
                self.assertEqual(reset["review_fields"], [key])
                self.assertEqual(client.get("/api/intakes/" + intake["run_id"]).json()["preview"], preview)

    def test_unreadable_layout_stops_before_preview_and_approval(self):
        image = BytesIO()
        Image.new("RGB", (300, 200), "white").save(image, "PNG")
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            with (
                mock.patch.object(api, "ledger", Ledger(Database(root / "ledger.sqlite"))),
                mock.patch.object(api, "erp", DemoERP(Database(root / "erp.sqlite"))),
                TestClient(api.app) as client,
            ):
                intake = client.post("/api/intakes/upload?filename=blank.png", content=image.getvalue(),
                                     headers={"Content-Type": "application/octet-stream"}).json()
                self.assertEqual(intake["status"], "needs_review")
                self.assertFalse(intake["complete"])
                body = {"run_id": intake["run_id"]}
                verdict = client.post("/api/preview?feedback=true", json=body)
                self.assertTrue(verdict.json()["blocked"])
                self.assertEqual(client.post("/api/preview", json=body).status_code, 422)
                self.assertEqual(client.post("/api/approve", json={**body, "digest": "0"*64}).status_code, 422)
                self.assertEqual(api.erp.count(), 0)

    def test_upload_can_be_reopened_and_reconciled(self):
        fixture = Path(__file__).resolve().parents[1] / "fixtures" / "harbour-po.png"
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            with (
                mock.patch.object(api, "ledger", Ledger(Database(root / "ledger.sqlite"))),
                mock.patch.object(api, "erp", DemoERP(Database(root / "erp.sqlite"))),
                mock.patch.dict("os.environ", {"AIOS_ENABLE_LIVE_VISION": "0"}),
                TestClient(api.app) as client,
            ):
                query = "/api/intakes/upload?filename=uploaded.png"
                headers = {"Content-Type": "application/octet-stream"}
                self.assertEqual(client.post(query, content=b"bad", headers=headers).status_code, 422)
                self.assertEqual(client.post(query, content=b"bad", headers={
                    **headers, "Origin": "https://other.example",
                }).status_code, 403)
                self.assertEqual(client.post(query + "&mode=vision-on-demand", content=fixture.read_bytes(),
                                             headers=headers).status_code, 503)
                uploaded = client.post(query, content=fixture.read_bytes(), headers=headers)
                self.assertEqual(uploaded.status_code, 201)
                evidence = uploaded.json()
                self.assertEqual(evidence["status"], "ready_for_preview")
                self.assertEqual(evidence["metrics"]["vision_calls"], 0)
                self.assertEqual(client.get(evidence["source_url"]).headers["content-type"], "image/png")
                run_id = evidence["run_id"]
                request = {"run_id": run_id, "overrides": {}}
                preview = client.post("/api/preview", json=request).json()
                approved = client.post("/api/approve", json={**request, "digest": preview["digest"]})
                self.assertEqual(approved.status_code, 202)
                for _ in range(2):
                    self.assertTrue(client.post("/api/worker/tick").json()["worked"])
                restored = client.get(f"/api/intakes/{run_id}").json()
                self.assertEqual(restored["preview"]["payload"]["po"], "PO-1042")
                self.assertEqual(restored["command_id"], approved.json()["command_id"])
                self.assertEqual(client.get("/api/intakes").json()[0]["status"], "COMMITTED")
