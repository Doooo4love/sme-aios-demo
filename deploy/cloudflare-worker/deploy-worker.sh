#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

WORKER_NAME="${AIOS_WORKER_NAME:-aios-demo}"
VPC_SERVICE_NAME="${AIOS_VPC_SERVICE_NAME:-aios-demo-origin}"
TUNNEL_ID="${AIOS_TUNNEL_ID:-3d90b761-eeb9-491f-a608-3079b4d4b0e4}"
ORIGIN_IPV4="${AIOS_ORIGIN_IPV4:-127.0.0.1}"
ORIGIN_PORT="${AIOS_ORIGIN_PORT:-3000}"
VPC_SERVICE_ID="${AIOS_VPC_SERVICE_ID:-}"
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: ./deploy-worker.sh [options]

Deploy the zero-secret SME AIOS Cloudflare Worker (`aios-demo`) wired to the
existing Cloudflare Tunnel via Cloudflare Workers VPC (`AIOS_ORIGIN`).

Options:
  --service-id <id>   Reuse an existing Workers VPC service ID instead of auto-detecting/creating.
  --tunnel-id <uuid>  Override Cloudflare Tunnel UUID (default: 3d90b761-eeb9-491f-a608-3079b4d4b0e4).
  --dry-run           Build bundle and validate Wrangler config without uploading to Cloudflare.
  -h, --help          Show this help message.

Environment overrides:
  AIOS_WORKER_NAME, AIOS_VPC_SERVICE_NAME, AIOS_TUNNEL_ID,
  AIOS_ORIGIN_IPV4, AIOS_ORIGIN_PORT, AIOS_VPC_SERVICE_ID
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --service-id)
      VPC_SERVICE_ID="${2:-}"
      shift 2
      ;;
    --tunnel-id)
      TUNNEL_ID="${2:-}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
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

echo "[1/5] Checking TypeScript types and unit tests..."
pnpm --dir "$SCRIPT_DIR" run typecheck
pnpm --dir "$SCRIPT_DIR" run test

RUNTIME_CFG="$SCRIPT_DIR/.wrangler-deploy.runtime.json"
cleanup() {
  rm -f "$RUNTIME_CFG"
}
trap cleanup EXIT

write_runtime_config() {
  local service_id="$1"
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const raw = fs.readFileSync(path.join(process.argv[1], "wrangler.jsonc"), "utf8");
    const withoutComments = raw
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    const parsed = JSON.parse(withoutComments);
    parsed.name = process.argv[2];
    parsed.vpc_services = [
      {
        binding: "AIOS_ORIGIN",
        service_id: process.argv[3],
        remote: true,
      },
    ];
    delete parsed.$schema;
    fs.writeFileSync(process.argv[4], JSON.stringify(parsed, null, 2) + "\n", "utf8");
  ' "$SCRIPT_DIR" "$WORKER_NAME" "$service_id" "$RUNTIME_CFG"
}

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[2/5] Preparing dry-run config (skipping Cloudflare auth & VPC mutation)..."
  DRY_ID="${VPC_SERVICE_ID:-00000000-0000-0000-0000-000000000000}"
  write_runtime_config "$DRY_ID"
  echo "[3/5] Running wrangler deploy --dry-run..."
  pnpm --dir "$SCRIPT_DIR" exec wrangler deploy --dry-run --config "$RUNTIME_CFG" --outdir "$SCRIPT_DIR/.wrangler/dry-run-dist"
  echo "Dry run succeeded cleanly."
  exit 0
fi

echo "[2/5] Verifying Cloudflare Wrangler authentication..."
if ! pnpm --dir "$SCRIPT_DIR" exec wrangler whoami >/dev/null 2>&1; then
  cat >&2 <<'EOF'
ERROR: Wrangler is not authenticated on this machine.
Please run first:
  pnpm --dir deploy/cloudflare-worker exec wrangler login
and complete Cloudflare OAuth in your browser, then re-run this script.
EOF
  exit 1
fi

if [[ -z "$VPC_SERVICE_ID" ]]; then
  echo "[3/5] Checking existing Workers VPC services for '$VPC_SERVICE_NAME'..."
  LIST_OUT="$(pnpm --dir "$SCRIPT_DIR" exec wrangler vpc service list 2>&1 || true)"
  VPC_SERVICE_ID="$(
    printf '%s\n' "$LIST_OUT" | node -e '
      const fs = require("node:fs");
      const name = process.argv[1];
      const text = fs.readFileSync(0, "utf8");
      for (const line of text.split(/\r?\n/)) {
        if (line.includes(name)) {
          const match = line.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
          if (match) {
            process.stdout.write(match[0]);
            process.exit(0);
          }
        }
      }
    ' "$VPC_SERVICE_NAME"
  )"

  if [[ -n "$VPC_SERVICE_ID" ]]; then
    echo "Found existing Workers VPC service '$VPC_SERVICE_NAME': $VPC_SERVICE_ID"
  else
    echo "Creating Workers VPC service '$VPC_SERVICE_NAME' -> tunnel $TUNNEL_ID ($ORIGIN_IPV4:$ORIGIN_PORT)..."
    CREATE_OUT="$(
      pnpm --dir "$SCRIPT_DIR" exec wrangler vpc service create "$VPC_SERVICE_NAME" \
        --type http \
        --tunnel-id "$TUNNEL_ID" \
        --http-port "$ORIGIN_PORT" \
        --ipv4 "$ORIGIN_IPV4"
    )"
    printf '%s\n' "$CREATE_OUT"
    VPC_SERVICE_ID="$(
      printf '%s\n' "$CREATE_OUT" | node -e '
        const fs = require("node:fs");
        const text = fs.readFileSync(0, "utf8");
        const match = text.match(/Created VPC service:\s*([0-9a-fA-F-]{8,})/);
        if (match) {
          process.stdout.write(match[1]);
          process.exit(0);
        }
        const uuid = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
        if (uuid) {
          process.stdout.write(uuid[0]);
        }
      '
    )"
  fi
fi

if [[ -z "$VPC_SERVICE_ID" ]]; then
  echo "ERROR: Could not determine Workers VPC service ID. Pass --service-id <id> explicitly." >&2
  exit 1
fi

echo "[4/5] Generating temporary deploy config bound to VPC service $VPC_SERVICE_ID..."
write_runtime_config "$VPC_SERVICE_ID"

echo "[5/5] Deploying Worker '$WORKER_NAME' to Cloudflare..."
pnpm --dir "$SCRIPT_DIR" exec wrangler deploy --config "$RUNTIME_CFG" --no-autoconfig

cat <<'EOF'

Deploy finished.
IMPORTANT reminders before sharing the URL:
1. Ensure Cloudflare Zero Trust team `aged-lake-87d1` has `One-time PIN` enabled and attached to `aios-demo`.
2. Ensure ECS (`47.242.128.179`) has `aios-demo-api`, `aios-demo-assurance`, `aios-demo-web`, and `cloudflared` (`hk-aios-demo`) active.
3. Run `/opt/aios/deploy/integrai/06-verify-live.sh --public-origin https://aios-demo.hk-demo.workers.dev` on the ECS host and test browser OTP login with an allowlisted email.
EOF
