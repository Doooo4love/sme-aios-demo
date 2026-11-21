# SME AIOS Enterprise Workbench (`web/`)

Next.js 16 (App Router) + TypeScript strict + Tailwind CSS v4 + unified `radix-ui` enterprise workbench frontend and same-origin BFF for `aios_platform`.

> 完整中文交付文档、API 核对清单、真假数据对照与最小成本部署指南请参见 [docs/workbench-frontend.zh-CN.md](../docs/workbench-frontend.zh-CN.md)。

## Stack Highlights

- **Runtime & UI**: Next.js `16.4.x` (`output: "standalone"`), React `19.3.x`, TypeScript `5.9.x` (`strict: true`, `noUncheckedIndexedAccess: true`), Tailwind CSS `v4`, unified `radix-ui`, `lucide-react`, `zod`.
- **Same-Origin BFF (`src/app/v1/[...path]/route.ts`, `src/lib/bff/*`)**:
  - Proxies strictly allowlisted `/v1/*`, `/healthz`, and `/readyz` routes to `aios_platform`.
  - Supports optional split-upstream routing via `AIOS_ASSURANCE_API_BASE_URL` so `/v1/assurance/*` can run on a dedicated Assurance process (`:8761`) while the main workbench uses `AIOS_WORKBENCH_PLANNER=pydantic-ai` (`:8760`).
  - Enforces server-side `Origin` checks, relays HttpOnly cookies (`aios_demo_session` / `__Host-aios_session`) via `getSetCookie()`, strips `capabilities.planner` and forbidden internal/LLM keys, normalizes all `404` responses to uniform `RECORD_UNAVAILABLE`, sanitizes `422`/`5xx` payloads, and sets `Cache-Control: no-store`.
- **Client Auth & Anti-Leak Hygiene (`src/lib/api-client.ts`, `src/lib/session-context.tsx`)**:
  - `csrf_token`, drafts, and business objects live strictly in memory (zero `localStorage` / `sessionStorage` business payloads, zero `NEXT_PUBLIC_*` secrets).
  - `authGeneration` + `AbortController` registry immediately aborts in-flight fetches, drops late responses from previous personas, and revokes transient `blob:` preview URLs on `401`, logout, or demo persona switch.
- **Anti-AI-Slop Visual System & QZT 3D Stage (`src/styles/tokens.css`, `src/components/kinetic/*`)**:
  - Warm paper canvas (`#F4F3EF`), crisp sheets (`#FFFFFF`), warm secondary plane (`#ECEAE4`), deep graphite ink (`#14181F`), single cool cyan-blue accent (`#0C6E91`), `1px` hairlines, `.tabular-nums`, and `prefers-reduced-motion` support.
  - Obsidian 3D Canvas 2D stage (`ArchitecturalRelayCanvas`) confined strictly to `/login`; real-state `StatePulseBeacon` and `ExecutionTopologyRibbon` with zero fake progress bars.

---

## Quick Start

### Option A · One-Command Keyless Local Demo (Single Process: Local Rules + Assurance)

From repository root (`/Users/rexzheng/Documents/AIOS`):

```bash
./deploy/demo/start-local-demo.sh
```

Open **http://localhost:3000/login** and pick any of the 11 controlled demo personas (`operator`, `manager`, `finance`, `access-admin`, `admin`, `other-manager`, `island-manager`, `viewer`, `quality`, `legal`, `executive`).

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

### Option D · Manual Two-Terminal Dev Startup

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

