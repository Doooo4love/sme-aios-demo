CREATE TABLE IF NOT EXISTS aios_user_memory (
    tenant TEXT NOT NULL,
    subject TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    previous_content TEXT,
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    token_count INTEGER NOT NULL DEFAULT 0 CHECK (token_count >= 0),
    updated_by TEXT NOT NULL,
    updated_at DOUBLE PRECISION NOT NULL,
    last_tidy_at DOUBLE PRECISION,
    PRIMARY KEY (tenant, subject)
);
CREATE INDEX IF NOT EXISTS aios_user_memory_tidy_scan
    ON aios_user_memory(tenant, last_tidy_at, updated_at);

CREATE TABLE IF NOT EXISTS aios_user_memory_staging (
    tenant TEXT NOT NULL,
    subject TEXT NOT NULL,
    id TEXT NOT NULL,
    fact_text TEXT NOT NULL,
    section_hint TEXT NOT NULL,
    fact_sha256 TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'merged', 'discarded')),
    created_at DOUBLE PRECISION NOT NULL,
    processed_at DOUBLE PRECISION,
    PRIMARY KEY (tenant, subject, id),
    UNIQUE (tenant, subject, fact_sha256)
);
CREATE INDEX IF NOT EXISTS aios_user_memory_staging_pending
    ON aios_user_memory_staging(tenant, subject, status, created_at);
