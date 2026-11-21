CREATE TABLE IF NOT EXISTS aios_employee (
    tenant TEXT NOT NULL,
    subject TEXT NOT NULL,
    PRIMARY KEY (tenant, subject)
);
CREATE TABLE IF NOT EXISTS aios_module_access (
    tenant TEXT NOT NULL,
    subject TEXT NOT NULL,
    module TEXT NOT NULL,
    grants TEXT NOT NULL,
    warehouses TEXT NOT NULL,
    expires_at DOUBLE PRECISION,
    version INTEGER NOT NULL CHECK (version > 0),
    PRIMARY KEY (tenant, subject, module),
    FOREIGN KEY (tenant, subject) REFERENCES aios_employee (tenant, subject)
);
