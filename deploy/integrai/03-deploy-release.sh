#!/usr/bin/env bash
# ==============================================================================
# IntegrAI Pinned-SHA Release Installer & Rollback Tool (03-deploy-release.sh)
# ==============================================================================
# Deploys a pinned 40-character Git commit SHA on Linux x86_64:
#   1. Checks out pinned SHA in /opt/aios (recording .previous-sha for rollback)
#      and installs /opt/aios/.venv (`requirements-platform.txt` +
#      `requirements-platform-harness.txt`).
#   2. Stages a verified Linux x86_64 Next.js standalone release into
#      `/opt/aios-web/releases/<short-sha>-<utc-ts>/` via either:
#        - `--web-tarball <path>` (RECOMMENDED: CI artifact from release-linux-x64.yml)
#        - `--build-local`        (Optional on-box Linux x86_64 build with RAM/swap check)
#      Verifies `server.js` layout, syntax (`node --check`), Linux x86_64 ELF `.node`
#      addons, and atomically swaps `/opt/aios-web/current` (saving `previous`).
#   3. Installs hardened systemd units, enables & restarts `:8760`, `:8761`, `:3000`.
#   4. Verifies `/readyz` on `:8760`, `:8761`, `:3000` and confirms `ss -lntup`
#      loopback-only (`127.0.0.1`) bindings.
#
# Safety guarantees:
#   - NEVER touches, wipes, or resets `/var/lib/aios/state` (no `--reset-state`).
#   - NEVER prints or logs any secret or env file contents.
#   - Rejects Mac ARM64 / Darwin native binaries or SHA-mismatched web bundles.
#
# Usage:
#   # Step A (first-time bootstrap before 02-init-secrets.sh):
#   sudo ./deploy/integrai/03-deploy-release.sh --prepare-venv --sha <40-char-sha>
#
#   # Step B (standard release with CI Linux x86_64 tarball):
#   sudo ./deploy/integrai/03-deploy-release.sh \
#     --sha <40-char-sha> \
#     --web-tarball /tmp/aios-web-linux-x64-<short-sha>.tar.gz
#
#   # Step B-alt (optional on-box Linux x86_64 build):
#   sudo ./deploy/integrai/03-deploy-release.sh --sha <40-char-sha> --build-local
#
#   # Instant rollback to previous release (preserves SQLite state):
#   sudo ./deploy/integrai/03-deploy-release.sh --rollback
# ==============================================================================
set +x
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "[error] Must be run as root (use sudo)." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="/opt/aios"
WEB_BASE="/opt/aios-web"
RELEASES_DIR="${WEB_BASE}/releases"
REPO_URL="https://github.com/Doooo4love/sme-aios-demo.git"

TARGET_SHA=""
WEB_TARBALL=""
CHECKSUMS_FILE=""
BUILD_LOCAL="0"
PREPARE_VENV_ONLY="0"
DO_ROLLBACK="0"
KEEP_RELEASES="3"
INSTALL_BACKUP_TIMER="0"

print_help() {
  cat <<'EOF'
IntegrAI Pinned-SHA Release Installer

Options:
  --sha <40-char-sha>       Pinned 40-char hex Git commit SHA (required unless --rollback)
  --web-tarball <path>      Path to CI-built aios-web-linux-x64-<short-sha>.tar.gz
  --checksums <path>        Optional SHA256SUMS file (auto-detected if beside tarball)
  --build-local             Build Next.js standalone directly on this Linux x86_64 host
  --prepare-venv            Only checkout pinned SHA & install /opt/aios/.venv (bootstrap)
  --rollback                Atomically roll back web (/opt/aios-web/previous) & backend
                            (.previous-sha) without touching SQLite state
  --repo-url <url>          Git remote URL when cloning /opt/aios initially
                            (default: https://github.com/Doooo4love/sme-aios-demo.git)
  --keep-releases <N>       Number of old web releases to retain (default: 3)
  --enable-backup-timer     Also install & enable aios-sqlite-backup.timer
  -h, --help                Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --sha)
      TARGET_SHA="${2:-}"
      shift 2
      ;;
    --web-tarball)
      WEB_TARBALL="${2:-}"
      shift 2
      ;;
    --checksums)
      CHECKSUMS_FILE="${2:-}"
      shift 2
      ;;
    --build-local)
      BUILD_LOCAL="1"
      shift
      ;;
    --prepare-venv)
      PREPARE_VENV_ONLY="1"
      shift
      ;;
    --rollback)
      DO_ROLLBACK="1"
      shift
      ;;
    --repo-url)
      REPO_URL="${2:-}"
      shift 2
      ;;
    --keep-releases)
      KEEP_RELEASES="${2:-}"
      shift 2
      ;;
    --enable-backup-timer)
      INSTALL_BACKUP_TIMER="1"
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

