-- Run after aios_platform/schema.sql with a separate migration owner.
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
GRANT UPDATE (state, approver, due, expires) ON aios_proposal TO aios_api;
GRANT SELECT ON aios_proposal TO aios_worker;
GRANT UPDATE (state, due, epoch, checks, receipt) ON aios_proposal TO aios_worker;
GRANT INSERT ON aios_audit TO aios_worker;
