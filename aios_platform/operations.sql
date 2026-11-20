CREATE INDEX IF NOT EXISTS aios_proposal_exception_due ON aios_proposal(tenant, due, id)
    WHERE state IN ('NEEDS_OPERATOR', 'OUTCOME_UNKNOWN');
