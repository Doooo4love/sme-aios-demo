# Research Synthesis: Cyberport CCMF (Feb 2027 Intake) & Enterprise B2B Pitch Architecture

> **Purpose**: Authoritative evidence and structural brief backing `docs/pitch/ccmf_feb2027_pitch_spec.md` for **Theodic (`Theodic Limited`, proposed pre-incorporation)** — Cyberport Creative Micro Fund (CCMF) Hong Kong Programme, February 2027 Intake.
> **Brand Philosophy & Tagline**: *"Connecting intelligence with the way industries work."* — Two Independent Worlds (HK trade/ERP workflows vs AI) interlocked through a Governed Intersection for Continuous Transformation without core system replacement.
> **Evidence Discipline**: Every figure below is tagged as `[OFFICIAL]`, `[VERIFIED CODE]`, `[VENDOR CLAIM]`, or `[MODELED SCENARIO]`. Unverified projections are never presented as realized customer traction.

---

## 1. Cyberport CCMF Vetting Rubric, Compliance & Timeline Nuances

### 1.1 Intake Schedule & Explicit Timeline Alignment
- **Intake**: Cyberport Creative Micro Fund (CCMF) — Hong Kong Programme, **February 2027 Intake**.
- **Deadlines**:
  - HKUST Entrepreneurship Center (EC) Fast-Track Nomination Form: **22 November 2026 (23:59 HKT)** (`https://ec.hkust.edu.hk/events/application-ccmf-and-cip-feb-2027-intake-cyberport-entrepreneurship-programme-information`). Note: EC nomination does not replace online submission in Cyberport EMS.
  - Official Cyberport EMS Application Deadline: **1 December 2026**.
  - Assessment & Result Window: Vetting in **January 2027**; results announced **February 2027**.
- **Project Timeline Rule** (aligned with intake cadence starting the month after application deadline):
  - **Month 1 = January 2027** through **Month 6 = June 2027**.
  - **Mandatory 3-Month Commercial Launch Preference**: Under *Business Model & Time to Market (30%)*, Cyberport explicitly prefers projects that launch a commercial product within **3 months** (`<= 90 days`, i.e., **Month 3 = March 2027**).

### 1.2 Vetting Rubric Weightings & Scoring Strategy
| Vetting Dimension | Weight | What Cyberport Panels Penalize | How Theodic Scores High | Primary Slide(s) |
|---|---|---|---|---|
| **Creativity & Innovation** | **30%** | "Wrapper" apps stitching ChatGPT/n8n/Odoo without defensible IP; violating **§9.1.4 Originality** ("original creator; product not already available anywhere in the world") or **§9.1.5 IP warranty**. | Built-from-scratch governed control-plane architecture (`aios_platform` + `aios_demo`): 0-VLM clean-PO routing, cell-level policy intersection `[Role ∩ RLS ∩ Model Allowlist]`, 16 KiB enum firewall, AES-GCM/Ed25519 signed ledger, epoch-fenced outbox read-back. | Slide 05 (+ Slide 04) |
| **Business Model & Time to Market** | **30%** | Inflated top-down TAM (`357,965 × fee`), vague SaaS pricing, >6-month launch delays, ignoring existing native tools (Odoo 20, Zoho, Excel). | Explicit **March 2027 (M3, <=90 days)** commercial launch; phased **D-V-P-G-M** (`HK$15k–39k` bounded onboarding/pilot + `HK$4,000/mo` SaaS); honest three-ledger buyer cash math (`HK$40,390` Yr-1 net cash, M10 payback @ 1,800 cases/mo, `62.5%` vendor recurring contribution margin). | Slide 06 (+ Slides 03, 07) |
| **Project Management Team** | **30%** | Idea-only student teams with unbuilt slides, missing technical execution proof, or vague "everyone is co-CEO" roles. | 4-founder HKUST team has **already shipped an L2 live MVP prior to funding** (`36 Python backend modules`, `119 TS/TSX frontend files`, `26/26 Playwright E2E`, live HK cloud + Cloudflare Edge demo). Explicit role/ownership structure on Slide 8. | Slide 08 (+ Slide 09, 10, 13) |
| **Social Responsibility** | **10%** | Generic ESG slogans ("AI saves the planet") disconnected from the product. | Tangible HK SME benefits: clerical augmentation without displacement (`zh-HK`/`zh-CN`/`en`), open-source **Apache-2.0 `Ed25519 AI Audit Verifier`** & **CC BY 4.0 Bilingual PO Benchmark** for HK SMEs, paperless evidence trails, HK PCPD PDPO compliance. | Slide 11 |

