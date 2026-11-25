CREATE TABLE IF NOT EXISTS aios_budget_reservation (
    tenant TEXT NOT NULL,
    id TEXT NOT NULL,
    subject TEXT NOT NULL,
    role TEXT NOT NULL,
    day_key TEXT NOT NULL,
    reserved_micro_usd BIGINT NOT NULL DEFAULT 0 CHECK (reserved_micro_usd >= 0),
    actual_micro_usd BIGINT NOT NULL DEFAULT 0 CHECK (actual_micro_usd >= 0),
    reserved_tokens BIGINT NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0),
    actual_tokens BIGINT NOT NULL DEFAULT 0 CHECK (actual_tokens >= 0),
    status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'settled', 'released')),
    expires_at DOUBLE PRECISION NOT NULL,
    created_at DOUBLE PRECISION NOT NULL,
    settled_at DOUBLE PRECISION,
    PRIMARY KEY (tenant, id)
);
CREATE INDEX IF NOT EXISTS aios_budget_reservation_active
    ON aios_budget_reservation(tenant, day_key, status, expires_at);

CREATE TABLE IF NOT EXISTS aios_durable_event (
    tenant TEXT NOT NULL,
    seq INTEGER NOT NULL,
    id TEXT NOT NULL,
    subjects_json TEXT NOT NULL,
    include_admins INTEGER NOT NULL DEFAULT 0 CHECK (include_admins IN (0, 1)),
    event_kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (tenant, seq),
    UNIQUE (tenant, id)
);
CREATE INDEX IF NOT EXISTS aios_durable_event_recent
    ON aios_durable_event(tenant, created_at DESC, seq DESC);

CREATE TABLE IF NOT EXISTS aios_external_action_outbox (
    tenant TEXT NOT NULL,
    id TEXT NOT NULL,
    subject TEXT NOT NULL,
    action_kind TEXT NOT NULL CHECK (action_kind IN ('email.send', 'zoom.book')),
    client_id TEXT NOT NULL,
    request_sha256 TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('RESERVED', 'DISPATCHING', 'SUCCEEDED', 'FAILED', 'UNKNOWN')),
    external_id TEXT,
    result_json TEXT,
    attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
    lease_until DOUBLE PRECISION NOT NULL,
    created_at DOUBLE PRECISION NOT NULL,
    updated_at DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (tenant, id),
    UNIQUE (tenant, subject, action_kind, client_id)
);
CREATE INDEX IF NOT EXISTS aios_external_outbox_state
    ON aios_external_action_outbox(tenant, state, updated_at DESC);

CREATE TABLE IF NOT EXISTS aios_tenant_provider_policy (
    tenant TEXT PRIMARY KEY,
    allowed_providers_json TEXT NOT NULL,
    allowed_regions_json TEXT NOT NULL,
    blocked_data_classes_json TEXT NOT NULL,
    allow_failover INTEGER NOT NULL DEFAULT 1 CHECK (allow_failover IN (0, 1)),
    max_tier TEXT NOT NULL DEFAULT 'T3' CHECK (max_tier IN ('T0', 'T1', 'T2', 'T3')),
    pricing_version TEXT NOT NULL DEFAULT '2026-11-official',
    updated_by TEXT NOT NULL,
    updated_at DOUBLE PRECISION NOT NULL
);
