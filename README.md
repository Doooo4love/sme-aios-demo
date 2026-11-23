# Theodic SME AIOS

[简体中文](README.zh-CN.md) · [Governed Assurance](docs/governed-assurance.md) · [Backend Architecture](docs/platform.en.md) · [Production Hardening](docs/production-readiness.en.md) · [Workbench Handoff](docs/workbench-handoff.md) · [Desktop Harness](desktop/README.md)

**Theodic SME AIOS** is a zero-migration enterprise operational AI operating system designed for wholesale distributors, logistics operators, and multi-site SMEs. It places a unified, permission-scoped conversational workbench over existing **ERP, WMS/TMS, Finance, Calendar, Email, and Enterprise IM** systems—enforcing deterministic authorization, digest-locked human approvals, transactional outbox ERP reconciliation, cost-aware multi-provider LLM routing, and controlled local desktop automation without exposing raw credentials or migrating core customer databases.

---

## Progressive Adoption Ladder (`Tier 0` → `Tier 1` → `Tier 2`)

Organizations can adopt Theodic SME AIOS incrementally without disrupting existing ERP/WMS infrastructure:

| Tier | Offering | Stack & Scope | Primary Value |
|---|---|---|---|
| **Tier 0** | **Entry-Level Paid Starter: Wholesale PO OCR Intake** | [`aios_demo/`](aios_demo/) · Local Tesseract OCR + bounded opt-in vision + SQLite/PostgreSQL outbox | Immediate ROI wedge: digitizes messy purchase orders with pixel-level evidence, deterministic pack/amount checks, and lost-reply-safe ERP draft verification. |
| **Tier 1** | **Full Enterprise AIOS Cloud Workbench** | [`web/`](web/) + [`aios_platform/`](aios_platform/) + [`mcp/email-server/`](mcp/email-server/) | Multi-tenant RBAC & PostgreSQL forced RLS, native macOS iMessage/WhatsApp collaboration, 8-channel IM hub, Ed25519 signed Assurance, `<2ms` `EffortRouter`, 4-Zone KV Prompt Cache, and L1/L2/L3 work-boundary governance. |
| **Tier 2** | **Tauri 2 Cross-Platform Desktop Harness & Local MCP/CUA** | [`desktop/`](desktop/) + [`mcp/workspace-server/`](mcp/workspace-server/) | Native macOS (`.dmg`/`.app`) & Windows (`.msi`/`.exe`) shell holding **zero LLM API keys**, OS Keychain/Credential Manager scoped device tokens, sandboxed OOXML/PDF document tools, allowlisted single-window CUA, and `CmdOrCtrl+Escape` kill switch. |

### Verified Enterprise Workbench Showcase

| Warm Porcelain Desktop Workbench | Native Messenger & Contact Context | Digest-Locked Approval Diff |
|---|---|---|
| ![Enterprise AIOS Login 3D Stage](web/e2e/screenshots/01-login-3d-stage.png) | ![Native Messenger & Active Context](web/e2e/screenshots/02b-inbox-active-chat-context.png) | ![Manager Digest-Locked Approval Diff](web/e2e/screenshots/04-manager-approval-diff.png) |

| Admin Ops, Telemetry & Security Monitor | Warm Carbon Obsidian (`zh-HK`) | MCP Calendar & Natural-Language Zoom |
|---|---|---|
| ![Admin Ops & Security Monitor](web/e2e/screenshots/05-admin-ops-monitor.png) | ![Dark Mode Inbox zh-HK](web/e2e/screenshots/12-inbox-dark-zh-HK.png) | ![MCP Calendar & Zoom Booking](web/e2e/screenshots/10-calendar-mcp-zoom.png) |

---

## End-to-End Architecture

### 1. Cloud Control Plane ↔ Tauri 2 Desktop (macOS/Windows) & Local MCP/CUA

```mermaid
flowchart TB
    subgraph CLIENT_LAYER ["Client & Desktop Harness Layer"]
        WEB["Web Browser: Next.js 16 Warm Porcelain / Obsidian UI"]
        DESK["Tauri 2 Desktop Shell: macOS .dmg/.app & Windows .msi/.exe"]
        KEYCHAIN["OS Keychain / Windows Credential Manager (Device Token <= 24h, Zero LLM Keys)"]
        ESTOP["Global Hotkey CmdOrCtrl+Escape & Red-Tier Confirmation Modal"]
    end

    subgraph EDGE_BFF ["Edge Cryptographic Gate & Same-Origin BFF"]
        CF["Cloudflare Workers VPC & Reviewer Gate"]
        BFF["Next.js Same-Origin BFF (:3000): HttpOnly Cookie, CSRF, Output Sanitizer, Streamable MCP"]
    end

    subgraph CLOUD_CORE ["Theodic Cloud Control Plane (aios_platform)"]
        API["FastAPI Core (:8760) + Governed Assurance Companion (:8761)"]
        RBAC["OIDC / Demo Auth + Module RBAC + Optional OPA + PostgreSQL Forced RLS"]
        GOV["Sealed SOUL.md + 12-Category Guardrails + L1/L2/L3 Escalation"]
        ROUTER["EffortRouter (<2ms T0-T3) + 4-Zone ContextManager + Pure httpx LLMProvider"]
        OUTBOX["Proposal Digest-Lock + Transactional Outbox + Independent aios_worker"]
        CHHUB["8-Channel Enterprise Hub + Standalone Email MCP (mcp/email-server)"]
    end

    subgraph LOCAL_MCP ["Local Workspace FastMCP & Controlled CUA (mcp/workspace-server)"]
        SANDBOX["WorkspaceSandbox (realpath jail, blocks .env/.ssh/.sqlite/SOUL.md)"]
        DOCTOOLS["API-First Document Tools (OOXML, Docling/MarkItDown, LibreOffice Preview)"]
        CUAGUARD["CuaPolicyEngine: Single-Window AX/UIA Allowlist, PII Scrub, Injection Neutralizer"]
    end

    WEB -->|"HTTPS + HttpOnly Cookie + CSRF"| CF
    DESK -->|"Scoped Device Token"| KEYCHAIN
    DESK -->|"Rust IPC Commands"| ESTOP
    DESK -->|"HTTPS Control Plane (Zero Local LLM Keys)"| CF
    CF -->|"Cloudflare Named Tunnel"| BFF
    BFF -->|"Allowlisted /v1/* & SSE"| API
    API --> RBAC
    RBAC --> GOV
    GOV --> ROUTER
    API --> OUTBOX
    API --> CHHUB
    DESK -->|"Stdio JSON-RPC 2.0"| SANDBOX
    SANDBOX --> DOCTOOLS
    DESK -->|"Green / Yellow / Red-Confirm"| CUAGUARD
    ESTOP -.->|"aios://emergency-stop Kill Switch"| CUAGUARD
```

