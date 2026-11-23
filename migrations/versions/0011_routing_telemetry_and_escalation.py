"""Add LLM routing telemetry, quota policy, agent session state, and off-topic escalation policy."""
from pathlib import Path

from alembic import op

revision = "0011_routing_telemetry_and_escalation"
down_revision = "0010_channels_and_read_receipts"


def upgrade():
    path = Path(__file__).resolve().parents[2] / "aios_platform/routing_and_escalation.sql"
    for statement in path.read_text().split(";"):
        if statement.strip():
            op.execute(statement)


def downgrade():
    op.execute("DROP TABLE IF EXISTS aios_off_topic_policy")
    op.execute("DROP TABLE IF EXISTS aios_agent_session_state")
    op.execute("DROP TABLE IF EXISTS aios_quota_policy")
    op.execute("DROP TABLE IF EXISTS aios_llm_telemetry")
