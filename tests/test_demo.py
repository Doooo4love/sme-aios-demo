from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import date
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase, mock
import os
import time

from aios_demo.parsing import parse_image
from aios_demo.routing import FixtureVision, order_payload, readers, route, route_on_demand
from aios_demo.storage import Conflict, Database, Ledger, LostLease, digest_of
from aios_demo.worker import DemoERP, Worker

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"


class ParseAndRouteTests(TestCase):
    def parsed(self, name):
        with mock.patch.dict(os.environ, {"AIOS_ENABLE_LIVE_VISION": "0"}):
            return route(parse_image(FIXTURES / name), *readers(name))

    def test_real_ocr_with_evidence_and_pack_conversion(self):
        evidence = self.parsed("harbour-po.png")
        self.assertEqual(evidence["rows"], 2)
        qty = evidence["fields"]["line.1.quantity"]
        self.assertEqual(qty["ocr"]["value"], "2")
        self.assertTrue(all(coordinate > 0 for coordinate in qty["ocr"]["bbox"]))
        self.assertEqual(qty["confirmed"], "2")
        payload = order_payload(evidence)
        self.assertEqual(payload["items"][0]["erp_quantity"], 48)
        self.assertEqual(payload["total"], "804.00")
        self.assertEqual(date.fromisoformat(payload["delivery"]).day, 25)

    def test_conflict_stays_in_human_review_even_if_third_reader_agrees(self):
        evidence = self.parsed("harbour-review.png")
        key = "line.1.quantity"
        conflict = evidence["fields"][key]
        self.assertEqual([reading["value"] for reading in conflict["vision"]], ["8", "2"])
        self.assertIsNone(conflict["confirmed"])
        with self.assertRaisesRegex(ValueError, "Resolve"):
            order_payload(evidence)
        with self.assertRaisesRegex(ValueError, "quantity × price"):
            order_payload(evidence, {key: "8"})
        self.assertEqual(order_payload(evidence, {key: "2"})["items"][0]["erp_quantity"], 48)

    def test_cannot_override_uncontested_fields(self):
        evidence = self.parsed("harbour-po.png")
        with self.assertRaisesRegex(ValueError, "Only unresolved"):
            order_payload(evidence, {"currency": "USD"})


    def test_targeted_vision_reads_only_anchored_uncertainty(self):
        name = "harbour-po.png"
        parsed = parse_image(FIXTURES / name)
        key = "line.1.quantity"
        reader = FixtureVision(name)
        clean = route_on_demand(parsed, reader)
        self.assertEqual(clean["metrics"]["vision_calls"], 0)
        self.assertEqual(order_payload(clean)["items"][0]["erp_quantity"], 48)

        quantity = parsed.fields[key]
        parsed.fields[key] = replace(quantity, score=60)
        baseline = route_on_demand(parsed)
        self.assertIsNone(baseline["fields"][key]["confirmed"])
        evidence = route_on_demand(parsed, reader)
        self.assertEqual(evidence["metrics"]["vision_calls"], 1)
        self.assertEqual(evidence["fields"][key]["confirmed"], "2")

        parsed.fields[key] = replace(quantity, value="2O")
        reader.answers[key] = "20"
        evidence = route_on_demand(parsed, reader)
        self.assertEqual(evidence["metrics"]["vision_calls"], 1)
        self.assertEqual(evidence["fields"][key]["ocr"]["bbox"], quantity.bbox)
        self.assertEqual(evidence["fields"][key]["ocr"]["value"], "2O")
        self.assertIsNone(evidence["fields"][key]["confirmed"])
        with self.assertRaisesRegex(ValueError, "quantity × price"):
            order_payload(evidence, {key: "20"})

        del parsed.fields[key]
        evidence = route_on_demand(parsed, reader)
        self.assertEqual(evidence["metrics"]["vision_calls"], 0)
        self.assertEqual(evidence["fields"][key]["reason_code"], "NO_FIELD_ANCHOR")


