#!/usr/bin/env bash
# ==============================================================================
# IntegrAI Host Read-Only Preflight Verification (01-preflight.sh)
# ==============================================================================
# Strictly READ-ONLY: never modifies host configuration, files, or services,
# and NEVER reads, prints, or logs any secret or /etc/aios/*.env file contents.
#
# Target baseline (Alibaba Cloud International Lighthouse, Hong Kong):
#   Ubuntu 24.04 x86_64, 2 vCPU / 2 GiB RAM + 2 GiB Swap (vm.swappiness=10),
#   40 GiB disk, low-privilege user `aios-demo`, Node.js 22, Python venv/pip,
#   Tesseract OCR, SQLite3, fail2ban, UFW.
#
# Usage:
#   ./deploy/integrai/01-preflight.sh
#   sudo ./deploy/integrai/01-preflight.sh   # enables ufw & full ss/stat checks
# ==============================================================================
set +x
set -euo pipefail

PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf '[PASS] %s\n' "$1"
}

warn() {
  WARN_COUNT=$((WARN_COUNT + 1))
  printf '[WARN] %s\n' "$1"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  printf '[FAIL] %s\n' "$1"
}

section() {
  printf '\n=== %s ===\n' "$1"
}

check_path_meta() {
  local path="$1"
  local expected_mode="${2:-}"
  local expected_owner="${3:-}"
  local reject_world="${4:-0}"

  if [[ ! -e "${path}" ]]; then
    warn "${path} does not exist yet"
    return 0
  fi

  local meta owner mode
  if ! meta="$(stat -c '%U:%G %a %F' "${path}" 2>/dev/null)"; then
    warn "${path} exists (unable to stat; run with sudo for full metadata)"
    return 0
  fi

  owner="$(awk '{print $1}' <<<"${meta}")"
  mode="$(awk '{print $2}' <<<"${meta}")"
  printf '  meta: %s -> %s\n' "${path}" "${meta}"

  if [[ "${reject_world}" == "1" ]]; then
    local world_digit="${mode: -1}"
    if [[ "${world_digit}" != "0" ]]; then
      fail "${path} has world-accessible permissions (${mode}); expected world=0"
      return 0
    fi
  fi

  if [[ -n "${expected_mode}" && "${mode}" != "${expected_mode}" ]]; then
    warn "${path} mode is ${mode} (expected ${expected_mode})"
  elif [[ -n "${expected_owner}" && "${owner}" != "${expected_owner}" ]]; then
    warn "${path} owner is ${owner} (expected ${expected_owner})"
  else
    pass "${path} metadata OK (${owner} ${mode})"
  fi
}

printf '==============================================================================\n'
printf '  IntegrAI Host Read-Only Preflight Check (%s)\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '==============================================================================\n'

# ------------------------------------------------------------------------------
# 1. OS & Architecture
# ------------------------------------------------------------------------------
section "1. OS & Architecture"
os_kernel="$(uname -s)"
os_arch="$(uname -m)"
printf '  uname: %s %s\n' "${os_kernel}" "${os_arch}"
if [[ "${os_kernel}" == "Linux" && "${os_arch}" == "x86_64" ]]; then
  pass "Linux x86_64 host confirmed"
else
  fail "Expected Linux x86_64 host (got ${os_kernel} ${os_arch}); never deploy Mac ARM64 artifacts"
fi

if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  pretty_os="$(. /etc/os-release && printf '%s' "${PRETTY_NAME:-unknown}")"
  printf '  os   : %s\n' "${pretty_os}"
  if [[ "${pretty_os}" == *"Ubuntu 24.04"* ]]; then
    pass "Ubuntu 24.04 baseline confirmed"
  else
    warn "Host OS is '${pretty_os}' (expected Ubuntu 24.04 LTS)"
  fi
else
  warn "/etc/os-release unreadable"
fi

