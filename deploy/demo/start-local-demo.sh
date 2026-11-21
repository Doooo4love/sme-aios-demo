#!/usr/bin/env bash
# ==============================================================================
# SME AIOS Enterprise Workbench — Local & $0 Cloudflare Tunnel Demo Launcher
# ==============================================================================
# Supports:
#   1. Single-process keyless mode (default):
#      - :8760 FastAPI (AIOS_WORKBENCH_PLANNER=local + Assurance demo key)
#      - :3000 Next.js Same-Origin BFF
#   2. Dual-port Cloud LLM + Assurance mode (--mode dual):
#      - :8760 FastAPI (AIOS_WORKBENCH_PLANNER=pydantic-ai; requires AIOS_LLM_*)
#      - :8761 FastAPI (AIOS_WORKBENCH_PLANNER=local + Assurance demo key,
#              sharing the exact same state dir & browser session encryption key)
#      - :3000 Next.js BFF with AIOS_ASSURANCE_API_BASE_URL=http://127.0.0.1:8761
#   3. $0 Public HTTPS Demo (--tunnel):
#      - Starts `cloudflared tunnel --url http://127.0.0.1:3000` first, captures
#        the exact https://*.trycloudflare.com origin, and sets AIOS_BROWSER_ORIGIN
#        so FastAPI issues Secure `__Host-aios_session` cookies and passes Origin checks.
#
# Usage:
#   ./deploy/demo/start-local-demo.sh                     # keyless local dev
#   ./deploy/demo/start-local-demo.sh --tunnel            # $0 public HTTPS demo
#   ./deploy/demo/start-local-demo.sh --mode dual         # Cloud LLM + Assurance
#   ./deploy/demo/start-local-demo.sh --prod --tunnel     # production Next build + tunnel
#   ./deploy/demo/start-local-demo.sh --reset-state       # wipe SQLite state first
# ==============================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WEB_DIR="${ROOT_DIR}/web"
PYTHON_BIN="${AIOS_PYTHON_BIN:-${ROOT_DIR}/.venv/bin/python}"
UVICORN_BIN="${AIOS_UVICORN_BIN:-${ROOT_DIR}/.venv/bin/uvicorn}"

MODE="single"          # single | dual
USE_TUNNEL="0"         # 0 | 1
USE_PROD_WEB="0"       # 0 (next dev) | 1 (next start)
RUN_WORKER="0"         # 0 (manual admin worker-tick) | 1 (background run_worker)
RESET_STATE="0"        # 0 | 1
CUSTOM_ORIGIN=""       # optional fixed origin (e.g. https://demo.example.com)
STATE_DIR="${AIOS_PLATFORM_STATE_DIR:-${ROOT_DIR}/.state/workbench-demo}"
API_PORT="${AIOS_API_PORT:-8760}"
ASSURANCE_PORT="${AIOS_ASSURANCE_PORT:-8761}"
WEB_PORT="${AIOS_WEB_PORT:-3000}"

print_help() {
  cat <<'EOF'
SME AIOS Local & $0 Tunnel Demo Launcher

Options:
  --mode single|dual     single (default): :8760 local rules + Assurance
                         dual: :8760 pydantic-ai Cloud LLM + :8761 Assurance
  --tunnel               Launch Cloudflare Quick Tunnel ($0 HTTPS URL) first
  --origin <https://...> Fixed browser origin (e.g. Cloudflare Named Tunnel)
  --prod                 Run Next.js production server (`pnpm start`) instead of `pnpm dev`
  --worker               Also start background ERP outbox worker (`run_worker`)
  --state-dir <path>     SQLite & demo key directory (default: .state/workbench-demo)
  --reset-state          Delete existing SQLite databases before starting
  -h, --help             Show this help message

Dual-mode Cloud LLM environment variables (when --mode dual):
  AIOS_LLM_BASE_URL      Must start with https:// (e.g. https://api.deepseek.com)
  AIOS_LLM_MODEL         Model identifier (e.g. deepseek-chat)
  AIOS_LLM_API_KEY       Server-only API key (or AIOS_LLM_API_KEY_FILE)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      MODE="${2:-}"
      shift 2
      ;;
    --tunnel)
      USE_TUNNEL="1"
      shift
      ;;
    --origin)
      CUSTOM_ORIGIN="${2:-}"
      shift 2
      ;;
    --prod)
      USE_PROD_WEB="1"
      shift
      ;;
    --worker)
      RUN_WORKER="1"
      shift
      ;;
    --state-dir)
      STATE_DIR="${2:-}"
      shift 2
      ;;
    --reset-state)
      RESET_STATE="1"
      shift
      ;;
    -h|--help)
      print_help
      exit 0
      ;;
    *)
      echo "[error] Unknown argument: $1" >&2
      print_help >&2
      exit 1
      ;;
  esac
