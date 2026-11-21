"""Consume the outbox. Keep the network boundary outside ledger transactions."""
from dataclasses import dataclass
from pathlib import Path
import argparse
import json
import os
import sqlite3
import time

from .storage import Database, Ledger, LostLease, canonical, digest_of


class UnknownOutcome(TimeoutError):
    """The caller cannot know whether the write took effect."""


@dataclass
class DemoERP:
    database: Database

    def initialize(self) -> None:
        with self.database.transaction() as run:
            run("""CREATE TABLE IF NOT EXISTS draft (
                   id TEXT PRIMARY KEY, business_key TEXT NOT NULL UNIQUE,
                   payload TEXT NOT NULL, status TEXT NOT NULL)""")

    def create_draft(self, key: str, payload: dict, *, lose_response: bool) -> None:
        with self.database.transaction() as run:
            # The local ERP serializes writers. Keep a short, human-readable receipt.
            serial = run("SELECT COUNT(*) + 1 AS serial FROM draft").fetchone()["serial"]
            number = f"SO-{serial:06d}"
            run("""INSERT INTO draft VALUES (?, ?, ?, 'DRAFT')
                   ON CONFLICT(business_key) DO NOTHING""", (number, key, canonical(payload)))
        if lose_response:
            raise UnknownOutcome("Simulated response timeout after ERP commit")

    def lookup(self, key: str) -> dict | None:
        with self.database.transaction(write=False) as run:
            record = run("SELECT * FROM draft WHERE business_key = ?", (key,)).fetchone()
        if not record:
            return None
        parsed = dict(record)
        parsed["payload"] = json.loads(parsed["payload"])
        return parsed

    def count(self) -> int:
        with self.database.transaction(write=False) as run:
            return run("SELECT COUNT(*) AS total FROM draft").fetchone()["total"]


@dataclass
class Worker:
    ledger: Ledger
    erp: DemoERP
    owner: str

    def tick(self) -> bool:
        self.ledger.reap()
        job = self.ledger.claim(self.owner)
        if not job:
            return False
        try:
            if job["kind"] == "DISPATCH":
                self._dispatch(job)
            else:
                self._reconcile(job)
        except LostLease:
            # A new epoch owns the job. The reaper handles uncertainty.
            pass
        return True

    def _dispatch(self, job: dict) -> None:
        command = self.ledger.reserve_send(job)
        payload = json.loads(command["payload"])
        if digest_of(payload) != command["digest"]:
            # Treat unexpected persisted data as unsafe, and allow the read-only path.
            self.ledger.schedule_readback(job, unknown=True)
            return
        try:
            self.erp.create_draft(command["business_key"], payload,
                                  lose_response=bool(command["simulate_timeout"]))
        except (UnknownOutcome, sqlite3.Error, OSError):
            self.ledger.schedule_readback(job, unknown=True)
        else:
            self.ledger.schedule_readback(job, unknown=False)

    def _reconcile(self, job: dict) -> None:
        command = self.ledger.snapshot(job["command_id"])
        try:
            record = self.erp.lookup(command["business_key"])
        except (sqlite3.Error, OSError, TimeoutError):
            record = None
        self.ledger.record_readback(job, record)


def services() -> tuple[Ledger, DemoERP]:
    root = Path(os.getenv("AIOS_STATE_DIR", ".state"))
    return (
        Ledger(Database(root / "ledger.sqlite", os.getenv("AIOS_POSTGRES_DSN"))),
        DemoERP(Database(root / "mock-erp.sqlite")),
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true", help="Process at most one available job")
    args = parser.parse_args()
    ledger, erp = services()
    ledger.initialize()
    erp.initialize()
    engine = Worker(ledger, erp, f"cli-{os.getpid()}")
    if args.once:
        engine.tick()
    else:
        try:
            while True:
                if not engine.tick():
                    time.sleep(0.5)
        except KeyboardInterrupt:
            pass