# ------------------------------------------------------------------------------
# 2. Low-Privilege Service Account (aios-demo)
# ------------------------------------------------------------------------------
section "2. Service User (aios-demo)"
if id_out="$(id aios-demo 2>/dev/null)"; then
  printf '  %s\n' "${id_out}"
  uid_val="$(id -u aios-demo)"
  if [[ "${uid_val}" -eq 0 ]]; then
    fail "aios-demo must NOT have uid 0"
  else
    pass "Low-privilege user aios-demo exists (uid=${uid_val})"
  fi
  if command -v getent >/dev/null 2>&1; then
    shell_val="$(getent passwd aios-demo | cut -d: -f7)"
    printf '  shell: %s\n' "${shell_val}"
    if [[ "${shell_val}" == *"nologin"* || "${shell_val}" == *"false"* ]]; then
      pass "aios-demo login shell is non-interactive (${shell_val})"
    else
      warn "aios-demo login shell is '${shell_val}' (recommend /usr/sbin/nologin)"
    fi
  fi
else
  fail "User 'aios-demo' does not exist"
fi

# ------------------------------------------------------------------------------
# 3. Memory, Swap & vm.swappiness
# ------------------------------------------------------------------------------
section "3. Memory, Swap & Swappiness"
if command -v free >/dev/null 2>&1; then
  free -h | sed 's/^/  /'
  mem_total_mb="$(free -m | awk '/^Mem:/ {print $2}')"
  swap_total_mb="$(free -m | awk '/^Swap:/ {print $2}')"
  if [[ "${mem_total_mb:-0}" -ge 1700 ]]; then
    pass "RAM detected: ${mem_total_mb} MiB"
  else
    warn "RAM is ${mem_total_mb:-0} MiB (expected ~2 GiB)"
  fi
  if [[ "${swap_total_mb:-0}" -ge 1800 ]]; then
    pass "Swap active: ${swap_total_mb} MiB"
  else
    fail "Swap is ${swap_total_mb:-0} MiB (expected ~2 GiB swap file)"
  fi
else
  warn "'free' command not found"
fi

if command -v swapon >/dev/null 2>&1; then
  swap_table="$(swapon --show || true)"
  if [[ -n "${swap_table}" ]]; then
    printf '%s\n' "${swap_table}" | sed 's/^/  /'
  else
    fail "No active swap devices reported by swapon --show"
  fi
fi

if [[ -r /proc/sys/vm/swappiness ]]; then
  swappiness="$(cat /proc/sys/vm/swappiness)"
  printf '  vm.swappiness=%s\n' "${swappiness}"
  if [[ "${swappiness}" == "10" ]]; then
    pass "vm.swappiness=10"
  else
    warn "vm.swappiness=${swappiness} (recommended: 10)"
  fi
fi

# ------------------------------------------------------------------------------
# 4. Runtime Dependencies
# ------------------------------------------------------------------------------
section "4. Runtime Dependencies"
if command -v node >/dev/null 2>&1; then
  node_ver="$(node -v)"
  printf '  node: %s (%s)\n' "${node_ver}" "$(command -v node)"
  if [[ "${node_ver}" =~ ^v22\. ]]; then
    pass "Node.js 22 installed (${node_ver})"
  else
    fail "Expected Node.js v22.x (got ${node_ver})"
  fi
else
  fail "Node.js not found"
fi

if command -v python3 >/dev/null 2>&1; then
  py_ver="$(python3 --version 2>&1)"
  printf '  python3: %s\n' "${py_ver}"
  if python3 -m venv --help >/dev/null 2>&1; then
    pass "python3 + venv available (${py_ver})"
  else
    fail "python3-venv module missing (install python3-venv)"
  fi
  if python3 -m pip --version >/dev/null 2>&1; then
    pass "pip available ($(python3 -m pip --version 2>&1))"
  else
    warn "system pip not directly available (ensure python3-pip or venv ensurepip works)"
  fi
