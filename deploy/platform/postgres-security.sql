-- Run after alembic upgrade head with a separate migration owner.
-- Create roles aios_api and aios_worker with dedicated LOGIN credentials first.
-- Neither login may own these tables or hold BYPASSRLS or superuser privileges.

ALTER TABLE aios_intake ENABLE ROW LEVEL SECURITY;
ALTER TABLE aios_intake FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aios_intake_tenant ON aios_intake;
CREATE POLICY aios_intake_tenant ON aios_intake
    USING (tenant = current_setting('aios.tenant', true))
    WITH CHECK (tenant = current_setting('aios.tenant', true));

ALTER TABLE aios_proposal ENABLE ROW LEVEL SECURITY;
ALTER TABLE aios_proposal FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aios_proposal_tenant ON aios_proposal;
CREATE POLICY aios_proposal_tenant ON aios_proposal
    USING (tenant = current_setting('aios.tenant', true))
    WITH CHECK (tenant = current_setting('aios.tenant', true));

ALTER TABLE aios_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE aios_audit FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aios_audit_tenant ON aios_audit;
CREATE POLICY aios_audit_tenant ON aios_audit
    USING (tenant = current_setting('aios.tenant', true))
    WITH CHECK (tenant = current_setting('aios.tenant', true));

REVOKE ALL ON aios_intake, aios_proposal, aios_audit FROM PUBLIC;
GRANT SELECT, INSERT ON aios_intake, aios_proposal, aios_audit TO aios_api;
GRANT UPDATE (state, approver, due, expires, checks) ON aios_proposal TO aios_api;
GRANT SELECT ON aios_proposal TO aios_worker;
GRANT UPDATE (state, due, epoch, checks, receipt) ON aios_proposal TO aios_worker;
GRANT INSERT ON aios_audit TO aios_worker;

ALTER TABLE aios_request_key ENABLE ROW LEVEL SECURITY;
ALTER TABLE aios_request_key FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aios_tenant_scope ON aios_request_key;
CREATE POLICY aios_tenant_scope ON aios_request_key
    USING (tenant = current_setting('aios.tenant', true))
    WITH CHECK (tenant = current_setting('aios.tenant', true));
REVOKE ALL ON aios_request_key FROM PUBLIC;

ALTER TABLE aios_write_control ENABLE ROW LEVEL SECURITY;
ALTER TABLE aios_write_control FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aios_tenant_scope ON aios_write_control;
CREATE POLICY aios_tenant_scope ON aios_write_control
    USING (tenant = current_setting('aios.tenant', true))
    WITH CHECK (tenant = current_setting('aios.tenant', true));
REVOKE ALL ON aios_write_control FROM PUBLIC;

ALTER TABLE aios_suspension ENABLE ROW LEVEL SECURITY;
ALTER TABLE aios_suspension FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aios_tenant_scope ON aios_suspension;
CREATE POLICY aios_tenant_scope ON aios_suspension
    USING (tenant = current_setting('aios.tenant', true))
    WITH CHECK (tenant = current_setting('aios.tenant', true));
REVOKE ALL ON aios_suspension FROM PUBLIC;

ALTER TABLE aios_planner_budget ENABLE ROW LEVEL SECURITY;
ALTER TABLE aios_planner_budget FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aios_tenant_scope ON aios_planner_budget;
CREATE POLICY aios_tenant_scope ON aios_planner_budget
    USING (tenant = current_setting('aios.tenant', true))
    WITH CHECK (tenant = current_setting('aios.tenant', true));
REVOKE ALL ON aios_planner_budget FROM PUBLIC;

GRANT SELECT, INSERT ON aios_request_key TO aios_api;
GRANT SELECT, INSERT ON aios_write_control, aios_suspension, aios_planner_budget TO aios_api;
GRANT UPDATE (paused) ON aios_write_control TO aios_api;
GRANT UPDATE (suspended) ON aios_suspension TO aios_api;
GRANT UPDATE (window_id, calls) ON aios_planner_budget TO aios_api;
GRANT SELECT ON aios_write_control, aios_suspension TO aios_worker;

ALTER TABLE aios_chat_room ENABLE ROW LEVEL SECURITY;
ALTER TABLE aios_chat_room FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aios_chat_tenant ON aios_chat_room;
CREATE POLICY aios_chat_tenant ON aios_chat_room TO aios_api
    USING (tenant = current_setting('aios.tenant', true))
    WITH CHECK (tenant = current_setting('aios.tenant', true));

ALTER TABLE aios_chat_member ENABLE ROW LEVEL SECURITY;
ALTER TABLE aios_chat_member FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aios_chat_tenant ON aios_chat_member;
CREATE POLICY aios_chat_tenant ON aios_chat_member TO aios_api
    USING (tenant = current_setting('aios.tenant', true))
    WITH CHECK (tenant = current_setting('aios.tenant', true));

