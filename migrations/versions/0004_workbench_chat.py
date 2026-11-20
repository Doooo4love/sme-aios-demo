"""Create tenant-scoped workbench chat storage."""
from pathlib import Path

from alembic import op

revision = "0004_workbench_chat"
down_revision = "0003_operations"


def upgrade():
    schema = Path(__file__).resolve().parents[2] / "aios_platform/chat.sql"
    for statement in schema.read_text().split(";"):
        if statement.strip():
            op.execute(statement)


def downgrade():
    raise RuntimeError("Use a forward migration to preserve conversations")
