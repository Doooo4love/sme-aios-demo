# SME AIOS Enterprise Workbench (`web/`)

Next.js 16 (App Router) + TypeScript strict + Tailwind CSS v4 + unified `radix-ui` enterprise workbench frontend and same-origin BFF for `aios_platform`.

> 完整中文交付文档、API 核对清单、三语（简体中文 / 繁體中文 / English）与 Apple Sequoia 深色模式架构、MCP 环境变量接入指南、真假数据对照、Claude Opus 5.5 High 超严苛全量视觉审计与 Polish Round 3 精修总结、IntegrAI 云端部署指引及 **26 / 26** 自动化验收报告请参见 [docs/workbench-frontend.zh-CN.md](../docs/workbench-frontend.zh-CN.md)。

## Stack & v2 Architecture Highlights

- **Runtime & UI**: Next.js `16.4.6` (`output: "standalone"`), React `19.3.x`, TypeScript `5.9.x` (`strict: true`, `noUncheckedIndexedAccess: true`), Tailwind CSS `v4`, unified `radix-ui`, `lucide-react`, `zod`.
- **Full Trilingual (`zh-CN` / `zh-HK` / `en`) & Native Apple macOS Sequoia Light/Dark Theme (`src/lib/i18n/*`, `src/lib/theme-context.tsx`, `src/styles/tokens.css`, `src/app/layout.tsx`)**:
  - **Zero-FOUC SSR Cookie Persistence**: Reads `aios_locale` (`zh-CN` | `zh-HK` | `en`) and `aios_theme` (`light` | `dark`) on the server in `RootLayout` (`<html lang={...} data-theme={...}>`, dynamic `generateMetadata()` + `themeColor` viewport) with **zero `localStorage` / `sessionStorage`** usage.
  - **Linguistic Craft & `Intl.PluralRules`**: Modular compile-time-verified trilingual dictionaries (`common`, `messenger`, `workbench`, `admin`), `:lang(zh-HK)` PingFang HK/TC glyph typography, HKT-consistent time formatting (`formatTimeOnly` / `formatUnixTime`), `tp()` pluralization, localized UOMs (`箱`/`件`/`Case`/`Each`), trilingual NL Zoom meeting parser (`zh-CN` / `zh-HK` / `en`), and locale-neutral structured chat room titles (`DM · ...` / `Meeting · ...`) & meeting-booked system tokens (`[[aios:meeting-booked|...]]`) rendered dynamically in the viewer's language.
  - **Frosted Alabaster (Light) & Obsidian Porcelain (Dark)**: Unified surface hierarchy (`#F5F6F8` → `#FFFFFF` in Light; `#0C0E13` → `#141822` → `#1E2332` in Dark), WCAG AA+ split Cobalt accent tokens (`--accent-solid` `#1F6FEB` / `--accent-ink` `#6AA6FF` in Dark; `#1668E3` in Light), opaque `ExecutionTopologyRibbon` stepper nodes (`color-mix`), seamless `IMessageBubbleTail` geometry, and strict `prefers-reduced-motion` freeze.
  - **1-Click Preferences Switchers (`PreferencesControls.tsx`)**: Mounted cleanly on `/` & `/login` (floating frosted capsule), `/inbox*` sidebar bottom dock & account popover, and `AppShell` centered CSS Grid top bar (with mobile `< 640px` account menu fallback).
  - **Calibrated 3D & Truthful Motion**: Theme- and locale-reactive 3D `ArchitecturalRelayCanvas` (`Frosted Porcelain` vs `Matte Obsidian`) on `/` & `/login`; size-damped `Interactive3DCard` (`maxTilt <= 3°`, `interactive={false}` sheen-only for static cards); `BriefProgressChain` (single-line pending status + collapsible real-state business checklist, zero fake CoT).
