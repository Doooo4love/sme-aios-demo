#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKER_NAME="${AIOS_WORKER_NAME:-aios-demo}"
PASS_FILE="$SCRIPT_DIR/.reviewer-pass.local.json"
DRY_RUN=0
SKIP_LIVE_CHECK=0
DEPLOY_ARGS=()

usage() {
  cat <<'EOF'
Usage: ./activate-reviewer-gate.sh [options]

Reads gitignored `.reviewer-pass.local.json`, pipes Theodic Edge Reviewer Gate
secrets into `wrangler secret put` without echoing secret values, deploys
the `aios-demo` Worker via `./deploy-worker.sh`, and runs `scripts/verify-live-gate.mjs`.

Options:
  --pass-file <path>  Path to reviewer pass JSON (default: ./.reviewer-pass.local.json)
  --service-id <id>   Forwarded to ./deploy-worker.sh
  --tunnel-id <uuid>  Forwarded to ./deploy-worker.sh
  --dry-run           Validate pass file and run ./deploy-worker.sh --dry-run (no Cloudflare calls)
  --skip-live-check   Skip post-deploy `scripts/verify-live-gate.mjs` live verification
  -h, --help          Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pass-file)
      PASS_FILE="${2:-}"
      shift 2
      ;;
    --service-id)
      DEPLOY_ARGS+=(--service-id "${2:-}")
      shift 2
      ;;
    --tunnel-id)
      DEPLOY_ARGS+=(--tunnel-id "${2:-}")
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      DEPLOY_ARGS+=(--dry-run)
      shift
      ;;
    --skip-live-check)
      SKIP_LIVE_CHECK=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ ! -f "$PASS_FILE" ]]; then
  cat >&2 <<EOF
ERROR: Reviewer pass file not found: $PASS_FILE
Generate it first with:
  node "$SCRIPT_DIR/scripts/generate-reviewer-pass.mjs"
EOF
  exit 1
fi

echo "[1/4] Validating local reviewer pass metadata (no secrets will be printed)..."
node -e '
  const fs = require("node:fs");
  const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const required = ["gate_secret", "reviewer_passcode", "team_passcode", "expires_at"];
  for (const key of required) {
    if (typeof data[key] !== "string" || data[key].trim().length === 0) {
      console.error(`ERROR: Missing or empty field "${key}" in ${process.argv[1]}`);
      process.exit(1);
    }
  }
  const expMs = Date.parse(data.expires_at);
  if (!Number.isFinite(expMs)) {
    console.error("ERROR: Invalid expires_at ISO timestamp.");
    process.exit(1);
  }
  console.log(`Validated pass file (expires_at=${data.expires_at}).`);
' "$PASS_FILE"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[2/4] Dry-run mode: skipping wrangler secret upload for:"
  echo "      - AIOS_GATE_SECRET"
  echo "      - AIOS_REVIEWER_PASSCODE"
  echo "      - AIOS_TEAM_PASSCODE"
  echo "      - AIOS_REVIEWER_EXPIRES_AT"
  echo "[3/4] Running ./deploy-worker.sh --dry-run..."
  "$SCRIPT_DIR/deploy-worker.sh" ${DEPLOY_ARGS[@]+"${DEPLOY_ARGS[@]}"}
  echo "[4/4] Dry-run mode: skipping live Edge Reviewer Gate verification."
  exit 0
fi

echo "[2/4] Verifying Wrangler authentication and uploading Edge Gate secrets..."
if ! pnpm --dir "$SCRIPT_DIR" exec wrangler whoami >/dev/null 2>&1; then
  cat >&2 <<'EOF'
ERROR: Wrangler is not authenticated on this machine.
Please run first:
  pnpm --dir deploy/cloudflare-worker exec wrangler login
EOF
  exit 1
fi

node -e '
  const fs = require("node:fs");
  const { execFileSync } = require("node:child_process");

  const [scriptDir, passFile, workerName] = process.argv.slice(1);
  const data = JSON.parse(fs.readFileSync(passFile, "utf8"));

  const mappings = [
    ["AIOS_GATE_SECRET", data.gate_secret],
    ["AIOS_REVIEWER_PASSCODE", data.reviewer_passcode],
    ["AIOS_TEAM_PASSCODE", data.team_passcode],
    ["AIOS_REVIEWER_EXPIRES_AT", data.expires_at],
  ];

  for (const [secretName, secretValue] of mappings) {
    process.stdout.write(`Uploading Worker secret ${secretName} -> ${workerName}...\n`);
    execFileSync(
      "pnpm",
      ["--dir", scriptDir, "exec", "wrangler", "secret", "put", secretName, "--name", workerName],
      {
        input: String(secretValue),
        stdio: ["pipe", "inherit", "inherit"],
      },
    );
  }
' "$SCRIPT_DIR" "$PASS_FILE" "$WORKER_NAME"

echo "[3/4] Deploying Worker '$WORKER_NAME' via ./deploy-worker.sh..."
"$SCRIPT_DIR/deploy-worker.sh" ${DEPLOY_ARGS[@]+"${DEPLOY_ARGS[@]}"}

if [[ "$SKIP_LIVE_CHECK" -eq 0 ]]; then
  echo "[4/4] Verifying QR payloads and live Edge Reviewer Gate..."
  node "$SCRIPT_DIR/scripts/verify-live-gate.mjs" --pass-file "$PASS_FILE"
else
  echo "[4/4] Skipping live Edge Reviewer Gate verification (--skip-live-check)."
fi

cat <<'EOF'

Reviewer Gate activation finished.
Next step (Cloudflare Zero Trust Access switch):
1. In Cloudflare Zero Trust (`aged-lake-87d1`) -> Access -> Applications -> `aios-demo`:
   remove or set Bypass on the legacy 4-email One-time PIN policy so external reviewers
   can reach `/review` directly and authenticate via the Worker Edge Cryptographic Gate.
2. Verify `/robots.txt` returns `Disallow: /`, unauthenticated `/login` returns 401,
   and `reviewer_fragment_url` / `reviewer_signed_url` land in English at `/login`.
EOF