### 1.3 Grant Quantum, Tranches, Eligible Spend & Compliance Rules
- **Grant Quantum**: **HK$100,000** non-dilutive cash seed grant over 6 months (Guide §8, Rev. 8 effective 26 Mar 2026).
- **Tranche Disbursement**:
  - **10% (HK$10,000)**: Upon agreement signing (Month 1, Jan 2027).
  - **45% (HK$45,000)**: Upon Mid-Term Report & deliverable approval (Month 3, Mar 2027).
  - **45% (HK$45,000)**: Upon Final Report & deliverable approval (Month 6, Jun 2027).
  - *Cash-flow implication*: Disbursement can take up to 60 days post-approval; budget and M3 commercial pilot revenue (`D-V-P`) must bridge working capital cleanly without founder payroll burn.
- **Eligible Spend Categories**: Direct product development/engineering, security/compliance verification, benchmark/training assets, cloud/API/hosting ops, Hong Kong statutory incorporation (`CR + BR`), and targeted user/pilot GTM.
- **Company Status**: Applicant entity **Theodic** (planned **Theodic Limited**, proposed pre-incorporation) — not yet registered; planned Hong Kong Private Limited Company incorporated upon grant award/launch (`CR e-filing HK$1,545 + 1-yr BR HK$2,350 = HK$3,895` per 2026–27 IRD/CR fee schedule, budgeted at `HK$4,000`).
- **Fundraising & No Double Subsidies Disclosure**: Must declare all funding/grants in the **past 18 months** (`May 2025 – Nov 2026: None / HK$0`) and **next 18 months** (`Jan 2027 – May 2028: None applied/committed during CCMF window`), confirming zero overlap with HKSTP Ideation, HKDC, or other public seed subsidies. Post-CCMF graduation target: Cyberport Incubation Programme (CIP) in H2 2027.

---

## 2. High-Density B2B SaaS & Enterprise Pitch Design Standards

1. **McKinsey Pyramid Principle & Action Titles**:
   - Every slide title is a **declarative, single-sentence takeaway** stating the conclusion backed by the cards below—never a passive topic label like *"Market Size"* or *"Business Model"*.
   - Reading the 13 slide titles sequentially yields the complete investment and grant memo.
2. **Sequoia Pacing Mapped to Grant Rubric**:
   - Cover -> Executive Thesis -> Pain & Market Frame -> Live Solution/MVP -> Technical Innovation (`30%`) -> Business Model & 90-Day Launch (`30%`) -> Competitive Wedge -> Team (`30%`) -> 6-Month Execution Milestones -> HK$100k Budget -> Social Responsibility (`10%`) -> Compliance Disclosure -> Live Judge Sandbox Appendix.
3. **Theodic V2 Swiss Editorial × Warm Museum Alabaster Visual System**:
   - Unifies the Theodic interlocking-arch identity (`#171717` Carbon on `#FAF8F5` Warm Museum Alabaster, preserving the smooth `#999795` silver intersection fold; zero generic AI brains/circuits/robots) across **all 14 slides** without jarring dark/light theme flips:
   - **Unified Paper Surface (`01`–`14`)**: `#FAF8F5` Warm Museum Alabaster canvas (Slide 01 uses full-bleed `cover_editorial_bg.png` feathered toward `#FAF8F5` on the left ~46%); flat unbordered `#F1ECE4` limestone fill allowed at most once per slide for structural anchor strips.
   - **Ink & Hairline Restraint**: `#171717` Primary Carbon, `#4A4640` Body Charcoal, `#857F76` Muted Kicker/Folio, `#DCD5CB` `0.5pt` straight hairline dividers (`1.5pt` `#171717` rules for formal accounting tables), and **ONE accent `#1B4F9C` Deep Ink Cobalt** (`≤5%` area on focal data points). Zero green/amber/red rainbow accents.
   - **Typography Pairing**: `Georgia` for declarative McKinsey action headlines (`23–25pt`, Cover `34pt`) and top-ruled KPI numerals (`36–44pt`); `Avenir Next` (`Regular` / `Demi Bold`) for body (`11.5–13pt`, `1.32×` line height), tracked uppercase section rails (`8.5pt`), and tables. Zero `Menlo` monospace on Slides `01`–`12` & `14` (reserved strictly for the live reviewer URL & passcode on `Slide 13`).
   - **Typographic Operators**: Proper Unicode `→`, `≤`, `≥`, `≠`, `–`, `×` everywhere—zero raw ASCII `->`, `<=`, `>=`, `!=`.

