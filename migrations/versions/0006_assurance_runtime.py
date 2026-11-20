"""Record durable attempt ownership and approval expiry."""
from pathlib import Path

from alembic import op

revision = "0006_assurance_runtime"
down_revision = "0005_governed_assurance"


def upgrade():
    schema = Path(__file__).resolve().parents[2] / "aios_platform/assurance_runtime.sql"
    for statement in schema.read_text().split(";"):
        if statement.strip():
            op.execute(statement)


def downgrade():
    raise RuntimeError("Use a forward migration to preserve attempt ownership")
