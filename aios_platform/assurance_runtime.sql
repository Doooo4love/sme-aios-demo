CREATE TABLE IF NOT EXISTS aios_assurance_attempt (
    tenant TEXT NOT NULL,
    id TEXT NOT NULL,
    binding TEXT NOT NULL,
    run_id TEXT NOT NULL,
    started_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('RUNNING', 'RETRYABLE', 'FAILED', 'COMPLETE')),
    PRIMARY KEY (tenant, id)
);
