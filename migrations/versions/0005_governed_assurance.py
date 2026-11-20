"""Create durable review and signed audit storage."""
from pathlib import Path

from alembic import op

revision = "0005_governed_assurance"
down_revision = "0004_workbench_chat"


def upgrade():
    schema = Path(__file__).resolve().parents[2] / "aios_platform/assurance.sql"
    for statement in schema.read_text().split(";"):
        if statement.strip():
            op.execute(statement)


def downgrade():
    raise RuntimeError("Use a forward migration to preserve assurance audit records")