- **Root `/` Account + Password Login (`src/app/page.tsx`, `src/features/auth/LoginView.tsx`, `POST /api/auth/login`)**:
  - Unauthenticated `/` renders the Account + Password login form + Porcelain 3D showcase directly (with collapsed-by-default 11-persona local demo quick-fill helper and optional enterprise OIDC `/v1/session/login`); authenticated `/` redirects directly to `/inbox`.
  - Constant-time password verification, anti-enumeration `401`, sliding-window `429` brute-force guard, and same-origin HttpOnly session cookie exchange.
- **Native macOS 2-Column Messenger + Company Contacts Directory (`src/features/inbox/*`, `/api/directory/*`)**:
  - Full-height 2-column macOS Sequoia split layout (zero legacy 60px far-left rail or redundant top chrome on `/inbox*`), unified `⌘K` search across rooms and live tenant-scoped colleagues, **Company Contacts Directory** modal (`GET /api/directory/contacts`, `POST /api/directory/direct-room`, strict tenant boundary, 1-click 1:1 room), Pinned 3D Agent hero tile, live room previews + compact timestamps, and serene single-row bottom dock (demo persona switcher folded cleanly inside the account popover).
- **Pure Muse Personal Agent Canvas (`src/features/inbox/AssistantWorkspace.tsx`)**:
  - Ultra-clean 60px frosted header showing **only** custom Agent avatar/name on the left and top-right `"工作台"` pill (`⌘.` toggles the frosted right slide-over inspector drawer).
  - Seamless iMessage spring bubbles with SVG tails, unboxed serene empty state, and floating capsule composer with strictly two footer controls: `+ 添加上下文` popover (today brief, frosted History Verification Modal with real-time `403`/`404` scrub, NL Zoom booking, structured tool form) and circular Cobalt `↑` Send.
- **Permission-Tiered Workbench Hub (`src/features/workbench/*`, `/work`)**:
  - 4 capability-gated tiers (`执行与进件层`, `专业复核层`, `审批与经营层`, `管理与治理层`), real live KPI tiles, humanized business titles + copyable short IDs, localized audit timelines (`自审批已拦截`, etc.), formatted Assurance currency (`HKD 12,000.00`), and calm 5-control frosted top bar.
- **Server-Side MCP Calendar & Natural-Language Zoom Booking (`src/lib/mcp/*`, `/api/integrations/*`, `/api/calendar/ics`)**:
  - Supports real Streamable HTTP MCP connectors for **Google Calendar**, **Apple iCloud CalDAV**, **Outlook / M365 Graph**, and **Zoom** (MCP → Zoom S2S OAuth → honest `sandbox_preview`), real RFC 5545 / RFC 7986 `.ics` export (`GET /api/calendar/ics`) with zero API keys required, and bilingual ZH/EN two-step NL Zoom booking (`POST /api/integrations/zoom/book`: `parse`/`preview` → explicit `confirm` → real internal `/v1/calendar/events` + room notification + external MCP fan-out + `.ics`).
- **Same-Origin BFF & Zero-Leak Security Hygiene (`src/app/v1/[...path]/route.ts`, `src/lib/bff/*`, `src/lib/api-client.ts`)**:
  - Allowlisted proxy to `aios_platform` with optional split-upstream `/v1/assurance/*` via `AIOS_ASSURANCE_API_BASE_URL`.
  - Strips `capabilities.planner` and all forbidden internal/LLM JSON keys (`provider`, `prompt`, `planner`, `reasoning`, `chain_of_thought`, `api_key`, `secret`, etc.), normalizes `404` to uniform `RECORD_UNAVAILABLE`, enforces `Cache-Control: no-store` on all `/v1/*` and `/api/*` routes, stores `csrf_token`/drafts/objects strictly in memory (zero `localStorage`/`sessionStorage`, zero `NEXT_PUBLIC_*` secrets), and drops late responses across `authGeneration` resets.

---

## Quick Start

### Option A · One-Command Keyless Local Demo (Single Process: Local Rules + Assurance)

From repository root (`/Users/rexzheng/Documents/AIOS`):

```bash
./deploy/demo/start-local-demo.sh
```