done

if [[ "${MODE}" != "single" && "${MODE}" != "dual" ]]; then
  echo "[error] --mode must be 'single' or 'dual' (got: ${MODE})" >&2
  exit 1
fi

if [[ ! -x "${PYTHON_BIN}" ]]; then
  PYTHON_BIN="$(command -v python3 || true)"
fi
if [[ ! -x "${UVICORN_BIN}" ]]; then
  UVICORN_BIN="$(command -v uvicorn || true)"
fi
if [[ -z "${PYTHON_BIN}" || -z "${UVICORN_BIN}" ]]; then
  echo "[error] Python / uvicorn not found. Activate .venv or install requirements-platform.txt." >&2
  exit 1
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo "[error] pnpm is required to run web/." >&2
  exit 1
fi

if [[ "${MODE}" == "dual" ]]; then
  if [[ -z "${AIOS_LLM_BASE_URL:-}" || -z "${AIOS_LLM_MODEL:-}" || ( -z "${AIOS_LLM_API_KEY:-}" && -z "${AIOS_LLM_API_KEY_FILE:-}" ) ]]; then
    echo "[error] --mode dual requires AIOS_LLM_BASE_URL (https://...), AIOS_LLM_MODEL, and AIOS_LLM_API_KEY (or AIOS_LLM_API_KEY_FILE)." >&2
    exit 1
  fi
fi

mkdir -p "${STATE_DIR}"
chmod 700 "${STATE_DIR}"

if [[ "${RESET_STATE}" == "1" ]]; then
  echo "[demo] Resetting SQLite state in ${STATE_DIR}..."
  rm -f "${STATE_DIR}/store.sqlite" "${STATE_DIR}/store.sqlite-wal" "${STATE_DIR}/store.sqlite-shm" \
        "${STATE_DIR}/erp.sqlite" "${STATE_DIR}/erp.sqlite-wal" "${STATE_DIR}/erp.sqlite-shm"
fi

# Persist or generate server-only demo secrets (NEVER printed to stdout)
DEMO_SECRET_FILE="${STATE_DIR}/.demo-secret"
SESSION_KEY_FILE="${STATE_DIR}/.session-key"
ASSURANCE_KEY_FILE="${STATE_DIR}/assurance-demo-key.json"

if [[ -n "${AIOS_DEMO_SECRET:-}" ]]; then
  DEMO_SECRET="${AIOS_DEMO_SECRET}"
elif [[ -f "${DEMO_SECRET_FILE}" ]]; then
  DEMO_SECRET="$(cat "${DEMO_SECRET_FILE}")"
else
  DEMO_SECRET="$("${PYTHON_BIN}" -c 'import secrets; print(secrets.token_urlsafe(32).replace(".", "-"))')"
  (umask 077 && printf '%s' "${DEMO_SECRET}" > "${DEMO_SECRET_FILE}")
fi

if [[ -n "${AIOS_BROWSER_SESSION_KEY:-}" ]]; then
  SESSION_KEY="${AIOS_BROWSER_SESSION_KEY}"
elif [[ -f "${SESSION_KEY_FILE}" ]]; then
  SESSION_KEY="$(cat "${SESSION_KEY_FILE}")"
else
  SESSION_KEY="$("${PYTHON_BIN}" -c 'import secrets; print(secrets.token_hex(32))')"
  (umask 077 && printf '%s' "${SESSION_KEY}" > "${SESSION_KEY_FILE}")
fi

if [[ ! -f "${ASSURANCE_KEY_FILE}" ]]; then
  echo "[demo] Generating private (0600) Assurance demo key at ${ASSURANCE_KEY_FILE}..."
  (cd "${ROOT_DIR}" && "${PYTHON_BIN}" -m aios_platform.assurance_audit keygen "${ASSURANCE_KEY_FILE}")
fi
chmod 600 "${ASSURANCE_KEY_FILE}"

PIDS=()
TUNNEL_LOG=""

