CREATE TABLE IF NOT EXISTS aios_profile (
    tenant TEXT NOT NULL,
    subject TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('employee','agent')),
    display_name TEXT,
    avatar BYTEA,
    version BIGINT NOT NULL CHECK (version > 0),
    PRIMARY KEY (tenant, subject, kind)
);
CREATE TABLE IF NOT EXISTS aios_agent_activity (
    tenant TEXT NOT NULL,
    subject TEXT NOT NULL,
    id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    attempt TEXT NOT NULL,
    started_at DOUBLE PRECISION NOT NULL,
    lease_until DOUBLE PRECISION NOT NULL,
    outcome TEXT,
    reference TEXT,
    PRIMARY KEY (tenant, subject, id)
);
CREATE INDEX IF NOT EXISTS aios_agent_activity_page ON aios_agent_activity(tenant, subject, started_at, id);
CREATE INDEX IF NOT EXISTS aios_proposal_requester ON aios_proposal(tenant, requester, due, id);
CREATE TABLE IF NOT EXISTS aios_proposal_review (
    tenant TEXT NOT NULL,
    proposal_id TEXT NOT NULL,
    assigned_to TEXT,
    decided_by TEXT,
    decision TEXT CHECK (decision IN ('returned','rejected')),
    reason TEXT,
    PRIMARY KEY (tenant, proposal_id),
    FOREIGN KEY (tenant, proposal_id) REFERENCES aios_proposal(tenant, id)
);
CREATE TABLE IF NOT EXISTS aios_calendar_event (
    tenant TEXT NOT NULL,
    id TEXT NOT NULL,
    organizer TEXT NOT NULL,
    title TEXT NOT NULL,
    starts_at DOUBLE PRECISION NOT NULL,
    ends_at DOUBLE PRECISION NOT NULL,
    fingerprint TEXT NOT NULL,
    revision BIGINT NOT NULL CHECK (revision > 0),
    cancelled INTEGER NOT NULL CHECK (cancelled IN (0, 1)),
    PRIMARY KEY (tenant, id),
    CHECK (ends_at > starts_at)
);
CREATE TABLE IF NOT EXISTS aios_calendar_member (
    tenant TEXT NOT NULL,
    event_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    PRIMARY KEY (tenant, event_id, subject),
    FOREIGN KEY (tenant, event_id) REFERENCES aios_calendar_event(tenant, id)
);
CREATE INDEX IF NOT EXISTS aios_calendar_subject ON aios_calendar_member(tenant, subject, event_id);
CREATE INDEX IF NOT EXISTS aios_calendar_time ON aios_calendar_event(tenant, starts_at, id);
CREATE TABLE IF NOT EXISTS aios_internal_notice (
    tenant TEXT NOT NULL,
    subject TEXT NOT NULL,
    id TEXT NOT NULL,
    kind TEXT NOT NULL,
    reference TEXT NOT NULL,
    created_at DOUBLE PRECISION NOT NULL,
    read_at DOUBLE PRECISION,
    PRIMARY KEY (tenant, subject, id)
);
CREATE INDEX IF NOT EXISTS aios_internal_notice_page ON aios_internal_notice(tenant, subject, created_at, id);
CREATE TABLE IF NOT EXISTS aios_browser_session (
    tenant TEXT NOT NULL,
    id TEXT NOT NULL,
    encrypted BYTEA NOT NULL,
    expires_at DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (tenant, id)
);
CREATE INDEX IF NOT EXISTS aios_browser_session_expiry ON aios_browser_session(tenant, expires_at, id);