Open **http://localhost:3000/** and sign in with Account + Password (e.g. `operator` / `aios2026`, or `manager` / `aios2026`), or expand **「测试演示账号快速填入」** to switch across all 11 controlled demo personas (`operator`, `manager`, `finance`, `access-admin`, `admin`, `other-manager`, `island-manager`, `viewer`, `quality`, `legal`, `executive`).

### Option B · One-Command `$0` Public HTTPS Demo (Local Mac + Cloudflare Quick Tunnel)

```bash
brew install cloudflared   # once
./deploy/demo/start-local-demo.sh --prod --tunnel
```

The launcher starts `cloudflared` first, captures the exact `https://*.trycloudflare.com` origin, configures `AIOS_BROWSER_ORIGIN` on both FastAPI and Next.js so Secure `__Host-aios_session` cookies and `Origin` checks succeed cleanly over HTTPS, and prints the shareable URL.

### Option C · Dual-Port Cloud LLM + Governed Assurance

Because `aios_platform/api.py` forbids running `AIOS_WORKBENCH_PLANNER=pydantic-ai` inside the same process as `AIOS_ASSURANCE_*KEY_FILE`, run both side by side sharing the same state directory and session encryption key:

```bash
export AIOS_LLM_BASE_URL="https://api.deepseek.com"
export AIOS_LLM_MODEL="deepseek-chat"
export AIOS_LLM_API_KEY="sk-..."

./deploy/demo/start-local-demo.sh --mode dual
```

- `:8760` serves main workbench endpoints with `pydantic-ai`.
- `:8761` serves `/v1/assurance/*` with `local` + `AIOS_ASSURANCE_DEMO_KEY_FILE`.
- Next.js BFF automatically sets `AIOS_ASSURANCE_API_BASE_URL=http://127.0.0.1:8761`.

### Option D · IntegrAI Production Demo Host (`deploy/integrai/`)

For hardened 24/7 Ubuntu VPS deployment behind Cloudflare Named Tunnel (loopback-only FastAPI `:8760` + Assurance `:8761` + Next.js standalone `:3000`, locked UFW, automated SQLite backup & restore drill), follow [`deploy/integrai/RUNBOOK.zh-CN.md`](../deploy/integrai/RUNBOOK.zh-CN.md) and scripts `01-preflight.sh` → `06-verify-live.sh`.

### Option E · Manual Two-Terminal Dev Startup

```bash
# Terminal 1: FastAPI backend (repo root)
export AIOS_PROFILE=demo
export AIOS_PLATFORM_STATE_DIR="$(mktemp -d)"
export AIOS_DEMO_SECRET="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32).replace(".", "-"))')"
export AIOS_BROWSER_SESSION_KEY="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
export AIOS_BROWSER_ORIGIN="http://localhost:3000"
export AIOS_WORKBENCH_PLANNER=local
.venv/bin/uvicorn aios_platform.api:create_app --factory --host 127.0.0.1 --port 8760 --no-access-log

# Terminal 2: Next.js BFF (web/)
cd web
cp .env.example .env.local   # fill matching AIOS_DEMO_SECRET and set AIOS_ENABLE_DEMO_AUTH=1
pnpm install
pnpm dev
```

---

## Environment Variables (`web/`)

All variables are **server-only**. Never prefix any secret, backend URL, or MCP credential with `NEXT_PUBLIC_`.

