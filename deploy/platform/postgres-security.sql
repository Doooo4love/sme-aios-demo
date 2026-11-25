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

-- Collaboration records. Profile and workbench history queries propagate the verified subject.
ALTER TABLE aios_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE aios_profile FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aios_profile_read ON aios_profile;
CREATE POLICY aios_profile_read ON aios_profile FOR SELECT TO aios_api USING (
    tenant = current_setting('aios.tenant', true) AND (
        subject = current_setting('aios.subject', true) OR (kind = 'employee' AND EXISTS (
            SELECT 1 FROM aios_chat_member target_member JOIN aios_chat_member own_member
            ON target_member.tenant = own_member.tenant AND target_member.room_id = own_member.room_id
            WHERE target_member.tenant = aios_profile.tenant AND target_member.subject = aios_profile.subject
              AND own_member.subject = current_setting('aios.subject', true)
        ))
    )
);
DROP POLICY IF EXISTS aios_profile_write ON aios_profile;
CREATE POLICY aios_profile_write ON aios_profile FOR ALL TO aios_api
    USING (tenant = current_setting('aios.tenant', true) AND subject = current_setting('aios.subject', true))
    WITH CHECK (tenant = current_setting('aios.tenant', true) AND subject = current_setting('aios.subject', true));

ALTER TABLE aios_agent_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE aios_agent_activity FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aios_agent_subject ON aios_agent_activity;
CREATE POLICY aios_agent_subject ON aios_agent_activity TO aios_api
    USING (tenant = current_setting('aios.tenant', true) AND subject = current_setting('aios.subject', true))
    WITH CHECK (tenant = current_setting('aios.tenant', true) AND subject = current_setting('aios.subject', true));

ALTER TABLE aios_proposal_review ENABLE ROW LEVEL SECURITY;
ALTER TABLE aios_proposal_review FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aios_review_tenant ON aios_proposal_review;
CREATE POLICY aios_review_tenant ON aios_proposal_review TO aios_api
    USING (tenant = current_setting('aios.tenant', true))
    WITH CHECK (tenant = current_setting('aios.tenant', true));

ALTER TABLE aios_calendar_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE aios_calendar_event FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aios_calendar_tenant ON aios_calendar_event;
CREATE POLICY aios_calendar_tenant ON aios_calendar_event TO aios_api
    USING (tenant = current_setting('aios.tenant', true))
    WITH CHECK (tenant = current_setting('aios.tenant', true));

ALTER TABLE aios_calendar_member ENABLE ROW LEVEL SECURITY;
ALTER TABLE aios_calendar_member FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aios_calendar_tenant ON aios_calendar_member;
CREATE POLICY aios_calendar_tenant ON aios_calendar_member TO aios_api
    USING (tenant = current_setting('aios.tenant', true))
    WITH CHECK (tenant = current_setting('aios.tenant', true));

ALTER TABLE aios_internal_notice ENABLE ROW LEVEL SECURITY;
ALTER TABLE aios_internal_notice FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aios_notice_subject ON aios_internal_notice;
CREATE POLICY aios_notice_subject ON aios_internal_notice TO aios_api
    USING (tenant = current_setting('aios.tenant', true) AND subject = current_setting('aios.subject', true))
    WITH CHECK (tenant = current_setting('aios.tenant', true) AND subject = current_setting('aios.subject', true));
DROP POLICY IF EXISTS aios_notice_append ON aios_internal_notice;
CREATE POLICY aios_notice_append ON aios_internal_notice FOR INSERT TO aios_api, aios_worker
    WITH CHECK (tenant = current_setting('aios.tenant', true));

ALTER TABLE aios_browser_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE aios_browser_session FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aios_session_tenant ON aios_browser_session;
CREATE POLICY aios_session_tenant ON aios_browser_session TO aios_api
    USING (tenant = current_setting('aios.tenant', true))
    WITH CHECK (tenant = current_setting('aios.tenant', true));

