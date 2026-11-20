"""Transactional command ledger and an outbox that can be shared by workers."""
from contextlib import contextmanager
from hashlib import sha256
from pathlib import Path
import json
import sqlite3
import time
import uuid

SCHEMA = Path(__file__).resolve().parents[1] / "sql" / "schema.sql"
POSTGRES_CLAIM = """
WITH next_job AS (
    SELECT id
    FROM job
    WHERE state = 'READY' AND available_at <= ?
    ORDER BY available_at, id
    LIMIT 1
    FOR UPDATE SKIP LOCKED
)
UPDATE job
SET state = 'LEASED', owner = ?, lease_until = ?, epoch = epoch + 1
FROM next_job
WHERE job.id = next_job.id
RETURNING job.*
"""


def canonical(payload: dict) -> str:
    return json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def digest_of(payload: dict) -> str:
    return sha256(canonical(payload).encode()).hexdigest()


def business_key(payload: dict) -> str:
    return ":".join(payload[key] for key in ("legal_entity", "buyer", "po"))


def _id() -> str:
    return uuid.uuid4().hex


class Conflict(ValueError):
    pass


class LostLease(RuntimeError):
    pass


class Database:
    def __init__(self, sqlite_path: Path, postgres_dsn: str | None = None):
        self.sqlite_path = sqlite_path
        self.dsn = postgres_dsn
        if self.dsn:
            from psycopg.conninfo import conninfo_to_dict, make_conninfo

            settings = {"connect_timeout": "5", **conninfo_to_dict(self.dsn)}
            self.dsn = make_conninfo(**settings)

    @contextmanager
    def transaction(self, *, write: bool = True, sqlite_timeout: float = 10):
        if self.dsn:
            import psycopg
            from psycopg.rows import dict_row

            with psycopg.connect(self.dsn, row_factory=dict_row) as conn:
                yield lambda query, args=(): conn.execute(query.replace("?", "%s"), args)
            return
        self.sqlite_path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.sqlite_path, timeout=sqlite_timeout)
        connection.row_factory = sqlite3.Row
        try:
            connection.execute("PRAGMA foreign_keys=ON")
            connection.execute("BEGIN IMMEDIATE" if write else "BEGIN")
            yield connection.execute
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()


