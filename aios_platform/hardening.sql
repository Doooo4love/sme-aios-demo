CREATE TABLE IF NOT EXISTS aios_request_key (
    tenant TEXT NOT NULL,
    subject TEXT NOT NULL,
    request_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    proposal_id TEXT NOT NULL,
    PRIMARY KEY (tenant, subject, request_key),
    FOREIGN KEY (tenant, proposal_id) REFERENCES aios_proposal(tenant, id)
        DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS aios_write_control (
    tenant TEXT PRIMARY KEY,
    paused INTEGER NOT NULL CHECK (paused IN (0, 1))
);

CREATE TABLE IF NOT EXISTS aios_suspension (
    tenant TEXT NOT NULL,
    subject TEXT NOT NULL,
    suspended INTEGER NOT NULL CHECK (suspended IN (0, 1)),
    PRIMARY KEY (tenant, subject)
);

CREATE TABLE IF NOT EXISTS aios_planner_budget (
    tenant TEXT PRIMARY KEY,
    window_id BIGINT NOT NULL,
    calls INTEGER NOT NULL CHECK (calls >= 1)
);
