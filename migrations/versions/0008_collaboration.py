"""Add scoped profiles, Agent activity, decisions, meetings and browser sessions."""
from pathlib import Path

from alembic import op

revision = "0008_collaboration"
down_revision = "0007_module_access"


def upgrade():
    path = Path(__file__).resolve().parents[2] / "aios_platform/collaboration.sql"
    for statement in path.read_text().split(";"):
        if statement.strip():
            op.execute(statement)


def downgrade():
    raise RuntimeError("Use a forward migration to preserve collaboration records")
