# SME AIOS production hardening and acceptance

[简体中文](production-readiness.md)

The logistics and wholesale reference workflows share execution, independent approvals, identity and ERP integration boundaries.

| Area | Reproducible now | Required before first-customer launch |
|---|---|---|
| Tenant isolation | Forced PostgreSQL RLS with separate API and worker roles. Startup checks ownership and critical grants | Test real Keycloak roles, token lifetime, warehouse mapping and revocation sync. Exercise network isolation and DB incidents |
| Write controls | Approval, restricted worker, tenant write pause, local subject suspension, replay deduplication, lost-response read-back, and read-only rechecks | Run pause and recovery drills with the ERP administrator. Validate atomic permission and version checks, mutation and receipt in the customer sandbox |
| Migrations | Alembic baseline, control tables and indexed exception queue. Existing data and repeated upgrades are covered | Backup/restore, release window, runtime accounts and connector setup |
| Models and documents | Typed intent output, shared per-tenant call budget, body limits and local no-key samples | Provider and egress approval. Measure accuracy, language and layout coverage, latency and spend on Hong Kong customer documents |
| Observability | API request counters and latency, protected metrics, readiness, request ID and audit | SLOs for P95, backlog age, lease recovery and unknown receipts. Measure RTO and RPO with restores |

## Upgrade

Use different identities for migrations and normal operation. Set `AIOS_MIGRATION_DATABASE_URL_FILE` for the migration owner to a file with a SQLAlchemy URL, for example `postgresql://migration_user:...@db.example/aios?sslmode=verify-full`. Migrations create missing tables and indexes and advance the schema revision. Apply migrations and permissions before starting the API and worker.

```bash
python -m pip install -r requirements-platform.txt
python -m alembic upgrade head
python -m alembic current
```

Create dedicated non-owner, non-superuser logins `aios_api` and `aios_worker`. The migration owner applies the [PostgreSQL security script](../deploy/platform/postgres-security.sql). Startup verifies forced RLS, role assignment and separation of audit and receipt permissions. Configure each role's DSN through the corresponding [systemd unit](../deploy/platform/). Tenant context must remain transaction-local. The services open a connection per transaction. If measured connection pressure warrants PgBouncer, verify transaction pool mode and tenant context resets. [Alembic tutorial](https://alembic.sqlalchemy.org/en/latest/tutorial.html) · [PostgreSQL RLS](https://www.postgresql.org/docs/17/ddl-rowsecurity.html)

## Operations and incidents

- Tenant admins set `{"paused":true}` through `PUT /v1/operations/write-control`. New sends stop and existing sends continue read-back. Operations past the final guard may complete. For severe incidents freeze the ERP write identity and reconcile in-flight work.
- Tenant admins suspend a different account at `PUT /v1/operations/subjects/{subject}/suspension`. The worker checks requester and approver before dispatch. Connect the Keycloak lifecycle to this control. Rejected proposals need resubmission and approval after restoration.
- `POST /v1/proposals/{id}/reconcile` lets a scoped manager reopen receipt lookup for `NEEDS_OPERATOR`. Every verification requires matching tenant, operation ID, digest and target. The attempt budget still applies.
- `POST /v1/actions` accepts `Idempotency-Key` for proposals. Use 1–128 ASCII letters, digits or `._:-`. Keys are scoped to tenant and subject. A replay returns the original proposal. Changing the request under the same key returns 409. Retain keys along with audit records.
- `AIOS_PLANNER_CALLS_PER_MINUTE` defaults to 60 per tenant with a shared window. An existing proposal replay skips model calls. Structured bodies are capped at 64 KiB, image bodies at 8 MB and inbound reads at 15 seconds. Configure gateway connection and throughput caps to match measured demand.
- `GET /v1/operations/exceptions` lists pending reconciliation and operator cases in assigned warehouses. See the [pilot automation guide](pilot-automation.md) for batch intake, approval and customer acceptance.

## Signals and tool choices

`/healthz` checks the process and `/readyz` checks database access. `/metrics` requires the dedicated bearer secret configured through `AIOS_METRICS_TOKEN_FILE`. The `aios.platform` logger uses a server-generated request ID. Prometheus labels contain method, route template and status code. Tenant IDs, references, tokens, request text and model output stay out of metrics. Alert on 5xx, 429, P95, queue age, unknown receipts and operator cases. [Prometheus instruments](https://prometheus.github.io/client_python/instrumenting/) · [OpenTelemetry sensitive data](https://opentelemetry.io/docs/security/handling-sensitive-data/)

- **Used now.** Alembic, the Prometheus Python client, OIDC with Keycloak and PostgreSQL. OPA is optional.
- **Use when the deployment warrants it.** pgBackRest for backup and PITR drills, OpenTelemetry Collector for redacted telemetry, OpenBao for centralized rotation, and Temporal for long-running multi-system workflows. ERP transaction and idempotency checks remain required.
- **Acceptance evidence.** CI audits production dependencies for known advisories. Use OWASP ASVS to guide independent security and capacity tests. Before customer data arrives, evidence is based on synthetic records. [OWASP ASVS](https://asvs.owasp.org/) · [pgBackRest](https://pgbackrest.org/user-guide.html) · [Temporal Activities](https://docs.temporal.io/activity-definition)

Customer sign-off covers ERP access and writes, identity revocation, network isolation, retention, alarms and tested restores.
