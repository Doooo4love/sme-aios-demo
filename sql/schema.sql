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

CREATE TABLE IF NOT EXISTS intake_document (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    evidence TEXT NOT NULL,
    source_png BYTEA NOT NULL,
    created_at DOUBLE PRECISION NOT NULL,
    preview TEXT,
    command_id TEXT REFERENCES command(id)
);
CREATE INDEX IF NOT EXISTS intake_document_recent ON intake_document(created_at DESC, id);

CREATE TABLE IF NOT EXISTS sku_memory (
    buyer TEXT NOT NULL,
    source_sku TEXT NOT NULL,
    erp_sku TEXT NOT NULL,
    units_per_case INTEGER NOT NULL CHECK (units_per_case > 0),
    updated_at REAL NOT NULL,
    PRIMARY KEY (buyer, source_sku)
);
