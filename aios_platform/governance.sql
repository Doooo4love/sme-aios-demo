CREATE TABLE IF NOT EXISTS aios_prompt_policy (
    tenant TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    title TEXT NOT NULL,
    directive TEXT NOT NULL,
    guardrail_rules TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    updated_at DOUBLE PRECISION NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    PRIMARY KEY (tenant, scope_key)
);

CREATE TABLE IF NOT EXISTS aios_security_event (
    tenant TEXT NOT NULL,
    id TEXT NOT NULL,
    subject TEXT NOT NULL,
    role TEXT NOT NULL,
    category TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('info', 'medium', 'high', 'critical')),
    module TEXT,
    action_attempted TEXT,
    decision TEXT NOT NULL CHECK (decision IN ('blocked', 'denied', 'flagged', 'escalated')),
    summary TEXT NOT NULL,
    input_sha256 TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
    resolved_by TEXT,
    resolved_at DOUBLE PRECISION,
    resolution_note TEXT,
    created_at DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (tenant, id)
);
CREATE INDEX IF NOT EXISTS aios_security_event_page
    ON aios_security_event(tenant, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS aios_security_event_filter
    ON aios_security_event(tenant, status, severity, created_at DESC);

CREATE TABLE IF NOT EXISTS aios_email_outbox (
    tenant TEXT NOT NULL,
    id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    sender_subject TEXT NOT NULL,
    recipients_json TEXT NOT NULL,
    cc_json TEXT NOT NULL,
    subject_line TEXT NOT NULL,
    body_preview TEXT NOT NULL,
    body_sha256 TEXT NOT NULL,
    transport_mode TEXT NOT NULL,
    message_id TEXT NOT NULL,
    delivery_status TEXT NOT NULL,
    created_at DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (tenant, id),
    UNIQUE (tenant, sender_subject, client_id)
);
CREATE INDEX IF NOT EXISTS aios_email_outbox_sender
    ON aios_email_outbox(tenant, sender_subject, created_at DESC, id DESC);
