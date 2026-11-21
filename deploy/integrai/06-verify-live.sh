#!/usr/bin/env bash
# ==============================================================================
# IntegrAI Post-Deploy Live Acceptance Verification (06-verify-live.sh)
# ==============================================================================
# Verifies all production security and functional acceptance invariants WITHOUT
# ever printing, logging, or exposing any secret, password, session cookie, or
# CSRF token on stdout, stderr, or process command lines:
#   1. Loopback readiness on :8760, :8761, :3000 (`/healthz` & `/readyz`)
#   2. Loopback-only TCP socket bindings (`127.0.0.1` ONLY via `ss`)
#   3. Hardened HTTP security headers on `/login` (`Referrer-Policy`, `nosniff`, `DENY`)
#   4. Spoofed `Origin` rejection (`403 ORIGIN_REJECTED`) + `Cache-Control: no-store`
#   5. Default weak password `aios2026` rejected (`401`)
#   6. Valid enterprise login (`operator`) sets `__Host-aios_session` cookie with
#      `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Cache-Control: no-store`
#   7. `GET /v1/workbench/capabilities` returns `200`, `Cache-Control: no-store`,
#      and ZERO `planner` or forbidden sanitization keys
#   8. `GET /v1/assurance/cases` authenticates via shared session key on `:8761`
#      with `200`, `Cache-Control: no-store`, and ZERO forbidden keys
#   9. Clean session logout via `DELETE /v1/session` (`204`)
#  10. When `--public-origin https://integrai.<confirmed-domain>` is passed:
#      verifies unauthenticated public requests are blocked/redirected by
#      Cloudflare Zero Trust Access (`302` to `*.cloudflareaccess.com` or `401`/`403`)
#      and NEVER return unauthenticated HTTP 200 app responses.
#
# Usage:
#   sudo ./deploy/integrai/06-verify-live.sh
#   sudo ./deploy/integrai/06-verify-live.sh --public-origin https://integrai.<confirmed-domain>
# ==============================================================================
set +x
set -euo pipefail

WEB_ENV_FILE="/etc/aios/demo-web.env"
PUBLIC_ORIGIN=""
LOCAL_ORIGIN=""
SKIP_AUTH="0"

print_help() {
  cat <<'EOF'
IntegrAI Post-Deploy Live Acceptance Verifier

Options:
  --public-origin <https://integrai.<domain>>
                        Public Cloudflare Access HTTPS origin to verify edge gate
  --origin <https://...>
                        Override AIOS_BROWSER_ORIGIN for loopback BFF tests
                        (defaults to value in /etc/aios/demo-web.env or --public-origin)
  --web-env <path>      Path to demo-web.env (default: /etc/aios/demo-web.env)
  --skip-auth           Skip authenticated BFF cookie/capabilities checks
  -h, --help            Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --public-origin)
      PUBLIC_ORIGIN="${2:-}"
      shift 2
      ;;
    --origin)
      LOCAL_ORIGIN="${2:-}"
      shift 2
      ;;
    --web-env)
      WEB_ENV_FILE="${2:-}"
      shift 2
      ;;
    --skip-auth)
      SKIP_AUTH="1"
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

PUBLIC_ORIGIN="${PUBLIC_ORIGIN%/}"
LOCAL_ORIGIN="${LOCAL_ORIGIN%/}"

PASS_COUNT=0
FAIL_COUNT=0

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf '[PASS] %s\n' "$1"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  printf '[FAIL] %s\n' "$1"
}

printf '==============================================================================\n'
printf '  IntegrAI Post-Deploy Live Acceptance Verification (%s)\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '==============================================================================\n'

# ------------------------------------------------------------------------------
# 1. Loopback Health & Readiness Endpoints
# ------------------------------------------------------------------------------
echo ""
echo "=== 1. Loopback Readiness (:8760, :8761, :3000) ==="
check_loopback_http() {
  local url="$1"
  local label="$2"
  local code
  code="$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' "${url}" 2>/dev/null || printf '000')"
  if [[ "${code}" == "200" ]]; then
    pass "${label} returned HTTP 200"
  else
    fail "${label} returned HTTP ${code} (expected 200)"
  fi
}

check_loopback_http "http://127.0.0.1:8760/healthz" "Core API :8760/healthz"
check_loopback_http "http://127.0.0.1:8760/readyz"  "Core API :8760/readyz"
check_loopback_http "http://127.0.0.1:8761/healthz" "Assurance :8761/healthz"
check_loopback_http "http://127.0.0.1:8761/readyz"  "Assurance :8761/readyz"
check_loopback_http "http://127.0.0.1:3000/healthz" "Web BFF :3000/healthz"
check_loopback_http "http://127.0.0.1:3000/readyz"  "Web BFF :3000/readyz"

