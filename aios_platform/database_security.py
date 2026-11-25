"""Fail startup if the production role or tenant isolation is misconfigured, and report security drift."""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from aios_demo.storage import Database

EXPECTED_ALEMBIC_HEAD = "0013_enterprise_hardening"

EXPECTED_RLS_TABLES: tuple[str, ...] = (
    # 0001_platform .. 0008_collaboration (23 original tables)
    "aios_intake",
    "aios_proposal",
    "aios_audit",
    "aios_request_key",
    "aios_write_control",
    "aios_suspension",
    "aios_planner_budget",
    "aios_chat_room",
    "aios_chat_member",
    "aios_chat_message",
    "aios_assurance_head",
    "aios_assurance_audit",
    "aios_assurance_review",
    "aios_assurance_attempt",
    "aios_employee",
    "aios_module_access",
    "aios_profile",
    "aios_agent_activity",
    "aios_proposal_review",
    "aios_calendar_event",
    "aios_calendar_member",
    "aios_internal_notice",
    "aios_browser_session",
    # 0009_governance_and_mail (3 tables)
    "aios_prompt_policy",
    "aios_security_event",
    "aios_email_outbox",
    # 0010_channels_and_read_receipts (4 tables)
    "aios_chat_read_receipt",
    "aios_channel_event_dedup",
    "aios_channel_binding",
    "aios_channel_outbound_log",
    # 0011_routing_telemetry_and_escalation (4 tables)
    "aios_llm_telemetry",
    "aios_quota_policy",
    "aios_agent_session_state",
    "aios_off_topic_policy",
    # 0012_user_long_term_memory (2 tables)
    "aios_user_memory",
    "aios_user_memory_staging",
    # 0013_enterprise_hardening (4 tables)
    "aios_budget_reservation",
    "aios_durable_event",
    "aios_external_action_outbox",
    "aios_tenant_provider_policy",
)

# Per-table (can_read, can_insert, can_update, can_delete, can_truncate) expectations: (api, worker).
_ENTERPRISE_TABLE_GRANTS: dict[
    str, tuple[tuple[bool, bool, bool, bool, bool], tuple[bool, bool, bool, bool, bool]]
] = {
    "aios_prompt_policy": ((True, True, True, False, False), (False, False, False, False, False)),
    "aios_security_event": ((True, True, True, False, False), (False, True, False, False, False)),
    "aios_email_outbox": ((True, True, False, False, False), (False, False, False, False, False)),
    "aios_chat_read_receipt": ((True, True, True, True, False), (False, False, False, False, False)),
    "aios_channel_event_dedup": ((True, True, False, False, False), (False, False, False, False, False)),
    "aios_channel_binding": ((True, True, True, True, False), (False, False, False, False, False)),
    "aios_channel_outbound_log": ((True, True, False, False, False), (False, False, False, False, False)),
    "aios_llm_telemetry": ((True, True, False, False, False), (False, False, False, False, False)),
    "aios_quota_policy": ((True, True, True, False, False), (False, False, False, False, False)),
    "aios_agent_session_state": ((True, True, True, True, False), (False, False, False, False, False)),
    "aios_off_topic_policy": ((True, True, True, False, False), (False, False, False, False, False)),
    "aios_user_memory": ((True, True, True, True, False), (False, False, False, False, False)),
    "aios_user_memory_staging": ((True, True, True, True, False), (False, False, False, False, False)),
    "aios_budget_reservation": ((True, True, True, False, False), (False, False, False, False, False)),
    "aios_durable_event": ((True, True, False, False, False), (False, True, False, False, False)),
    "aios_external_action_outbox": ((True, True, True, False, False), (True, False, True, False, False)),
    "aios_tenant_provider_policy": ((True, True, True, False, False), (False, False, False, False, False)),
}