# ------------------------------------------------------------------------------
# Common helpers
# ------------------------------------------------------------------------------
assert_host_baseline() {
  local kernel arch
  kernel="$(uname -s)"
  arch="$(uname -m)"
  if [[ "${kernel}" != "Linux" || "${arch}" != "x86_64" ]]; then
    echo "[error] Target host must be Linux x86_64 (got ${kernel}/${arch})." >&2
    exit 1
  fi
  if ! id aios-demo >/dev/null 2>&1; then
    echo "[error] User 'aios-demo' does not exist." >&2
    exit 1
  fi
  if [[ "${PREPARE_VENV_ONLY}" == "0" ]]; then
    if ! command -v node >/dev/null 2>&1; then
      echo "[error] Node.js 22 is required at /usr/bin/node." >&2
      exit 1
    fi
    local node_ver
    node_ver="$(node -v)"
    if [[ ! "${node_ver}" =~ ^v22\. ]]; then
      echo "[error] Expected Node.js v22.x (got ${node_ver})." >&2
      exit 1
    fi
  fi
}

assert_secrets_ready() {
  local missing=0
  for f in \
    /etc/aios/demo-common.env \
    /etc/aios/demo-api.env \
    /etc/aios/demo-assurance.env \
    /etc/aios/demo-web.env \
    /etc/aios/secrets/llm-api-key \
    /etc/aios/secrets/assurance-demo-key.json; do
    if [[ ! -f "${f}" ]]; then
      echo "[error] Missing required config/secret file: ${f}" >&2
      missing=1
      continue
    fi
    local mode world_digit
    mode="$(stat -c '%a' "${f}")"
    world_digit="${mode: -1}"
    if [[ "${world_digit}" != "0" ]]; then
      echo "[error] Refusing to start with world-accessible permissions on ${f} (mode ${mode})." >&2
      missing=1
    fi
  done
  if [[ "${missing}" -ne 0 ]]; then
    echo "[error] Initialize secrets first with: sudo ./deploy/integrai/02-init-secrets.sh --origin https://integrai.<confirmed-domain>" >&2
    exit 1
  fi
}

verify_web_bundle_tree() {
  local dir="$1"
  if [[ ! -f "${dir}/server.js" ]]; then
    echo "[error] Staged web release is missing root server.js: ${dir}" >&2
    exit 1
  fi
  /usr/bin/node --check "${dir}/server.js"

  # Ensure no macOS/Darwin or non-x86_64 native binaries exist
  if find "${dir}" -iname "*darwin*" -print -quit | grep -q .; then
    echo "[error] Refusing deployment: darwin/macOS binary path detected in ${dir}!" >&2
    exit 1
  fi
  if command -v file >/dev/null 2>&1; then
    while IFS= read -r -d '' addon; do
      local desc
      desc="$(file -b "${addon}")"
      if [[ "${desc}" != *"ELF 64-bit"* || "${desc}" != *"x86-64"* ]]; then
        echo "[error] Refusing deployment: non-Linux-x86_64 native addon ${addon} (${desc})" >&2
        exit 1
      fi
    done < <(find "${dir}" -type f -name "*.node" -print0)
  fi

  if ! find "${dir}" -maxdepth 3 -path "*/.next/static" -type d -print -quit | grep -q .; then
    echo "[error] Staged web release is missing .next/static assets in ${dir}" >&2
    exit 1
  fi
}