### 2. Security Governance, Sealed `SOUL.md`, & Non-Work L1/L2/L3 Escalation Pipeline

```mermaid
flowchart TD
    IN["User Turn / Channel Webhook / Desktop CUA Target"] --> NORM["NFKC + Zero-Width Cf Strip (normalize_user_text)"]
    NORM --> SEALED["Sealed Maintainer-Only SOUL.md & Module Policies (403 SYSTEM_POLICY_IMMUTABLE)"]
    NORM --> COREGUARD["10 Core Adversarial Categories (Skill/Prompt Tamper, Injection, SQL/FS Escape, Exfil)"]
    COREGUARD -->|"Blocked"| SEC_LEDGER["Critical/High Security Event + SHA-256 + SSE Alert (T0)"]
    COREGUARD -->|"Clean"| BOUNDARY["evaluate_work_boundary + Work App Allowlist"]
    BOUNDARY -->|"Authorized Business / Normal Greeting"| EXEC["EffortRouter (T1/T2/T3) + RBAC/OPA Tool Execution"]
    BOUNDARY -->|"Off-Topic Chat or Disallowed Local App"| HISTORY["Query 24h & 7d History in aios_security_event"]
    HISTORY -->|"L1: 1-2/day Personal Chat"| NUDGE["Grounded Colleague Nudge (T0 Zero LLM Cost, Info/Resolved, No Supervisor Alert)"]
    HISTORY -->|"L2: 3-4/day Chat or 1st Disallowed Local App"| DENY["Deterministic Boundary Refusal (Medium/Denied, Logged Only)"]
    HISTORY -->|"L3: >=5/day or >=12/7d or >=2/day Local Auto"| REDACT["PDPO/GDPR/PIPL Redaction (preview = REDACTED_PRIVACY_POLICY)"]
    REDACT --> ESCALATE["Role Reporting-Line Router (operator->manager, manager/admin->executive+legal, 7d Sec->CC access-admin+legal)"]
    ESCALATE --> NOTIFY["SSE EventHub + Internal Notice + Optional 8-Channel Webhook Relay"]
    EXEC --> SCRUB["check_output_leakage (Scrub Keys, Paths & Sealed Policy Anchors)"]
    SEALED -.-> SCRUB
```

### 3. Cross-Provider `EffortRouter` & 4-Zone KV Prompt Cache / Dual-Bucket Flow

```mermaid
flowchart LR
    TURN["User Turn + Active Doc + Work Pulse"] --> QUOTA["QuotaManager (Tenant / Role / Subject Daily USD & Token Cap)"]
    QUOTA --> ROUTER["EffortRouter (<2ms Deterministic Classifier)"]
    ROUTER -->|"T0: Security / Slash / Local Rule / Off-Topic L1"| ZERO["0 LLM Calls -> Immediate Deterministic Output"]
    ROUTER -->|"T1: Greeting / Pulse / Single Read"| EFF_N["effort=none (1200 tok, 15s)"]
    ROUTER -->|"T2: Draft / Summary / Clarification"| EFF_L["effort=low (2400 tok, 22s)"]
    ROUTER -->|"T3: Cross-Module / Contract Conflict"| EFF_H["effort=high (8192 tok, 55s)"]

    EFF_N --> CTX["ContextManager 4-Zone Assembly"]
    EFF_L --> CTX
    EFF_H --> CTX

    subgraph ZONES ["4-Zone Dual-Bucket KV Cache Architecture"]
        Z1["Zone 1 (~3K-5K Immutable Prefix): Sealed SOUL.md + Role/Module Policy + Sorted Tool Schemas"]
        Z15["Zone 1.5 (<=140K & <=safe_cap-38K): Single Active Doc Slot (Auto-Unmount <=2K Summary)"]
        Z2["Zone 2 (32K Trajectory Bucket): <=1500 tok Clamped Tool Outputs, Compact >=28K -> ~7K, >60m Idle Compact"]
        Z3["Zone 3 (Ephemeral Tail): Live pulse_summary Attached to Current User Request Only"]
    end

    CTX --> Z1 --> Z15 --> Z2 --> Z3
    Z15 -->|">140K Document Pack"| MR["MapReduceDocumentAnalyzer: <=24K Chunks (T1/T2 Map) -> <=80K (T3 Reduce)"]
    Z3 --> PROV["Pure httpx+pydantic LLMProvider (OpenAICompat / Anthropic / Gemini + Circuit Breaker)"]
    MR --> PROV
    PROV --> HARNESS["Multi-Step Plan-Act-Observe Harness (MAX_HARNESS_STEPS = 4)"]
    HARNESS -->|"Malformed Tool Call on T1/T2"| CASCADE["Cascade Escalation -> T3 (effort=high)"]
    CASCADE --> PROV
    HARNESS -->|"HITL Proposal / Email / Approval Preview"| TELEM["RoutingTelemetryStore (Cache Hit %, USD, Latency)"]
```

