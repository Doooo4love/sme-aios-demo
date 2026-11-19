# Pitch operator guide

## What to say while the demo runs

> A wholesale team receives purchase orders in different forms. The expensive work is often deciding which product and package the customer meant. Here the order clerk sees the exact OCR region, the disputed reading, and the multiplication that takes two cases to 48 units. After approval, the ERP write survives a lost reply and we can show which draft the system actually verified.

- **Start with evidence.** Show one field's bounding box on the input. The source is synthetic, but OCR and its coordinates are produced during the run. Open the [raw fixture](../fixtures/harbour-review.png) if someone asks to check the source.
- **Make the reviewer decision tangible.** Scripted Vision A returns 8 for the original quantity 2. Scripted Vision B agrees with OCR. The sketch routes to a human rather than allowing a majority vote to write a business value. A reviewer who selects 8 still fails the unit-price × quantity rule. The confirmed 2 becomes 48 units through a catalog mapping.
- **Finish with resilience.** Approval stores an exact-payload digest and queues the command in one database transaction. The worker commits to the mock ERP and deliberately raises a timeout. The next worker step performs a read-back and recovers the existing draft; a valid reply is never required for the system to discover the side effect.

## Reproduce the supporting visuals

Run `python scripts/run_demo.py` for machine-readable evidence. It executes Tesseract, routing, the review branch, dispatch and read-back locally with temporary databases. `python scripts/render_run_evidence.py` recreates the evidence cards from that run (requires DejaVu installed at the paths referenced by the script).

To capture the actual workbench, run the API with a fresh state directory, install `requirements-test.txt` and run `python -m playwright install chromium`. Then run `python scripts/capture_demo.py`. The script checks the standard route, the conflict and invalid override, the approved queue, the timeout and the final read-back, and saves three screenshots. Set `CHROMIUM_BIN` to use a local Chromium or `AIOS_CAPTURE_DIR` to select the output directory. The GitHub Actions workflow uploads the same screenshots as an artifact.

## Implementation boundaries

- **PostgreSQL.** Install `requirements-postgres.txt`, set `AIOS_POSTGRES_DSN` to a fresh database and run the API and worker against the same state directory. The schema is in [sql/schema.sql](../sql/schema.sql). The queue tests can also use a **disposable** PostgreSQL database via `AIOS_TEST_POSTGRES_DSN`. Those tests delete and recreate their schema. A lease only fences local results. Once dispatch is reserved and a worker vanishes, recovery reads the ERP, then escalates if the result stays unknown.
- **Vision.** The fixture adapter is the pitch default and uses no network. An opt-in adapter accepts `AIOS_ENABLE_LIVE_VISION=1` and the server-side variables `VISION_BASE_URL`, `VISION_MODEL`, `VISION_API_KEY`. A second model supports corresponding `VISION_B_*` variables. The application sends image crops and the field type, and accepts only a strict value response. A provider has to support the compatible vision request, JSON output, and the customer's data policy. Test it on the synthetic fixture first. There is no claimed provider benchmark.
- **Production.** Add verified tenant identity, scopes and separation of duties, durable evidence storage, production document sandboxing and API quotas. Test the customer's ERP actually supports a unique external business reference, draft-only credentials, post-write lookup, and atomic version checks for modifications. Profile multilingual formats and reviewed error/coverage on historical and held-out customer data.
- **Business key.** This demo uses legal entity, buyer, and buyer PO number. A conflicting new digest raises a revision error. Customer-specific numbering rules and revisions need an explicit production policy.