cleanup() {
  local exit_code=$?
  echo ""
  echo "[demo] Shutting down processes..."
  for pid in "${PIDS[@]:-}"; do
    if kill -0 "${pid}" 2>/dev/null; then
      kill "${pid}" 2>/dev/null || true
    fi
  done
  wait 2>/dev/null || true
  if [[ -n "${TUNNEL_LOG}" && -f "${TUNNEL_LOG}" ]]; then
    rm -f "${TUNNEL_LOG}"
  fi
  exit "${exit_code}"
}
trap cleanup INT TERM EXIT

# Determine exact AIOS_BROWSER_ORIGIN (start Quick Tunnel first if requested)
BROWSER_ORIGIN="${CUSTOM_ORIGIN:-${AIOS_BROWSER_ORIGIN:-http://localhost:${WEB_PORT}}}"

if [[ "${USE_TUNNEL}" == "1" ]]; then
  if ! command -v cloudflared >/dev/null 2>&1; then
    echo "[error] cloudflared not found. Install with: brew install cloudflared" >&2
    exit 1
  fi
  TUNNEL_LOG="$(mktemp)"
  echo "[demo] Starting Cloudflare Quick Tunnel -> http://127.0.0.1:${WEB_PORT}..."
  cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:${WEB_PORT}" >"${TUNNEL_LOG}" 2>&1 &
  PIDS+=("$!")

  DETECTED_URL=""
  for _ in $(seq 1 40); do
    DETECTED_URL="$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "${TUNNEL_LOG}" | head -n 1 || true)"
    if [[ -n "${DETECTED_URL}" ]]; then
      break
    fi
    sleep 0.5
  done

  if [[ -z "${DETECTED_URL}" ]]; then
    echo "[error] Timed out waiting for cloudflared Quick Tunnel URL. Log output:" >&2
    cat "${TUNNEL_LOG}" >&2
    exit 1
  fi
  BROWSER_ORIGIN="${DETECTED_URL}"
  echo "[demo] Public HTTPS Quick Tunnel ready: ${BROWSER_ORIGIN}"
fi

wait_for_http() {
  local url="$1"
  local label="$2"
  for _ in $(seq 1 60); do
    if curl -fsS "${url}" >/dev/null 2>&1; then
      echo "[demo] ${label} is ready (${url})"
      return 0
    fi
    sleep 0.5
  done
  echo "[error] Timed out waiting for ${label} at ${url}" >&2
  return 1
}

# Start FastAPI backend(s)
if [[ "${MODE}" == "single" ]]; then
  echo "[demo] Starting single-process FastAPI (local planner + Assurance) on 127.0.0.1:${API_PORT}..."
  (
    cd "${ROOT_DIR}"
    export AIOS_PROFILE=demo
    export AIOS_PLATFORM_STATE_DIR="${STATE_DIR}"
    export AIOS_DEMO_SECRET="${DEMO_SECRET}"
    export AIOS_BROWSER_ORIGIN="${BROWSER_ORIGIN}"
    export AIOS_BROWSER_SESSION_KEY="${SESSION_KEY}"
    export AIOS_PLANNER=demo
    export AIOS_WORKBENCH_PLANNER=local
    export AIOS_ASSURANCE_DEMO_KEY_FILE="${ASSURANCE_KEY_FILE}"
    exec "${UVICORN_BIN}" aios_platform.api:create_app --factory \
      --host 127.0.0.1 --port "${API_PORT}" --no-access-log
  ) &
  PIDS+=("$!")
  wait_for_http "http://127.0.0.1:${API_PORT}/readyz" "FastAPI Core + Assurance"
  ASSURANCE_BFF_URL=""