---

## 4. V2 De-AI-ification & Executive Editorial Standards (McKinsey / Pentagram / Sequoia)

1. **Eliminate "AI-Template" Tropes**:
   - **Zero Bento Grids (`0` `ROUNDED_RECTANGLE` shapes)**: Replace uniform rounded-rectangle card cages with frameless asymmetric typographic columns separated by `0.5pt` straight hairline dividers and `≥35%` open `#FAF8F5` whitespace.
   - **Zero Capsule Pills & Vertical Bars**: Strip all floating rounded badges (`30% WEIGHTING`, `NEXT.JS BFF`) and thick left accent bars (`|`); communicate hierarchy through `8.5pt–10.0pt` tracked uppercase kickers and `Georgia` vs `Avenir Next` scale contrast.
   - **Zero Fake Browser Chrome**: Present real product verification via tightly cropped, high-legibility UI screenshots (`ui_po_conflict_zoom.png`, `ui_agent_lookup_zoom.png`, `ui_receipt_stepper_zoom.png`) bordered only by a crisp `1px` `#D8D1C7` hairline and soft ambient drop shadow.
2. **Narrative Flow & Citation Hygiene (`12 Core + 2 Appendix = 14 Slides`)**:
   - **Zero Source Footers on Core Slides (`01`–`12`)**: Core slides show only subtle right-aligned folio numbers (`02` .. `12`). All statistical definitions, competitor documentation references, modeled boundaries, and repository CI proofs consolidate into **Slide 14 (`Appendix B`)** for rapid verification without cluttering executive storytelling.
3. **Chart Restraint**:
   - Render all 4 data visualizations at `300 DPI` directly on `#FAF8F5` paper using `Avenir Next` labels, `#171717` carbon primary bars, `#7A746B` warm stone secondary fills, `#CFC8BE` sand comparison fills, and `#1B4F9C` Deep Ink Cobalt solely for Theodic's target wedge/milestone/net-cash highlight.

---

## 5. V3 Refinements: Cross-Sector HK SME Positioning & Fund-Agnostic Deck Portability

1. **Broaden Wedge from Wholesale-Only to Cross-Sector Hong Kong SMEs**:
   - While bilingual PO-to-ERP draft intake is the live initial module, `aios_platform/` already enforces policies across purchase orders (`PO-100`), billing/invoices (`INV-100`), shipments (`SHP-1001`), incoming quality (`QA-200`), and contracts (`CT-300`).
   - Verified cross-sector Hong Kong official frame (without conflating TID vs C&SD statistical units):
     - **Total HK SMEs (TID Jun 2026)**: `357,965` SMEs (`>98%` of all HK enterprises; services account for `93.6%` of 2024 GDP).
     - **Document-Heavy Trade & Logistics Core (TID Jun 2026)**: `92,307` distinct SMEs (`83,759` Import/Export & Wholesale + `8,548` Transport, Storage, Postal & Courier).
     - **Operating `10–49` Staff B2B Tier (C&SD 2024 ASEA)**: `8,202` reporting companies (`6,680` Import/Export + `946` Wholesale + `576` Other Transport Support; plus `146` warehousing and `89` courier units).
     - **Economy-Wide System & Wage Baseline (C&SD 2025/2026)**: `94.0%` of `320,710` computer-using firms operate without full ERP (`6.0%` ERP vs `45.5%` accounting vs `26.7%` supply chain); cross-sector clerical support median hourly wage `HK$72.4/hr` (`HK$72.3/hr` wholesale `<50`), with June 2026 monthly averages `HK$18,782` (general office), `HK$18,433` (warehouse/purchasing), `HK$20,312` (shipping/doc), and `HK$21,226` (accounting).