### Core BFF & Authentication

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `AIOS_API_BASE_URL` | Yes | `http://127.0.0.1:8760` | Internal FastAPI base URL for `/v1/*`, `/healthz`, `/readyz`. |
| `AIOS_ASSURANCE_API_BASE_URL` | Optional | *(falls back to `AIOS_API_BASE_URL`)* | Dedicated Assurance backend URL (e.g. `http://127.0.0.1:8761`) in dual-port Cloud LLM + Assurance setups. |
| `AIOS_BROWSER_ORIGIN` | Yes | `http://localhost:3000` | Exact browser origin (`scheme://host[:port]`) validated on all mutations and forwarded to FastAPI. Must match FastAPI's `AIOS_BROWSER_ORIGIN`. |
| `AIOS_ENABLE_DEMO_AUTH` | Demo only | `0` | Set to `1` ONLY in local/demo environments to enable `/api/auth/login` and `/api/auth/demo-login`. |
| `AIOS_DEMO_SECRET` | Demo only | — | Must match FastAPI `AIOS_DEMO_SECRET` (`>= 32` chars, no `.`). Held exclusively on the BFF server. |
| `AIOS_DEMO_LOGIN_PASSWORD` | Demo only | `aios2026` | Local Account + Password demo secret for `POST /api/auth/login` when `AIOS_ENABLE_DEMO_AUTH=1`. |
| `AIOS_OIDC_LOGIN_ENABLED` | Optional | `1` when demo auth is disabled | Controls visibility of the enterprise OIDC (`/v1/session/login`) button on `/` & `/login`. |

### Optional External Calendar & Zoom MCP Connectors (Zero Keys Required by Default)

Without these variables, AIOS runs 100% live internal calendar persistence, honest MCP sandbox status, and real RFC 5545 / RFC 7986 `.ics` export (`GET /api/calendar/ics`). Setting the server-side variables below seamlessly upgrades each connector to live sync:

| Connector | Server-Only Environment Variables |
|---|---|
| **Google Calendar MCP** (`@cocal/google-calendar-mcp`) | `AIOS_MCP_GOOGLE_CALENDAR_URL`, `AIOS_MCP_GOOGLE_CALENDAR_TOKEN`, `AIOS_MCP_GOOGLE_CALENDAR_ID` (default `primary`), `AIOS_MCP_GOOGLE_CALENDAR_TOOL` (default `create-event`) |
| **Apple iCloud CalDAV MCP** (`caldav-mcp --http`) | `AIOS_MCP_ICLOUD_CALENDAR_URL`, `AIOS_MCP_ICLOUD_CALENDAR_TOKEN`, `AIOS_MCP_ICLOUD_CALENDAR_TOOL` (default `create_event`) |
| **Outlook / M365 Graph MCP** (`@softeria/ms-365-mcp-server`) | `AIOS_MCP_OUTLOOK_CALENDAR_URL`, `AIOS_MCP_OUTLOOK_CALENDAR_TOKEN`, `AIOS_MCP_OUTLOOK_CALENDAR_TOOL` (default `create-calendar-event`) |
| **Zoom Video Meetings** (Option A: MCP) | `AIOS_MCP_ZOOM_URL`, `AIOS_MCP_ZOOM_TOKEN`, `AIOS_MCP_ZOOM_TOOL` (default `create_meeting`) |
| **Zoom Video Meetings** (Option B: S2S OAuth) | `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`, `ZOOM_HOST_USER_ID` (default `me`) |

---

## Scripts & Verification

```bash
pnpm --dir web install       # Install dependencies (pnpm 11 + Node 26)
pnpm --dir web dev           # Local dev server on 127.0.0.1:3000
pnpm --dir web typecheck     # Strict TypeScript check (`tsc --noEmit`)
pnpm --dir web build         # Production Turbopack standalone build (`.next/standalone/server.js`)
pnpm --dir web test:e2e      # Run full Playwright E2E + i18n/Dark + security regression suite (26 tests, desktop + mobile)
```

> **Production Standalone Runtime**: Because `next.config.ts` enables `output: "standalone"`, run production servers with `cp -R web/.next/static web/.next/standalone/.next/ && HOSTNAME=127.0.0.1 PORT=3000 node web/.next/standalone/server.js` (handled automatically by `./deploy/demo/start-local-demo.sh --prod`, `deploy/demo/aios-demo-web.service`, and `deploy/integrai/03-deploy-release.sh`).
>
> **First-time Playwright setup**: Install Chromium once via `pnpm --dir web exec playwright install chromium`. Run E2E tests against a live FastAPI + Next.js stack (`PLAYWRIGHT_BASE_URL=http://localhost:3000 pnpm --dir web test:e2e`). Latest full live verification after **Claude Opus 5.5 High Ultra Audit & Polish Round 3**: **26 / 26 PASS** (desktop `1440×900` + mobile `390×844` + trilingual `zh-CN`/`zh-HK`/`en` + Apple Sequoia Dark Mode + zero-FOUC SSR reload + live Assurance `PO-100` + Contacts tenant isolation + MCP/Zoom `.ics` + zero-leak audit), with **23 fresh verification screenshots** saved in `web/e2e/screenshots/`.

