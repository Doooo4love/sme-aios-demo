"""Fail startup if the production role or tenant isolation is misconfigured."""
from aios_demo.storage import Database


def verify_database(database: Database, *, worker: bool):
    role = "aios_worker" if worker else "aios_api"
    with database.transaction(write=False) as run:
        principal = run("""SELECT rolname, rolsuper, rolbypassrls, rolcreaterole
                           FROM pg_roles WHERE rolname = CURRENT_USER""").fetchone()
        if principal["rolname"] != role or any(principal[key] for key in
                ("rolsuper", "rolbypassrls", "rolcreaterole")):
            raise RuntimeError(f"Platform service must use the restricted {role} PostgreSQL login")
        tables = run("""
            SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
                   pg_has_role(c.relowner, 'MEMBER') AS owner_member
            FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace
            WHERE n.nspname = current_schema()
              AND c.relname IN ('aios_intake', 'aios_proposal', 'aios_audit',
                  'aios_request_key', 'aios_write_control', 'aios_suspension', 'aios_planner_budget',
                  'aios_chat_room', 'aios_chat_member', 'aios_chat_message',
                  'aios_assurance_head', 'aios_assurance_audit', 'aios_assurance_review',
                  'aios_assurance_attempt', 'aios_employee', 'aios_module_access',
                  'aios_profile', 'aios_agent_activity', 'aios_proposal_review', 'aios_calendar_event',
                  'aios_calendar_member', 'aios_internal_notice', 'aios_browser_session')
        """).fetchall()
        if len(tables) != 23 or any(row["owner_member"] or not row["relrowsecurity"]
                                or not row["relforcerowsecurity"] for row in tables):
            raise RuntimeError("Apply platform migrations and forced row-level security as the migration owner")
        collaboration = run("""
            SELECT c.relname,
                   has_table_privilege(c.oid, 'SELECT') AS can_read,
                   has_table_privilege(c.oid, 'INSERT') AS can_insert,
                   has_any_column_privilege(c.oid, 'UPDATE') AS can_update,
                   has_table_privilege(c.oid, 'DELETE') AS can_delete
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = current_schema() AND c.relname IN (
                'aios_profile', 'aios_agent_activity', 'aios_proposal_review', 'aios_calendar_event',
                'aios_calendar_member', 'aios_internal_notice', 'aios_browser_session')
        """).fetchall()
        for entry in collaboration:
            name = entry["relname"]
            expected = (False, name == "aios_internal_notice", False, False) if worker else (
                True, True, name not in {"aios_calendar_member", "aios_browser_session"}, name == "aios_browser_session")
            if tuple(entry[key] for key in ("can_read", "can_insert", "can_update", "can_delete")) != expected:
                raise RuntimeError("Platform PostgreSQL grants do not match collaboration roles")
        privileges = run("""
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
        """).fetchone()
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