2. **Fund-Agnostic Portability & Accurate Channel Claims**:
   - Strip grant-specific names (`CCMF`, `Cyberport`, `CIP`) and calendar-specific intake months from the master deck so the same executive narrative works across seed funds, incubators, and angel evaluations (`Month 1`–`Month 6`, `M3 ≤ 90d` launch, `Seed Grant Track · HK$100,000`, passcode prefix `THEODIC-DEMO-`).
   - Replace `founder` / `founders` with `member` / `members` across all slides to reflect an academic team structure cleanly.
   - Remove unverified `"Odoo/Xero partners"` claims (no formal vendor partner listing exists per §6.5); state accurately that Theodic co-exists via API/CSV bridges alongside Xero, ABSS, Odoo, ERPNext, or Excel and enters via member-led paid workflow diagnostics and HKTDC/HKPC clinics.
3. **Typography Upscaling & Structural Polish**:
   - Keep Slide 05 as a clean `2×2` crosshair grid without the bottom limestone band; move the `PROJECT MEMBERS' COMPLIANCE DECLARATION` from Slide 12 to the bottom of Slide 14 (`Appendix B`); increase core body copy to `12.6–13.6pt`, tables to `11.2–12.4pt`, and Appendix A/B text to `≥8.5–10.0pt`.
4. **Zero "AI-Slop" & Strict Honesty**:
   - Banned words: *revolutionize, seamless, seamlessly, game-changing, unlock, delve, cutting-edge, empower, empowering, leverage, synergy, transformative, holistic, next-gen, reimagine, stream-line/streamline*.
   - Every statistic carries its exact denominator, date, and unit; modeled unit economics are explicitly tagged `Modeled Scenario`.

---

## 3. Verified Quantitative & Codebase Facts (Cross-Checked Against Repo & Primary Sources)

### 3.1 Hong Kong Macro & SME Market Data (`[OFFICIAL]` & `[VENDOR/JOB EVIDENCE]`)
- **HK TID SUCCESS (June 2026)**: `357,965` total HK SMEs; `83,759` Import/Export & Wholesale SMEs (merged BR + industry group count).
- **C&SD 2024 Annual Survey of Economic Activities (ASEA, Table 5.1 & Table 630-76002, published 31 Dec 2025)**:
  - **12,295** HSIC 46 Wholesale reporting companies generating **HK$275,180M (`HK$275.2B`)** business receipts, **HK$13,656M** employee compensation, and **HK$16,528M** operating expenses.
  - Size distribution inside HSIC 46: **11,276** (<10 persons, **91.7%**); **946** (10–49 persons, **7.7%** -> composed of **725** Other Wholesale + **209** Food/Alcohol/Tobacco + **12** Clothing/Footwear); **73** (50+ persons, **0.6%**).
  - Separate HSIC 45 Import/Export 10–49 tier: **6,680** reporting companies (cannot be naively summed with TID counts due to differing statistical unit definitions).
  - Quarterly Survey of Employment & Vacancies (June 2026, Table 215-16003, published 18 Sep 2026): **11,075** HSIC 46 wholesale establishments; **725** "Other Wholesale 10–49" statistical companies serves as the disciplined initial discovery frame (`TAM/SAM` explicitly left uninflated until field qualification).
- **C&SD 2025 Business IT Usage Survey (published 27 Feb 2026, Tables 4.1 & 4.26–4.28, base = 320,710 computer-using companies across all sectors)**:
  - **45.5%** use Accounting/Finance software vs **26.7%** Supply Chain software vs **6.0%** ERP (**4.2%** cloud ERP among cloud users — distinct denominator).
- **HKPC Q1 2026 SME Index (surveyed Nov–Dec 2025, n = 819 SMEs)**:
  - **55%** use or plan to use AI; among current AI users (`distinct denominator`), only **32%** use paid AI tools.