All variables are **server-only**. Never prefix any secret or backend URL with `NEXT_PUBLIC_`.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `AIOS_API_BASE_URL` | Yes | `http://127.0.0.1:8760` | Internal FastAPI base URL for `/v1/*`, `/healthz`, `/readyz`. |
| `AIOS_ASSURANCE_API_BASE_URL` | Optional | *(falls back to `AIOS_API_BASE_URL`)* | Dedicated Assurance backend URL (e.g. `http://127.0.0.1:8761`) in dual-port Cloud LLM + Assurance setups. |
| `AIOS_BROWSER_ORIGIN` | Yes | `http://localhost:3000` | Exact browser origin (`scheme://host[:port]`) validated on all mutations and forwarded to FastAPI. Must match FastAPI's `AIOS_BROWSER_ORIGIN`. |
| `AIOS_ENABLE_DEMO_AUTH` | Demo only | `0` | Set to `1` ONLY in local/demo environments to enable `/api/auth/demo-login`. |
| `AIOS_DEMO_SECRET` | Demo only | — | Must match FastAPI `AIOS_DEMO_SECRET` (`>= 32` chars, no `.`). Held exclusively on the BFF server. |
| `AIOS_OIDC_LOGIN_ENABLED` | Optional | `1` when demo auth is disabled | Controls visibility of the enterprise OIDC (`/v1/session/login`) button on `/login`. |

---

## Scripts & Verification

```bash
pnpm --dir web install       # Install dependencies (pnpm 11 + Node 26)
pnpm --dir web dev           # Local dev server on 127.0.0.1:3000
pnpm --dir web typecheck     # Strict TypeScript check (`tsc --noEmit`)
pnpm --dir web build         # Production Turbopack standalone build (`.next/standalone/server.js`)
pnpm --dir web test:e2e      # Run full Playwright E2E + security regression suite (15 tests, desktop + mobile)
```

> **Production Standalone Runtime**: Because `next.config.ts` enables `output: "standalone"`, run production servers with `cp -R web/.next/static web/.next/standalone/.next/ && HOSTNAME=127.0.0.1 PORT=3000 node web/.next/standalone/server.js` (handled automatically by `./deploy/demo/start-local-demo.sh --prod` and `deploy/demo/aios-demo-web.service`).
>
> **First-time Playwright setup**: Install Chromium once via `pnpm --dir web exec playwright install chromium`. Run E2E tests against a live FastAPI + Next.js stack (`PLAYWRIGHT_BASE_URL=http://localhost:3000 pnpm --dir web test:e2e`). Latest full live verification: **15/15 PASS** (desktop `1440x900` + mobile `390x844` + live Assurance `PO-100` + zero-leak audit), curated screenshots saved in `web/e2e/screenshots/`.

---

## Project Layout

```text
web/
├── playwright.config.ts        # Desktop (1440x900) + Mobile (390x844) sequential E2E config
├── e2e/
│   ├── helpers/workbench.ts    # Login/switch helpers, BFF fetcher, zero-leak runtime auditor
│   ├── 01-auth-shell-profile.spec.ts
│   ├── 02-order-approval-receipt.spec.ts
│   ├── 03-module-access-and-isolation.spec.ts
│   ├── 04-collaboration-roles-calendar.spec.ts
│   ├── 05-security-errors-resilience.spec.ts
│   └── screenshots/            # Key-flow verification screenshots
└── src/
    ├── app/
    │   ├── v1/[...path]/       # Same-origin sanitized BFF proxy
    │   ├── healthz/ & readyz/  # Public health/readiness passthrough
    │   ├── api/auth/           # Controlled server-side demo login & persona metadata
    │   ├── login/              # Split authentication view + QZT 3D ArchitecturalRelayCanvas
    │   └── (app)/              # Authenticated AppShell routes (/inbox, /work, /orders/new, /proposals/[id], /calendar, /admin, /admin/people, /settings/*)
    ├── components/
    │   ├── kinetic/            # ArchitecturalRelayCanvas, StatePulseBeacon, ExecutionTopologyRibbon
    │   ├── shell/              # AppShell, WorkbenchDrawerSlot, DemoPersonaSwitcher, NoticesPopover
    │   └── ui/                 # Button, StatusBadge, ConfirmDialog, Modal, AccessNoticeCard, Avatar, SourceTag
    ├── features/               # Feature modules (inbox, chat, calendar, settings, workbench, orders, proposals, admin, people)
    ├── lib/                    # BFF config/proxy/sanitize, api-client (authGeneration/CSRF), contexts, types
    └── styles/tokens.css       # Anti-AI-Slop v2 harmonized tokens
```