---

## Project Layout

```text
web/
├── playwright.config.ts        # Desktop (1440x900) + Mobile (390x844) sequential E2E config
├── e2e/
│   ├── helpers/workbench.ts    # Trilingual Account+Password/demo login, persona switch, BFF fetcher, zero-leak auditor
│   ├── 01-auth-shell-profile.spec.ts
│   ├── 02-order-approval-receipt.spec.ts
│   ├── 03-module-access-and-isolation.spec.ts
│   ├── 04-collaboration-roles-calendar.spec.ts
│   ├── 05-security-errors-resilience.spec.ts
│   ├── 06-v2-login-contacts-mcp-zoom.spec.ts
│   ├── 07-i18n-and-dark-mode.spec.ts
│   └── screenshots/            # 23 curated v2/v3 verification screenshots (Light + Dark + zh-CN/zh-HK/en + Mobile)
└── src/
    ├── app/
    │   ├── layout.tsx          # SSR cookie reader (aios_locale / aios_theme), zero-FOUC <html>, viewport themeColor
    │   ├── page.tsx            # Root `/` SSR session check -> <LoginView /> or redirect /inbox
    │   ├── login/              # Direct login route -> <LoginView />
    │   ├── v1/[...path]/       # Same-origin sanitized BFF proxy
    │   ├── healthz/ & readyz/  # Public health/readiness passthrough
    │   ├── api/auth/           # Account+Password login, controlled demo-login & persona metadata
    │   ├── api/directory/      # Tenant-scoped Company Contacts Directory & locale-neutral 1:1 direct-room BFF
    │   ├── api/integrations/   # MCP connector status, trilingual NL Zoom booking & external calendar sync BFF
    │   ├── api/calendar/ics/   # RFC 5545 / RFC 7986 .ics generator
    │   └── (app)/              # Authenticated AppShell routes (/inbox, /work, /orders/new, /proposals/[id], /calendar, /admin, /admin/people, /settings/*)
    ├── components/
    │   ├── kinetic/            # ArchitecturalRelayCanvas (Light/Dark + Trilingual), Interactive3DCard, BriefProgressChain, StatePulseBeacon, ExecutionTopologyRibbon
    │   ├── shell/              # AppShell (2-col Messenger + centered CSS Grid Workbench top bar), WorkbenchDrawerSlot, DemoPersonaSwitcher, NoticesPopover
    │   └── ui/                 # PreferencesControls (LanguageSwitcher/ThemeToggle/PreferencesBar), Button, Avatar, StatusBadge, ConfirmDialog, Modal, AccessNoticeCard, SourceTag
    ├── features/               # Feature modules (auth, inbox, chat, calendar, settings, workbench, orders, proposals, admin, people)
    ├── lib/
    │   ├── i18n/               # Trilingual engine (zh-CN/zh-HK/en), tp() plurals, dictionaries/*, structured chat-format.ts
    │   ├── theme-context.tsx   # Cookie-only Light/Dark theme provider + smooth crossfade
    │   ├── bff/                # config, proxy, sanitize, demo-auth, directory
    │   ├── mcp/                # client (Streamable HTTP JSON-RPC), connectors, trilingual nl-meeting, ics
    │   └── ...                 # api-client (authGeneration/CSRF), format (HKT helpers), session-context, workbench-context, types
    └── styles/tokens.css       # Frosted Alabaster (Light) & Obsidian Porcelain (Dark) AA+ design tokens & spring physics
```
