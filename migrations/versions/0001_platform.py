"""Baseline platform tables, including adoption of the initial schema."""
from pathlib import Path

from alembic import op

revision = "0001_platform"
down_revision = None


def upgrade():
    package = Path(__file__).resolve().parents[2] / "aios_platform"
    for statement in (package / "schema.sql").read_text().split(";"):
        if statement.strip():
            op.execute(statement)


def downgrade():
    raise RuntimeError("Restore from backup to remove the platform schema")
