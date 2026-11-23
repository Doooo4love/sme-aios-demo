import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, text

ROOT = Path(__file__).resolve().parents[1]


class MigrationTests(unittest.TestCase):
    def test_baseline_upgrade_adopts_existing_data_and_is_repeatable(self):
        with TemporaryDirectory() as temporary:
            url = f"sqlite:///{temporary}/legacy.sqlite"
            legacy = create_engine(url)
            config = Config(str(ROOT / "alembic.ini"))
            try:
                with legacy.begin() as connection:
                    for statement in (ROOT / "aios_platform/schema.sql").read_text().split(";"):
                        if statement.strip():
                            connection.exec_driver_sql(statement)
                    connection.execute(text("INSERT INTO aios_intake VALUES ('t', 'id1', 'w', '{}')"))
                with patch.dict(os.environ, {"AIOS_MIGRATION_DATABASE_URL": url, "AIOS_MIGRATION_DATABASE_URL_FILE": ""}):
                    command.upgrade(config, "head")
                    command.upgrade(config, "head")
                with legacy.connect() as connection:
                    self.assertEqual(connection.execute(text("SELECT id FROM aios_intake")).scalar_one(), "id1")
                    self.assertEqual(connection.execute(text("SELECT COUNT(*) FROM aios_write_control")).scalar_one(), 0)
                    self.assertEqual(connection.execute(text("SELECT version_num FROM alembic_version")).scalar_one(),
                                     "0011_routing_telemetry_and_escalation")
            finally:
                legacy.dispose()

    def test_0011_upgrade_and_rollback_compatibility(self):
        with TemporaryDirectory() as temporary:
            url = f"sqlite:///{temporary}/rollback.sqlite"
            engine = create_engine(url)
            config = Config(str(ROOT / "alembic.ini"))
            try:
                with patch.dict(os.environ, {"AIOS_MIGRATION_DATABASE_URL": url, "AIOS_MIGRATION_DATABASE_URL_FILE": ""}):
                    command.upgrade(config, "head")
                    with engine.connect() as conn:
                        self.assertEqual(
                            conn.execute(text("SELECT version_num FROM alembic_version")).scalar_one(),
                            "0011_routing_telemetry_and_escalation",
                        )
                        tables = {
                            row[0]
                            for row in conn.execute(text("SELECT name FROM sqlite_master WHERE type='table'")).fetchall()
                        }
                        self.assertTrue(
                            {
                                "aios_llm_telemetry",
                                "aios_quota_policy",
                                "aios_agent_session_state",
                                "aios_off_topic_policy",
                            } <= tables
                        )
                    command.downgrade(config, "0010_channels_and_read_receipts")
                    with engine.connect() as conn:
                        self.assertEqual(
                            conn.execute(text("SELECT version_num FROM alembic_version")).scalar_one(),
                            "0010_channels_and_read_receipts",
                        )
                        tables_after = {
                            row[0]
                            for row in conn.execute(text("SELECT name FROM sqlite_master WHERE type='table'")).fetchall()
                        }
                        self.assertFalse(
                            tables_after
                            & {
                                "aios_llm_telemetry",
                                "aios_quota_policy",
                                "aios_agent_session_state",
                                "aios_off_topic_policy",
                            }
                        )
                    command.upgrade(config, "head")
                    with engine.connect() as conn:
                        self.assertEqual(
                            conn.execute(text("SELECT version_num FROM alembic_version")).scalar_one(),
                            "0011_routing_telemetry_and_escalation",
                        )
            finally:
                engine.dispose()
