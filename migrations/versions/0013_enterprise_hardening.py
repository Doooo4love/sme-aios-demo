"""Add budget reservations, durable SSE events, external action outbox, and tenant provider policy."""
from pathlib import Path

from alembic import op

revision = "0013_enterprise_hardening"
down_revision = "0012_user_long_term_memory"


def upgrade():
    path = Path(__file__).resolve().parents[2] / "aios_platform/enterprise_hardening.sql"
    for statement in path.read_text().split(";"):
        if statement.strip():
            op.execute(statement)


def downgrade():
    op.execute("DROP TABLE IF EXISTS aios_tenant_provider_policy")
    op.execute("DROP TABLE IF EXISTS aios_external_action_outbox")
    op.execute("DROP TABLE IF EXISTS aios_durable_event")
    op.execute("DROP TABLE IF EXISTS aios_budget_reservation")