### 4. Proposal Digest-Lock Approval, Outbox Read-Back & 8-Channel Collaboration Closed Loop

```mermaid
flowchart LR
    INTAKE["PO Image / Structured Batch / NL Workbench Turn"] --> PREP["Typed Tool Validation + SHA-256 plan_digest"]
    PREP --> PROP["PROPOSED (900s Expiry, Scoped Idempotency-Key)"]
    PROP -->|"SSE Work-Pulse & Channel Notice"| REVIEW["Independent Manager Review (Diff View, Self-Approval Blocked)"]
    REVIEW -->|"Submit Exact SHA-256 Digest + Optional OPA"| QUEUED["QUEUED (Atomic Tx + Audit + Advisory Lock)"]
    QUEUED --> WORKER["Independent aios_worker (SKIP LOCKED + Lease/Epoch)"]
    WORKER -->|"Odoo JSON-2 / ERPNext Frappe / LocalERP"| ERP["Authoritative ERP System"]
    ERP -->|"Reply Lost / Lease Expired"| UNKNOWN["OUTCOME_UNKNOWN -> Bounded Read-Only Reconciliation"]
    UNKNOWN -->|"Receipt Matched"| VERIFIED["VERIFIED (Receipt + Ed25519 Signed Audit Trail)"]
    UNKNOWN -->|"3 Checks Exhausted / Mismatch"| OPS["NEEDS_OPERATOR (Admin Exception Queue + Reopen)"]
    ERP -->|"Confirmed Receipt"| VERIFIED
    VERIFIED -->|"SSE + Real-Time Read Receipts & Outbound Relay"| CHANNELS["Inbox / 8-Channel Hub (WhatsApp, WeCom, Feishu, DingTalk, Slack, Teams, Telegram, LINE)"]
```

---

## Frontend Engineering Highlights (`web/`)

Built on **Next.js 16 (App Router)**, **React 19**, **TypeScript 5.9 (`strict: true`, `noUncheckedIndexedAccess: true`)**, **Tailwind CSS v4**, and unified **Radix UI** (`web/package.json`):

- **Warm Museum Alabaster (`#FAF8F5`) & Warm Carbon Obsidian (`#111110`) Dual Theme**:
  - Zero-FOUC server-side cookie persistence (`aios_locale` and `aios_theme` read in [`web/src/app/layout.tsx`](web/src/app/layout.tsx), zero `localStorage` or `sessionStorage` footprint).
  - De-AI-ified architectural typography (`--font-sans`, `--font-display`, `--font-mono` with `.tabular-nums` / `.font-mono-code`, plus `:lang(zh-HK)` PingFang HK/TC glyph prioritization in [`web/src/app/globals.css`](web/src/app/globals.css)) paired with the dual-ink **Theodic** geometric mark ([`TheodicBrand.tsx`](web/src/components/ui/TheodicBrand.tsx)).
  - Surgical navy-cobalt accents (`#1B4F9C` light / `#6EA3F2` dark) in [`web/src/styles/tokens.css`](web/src/styles/tokens.css) and restrained porcelain/obsidian kinetic components ([`ArchitecturalRelayCanvas`](web/src/components/kinetic/ArchitecturalRelayCanvas.tsx), [`Interactive3DCard`](web/src/components/kinetic/Interactive3DCard.tsx), [`BriefProgressChain`](web/src/components/kinetic/BriefProgressChain.tsx), [`ExecutionTopologyRibbon`](web/src/components/kinetic/ExecutionTopologyRibbon.tsx), [`StatePulseBeacon`](web/src/components/kinetic/StatePulseBeacon.tsx)).
- **Native macOS iMessage / WhatsApp Conversation Experience**:
  - Borderless floating `88px` sticky conversation header ([`ConversationHeader.tsx`](web/src/components/chat/ConversationHeader.tsx)) with hover/focus progressive `112px` blur veil (`.aios-chat-header-veil`) and centered identity trigger.
  - Organic stacked message geometry ([`bubble-group.tsx`](web/src/features/inbox/bubble-group.tsx)): `20px` outer corners (`--radius-bubble`), `6px` shared seam corners (`--radius-bubble-tight`) on consecutive bursts within 300s, `10px` tail-joining corner (`--radius-bubble-tail`), bottom-most overlapping SVG tails (`IMessageBubbleTail`), CSS `linear(...)` physical spring entry (`--ease-spring-bubble`), and centered burst timestamps (`shouldShowBurstTimestamp` / `formatBurstTimestamp`).
  - Live **Delivered / Read** receipts (`fetchRoomReceipts`, `markRoomRead`, SSE `chat_read` events) across [`ChatRoomWorkspace.tsx`](web/src/features/chat/ChatRoomWorkspace.tsx) and [`AssistantWorkspace.tsx`](web/src/features/inbox/AssistantWorkspace.tsx).
  - Interactive **Contact Profile Cards** ([`ContactProfileDialog.tsx`](web/src/components/chat/ContactProfileDialog.tsx)) and tenant-scoped **Company Contacts Directory** ([`ContactsDirectoryModal.tsx`](web/src/features/inbox/ContactsDirectoryModal.tsx)) with 1-click email, Zoom meeting scheduling, and 1:1 DM creation (`/api/directory/contacts`, `/api/directory/direct-room`).