- **Clerical Wages & Channel Evidence**:
  - **C&SD Table 220-19013 (June 2026 avg monthly salary, published 28 Sep 2026)**: Document/Shipping Clerk **HK$20,312/mo**, General Office Clerk **HK$18,782/mo**, Warehouse/Purchasing Clerk **HK$18,433/mo**, Bookkeeper/Accounting Clerk **HK$21,226/mo**.
  - **C&SD 2025 Annual Earnings & Hours Survey (May–Jun 2025 ref, published 23 Mar 2026, Tables 6.15–6.17)**: Wholesale <50 persons median hourly wage **HK$72.3/hr** (IQR **HK$59.5–93.3/hr**); cross-sector clerical support median **HK$72.4/hr** (IQR **HK$59.5–91.3/hr**).
  - **Live HK Distributor Workflow Evidence (`HK_B2B_AI_Full_Report_ZH.pdf`)**: Multi-channel ordering across portals, email, fax, and WhatsApp persists in HK stationery/office & wholesale suppliers (*A.S. Stationery*, *Young Vision*, *Wah Chit*, *Li Tung* serving 300+ retail outlets); HK job ads (*Stationery Lo* on Recruit Sep 2026; *SEABO* billing/shipping clerk) explicitly bundle ERP sales-order entry, returns/cancellations, inventory checks, and transport coordination.

### 3.2 Implemented Codebase Proof (`[VERIFIED CODE]`)
- **Backend Architecture (`36` core Python modules + `8` Alembic migrations + `8` SQL schemas)**:
  - `aios_platform/` (`29` `.py` files, `5,011 LOC`): `api.py`, `assurance.py`, `assurance_policy.py`, `assurance_gateway.py`, `assurance_audit.py`, `assurance_catalog.py`, `database_security.py`, `erp.py`, `workflow.py`, `identity.py`, `module_access.py`, `workbench.py`, `workbench_tools.py`, `workbench_planner.py`, `contracts.py`, `chat.py`, `collaboration.py`, `calendar.py`, `service.py`, `providers.py`, `purchase.py`, `tasks.py`, `browser.py`, `agent_history.py`, `observability.py`, `profile.py`, `run_worker.py`, `workspace_source.py`, `__init__.py`.
  - `aios_demo/` (`7` `.py` files, `1,094 LOC`): `parsing.py`, `routing.py`, `storage.py`, `worker.py`, `extract_po.py`, `api.py`, `__init__.py`.
  - PostgreSQL Hardening: `8` SQL schemas (`hardening.sql`, `assurance.sql`, `assurance_runtime.sql`, etc.) + `8` Alembic versions (`0001`–`0008`), verified at startup by `database_security.verify_database()` across **23 forced-RLS tables** with separated `aios_api` (no `receipt` update, no audit read/delete) and `aios_worker` (write-receipt only, zero chat/intake/assurance-audit access) logins.
- **Key Cryptographic & Policy Constants Verified in Source**:
  - `aios_demo/routing.py`: `route_on_demand(..., call_limit=4)`, Tesseract OCR score threshold `>= 80`, pixel crop padding `(±10px, ±8px)`, deterministic catalog conversion (`2 cases -> 48 units` for `SKU-1028`) and arithmetic checks (`ROW_AMOUNT_MISMATCH`, `ORDER_TOTAL_MISMATCH`, `UNKNOWN_PACKAGE`).
  - `aios_platform/assurance_policy.py`: `project(actor, case, audience="model", restrictions=...)` intersects `[Role/Tenant/Site ∩ Employee Grant ∩ Model Allowlist]`; `HARD_HOLDS = {"SUPPLIER_UNAPPROVED", "CERTIFICATE_MISSING", "CRITICAL_DEFECT", "LIABILITY_CAP_MISSING"}`.
  - `aios_platform/assurance_gateway.py`: `MAX_OUTPUT = 16 * 1024` (16 KiB), NFKC normalization + zero-width strip (`Cf`), `SUSPECT` regex prompt-injection shield, `REVIEW_REQUESTS` allowlist, duplicate-key JSON rejection (`unique_object`), closed `FINDINGS` enum validation.
  - `aios_platform/assurance.py`: Requester-cannot-self-approve (`actor.subject == row["requester"] -> 403`), distinct approvers across parallel tracks, `snapshot_digest` staleness lock (`REVIEW_SNAPSHOT_CONFLICT 409`), `IN_FLIGHT_SECONDS = 120`, `review_ttl = 3600`.
  - `aios_platform/assurance_audit.py`: `AESGCM` encrypted envelopes + `SHA-256` hash-chain + `Ed25519` signatures + offline `verify_chain()` CLI.
  - `aios_demo/storage.py` & `aios_platform/erp.py`: `POSTGRES_CLAIM` with `FOR UPDATE SKIP LOCKED` + monotonic `epoch = epoch + 1` lease fencing + `LocalERP`, `OdooERP` (`/json/2/ai.os.gateway/`), `ERPNext` (`/api/method/aios_bridge.api.`).