install_systemd_units() {
  local unit_src="${APP_DIR}/deploy/integrai/systemd"
  if [[ ! -d "${unit_src}" ]]; then
    unit_src="${SCRIPT_DIR}/systemd"
  fi
  for unit in aios-demo-api.service aios-demo-assurance.service aios-demo-web.service; do
    if [[ ! -f "${unit_src}/${unit}" ]]; then
      echo "[error] Missing systemd unit template: ${unit_src}/${unit}" >&2
      exit 1
    fi
    install -o root -g root -m 0644 "${unit_src}/${unit}" "/etc/systemd/system/${unit}"
  done

  if [[ "${INSTALL_BACKUP_TIMER}" == "1" ]]; then
    for unit in aios-sqlite-backup.service aios-sqlite-backup.timer; do
      install -o root -g root -m 0644 "${unit_src}/${unit}" "/etc/systemd/system/${unit}"
    done
  fi

  systemctl daemon-reload
  systemctl enable aios-demo-api.service aios-demo-assurance.service aios-demo-web.service
  if [[ "${INSTALL_BACKUP_TIMER}" == "1" ]]; then
    systemctl enable --now aios-sqlite-backup.timer
  fi
}

wait_for_readyz() {
  local url="$1"
  local label="$2"
  local attempt
  for attempt in $(seq 1 30); do
    if body="$(curl -fsS --max-time 3 "${url}" 2>/dev/null)"; then
      if grep -q '"ready"' <<<"${body}" || grep -q '"up"' <<<"${body}"; then
        echo "[ok] ${label} ready (${url})"
        return 0
      fi
    fi
    sleep 1
  done
  echo "[error] Timed out waiting for ${label} at ${url}" >&2
  return 1
}

restart_and_verify_services() {
  echo "[deploy] Restarting services in dependency order..."
  systemctl restart aios-demo-api.service
  wait_for_readyz "http://127.0.0.1:8760/readyz" "Core API (:8760)"

  systemctl restart aios-demo-assurance.service
  wait_for_readyz "http://127.0.0.1:8761/readyz" "Assurance Companion (:8761)"

  systemctl restart aios-demo-web.service
  wait_for_readyz "http://127.0.0.1:3000/readyz" "Next.js BFF (:3000/readyz)"
  wait_for_readyz "http://127.0.0.1:3000/healthz" "Next.js BFF (:3000/healthz)"

  echo "[deploy] Verifying loopback-only TCP bindings (ss -lntup)..."
  ss -lntup | grep -E ':(8760|8761|3000)\b' | sed 's/^/  /' || true
  local tcp_addrs
  tcp_addrs="$(ss -H -lnt | awk '{print $4}')"
  for port in 8760 8761 3000; do
    local found_loopback=0
    while IFS= read -r addr; do
      [[ -z "${addr}" ]] && continue
      if [[ "${addr}" == "127.0.0.1:${port}" ]]; then
        found_loopback=1
      elif [[ "${addr}" == *":${port}" ]]; then
        echo "[error] Security violation: port ${port} is bound to non-loopback address ${addr}!" >&2
        exit 1
      fi
    done <<<"${tcp_addrs}"
    if [[ "${found_loopback}" -ne 1 ]]; then
      echo "[error] Expected 127.0.0.1:${port} to be listening, but it was not found." >&2
      exit 1
    fi
    echo "[ok] Port ${port} bound strictly to 127.0.0.1"
  done
}

