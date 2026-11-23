"""Add per-user long-term MEMORY.md and passive staging tables."""
from pathlib import Path

from alembic import op

revision = "0012_user_long_term_memory"
down_revision = "0011_routing_telemetry_and_escalation"


def upgrade():
    path = Path(__file__).resolve().parents[2] / "aios_platform/user_memory.sql"
    for statement in path.read_text().split(";"):
        if statement.strip():
            op.execute(statement)


def downgrade():
    op.execute("DROP TABLE IF EXISTS aios_user_memory_staging")
    op.execute("DROP TABLE IF EXISTS aios_user_memory")