- **GFM Markdown Compiler, `cmdk` Slash Skill Palette & Real-Time SSE Work Pulse**:
  - [`MarkdownMessage.tsx`](web/src/components/ui/MarkdownMessage.tsx) compiles full GitHub-Flavored Markdown (`react-markdown` + `remark-gfm`) with `safeUrlTransform` blocking `javascript:`, `data:`, `vbscript:`, and protocol-relative `//` URLs.
  - [`SlashCommandPalette.tsx`](web/src/features/inbox/SlashCommandPalette.tsx) (`cmdk`) surfaces grant-filtered `/` skills (`/brief`, `/todo`, `/shipment`, `/reschedule`, `/order`, `/invoice`, `/warehouse`, `/approve`, `/email`, `/inbox-mail`, `/meeting`, `/assurance`, `/exceptions`, `/help`).
  - [`ProactiveAgentNotifier.tsx`](web/src/components/shell/ProactiveAgentNotifier.tsx) streams `/v1/workbench/events/stream` SSE events (with `/v1/workbench/work-pulse` fallback) to push real-time approvals, returned drafts, notices, and read receipts into the shell and right-hand slide-over inspector drawer ([`WorkbenchDrawerSlot.tsx`](web/src/components/shell/WorkbenchDrawerSlot.tsx), shortcut `⌘.`).
- **Admin Operations Console, Sealed Governance, 8-Channel Hub & Telemetry/Off-Topic Monitor**:
  - [`AdminOpsOverview.tsx`](web/src/features/admin/AdminOpsOverview.tsx): tenant write-pause kill switch, demo worker stepping, subject suspension, and exception queue triage.
  - [`PromptGovernancePanel.tsx`](web/src/features/admin/PromptGovernancePanel.tsx): sealed governance integrity banner (`managedBy: theodic_core_team`) and Role/Module Capability Simulator without exposing sealed directive text.
  - [`ChannelsHubPanel.tsx`](web/src/features/admin/ChannelsHubPanel.tsx): 8-channel catalog, webhook URL copy, employee handle bindings, and governed outbound relay testing.
  - [`SecurityMonitorPanel.tsx`](web/src/features/admin/SecurityMonitorPanel.tsx): 12-category security event feed with PDPO/GDPR privacy-redacted badges, **Smart Routing & KV Cache Telemetry** (`T0–T3` distribution, cache hit ratio, USD cost, latency, tenant daily quota guardrail), and **Non-Work Boundary & Role Escalation Policy** editor.
- **Same-Origin Sanitized BFF, MCP Calendar/Zoom & Desktop Overlay**:
  - Allowlisted BFF proxy ([`proxy.ts`](web/src/lib/bff/proxy.ts), [`route.ts`](web/src/app/v1/[...path]/route.ts)) recursively strips `planner` and internal LLM keys ([`sanitize.ts`](web/src/lib/bff/sanitize.ts)), normalizes `404` responses to `RECORD_UNAVAILABLE`, enforces `Cache-Control: no-store`, and invalidates stale async responses across `authGeneration` resets.
  - Server-side Streamable HTTP MCP connectors & trilingual natural-language Zoom booking ([`web/src/lib/mcp/`](web/src/lib/mcp/), `/api/integrations/*`, `/api/calendar/ics`).
  - [`DesktopHarnessOverlay.tsx`](web/src/components/desktop/DesktopHarnessOverlay.tsx) (mounted in [`AppShell.tsx`](web/src/components/shell/AppShell.tsx)) strictly renders `null` in standard web browsers and activates only inside Tauri 2 (`window.__TAURI_INTERNALS__`) to surface the `Cmd/Ctrl+Esc` emergency-stop pill and RED-action confirmation modal.

---

## Backend, AI Routing & Desktop Harness Architecture (`aios_platform/`, `mcp/`, `desktop/`)

- **Sealed Maintainer-Only `SOUL.md` & Policy Integrity ([`aios_platform/governance.py`](aios_platform/governance.py))**:
  - Persona and role/module directives load exclusively from the maintainer-sealed [`aios_platform/SOUL.md`](aios_platform/SOUL.md) and server-side specs; never editable or readable by enterprise admins or LLMs.
  - Mutation/reset endpoints (`PUT /v1/operations/prompt-policies/{scope_key}`, `POST .../reset`) fail closed with HTTP `403 SYSTEM_POLICY_IMMUTABLE` (`PolicyImmutableError`).
  - `check_output_leakage()` strips secrets, server paths, and sealed directive anchors before any response leaves the API.
- **Multi-Warehouse RBAC, Optional OPA & PostgreSQL Forced RLS**:
  - Dynamic per-module, per-warehouse grant overrides with advisory locking and optimistic `version` checks in [`aios_platform/module_access.py`](aios_platform/module_access.py).
  - Optional external Open Policy Agent gate ([`deploy/platform/opa.rego`](deploy/platform/opa.rego), [`aios_platform/providers.py`](aios_platform/providers.py)).
  - Forced PostgreSQL Row-Level Security across 23+ tenant tables ([`deploy/platform/postgres-security.sql`](deploy/platform/postgres-security.sql)) verified at startup by [`aios_platform/database_security.py`](aios_platform/database_security.py), separating restricted `aios_api` and `aios_worker` DB identities.
- **12-Category Deterministic Guardrails & L1/L2/L3 PDPO/GDPR/PIPL Escalation ([`aios_platform/security_guard.py`](aios_platform/security_guard.py), [`aios_platform/governance.py`](aios_platform/governance.py))**:
  - `normalize_user_text()` performs NFKC + zero-width `Cf` character stripping before matching 12 categories: `SKILL_TAMPER_ATTEMPT`, `PROMPT_TAMPER_ATTEMPT`, `DESTRUCTIVE_ACTION_ATTEMPT`, `FILESYSTEM_ESCAPE_ATTEMPT`, `PROMPT_INJECTION_ATTEMPT`, `SECRET_EXFILTRATION_ATTEMPT`, `PRIVILEGE_ESCALATION_ATTEMPT`, `CROSS_SCOPE_ACCESS_ATTEMPT`, `UNAUTHORIZED_MODULE_QUERY`, `EMAIL_POLICY_VIOLATION`, `OFF_TOPIC_PERSONAL_CHAT`, and `OFF_TOPIC_LOCAL_AUTOMATION`.
  - `evaluate_work_boundary()` guards against off-topic personal chat and disallowed local app automation against `DEFAULT_WORK_APP_ALLOWLIST` with zero false positives on polite greetings or business queries:
    - **L1** (1–2 daily personal off-topics): grounded, non-preachy nudge at `T0` (zero LLM spend), recorded `info`/`resolved`.
    - **L2** (3–4 daily personal off-topics or first disallowed local automation): deterministic refusal (`medium`/`denied`), zero supervisor push.
    - **L3** (`>=5/day`, `>=12/7d`, or `>=2/day` local automation): `high`/`escalated` along reporting lines (`operator -> [manager]`, `manager/admin -> [executive, legal]`, `executive -> [legal]`, plus `access-admin` & `legal` CC if 7d high/critical security violations exist).
    - **Hard Privacy Redaction**: stored `preview` is strictly `[REDACTED_PRIVACY_POLICY]`; supervisors receive only `(subject, role)`, `24h/7d` counts, category, and `estimated_usd` compute cost.
