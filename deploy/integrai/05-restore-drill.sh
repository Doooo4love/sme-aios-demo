#!/usr/bin/env bash
# ==============================================================================
# IntegrAI Isolated SQLite Restore Drill (05-restore-drill.sh)
# ==============================================================================
# Verifies backup recoverability inside an isolated `mktemp -d` (`0700`) temp
# directory that is automatically deleted on exit.
#
# SAFETY INVARIANT:
#   NEVER writes to, touches, restarts, or overwrites live `/var/lib/aios/state`!
#   Refuses to run if any resolved path could collide with live state.
#
# Checks performed on restored copies of `store.sqlite` & `erp.sqlite`:
#   1. Snapshot `SHA256SUMS` verification
#   2. `PRAGMA integrity_check;` == `ok`
#   3. `PRAGMA quick_check;` == `ok`
#   4. `PRAGMA foreign_key_check;` == empty (0 violations)
#   5. Non-empty schema table inventory (prints table names & row counts ONLY;
#      never prints business record contents, tokens, or secrets)
#
# Usage:
#   sudo -u aios-demo /opt/aios/deploy/integrai/05-restore-drill.sh
#   ./deploy/integrai/05-restore-drill.sh --snapshot /var/backups/aios/snapshot-20261122T031500Z
# ==============================================================================
set +x
set -euo pipefail
umask 077

BACKUP_DIR="${AIOS_BACKUP_DIR:-/var/backups/aios}"
LIVE_STATE_DIR="${AIOS_STATE_DIR:-/var/lib/aios/state}"
SNAPSHOT_DIR=""

print_help() {
  cat <<'EOF'
IntegrAI Isolated SQLite Restore Drill (NEVER touches live state)

Options:
  --snapshot <dir>      Specific snapshot directory to verify (default: latest)
  --backup-dir <dir>    Backup root directory (default: /var/backups/aios)
  -h, --help            Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --snapshot)
      SNAPSHOT_DIR="${2:-}"
      shift 2
      ;;
    --backup-dir)
      BACKUP_DIR="${2:-}"
      shift 2
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

for cmd in sqlite3 sha256sum mktemp; do
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "[error] Required command '${cmd}' not found." >&2
    exit 1
  fi
done

if [[ -z "${SNAPSHOT_DIR}" ]]; then
  if [[ ! -d "${BACKUP_DIR}" ]]; then
    echo "[error] Backup directory not found: ${BACKUP_DIR}" >&2
    exit 1
  fi
  SNAPSHOT_DIR="$(find "${BACKUP_DIR}" -mindepth 1 -maxdepth 1 -type d -name 'snapshot-*' | sort -r | head -n 1 || true)"
  if [[ -z "${SNAPSHOT_DIR}" ]]; then
    echo "[error] No snapshot-* directories found in ${BACKUP_DIR}. Run 04-sqlite-backup.sh first." >&2
    exit 1
  fi
fi

if [[ ! -d "${SNAPSHOT_DIR}" ]]; then
  echo "[error] Snapshot directory does not exist: ${SNAPSHOT_DIR}" >&2
  exit 1
fi

SNAPSHOT_REAL="$(readlink -f "${SNAPSHOT_DIR}")"
LIVE_REAL="$(readlink -f "${LIVE_STATE_DIR}" 2>/dev/null || printf '%s' "${LIVE_STATE_DIR}")"

if [[ "${SNAPSHOT_REAL}" == "${LIVE_REAL}" || "${SNAPSHOT_REAL}" == "${LIVE_REAL}/"* ]]; then
  echo "[error] Refusing drill: snapshot path resolves inside live state directory (${LIVE_REAL})!" >&2
  exit 1
fi

# Create strictly isolated 0700 temp directory outside /var/lib/aios/state
DRILL_DIR="$(mktemp -d /tmp/aios-restore-drill.XXXXXX)"
chmod 0700 "${DRILL_DIR}"
DRILL_REAL="$(readlink -f "${DRILL_DIR}")"