sync_python_venv() {
  if [[ ! -d "${APP_DIR}/.venv" ]]; then
    echo "[deploy] Creating Python venv at ${APP_DIR}/.venv..."
    python3 -m venv "${APP_DIR}/.venv"
  fi
  echo "[deploy] Installing Python platform + harness dependencies..."
  "${APP_DIR}/.venv/bin/python" -m pip install --upgrade pip >/dev/null
  "${APP_DIR}/.venv/bin/python" -m pip install \
    -r "${APP_DIR}/requirements-platform.txt" \
    -r "${APP_DIR}/requirements-platform-harness.txt"

  # Smoke-verify imports without touching secrets or SQLite state
  (
    cd "${APP_DIR}"
    "${APP_DIR}/.venv/bin/python" -c "import aios_platform.api, aios_platform.assurance_audit, pydantic_ai; print('[ok] Python backend + pydantic-ai imports verified')"
  )

  # Ensure executable deploy scripts remain executable and code is read-only to aios-demo
  chmod 0750 "${APP_DIR}"/deploy/integrai/*.sh 2>/dev/null || true
  chown -R root:aios-demo "${APP_DIR}"
  chmod -R g+rX,o-w "${APP_DIR}"
  # Ensure aios-demo can traverse and execute scripts/venv cleanly
  chmod 0750 "${APP_DIR}"
}

git_app() {
  git -c safe.directory="${APP_DIR}" -C "${APP_DIR}" "$@"
}

print_runtime_summary() {
  local active_sha active_web
  active_sha="$(git_app rev-parse HEAD 2>/dev/null || printf 'unknown')"
  active_web="$(readlink -f "${WEB_BASE}/current" 2>/dev/null || printf 'none')"
  echo ""
  echo "=============================================================================="
  echo "  IntegrAI Release Active"
  echo "  Backend SHA : ${active_sha}"
  echo "  Web Release : ${active_web}"
  for svc in aios-demo-api.service aios-demo-assurance.service aios-demo-web.service; do
    if systemctl is-active --quiet "${svc}"; then
      mem_cur="$(systemctl show -p MemoryCurrent --value "${svc}" 2>/dev/null || printf 'n/a')"
      printf '  %-30s active (MemoryCurrent=%s bytes)\n' "${svc}" "${mem_cur}"
    fi
  done
  echo "=============================================================================="
}

# ------------------------------------------------------------------------------
# Mode 1: Instant Rollback
# ------------------------------------------------------------------------------
if [[ "${DO_ROLLBACK}" == "1" ]]; then
  assert_host_baseline
  assert_secrets_ready

  if [[ ! -L "${WEB_BASE}/previous" ]]; then
    echo "[error] No ${WEB_BASE}/previous symlink recorded; cannot auto-rollback web." >&2
    exit 1
  fi
  PREV_WEB="$(readlink -f "${WEB_BASE}/previous")"
  if [[ ! -d "${PREV_WEB}" || ! -f "${PREV_WEB}/server.js" ]]; then
    echo "[error] Previous web release directory invalid: ${PREV_WEB}" >&2
    exit 1
  fi

  echo "[rollback] Rolling back web symlink to ${PREV_WEB}..."
  verify_web_bundle_tree "${PREV_WEB}"
  CURRENT_WEB=""
  if [[ -L "${WEB_BASE}/current" ]]; then
    CURRENT_WEB="$(readlink -f "${WEB_BASE}/current" || true)"
  fi
  ln -s "${PREV_WEB}" "${WEB_BASE}/.current.rollback"
  mv -Tf "${WEB_BASE}/.current.rollback" "${WEB_BASE}/current"
  if [[ -n "${CURRENT_WEB}" && "${CURRENT_WEB}" != "${PREV_WEB}" ]]; then
    ln -s "${CURRENT_WEB}" "${WEB_BASE}/.previous.rollback"
    mv -Tf "${WEB_BASE}/.previous.rollback" "${WEB_BASE}/previous"
  fi

  if [[ -f "${APP_DIR}/.previous-sha" ]]; then
    PREV_SHA="$(tr -d '[:space:]' < "${APP_DIR}/.previous-sha")"
    if [[ "${PREV_SHA}" =~ ^[0-9a-fA-F]{40}$ ]]; then
      CUR_SHA="$(git_app rev-parse HEAD 2>/dev/null || true)"
      echo "[rollback] Rolling back backend ${APP_DIR} to ${PREV_SHA}..."
      git_app checkout --detach "${PREV_SHA}"
      if [[ -n "${CUR_SHA}" && "${CUR_SHA}" != "${PREV_SHA}" ]]; then
        printf '%s\n' "${CUR_SHA}" > "${APP_DIR}/.previous-sha"
      fi
      sync_python_venv
    fi
  else
    echo "[warn] ${APP_DIR}/.previous-sha not found; backend SHA unchanged."
  fi

  install_systemd_units
  restart_and_verify_services
  print_runtime_summary
  exit 0
fi

# ------------------------------------------------------------------------------
# Mode 2: Forward Pinned-SHA Deploy (or --prepare-venv bootstrap)
# ------------------------------------------------------------------------------
if [[ ! "${TARGET_SHA}" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "[error] --sha must be an exact 40-character hexadecimal Git commit SHA (got: '${TARGET_SHA}')." >&2
  exit 1
fi
TARGET_SHA="$(tr '[:upper:]' '[:lower:]' <<<"${TARGET_SHA}")"
SHORT_SHA="${TARGET_SHA:0:12}"

if [[ "${PREPARE_VENV_ONLY}" == "0" ]]; then
  if [[ -n "${WEB_TARBALL}" && "${BUILD_LOCAL}" == "1" ]]; then
    echo "[error] Specify either --web-tarball OR --build-local, not both." >&2
    exit 1
  fi
  if [[ -z "${WEB_TARBALL}" && "${BUILD_LOCAL}" == "0" ]]; then
    echo "[error] Specify --web-tarball <path-to-linux-x64-tarball> (recommended) or --build-local." >&2
    exit 1
  fi
fi

if [[ ! "${KEEP_RELEASES}" =~ ^[0-9]+$ || "${KEEP_RELEASES}" -lt 2 ]]; then
  echo "[error] --keep-releases must be an integer >= 2." >&2
  exit 1
fi

assert_host_baseline

# 1. Checkout pinned SHA in /opt/aios
if [[ ! -d "${APP_DIR}/.git" ]]; then
  if [[ -d "${APP_DIR}" && -n "$(ls -A "${APP_DIR}" 2>/dev/null || true)" ]]; then
    echo "[error] ${APP_DIR} exists and is non-empty without .git; inspect manually before deploying." >&2
    exit 1
  fi
  echo "[deploy] Cloning ${REPO_URL} into ${APP_DIR}..."
  mkdir -p "${APP_DIR}"
  git clone --no-checkout "${REPO_URL}" "${APP_DIR}"
fi

# Refuse to clobber dirty local edits
if [[ -n "$(git_app status --porcelain --untracked-files=no 2>/dev/null || true)" ]]; then
  echo "[error] ${APP_DIR} has uncommitted tracked modifications; clean or stash before deploying." >&2
  exit 1
fi

PREV_SHA="$(git_app rev-parse HEAD 2>/dev/null || true)"

echo "[deploy] Fetching commit ${TARGET_SHA}..."
git_app fetch --tags origin
if ! git_app cat-file -e "${TARGET_SHA}^{commit}" 2>/dev/null; then
  git_app fetch origin "${TARGET_SHA}"
fi
if ! git_app cat-file -e "${TARGET_SHA}^{commit}" 2>/dev/null; then
  echo "[error] Commit ${TARGET_SHA} not found in origin (${REPO_URL})." >&2
  exit 1
fi

if [[ -n "${PREV_SHA}" && "${PREV_SHA}" != "${TARGET_SHA}" ]]; then
  printf '%s\n' "${PREV_SHA}" > "${APP_DIR}/.previous-sha"
fi

git_app checkout --detach "${TARGET_SHA}"
RESOLVED_SHA="$(git_app rev-parse HEAD)"
if [[ "${RESOLVED_SHA}" != "${TARGET_SHA}" ]]; then
  echo "[error] Checkout verification failed: expected ${TARGET_SHA}, got ${RESOLVED_SHA}." >&2
  exit 1
fi
echo "[ok] Backend pinned to commit ${RESOLVED_SHA}"

# 2. Install /opt/aios/.venv
sync_python_venv

if [[ "${PREPARE_VENV_ONLY}" == "1" ]]; then
  echo ""
  echo "[ok] Bootstrap complete: ${APP_DIR} pinned to ${RESOLVED_SHA} and ${APP_DIR}/.venv ready."
  echo "     Next step: sudo ${APP_DIR}/deploy/integrai/02-init-secrets.sh --origin https://integrai.<confirmed-domain>"
  exit 0
fi

# 3. Verify secrets exist before deploying web or restarting services
assert_secrets_ready

# 4. Stage Linux x86_64 Next.js standalone release
install -d -o root -g aios-demo -m 0750 "${WEB_BASE}"
install -d -o root -g aios-demo -m 0750 "${RELEASES_DIR}"

UTC_TS="$(date -u +%Y%m%dT%H%M%SZ)"
STAGE_DIR="${RELEASES_DIR}/.staging-${SHORT_SHA}-${UTC_TS}"
RELEASE_DIR="${RELEASES_DIR}/${SHORT_SHA}-${UTC_TS}"

cleanup_stage() {
  if [[ -d "${STAGE_DIR}" ]]; then
    rm -rf "${STAGE_DIR}"
  fi
}
trap cleanup_stage EXIT INT TERM

mkdir -p "${STAGE_DIR}"

if [[ -n "${WEB_TARBALL}" ]]; then
  if [[ ! -f "${WEB_TARBALL}" ]]; then
    echo "[error] Web tarball not found: ${WEB_TARBALL}" >&2
    exit 1
  fi
  WEB_TARBALL="$(readlink -f "${WEB_TARBALL}")"

  # Auto-detect sibling SHA256SUMS if not explicitly supplied
  if [[ -z "${CHECKSUMS_FILE}" ]]; then
    sibling_sums="$(dirname "${WEB_TARBALL}")/SHA256SUMS"
    if [[ -f "${sibling_sums}" ]]; then
      CHECKSUMS_FILE="${sibling_sums}"
    fi
  fi

  if [[ -n "${CHECKSUMS_FILE}" ]]; then
    if [[ ! -f "${CHECKSUMS_FILE}" ]]; then
      echo "[error] Checksums file not found: ${CHECKSUMS_FILE}" >&2
      exit 1
    fi
    CHECKSUMS_FILE="$(readlink -f "${CHECKSUMS_FILE}")"
    tar_base="$(basename "${WEB_TARBALL}")"
    echo "[deploy] Verifying SHA-256 checksum for ${tar_base}..."
    python3 - "${CHECKSUMS_FILE}" "${WEB_TARBALL}" "${tar_base}" <<'PY'
import hashlib, sys
sums_path, tarball_path, tar_base = sys.argv[1], sys.argv[2], sys.argv[3]
expected = None
with open(sums_path, "r", encoding="utf-8") as fh:
    for raw in fh:
        parts = raw.strip().split(None, 1)
        if len(parts) != 2:
            continue
        digest, name = parts[0].lower(), parts[1].lstrip("*").strip()
        if name == tar_base:
            expected = digest
            break
if not expected:
    sys.exit(f"[error] Entry for '{tar_base}' not found in {sums_path}")
h = hashlib.sha256()
with open(tarball_path, "rb") as fh:
    for chunk in iter(lambda: fh.read(1024 * 1024), b""):
        h.update(chunk)
actual = h.hexdigest().lower()
if actual != expected:
    sys.exit(f"[error] SHA-256 mismatch for {tar_base}: expected={expected} actual={actual}")
print(f"[ok] SHA-256 verified for {tar_base} ({actual[:16]}...)")
PY
  else
    echo "[warn] No SHA256SUMS found alongside tarball; proceeding without checksum verification."
  fi

  echo "[deploy] Extracting Linux x86_64 web release tarball..."
  tar -xzf "${WEB_TARBALL}" -C "${STAGE_DIR}"

  if [[ -f "${STAGE_DIR}/RELEASE_METADATA.json" ]]; then
    python3 - "${STAGE_DIR}/RELEASE_METADATA.json" "${TARGET_SHA}" <<'PY'
import json, sys
meta_path, expected_sha = sys.argv[1], sys.argv[2]
meta = json.load(open(meta_path, "r", encoding="utf-8"))
if meta.get("arch") != "linux-x86_64":
    sys.exit(f"[error] Web bundle arch mismatch: expected linux-x86_64, got {meta.get('arch')}")
bundle_sha = str(meta.get("commit_sha", "")).lower()
if bundle_sha != expected_sha:
    sys.exit(f"[error] Web bundle SHA mismatch: tarball={bundle_sha} vs --sha={expected_sha}")
print(f"[ok] Verified RELEASE_METADATA.json (arch=linux-x86_64, sha={bundle_sha})")
PY
  else
    echo "[warn] RELEASE_METADATA.json not present in tarball; verifying bundle tree directly."
  fi
else
  # Optional on-box Linux x86_64 build path
  if ! command -v pnpm >/dev/null 2>&1; then
    echo "[error] --build-local requires pnpm 11 installed on the host. Prefer CI artifact via --web-tarball." >&2
    exit 1
  fi
  mem_avail_mb="$(awk '/MemAvailable:/ {print int($2/1024)}' /proc/meminfo)"
  swap_free_mb="$(awk '/SwapFree:/ {print int($2/1024)}' /proc/meminfo)"
  total_headroom_mb=$((mem_avail_mb + swap_free_mb))
  echo "[deploy] Local build headroom: MemAvailable=${mem_avail_mb} MiB + SwapFree=${swap_free_mb} MiB = ${total_headroom_mb} MiB"
  if [[ "${total_headroom_mb}" -lt 1536 ]]; then
    echo "[error] Insufficient available RAM+Swap (${total_headroom_mb} MiB < 1536 MiB) for local Next.js build." >&2
    echo "        Build on GitHub Actions (.github/workflows/release-linux-x64.yml) and deploy with --web-tarball." >&2
    exit 1
  fi

  BUILD_TMP="$(mktemp -d /tmp/aios-web-build.XXXXXX)"
  trap 'rm -rf "${BUILD_TMP}"; cleanup_stage' EXIT INT TERM
  cp -a "${APP_DIR}/web/." "${BUILD_TMP}/"
  rm -rf "${BUILD_TMP}/.next"

  echo "[deploy] Building Next.js standalone on Linux x86_64 (NODE_OPTIONS=--max-old-space-size=1536)..."
  (
    cd "${BUILD_TMP}"
    export NEXT_TELEMETRY_DISABLED=1
    export NODE_OPTIONS="--max-old-space-size=1536"
    pnpm install --frozen-lockfile
    pnpm typecheck
    NODE_ENV=production pnpm build
  )

  STANDALONE_ROOT="${BUILD_TMP}/.next/standalone"
  if [[ ! -d "${STANDALONE_ROOT}" ]]; then
    echo "[error] Missing .next/standalone after local build." >&2
    exit 1
  fi

  # Inspect real standalone server.js layout (root vs nested workspace path)
  if [[ -f "${STANDALONE_ROOT}/server.js" ]]; then
    SERVER_REL="server.js"
    SERVER_REL_DIR="."
  else
    mapfile -t FOUND_SERVERS < <(find "${STANDALONE_ROOT}" -maxdepth 3 -name "server.js" -not -path "*/node_modules/*" | sort)
    if [[ "${#FOUND_SERVERS[@]}" -ne 1 ]]; then
      echo "[error] Expected exactly 1 standalone server.js, found ${#FOUND_SERVERS[@]}" >&2
      exit 1
    fi
    SERVER_REL="${FOUND_SERVERS[0]#${STANDALONE_ROOT}/}"
    SERVER_REL_DIR="$(dirname "${SERVER_REL}")"
  fi
  echo "[deploy] Local standalone server entry: ${SERVER_REL}"

  cp -a "${STANDALONE_ROOT}/." "${STAGE_DIR}/"
  if [[ "${SERVER_REL_DIR}" == "." ]]; then
    mkdir -p "${STAGE_DIR}/.next"
    rm -rf "${STAGE_DIR}/.next/static"
    cp -a "${BUILD_TMP}/.next/static" "${STAGE_DIR}/.next/static"
    if [[ -d "${BUILD_TMP}/public" ]]; then
      rm -rf "${STAGE_DIR}/public"
      cp -a "${BUILD_TMP}/public" "${STAGE_DIR}/public"
    fi
  else
    mkdir -p "${STAGE_DIR}/${SERVER_REL_DIR}/.next"
    rm -rf "${STAGE_DIR}/${SERVER_REL_DIR}/.next/static"
    cp -a "${BUILD_TMP}/.next/static" "${STAGE_DIR}/${SERVER_REL_DIR}/.next/static"
    if [[ -d "${BUILD_TMP}/public" ]]; then
      rm -rf "${STAGE_DIR}/${SERVER_REL_DIR}/public"
      cp -a "${BUILD_TMP}/public" "${STAGE_DIR}/${SERVER_REL_DIR}/public"
    fi
    cat > "${STAGE_DIR}/server.js" <<EOF
// Auto-generated standalone entry shim for nested Next.js output layout
const path = require("node:path");
process.chdir(path.join(__dirname, "${SERVER_REL_DIR}"));
require(path.join(__dirname, "${SERVER_REL}"));
EOF
  fi

  python3 - "${STAGE_DIR}/RELEASE_METADATA.json" "${TARGET_SHA}" "${SHORT_SHA}" "${SERVER_REL}" <<'PY'
import json, sys, time
out_path, full_sha, short_sha, server_rel = sys.argv[1:]
with open(out_path, "w", encoding="utf-8") as fh:
    json.dump({
        "product": "integrai-workbench-web",
        "commit_sha": full_sha,
        "short_sha": short_sha,
        "arch": "linux-x86_64",
        "built_on_host": True,
        "built_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "standalone_server_rel": server_rel,
        "entry_script": "server.js",
    }, fh, indent=2, sort_keys=True)
    fh.write("\n")
PY
  rm -rf "${BUILD_TMP}"
fi

# Verify staged web bundle integrity & architecture
verify_web_bundle_tree "${STAGE_DIR}"

# Finalize immutable release directory and atomically swap symlink
mv "${STAGE_DIR}" "${RELEASE_DIR}"
chown -R root:aios-demo "${RELEASE_DIR}"
chmod -R g+rX,o-rwx "${RELEASE_DIR}"
chmod 0750 "${RELEASE_DIR}"

if [[ -e "${WEB_BASE}/current" && ! -L "${WEB_BASE}/current" ]]; then
  echo "[error] ${WEB_BASE}/current exists and is not a symlink; inspect manually before deploying." >&2
  exit 1
fi

OLD_CURRENT=""
if [[ -L "${WEB_BASE}/current" ]]; then
  OLD_CURRENT="$(readlink -f "${WEB_BASE}/current" || true)"
fi

ln -s "${RELEASE_DIR}" "${WEB_BASE}/.current.next"
mv -Tf "${WEB_BASE}/.current.next" "${WEB_BASE}/current"
if [[ -n "${OLD_CURRENT}" && -d "${OLD_CURRENT}" && "${OLD_CURRENT}" != "${RELEASE_DIR}" ]]; then
  ln -s "${OLD_CURRENT}" "${WEB_BASE}/.previous.next"
  mv -Tf "${WEB_BASE}/.previous.next" "${WEB_BASE}/previous"
fi
echo "[ok] Atomically switched ${WEB_BASE}/current -> ${RELEASE_DIR}"

# 5. Install systemd units, restart, and verify readiness & loopback binding
install_systemd_units
restart_and_verify_services

# 6. Prune old web releases (never delete current or previous)
CURRENT_REAL="$(readlink -f "${WEB_BASE}/current" || true)"
PREVIOUS_REAL="$(readlink -f "${WEB_BASE}/previous" 2>/dev/null || true)"
mapfile -t ALL_RELEASES < <(find "${RELEASES_DIR}" -mindepth 1 -maxdepth 1 -type d ! -name '.staging-*' | sort -r)
kept=0
for rel in "${ALL_RELEASES[@]}"; do
  rel_real="$(readlink -f "${rel}")"
  kept=$((kept + 1))
  if [[ "${kept}" -le "${KEEP_RELEASES}" ]]; then
    continue
  fi
  if [[ "${rel_real}" == "${CURRENT_REAL}" || "${rel_real}" == "${PREVIOUS_REAL}" ]]; then
    continue
  fi
  echo "[deploy] Pruning old web release: ${rel}"
  rm -rf "${rel}"
done

print_runtime_summary
