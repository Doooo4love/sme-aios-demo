"""Index the tenant-scoped reconciliation queue."""
from pathlib import Path

from alembic import op

revision = "0003_operations"
down_revision = "0002_safety"


def upgrade():
    package = Path(__file__).resolve().parents[2] / "aios_platform"
    op.execute((package / "operations.sql").read_text())


def downgrade():
    op.execute("DROP INDEX IF EXISTS aios_proposal_exception_due")