# ------------------------------------------------------------------------------
# 2. Loopback-Only Socket Binding Verification
# ------------------------------------------------------------------------------
echo ""
echo "=== 2. Loopback-Only TCP Binding Check ==="
if command -v ss >/dev/null 2>&1; then
  tcp_addrs="$(ss -H -lnt 2>/dev/null | awk '{print $4}' || true)"
  for port in 8760 8761 3000; do
    found_lo=0
    found_non_lo=0
    while IFS= read -r addr; do
      [[ -z "${addr}" ]] && continue
      if [[ "${addr}" == "127.0.0.1:${port}" ]]; then
        found_lo=1
      elif [[ "${addr}" == *":${port}" ]]; then
        found_non_lo=1
        fail "Port ${port} is exposed on non-loopback address: ${addr}"
      fi
    done <<<"${tcp_addrs}"
    if [[ "${found_lo}" -eq 1 && "${found_non_lo}" -eq 0 ]]; then
      pass "Port ${port} bound strictly to 127.0.0.1"
    elif [[ "${found_lo}" -eq 0 ]]; then
      fail "Port ${port} is not listening on 127.0.0.1"
    fi
  done
else
  fail "'ss' command unavailable; cannot verify loopback bindings"
fi

# ------------------------------------------------------------------------------
# 3. BFF Headers, Cookie Flags, Cache-Control, Sanitization & Dual-Port Session
# ------------------------------------------------------------------------------
echo ""
echo "=== 3. BFF Security Headers, Cookie Flags, Cache-Control & Sanitization ==="
if [[ "${SKIP_AUTH}" == "1" ]]; then
  echo "[info] --skip-auth specified; skipping authenticated loopback BFF tests."
else
  if python3 - "${WEB_ENV_FILE}" "${LOCAL_ORIGIN}" "${PUBLIC_ORIGIN}" <<'PY'
import getpass
import http.client
import json
import os
import sys
from urllib.parse import urlsplit

web_env_path, local_origin_arg, public_origin_arg = sys.argv[1], sys.argv[2], sys.argv[3]

FORBIDDEN_KEYS = {
    "planner",
    "reasoning",
    "chain_of_thought",
    "thought",
    "raw_tokens",
    "prompt",
    "system_prompt",
    "tool_args",
    "internal_args",
    "model_name",
    "llm_model",
    "provider",
    "usage",
    "token_usage",
    "api_key",
    "secret",
    "traceback",
    "stack",
}