- **Pure `httpx` + `pydantic` Cross-Provider `LLMProvider` ([`aios_platform/llm_provider.py`](aios_platform/llm_provider.py))**:
  - Zero embedded `litellm` SDK (eliminating third-party LLM wrapper supply-chain risk) while remaining compatible with external OpenAI-format gateways via `base_url`.
  - `ModelProfile` registry covering `deepseek-chat`, `deepseek-flash`, `deepseek-v4-pro`, `gpt-5.4-mini`, `claude-sonnet-4-6`, `gemini-2.5-pro`, and `qwen-plus`, enforcing `safe_cap_tokens = min(180_000, int(surcharge_cliff * 0.90), int(context_window * 0.60))`.
  - Three pooled `httpx.Client` adapters (`OpenAICompatAdapter`, `AnthropicAdapter`, `GeminiAdapter`) supporting provider prompt caching, `reasoning_effort` / `thinking` translation with HTTP 400 fallback stripping, multi-turn `reasoning_content` and `thinking_blocks` preservation, `MAX_LLM_RESPONSE_BYTES = 524_288`, jittered retries, and `ProviderCircuitBreaker`.
- **`<2ms` `EffortRouter`, 4-Zone KV Cache Context Manager & Plan-Act-Observe Harness ([`aios_platform/routing_context.py`](aios_platform/routing_context.py), [`aios_platform/assistant_agent.py`](aios_platform/assistant_agent.py))**:
  - `EffortRouter` deterministically routes requests into `T0` (0 LLM calls), `T1` (`effort="none"`, `1200` tokens / `15s`), `T2` (`effort="low"`, `2400` tokens / `22s`), or `T3` (`effort="high"`, `8192` tokens / `55s`), preserving same-model KV cache warmth and applying **Cascade Escalation** (`T1/T2` → `T3`) on malformed tool calls.
  - `ContextManager` separates **Zone 1** (~3K–5K immutable prefix + sorted `zone1_tool_schemas`), **Zone 1.5** (single Active Document Slot capped at `<= 140K` and `<= safe_cap_tokens - 38K`, auto-unmounting to a `<= 2,000`-token structured summary), **Zone 2** (`32K` append-only trajectory clamping tool outputs to `<= 1,500` tokens before insertion, compacting at `>= 28,000` down to `~7,000`, plus `>60m` idle compaction), and **Zone 3** (ephemeral `pulse_summary` tail attached only to the active turn).
  - `MapReduceDocumentAnalyzer` handles `>140K` document packs by splitting into `<= 24K` token chunks for concurrent `T1/T2` map extraction followed by `T3` synthesis (`<= 80K`).
  - `RoutingTelemetryStore` & `QuotaManager` back `/v1/operations/llm-telemetry`, `/v1/operations/quota-policies`, and `/v1/operations/off-topic-policy` ([`routing_and_escalation.sql`](aios_platform/routing_and_escalation.sql), migration [`0011_routing_telemetry_and_escalation.py`](migrations/versions/0011_routing_telemetry_and_escalation.py)).
- **Proposal Digest-Lock, Outbox & Ed25519 Signed Assurance ([`aios_platform/workflow.py`](aios_platform/workflow.py), [`aios_platform/assurance*.py`](aios_platform/assurance.py))**:
  - Deterministic state machine (`PROPOSED -> QUEUED -> SENDING -> VERIFYING -> CHECKING -> VERIFIED` / `OUTCOME_UNKNOWN` / `NEEDS_OPERATOR` / `REJECTED`), exact SHA-256 `plan_digest` approval, independent approver check, PostgreSQL `SKIP LOCKED` + lease/epoch fencing in [`run_worker.py`](aios_platform/run_worker.py), and [`erp.py`](aios_platform/erp.py) bridges (`LocalERP`, `OdooERP` JSON-2, `ERPNext` Frappe RPC).
  - Governed Assurance ([`assurance.py`](aios_platform/assurance.py), [`assurance_policy.py`](aios_platform/assurance_policy.py), [`assurance_gateway.py`](aios_platform/assurance_gateway.py), [`assurance_audit.py`](aios_platform/assurance_audit.py), [`assurance_catalog.py`](aios_platform/assurance_catalog.py)) adds cell-level allowlists, 16 KiB bounded review gateway, AES-256-GCM transcript encryption, SHA-256 hash chains, and Ed25519 signed checkpoints.
- **8-Channel Enterprise Hub & Standalone Email MCP ([`aios_platform/channels.py`](aios_platform/channels.py), [`mcp/email-server/`](mcp/email-server/))**:
  - Unified registry, employee handle binding, signed webhook ingress + replay protection, and outbound relay across **WhatsApp Business**, **WeCom**, **Feishu / Lark**, **DingTalk**, **Slack Enterprise**, **Microsoft Teams**, **Telegram Business**, and **LINE Official / WORKS**.
  - Standalone TypeScript Email MCP (`mcp/email-server/src/server.ts`, `security.ts`, `transport.ts`) enforcing `MAX_EMAIL_RECIPIENTS = 10`, CRLF header-injection blocking, sliding-window rate limits, pooled TLS/STARTTLS SMTP, and `/v1/workbench/email-outbox` persistence.
