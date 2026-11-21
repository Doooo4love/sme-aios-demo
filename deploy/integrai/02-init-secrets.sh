#!/usr/bin/env bash
# ==============================================================================
# IntegrAI Interactive Secret & Assurance Key Initializer (02-init-secrets.sh)
# ==============================================================================
# Run interactively as root on the target server (NEVER via Cloud Assistant or
# non-interactive logs!). Uses `read -rs` so neither DeepSeek API key nor the
# enterprise demo password ever echoes to terminal or enters shell history.
#
# Creates / updates (all atomic installs with strict permissions):
#   /etc/aios                               (0750 root:aios-demo)
#   /etc/aios/secrets                       (0750 root:aios-demo)
#   /var/lib/aios                           (0750 root:aios-demo)
#   /var/lib/aios/state                     (0750 aios-demo:aios-demo)
#   /var/backups/aios                       (0750 aios-demo:aios-demo)
#   /etc/aios/secrets/llm-api-key           (0600 aios-demo:aios-demo)
#   /etc/aios/secrets/assurance-demo-key.json     (0600 aios-demo:aios-demo)
#   /etc/aios/secrets/assurance-demo-key.pub.json (0640 root:aios-demo)
#   /etc/aios/demo-common.env               (0640 root:aios-demo)
#   /etc/aios/demo-api.env                  (0640 root:aios-demo) -- NO Assurance key
#   /etc/aios/demo-assurance.env            (0640 root:aios-demo) -- NO LLM key
#   /etc/aios/demo-web.env                  (0640 root:aios-demo)
#
# Security invariants enforced:
#   - NEVER prints, echoes, or logs any secret, API key, session key, or password.
#   - Rejects weak/default password `aios2026` and short (<14 char) passwords.
#   - Rejects unconfirmed placeholder domains (`integrai.com`, `example.com`).
#   - Validates `AIOS_DEMO_SECRET` has >=32 chars and contains NO period (`.`).
#   - Validates `AIOS_BROWSER_SESSION_KEY` is exact 64 hex chars (32 bytes).
#   - Generates Assurance key as root in a 0700 mktemp directory via
#     `.venv/bin/python -m aios_platform.assurance_audit keygen <path> --public-out <pub>`
#     and atomically installs with 0600 aios-demo:aios-demo (NEVER runs as
#     aios-demo attempting to write into root:aios-demo 0750 /etc/aios/secrets).
#   - NEVER overwrites existing keys/secrets unless `--rotate` is explicitly passed.
#
# Usage:
#   sudo ./deploy/integrai/02-init-secrets.sh --origin https://integrai.<confirmed-domain>
#   sudo ./deploy/integrai/02-init-secrets.sh --origin https://integrai.<confirmed-domain> --rotate
# ==============================================================================
set +x
set -euo pipefail
umask 077

if [[ "${EUID}" -ne 0 ]]; then
  echo "[error] Must be run as root (use sudo)." >&2
  exit 1
fi

BROWSER_ORIGIN=""
LLM_BASE_URL="https://api.deepseek.com"
LLM_MODEL="deepseek-chat"
REPO_DIR="/opt/aios"
PYTHON_BIN="/opt/aios/.venv/bin/python"
ROTATE_ALL="0"
ROTATE_PASSWORD="0"
ROTATE_LLM_KEY="0"

print_help() {
  cat <<'EOF'
IntegrAI Secret & Assurance Key Initializer

Required:
  --origin <https://integrai.<confirmed-domain>>
                        Exact public HTTPS origin bound to Cloudflare Access.
                        NEVER use placeholder domains such as integrai.com.

Optional:
  --llm-base-url <url>  OpenAI-compatible HTTPS endpoint (default: https://api.deepseek.com)
  --llm-model <model>   Model identifier (default: deepseek-chat)
  --repo-dir <path>     Backend repo checkout path (default: /opt/aios)
  --python <path>       Python interpreter inside venv (default: /opt/aios/.venv/bin/python)
  --rotate              Rotate ALL secrets including demo secret, session key,
                        LLM API key, login password, and Assurance private key
  --rotate-password     Prompt to rotate only AIOS_DEMO_LOGIN_PASSWORD
  --rotate-llm-key      Prompt to rotate only /etc/aios/secrets/llm-api-key
  -h, --help            Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --origin)
      BROWSER_ORIGIN="${2:-}"
      shift 2
      ;;
    --llm-base-url)
      LLM_BASE_URL="${2:-}"
      shift 2
      ;;
    --llm-model)
      LLM_MODEL="${2:-}"
      shift 2
      ;;
    --repo-dir)
      REPO_DIR="${2:-}"
      shift 2
      ;;
    --python)
      PYTHON_BIN="${2:-}"
      shift 2
      ;;
    --rotate)
      ROTATE_ALL="1"
      shift
      ;;
    --rotate-password)
      ROTATE_PASSWORD="1"
      shift
      ;;
    --rotate-llm-key)
      ROTATE_LLM_KEY="1"
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

