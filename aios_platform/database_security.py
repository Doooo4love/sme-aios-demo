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
                  'aios_assurance_head', 'aios_assurance_audit', 'aios_assurance_review')
        """).fetchall()
        if len(tables) != 13 or any(row["owner_member"] or not row["relrowsecurity"]
                                or not row["relforcerowsecurity"] for row in tables):
            raise RuntimeError("Apply platform migrations and forced row-level security as the migration owner")
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
                   has_table_privilege('aios_assurance_review', 'SELECT') AS assurance_read
        """).fetchone()
        if privileges["audit_mutable"] or privileges["chat_mutable"] or privileges["audit_disclosed"] or (
            worker and (privileges["can_propose"] or privileges["can_change_pause"]
                        or privileges["can_read_intakes"] or privileges["can_read_chat"]
                        or privileges["audit_append"] or privileges["assurance_read"]
                        or not privileges["receipt_writable"])
        ) or (not worker and (not privileges["can_propose"] or not privileges["can_change_pause"]
                             or privileges["receipt_writable"] or not privileges["can_read_intakes"]
                             or not privileges["can_read_chat"] or not privileges["audit_append"]
                             or not privileges["assurance_read"])):
            raise RuntimeError("Platform PostgreSQL grants do not match API/worker separation")
