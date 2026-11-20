# Wholesale and logistics pilot automation

[简体中文](pilot-automation.zh-CN.md)

## What work moves out of the manual queue

| Task | Current automatic path | Manual decision or pilot evidence |
|---|---|---|
| Enter a structured purchase order | Contract validation, buyer SKU lookup, pack conversion, exact decimal checks, and draft preparation | Confirm partner mappings, freight, discounts, tax and rounding rules |
| Key the same order again | Identical canonical order in the same warehouse reuses its intake. The same submitting account gets the original batch proposal | Confirm external PO numbering, duplicate handling across channels or senders, and revision and cancellation policy in ERP |
| Check a scanned order | Local OCR and field evidence for the supported layout. The workbench can compare disputed crops with an optional vision reader | Supply held-out document layouts. Review missing anchors, OCR disagreement and ambiguous handwriting. Measure false acceptance |
| Release routine drafts | Independent manager can approve up to 50 known proposal digests in one request | Confirm delegation, sampling policy, amount thresholds and which exceptions need a second reviewer |
| Track shipment or change a confirmed date | Scoped lookup. A date change prepares a preview and binds the current ERP version | Obtain WMS and carrier rules for cutoffs, holidays, time zones, capacity, partial shipments and customer notifications |
| Verify whether the ERP wrote the order | Audit, operation ID, and bounded read-back. A scoped queue exposes unresolved cases and receipt mismatch | Confirm customer bridge atomicity and recovery from failure. Resolve authoritative rejections, manual changes or irreconcilable receipts |

These controls target repeated entry, arithmetic checking, approval clicks and routine reconciliation. Production headcount savings require shadow-mode measurements against current operator work.

## API for structured feeds

`POST /v1/intakes/{warehouse}/structured/batch` accepts up to 50 orders and a body up to 64 KiB. Send canonical JSON after mapping CSV, EDI or partner exports. Example.

```json
{"orders":[{"po":"B-100","buyer":"HBR-47","currency":"HKD","delivery":"2027-02-01","total":"50.00","lines":[{"sku":"TEA-24","unit":"CASE","quantity":2,"unit_price":"25.00","amount":"50.00"}]}]}
```

- The API returns one result per zero-based `position`. `status=prepared` includes `intake_id`, `proposal_id`, `digest` and current `state`. It performs no ERP write and calls no LLM. A retry may report the latest state of an already approved or verified proposal.
- `status=review` includes a reason code. `INVALID_ORDER` also supplies up to ten field paths and validation codes. Archive the original source upstream and use the position to correct malformed rows. Validly shaped but unresolved orders are kept as intake records. Correct the source and resubmit. Reusing the same intakes after a master-data fix is also supported.
- Reasons cover missing mappings, unsupported currencies, amount limits, invalid totals, conflicting revisions in one batch and policy failure. Same-content duplicates share an intake and a proposal for the same submitting account. A repeated PO with different content across batches needs customer revision policy and an ERP-side unique external reference. The sandbox enforces that reference at write.
- Domain errors affect only their own items. A database failure rolls back the batch. Resend the same request after recovery. When a new proposal is required after expiration, create a fresh preview through `POST /v1/actions` and obtain a fresh approval. Automatic batch replay preserves the original proposal.

`POST /v1/proposals/approve-batch` accepts `{"proposals":[{"proposal_id":"…","digest":"…"}]}`. The caller reviews each preview first. Every item separately enforces scope, independence, optional OPA and exact digest. It returns per-item 202, 403, 404 or 409. Commits are per item. After a connection loss, retry the same set and use the per-item response to resume. An API 202 means queued or previously accepted. Read final state separately.

## Reconciliation

A manager or admin calls `GET /v1/operations/exceptions?limit=50`. Follow the `next` object as query parameters until it is null. The view shows `OUTCOME_UNKNOWN` and `NEEDS_OPERATOR`, is scoped to assigned warehouses, and may change as work progresses. It includes the most recent relevant audit event.

| Event or failure | Action |
|---|---|
| Ambiguous write or abandoned send lease | Worker checks the receipt without sending a second write |
| `READBACK_LIMIT_REACHED` | Check the ERP service and the external operation ID. An authorized manager may reopen read-only reconciliation |
| `ERP_RECEIPT_MISMATCH` | Investigate the ERP bridge and verify tenant, ID, digest and target before reopening |
| `INVALID_STORED_PLAN` or `PLAN_DIGEST_OR_TENANT_MISMATCH` | Pause new writes if indicated, preserve audit evidence and investigate data or configuration |
| Expired approval, permission revocation, stale shipment version or confirmed ERP rejection | Read the proposal timeline. Obtain a fresh authorized preview if a correction is needed |
| Unknown business flow | Keep the source and route to the designated operator under the customer's approved policy |

The ERP write and receipt contract is mandatory even with an outbox. An electronic order standard such as UBL can represent extra charges, allowances, delivery conditions, changes and cancellations. Confirm the partner's profile before mapping it into this narrower order schema. [OASIS UBL 2.3](https://docs.oasis-open.org/ubl/os-UBL-2.3/UBL-2.3.pdf) · [Transactional outbox guidance](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html)

## Synthetic performance and pilot measurements

Run `python scripts/platform_benchmark.py` after installing `requirements-test.txt`. It runs three trials per path. Each trial sends 250 unique one-line synthetic orders through an in-process API to temporary SQLite stores and verifies all 250 ERP receipts. Batch size is 50.

| Median result on the development host | Single-order path | Batch path |
|---|---:|---:|
| Inbound requests through approval | 750 | 10 |
| Intake, preparation and approval | 1.540 s | 0.169 s |
| Worker dispatch and receipt verification | 0.444 s | 0.510 s |

The local comparison excludes client network, live IdP and OPA, LLM, PostgreSQL and a remote ERP. The batch accelerates intake and approval. The worker still dispatches and verifies each order separately.

For customer sign-off supply a de-identified sample with manually confirmed outcomes, actual buyer SKU and pack metadata, read and write sandbox roles, and representative volumes. Measure exactness by critical field, false accepts, eligible orders with no re-entry, manual minutes per order, duplicate writes, queue age, P95 and cost per verified order. Hold out partners and document layouts when testing OCR or an external model. Record a baseline from the current staff workflow. [Production acceptance](production-readiness.en.md)