- **Frontend & Verification**:
  - `web/src/` (`119` `.ts`/`.tsx` files, `52,983 LOC`): Next.js same-origin BFF (`:3000`), native trilingual i18n (`zh-CN` / `zh-HK` / `en`, `LOCALE_COOKIE_NAME = "aios_locale"`), dual-theme Frosted Alabaster / Obsidian Porcelain (`tokens.css`).
  - Testing: **67 Python unittest methods** across 6 test files (`tests/`) + **26/26 Playwright E2E tests** across 7 `.spec.ts` files (`web/e2e/`, documented pass in commit `ea3ff72` / `docs/workbench-frontend.zh-CN.md`).
  - Live Deployment: Cloudflare Worker `aios-demo` -> Workers VPC -> Tunnel `hk-aios-demo` -> Aliyun HK ECS (`127.0.0.1:3000` Next.js + `:8760`/`:8761` FastAPI), fronted by the new 4-layer Edge Cryptographic Reviewer Gate (`deploy/cloudflare-worker/src/reviewer-gate.ts`).

### 3.3 Unit Economics & SOM Model (`HK_wholesale_TAM_SAM_SOM_model(1).xlsx`, `[MODELED SCENARIO]`)
- **Buyer Economics (`Buyer economics` & `C1/C2` sheets)**:
  - Manual baseline: `8.0 min/case` vs AIOS clean PO: `2.0 min/case`; each exception adds `8.0 min`. At **12.5% exception rate** (`e = 0.125`), blended handling time is **`3.0 min/case` -> `5.0 net min/case` saved** (`6 - 8e`).
  - At `1,800` adopted cases/mo, `HK$130/hr` cancellable overtime/outsourcing rate, `HK$56,000` Yr-1 startup (`HK$39k D/V/P + HK$15k G + HK$2k internal`), `HK$4,000/mo` SaaS + `HK$500/mo` buyer cloud (`HK$40,500` over 9 live months, `7.5` mature-equivalent ramp months), and `8 hrs/mo` paid review (`HK$9,360/9 mo`):
    - Mature monthly gross cash released: `HK$19,500/mo` (`7.5` mo = `HK$146,250`).
    - **Yr-1 Buyer Net Cash Gain**: **`+HK$40,390`**; **Payback Month**: **Month 10** (`M9 cumulative = -HK$1,490`, `M10 = +HK$12,470`).
    - 12-month buyer cash breakeven volume: `1,303` adopted cases/mo (`@12.5%` exception) vs `1,629` (`@25%` exception).
    - Sensitivity floor: At `2,000` cases/mo, cancellable labor rate must exceed **`HK$81.92/hr`** (highlighting why targets must have cancellable overtime/outsourcing or capacity bottlenecks, not static fixed payroll at C&SD `HK$72.3/hr` median).
- **Vendor Economics & SOM (`Assumptions`, `Decision`, `SOM monthly` sheets)**:
  - Recurring gross margin per live tenant: `HK$4,000/mo` fee - `HK$500/mo` direct cloud/LLM - `4h × HK$250/hr` (`HK$1,000/mo` in C3 reuse mode) = **`HK$2,500/mo` (`62.5%` contribution margin)**; at `8h/mo` support (`C2`), cash-out-of-pocket margin before founder hours is `HK$3,500/mo` (`87.5%`), economic contribution `HK$1,500/mo`.
  - **36-Month Capacity-Constrained SOM Scenarios** (3 active contributors, `HK$4,000/mo` ARR/account, excluding one-time D-V-P-G fees):
    - **C1 Constrained (`10h/wk`)**: M12 `0.67` accts | M24 `2.03` | M36 **`3.10` accts -> `HK$149k` Exit ARR**.
    - **C2 Reference (`20h/wk`, `8h` support)**: M12 `2.34` accts | M24 `6.62` | M36 **`10.41` accts -> `HK$500k` Exit ARR** (exact `HK$499,775`, plus `HK$306k` Yr-3 one-time fees = `HK$724k` Yr-3 scheduled billings).
    - **C3 Validated Reuse (`20h/wk`, `4h` support, `8` leads/mo)**: M12 `6.21` accts | M24 `16.35` | M36 **`24.29` accts -> `HK$1,166k` (`HK$1.17M`) Exit ARR**.
