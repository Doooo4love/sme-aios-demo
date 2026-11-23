"""Add chat read receipts and enterprise messaging channel tables."""
from pathlib import Path

from alembic import op

revision = "0010_channels_and_read_receipts"
down_revision = "0009_governance_and_mail"


def upgrade():
    path = Path(__file__).resolve().parents[2] / "aios_platform/channels_and_receipts.sql"
    for statement in path.read_text().split(";"):
        if statement.strip():
            op.execute(statement)


def downgrade():
    raise RuntimeError("Use a forward migration to preserve channel and read receipt audit records")
