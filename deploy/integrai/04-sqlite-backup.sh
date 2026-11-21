#!/usr/bin/env bash
# ==============================================================================
# IntegrAI Daily WAL-Safe SQLite Hot Backup (04-sqlite-backup.sh)
# ==============================================================================
# Creates consistent online hot backups of BOTH `store.sqlite` and `erp.sqlite`
# via `sqlite3 ... ".backup ..."` (safe while WAL-mode services are live),
# runs `PRAGMA integrity_check;` on every snapshot copy, generates `SHA256SUMS`,
# enforces disk-space alerting (`>=15%` free threshold), and prunes snapshots
# older than `AIOS_BACKUP_RETENTION_DAYS` (default: 14, always keeping >= 2).
#
# NEVER mutates or deletes any live database in `/var/lib/aios/state`.
#
# Environment / CLI overrides:
#   AIOS_STATE_DIR=/var/lib/aios/state
#   AIOS_BACKUP_DIR=/var/backups/aios
#   AIOS_BACKUP_RETENTION_DAYS=14
#   AIOS_BACKUP_MIN_FREE_PCT=15
#
# Usage:
#   sudo -u aios-demo /opt/aios/deploy/integrai/04-sqlite-backup.sh
#   ./deploy/integrai/04-sqlite-backup.sh --retention-days 14 --min-free-pct 15
# ==============================================================================
set +x
set -euo pipefail
umask 077

STATE_DIR="${AIOS_STATE_DIR:-/var/lib/aios/state}"
BACKUP_DIR="${AIOS_BACKUP_DIR:-/var/backups/aios}"
RETENTION_DAYS="${AIOS_BACKUP_RETENTION_DAYS:-14}"
MIN_FREE_PCT="${AIOS_BACKUP_MIN_FREE_PCT:-15}"
CRITICAL_FREE_PCT=5
MIN_SNAPSHOTS_KEEP=2

print_help() {
  cat <<'EOF'
IntegrAI WAL-Safe SQLite Hot Backup

Options:
  --state-dir <path>       Live SQLite state dir (default: /var/lib/aios/state)
  --backup-dir <path>      Backup target root (default: /var/backups/aios)
  --retention-days <N>     Days to retain old snapshots (default: 14)
  --min-free-pct <N>       Free disk % alert threshold (default: 15)
  -h, --help               Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --state-dir)
      STATE_DIR="${2:-}"
      shift 2
      ;;
    --backup-dir)
      BACKUP_DIR="${2:-}"
      shift 2
      ;;
    --retention-days)
      RETENTION_DAYS="${2:-}"
      shift 2
      ;;
    --min-free-pct)
      MIN_FREE_PCT="${2:-}"
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

for cmd in sqlite3 sha256sum df find; do
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "[error] Required command '${cmd}' not found." >&2
    exit 1
  fi
done

if [[ ! "${RETENTION_DAYS}" =~ ^[0-9]+$ || "${RETENTION_DAYS}" -lt 1 ]]; then
  echo "[error] retention-days must be an integer >= 1 (got: ${RETENTION_DAYS})." >&2
  exit 1
fi
if [[ ! "${MIN_FREE_PCT}" =~ ^[0-9]+$ || "${MIN_FREE_PCT}" -lt 1 || "${MIN_FREE_PCT}" -gt 90 ]]; then
  echo "[error] min-free-pct must be an integer between 1 and 90 (got: ${MIN_FREE_PCT})." >&2
  exit 1
fi
if [[ "${BACKUP_DIR}" == *"'"* || "${BACKUP_DIR}" == *$'\n'* ]]; then
  echo "[error] Unsafe characters in BACKUP_DIR." >&2
  exit 1
fi

if [[ ! -d "${STATE_DIR}" ]]; then
  echo "[error] State directory does not exist: ${STATE_DIR}" >&2
  exit 1
fi

mkdir -p "${BACKUP_DIR}"
chmod 0750 "${BACKUP_DIR}" 2>/dev/null || true

alert_msg() {
  local msg="$1"
  echo "[ALERT] ${msg}" >&2
  if command -v logger >/dev/null 2>&1; then
    logger -t aios-sqlite-backup -p user.warning "${msg}" || true
  fi
}

check_disk_space() {
  local phase="$1"
  local use_pct free_pct avail_human
  use_pct="$(df -P "${BACKUP_DIR}" | awk 'NR==2 {gsub(/%/, "", $5); print $5}')"
  avail_human="$(df -hP "${BACKUP_DIR}" | awk 'NR==2 {print $4}')"
  free_pct=$((100 - use_pct))
  echo "[backup] Disk free (${phase}): ${free_pct}% (${avail_human} available on ${BACKUP_DIR})"

  if [[ "${free_pct}" -lt "${CRITICAL_FREE_PCT}" ]]; then
    alert_msg "CRITICAL disk space on ${BACKUP_DIR}: ${free_pct}% free (<${CRITICAL_FREE_PCT}%). Aborting backup to protect host!"
    return 2
  fi
  if [[ "${free_pct}" -lt "${MIN_FREE_PCT}" ]]; then
    alert_msg "Low disk space on ${BACKUP_DIR}: ${free_pct}% free (threshold >=${MIN_FREE_PCT}%)."
    return 1
  fi
  return 0
}

