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