cleanup() {
  rm -rf "${DRILL_DIR}"
}
trap cleanup EXIT INT TERM

if [[ "${DRILL_REAL}" == "${LIVE_REAL}" || "${DRILL_REAL}" == "${LIVE_REAL}/"* ]]; then
  echo "[error] Safety guard tripped: drill directory collided with live state!" >&2
  exit 1
fi

echo "=============================================================================="
echo "  IntegrAI Isolated SQLite Restore Drill"
echo "  Snapshot   : ${SNAPSHOT_REAL}"
echo "  Drill Temp : ${DRILL_REAL} (auto-cleaned; live state untouched)"
echo "=============================================================================="

# 1. Verify SHA256SUMS
if [[ ! -f "${SNAPSHOT_REAL}/SHA256SUMS" ]]; then
  echo "[error] Missing SHA256SUMS in snapshot ${SNAPSHOT_REAL}" >&2
  exit 1
fi
(
  cd "${SNAPSHOT_REAL}"
  sha256sum -c SHA256SUMS
)
echo "[ok] Snapshot SHA256SUMS verified"

# 2. Copy snapshots into isolated temp dir
for db in store.sqlite erp.sqlite; do
  if [[ ! -f "${SNAPSHOT_REAL}/${db}" ]]; then
    echo "[error] Snapshot missing ${db}" >&2
    exit 1
  fi
  cp "${SNAPSHOT_REAL}/${db}" "${DRILL_DIR}/${db}"
  chmod 0600 "${DRILL_DIR}/${db}"
done

# 3. Run SQLite integrity, quick_check, foreign_key_check, and schema inventory
for db in store.sqlite erp.sqlite; do
  target="${DRILL_DIR}/${db}"
  echo ""
  echo "--- Verifying isolated copy: ${db} ---"

  ic="$(sqlite3 -noinit -batch -list "${target}" "PRAGMA integrity_check;")"
  if [[ "${ic}" != "ok" ]]; then
    echo "[FAIL] ${db} PRAGMA integrity_check failed: ${ic}" >&2
    exit 1
  fi
  echo "[PASS] ${db} PRAGMA integrity_check = ok"

  qc="$(sqlite3 -noinit -batch -list "${target}" "PRAGMA quick_check;")"
  if [[ "${qc}" != "ok" ]]; then
    echo "[FAIL] ${db} PRAGMA quick_check failed: ${qc}" >&2
    exit 1
  fi
  echo "[PASS] ${db} PRAGMA quick_check = ok"

  fk="$(sqlite3 -noinit -batch -list "${target}" "PRAGMA foreign_key_check;")"
  if [[ -n "${fk}" ]]; then
    echo "[FAIL] ${db} PRAGMA foreign_key_check reported violations:" >&2
    printf '%s\n' "${fk}" >&2
    exit 1
  fi
  echo "[PASS] ${db} PRAGMA foreign_key_check = clean (0 violations)"

  tables="$(sqlite3 -noinit -batch -list "${target}" "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;")"
  if [[ -z "${tables}" ]]; then
    echo "[FAIL] ${db} has zero user tables (unexpected empty database)" >&2
    exit 1
  fi
  table_count="$(wc -l <<<"${tables}" | tr -d '[:space:]')"
  echo "[PASS] ${db} schema contains ${table_count} table(s):"
  while IFS= read -r tbl; do
    [[ -z "${tbl}" ]] && continue
    # Count rows only — NEVER print row contents or secrets
    cnt="$(sqlite3 -noinit -batch -list "${target}" "SELECT COUNT(*) FROM \"${tbl}\";")"
    printf '       - %-32s rows=%s\n' "${tbl}" "${cnt}"
  done <<<"${tables}"
done

echo ""
echo "=============================================================================="
echo "  [PASS] Isolated Restore Drill SUCCEEDED"
echo "  Live state (${LIVE_REAL}) was NEVER modified."
echo "=============================================================================="