if ! id aios-demo >/dev/null 2>&1; then
  echo "[error] Low-privilege user 'aios-demo' does not exist. Create it before initializing secrets." >&2
  exit 1
fi

if [[ -z "${BROWSER_ORIGIN}" ]]; then
  if [[ ! -t 0 ]]; then
    echo "[error] --origin https://integrai.<confirmed-domain> is required." >&2
    exit 1
  fi
  read -r -p "Enter exact confirmed HTTPS origin (e.g. https://integrai.<your-domain>): " BROWSER_ORIGIN
fi

# Strip accidental trailing slash
BROWSER_ORIGIN="${BROWSER_ORIGIN%/}"
LLM_BASE_URL="${LLM_BASE_URL%/}"

# Validate origin strictly (matches aios_platform/browser.py BrowserConfig rules)
python3 - "${BROWSER_ORIGIN}" "${LLM_BASE_URL}" "${LLM_MODEL}" <<'PY'
import re, sys
from urllib.parse import urlsplit

origin, llm_url, llm_model = sys.argv[1], sys.argv[2], sys.argv[3]

u = urlsplit(origin)
if (
    u.scheme != "https"
    or not u.hostname
    or u.username
    or u.password
    or u.path
    or u.query
    or u.fragment
    or any(ch.isspace() for ch in origin)
):
    sys.exit("[error] --origin must be an exact HTTPS origin with no path/query (e.g. https://integrai.your-domain.tld).")

host = u.hostname.lower()
forbidden_hosts = {
    "integrai.com",
    "www.integrai.com",
    "example.com",
    "demo.example.com",
    "localhost",
    "127.0.0.1",
}
if host in forbidden_hosts or host.endswith(".example.com") or "<" in host or ">" in host:
    sys.exit(f"[error] Refusing placeholder/unconfirmed origin host '{host}'. Supply your confirmed Cloudflare root domain.")

lu = urlsplit(llm_url)
if lu.scheme != "https" or not lu.hostname or any(ch.isspace() for ch in llm_url):
    sys.exit("[error] --llm-base-url must be a valid https:// URL.")

if not re.fullmatch(r"[A-Za-z0-9._:/-]{1,128}", llm_model):
    sys.exit("[error] --llm-model contains invalid characters.")
PY

# Verify venv Python is available for Assurance keygen
if [[ ! -x "${PYTHON_BIN}" ]]; then
  echo "[error] Python venv not found at ${PYTHON_BIN}." >&2
  echo "        Run first: sudo ./deploy/integrai/03-deploy-release.sh --prepare-venv --sha <40-char-sha>" >&2
  exit 1
fi
if [[ ! -f "${REPO_DIR}/aios_platform/assurance_audit.py" ]]; then
  echo "[error] Backend source not found at ${REPO_DIR}/aios_platform/assurance_audit.py." >&2
  echo "        Run first: sudo ./deploy/integrai/03-deploy-release.sh --prepare-venv --sha <40-char-sha>" >&2
  exit 1
fi

TMP_WORK="$(mktemp -d /tmp/aios-init-secrets.XXXXXX)"
chmod 0700 "${TMP_WORK}"
cleanup() {
  rm -rf "${TMP_WORK}"
}
trap cleanup EXIT INT TERM

# Ensure directory hierarchy and strict permissions
install -d -o root -g aios-demo -m 0750 /etc/aios
install -d -o root -g aios-demo -m 0750 /etc/aios/secrets
install -d -o root -g aios-demo -m 0750 /var/lib/aios
install -d -o aios-demo -g aios-demo -m 0750 /var/lib/aios/state
install -d -o aios-demo -g aios-demo -m 0750 /var/backups/aios