REVOKE ALL ON aios_profile, aios_agent_activity, aios_proposal_review, aios_calendar_event,
    aios_calendar_member, aios_internal_notice, aios_browser_session FROM PUBLIC, aios_api, aios_worker;
GRANT SELECT, INSERT ON aios_profile, aios_agent_activity, aios_proposal_review, aios_calendar_event,
    aios_calendar_member, aios_internal_notice, aios_browser_session TO aios_api;
GRANT UPDATE (display_name, avatar, version) ON aios_profile TO aios_api;
GRANT UPDATE (attempt, outcome, reference, lease_until) ON aios_agent_activity TO aios_api;
GRANT UPDATE (assigned_to, decided_by, decision, reason) ON aios_proposal_review TO aios_api;
GRANT UPDATE (title, starts_at, ends_at, revision, cancelled) ON aios_calendar_event TO aios_api;
GRANT UPDATE (read_at) ON aios_internal_notice TO aios_api;
GRANT DELETE ON aios_browser_session TO aios_api;
GRANT INSERT ON aios_internal_notice TO aios_worker;

-- Governance, prompt policy, security ledger, and email outbox (0009).
ALTER TABLE aios_prompt_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE aios_prompt_policy FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aios_prompt_policy_tenant ON aios_prompt_policy;
CREATE POLICY aios_prompt_policy_tenant ON aios_prompt_policy TO aios_api
    USING (tenant = current_setting('aios.tenant', true))
    WITH CHECK (tenant = current_setting('aios.tenant', true));
REVOKE ALL ON aios_prompt_policy FROM PUBLIC, aios_api, aios_worker;
GRANT SELECT, INSERT ON aios_prompt_policy TO aios_api;
GRANT UPDATE (title, directive, guardrail_rules, updated_by, updated_at, version) ON aios_prompt_policy TO aios_api;

ALTER TABLE aios_security_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE aios_security_event FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aios_security_event_select ON aios_security_event;
DROP POLICY IF EXISTS aios_security_event_update ON aios_security_event;
DROP POLICY IF EXISTS aios_security_event_insert ON aios_security_event;
CREATE POLICY aios_security_event_select ON aios_security_event FOR SELECT TO aios_api
    USING (tenant = current_setting('aios.tenant', true));
CREATE POLICY aios_security_event_update ON aios_security_event FOR UPDATE TO aios_api
    USING (tenant = current_setting('aios.tenant', true))
    WITH CHECK (tenant = current_setting('aios.tenant', true));
CREATE POLICY aios_security_event_insert ON aios_security_event FOR INSERT TO aios_api, aios_worker
    WITH CHECK (tenant = current_setting('aios.tenant', true));
REVOKE ALL ON aios_security_event FROM PUBLIC, aios_api, aios_worker;
GRANT SELECT, INSERT ON aios_security_event TO aios_api;
GRANT UPDATE (status, resolved_by, resolved_at, resolution_note) ON aios_security_event TO aios_api;
GRANT INSERT ON aios_security_event TO aios_worker;

ALTER TABLE aios_email_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE aios_email_outbox FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aios_email_outbox_tenant ON aios_email_outbox;
CREATE POLICY aios_email_outbox_tenant ON aios_email_outbox TO aios_api
    USING (tenant = current_setting('aios.tenant', true))
    WITH CHECK (tenant = current_setting('aios.tenant', true));
REVOKE ALL ON aios_email_outbox FROM PUBLIC, aios_api, aios_worker;
GRANT SELECT, INSERT ON aios_email_outbox TO aios_api;

