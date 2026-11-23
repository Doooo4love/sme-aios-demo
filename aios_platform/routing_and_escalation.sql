CREATE TABLE IF NOT EXISTS aios_llm_telemetry (
    tenant TEXT NOT NULL,
    id TEXT NOT NULL,
    subject TEXT NOT NULL,
    role TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    tier TEXT NOT NULL CHECK (tier IN ('T0', 'T1', 'T2', 'T3')),
    reasoning_effort TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
    cache_hit_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_hit_tokens >= 0),
    reasoning_tokens INTEGER NOT NULL DEFAULT 0 CHECK (reasoning_tokens >= 0),
    completion_tokens INTEGER NOT NULL DEFAULT 0 CHECK (completion_tokens >= 0),
    estimated_usd DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (estimated_usd >= 0),
    latency_ms DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (latency_ms >= 0),
    escalated_from_tier TEXT,
    success INTEGER NOT NULL DEFAULT 1 CHECK (success IN (0, 1)),
    error_code TEXT,
    created_at DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (tenant, id)
);
CREATE INDEX IF NOT EXISTS aios_llm_telemetry_window
    ON aios_llm_telemetry(tenant, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS aios_llm_telemetry_subject_day
    ON aios_llm_telemetry(tenant, subject, created_at DESC);

CREATE TABLE IF NOT EXISTS aios_quota_policy (
    tenant TEXT NOT NULL,
    scope_type TEXT NOT NULL CHECK (scope_type IN ('tenant', 'role', 'subject')),
    scope_key TEXT NOT NULL,
    daily_usd_limit DOUBLE PRECISION CHECK (daily_usd_limit IS NULL OR daily_usd_limit >= 0),
    daily_token_limit BIGINT CHECK (daily_token_limit IS NULL OR daily_token_limit >= 0),
    updated_by TEXT NOT NULL,
    updated_at DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (tenant, scope_type, scope_key)
);

CREATE TABLE IF NOT EXISTS aios_agent_session_state (
    tenant TEXT NOT NULL,
    subject TEXT NOT NULL,
    session_id TEXT NOT NULL,
    rolling_summary TEXT NOT NULL DEFAULT '',
    active_doc_id TEXT,
    active_doc_title TEXT,
    active_doc_summary TEXT,
    active_doc_tokens INTEGER NOT NULL DEFAULT 0 CHECK (active_doc_tokens >= 0),
    last_turn_at DOUBLE PRECISION NOT NULL,
    compacted_at DOUBLE PRECISION,
    PRIMARY KEY (tenant, subject, session_id)
);
CREATE INDEX IF NOT EXISTS aios_agent_session_recent
    ON aios_agent_session_state(tenant, subject, last_turn_at DESC);

CREATE TABLE IF NOT EXISTS aios_off_topic_policy (
    tenant TEXT PRIMARY KEY,
    daily_remind_threshold INTEGER NOT NULL DEFAULT 1 CHECK (daily_remind_threshold >= 1),
    daily_escalate_threshold INTEGER NOT NULL DEFAULT 5 CHECK (daily_escalate_threshold >= 1),
    seven_day_escalate_threshold INTEGER NOT NULL DEFAULT 12 CHECK (seven_day_escalate_threshold >= 1),
    daily_local_auto_escalate_threshold INTEGER NOT NULL DEFAULT 2 CHECK (daily_local_auto_escalate_threshold >= 1),
    app_allowlist_json TEXT NOT NULL,
    routing_rules_json TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    updated_at DOUBLE PRECISION NOT NULL
);
