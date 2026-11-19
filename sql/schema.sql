CREATE TABLE IF NOT EXISTS command (
    id TEXT PRIMARY KEY,
    business_key TEXT NOT NULL UNIQUE,
    payload TEXT NOT NULL,
    digest TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
        'QUEUED', 'SENDING', 'VERIFYING', 'OUTCOME_UNKNOWN', 'COMMITTED', 'NEEDS_OPERATOR'
    )),
    approved_by TEXT NOT NULL,
    review TEXT NOT NULL,
    simulate_timeout INTEGER NOT NULL CHECK (simulate_timeout IN (0, 1)),
    erp_id TEXT,
    created_at DOUBLE PRECISION NOT NULL
);
CREATE TABLE IF NOT EXISTS job (
    id TEXT PRIMARY KEY,
    command_id TEXT NOT NULL REFERENCES command(id),
    kind TEXT NOT NULL CHECK (kind IN ('DISPATCH', 'RECONCILE')),
    state TEXT NOT NULL CHECK (state IN ('READY', 'LEASED', 'DONE')),
    available_at DOUBLE PRECISION NOT NULL,
    owner TEXT,
    lease_until DOUBLE PRECISION,
    epoch INTEGER NOT NULL DEFAULT 0,
    UNIQUE (command_id, kind)
);
CREATE INDEX IF NOT EXISTS job_ready ON job(state, available_at, id);
CREATE INDEX IF NOT EXISTS job_expired ON job(state, lease_until);
CREATE TABLE IF NOT EXISTS journal (
    id TEXT PRIMARY KEY,
    command_id TEXT NOT NULL REFERENCES command(id),
    event TEXT NOT NULL,
    note TEXT NOT NULL,
    at DOUBLE PRECISION NOT NULL
);
CREATE INDEX IF NOT EXISTS journal_command ON journal(command_id, at);