ALTER TABLE aios_chat_message ENABLE ROW LEVEL SECURITY;
ALTER TABLE aios_chat_message FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aios_chat_message_read ON aios_chat_message;
CREATE POLICY aios_chat_message_read ON aios_chat_message FOR SELECT TO aios_api USING (
    tenant = current_setting('aios.tenant', true) AND EXISTS (
        SELECT 1 FROM aios_chat_member AS m
        WHERE m.tenant = aios_chat_message.tenant AND m.room_id = aios_chat_message.room_id
          AND m.subject = current_setting('aios.subject', true) AND aios_chat_message.seq >= m.from_seq
    )
);
DROP POLICY IF EXISTS aios_chat_message_insert ON aios_chat_message;
CREATE POLICY aios_chat_message_insert ON aios_chat_message FOR INSERT TO aios_api WITH CHECK (
    tenant = current_setting('aios.tenant', true) AND author = current_setting('aios.subject', true)
    AND EXISTS (
        SELECT 1 FROM aios_chat_member AS m
        WHERE m.tenant = aios_chat_message.tenant AND m.room_id = aios_chat_message.room_id
          AND m.subject = current_setting('aios.subject', true) AND aios_chat_message.seq >= m.from_seq
    )
);

REVOKE ALL ON aios_chat_room, aios_chat_member, aios_chat_message FROM PUBLIC, aios_worker;
GRANT SELECT, INSERT ON aios_chat_room, aios_chat_member, aios_chat_message TO aios_api;
GRANT UPDATE (next_seq) ON aios_chat_room TO aios_api;
GRANT DELETE ON aios_chat_member TO aios_api;

ALTER TABLE aios_assurance_head ENABLE ROW LEVEL SECURITY;
ALTER TABLE aios_assurance_head FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aios_assurance_tenant ON aios_assurance_head;
CREATE POLICY aios_assurance_tenant ON aios_assurance_head TO aios_api
    USING (tenant = current_setting('aios.tenant', true))
    WITH CHECK (tenant = current_setting('aios.tenant', true));

ALTER TABLE aios_assurance_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE aios_assurance_audit FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aios_assurance_tenant ON aios_assurance_audit;
CREATE POLICY aios_assurance_tenant ON aios_assurance_audit TO aios_api
    USING (tenant = current_setting('aios.tenant', true))
    WITH CHECK (tenant = current_setting('aios.tenant', true));

ALTER TABLE aios_assurance_review ENABLE ROW LEVEL SECURITY;
ALTER TABLE aios_assurance_review FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aios_assurance_tenant ON aios_assurance_review;
CREATE POLICY aios_assurance_tenant ON aios_assurance_review TO aios_api
    USING (tenant = current_setting('aios.tenant', true))
    WITH CHECK (tenant = current_setting('aios.tenant', true));

REVOKE ALL ON aios_assurance_head, aios_assurance_audit, aios_assurance_review FROM PUBLIC, aios_worker;
REVOKE UPDATE, DELETE, TRUNCATE ON aios_assurance_audit FROM aios_api;
GRANT SELECT, INSERT ON aios_assurance_head, aios_assurance_review TO aios_api;
GRANT INSERT ON aios_assurance_audit TO aios_api;
GRANT UPDATE (tip_seq, tip_hash) ON aios_assurance_head TO aios_api;
GRANT UPDATE (state, decisions) ON aios_assurance_review TO aios_api;

ALTER TABLE aios_assurance_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE aios_assurance_attempt FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aios_assurance_tenant ON aios_assurance_attempt;
CREATE POLICY aios_assurance_tenant ON aios_assurance_attempt TO aios_api
    USING (tenant = current_setting('aios.tenant', true))
    WITH CHECK (tenant = current_setting('aios.tenant', true));

REVOKE ALL ON aios_assurance_attempt FROM PUBLIC, aios_worker, aios_api;
GRANT SELECT, INSERT ON aios_assurance_attempt TO aios_api;
GRANT UPDATE (run_id, started_at, expires_at, state) ON aios_assurance_attempt TO aios_api;

ALTER TABLE aios_employee ENABLE ROW LEVEL SECURITY;
ALTER TABLE aios_employee FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aios_employee_tenant ON aios_employee;
CREATE POLICY aios_employee_tenant ON aios_employee TO aios_api
    USING (tenant = current_setting('aios.tenant', true))
    WITH CHECK (tenant = current_setting('aios.tenant', true));

ALTER TABLE aios_module_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE aios_module_access FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aios_module_tenant ON aios_module_access;
CREATE POLICY aios_module_tenant ON aios_module_access TO aios_api, aios_worker
    USING (tenant = current_setting('aios.tenant', true))
    WITH CHECK (tenant = current_setting('aios.tenant', true));

REVOKE ALL ON aios_employee, aios_module_access FROM PUBLIC, aios_api, aios_worker;
GRANT SELECT, INSERT ON aios_employee, aios_module_access TO aios_api;
GRANT UPDATE (grants, warehouses, expires_at, version) ON aios_module_access TO aios_api;
GRANT SELECT ON aios_module_access TO aios_worker;