def read_env_map(path):
    data = {}
    if not os.path.isfile(path) or not os.access(path, os.R_OK):
        return data
    with open(path, "r", encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            data[k.strip()] = v.strip()
    return data

env_map = read_env_map(web_env_path)
origin = (local_origin_arg or env_map.get("AIOS_BROWSER_ORIGIN") or public_origin_arg or "").rstrip("/")
password = env_map.get("AIOS_DEMO_LOGIN_PASSWORD", "")

if not origin:
    sys.exit("[FAIL] Unable to determine AIOS_BROWSER_ORIGIN (run with sudo or pass --origin).")
if not password:
    if sys.stdin.isatty():
        password = getpass.getpass("Enter AIOS_DEMO_LOGIN_PASSWORD for loopback verification (hidden): ")
    else:
        sys.exit("[FAIL] Cannot read AIOS_DEMO_LOGIN_PASSWORD (run with sudo or interactive TTY).")

failures = []

def check(cond, ok_msg, err_msg):
    if cond:
        print(f"[PASS] {ok_msg}")
    else:
        print(f"[FAIL] {err_msg}")
        failures.append(err_msg)

def req(method, path, headers=None, body_obj=None):
    conn = http.client.HTTPConnection("127.0.0.1", 3000, timeout=10)
    hdrs = dict(headers or {})
    body = None
    if body_obj is not None:
        body = json.dumps(body_obj).encode("utf-8")
        hdrs["Content-Type"] = "application/json"
    conn.request(method, path, body=body, headers=hdrs)
    resp = conn.getresponse()
    raw = resp.read()
    resp_headers = resp.headers
    status = resp.status
    conn.close()
    return status, resp_headers, raw

def find_forbidden_keys(obj, prefix=""):
    found = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            full = f"{prefix}.{k}" if prefix else k
            if k.lower() in FORBIDDEN_KEYS:
                found.append(full)
            found.extend(find_forbidden_keys(v, full))
    elif isinstance(obj, list):
        for i, item in enumerate(obj):
            found.extend(find_forbidden_keys(item, f"{prefix}[{i}]"))
    return found

# 3a. Security headers on /login
st, hdrs, _ = req("GET", "/login")
check(st == 200, "GET /login returned HTTP 200", f"GET /login returned HTTP {st}")
check((hdrs.get("Referrer-Policy") or "").lower() == "no-referrer",
      "GET /login sets Referrer-Policy: no-referrer",
      f"GET /login missing Referrer-Policy: no-referrer (got {hdrs.get('Referrer-Policy')!r})")
check((hdrs.get("X-Content-Type-Options") or "").lower() == "nosniff",
      "GET /login sets X-Content-Type-Options: nosniff",
      f"GET /login missing nosniff (got {hdrs.get('X-Content-Type-Options')!r})")
check((hdrs.get("X-Frame-Options") or "").upper() == "DENY",
      "GET /login sets X-Frame-Options: DENY",
      f"GET /login missing X-Frame-Options: DENY (got {hdrs.get('X-Frame-Options')!r})")

# 3b. Spoofed Origin rejection
st, hdrs, raw = req("POST", "/api/auth/login",
                    headers={"Origin": "https://evil.invalid"},
                    body_obj={"username": "operator", "password": "not-the-password"})
cc = (hdrs.get("Cache-Control") or "").lower()
check(st == 403, "Spoofed Origin rejected with HTTP 403", f"Spoofed Origin returned HTTP {st} (expected 403)")
check("no-store" in cc, "Spoofed Origin response has Cache-Control: no-store",
      f"Spoofed Origin missing Cache-Control: no-store (got {cc!r})")

# 3c. Weak default password aios2026 must be rejected
st, hdrs, _ = req("POST", "/api/auth/login",
                  headers={"Origin": origin},
                  body_obj={"username": "operator", "password": "aios2026"})
check(st == 401, "Default weak password 'aios2026' is rejected (HTTP 401)",
      f"Weak password 'aios2026' returned HTTP {st} (expected 401; rotate AIOS_DEMO_LOGIN_PASSWORD immediately!)")

# 3d. Real login -> verify cookie flags & Cache-Control: no-store (never print cookie or csrf!)
st, hdrs, raw = req("POST", "/api/auth/login",
                    headers={"Origin": origin},
                    body_obj={"username": "operator", "password": password})
cc = (hdrs.get("Cache-Control") or "").lower()
check(st == 200, "POST /api/auth/login succeeded (HTTP 200)", f"POST /api/auth/login failed with HTTP {st}")
check("no-store" in cc, "POST /api/auth/login has Cache-Control: no-store",
      f"POST /api/auth/login missing Cache-Control: no-store (got {cc!r})")

set_cookies = hdrs.get_all("Set-Cookie") or []
is_https = urlsplit(origin).scheme == "https"
expected_cookie_name = "__Host-aios_session" if is_https else "aios_demo_session"
session_set_cookie = None
for sc in set_cookies:
    if sc.startswith(expected_cookie_name + "="):
        session_set_cookie = sc
        break

check(session_set_cookie is not None,
      f"Set-Cookie issues {expected_cookie_name}",
      f"Set-Cookie missing {expected_cookie_name}")

cookie_pair = ""
csrf_token = ""
if session_set_cookie:
    parts = [p.strip() for p in session_set_cookie.split(";")]
    cookie_pair = parts[0]
    attrs_lower = {p.lower() for p in parts[1:]}
    check("httponly" in attrs_lower, "Session cookie sets HttpOnly", "Session cookie missing HttpOnly")
    if is_https:
        check("secure" in attrs_lower, "Session cookie sets Secure", "Session cookie missing Secure")
    check("samesite=lax" in attrs_lower, "Session cookie sets SameSite=Lax",
          "Session cookie missing SameSite=Lax")
    check("path=/" in attrs_lower, "Session cookie sets Path=/", "Session cookie missing Path=/")
    check(not any(a.startswith("domain=") for a in attrs_lower),
          "Session cookie has no Domain attribute (strict __Host- host-only binding)",
          "Session cookie unexpectedly sets Domain=")

if st == 200:
    login_json = json.loads(raw.decode("utf-8"))
    csrf_token = str(login_json.get("csrf_token") or "")
    check(len(csrf_token) >= 16, "Login payload returns non-empty csrf_token", "Missing csrf_token in login response")

# 3e. GET /v1/workbench/capabilities -> no-store + zero forbidden keys / planner
if cookie_pair:
    st, hdrs, raw = req("GET", "/v1/workbench/capabilities", headers={"Cookie": cookie_pair})
    cc = (hdrs.get("Cache-Control") or "").lower()
    check(st == 200, "GET /v1/workbench/capabilities returned HTTP 200",
          f"GET /v1/workbench/capabilities returned HTTP {st}")
    check("no-store" in cc, "GET /v1/workbench/capabilities has Cache-Control: no-store",
          f"GET /v1/workbench/capabilities missing no-store (got {cc!r})")
    if st == 200:
        cap_json = json.loads(raw.decode("utf-8"))
        bad_keys = find_forbidden_keys(cap_json)
        check("planner" not in cap_json and len(bad_keys) == 0,
              "GET /v1/workbench/capabilities has zero 'planner' or forbidden keys",
              f"Forbidden key(s) leaked in capabilities: {bad_keys}")

    # 3f. GET /v1/assurance/cases -> proves dual-port :8761 routing & shared session encryption key
    st, hdrs, raw = req("GET", "/v1/assurance/cases", headers={"Cookie": cookie_pair})
    cc = (hdrs.get("Cache-Control") or "").lower()
    check(st == 200, "GET /v1/assurance/cases (routed to :8761) returned HTTP 200",
          f"GET /v1/assurance/cases returned HTTP {st} (check :8761 & shared AIOS_BROWSER_SESSION_KEY)")
    check("no-store" in cc, "GET /v1/assurance/cases has Cache-Control: no-store",
          f"GET /v1/assurance/cases missing no-store (got {cc!r})")
    if st == 200:
        assur_json = json.loads(raw.decode("utf-8"))
        bad_keys = find_forbidden_keys(assur_json)
        check(len(bad_keys) == 0,
              "GET /v1/assurance/cases has zero forbidden keys",
              f"Forbidden key(s) leaked in assurance cases: {bad_keys}")

    # 3g. Clean logout
    st, hdrs, _ = req("DELETE", "/v1/session",
                      headers={"Cookie": cookie_pair, "Origin": origin, "X-CSRF-Token": csrf_token})
    check(st == 204, "DELETE /v1/session cleaned up test session (HTTP 204)",
          f"DELETE /v1/session returned HTTP {st} (expected 204)")

if failures:
    sys.exit(1)
PY
  then
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
fi

# ------------------------------------------------------------------------------
# 4. Public Cloudflare Zero Trust Access Gate Check (optional --public-origin)
# ------------------------------------------------------------------------------
if [[ -n "${PUBLIC_ORIGIN}" ]]; then
  echo ""
  echo "=== 4. Public Cloudflare Access Gate Check (${PUBLIC_ORIGIN}) ==="
  if ! python3 - "${PUBLIC_ORIGIN}" <<'PY'
import sys
from urllib.parse import urlsplit
u = urlsplit(sys.argv[1])
host = (u.hostname or "").lower()
if u.scheme != "https" or not host or u.path or u.query:
    sys.exit("[error] --public-origin must be an exact https:// origin with no path.")
if host in {"integrai.com", "www.integrai.com", "example.com"} or host.endswith(".example.com"):
    sys.exit(f"[error] Refusing placeholder public host '{host}'. Pass your confirmed Cloudflare domain.")
PY
  then
    fail "Invalid --public-origin: ${PUBLIC_ORIGIN}"
  else
    for path in /login /readyz /v1/me; do
      hdr_tmp="$(mktemp /tmp/aios-pub-hdr.XXXXXX)"
      http_code="$(curl -sS --max-time 10 -D "${hdr_tmp}" -o /dev/null -w '%{http_code}' "${PUBLIC_ORIGIN}${path}" 2>/dev/null || printf '000')"
      loc="$(awk 'BEGIN{IGNORECASE=1} /^location:/ {sub(/^[^:]+:[[:space:]]*/, ""); sub(/\r$/, ""); print; exit}' "${hdr_tmp}")"
      rm -f "${hdr_tmp}"

      if [[ "${http_code}" == "302" && "${loc}" == *"cloudflareaccess.com"* ]]; then
        if [[ "${loc}" == *"aged-lake-87d1.cloudflareaccess.com"* ]]; then
          pass "Public ${path} gated by Cloudflare Access team aged-lake-87d1 (HTTP 302)"
        else
          pass "Public ${path} gated by Cloudflare Access (HTTP 302 -> ${loc%%\?*})"
        fi
      elif [[ "${http_code}" == "401" || "${http_code}" == "403" ]]; then
        pass "Public ${path} blocked unauthenticated request (HTTP ${http_code})"
      else
        fail "Public ${path} NOT properly gated by Cloudflare Access! Got HTTP ${http_code} Location='${loc:-none}'"
      fi
    done
  fi
else
  echo ""
  echo "=== 4. Public Cloudflare Access Gate Check ==="
  echo "[info] Pass --public-origin https://integrai.<confirmed-domain> to verify Cloudflare Access rejection."
fi

printf '\n==============================================================================\n'
printf '  Live Verification Summary: PASS_GROUPS=%d  FAIL_GROUPS=%d\n' "${PASS_COUNT}" "${FAIL_COUNT}"
printf '==============================================================================\n'

if [[ "${FAIL_COUNT}" -gt 0 ]]; then
  exit 1
fi
exit 0
