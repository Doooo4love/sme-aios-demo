# Theodic — Multi-Fund Swiss-Editorial 14-Slide Pitch Specification (V3.2)

> **Deliverables**: `/Users/rexzheng/Documents/AIOS/deliverables/Theodic_Pitch_Deck.pptx` & `.pdf` (Multi-Fund Reusable)
> **Company**: **Theodic** (`Theodic Limited`, proposed pre-incorporation HK Private Limited Company) | **Tagline**: *"Connecting intelligence with the way industries work."*
> **Domain**: AI / Big Data | **Funding Scope**: HK$100,000 Seed Grant · Month 1 – Month 6 (**Commercial Launch within 90 Days / Month 3**)
> **Architecture**: **12 Core Executive Slides (`02`–`12` + unfolioed Cover) + Appendix A (`13`: Live MVP Reviewer Sandbox) + Appendix B (`14`: Data Sources, Verification Index & Compliance Declaration)**

---

## Global V3.2 Design, Language & Typography Contract

1. **Unified Swiss Editorial Surface**:
   - `#FAF8F5` Warm Museum Alabaster paper across Slides `02`–`14`; Slide `01` uses bespoke architectural photography `cover_editorial_bg.png` (`2560×1440`) with left editorial typography kept at `x ≤ 6.70"`.
   - Zero `ROUNDED_RECTANGLE` shapes, zero capsule pills, zero thick vertical accent bars, zero fake browser chrome, zero rainbow badges.
   - Strict Ink & Accent Hierarchy: `#171717` Carbon, `#4A4640` Body Charcoal, `#857F76` Muted Kicker/Folio, `#DCD5CB` `0.5pt` Hairline, `#F1ECE4` flat Limestone strip, and single `#1B4F9C` Deep Ink Cobalt accent (`≤5%` area).
2. **Zero Arrows & Fluent American English**:
   - **Zero `→` / `->` / `<=` / `>=` / `!=` arrows or multi-character ASCII operators** anywhere across text boxes, XMLs, or charts.
   - All slide copy uses idiomatic, concise American English prose (e.g., *Commercialization*, *anonymized*, full spelled-out transitions instead of arrow chains or abbreviations like `avg`, `ex.`, `accts`, `shipping/doc`).
3. **Upscaled Typography Floors (`run_qa_checks`)**:
   - Running rail & folios: **`10.5pt`** `Avenir Next` (`THEODIC` right rail; `02`–`12`, `Appendix A · 13`, `Appendix B · 14` folios).
   - Slide action titles: **`24.0pt`** `Georgia` Bold (`Cover 34.0pt`).
   - Core Slides `01`–`12` minimum font floor: **`≥ 10.5pt`** across every run; body copy `12.2–14.0pt`.
   - Appendix A & B minimum font floor: **`≥ 9.0pt`** `Menlo` strictly for the single-line clickable URL (`s13_clickable_url`) + **`≥ 10.5pt`** for all prose, tables, sources, and compliance text.
4. **Compliance, Fund-Agnostic & Scope Rules**:
   - Zero `ccmf`, `cyberport`, `\bcip\b`, `founders` (plural), `otheon`, `partnar`, or `odoo/xero partner` across slide text, raw XML, or embedded charts/QR.
   - Team-wide wording uses `4 HKUST members` (`singular founder` disallowed outside Slide `08` individual member cards `s8_top_*` / `s8_bot_*`).
   - Slide `12` Declaration moved cleanly to Slide `14` Appendix B bottom Limestone band (`PROJECT MEMBERS' COMPLIANCE DECLARATION`).
   - Reviewer passcode prefix rotated to `THEODIC-DEMO-...` inside `.reviewer-pass.local.json` and `qr_mvp_reviewer_pass.png`.

---

## Slide-by-Slide Content Summary (`01`–`14`)