class Ledger:
    def __init__(self, database: Database):
        self.db = database

    def initialize(self) -> None:
        with self.db.transaction() as run:
            for statement in SCHEMA.read_text().split(";"):
                if statement.strip():
                    run(statement)

    @staticmethod
    def _event(run, command_id: str, event: str, note: str) -> None:
        run("INSERT INTO journal VALUES (?, ?, ?, ?, ?)", (_id(), command_id, event, note, time.time()))

    @staticmethod
    def _job(run, command_id: str, kind: str) -> None:
        run("""INSERT INTO job(id, command_id, kind, state, available_at)
               VALUES (?, ?, ?, 'READY', ?) ON CONFLICT(command_id, kind) DO NOTHING""",
            (_id(), command_id, kind, time.time()))

    def create_intake(self, filename: str, evidence: dict, source_png: bytes) -> str:
        run_id = _id()
        with self.db.transaction() as run:
            run(
                """INSERT INTO intake_document (id, filename, evidence, source_png, created_at)
                   VALUES (?, ?, ?, ?, ?)""",
                (run_id, filename, canonical(evidence), source_png, time.time()),
            )
        return run_id

    def intake(self, run_id: str) -> dict:
        with self.db.transaction(write=False) as run:
            row = run(
                """SELECT filename, evidence, preview, command_id FROM intake_document WHERE id = ?""",
                (run_id,),
            ).fetchone()
        if row is None:
            raise KeyError(run_id)
        return {**json.loads(row["evidence"]), "filename": row["filename"],
                "preview": json.loads(row["preview"]) if row["preview"] else None,
                "command_id": row["command_id"]}

    def intake_source(self, run_id: str) -> bytes:
        with self.db.transaction(write=False) as run:
            row = run("SELECT source_png FROM intake_document WHERE id = ?", (run_id,)).fetchone()
        if row is None:
            raise KeyError(run_id)
        return bytes(row["source_png"])

    def recent_intakes(self) -> list[dict]:
        with self.db.transaction(write=False) as run:
            rows = run(
                """SELECT doc.id AS run_id, doc.filename, doc.evidence, doc.preview,
                          doc.created_at, command.status AS command_status
                   FROM intake_document AS doc LEFT JOIN command ON command.id = doc.command_id
                   ORDER BY doc.created_at DESC, doc.id DESC LIMIT 30"""
            ).fetchall()
        result = []
        for row in rows:
            evidence = json.loads(row["evidence"])
            status = row["command_status"] or ("preview_ready" if row["preview"] else evidence["status"])
            result.append({"run_id": row["run_id"], "filename": row["filename"],
                           "status": status, "created_at": row["created_at"]})
        return result

    def save_preview(self, run_id: str, preview: dict) -> None:
        with self.db.transaction() as run:
            changed = run(
                """UPDATE intake_document SET preview = ? WHERE id = ? AND command_id IS NULL""",
                (canonical(preview), run_id),
            )
            if changed.rowcount != 1:
                raise Conflict("This intake has already been approved")

    def approve(self, payload: dict, expected_digest: str, actor: str, review: dict,
                simulate_timeout: bool, *, intake_id: str | None = None) -> str:
        key = business_key(payload)
        digest = digest_of(payload)
        if digest != expected_digest:
            raise Conflict("The approved preview changed")
        new_id = _id()
        with self.db.transaction() as run:
            if intake_id is not None:
                lock = " FOR UPDATE" if self.db.dsn else ""
                intake = run(
                    "SELECT preview, command_id FROM intake_document WHERE id = ?" + lock, (intake_id,)
                ).fetchone()
                current = json.loads(intake["preview"]) if intake and intake["preview"] else {}
                if current.get("digest") != digest or current.get("overrides") != review:
                    raise Conflict("Generate and approve the current saved preview")
                if intake["command_id"]:
                    return intake["command_id"]
            inserted = run(
                """INSERT INTO command
                   (id, business_key, payload, digest, status, approved_by, review,
                    simulate_timeout, created_at)
                   VALUES (?, ?, ?, ?, 'QUEUED', ?, ?, ?, ?)
                   ON CONFLICT (business_key) DO NOTHING RETURNING id""",
                (new_id, key, canonical(payload), digest, actor, canonical(review),
                 int(simulate_timeout), time.time()),
            ).fetchone()
            if not inserted:
                prior = run("SELECT id, digest FROM command WHERE business_key = ?", (key,)).fetchone()
                if prior["digest"] != digest:
                    raise Conflict("This PO already has a different command. Reconcile the revision.")
                new_id = prior["id"]
            else:
                self._job(run, new_id, "DISPATCH")
                self._event(run, new_id, "APPROVED", f"{actor} approved the exact draft preview.")
                self._event(run, new_id, "OUTBOX_QUEUED", "Command and outbox row committed together.")
            if intake_id is not None:
                run("UPDATE intake_document SET command_id = ? WHERE id = ?", (new_id, intake_id))
        return new_id

    def claim(self, owner: str, seconds: float = 30, *, now: float | None = None) -> dict | None:
        now = time.time() if now is None else now
        with self.db.transaction() as run:
            if self.db.dsn:
                row = run(POSTGRES_CLAIM, (now, owner, now + seconds)).fetchone()
            else:
                row = run(
                    """UPDATE job SET state = 'LEASED', owner = ?, lease_until = ?, epoch = epoch + 1
                       WHERE id = (SELECT id FROM job WHERE state = 'READY' AND available_at <= ?
                                   ORDER BY available_at, id LIMIT 1)
                       RETURNING *""",
                    (owner, now + seconds, now),
                ).fetchone()
        return dict(row) if row else None

    @staticmethod
    def _live(run, job: dict, action: str, args: tuple = ()) -> None:
        result = run(
            f"""UPDATE job SET {action} WHERE id = ? AND state = 'LEASED' AND owner = ?
                AND epoch = ? AND lease_until > ?""",
            (*args, job["id"], job["owner"], job["epoch"], time.time()),
        )
        if result.rowcount != 1:
            raise LostLease(job["id"])

    def reserve_send(self, job: dict) -> dict:
        with self.db.transaction() as run:
            self._live(run, job, "owner = owner")
            changed = run("UPDATE command SET status = 'SENDING' WHERE id = ? AND status = 'QUEUED'",
                          (job["command_id"],))
            if changed.rowcount != 1:
                raise Conflict("Command is not queued")
            self._event(run, job["command_id"], "SENDING",
                        f"Intent recorded before the ERP call. Dispatch epoch {job['epoch']}.")
            return dict(run("SELECT * FROM command WHERE id = ?", (job["command_id"],)).fetchone())

    def schedule_readback(self, job: dict, *, unknown: bool) -> None:
        state = "OUTCOME_UNKNOWN" if unknown else "VERIFYING"
        note = ("ERP response was lost. Scheduled a read, with no second write." if unknown
                else "ERP responded. Scheduled an independent payload read-back.")
        with self.db.transaction() as run:
            self._live(run, job, "state = 'DONE', owner = NULL, lease_until = NULL")
            run("UPDATE command SET status = ? WHERE id = ?", (state, job["command_id"]))
            self._job(run, job["command_id"], "RECONCILE")
            self._event(run, job["command_id"], state, note)

    def reap(self, *, now: float | None = None) -> int:
        now = time.time() if now is None else now
        lock = " FOR UPDATE SKIP LOCKED" if self.db.dsn else ""
        with self.db.transaction() as run:
            expired = run(
                """SELECT * FROM job WHERE state = 'LEASED' AND lease_until <= ?
                   ORDER BY lease_until, id LIMIT 50""" + lock,
                (now,),
            ).fetchall()
            for job in expired:
                cid = job["command_id"]
                status = run("SELECT status FROM command WHERE id = ?", (cid,)).fetchone()["status"]
                if job["kind"] == "DISPATCH" and status == "SENDING":
                    run("UPDATE job SET state = 'DONE', owner = NULL, lease_until = NULL WHERE id = ?",
                        (job["id"],))
                    run("UPDATE command SET status = 'OUTCOME_UNKNOWN' WHERE id = ?", (cid,))
                    self._job(run, cid, "RECONCILE")
                    self._event(run, cid, "OUTCOME_UNKNOWN", "Dispatch lease expired after reservation.")
                else:
                    run("""UPDATE job SET state = 'READY', owner = NULL, lease_until = NULL
                           WHERE id = ?""", (job["id"],))
            return len(expired)

    def record_readback(self, job: dict, record: dict | None) -> None:
        cid = job["command_id"]
        with self.db.transaction() as run:
            self._live(run, job, "owner = owner")
            command = run("SELECT * FROM command WHERE id = ?", (cid,)).fetchone()
            matches = (record is not None and record["business_key"] == command["business_key"]
                       and record["status"] == "DRAFT"
                       and digest_of(record["payload"]) == command["digest"])
            if matches:
                state, note, erp_id = "COMMITTED", "Read-back matched the approved payload.", record["id"]
            elif record is not None or job["epoch"] >= 3:
                state, note, erp_id = "NEEDS_OPERATOR", "ERP copy differs or remains unconfirmed.", None
            else:
                delay = 2 ** (job["epoch"] - 1)
                self._live(run, job, "state='READY', owner=NULL, lease_until=NULL, available_at = ?",
                           (time.time() + delay,))
                self._event(run, cid, "RECHECK", f"No ERP copy visible. Next read in {delay}s.")
                return
            self._live(run, job, "state='DONE', owner=NULL, lease_until=NULL")
            run("UPDATE command SET status = ?, erp_id = ? WHERE id = ?", (state, erp_id, cid))
            self._event(run, cid, state, note)

    def snapshot(self, command_id: str) -> dict:
        with self.db.transaction(write=False) as run:
            row = run("SELECT * FROM command WHERE id = ?", (command_id,)).fetchone()
            if not row:
                raise KeyError(command_id)
            data = dict(row)
            data["events"] = [dict(event) for event in run(
                "SELECT event, note, at FROM journal WHERE command_id = ? ORDER BY at, id", (command_id,)
            ).fetchall()]
        data["payload"] = json.loads(data["payload"])
        data["review"] = json.loads(data["review"])
        return data