else
  echo "[demo] Starting FastAPI Main API (pydantic-ai Cloud LLM) on 127.0.0.1:${API_PORT}..."
  (
    cd "${ROOT_DIR}"
    export AIOS_PROFILE=demo
    export AIOS_PLATFORM_STATE_DIR="${STATE_DIR}"
    export AIOS_DEMO_SECRET="${DEMO_SECRET}"
    export AIOS_BROWSER_ORIGIN="${BROWSER_ORIGIN}"
    export AIOS_BROWSER_SESSION_KEY="${SESSION_KEY}"
    export AIOS_PLANNER=demo
    export AIOS_WORKBENCH_PLANNER=pydantic-ai
    unset AIOS_ASSURANCE_DEMO_KEY_FILE AIOS_ASSURANCE_KEY_FILE
    exec "${UVICORN_BIN}" aios_platform.api:create_app --factory \
      --host 127.0.0.1 --port "${API_PORT}" --no-access-log
  ) &
  PIDS+=("$!")
  wait_for_http "http://127.0.0.1:${API_PORT}/readyz" "FastAPI Cloud LLM API"

  echo "[demo] Starting FastAPI Assurance Companion on 127.0.0.1:${ASSURANCE_PORT}..."
  (
    cd "${ROOT_DIR}"
    export AIOS_PROFILE=demo
    export AIOS_PLATFORM_STATE_DIR="${STATE_DIR}"
    export AIOS_DEMO_SECRET="${DEMO_SECRET}"
    export AIOS_BROWSER_ORIGIN="${BROWSER_ORIGIN}"
    export AIOS_BROWSER_SESSION_KEY="${SESSION_KEY}"
    export AIOS_PLANNER=demo
    export AIOS_WORKBENCH_PLANNER=local
    export AIOS_ASSURANCE_DEMO_KEY_FILE="${ASSURANCE_KEY_FILE}"
    exec "${UVICORN_BIN}" aios_platform.api:create_app --factory \
      --host 127.0.0.1 --port "${ASSURANCE_PORT}" --no-access-log
  ) &
  PIDS+=("$!")
  wait_for_http "http://127.0.0.1:${ASSURANCE_PORT}/readyz" "FastAPI Assurance Companion"
  ASSURANCE_BFF_URL="http://127.0.0.1:${ASSURANCE_PORT}"
fi

# Optional background ERP worker (omit for interactive admin worker-tick demo)
if [[ "${RUN_WORKER}" == "1" ]]; then
  echo "[demo] Starting background ERP outbox worker..."
  (
    cd "${ROOT_DIR}"
    export AIOS_PROFILE=demo
    export AIOS_PLATFORM_STATE_DIR="${STATE_DIR}"
    export AIOS_DEMO_SECRET="${DEMO_SECRET}"
    exec "${PYTHON_BIN}" -m aios_platform.run_worker
  ) &
  PIDS+=("$!")
fi

# Start Next.js Same-Origin BFF
echo "[demo] Starting Next.js Workbench BFF on 127.0.0.1:${WEB_PORT} (Origin: ${BROWSER_ORIGIN})..."
(
  cd "${WEB_DIR}"
  export AIOS_API_BASE_URL="http://127.0.0.1:${API_PORT}"
  export AIOS_ASSURANCE_API_BASE_URL="${ASSURANCE_BFF_URL}"
  export AIOS_BROWSER_ORIGIN="${BROWSER_ORIGIN}"
  export AIOS_ENABLE_DEMO_AUTH=1
  export AIOS_DEMO_SECRET="${DEMO_SECRET}"
  export AIOS_OIDC_LOGIN_ENABLED=0
  if [[ "${USE_PROD_WEB}" == "1" ]]; then
    if [[ ! -f "${WEB_DIR}/.next/standalone/server.js" ]]; then
      pnpm build
    fi
    if [[ -d "${WEB_DIR}/.next/static" ]]; then
      mkdir -p "${WEB_DIR}/.next/standalone/.next"
      cp -R "${WEB_DIR}/.next/static" "${WEB_DIR}/.next/standalone/.next/"
    fi
    if [[ -d "${WEB_DIR}/public" ]]; then
      cp -R "${WEB_DIR}/public" "${WEB_DIR}/.next/standalone/"
    fi
    export NODE_ENV=production
    export HOSTNAME=127.0.0.1
    export PORT="${WEB_PORT}"
    exec node "${WEB_DIR}/.next/standalone/server.js"
  else
    exec pnpm exec next dev -H 127.0.0.1 -p "${WEB_PORT}"
  fi
) &
PIDS+=("$!")

wait_for_http "http://127.0.0.1:${WEB_PORT}/healthz" "Next.js Workbench BFF"

echo ""
echo "=============================================================================="
echo "  SME AIOS Enterprise Workbench is LIVE"
echo "  Open URL      : ${BROWSER_ORIGIN}/login"
echo "  Mode          : ${MODE} ($([[ "${MODE}" == "dual" ]] && echo "Cloud LLM :${API_PORT} + Assurance :${ASSURANCE_PORT}" || echo "Local Planner + Assurance :${API_PORT}"))"
echo "  Worker        : $([[ "${RUN_WORKER}" == "1" ]] && echo "Automatic background worker" || echo "Manual step via admin /admin worker-tick")"
echo "  State Dir     : ${STATE_DIR}"
echo "  Press Ctrl+C to stop all services cleanly."
echo "=============================================================================="

wait