-- Chat read receipts and enterprise channels (0010).
ALTER TABLE aios_chat_read_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE aios_chat_read_receipt FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aios_chat_read_receipt_read ON aios_chat_read_receipt;
CREATE POLICY aios_chat_read_receipt_read ON aios_chat_read_receipt FOR SELECT TO aios_api USING (
    tenant = current_setting('aios.tenant', true) AND EXISTS (
        SELECT 1 FROM aios_chat_member AS m
        WHERE m.tenant = aios_chat_read_receipt.tenant
          AND m.room_id = aios_chat_read_receipt.room_id
          AND m.subject = current_setting('aios.subject', true)
    )
);
DROP POLICY IF EXISTS aios_chat_read_receipt_insert ON aios_chat_read_receipt;
CREATE POLICY aios_chat_read_receipt_insert ON aios_chat_read_receipt FOR INSERT TO aios_api WITH CHECK (
    tenant = current_setting('aios.tenant', true)
    AND subject = current_setting('aios.subject', true)
    AND EXISTS (
        SELECT 1 FROM aios_chat_member AS m
        WHERE m.tenant = aios_chat_read_receipt.tenant
          AND m.room_id = aios_chat_read_receipt.room_id
          AND m.subject = current_setting('aios.subject', true)
    )
);
DROP POLICY IF EXISTS aios_chat_read_receipt_update ON aios_chat_read_receipt;
CREATE POLICY aios_chat_read_receipt_update ON aios_chat_read_receipt FOR UPDATE TO aios_api
    USING (tenant = current_setting('aios.tenant', true) AND subject = current_setting('aios.subject', true))
    WITH CHECK (
        tenant = current_setting('aios.tenant', true)
        AND subject = current_setting('aios.subject', true)
        AND EXISTS (
            SELECT 1 FROM aios_chat_member AS m
            WHERE m.tenant = aios_chat_read_receipt.tenant
              AND m.room_id = aios_chat_read_receipt.room_id
              AND m.subject = current_setting('aios.subject', true)
        )
    );
DROP POLICY IF EXISTS aios_chat_read_receipt_delete ON aios_chat_read_receipt;
CREATE POLICY aios_chat_read_receipt_delete ON aios_chat_read_receipt FOR DELETE TO aios_api USING (
    tenant = current_setting('aios.tenant', true) AND (
        subject = current_setting('aios.subject', true)
        OR EXISTS (
            SELECT 1 FROM aios_chat_room AS r
            WHERE r.tenant = aios_chat_read_receipt.tenant
              AND r.id = aios_chat_read_receipt.room_id
              AND r.owner = current_setting('aios.subject', true)
        )
    )
);
REVOKE ALL ON aios_chat_read_receipt FROM PUBLIC, aios_api, aios_worker;
GRANT SELECT, INSERT, DELETE ON aios_chat_read_receipt TO aios_api;
GRANT UPDATE (last_read_seq, read_at) ON aios_chat_read_receipt TO aios_api;

ALTER TABLE aios_channel_event_dedup ENABLE ROW LEVEL SECURITY;
ALTER TABLE aios_channel_event_dedup FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aios_channel_event_dedup_tenant ON aios_channel_event_dedup;
CREATE POLICY aios_channel_event_dedup_tenant ON aios_channel_event_dedup TO aios_api
    USING (tenant = current_setting('aios.tenant', true))
    WITH CHECK (tenant = current_setting('aios.tenant', true));
REVOKE ALL ON aios_channel_event_dedup FROM PUBLIC, aios_api, aios_worker;
GRANT SELECT, INSERT ON aios_channel_event_dedup TO aios_api;

ALTER TABLE aios_channel_binding ENABLE ROW LEVEL SECURITY;
ALTER TABLE aios_channel_binding FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aios_channel_binding_tenant ON aios_channel_binding;
CREATE POLICY aios_channel_binding_tenant ON aios_channel_binding TO aios_api
    USING (tenant = current_setting('aios.tenant', true))
    WITH CHECK (tenant = current_setting('aios.tenant', true));
REVOKE ALL ON aios_channel_binding FROM PUBLIC, aios_api, aios_worker;
GRANT SELECT, INSERT, DELETE ON aios_channel_binding TO aios_api;
GRANT UPDATE (external_user_id, display_handle, verified, updated_at) ON aios_channel_binding TO aios_api;