else
  fail "python3 not found"
fi

if command -v tesseract >/dev/null 2>&1; then
  tess_ver="$(tesseract --version 2>&1 | head -n 1)"
  printf '  tesseract: %s\n' "${tess_ver}"
  if tesseract --list-langs 2>/dev/null | grep -qx 'eng'; then
    pass "Tesseract OCR with 'eng' traineddata installed"
  else
    warn "Tesseract installed, but 'eng' language pack not listed"
  fi
else
  fail "Tesseract OCR not found (required for PO intake OCR)"
fi

if command -v sqlite3 >/dev/null 2>&1; then
  pass "sqlite3 CLI installed ($(sqlite3 --version | awk '{print $1}'))"
else
  fail "sqlite3 CLI not found (required for WAL-safe hot backups & restore drill)"
fi

for tool in git curl tar sha256sum; do
  if command -v "${tool}" >/dev/null 2>&1; then
    pass "Tool '${tool}' available"
  else
    fail "Required tool '${tool}' not found"
  fi
done

if command -v cloudflared >/dev/null 2>&1; then
  pass "cloudflared installed ($(cloudflared --version 2>&1 | head -n 1))"
else
  warn "cloudflared not installed yet (install during Section 6 Cloudflare Tunnel setup)"
fi

if command -v pnpm >/dev/null 2>&1; then
  printf '  pnpm: %s (optional unless using --build-local)\n' "$(pnpm --version 2>&1)"
else
  printf '  pnpm: not installed (not required when deploying CI Linux x86_64 tarball)\n'
fi

# ------------------------------------------------------------------------------
# 5. Host Hardening (fail2ban, UFW, sshd)
# ------------------------------------------------------------------------------
section "5. Host Hardening (fail2ban, UFW, sshd)"
if command -v systemctl >/dev/null 2>&1; then
  f2b_state="$(systemctl is-active fail2ban 2>/dev/null || true)"
  if [[ "${f2b_state}" == "active" ]]; then
    pass "fail2ban service is active"
  else
    fail "fail2ban is not active (state=${f2b_state:-unknown})"
  fi
else
  warn "systemctl not available"
fi

if command -v ufw >/dev/null 2>&1; then
  if [[ "${EUID}" -eq 0 ]]; then
    ufw_out="$(ufw status verbose 2>&1 || true)"
    printf '%s\n' "${ufw_out}" | sed 's/^/  /'
    if grep -q '^Status: active' <<<"${ufw_out}"; then
      pass "UFW firewall is active"
    else
      warn "UFW firewall is NOT active yet (enable in Section 3 after verifying SSH key login)"
    fi
    if grep -Eq '\b(80|443|3000|8760|8761)(/tcp)?[[:space:]]+ALLOW' <<<"${ufw_out}"; then
      fail "UFW allows business/web port (80/443/3000/8760/8761); keep all closed!"
    else
      pass "UFW has no ALLOW rules for 80/443/3000/8760/8761"
    fi
  else
    warn "Run with sudo to inspect 'ufw status verbose'"
  fi
else
  fail "ufw command not found"
fi

if [[ "${EUID}" -eq 0 ]] && command -v sshd >/dev/null 2>&1; then
  sshd_effective="$(sshd -T 2>/dev/null | grep -E '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin|pubkeyauthentication) ' || true)"
  if [[ -n "${sshd_effective}" ]]; then
    printf '%s\n' "${sshd_effective}" | sed 's/^/  sshd: /'
    if grep -q '^passwordauthentication no$' <<<"${sshd_effective}"; then
      pass "sshd PasswordAuthentication is disabled"
    else
      warn "sshd PasswordAuthentication is still enabled (disable in Section 2 AFTER verifying SSH key login on a second session)"
    fi
  fi
fi

