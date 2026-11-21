"""Add tenant-local employee module assignments."""
from pathlib import Path

from alembic import op

revision = "0007_module_access"
down_revision = "0006_assurance_runtime"


def upgrade():
    schema = Path(__file__).resolve().parents[2] / "aios_platform/module_access.sql"
    for statement in schema.read_text().split(";"):
        if statement.strip():
            op.execute(statement)


def downgrade():
    raise RuntimeError("Use a forward migration to preserve module revocations")
