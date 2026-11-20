CREATE TABLE IF NOT EXISTS aios_intake (
    tenant TEXT NOT NULL,
    id TEXT NOT NULL,
    warehouse TEXT NOT NULL,
    document TEXT NOT NULL,
    PRIMARY KEY (tenant, id)
);

CREATE TABLE IF NOT EXISTS aios_proposal (
    tenant TEXT NOT NULL,
    id TEXT NOT NULL,
    warehouse TEXT NOT NULL,
    requester TEXT NOT NULL,
    approver TEXT,
    digest TEXT NOT NULL,
    plan TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN (
        'PROPOSED', 'QUEUED', 'SENDING', 'VERIFYING', 'OUTCOME_UNKNOWN',
        'CHECKING', 'VERIFIED', 'REJECTED', 'NEEDS_OPERATOR'
    )),
    epoch INTEGER NOT NULL DEFAULT 0,
    checks INTEGER NOT NULL DEFAULT 0,
    due DOUBLE PRECISION NOT NULL,
    expires DOUBLE PRECISION NOT NULL,
    receipt TEXT,
    PRIMARY KEY (tenant, id)
);
CREATE INDEX IF NOT EXISTS aios_proposal_due ON aios_proposal(tenant, state, due, id);

CREATE TABLE IF NOT EXISTS aios_audit (
    tenant TEXT NOT NULL,
    id TEXT NOT NULL,
    subject TEXT NOT NULL,
    target TEXT NOT NULL,
    event TEXT NOT NULL,
    at DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (tenant, id)
);
CREATE INDEX IF NOT EXISTS aios_audit_target ON aios_audit(tenant, target, at);