ALTER TABLE aios_channel_outbound_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE aios_channel_outbound_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aios_channel_outbound_log_tenant ON aios_channel_outbound_log;
CREATE POLICY aios_channel_outbound_log_tenant ON aios_channel_outbound_log TO aios_api
    USING (tenant = current_setting('aios.tenant', true))
    WITH CHECK (tenant = current_setting('aios.tenant', true));
REVOKE ALL ON aios_channel_outbound_log FROM PUBLIC, aios_api, aios_worker;
GRANT SELECT, INSERT ON aios_channel_outbound_log TO aios_api;

-- Routing telemetry, quota policies, agent session state, and off-topic escalation (0011).
ALTER TABLE aios_llm_telemetry ENABLE ROW LEVEL SECURITY;
ALTER TABLE aios_llm_telemetry FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aios_llm_telemetry_tenant ON aios_llm_telemetry;
CREATE POLICY aios_llm_telemetry_tenant ON aios_llm_telemetry TO aios_api
    USING (tenant = current_setting('aios.tenant', true))
    WITH CHECK (tenant = current_setting('aios.tenant', true));
REVOKE ALL ON aios_llm_telemetry FROM PUBLIC, aios_api, aios_worker;
REVOKE UPDATE, DELETE, TRUNCATE ON aios_llm_telemetry FROM aios_api;
GRANT SELECT, INSERT ON aios_llm_telemetry TO aios_api;

ALTER TABLE aios_quota_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE aios_quota_policy FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aios_quota_policy_tenant ON aios_quota_policy;
CREATE POLICY aios_quota_policy_tenant ON aios_quota_policy TO aios_api
    USING (tenant = current_setting('aios.tenant', true))
    WITH CHECK (tenant = current_setting('aios.tenant', true));
REVOKE ALL ON aios_quota_policy FROM PUBLIC, aios_api, aios_worker;
GRANT SELECT, INSERT, UPDATE ON aios_quota_policy TO aios_api;

-- ContextManager uses workflow.tx (tenant-scoped); enforce tenant and optional subject isolation.
ALTER TABLE aios_agent_session_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE aios_agent_session_state FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aios_agent_session_state_tenant ON aios_agent_session_state;
CREATE POLICY aios_agent_session_state_tenant ON aios_agent_session_state TO aios_api
    USING (
        tenant = current_setting('aios.tenant', true)
        AND (NULLIF(current_setting('aios.subject', true), '') IS NULL
             OR subject = current_setting('aios.subject', true))
    )
    WITH CHECK (
        tenant = current_setting('aios.tenant', true)
        AND (NULLIF(current_setting('aios.subject', true), '') IS NULL
             OR subject = current_setting('aios.subject', true))
    );
REVOKE ALL ON aios_agent_session_state FROM PUBLIC, aios_api, aios_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON aios_agent_session_state TO aios_api;

ALTER TABLE aios_off_topic_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE aios_off_topic_policy FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aios_off_topic_policy_tenant ON aios_off_topic_policy;
CREATE POLICY aios_off_topic_policy_tenant ON aios_off_topic_policy TO aios_api
    USING (tenant = current_setting('aios.tenant', true))
    WITH CHECK (tenant = current_setting('aios.tenant', true));
REVOKE ALL ON aios_off_topic_policy FROM PUBLIC, aios_api, aios_worker;
GRANT SELECT, INSERT, UPDATE ON aios_off_topic_policy TO aios_api;

-- Per-user long-term MEMORY.md and passive staging (0012): strictly tenant + subject isolated.
ALTER TABLE aios_user_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE aios_user_memory FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aios_user_memory_subject ON aios_user_memory;
CREATE POLICY aios_user_memory_subject ON aios_user_memory TO aios_api
    USING (tenant = current_setting('aios.tenant', true) AND subject = current_setting('aios.subject', true))
    WITH CHECK (tenant = current_setting('aios.tenant', true) AND subject = current_setting('aios.subject', true));
