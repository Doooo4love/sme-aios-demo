CREATE TABLE IF NOT EXISTS aios_assurance_head (
    tenant TEXT PRIMARY KEY,
    tip_seq BIGINT NOT NULL CHECK (tip_seq >= 0),
    tip_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS aios_assurance_audit (
    tenant TEXT NOT NULL,
    seq BIGINT NOT NULL CHECK (seq > 0),
    envelope TEXT NOT NULL,
    digest TEXT NOT NULL,
    signature TEXT NOT NULL,
    PRIMARY KEY (tenant, seq)
);

CREATE TABLE IF NOT EXISTS aios_assurance_review (
    tenant TEXT NOT NULL,
    id TEXT NOT NULL,
    case_id TEXT NOT NULL,
    site TEXT NOT NULL,
    requester TEXT NOT NULL,
    binding TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('PENDING', 'HELD', 'APPROVED', 'REJECTED')),
    report TEXT NOT NULL,
    decisions TEXT NOT NULL,
    PRIMARY KEY (tenant, id)
);
CREATE INDEX IF NOT EXISTS aios_assurance_case_history ON aios_assurance_review (tenant, case_id, site, id);