- **Slide 01 (`Cover`)**: Top-left `theodic_logo_dark.png`; eyebrow `SEED & INNOVATION GRANT BRIEF · AI / BIG DATA`; headline `Governed AI Execution Control Plane for Hong Kong SMEs`; tagline `Connecting intelligence with the way industries work.`; subtitle `Turning unstructured business documents and operational requests into audited, human-approved ERP drafts without migrating core systems.`; 2-column bottom metadata (`DOMAIN: AI / Big Data`, `APPLICANT: Theodic Limited (Proposed) / 4 HKUST Members · HK$100,000`).
- **Slide 02 (`Executive Summary`)**: 3-column architectural bridge (`Two Independent Worlds`, `The Governed Intersection`, `Continuous Transformation`); `VISION & WEDGE` (`357,965` HK SMEs, zero-vision-cost clean routine path) & `WHO WE ARE`; `2×2` Georgia KPIs (`8 to 3 min`, `HK$40,390`, `Month 3`, `HK$100,000`).
- **Slide 03 (`Pain Points & Market Demand · Hong Kong SMEs`)**: 3 idiomatic prose blocks without arrows covering manual clerical bottleneck (`HK$72.4/hr` median, `HK$20,312/month` shipping clerks), manual/unguarded AI failure modes (`12.5%–25%` tail), and cross-sector HK SME market (`357,965` total, `92,307` trade/wholesale/logistics, `8,202` `10–49` B2B firms, `6.0%` ERP, `55%` vs. `32%` paid AI), paired with `chart_hk_sme_gap.png`.
- **Slide 04 (`Solution & Live MVP`)**: 5-stage pipeline (`Intake Lock`, `Confidence Route`, `Policy Queue`, `Digest Lock`, `Read-Back`), enlarged tight crops (`ui_po_conflict_zoom.png`, `ui_agent_lookup_zoom.png`), `SAFETY BOUNDARY` & `VERIFIED MVP FOOTPRINT`.
- **Slide 05 (`Creativity & Innovation`)**: Clean `2×2` Swiss crosshair grid (`01 Confidence-Routed Pixel Extraction`, `02 Cell-Level Policy & Typed Output Firewall`, `03 Separation of Duties & Signed Audit Ledger`, `04 Epoch-Fenced Outbox & ERP Read-Back`).
- **Slide 06 (`Business Model & Time to Market`)**: `01 90-Day Commercial Launch & Targets`, `02 Phased Pricing & Go-To-Market` (`Diagnosis HK$4k`, `Validation HK$10k`, `Pilot HK$25k`, `Production Setup HK$15k`, `HK$4,000/month` SaaS; member-led audits, HKTDC/HKPC clinics, API/CSV integration with Xero, ABSS, Odoo, Excel), `03 Buyer ROI & Unit Economics (Modeled)`, paired with `chart_unit_economics_som.png`.
- **Slide 07 (`Competitive Analysis`)**: Formal accounting table comparing `PrimeFlow / Zoo AI`, `Ricoh / FarSight / iGears`, `Rossum / Conexiom / Esker`, `Odoo 20 Native AI`, `AirPurchase / HKPC Portals` + `THEODIC ADVANTAGE` + `chart_competitor_map.png`.
- **Slide 08 (`Project Management Team`)**: Top `PRE-GRANT PROOF` strip + 4 unified columns with aligned `y = 3.98"` hairlines and 3 structured bullets each:
  - `01` **Lau Hoi Yiu** (`HKUST MGMT · Year 4` | `Founder & CEO / Strategy & Commercialization`): Goldman Sachs (PWM), PwC, Project Melo AI-5000.
  - `02` **Zheng Botao (Rex)** (`HKUST MAEC · Year 3` | `Co-Founder, R&D / System Architecture & AIOS Lead`): SDIC Securities (IBD) Python/OCR (`150+` filings `–70%` time, `300+` vouchers), BDO Consulting China Southern Airlines RPA (`–60%` time, `500+` control matrices), Theodic Lead Architect (`36` Python modules, `26/26` E2E trilingual BFF, HK edge stack).
  - `03` **Chen Haofeng Michael** (`HKUST MATH (CS) · Year 3` | `Co-Founder, R&D / Policy & Verification Lead`): Algorithmic Accountability research, Human–AI Control Design, Theodic Policy & Eval.
  - `04` **Sun Yiping** (`HKUST CSE · Year 1` | `Software Engineer / Full-Stack Workbench & UX`): RTSBuilding (`130K+` downloads, `90` GitHub stars), LexiLamp (paid pilot summer 2026), Theodic Engineering.
- **Slide 09 (`6-Month Execution Milestones · Month 1 – Month 6`)**: Relative timeline (`Tranche 1 · 10%` through `3 SMEs · Final 45%` with `Launch ≤ 90d` highlighted) + 6-row table.
- **Slide 10 (`Cost Budget · HK$100,000 Grant Allocation`)**: Exact `HK$64,000 + HK$36,000 = HK$100,000` table + `chart_budget_tranches.png` + `IN-KIND & CASH VIABILITY` note.
- **Slide 11 (`Social Responsibility`)**: Balanced two-tier spread: 3 plain-English pillars (`–62.5%` `Upskilling Local Clerks`, `3 Languages` `Inclusive Trilingual AI`, `Paperless` `Paperless & Private Workflows`) + bottom `#F1ECE4` `ECOSYSTEM COMMITMENTS` band (`01 SME Clinics`, `02 Open Toolkit` w/ anonymized dataset, `03 Human Sign-Off`) locked to `x = 4.568"`.
- **Slide 12 (`Fundraising & Grant Status`)**: Spacious 3-row 18-month No Double Subsidies disclosure table (`None / HK$0` prior, `Seed Grant · HK$100,000` current, `None During Grant Window` next 18 months).
- **Slide 13 (`Appendix A · Live MVP Reviewer Sandbox`)**: `qr_mvp_reviewer_pass.png`, `THEODIC-DEMO-...` passcode, single-line clickable `>= 9.0pt` URL, arrow-free 90-second walkthrough, 4-layer edge security bullets, and `ui_receipt_stepper_zoom.png`.
- **Slide 14 (`Appendix B · Data Sources, Verification Index & Compliance`)**: Balanced 2-column `[1]–[7]` & `[8]–[13]` index (`10.5pt` Avenir Next) above the bottom `#F1ECE4` `PROJECT MEMBERS' COMPLIANCE DECLARATION` strip.