DISK_WARN=0
disk_rc=0
check_disk_space "pre-backup" || disk_rc=$?
if [[ "${disk_rc}" -eq 2 ]]; then
  exit 2
elif [[ "${disk_rc}" -eq 1 ]]; then
  DISK_WARN=1
fi

# Verify both databases exist before creating snapshot
for db in store.sqlite erp.sqlite; do
  if [[ ! -f "${STATE_DIR}/${db}" ]]; then
    echo "[error] Missing expected SQLite database: ${STATE_DIR}/${db}" >&2
    exit 1
  fi
done

UTC_TS="$(date -u +%Y%m%dT%H%M%SZ)"
STAGE_DIR="${BACKUP_DIR}/.staging-snapshot-${UTC_TS}-$$"
FINAL_DIR="${BACKUP_DIR}/snapshot-${UTC_TS}"

cleanup_stage() {
  if [[ -d "${STAGE_DIR}" ]]; then
    rm -rf "${STAGE_DIR}"
  fi
}
trap cleanup_stage EXIT INT TERM

mkdir -m 0700 "${STAGE_DIR}"

# Perform WAL-safe online .backup + immediate PRAGMA integrity_check on each copy
for db in store.sqlite erp.sqlite; do
  src="${STATE_DIR}/${db}"
  dst="${STAGE_DIR}/${db}"
  echo "[backup] Hot-backing up ${db} via sqlite3 .backup..."
  sqlite3 -noinit -batch -cmd ".timeout 15000" "${src}" ".backup '${dst}'"
  chmod 0600 "${dst}"

  # Open snapshot read-only + immutable so WAL-header backups never create -shm/-wal sidecars
  check_out="$(sqlite3 -noinit -batch -list "file:${dst}?mode=ro&immutable=1" "PRAGMA integrity_check;" 2>&1)"
  if [[ "${check_out}" != "ok" ]]; then
    echo "[error] Integrity check FAILED for backup copy ${dst}: ${check_out}" >&2
    exit 1
  fi
  size_bytes="$(stat -c '%s' "${dst}" 2>/dev/null || stat -f '%z' "${dst}")"
  echo "[ok] ${db} backed up (${size_bytes} bytes, PRAGMA integrity_check=ok)"
done

(
  cd "${STAGE_DIR}"
  sha256sum store.sqlite erp.sqlite > SHA256SUMS
  chmod 0600 SHA256SUMS
  sha256sum -c SHA256SUMS >/dev/null
)

# Publish snapshot atomically
mv "${STAGE_DIR}" "${FINAL_DIR}"
chmod 0750 "${FINAL_DIR}"
echo "[ok] Published verified snapshot: ${FINAL_DIR}"

# Prune snapshots older than RETENTION_DAYS while always keeping >= MIN_SNAPSHOTS_KEEP newest
mapfile -t ALL_SNAPS < <(find "${BACKUP_DIR}" -mindepth 1 -maxdepth 1 -type d -name 'snapshot-*' | sort -r)
total_snaps="${#ALL_SNAPS[@]}"
pruned=0
if [[ "${total_snaps}" -gt "${MIN_SNAPSHOTS_KEEP}" ]]; then
  idx=0
  for snap in "${ALL_SNAPS[@]}"; do
    idx=$((idx + 1))
    if [[ "${idx}" -le "${MIN_SNAPSHOTS_KEEP}" ]]; then
      continue
    fi
    if find "${snap}" -maxdepth 0 -mtime +"${RETENTION_DAYS}" | grep -q .; then
      echo "[backup] Pruning expired snapshot (> ${RETENTION_DAYS}d): ${snap}"
      rm -rf "${snap}"
      pruned=$((pruned + 1))
    fi
  done
fi

remaining_snaps=$((total_snaps - pruned))
echo "[backup] Retention summary: kept=${remaining_snaps}, pruned=${pruned} (policy=${RETENTION_DAYS}d, floor=${MIN_SNAPSHOTS_KEEP})"

post_rc=0
check_disk_space "post-backup" || post_rc=$?
if [[ "${post_rc}" -ge 1 ]]; then
  DISK_WARN=1
fi

if [[ "${DISK_WARN}" -ne 0 ]]; then
  echo "[backup] Completed WITH DISK SPACE ALERT (free space below ${MIN_FREE_PCT}%)." >&2
fi
exit 0
