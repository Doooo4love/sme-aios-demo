"""PostgreSQL 16 enterprise hardening, 40-table RLS, migration, and drift detection tests."""
from __future__ import annotations

from contextlib import contextmanager, redirect_stdout
import importlib.util
import io
import os
from pathlib import Path
import re
import sqlite3
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from uuid import uuid4

from alembic import command
from alembic.config import Config

from aios_demo.storage import Database
from aios_platform.database_security import (
    EXPECTED_ALEMBIC_HEAD,
    EXPECTED_RLS_TABLES,
    _ENTERPRISE_TABLE_GRANTS,
    database_security_status,
    verify_database,
)
from aios_platform.workflow import Workflow

ROOT = Path(__file__).resolve().parents[1]
TEST_DSN = os.getenv("AIOS_PLATFORM_TEST_DSN")


def _load_migrations_env():
    spec = importlib.util.spec_from_file_location("aios_migrations_env", ROOT / "migrations/env.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _FakeResult:
    def __init__(self, rows):
        self._rows = list(rows)

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return list(self._rows)


class _FakePostgresDatabase:
    """Minimal mock mimicking psycopg dict_row queries for verify_database & database_security_status."""

    def __init__(
        self,
        *,
        role: str = "aios_api",
        rolsuper: bool = False,
        rolbypassrls: bool = False,
        rolcreaterole: bool = False,
        alembic_head: str | None = EXPECTED_ALEMBIC_HEAD,
        missing_rls: set[str] | None = None,
        no_force_rls: set[str] | None = None,
        owner_member_tables: set[str] | None = None,
        enterprise_overrides: dict[str, tuple[bool, bool, bool, bool, bool]] | None = None,
        col_priv_overrides: dict[str, bool] | None = None,
        raise_on_tx: Exception | None = None,
    ):
        self.dsn = "postgresql://mocked@localhost/aios"
        self.engine_mode = "postgres-pooled"
        self.role = role
        self.rolsuper = rolsuper
        self.rolbypassrls = rolbypassrls
        self.rolcreaterole = rolcreaterole
        self.alembic_head = alembic_head
        self.missing_rls = missing_rls or set()
        self.no_force_rls = no_force_rls or set()
        self.owner_member_tables = owner_member_tables or set()
        self.enterprise_overrides = enterprise_overrides or {}
        self.col_priv_overrides = col_priv_overrides or {}
        self.raise_on_tx = raise_on_tx

    @contextmanager
    def transaction(self, *, write: bool = True, sqlite_timeout: float = 10):
        del write, sqlite_timeout
        if self.raise_on_tx is not None:
            raise self.raise_on_tx

        def run(query: str, args=()):
            q = " ".join(query.split())
            if "FROM pg_roles WHERE rolname = CURRENT_USER" in q:
                return _FakeResult([
                    {
                        "rolname": self.role,
                        "rolsuper": self.rolsuper,
                        "rolbypassrls": self.rolbypassrls,
                        "rolcreaterole": self.rolcreaterole,
                    }
                ])
            if "SELECT to_regclass('alembic_version')" in q:
                return _FakeResult([{"reg": "alembic_version" if self.alembic_head is not None else None}])
            if "SELECT version_num FROM alembic_version" in q:
                return _FakeResult([{"version_num": self.alembic_head}] if self.alembic_head is not None else [])
            if "SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity" in q:
                rows = []
                for tbl in args:
                    if tbl in self.missing_rls:
                        continue
                    rows.append(
                        {
                            "relname": tbl,
                            "relrowsecurity": True,
                            "relforcerowsecurity": tbl not in self.no_force_rls,
                            "owner_member": tbl in self.owner_member_tables,
                        }
                    )
                return _FakeResult(rows)
            if "aios_browser_session" in q and "has_table_privilege" in q:
                worker = self.role == "aios_worker"
                collab_names = (
                    "aios_profile",
                    "aios_agent_activity",
                    "aios_proposal_review",
                    "aios_calendar_event",
                    "aios_calendar_member",
                    "aios_internal_notice",
                    "aios_browser_session",
                )
                return _FakeResult([
                    {
                        "relname": name,
                        "can_read": False if worker else True,
                        "can_insert": (name == "aios_internal_notice") if worker else True,
                        "can_update": False if worker else (name not in {"aios_calendar_member", "aios_browser_session"}),
                        "can_delete": False if worker else (name == "aios_browser_session"),
                    }
                    for name in collab_names
                ])
            if "has_table_privilege('aios_audit', 'UPDATE, DELETE, TRUNCATE')" in q:
                worker = self.role == "aios_worker"
                return _FakeResult([
                    {
                        "audit_mutable": False,
                        "receipt_writable": worker,
                        "can_propose": not worker,
                        "can_change_pause": not worker,
                        "can_read_intakes": not worker,
                        "can_read_chat": not worker,
                        "chat_mutable": False,
                        "audit_disclosed": False,
                        "audit_append": not worker,
                        "assurance_read": not worker,
                        "attempt_access": not worker,
                        "attempt_read": not worker,
                        "attempt_insert": not worker,
                        "attempt_transition": not worker,
                        "attempt_mutable_key": False,
                        "directory_access": not worker,
                        "module_read": True,
                        "module_write": not worker,
                        "module_mutable_key": False,
                    }
                ])
            if "has_table_privilege(c.oid, 'TRUNCATE') AS can_truncate" in q:
                worker = self.role == "aios_worker"
                rows = []
                for tbl in args:
                    api_t, worker_t = _ENTERPRISE_TABLE_GRANTS[tbl]
                    vals = self.enterprise_overrides.get(tbl, worker_t if worker else api_t)
                    rows.append(
                        {
                            "relname": tbl,
                            "can_read": vals[0],
                            "can_insert": vals[1],
                            "can_update": vals[2],
                            "can_delete": vals[3],
                            "can_truncate": vals[4],
                        }
                    )
                return _FakeResult(rows)
            if "aios_external_action_outbox_allowed" in q:
                defaults = {
                    "aios_prompt_policy_allowed": True,
                    "aios_prompt_policy_immutable_mutable": False,
                    "aios_security_event_allowed": True,
                    "aios_security_event_immutable_mutable": False,
                    "aios_channel_binding_allowed": True,
                    "aios_channel_binding_immutable_mutable": False,
                    "aios_chat_read_receipt_allowed": True,
                    "aios_chat_read_receipt_immutable_mutable": False,
                    "aios_external_action_outbox_allowed": True,
                    "aios_external_action_outbox_immutable_mutable": False,
                }
                defaults.update(self.col_priv_overrides)
                return _FakeResult([defaults])
            if "tel_mutable" in q:
                tel = self.enterprise_overrides.get("aios_llm_telemetry", (True, True, False, False, False))
                sec = self.enterprise_overrides.get("aios_security_event", (True, True, True, False, False))
                mail = self.enterprise_overrides.get("aios_email_outbox", (True, True, False, False, False))
                return _FakeResult([
                    {
                        "tel_mutable": tel[2] or tel[3] or tel[4],
                        "sec_deletable": sec[3] or sec[4],
                        "mail_mutable": mail[2] or mail[3] or mail[4],
                    }
                ])
            raise AssertionError(f"Unexpected SQL in fake DB: {q}")

        yield run


class PostgresEnterpriseUnitTests(unittest.TestCase):
    def test_expected_rls_tables_covers_all_40_schema_tables(self):
        self.assertEqual(len(EXPECTED_RLS_TABLES), 40)
        self.assertEqual(len(set(EXPECTED_RLS_TABLES)), 40)

        ddl_tables: set[str] = set()
        for sql_path in (ROOT / "aios_platform").glob("*.sql"):
            for match in re.finditer(r"CREATE TABLE IF NOT EXISTS\s+([a-zA-Z0-9_]+)", sql_path.read_text()):
                ddl_tables.add(match.group(1))
        self.assertEqual(set(EXPECTED_RLS_TABLES), ddl_tables)

    def test_workflow_initialize_creates_all_40_tables_on_sqlite(self):
        with TemporaryDirectory() as tmp:
            db = Database(Path(tmp) / "store.sqlite")
            try:
                wf = Workflow(db)
                wf.initialize()
                with db.transaction(write=False) as run:
                    tables = {
                        row["name"]
                        for row in run("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()
                    }
                self.assertTrue(set(EXPECTED_RLS_TABLES) <= tables)
                status = database_security_status(db)
                self.assertEqual(status["engine_mode"], "sqlite-wal-pooled")
                self.assertIsNone(status["alembic_head"])
                self.assertEqual(status["rls_covered"], 0)
                self.assertEqual(status["rls_expected"], 40)
                self.assertEqual(status["missing_rls_tables"], [])
                self.assertEqual(status["status"], "sqlite_demo")
            finally:
                db.close()

    def test_enterprise_hardening_ddl_constraints_in_sqlite(self):
        with TemporaryDirectory() as tmp:
            db = Database(Path(tmp) / "ddl.sqlite")
            try:
                Workflow(db).initialize()
                with db.transaction(write=True) as run:
                    run(
                        """INSERT INTO aios_budget_reservation
                           (tenant, id, subject, role, day_key, reserved_micro_usd, status, expires_at, created_at)
                           VALUES ('t1', 'r1', 'op', 'operator', '2026-11-25', 1000, 'reserved', 200.0, 100.0)"""
                    )
                    run(
                        """INSERT INTO aios_durable_event
                           (tenant, seq, id, subjects_json, include_admins, event_kind, payload_json, created_at)
                           VALUES ('t1', 1, 'evt1', '["op"]', 0, 'work_alert', '{}', 100.0)"""
                    )
                    run(
                        """INSERT INTO aios_external_action_outbox
                           (tenant, id, subject, action_kind, client_id, request_sha256, state,
                            attempt, lease_until, created_at, updated_at)
                           VALUES ('t1', 'out1', 'op', 'email.send', 'cid1', 'abc', 'RESERVED', 1, 200.0, 100.0, 100.0)"""
                    )
                    run(
                        """INSERT INTO aios_tenant_provider_policy
                           (tenant, allowed_providers_json, allowed_regions_json, blocked_data_classes_json,
                            allow_failover, max_tier, pricing_version, updated_by, updated_at)
                           VALUES ('t1', '["deepseek"]', '["cn-hk"]', '["restricted_pii"]', 1, 'T3',
                                   '2026-11-official', 'admin', 100.0)"""
                    )

                with self.assertRaises(sqlite3.IntegrityError):
                    with db.transaction(write=True) as run:
                        run(
                            """INSERT INTO aios_external_action_outbox
                               (tenant, id, subject, action_kind, client_id, request_sha256, state,
                                attempt, lease_until, created_at, updated_at)
                               VALUES ('t1', 'out2', 'op', 'invalid.kind', 'cid2', 'abc', 'RESERVED', 1, 200.0, 100.0, 100.0)"""
                        )
            finally:
                db.close()

    def test_env_py_postgres_alembic_version_safeguard(self):
        env_mod = _load_migrations_env()
        ensure_fn = env_mod._ensure_postgres_alembic_version

        class _FakeConn:
            def __init__(self, dialect_name: str, row):
                self.dialect = SimpleNamespace(name=dialect_name)
                self._row = row
                self.executed: list[str] = []

            def execute(self, stmt):
                sql_str = str(stmt)
                self.executed.append(sql_str)
                return _FakeResult([self._row] if self._row is not None else [])

        # 1. Absent alembic_version -> creates VARCHAR(64) table
        conn_absent = _FakeConn("postgresql", None)
        ensure_fn(conn_absent)
        self.assertEqual(len(conn_absent.executed), 2)
        self.assertIn("CREATE TABLE alembic_version (version_num VARCHAR(64) NOT NULL", conn_absent.executed[1])

        # 2. Legacy VARCHAR(32) -> widens to VARCHAR(64)
        conn_narrow = _FakeConn("postgresql", (32,))
        ensure_fn(conn_narrow)
        self.assertEqual(len(conn_narrow.executed), 2)
        self.assertIn("ALTER TABLE alembic_version ALTER COLUMN version_num TYPE VARCHAR(64)", conn_narrow.executed[1])

        # 3. Already VARCHAR(64) -> idempotent no-op
        conn_wide = _FakeConn("postgresql", (64,))
        ensure_fn(conn_wide)
        self.assertEqual(len(conn_wide.executed), 1)

        # 4. Non-PostgreSQL dialect -> no-op
        conn_sqlite = _FakeConn("sqlite", None)
        ensure_fn(conn_sqlite)
        self.assertEqual(conn_sqlite.executed, [])

    def test_alembic_offline_postgres_sql_widens_alembic_version(self):
        buf = io.StringIO()
        config = Config(str(ROOT / "alembic.ini"))
        with patch.dict(
            os.environ,
            {
                "AIOS_MIGRATION_DATABASE_URL": "postgresql://u:p@127.0.0.1:5432/aios",
                "AIOS_MIGRATION_DATABASE_URL_FILE": "",
            },
        ), redirect_stdout(buf):
            command.upgrade(config, "head", sql=True)
        sql_out = buf.getvalue()
        self.assertIn("version_num VARCHAR(64) NOT NULL", sql_out)
        self.assertIn("ALTER TABLE alembic_version ALTER COLUMN version_num TYPE VARCHAR(64)", sql_out)
        self.assertIn("0011_routing_telemetry_and_escalation", sql_out)
        self.assertIn("0012_user_long_term_memory", sql_out)
        self.assertIn("0013_enterprise_hardening", sql_out)
        for tbl in (
            "aios_budget_reservation",
            "aios_durable_event",
            "aios_external_action_outbox",
            "aios_tenant_provider_policy",
        ):
            self.assertIn(f"CREATE TABLE IF NOT EXISTS {tbl}", sql_out)

    def test_postgres_security_sql_covers_all_40_tables_and_least_privilege(self):
        raw_sql = (ROOT / "deploy/platform/postgres-security.sql").read_text()
        statements = [stmt.strip() for stmt in raw_sql.split(";") if stmt.strip()]
        self.assertGreaterEqual(len(statements), 120)

        for tbl in EXPECTED_RLS_TABLES:
            self.assertRegex(
                raw_sql,
                rf"ALTER TABLE {tbl}\s+ENABLE ROW LEVEL SECURITY",
                f"Missing ENABLE ROW LEVEL SECURITY on {tbl}",
            )
            self.assertRegex(
                raw_sql,
                rf"ALTER TABLE {tbl}\s+FORCE ROW LEVEL SECURITY",
                f"Missing FORCE ROW LEVEL SECURITY on {tbl}",
            )
            self.assertRegex(
                raw_sql,
                rf"CREATE POLICY\s+[a-z0-9_]+\s+ON\s+{tbl}\b",
                f"Missing RLS policy on {tbl}",
            )
            self.assertRegex(
                raw_sql,
                rf"REVOKE ALL ON [^;]*\b{tbl}\b[^;]*FROM PUBLIC",
                f"Missing REVOKE ALL FROM PUBLIC on {tbl}",
            )

        # Verify strict immutability and least-privilege constraints in SQL
        self.assertIn("REVOKE UPDATE, DELETE, TRUNCATE ON aios_llm_telemetry FROM aios_api", raw_sql)
        self.assertNotRegex(raw_sql, r"GRANT [^;]*\b(?:UPDATE|DELETE|TRUNCATE)\b[^;]*ON aios_llm_telemetry")
        self.assertNotRegex(raw_sql, r"GRANT [^;]*\b(?:DELETE|TRUNCATE)\b[^;]*ON aios_security_event")
        self.assertIn("GRANT INSERT ON aios_security_event TO aios_worker", raw_sql)
        self.assertNotRegex(raw_sql, r"GRANT [^;]*\bSELECT\b[^;]*ON aios_security_event TO aios_worker")
        for append_only in ("aios_email_outbox", "aios_channel_outbound_log", "aios_channel_event_dedup"):
            self.assertNotRegex(raw_sql, rf"GRANT [^;]*\b(?:UPDATE|DELETE|TRUNCATE)\b[^;]*ON [^;]*\b{append_only}\b")

        # Verify subject_tx vs workflow.tx compatibility
        self.assertIn(
            "CREATE POLICY aios_user_memory_subject ON aios_user_memory TO aios_api\n"
            "    USING (tenant = current_setting('aios.tenant', true) AND subject = current_setting('aios.subject', true))",
            raw_sql,
        )
        self.assertIn(
            "CREATE POLICY aios_user_memory_staging_subject ON aios_user_memory_staging TO aios_api\n"
            "    USING (tenant = current_setting('aios.tenant', true) AND subject = current_setting('aios.subject', true))",
            raw_sql,
        )
        self.assertIn(
            "CREATE POLICY aios_budget_reservation_tenant ON aios_budget_reservation TO aios_api\n"
            "    USING (tenant = current_setting('aios.tenant', true))",
            raw_sql,
        )
        self.assertIn("NULLIF(current_setting('aios.subject', true), '') IS NULL", raw_sql)

        # Verify external outbox & durable event API/worker split
        self.assertIn(
            "GRANT UPDATE (state, external_id, result_json, attempt, lease_until, updated_at) ON aios_external_action_outbox TO aios_worker",
            raw_sql,
        )
        self.assertNotRegex(raw_sql, r"GRANT [^;]*\bINSERT\b[^;]*ON aios_external_action_outbox TO aios_worker")
        self.assertIn("GRANT INSERT ON aios_durable_event TO aios_worker", raw_sql)
        self.assertNotRegex(raw_sql, r"GRANT [^;]*\bSELECT\b[^;]*ON aios_durable_event TO aios_worker")

        # Ensure test_platform.py role replacement never collides with non-role identifiers
        replaced = raw_sql.replace("aios_api", "aios_api_test").replace("aios_worker", "aios_worker_test")
        for tbl in EXPECTED_RLS_TABLES:
            self.assertIn(tbl, replaced)

    def test_database_security_status_sqlite_migrations_and_error_handling(self):
        with TemporaryDirectory() as tmp:
            url = f"sqlite:///{tmp}/migrated.sqlite"
            db_path = Path(tmp) / "migrated.sqlite"
            config = Config(str(ROOT / "alembic.ini"))
            with patch.dict(os.environ, {"AIOS_MIGRATION_DATABASE_URL": url, "AIOS_MIGRATION_DATABASE_URL_FILE": ""}):
                command.upgrade(config, "0012_user_long_term_memory")
                db = Database(db_path)
                try:
                    drift_status = database_security_status(db)
                    self.assertEqual(drift_status["alembic_head"], "0012_user_long_term_memory")
                    self.assertEqual(drift_status["status"], "drift")
                    self.assertEqual(len(drift_status["missing_tables"]), 4)
                finally:
                    db.close()

                command.upgrade(config, "head")
                db_ok = Database(db_path)
                try:
                    ok_status = database_security_status(db_ok)
                    self.assertEqual(ok_status["alembic_head"], "0013_enterprise_hardening")
                    self.assertEqual(ok_status["missing_tables"], [])
                    self.assertEqual(ok_status["status"], "ok")
                finally:
                    db_ok.close()

        # Non-raising on database failure
        broken = _FakePostgresDatabase(raise_on_tx=RuntimeError("connection refused"))
        err_status = database_security_status(broken)  # type: ignore[arg-type]
        self.assertEqual(err_status["status"], "error")
        self.assertEqual(err_status["error"], "RuntimeError")
        self.assertEqual(err_status["rls_expected"], 40)

    def test_mocked_postgres_verify_database_and_drift_status(self):
        healthy_api = _FakePostgresDatabase(role="aios_api")
        verify_database(healthy_api, worker=False)  # type: ignore[arg-type]
        status_ok = database_security_status(healthy_api)  # type: ignore[arg-type]
        self.assertEqual(status_ok["status"], "ok")
        self.assertEqual(status_ok["rls_covered"], 40)
        self.assertEqual(status_ok["rls_expected"], 40)
        self.assertEqual(status_ok["missing_rls_tables"], [])
        self.assertEqual(status_ok["alembic_head"], EXPECTED_ALEMBIC_HEAD)

        healthy_worker = _FakePostgresDatabase(role="aios_worker")
        verify_database(healthy_worker, worker=True)  # type: ignore[arg-type]

        # Drift scenarios
        missing_tbl_db = _FakePostgresDatabase(missing_rls={"aios_budget_reservation"})
        drift_missing = database_security_status(missing_tbl_db)  # type: ignore[arg-type]
        self.assertEqual(drift_missing["status"], "drift")
        self.assertEqual(drift_missing["rls_covered"], 39)
        self.assertEqual(drift_missing["missing_rls_tables"], ["aios_budget_reservation"])
        with self.assertRaisesRegex(RuntimeError, "forced row-level security"):
            verify_database(missing_tbl_db, worker=False)  # type: ignore[arg-type]

        stale_rev_db = _FakePostgresDatabase(alembic_head="0012_user_long_term_memory")
        self.assertEqual(database_security_status(stale_rev_db)["status"], "drift")  # type: ignore[arg-type]

        owner_drift_db = _FakePostgresDatabase(owner_member_tables={"aios_user_memory"})
        self.assertEqual(database_security_status(owner_drift_db)["status"], "drift")  # type: ignore[arg-type]
        with self.assertRaisesRegex(RuntimeError, "forced row-level security"):
            verify_database(owner_drift_db, worker=False)  # type: ignore[arg-type]

        no_force_db = _FakePostgresDatabase(no_force_rls={"aios_durable_event"})
        self.assertEqual(database_security_status(no_force_db)["status"], "drift")  # type: ignore[arg-type]

        # Grant drift scenarios
        tel_mutable = _FakePostgresDatabase(
            enterprise_overrides={"aios_llm_telemetry": (True, True, False, True, False)}
        )
        self.assertEqual(database_security_status(tel_mutable)["status"], "drift")  # type: ignore[arg-type]
        with self.assertRaisesRegex(RuntimeError, "aios_llm_telemetry"):
            verify_database(tel_mutable, worker=False)  # type: ignore[arg-type]

        sec_deletable = _FakePostgresDatabase(
            enterprise_overrides={"aios_security_event": (True, True, True, True, False)}
        )
        self.assertEqual(database_security_status(sec_deletable)["status"], "drift")  # type: ignore[arg-type]
        with self.assertRaisesRegex(RuntimeError, "aios_security_event"):
            verify_database(sec_deletable, worker=False)  # type: ignore[arg-type]

        worker_reads_durable = _FakePostgresDatabase(
            role="aios_worker",
            enterprise_overrides={"aios_durable_event": (True, True, False, False, False)},
        )
        with self.assertRaisesRegex(RuntimeError, "aios_durable_event"):
            verify_database(worker_reads_durable, worker=True)  # type: ignore[arg-type]

        outbox_mutable_key = _FakePostgresDatabase(
            col_priv_overrides={"aios_external_action_outbox_immutable_mutable": True}
        )
        with self.assertRaisesRegex(RuntimeError, "column grants drifted"):
            verify_database(outbox_mutable_key, worker=False)  # type: ignore[arg-type]


@unittest.skipUnless(TEST_DSN, "PostgreSQL test DSN is not configured")
class PostgresLiveEnterpriseTests(unittest.TestCase):
    def _create_temp_schema(self):
        import psycopg
        from psycopg import sql
        from psycopg.conninfo import make_conninfo

        schema_name = "aios_pg_ent_" + uuid4().hex[:16]
        ident = sql.Identifier(schema_name)
        with psycopg.connect(TEST_DSN) as conn:
            conn.execute(sql.SQL("CREATE SCHEMA {}").format(ident))

        def cleanup():
            with psycopg.connect(TEST_DSN) as conn:
                conn.execute(sql.SQL("DROP SCHEMA IF EXISTS {} CASCADE").format(ident))

        self.addCleanup(cleanup)
        return make_conninfo(TEST_DSN, options="-c search_path=" + schema_name)

    def test_postgres_alembic_32char_upgrade_from_0010_and_empty_is_idempotent(self):
        import psycopg

        config = Config(str(ROOT / "alembic.ini"))

        # 1. Empty schema -> upgrade head twice
        dsn_empty = self._create_temp_schema()
        with patch.dict(os.environ, {"AIOS_MIGRATION_DATABASE_URL": dsn_empty, "AIOS_MIGRATION_DATABASE_URL_FILE": ""}):
            command.upgrade(config, "head")
            command.upgrade(config, "head")
        with psycopg.connect(dsn_empty) as conn:
            ver = conn.execute("SELECT version_num FROM alembic_version").fetchone()[0]
            self.assertEqual(ver, EXPECTED_ALEMBIC_HEAD)
            max_len = conn.execute(
                """SELECT character_maximum_length FROM information_schema.columns
                   WHERE table_schema = current_schema()
                     AND table_name = 'alembic_version' AND column_name = 'version_num'"""
            ).fetchone()[0]
            self.assertEqual(max_len, 64)

        # 2. Legacy VARCHAR(32) alembic_version at 0010 -> upgrade through 0011 (37 chars), 0012, 0013
        dsn_legacy = self._create_temp_schema()
        with patch.dict(os.environ, {"AIOS_MIGRATION_DATABASE_URL": dsn_legacy, "AIOS_MIGRATION_DATABASE_URL_FILE": ""}):
            command.upgrade(config, "0010_channels_and_read_receipts")
        with psycopg.connect(dsn_legacy) as conn:
            conn.execute("ALTER TABLE alembic_version ALTER COLUMN version_num TYPE VARCHAR(32)")
        with patch.dict(os.environ, {"AIOS_MIGRATION_DATABASE_URL": dsn_legacy, "AIOS_MIGRATION_DATABASE_URL_FILE": ""}):
            command.upgrade(config, "head")
            command.downgrade(config, "0012_user_long_term_memory")
            command.upgrade(config, "head")
        with psycopg.connect(dsn_legacy) as conn:
            ver = conn.execute("SELECT version_num FROM alembic_version").fetchone()[0]
            self.assertEqual(ver, EXPECTED_ALEMBIC_HEAD)

    def test_postgres_40_table_rls_least_privilege_and_drift_detection(self):
        import psycopg
        from psycopg import errors, sql
        from psycopg.conninfo import make_conninfo

        dsn = self._create_temp_schema()
        config = Config(str(ROOT / "alembic.ini"))
        with patch.dict(os.environ, {"AIOS_MIGRATION_DATABASE_URL": dsn, "AIOS_MIGRATION_DATABASE_URL_FILE": ""}):
            command.upgrade(config, "head")

        suffix = uuid4().hex[:10]
        api_role = f"aios_api_{suffix}"
        worker_role = f"aios_worker_{suffix}"
        api_pw = uuid4().hex
        worker_pw = uuid4().hex
        secure_sql = (ROOT / "deploy/platform/postgres-security.sql").read_text()
        secure_sql = secure_sql.replace("aios_api", api_role).replace("aios_worker", worker_role)

        with psycopg.connect(dsn) as admin:
            schema = admin.execute("SELECT current_schema()").fetchone()[0]
            for rname, pw in ((api_role, api_pw), (worker_role, worker_pw)):
                admin.execute(sql.SQL("CREATE ROLE {} LOGIN PASSWORD {}").format(sql.Identifier(rname), sql.Literal(pw)))
                admin.execute(
                    sql.SQL("GRANT USAGE ON SCHEMA {} TO {}").format(sql.Identifier(schema), sql.Identifier(rname))
                )
            for stmt in secure_sql.split(";"):
                if stmt.strip():
                    admin.execute(stmt)

        def drop_roles():
            with psycopg.connect(dsn) as admin:
                for rname in (api_role, worker_role):
                    ident = sql.Identifier(rname)
                    admin.execute(sql.SQL("DROP OWNED BY {}").format(ident))
                    admin.execute(sql.SQL("DROP ROLE {}").format(ident))

        self.addCleanup(drop_roles)

        api_db = Database(Path("unused.sqlite"), make_conninfo(dsn, user=api_role, password=api_pw))
        worker_db = Database(Path("unused.sqlite"), make_conninfo(dsn, user=worker_role, password=worker_pw))
        self.addCleanup(api_db.close)
        self.addCleanup(worker_db.close)

        status = database_security_status(api_db)
        self.assertEqual(status["rls_covered"], 40)
        self.assertEqual(status["rls_expected"], 40)
        self.assertEqual(status["missing_rls_tables"], [])
        self.assertEqual(status["alembic_head"], EXPECTED_ALEMBIC_HEAD)
        self.assertEqual(status["status"], "ok")

        # Seed and verify tenant/subject isolation and immutability
        with api_db.transaction(write=True) as run:
            run("SELECT set_config('aios.tenant', 'harbour', true)")
            run(
                """INSERT INTO aios_llm_telemetry
                   (tenant, id, subject, role, provider, model, tier, reasoning_effort, created_at)
                   VALUES ('harbour', 'tel1', 'op', 'operator', 'deepseek', 'deepseek-flash', 'T1', 'none', 1.0)"""
            )
            run(
                """INSERT INTO aios_agent_session_state
                   (tenant, subject, session_id, rolling_summary, last_turn_at)
                   VALUES ('harbour', 'op', 's1', 'ok', 1.0)"""
            )
            run(
                """INSERT INTO aios_budget_reservation
                   (tenant, id, subject, role, day_key, reserved_micro_usd, status, expires_at, created_at)
                   VALUES ('harbour', 'res1', 'op', 'operator', '2026-11-25', 500, 'reserved', 9999.0, 1.0)"""
            )
            run("SELECT set_config('aios.subject', 'op', true)")
            run(
                """INSERT INTO aios_user_memory
                   (tenant, subject, content, version, token_count, updated_by, updated_at)
                   VALUES ('harbour', 'op', '# MEMORY.md', 1, 2, 'op', 1.0)"""
            )

        with api_db.transaction(write=False) as run:
            run("SELECT set_config('aios.tenant', 'harbour', true)")
            run("SELECT set_config('aios.subject', 'finance', true)")
            self.assertEqual(run("SELECT COUNT(*) AS n FROM aios_user_memory").fetchone()["n"], 0)

        with self.assertRaises(errors.InsufficientPrivilege):
            with api_db.transaction(write=True) as run:
                run("SELECT set_config('aios.tenant', 'harbour', true)")
                run("DELETE FROM aios_llm_telemetry WHERE id = 'tel1'")

        with self.assertRaises(errors.InsufficientPrivilege):
            with worker_db.transaction(write=False) as run:
                run("SELECT set_config('aios.tenant', 'harbour', true)")
                run("SELECT * FROM aios_durable_event")