- **Tauri 2 Cross-Platform Desktop ([`desktop/`](desktop/)) & Local Workspace FastMCP + CUA ([`mcp/workspace-server/`](mcp/workspace-server/))**:
  - `desktop/src-tauri/`: Rust/Tauri 2 shell with strict CSP (`script-src 'self'; frame-ancestors 'none'`), least-privilege capabilities, `keyring` v3 (`apple-native` macOS Keychain / `windows-native` Windows Credential Manager) rejecting LLM API keys (`ForbiddenLlmSecret`), 5 IPC commands (`ipc.rs`), and `CmdOrCtrl+Escape` global emergency stop (`lib.rs`).
  - `mcp/workspace-server/`: `WorkspaceSandbox(root_dir)` (`realpath` containment blocking traversal, symlinks, `.env`, `.ssh`, `id_rsa`, `*.sqlite*`, `.reviewer-pass.local.json`, `SOUL.md`), API-first `document_tools.py` (native `.txt/.md/.csv/.json`/OOXML + optional `docling`/`markitdown`/`python-docx`/`python-pptx`/`openpyxl` + LibreOffice PNG visual preview), and `CuaPolicyEngine` (`cua_guard.py`: macOS AX / Windows UIA work-app allowlists, `full_screen_capture=False` enforcement, `GREEN`/`YELLOW`/`RED` confirmation tokens, PII scrubbing with optional Presidio, indirect prompt-injection neutralization, and `EmergencyStopController`).

---

## Entry-Level Paid Starter: Wholesale PO OCR Intake

The original standalone wholesale purchase-order intake prototype (`aios_demo/`) remains preserved in full as our **Tier 0** entry-level paid starter—allowing wholesale teams to upload a purchase-order image, examine field-level evidence, review exceptions, approve a sales-order draft, and verify it in the mock ERP. The inbox preserves the document, reviewed preview, and command so the workflow can resume after refresh or restart.

### Reusable Logistics & Wholesale Backend (`aios_platform/`)

`aios_platform/` builds directly on these typed actions, tenant policy, independent approval, and ERP verification across sample tenants (`harbour` and `island`), while the standalone PO workbench below remains runnable independently:

```bash
python -m pip install -r requirements-platform.txt
python scripts/platform_smoke.py
```

Read the [backend architecture and ERP bridge contract](docs/platform.en.md) for tenant configuration, Linux and PostgreSQL isolation, API usage, LLM options and the customer onboarding checklist. The [production hardening guide](docs/production-readiness.en.md) covers migrations, controls and release gates. The [pilot automation guide](docs/pilot-automation.md) describes bulk intake and approval, exception handling, and reproducible performance measurements.

Read the [enterprise workbench and frontend handoff](docs/workbench-handoff.md) for role-scoped tools, employee chat, and customer integration gates.

![Current workbench showing a local upload, the intake inbox, OCR evidence and the draft preview](docs/browser/04-upload-and-inbox.png)

### A two-minute demo

1. Open **Standard PO**. Select **Line 1 · Quantity** to highlight the OCR bounding box. The approved catalogue maps **2 cases → 48 units**. Line totals reconcile to **HKD 804**.
2. Switch to **Quantity conflict**. Tesseract reads **2** and scripted Vision A reads **8**. The second scripted reader reads **2**, and the field still goes to review. Enter **8** to see the amount check reject it, then enter **2**.
3. Select **Approve and queue**, keeping **Simulate a lost reply** enabled. The first worker step writes the mock ERP draft and loses the reply. The second performs a separate read-back. The ledger shows **one** matching ERP draft and the verified approved payload.
4. Refresh to reopen the verified order. Then upload `fixtures/harbour-po.png` with vision unchecked. The inbox shows the uploaded PO and its separate preview. A readable, consistent order makes zero vision requests.

| Exception review | ERP reconciliation |
|---|---|
| [View browser screenshot](docs/browser/02-quantity-review.png) | [View browser screenshot](docs/browser/03-erp-reconciliation.png) |

