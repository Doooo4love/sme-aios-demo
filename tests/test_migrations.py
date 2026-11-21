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
                                     "0008_collaboration")
            finally:
                legacy.dispose()
