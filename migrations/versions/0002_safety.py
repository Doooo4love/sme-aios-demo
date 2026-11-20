"""Add operational controls, planner budgets and proposal idempotency."""
from pathlib import Path

from alembic import op

revision = "0002_safety"
down_revision = "0001_platform"


def upgrade():
    package = Path(__file__).resolve().parents[2] / "aios_platform"
    for statement in (package / "hardening.sql").read_text().split(";"):
        if statement.strip():
            op.execute(statement)


def downgrade():
    raise RuntimeError("Use a forward migration to preserve operational and idempotency records")