# Helper: silently read an existing KEY from an env file (never prints)
read_existing_env_key() {
  local file="$1"
  local key="$2"
  if [[ ! -f "${file}" ]]; then
    return 0
  fi
  python3 - "${file}" "${key}" <<'PY'
import sys
path, key = sys.argv[1], sys.argv[2]
prefix = key + "="
with open(path, "r", encoding="utf-8") as fh:
    for raw in fh:
        line = raw.rstrip("\r\n")
        if line.startswith(prefix):
            sys.stdout.write(line[len(prefix):])
            break
PY
}

# ------------------------------------------------------------------------------
# 1. AIOS_DEMO_SECRET (>=32 chars, NO '.') & AIOS_BROWSER_SESSION_KEY (64 hex)
# ------------------------------------------------------------------------------
DEMO_SECRET=""
SESSION_KEY=""

if [[ "${ROTATE_ALL}" == "0" && -f /etc/aios/demo-common.env ]]; then
  DEMO_SECRET="$(read_existing_env_key /etc/aios/demo-common.env AIOS_DEMO_SECRET)"
  SESSION_KEY="$(read_existing_env_key /etc/aios/demo-common.env AIOS_BROWSER_SESSION_KEY)"
fi

if [[ -z "${DEMO_SECRET}" || "${#DEMO_SECRET}" -lt 32 || "${DEMO_SECRET}" == *.* ]]; then
  DEMO_SECRET="$("${PYTHON_BIN}" -c 'import secrets; s = secrets.token_urlsafe(36).replace(".", "-"); assert len(s) >= 32 and "." not in s; print(s)')"
  echo "[init] Generated fresh AIOS_DEMO_SECRET (>=32 chars, dot-free)."
else
  echo "[init] Preserving existing AIOS_DEMO_SECRET (pass --rotate to replace)."
fi

if [[ ! "${SESSION_KEY}" =~ ^[0-9a-f]{64}$ ]]; then
  SESSION_KEY="$("${PYTHON_BIN}" -c 'import secrets; print(secrets.token_hex(32))')"
  echo "[init] Generated fresh 32-byte AIOS_BROWSER_SESSION_KEY."
else
  echo "[init] Preserving existing AIOS_BROWSER_SESSION_KEY (pass --rotate to replace)."
fi

# Double-check secret invariants without printing values
if [[ "${#DEMO_SECRET}" -lt 32 || "${DEMO_SECRET}" == *.* ]]; then
  echo "[error] Internal validation failed for AIOS_DEMO_SECRET." >&2
  exit 1
fi
if [[ ! "${SESSION_KEY}" =~ ^[0-9a-f]{64}$ ]]; then
  echo "[error] Internal validation failed for AIOS_BROWSER_SESSION_KEY." >&2
  exit 1
fi

# ------------------------------------------------------------------------------
# 2. DeepSeek LLM API Key (/etc/aios/secrets/llm-api-key, 0600 aios-demo)
# ------------------------------------------------------------------------------
LLM_KEY_PATH="/etc/aios/secrets/llm-api-key"
if [[ -f "${LLM_KEY_PATH}" && "${ROTATE_ALL}" == "0" && "${ROTATE_LLM_KEY}" == "0" ]]; then
  chown aios-demo:aios-demo "${LLM_KEY_PATH}"
  chmod 0600 "${LLM_KEY_PATH}"
  echo "[init] Preserving existing ${LLM_KEY_PATH} (pass --rotate-llm-key or --rotate to replace)."