class OutboxTests(TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        self.ledger = Ledger(Database(root / "ledger.sqlite", os.getenv("AIOS_TEST_POSTGRES_DSN")))
        if self.ledger.db.dsn:
            with self.ledger.db.transaction() as run:
                run("DROP TABLE IF EXISTS intake_document, journal, job, command")
        self.erp = DemoERP(Database(root / "erp.sqlite"))
        self.ledger.initialize()
        self.erp.initialize()
        self.worker = Worker(self.ledger, self.erp, "unit-worker")
        self.payload = {"legal_entity": "HK01", "buyer": "HBR-47", "po": "PO-1042",
                        "total": "804.00"}

    def approve(self, *, timeout=False):
        return self.ledger.approve(self.payload, digest_of(self.payload), "tester", {}, timeout)

    def test_intake_preview_and_approval_survive_process_restart(self):
        run_id = self.ledger.create_intake("example.png", {"status": "needs_review"}, b"image")
        payload = self.payload.copy()
        digest = digest_of(payload)
        overrides = {"line.1.quantity": "2"}
        self.ledger.save_preview(run_id, {"payload": payload, "digest": digest, "overrides": overrides})
        self.ledger.save_preview(run_id, {"payload": payload, "digest": digest, "overrides": {}})
        with self.assertRaises(Conflict):
            self.ledger.approve(payload, digest, "tester", overrides, True, intake_id=run_id)
        self.assertIsNone(self.ledger.claim("nothing-queued"))

        reopened = Ledger(self.ledger.db)
        self.assertEqual(reopened.intake_source(run_id), b"image")
        self.assertEqual(reopened.recent_intakes()[0]["status"], "preview_ready")
        command = reopened.approve(payload, digest, "tester", {}, True, intake_id=run_id)
        self.assertEqual(reopened.intake(run_id)["command_id"], command)
        self.assertEqual(reopened.approve(payload, digest, "tester", {}, True, intake_id=run_id), command)
        self.assertEqual(reopened.recent_intakes()[0]["status"], "QUEUED")
        self.worker.tick()
        self.worker.tick()
        self.assertEqual(reopened.recent_intakes()[0]["status"], "COMMITTED")
        self.assertEqual(self.erp.count(), 1)

    def test_wrong_digest_cannot_enqueue(self):
        with self.assertRaises(Conflict):
            self.ledger.approve(self.payload, "wrong", "tester", {}, False)
        self.assertIsNone(self.ledger.claim("none"))

    def test_concurrent_duplicate_approvals_only_queue_once(self):
        with ThreadPoolExecutor(max_workers=4) as pool:
            commands = list(pool.map(lambda _: self.approve(), range(8)))
        self.assertEqual(len(set(commands)), 1)
        with ThreadPoolExecutor(max_workers=4) as pool:
            jobs = list(pool.map(lambda owner: self.ledger.claim(owner), map(str, range(4))))
        self.assertEqual(sum(job is not None for job in jobs), 1)

    def test_same_po_different_payload_needs_revision(self):
        self.approve()
        self.payload["total"] = "805.00"
        with self.assertRaises(Conflict):
            self.approve()

    def test_lost_response_does_not_trigger_another_erp_write(self):
        command = self.approve(timeout=True)
        with mock.patch.object(self.erp, "create_draft", wraps=self.erp.create_draft) as write:
            self.worker.tick()
            self.assertEqual(self.ledger.snapshot(command)["status"], "OUTCOME_UNKNOWN")
            self.worker.tick()
            self.assertEqual(write.call_count, 1)
        snapshot = self.ledger.snapshot(command)
        self.assertEqual(snapshot["status"], "COMMITTED")
        self.assertEqual(self.erp.count(), 1)
        self.assertEqual([event["event"] for event in snapshot["events"]],
                         ["APPROVED", "OUTBOX_QUEUED", "SENDING", "OUTCOME_UNKNOWN", "COMMITTED"])

    def test_expired_inflight_lease_goes_to_reconcile(self):
        command_id = self.approve()
        job = self.ledger.claim("crashed")
        command = self.ledger.reserve_send(job)
        self.erp.create_draft(command["business_key"], self.payload, lose_response=False)
        self.ledger.reap(now=time.time() + 100)
        with self.assertRaises(LostLease):
            self.ledger.schedule_readback(job, unknown=False)
        self.worker.tick()
        self.assertEqual(self.ledger.snapshot(command_id)["status"], "COMMITTED")
        self.assertEqual(self.erp.count(), 1)

    def test_mismatched_erp_payload_requires_operator(self):
        command = self.approve()
        self.worker.tick()
        with self.erp.database.transaction() as execute:
            execute("UPDATE draft SET payload = ?", ('{"total":"0"}',))
        self.worker.tick()
        self.assertEqual(self.ledger.snapshot(command)["status"], "NEEDS_OPERATOR")

    def test_restarted_worker_can_read_persisted_outbox(self):
        command = self.approve()
        restarted = Worker(Ledger(self.ledger.db), self.erp, "restart")
        restarted.tick()
        restarted.tick()
        self.assertEqual(self.ledger.snapshot(command)["status"], "COMMITTED")

    def test_missing_erp_result_stops_after_bounded_read_retries(self):
        command = self.approve()
        job = self.ledger.claim("lost-before-send")
        self.ledger.reserve_send(job)
        self.ledger.schedule_readback(job, unknown=True)
        for _ in range(3):
            job = self.ledger.claim("checks", now=time.time() + 10)
            self.ledger.record_readback(job, None)
        self.assertEqual(self.ledger.snapshot(command)["status"], "NEEDS_OPERATOR")
        self.assertEqual(self.erp.count(), 0)
