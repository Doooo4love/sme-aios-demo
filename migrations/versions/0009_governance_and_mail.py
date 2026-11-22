"""Add dynamic governance prompt policies, security events, and email outbox."""
from pathlib import Path

from alembic import op

revision = "0009_governance_and_mail"
down_revision = "0008_collaboration"


def upgrade():
    path = Path(__file__).resolve().parents[2] / "aios_platform/governance.sql"
    for statement in path.read_text().split(";"):
        if statement.strip():
            op.execute(statement)


def downgrade():
    raise RuntimeError("Use a forward migration to preserve governance and security audit records")