The upload and inbox screen was captured from the [verified browser run](https://github.com/Doooo4love/sme-aios-demo/actions/runs/44757111231). The two linked images show the original review and reconciliation walkthrough. See the [demo guide](docs/demo.md) for the operator script.

### Run locally (Standalone PO Workbench)

Use Python 3.11+ and Tesseract with English trained data. On Debian/Ubuntu install `tesseract-ocr` and `tesseract-ocr-eng`. On macOS install `tesseract` with Homebrew.

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python -m uvicorn aios_demo.api:app --host 127.0.0.1 --port 8758
```

Open **http://127.0.0.1:8758**. No provider keys are needed. For a repeatable demo use a fresh `AIOS_STATE_DIR`; approval of the same business key in an existing database resolves to the original command. The UI advances the asynchronous worker one step at a time for the presentation. In normal local runs you can start a separate worker with `python -m aios_demo.worker` using the same state directory and optional PostgreSQL DSN.

```bash
python scripts/run_demo.py
python -m pip install -r requirements-test.txt
python -m unittest discover -s tests -v
```

### Intake contract

```bash
python -m aios_demo.extract_po fixtures/harbour-po.png --mode ocr
```

The CLI returns JSON with the original file hash, image dimensions, field values, OCR regions, review reason codes, vision call count, and an optional ERP draft. Use `--mode vision-on-demand` with the configured provider to compare the same input with targeted visual review. Both modes use the same amount and pack-size rules. The CLI stops at the draft preview.

The workbench accepts PNG/JPEG up to 8 MB and eight megapixels. It stores a normalized PNG so displayed coordinates match the extracted evidence. The initial parser and catalog match the demo buyer and supported PO layout. A different layout stays in review. Configured vision receives only an anchored crop and the field type, and is opt-in per upload.

### Core implementation

| Piece | What is implemented |
|---|---|
| [Parser](aios_demo/parsing.py) | Tesseract TSV → typed fields, document completeness checks, pixel coordinates, OCR scores |
| [Multimodal routing](aios_demo/routing.py) | Evidence anchors, deterministic business checks, targeted and bounded visual reads, and human review |
| [Command and outbox](aios_demo/storage.py) | Saved intake and preview, exact-payload approval, idempotent same-PO handling, transactional job creation, PostgreSQL `SKIP LOCKED`, leases and epoch fencing, bounded read retries |
| [Outbox consumer](aios_demo/worker.py) | Persists dispatch intent, crosses a separate database boundary, handles lost replies, and verifies business key, draft status and full payload |
| [API and workbench](aios_demo/api.py) | Upload, recent-intake inbox, persisted evidence and preview, approval and read-back state |
| [Tests](tests/) | Real OCR, conflict gating, concurrent duplicate approvals, stale lease, unknown outcomes and end-to-end API |

```mermaid
flowchart LR
    A["PO image"] --> B["OCR and vision router"]
    B --> C["Field review and approval"]
    C --> D["Command and outbox"]
    D --> E["ERP draft and read-back"]
```

### Scope

The workbench is a single-tenant pitch prototype with synthetic documents, a fixed local reviewer, and a mock ERP backed by a separate database file. The predefined pitch scenarios use **scripted vision fixtures** by default. New uploads use local OCR by default, and the default command store is SQLite. A PostgreSQL path and an opt-in HTTPS vision adapter are included. The backend platform provides separate role enforcement and ERP bridge clients. Customer-side ERP transactions, identity onboarding, and write acceptance are pilot integration work. The app is intended for loopback use. See [implementation notes](docs/demo.md#implementation-boundaries) before adapting it to a customer environment.

> **Seamless Upgrade Path**: The exact same PO evidence and `plan_digest` approval semantics from `aios_demo/` scale directly into [`aios_platform/`](aios_platform/) (`POST /v1/intakes/{warehouse}`, `/structured/batch`, `/proposals/{id}/approve`) and the Next.js [`OrderIntakeWorkspace.tsx`](web/src/features/orders/OrderIntakeWorkspace.tsx) + [`OcrEvidenceViewer.tsx`](web/src/features/orders/OcrEvidenceViewer.tsx).

---

## Quickstart, Testing & Operations

### 1. Enterprise Cloud Workbench (`web/` + `aios_platform/`)

```bash
# Option A: One-command keyless local demo (FastAPI :8760 + Next.js BFF :3000)
./deploy/demo/start-local-demo.sh

# Option B: Dual-port Cloud LLM (:8760) + Governed Assurance (:8761)
export AIOS_LLM_BASE_URL="https://api.deepseek.com"
export AIOS_LLM_MODEL="deepseek-chat"
export AIOS_LLM_API_KEY="sk-your-server-only-key"
./deploy/demo/start-local-demo.sh --mode dual

# Option C: $0 Public HTTPS Quick Tunnel (macOS/Linux + cloudflared)
./deploy/demo/start-local-demo.sh --prod --tunnel
```

Open **http://localhost:3000/** and sign in with Account + Password or expand the local demo persona helper across 11 controlled identities (`operator`, `manager`, `finance`, `access-admin`, `admin`, `other-manager`, `island-manager`, `viewer`, `quality`, `legal`, `executive`). For full Next.js BFF variables and MCP calendar/Zoom setup, see [`web/README.md`](web/README.md).

### 2. Backend Migrations & Automated Verification Suites

```bash
# Apply Alembic database migrations through 0011_routing_telemetry_and_escalation
.venv/bin/python -m alembic upgrade head

# Run backend Python unit & integration suites
.venv/bin/python -m unittest discover -s tests -v

# Run routing, context, assistant, and migration unit suites
.venv/bin/python -m unittest tests.test_routing_provider_context tests.test_assistant_and_sse tests.test_migrations -v

# Run standalone Desktop & Workspace MCP harness tests
.venv/bin/python -m unittest tests.test_desktop_workspace_harness -v

# Run Work-Boundary L1/L2/L3 escalation & guard tests
.venv/bin/python -m unittest tests.test_off_topic_escalation tests.test_governance_and_guard -v

# Run Next.js strict TypeScript check, production standalone build, and Playwright E2E
pnpm --dir web run typecheck
pnpm --dir web run build
pnpm --dir web run test:e2e

# Run Cloudflare Worker typecheck & unit tests
pnpm --dir deploy/cloudflare-worker run typecheck
pnpm --dir deploy/cloudflare-worker run test
```

### 3. Tauri 2 Desktop (`desktop/`) & Local Workspace MCP (`mcp/workspace-server/`)

```bash
# Run Local Workspace & Controlled CUA MCP server over stdio
.venv/bin/python mcp/workspace-server/server.py --root /path/to/workspace

# Run or build Tauri 2 Desktop shell (requires Node >= 20, pnpm, and Rust >= 1.77 on macOS/Windows CI)
pnpm --dir desktop install
pnpm --dir desktop dev
pnpm --dir desktop build
```

See [`desktop/README.md`](desktop/README.md) and [`mcp/workspace-server/README.md`](mcp/workspace-server/README.md) for OS Keychain invariants, capability allowlists, and native installer build targets (`.dmg`/`.app`/`.msi`/`.exe`).

### 4. Cloudflare Zero Trust, IntegrAI Host & Reviewer Gate Ops

Production demo hosting binds all application listeners strictly to loopback (`127.0.0.1:3000`, `:8760`, `:8761`) behind a Cloudflare Named Tunnel (`deploy/integrai/`) and **Cloudflare Workers VPC** (`deploy/cloudflare-worker/`) with an edge HMAC **Reviewer Gate** (`src/reviewer-gate.ts`) enforcing `X-Robots-Tag: noindex, nofollow, noarchive`, sliding-window LLM rate limits (`8/min`, `40/hr`), and Judge sandbox mutation protection (`403 JUDGE_SANDBOX_PROTECTED`).

- **Dry-run & secret-free gate activation** (reads gitignored `.reviewer-pass.local.json`, pipes secrets via `stdin` to `wrangler secret put` without echoing):
  ```bash
  ./deploy/cloudflare-worker/activate-reviewer-gate.sh --dry-run
  ./deploy/cloudflare-worker/activate-reviewer-gate.sh
  ```
- **Zero-downtime emergency expiration circuit breaker** (immediately invalidates active reviewer passcodes/links):
  ```bash
  printf '%s' '2020-01-01T00:00:00Z' | pnpm --dir deploy/cloudflare-worker exec wrangler secret put AIOS_REVIEWER_EXPIRES_AT --name aios-demo
  ```
- **Credential rotation** (revokes all prior cookies & QR capability tokens):
  ```bash
  node ./deploy/cloudflare-worker/scripts/generate-reviewer-pass.mjs --force
  ./deploy/cloudflare-worker/activate-reviewer-gate.sh
  ```
- Full Cloudflare Worker, Zero Trust Access fallback, and custom domain migration instructions: [`deploy/cloudflare-worker/README.zh-CN.md`](deploy/cloudflare-worker/README.zh-CN.md).
- Hardened Ubuntu VPS deployment runbook (`01-preflight.sh` → `06-verify-live.sh`): [`deploy/integrai/RUNBOOK.zh-CN.md`](deploy/integrai/RUNBOOK.zh-CN.md).

---

## Documentation Index

| Area | English | 简体中文 |
|---|---|---|
| **Governed AI Assurance & Zero-Migration Integration** | [docs/governed-assurance.md](docs/governed-assurance.md) | [docs/governed-assurance.zh-CN.md](docs/governed-assurance.zh-CN.md) |
| **Backend Architecture & ERP Bridge Contract** | [docs/platform.en.md](docs/platform.en.md) | [docs/platform.md](docs/platform.md) |
| **Production Hardening & Acceptance Gates** | [docs/production-readiness.en.md](docs/production-readiness.en.md) | [docs/production-readiness.md](docs/production-readiness.md) |
| **Wholesale & Logistics Pilot Automation** | [docs/pilot-automation.md](docs/pilot-automation.md) | [docs/pilot-automation.zh-CN.md](docs/pilot-automation.zh-CN.md) |
| **Enterprise Workbench & Frontend Handoff** | [docs/workbench-handoff.md](docs/workbench-handoff.md) | [docs/workbench-handoff.zh-CN.md](docs/workbench-handoff.zh-CN.md) |
| **Workbench Backend & Module Access** | — | [docs/workbench-backend.zh-CN.md](docs/workbench-backend.zh-CN.md) |
| **Collaboration, OIDC Sessions & Customer Connectors** | — | [docs/workbench-collaboration.zh-CN.md](docs/workbench-collaboration.zh-CN.md) |
| **Enterprise Frontend Delivery Guide (`web/`)** | [web/README.md](web/README.md) | [docs/workbench-frontend.zh-CN.md](docs/workbench-frontend.zh-CN.md) |
| **PO OCR Operator Demo Script & Boundaries** | [docs/demo.md](docs/demo.md) | [docs/demo.zh-CN.md](docs/demo.zh-CN.md) |
| **Desktop Harness & Local Workspace MCP** | [desktop/README.md](desktop/README.md) · [mcp/workspace-server/README.md](mcp/workspace-server/README.md) | — |
| **Cloudflare Worker Gate & IntegrAI Ops** | — | [deploy/cloudflare-worker/README.zh-CN.md](deploy/cloudflare-worker/README.zh-CN.md) · [deploy/integrai/RUNBOOK.zh-CN.md](deploy/integrai/RUNBOOK.zh-CN.md) |

---

## Open-Source Acknowledgments

Theodic SME AIOS stands on the shoulders of proven open-source foundations:

- **Backend & Data**: [FastAPI](https://fastapi.tiangolo.com/), [Pydantic](https://docs.pydantic.dev/), [httpx](https://www.python-httpx.org/), [SQLAlchemy](https://www.sqlalchemy.org/) / [Alembic](https://alembic.sqlalchemy.org/), [PostgreSQL](https://www.postgresql.org/) (Forced RLS & `SKIP LOCKED`), [PyJWT](https://pyjwt.readthedocs.io/), [cryptography](https://cryptography.io/) (Ed25519 / AES-256-GCM), [Open Policy Agent](https://www.openpolicyagent.org/), [Prometheus Python Client](https://github.com/prometheus/client_python).
- **Frontend & UI**: [Next.js](https://nextjs.org/), [React](https://react.dev/), [Tailwind CSS](https://tailwindcss.com/), [Radix UI](https://www.radix-ui.com/), [cmdk](https://cmdk.paco.me/), [react-markdown](https://github.com/remarkjs/react-markdown) + [remark-gfm](https://github.com/remarkjs/remark-gfm), [Lucide](https://lucide.dev/), [Zod](https://zod.dev/), [Playwright](https://playwright.dev/).
- **Desktop, Document & Controlled Automation**: [Tauri 2](https://v2.tauri.app/) (`keyring` v3), [Model Context Protocol (MCP)](https://modelcontextprotocol.io/), [Docling](https://github.com/DS4SD/docling) / [MarkItDown](https://github.com/microsoft/markitdown), [Microsoft Presidio](https://microsoft.github.io/presidio/), [OmniParser](https://github.com/microsoft/OmniParser), [Tesseract OCR](https://github.com/tesseract-ocr/tesseract), and [Cloudflare Workers](https://developers.cloudflare.com/workers/).