else
  if [[ ! -t 0 ]]; then
    echo "[error] Interactive TTY required to enter DeepSeek API key via read -rs." >&2
    exit 1
  fi
  printf 'Enter DeepSeek LLM API key (input hidden, not logged): '
  IFS= read -rs LLM_API_KEY_INPUT
  printf '\n'
  # Trim accidental leading/trailing spaces without echoing
  LLM_API_KEY_INPUT="${LLM_API_KEY_INPUT#"${LLM_API_KEY_INPUT%%[![:space:]]*}"}"
  LLM_API_KEY_INPUT="${LLM_API_KEY_INPUT%"${LLM_API_KEY_INPUT##*[![:space:]]}"}"
  if [[ -z "${LLM_API_KEY_INPUT}" || "${#LLM_API_KEY_INPUT}" -lt 16 ]]; then
    echo "[error] DeepSeek LLM API key appears empty or too short (<16 chars). Aborting." >&2
    exit 1
  fi
  if [[ "${LLM_API_KEY_INPUT}" =~ [[:space:]] ]]; then
    echo "[error] DeepSeek LLM API key must not contain whitespace. Aborting." >&2
    exit 1
  fi
  printf '%s\n' "${LLM_API_KEY_INPUT}" > "${TMP_WORK}/llm-api-key"
  unset LLM_API_KEY_INPUT
  install -o aios-demo -g aios-demo -m 0600 "${TMP_WORK}/llm-api-key" "${LLM_KEY_PATH}"
  rm -f "${TMP_WORK}/llm-api-key"
  echo "[init] Atomically installed ${LLM_KEY_PATH} (0600 aios-demo:aios-demo)."
fi

# ------------------------------------------------------------------------------
# 3. Strong Enterprise Demo Login Password (NEVER aios2026)
# ------------------------------------------------------------------------------
DEMO_PASSWORD=""
if [[ "${ROTATE_ALL}" == "0" && "${ROTATE_PASSWORD}" == "0" && -f /etc/aios/demo-web.env ]]; then
  DEMO_PASSWORD="$(read_existing_env_key /etc/aios/demo-web.env AIOS_DEMO_LOGIN_PASSWORD)"
fi

is_valid_password() {
  python3 - <<'PY'
import os, re, sys
pw = os.environ.get("PW_CHECK", "")
lower = pw.lower()
banned = {"aios2026", "password", "password123", "admin", "admin123", "changeme", "integrai", "integrai2026", "12345678"}
if len(pw) < 14:
    sys.exit("Password must be at least 14 characters.")
if lower in banned or "aios2026" in lower:
    sys.exit("Default/weak password (including aios2026) is strictly forbidden.")
if any(ord(c) < 33 or ord(c) > 126 for c in pw):
    sys.exit("Password must use printable non-whitespace ASCII characters only.")
if any(c in pw for c in ('"', "'", "\\", "$", "`")):
    sys.exit("Avoid quotes, backslash, '$', and backticks so systemd EnvironmentFile parses verbatim.")
classes = sum([
    bool(re.search(r"[a-z]", pw)),
    bool(re.search(r"[A-Z]", pw)),
    bool(re.search(r"[0-9]", pw)),
    bool(re.search(r"[^A-Za-z0-9]", pw)),
])
if classes < 3:
    sys.exit("Password must include at least 3 character classes (lower, upper, digit, symbol).")
PY
}

NEED_PASSWORD_PROMPT="0"
if [[ -z "${DEMO_PASSWORD}" ]]; then
  NEED_PASSWORD_PROMPT="1"
else
  if ! PW_CHECK="${DEMO_PASSWORD}" is_valid_password >/dev/null 2>&1; then
    echo "[warn] Existing AIOS_DEMO_LOGIN_PASSWORD failed strength policy (e.g. default aios2026); forcing rotation."
    NEED_PASSWORD_PROMPT="1"
    DEMO_PASSWORD=""
  else
    echo "[init] Preserving existing strong AIOS_DEMO_LOGIN_PASSWORD (pass --rotate-password to replace)."
  fi
fi

if [[ "${NEED_PASSWORD_PROMPT}" == "1" ]]; then
  if [[ ! -t 0 ]]; then
    echo "[error] Interactive TTY required to set strong AIOS_DEMO_LOGIN_PASSWORD via read -rs." >&2
    exit 1
  fi
  while true; do
    printf 'Enter strong AIOS_DEMO_LOGIN_PASSWORD (>=14 chars, >=3 classes, NOT aios2026; hidden): '
    IFS= read -rs PW_FIRST
    printf '\n'
    printf 'Confirm AIOS_DEMO_LOGIN_PASSWORD (hidden): '
    IFS= read -rs PW_SECOND
    printf '\n'
    if [[ "${PW_FIRST}" != "${PW_SECOND}" ]]; then
      echo "[warn] Passwords did not match. Try again."
      unset PW_FIRST PW_SECOND
      continue
    fi
    if err_msg="$(PW_CHECK="${PW_FIRST}" is_valid_password 2>&1)"; then
      DEMO_PASSWORD="${PW_FIRST}"
      unset PW_FIRST PW_SECOND
      break
    else
      echo "[warn] ${err_msg} Try again."
      unset PW_FIRST PW_SECOND
    fi
  done
  echo "[init] Strong AIOS_DEMO_LOGIN_PASSWORD validated and accepted."
fi

# ------------------------------------------------------------------------------
# 4. Assurance Private Key (0700 temp dir -> atomic 0600 aios-demo:aios-demo)
# ------------------------------------------------------------------------------
ASSURANCE_KEY_PATH="/etc/aios/secrets/assurance-demo-key.json"
ASSURANCE_PUB_PATH="/etc/aios/secrets/assurance-demo-key.pub.json"

if [[ -f "${ASSURANCE_KEY_PATH}" && "${ROTATE_ALL}" == "0" ]]; then
  chown aios-demo:aios-demo "${ASSURANCE_KEY_PATH}"
  chmod 0600 "${ASSURANCE_KEY_PATH}"
  echo "[init] Preserving existing ${ASSURANCE_KEY_PATH} (pass --rotate to regenerate)."
else
  if [[ -f "${ASSURANCE_KEY_PATH}" ]]; then
    echo "[warn] --rotate specified: replacing existing Assurance signing key (prior checkpoints remain tied to prior key_id)."
  fi
  KEYGEN_DIR="${TMP_WORK}/assurance-keygen"
  mkdir -m 0700 "${KEYGEN_DIR}"
  (
    cd "${REPO_DIR}"
    "${PYTHON_BIN}" -m aios_platform.assurance_audit keygen \
      "${KEYGEN_DIR}/assurance-demo-key.json" \
      --public-out "${KEYGEN_DIR}/assurance-demo-key.pub.json"
  )
  install -o aios-demo -g aios-demo -m 0600 "${KEYGEN_DIR}/assurance-demo-key.json" "${ASSURANCE_KEY_PATH}"
  install -o root -g aios-demo -m 0640 "${KEYGEN_DIR}/assurance-demo-key.pub.json" "${ASSURANCE_PUB_PATH}"
  rm -rf "${KEYGEN_DIR}"
  echo "[init] Generated and atomically installed ${ASSURANCE_KEY_PATH} (0600 aios-demo:aios-demo)."
fi

# ------------------------------------------------------------------------------
# 5. Atomically Install All 4 Systemd Environment Files (0640 root:aios-demo)
# ------------------------------------------------------------------------------
# Write via Python from process env to avoid any shell expansion of secrets.
TMP_WORK_DIR="${TMP_WORK}" \
W_BROWSER_ORIGIN="${BROWSER_ORIGIN}" \
W_DEMO_SECRET="${DEMO_SECRET}" \
W_SESSION_KEY="${SESSION_KEY}" \
W_LLM_BASE_URL="${LLM_BASE_URL}" \
W_LLM_MODEL="${LLM_MODEL}" \
W_LLM_KEY_PATH="${LLM_KEY_PATH}" \
W_ASSURANCE_KEY_PATH="${ASSURANCE_KEY_PATH}" \
W_DEMO_PASSWORD="${DEMO_PASSWORD}" \
python3 - <<'PY'
import os
from pathlib import Path

tmp = Path(os.environ["TMP_WORK_DIR"])

def write_env(filename, pairs):
    lines = []
    for k, v in pairs:
        if "\n" in v or "\r" in v or "\x00" in v:
            raise SystemExit(f"[error] Refusing control character in {k}.")
        lines.append(f"{k}={v}\n")
    (tmp / filename).write_text("".join(lines), encoding="utf-8")

write_env("demo-common.env", [
    ("AIOS_PROFILE", "demo"),
    ("AIOS_PLATFORM_STATE_DIR", "/var/lib/aios/state"),
    ("AIOS_BROWSER_ORIGIN", os.environ["W_BROWSER_ORIGIN"]),
    ("AIOS_DEMO_SECRET", os.environ["W_DEMO_SECRET"]),
    ("AIOS_BROWSER_SESSION_KEY", os.environ["W_SESSION_KEY"]),
])

# Cloud LLM Primary (:8760) — MUST NOT load Assurance private key
write_env("demo-api.env", [
    ("AIOS_PLANNER", "demo"),
    ("AIOS_WORKBENCH_PLANNER", "pydantic-ai"),
    ("AIOS_LLM_BASE_URL", os.environ["W_LLM_BASE_URL"]),
    ("AIOS_LLM_MODEL", os.environ["W_LLM_MODEL"]),
    ("AIOS_LLM_API_KEY_FILE", os.environ["W_LLM_KEY_PATH"]),
])

# Governed Assurance Companion (:8761) — MUST NOT load external LLM key
write_env("demo-assurance.env", [
    ("AIOS_PLANNER", "demo"),
    ("AIOS_WORKBENCH_PLANNER", "local"),
    ("AIOS_ASSURANCE_DEMO_KEY_FILE", os.environ["W_ASSURANCE_KEY_PATH"]),
])

# Next.js Same-Origin BFF (:3000)
write_env("demo-web.env", [
    ("AIOS_API_BASE_URL", "http://127.0.0.1:8760"),
    ("AIOS_ASSURANCE_API_BASE_URL", "http://127.0.0.1:8761"),
    ("AIOS_BROWSER_ORIGIN", os.environ["W_BROWSER_ORIGIN"]),
    ("AIOS_ENABLE_DEMO_AUTH", "1"),
    ("AIOS_DEMO_SECRET", os.environ["W_DEMO_SECRET"]),
    ("AIOS_DEMO_LOGIN_PASSWORD", os.environ["W_DEMO_PASSWORD"]),
    ("AIOS_OIDC_LOGIN_ENABLED", "0"),
])
PY

unset DEMO_SECRET SESSION_KEY DEMO_PASSWORD

# Process-isolation sanity assertions before atomic installation
if grep -q 'AIOS_ASSURANCE_' "${TMP_WORK}/demo-api.env"; then
  echo "[error] Process-isolation violation: demo-api.env must NOT reference Assurance keys." >&2
  exit 1
fi
if grep -q 'AIOS_LLM_' "${TMP_WORK}/demo-assurance.env"; then
  echo "[error] Process-isolation violation: demo-assurance.env must NOT reference external LLM config." >&2
  exit 1
fi

install -o root -g aios-demo -m 0640 "${TMP_WORK}/demo-common.env" /etc/aios/demo-common.env
install -o root -g aios-demo -m 0640 "${TMP_WORK}/demo-api.env" /etc/aios/demo-api.env
install -o root -g aios-demo -m 0640 "${TMP_WORK}/demo-assurance.env" /etc/aios/demo-assurance.env
install -o root -g aios-demo -m 0640 "${TMP_WORK}/demo-web.env" /etc/aios/demo-web.env

# ------------------------------------------------------------------------------
# 6. Non-Sensitive Verification Summary
# ------------------------------------------------------------------------------
PUB_KEY_ID="not-recorded"
if [[ -f "${ASSURANCE_PUB_PATH}" ]]; then
  PUB_KEY_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["key_id"])' "${ASSURANCE_PUB_PATH}" 2>/dev/null || printf 'unknown')"
fi

echo ""
echo "=============================================================================="
echo "  IntegrAI Secrets & Environment Initialized (Zero Secrets Logged)"
echo "  AIOS_BROWSER_ORIGIN : ${BROWSER_ORIGIN}"
echo "  AIOS_LLM_BASE_URL   : ${LLM_BASE_URL}"
echo "  AIOS_LLM_MODEL      : ${LLM_MODEL}"
echo "  Assurance key_id    : ${PUB_KEY_ID}"
echo "  Installed files     :"
for f in \
  /etc/aios/demo-common.env \
  /etc/aios/demo-api.env \
  /etc/aios/demo-assurance.env \
  /etc/aios/demo-web.env \
  "${LLM_KEY_PATH}" \
  "${ASSURANCE_KEY_PATH}"; do
  printf '    %s (%s)\n' "${f}" "$(stat -c '%U:%G %a' "${f}")"
done
echo "=============================================================================="