_COLUMN_UPDATE_BOUNDARIES: dict[str, tuple[tuple[str, ...], tuple[str, ...]]] = {
    "aios_prompt_policy": (
        ("title", "directive", "guardrail_rules", "updated_by", "updated_at", "version"),
        ("tenant", "scope_key"),
    ),
    "aios_security_event": (
        ("status", "resolved_by", "resolved_at", "resolution_note"),
        ("tenant", "id", "subject", "category", "decision", "created_at"),
    ),
    "aios_channel_binding": (
        ("external_user_id", "display_handle", "verified", "updated_at"),
        ("tenant", "subject", "channel_id"),
    ),
    "aios_chat_read_receipt": (
        ("last_read_seq", "read_at"),
        ("tenant", "room_id", "subject"),
    ),
    "aios_external_action_outbox": (
        ("state", "external_id", "result_json", "attempt", "lease_until", "updated_at"),
        ("tenant", "id", "subject", "action_kind", "client_id", "request_sha256", "created_at"),
    ),
}


def _col(row: Any, key: str, index: int = 0) -> Any:
    if isinstance(row, Mapping) or hasattr(row, "keys"):
        return row[key]
    return row[index]


def verify_database(database: Database, *, worker: bool) -> None:
    """Fail closed at startup if the PostgreSQL principal, RLS policies, or grants drift."""
    role = "aios_worker" if worker else "aios_api"
    marks = ",".join("?" for _ in EXPECTED_RLS_TABLES)
    enterprise_names = tuple(_ENTERPRISE_TABLE_GRANTS)
    enterprise_marks = ",".join("?" for _ in enterprise_names)

    with database.transaction(write=False) as run:
        principal = run(
            """SELECT rolname, rolsuper, rolbypassrls, rolcreaterole
               FROM pg_roles WHERE rolname = CURRENT_USER"""
        ).fetchone()
        if principal is None or principal["rolname"] != role or any(
            principal[key] for key in ("rolsuper", "rolbypassrls", "rolcreaterole")
        ):
            raise RuntimeError(f"Platform service must use the restricted {role} PostgreSQL login")

        tables = run(
            f"""
            SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
                   pg_has_role(c.relowner, 'MEMBER') AS owner_member
            FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace
            WHERE n.nspname = current_schema()
              AND c.relname IN ({marks})
            """,
            EXPECTED_RLS_TABLES,
        ).fetchall()
        if len(tables) != len(EXPECTED_RLS_TABLES) or any(
            row["owner_member"] or not row["relrowsecurity"] or not row["relforcerowsecurity"]
            for row in tables
        ):
            raise RuntimeError("Apply platform migrations and forced row-level security as the migration owner")

        collaboration = run(
            """
            SELECT c.relname,
                   has_table_privilege(c.oid, 'SELECT') AS can_read,
                   has_table_privilege(c.oid, 'INSERT') AS can_insert,
                   has_any_column_privilege(c.oid, 'UPDATE') AS can_update,
                   has_table_privilege(c.oid, 'DELETE') AS can_delete
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = current_schema() AND c.relname IN (
                'aios_profile', 'aios_agent_activity', 'aios_proposal_review', 'aios_calendar_event',
                'aios_calendar_member', 'aios_internal_notice', 'aios_browser_session')
            """
        ).fetchall()
        if len(collaboration) != 7:
            raise RuntimeError("Platform PostgreSQL grants do not match collaboration roles")
        for entry in collaboration:
            name = entry["relname"]
            expected = (False, name == "aios_internal_notice", False, False) if worker else (
                True, True, name not in {"aios_calendar_member", "aios_browser_session"}, name == "aios_browser_session"
            )
            if tuple(entry[key] for key in ("can_read", "can_insert", "can_update", "can_delete")) != expected:
                raise RuntimeError("Platform PostgreSQL grants do not match collaboration roles")

        privileges = run(
            """
            SELECT has_table_privilege('aios_audit', 'UPDATE, DELETE, TRUNCATE') AS audit_mutable,
                   has_column_privilege('aios_proposal', 'receipt', 'UPDATE') AS receipt_writable,
                   has_table_privilege('aios_proposal', 'INSERT') AS can_propose,
                   has_column_privilege('aios_write_control', 'paused', 'UPDATE') AS can_change_pause,
                   has_table_privilege('aios_intake', 'SELECT') AS can_read_intakes,
                   has_table_privilege('aios_chat_message', 'SELECT') AS can_read_chat,
                   has_table_privilege('aios_chat_message', 'UPDATE, DELETE, TRUNCATE') AS chat_mutable,
                   has_table_privilege('aios_assurance_audit', 'SELECT, UPDATE, DELETE, TRUNCATE') AS audit_disclosed,
                   has_table_privilege('aios_assurance_audit', 'INSERT') AS audit_append,
                   has_table_privilege('aios_assurance_review', 'SELECT') AS assurance_read,
                   has_any_column_privilege('aios_assurance_attempt', 'SELECT, INSERT, UPDATE, REFERENCES')
                       OR has_table_privilege('aios_assurance_attempt', 'DELETE, TRUNCATE, TRIGGER') AS attempt_access,
                   has_table_privilege('aios_assurance_attempt', 'SELECT') AS attempt_read,
                   has_table_privilege('aios_assurance_attempt', 'INSERT') AS attempt_insert,
                   has_column_privilege('aios_assurance_attempt', 'run_id', 'UPDATE')
                       AND has_column_privilege('aios_assurance_attempt', 'started_at', 'UPDATE')
                       AND has_column_privilege('aios_assurance_attempt', 'expires_at', 'UPDATE')
                       AND has_column_privilege('aios_assurance_attempt', 'state', 'UPDATE') AS attempt_transition,
                   has_table_privilege('aios_assurance_attempt', 'DELETE, TRUNCATE, TRIGGER')
                       OR has_column_privilege('aios_assurance_attempt', 'tenant', 'UPDATE')
                       OR has_column_privilege('aios_assurance_attempt', 'id', 'UPDATE')
                       OR has_column_privilege('aios_assurance_attempt', 'binding', 'UPDATE') AS attempt_mutable_key,
                   has_table_privilege('aios_employee', 'SELECT, INSERT')
                       OR has_any_column_privilege('aios_employee', 'SELECT, INSERT') AS directory_access,
                   has_table_privilege('aios_module_access', 'SELECT') AS module_read,
                   has_table_privilege('aios_module_access', 'INSERT')
                       OR has_any_column_privilege('aios_module_access', 'INSERT, UPDATE') AS module_write,
                   has_any_column_privilege('aios_employee', 'UPDATE')
                       OR has_table_privilege('aios_employee', 'DELETE, TRUNCATE')
                       OR has_table_privilege('aios_module_access', 'DELETE, TRUNCATE')
                       OR has_column_privilege('aios_module_access', 'tenant', 'UPDATE')
                       OR has_column_privilege('aios_module_access', 'subject', 'UPDATE')
                       OR has_column_privilege('aios_module_access', 'module', 'UPDATE') AS module_mutable_key
            """
        ).fetchone()
        if (not privileges["module_read"] or privileges["module_mutable_key"]
                or privileges["directory_access"] == worker or privileges["module_write"] == worker):
            raise RuntimeError("Platform PostgreSQL grants do not match the module access boundary")
        if privileges["audit_mutable"] or privileges["chat_mutable"] or privileges["audit_disclosed"] or (
            worker and (privileges["can_propose"] or privileges["can_change_pause"]
                        or privileges["can_read_intakes"] or privileges["can_read_chat"]
                        or privileges["audit_append"] or privileges["assurance_read"] or privileges["attempt_access"]
                        or not privileges["receipt_writable"])
        ) or (not worker and (not privileges["can_propose"] or not privileges["can_change_pause"]
                             or privileges["receipt_writable"] or not privileges["can_read_intakes"]
                             or not privileges["can_read_chat"] or not privileges["audit_append"]
                             or not privileges["assurance_read"] or not privileges["attempt_read"]
                             or not privileges["attempt_insert"] or not privileges["attempt_transition"]
                             or privileges["attempt_mutable_key"])):
            raise RuntimeError("Platform PostgreSQL grants do not match API/worker separation")

        enterprise_rows = run(
            f"""
            SELECT c.relname,
                   has_table_privilege(c.oid, 'SELECT') AS can_read,
                   has_table_privilege(c.oid, 'INSERT') AS can_insert,
                   has_any_column_privilege(c.oid, 'UPDATE') AS can_update,
                   has_table_privilege(c.oid, 'DELETE') AS can_delete,
                   has_table_privilege(c.oid, 'TRUNCATE') AS can_truncate
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = current_schema() AND c.relname IN ({enterprise_marks})
            """,
            enterprise_names,
        ).fetchall()
        if len(enterprise_rows) != len(_ENTERPRISE_TABLE_GRANTS):
            raise RuntimeError("Platform PostgreSQL grants do not match enterprise hardening roles")
        for entry in enterprise_rows:
            name = entry["relname"]
            expected_api, expected_worker = _ENTERPRISE_TABLE_GRANTS[name]
            expected = expected_worker if worker else expected_api
            actual = tuple(
                bool(entry[key])
                for key in ("can_read", "can_insert", "can_update", "can_delete", "can_truncate")
            )
            if actual != expected:
                raise RuntimeError(f"Platform PostgreSQL grants do not match enterprise boundary on {name}")

        # Verify column-level immutability for key/audit columns on column-granted tables.
        col_selects: list[str] = []
        for tbl, (allowed_cols, immutable_cols) in _COLUMN_UPDATE_BOUNDARIES.items():
            if worker and tbl != "aios_external_action_outbox":
                continue
            allowed_expr = " AND ".join(
                f"has_column_privilege('{tbl}', '{col}', 'UPDATE')" for col in allowed_cols
            )
            immutable_expr = " OR ".join(
                f"has_column_privilege('{tbl}', '{col}', 'UPDATE')" for col in immutable_cols
            )
            col_selects.append(f"({allowed_expr}) AS {tbl}_allowed")
            col_selects.append(f"({immutable_expr}) AS {tbl}_immutable_mutable")

        if col_selects:
            col_privs = run("SELECT " + ", ".join(col_selects)).fetchone()
            for tbl in _COLUMN_UPDATE_BOUNDARIES:
                if worker and tbl != "aios_external_action_outbox":
                    continue
                if not col_privs[f"{tbl}_allowed"] or col_privs[f"{tbl}_immutable_mutable"]:
                    raise RuntimeError(f"Platform PostgreSQL column grants drifted on {tbl}")