REVOKE ALL ON aios_user_memory FROM PUBLIC, aios_api, aios_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON aios_user_memory TO aios_api;

ALTER TABLE aios_user_memory_staging ENABLE ROW LEVEL SECURITY;
ALTER TABLE aios_user_memory_staging FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aios_user_memory_staging_subject ON aios_user_memory_staging;
CREATE POLICY aios_user_memory_staging_subject ON aios_user_memory_staging TO aios_api
    USING (tenant = current_setting('aios.tenant', true) AND subject = current_setting('aios.subject', true))
    WITH CHECK (tenant = current_setting('aios.tenant', true) AND subject = current_setting('aios.subject', true));
REVOKE ALL ON aios_user_memory_staging FROM PUBLIC, aios_api, aios_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON aios_user_memory_staging TO aios_api;

-- Enterprise hardening: budget reservations, durable events, external outbox, and provider policy (0013).
ALTER TABLE aios_budget_reservation ENABLE ROW LEVEL SECURITY;
ALTER TABLE aios_budget_reservation FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aios_budget_reservation_tenant ON aios_budget_reservation;
CREATE POLICY aios_budget_reservation_tenant ON aios_budget_reservation TO aios_api
    USING (tenant = current_setting('aios.tenant', true))
    WITH CHECK (tenant = current_setting('aios.tenant', true));
REVOKE ALL ON aios_budget_reservation FROM PUBLIC, aios_api, aios_worker;
GRANT SELECT, INSERT, UPDATE ON aios_budget_reservation TO aios_api;

ALTER TABLE aios_durable_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE aios_durable_event FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aios_durable_event_select ON aios_durable_event;
DROP POLICY IF EXISTS aios_durable_event_insert ON aios_durable_event;
CREATE POLICY aios_durable_event_select ON aios_durable_event FOR SELECT TO aios_api
    USING (tenant = current_setting('aios.tenant', true));
CREATE POLICY aios_durable_event_insert ON aios_durable_event FOR INSERT TO aios_api, aios_worker
    WITH CHECK (tenant = current_setting('aios.tenant', true));
REVOKE ALL ON aios_durable_event FROM PUBLIC, aios_api, aios_worker;
GRANT SELECT, INSERT ON aios_durable_event TO aios_api;
GRANT INSERT ON aios_durable_event TO aios_worker;

ALTER TABLE aios_external_action_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE aios_external_action_outbox FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aios_external_outbox_tenant ON aios_external_action_outbox;
CREATE POLICY aios_external_outbox_tenant ON aios_external_action_outbox TO aios_api, aios_worker
    USING (tenant = current_setting('aios.tenant', true))
    WITH CHECK (tenant = current_setting('aios.tenant', true));
REVOKE ALL ON aios_external_action_outbox FROM PUBLIC, aios_api, aios_worker;
GRANT SELECT, INSERT ON aios_external_action_outbox TO aios_api;
GRANT UPDATE (state, external_id, result_json, attempt, lease_until, updated_at) ON aios_external_action_outbox TO aios_api;
GRANT SELECT ON aios_external_action_outbox TO aios_worker;
GRANT UPDATE (state, external_id, result_json, attempt, lease_until, updated_at) ON aios_external_action_outbox TO aios_worker;

ALTER TABLE aios_tenant_provider_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE aios_tenant_provider_policy FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS aios_tenant_provider_policy_tenant ON aios_tenant_provider_policy;
CREATE POLICY aios_tenant_provider_policy_tenant ON aios_tenant_provider_policy TO aios_api
    USING (tenant = current_setting('aios.tenant', true))
    WITH CHECK (tenant = current_setting('aios.tenant', true));
REVOKE ALL ON aios_tenant_provider_policy FROM PUBLIC, aios_api, aios_worker;
GRANT SELECT, INSERT, UPDATE ON aios_tenant_provider_policy TO aios_api;