# ------------------------------------------------------------------------------
# 6. Listening Sockets (Loopback-Only Enforcement)
# ------------------------------------------------------------------------------
section "6. Listening TCP Sockets (ss -lntup)"
if command -v ss >/dev/null 2>&1; then
  if [[ "${EUID}" -eq 0 ]]; then
    ss_out="$(ss -lntup || true)"
  else
    ss_out="$(ss -lnt || true)"
    warn "Running as non-root; process names omitted in ss output (run with sudo for ss -lntup)"
  fi
  printf '%s\n' "${ss_out}" | sed 's/^/  /'

  bad_bind=0
  tcp_addrs="$(ss -H -lnt 2>/dev/null | awk '{print $4}' || true)"
  for port in 3000 8760 8761 80 443; do
    # Match any non-127.0.0.1 / non-[::1] listener on these ports
    while IFS= read -r local_addr; do
      [[ -z "${local_addr}" ]] && continue
      if [[ "${local_addr}" == *":${port}" ]]; then
        if [[ "${local_addr}" != "127.0.0.1:${port}" && "${local_addr}" != "[::1]:${port}" ]]; then
          fail "Port ${port} is exposed on non-loopback address: ${local_addr}"
          bad_bind=1
        fi
      fi
    done <<<"${tcp_addrs}"
  done
  if [[ "${bad_bind}" -eq 0 ]]; then
    pass "No public/wildcard bindings detected on ports 80/443/3000/8760/8761"
  fi
else
  warn "'ss' command not found"
fi

# ------------------------------------------------------------------------------
# 7. Disk Capacity
# ------------------------------------------------------------------------------
section "7. Disk Space"
df -h / | sed 's/^/  /'
use_pct="$(df -P / | awk 'NR==2 {gsub(/%/, "", $5); print $5}')"
free_pct=$((100 - use_pct))
if [[ "${free_pct}" -ge 20 ]]; then
  pass "Root filesystem has ${free_pct}% free space"
elif [[ "${free_pct}" -ge 15 ]]; then
  warn "Root filesystem has ${free_pct}% free space (approaching 15% backup alert threshold)"
else
  fail "Root filesystem has only ${free_pct}% free space (<15% threshold)"
fi

# ------------------------------------------------------------------------------
# 8. Directory & File Metadata (ZERO Secret Content Read)
# ------------------------------------------------------------------------------
section "8. Directory & File Permissions (Metadata Only)"
check_path_meta "/opt/aios" "" "" 0
check_path_meta "/opt/aios-web" "" "" 0
check_path_meta "/etc/aios" "750" "root:aios-demo" 1
check_path_meta "/etc/aios/secrets" "750" "root:aios-demo" 1
check_path_meta "/etc/aios/demo-common.env" "640" "root:aios-demo" 1
check_path_meta "/etc/aios/demo-api.env" "640" "root:aios-demo" 1
check_path_meta "/etc/aios/demo-assurance.env" "640" "root:aios-demo" 1
check_path_meta "/etc/aios/demo-web.env" "640" "root:aios-demo" 1
check_path_meta "/etc/aios/secrets/llm-api-key" "600" "aios-demo:aios-demo" 1
check_path_meta "/etc/aios/secrets/assurance-demo-key.json" "600" "aios-demo:aios-demo" 1
check_path_meta "/var/lib/aios" "750" "root:aios-demo" 1
check_path_meta "/var/lib/aios/state" "750" "aios-demo:aios-demo" 1
check_path_meta "/var/backups/aios" "750" "aios-demo:aios-demo" 1

# ------------------------------------------------------------------------------
# Summary
# ------------------------------------------------------------------------------
printf '\n==============================================================================\n'
printf '  Preflight Summary: PASS=%d  WARN=%d  FAIL=%d\n' "${PASS_COUNT}" "${WARN_COUNT}" "${FAIL_COUNT}"
printf '==============================================================================\n'

if [[ "${FAIL_COUNT}" -gt 0 ]]; then
  exit 1
fi
exit 0