def database_security_status(database: Database) -> dict[str, Any]:
    """Return non-raising schema, Alembic revision, and RLS drift status for system health."""
    is_postgres = bool(getattr(database, "dsn", None))
    engine_mode = getattr(database, "engine_mode", "postgres" if is_postgres else "sqlite")
    try:
        with database.transaction(write=False) as run:
            if not is_postgres:
                table_rows = run("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()
                existing = {str(_col(row, "name", 0)) for row in table_rows}
                alembic_head: str | None = None
                if "alembic_version" in existing:
                    ver_row = run("SELECT version_num FROM alembic_version LIMIT 1").fetchone()
                    alembic_head = str(_col(ver_row, "version_num", 0)) if ver_row is not None else None
                missing_tables = [tbl for tbl in EXPECTED_RLS_TABLES if tbl not in existing]
                if missing_tables or (alembic_head is not None and alembic_head != EXPECTED_ALEMBIC_HEAD):
                    status = "drift"
                elif alembic_head == EXPECTED_ALEMBIC_HEAD:
                    status = "ok"
                else:
                    status = "sqlite_demo"
                return {
                    "engine_mode": engine_mode,
                    "alembic_head": alembic_head,
                    "expected_alembic_head": EXPECTED_ALEMBIC_HEAD,
                    "rls_covered": 0,
                    "rls_expected": len(EXPECTED_RLS_TABLES),
                    "missing_rls_tables": [],
                    "missing_tables": missing_tables,
                    "status": status,
                }

            reg_row = run("SELECT to_regclass('alembic_version') AS reg").fetchone()
            has_alembic = reg_row is not None and _col(reg_row, "reg", 0) is not None
            alembic_head = None
            if has_alembic:
                ver_row = run("SELECT version_num FROM alembic_version LIMIT 1").fetchone()
                alembic_head = str(_col(ver_row, "version_num", 0)) if ver_row is not None else None

            marks = ",".join("?" for _ in EXPECTED_RLS_TABLES)
            rls_rows = run(
                f"""SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
                           pg_has_role(c.relowner, 'MEMBER') AS owner_member
                    FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace
                    WHERE n.nspname = current_schema()
                      AND c.relname IN ({marks})""",
                EXPECTED_RLS_TABLES,
            ).fetchall()
            by_name = {str(_col(row, "relname", 0)): row for row in rls_rows}
            missing_rls_tables: list[str] = []
            owner_drift_tables: list[str] = []
            for tbl in EXPECTED_RLS_TABLES:
                row = by_name.get(tbl)
                if (
                    row is None
                    or not bool(_col(row, "relrowsecurity", 1))
                    or not bool(_col(row, "relforcerowsecurity", 2))
                ):
                    missing_rls_tables.append(tbl)
                if row is not None and bool(_col(row, "owner_member", 3)):
                    owner_drift_tables.append(tbl)

            privilege_drift = False
            principal = run(
                """SELECT rolname, rolsuper, rolbypassrls, rolcreaterole
                   FROM pg_roles WHERE rolname = CURRENT_USER"""
            ).fetchone()
            if principal is not None:
                if (
                    bool(_col(principal, "rolsuper", 1))
                    or bool(_col(principal, "rolbypassrls", 2))
                    or bool(_col(principal, "rolcreaterole", 3))
                ):
                    privilege_drift = True
                elif (
                    str(_col(principal, "rolname", 0)) == "aios_api"
                    and {"aios_llm_telemetry", "aios_security_event", "aios_email_outbox"} <= set(by_name)
                ):
                    priv_row = run(
                        """SELECT has_table_privilege('aios_llm_telemetry', 'DELETE, TRUNCATE')
                                      OR has_any_column_privilege('aios_llm_telemetry', 'UPDATE') AS tel_mutable,
                                  has_table_privilege('aios_security_event', 'DELETE, TRUNCATE') AS sec_deletable,
                                  has_table_privilege('aios_email_outbox', 'DELETE, TRUNCATE')
                                      OR has_any_column_privilege('aios_email_outbox', 'UPDATE') AS mail_mutable"""
                    ).fetchone()
                    if priv_row is not None and (
                        bool(_col(priv_row, "tel_mutable", 0))
                        or bool(_col(priv_row, "sec_deletable", 1))
                        or bool(_col(priv_row, "mail_mutable", 2))
                    ):
                        privilege_drift = True

            rls_covered = len(EXPECTED_RLS_TABLES) - len(missing_rls_tables)
            healthy = (
                alembic_head == EXPECTED_ALEMBIC_HEAD
                and rls_covered == len(EXPECTED_RLS_TABLES)
                and not owner_drift_tables
                and not privilege_drift
            )
            return {
                "engine_mode": engine_mode,
                "alembic_head": alembic_head,
                "expected_alembic_head": EXPECTED_ALEMBIC_HEAD,
                "rls_covered": rls_covered,
                "rls_expected": len(EXPECTED_RLS_TABLES),
                "missing_rls_tables": missing_rls_tables,
                "owner_drift_tables": owner_drift_tables,
                "privilege_drift": privilege_drift,
                "status": "ok" if healthy else "drift",
            }
    except Exception as exc:
        return {
            "engine_mode": engine_mode,
            "alembic_head": None,
            "expected_alembic_head": EXPECTED_ALEMBIC_HEAD,
            "rls_covered": 0,
            "rls_expected": len(EXPECTED_RLS_TABLES),
            "missing_rls_tables": list(EXPECTED_RLS_TABLES) if is_postgres else [],
            "status": "error",
            "error": type(exc).__name__,
        }
