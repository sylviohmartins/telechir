#!/usr/bin/env bash
# Phase 16: independent MCP Inspector CLI test against an isolated local Worker.
# NO production deployment, NO credentials, NO TLS verification bypass.
set -euo pipefail
umask 077

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
work_dir="$(mktemp -d)"
cert="$work_dir/localhost.crt"
key="$work_dir/localhost.key"
worker_pid=""
port=8987
base="https://127.0.0.1:${port}"
url="${base}/mcp"

cleanup() {
  if [[ -n "$worker_pid" ]]; then
    kill "$worker_pid" 2>/dev/null || true
    wait "$worker_pid" 2>/dev/null || true
  fi
  rm -rf "$work_dir"
}
trap cleanup EXIT INT TERM

for command in openssl curl node npx jq timeout; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "FAIL: required executable not found: $command" >&2
    exit 1
  fi
done

# A generated one-day X.509 cert; the PRIVATE KEY is never committed or logged.
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
  -keyout "$key" -out "$cert" >/dev/null 2>&1

mkdir -p "$work_dir/oauth-store"
export MCP_STORAGE_DIR="$work_dir/oauth-store"
export MCP_INSPECTOR_OAUTH_STATE_PATH="$work_dir/oauth-store/oauth.json"
export NODE_EXTRA_CA_CERTS="$cert"
export MCP_AUTO_OPEN_ENABLED=false

# Local Wrangler + loopback only. OAuth issuer is a non-routable test fixture:
# deliberately NO token or authorization-code flow can succeed.
cd "$repo_root/apps/control-plane"
./node_modules/.bin/wrangler dev \
  --local \
  --local-protocol https \
  --https-key-path "$key" \
  --https-cert-path "$cert" \
  --ip 127.0.0.1 \
  --port "$port" \
  --var "MCP_RESOURCE_URI:$url" \
  --var "OAUTH_ISSUER:https://auth.telechir.test" \
  --show-interactive-dev-session false \
  --log-level warn >"$work_dir/wrangler.log" 2>&1 &
worker_pid=$!

ready=false
for i in $(seq 1 50); do
  if ! kill -0 "$worker_pid" 2>/dev/null; then
    echo "FAIL: local Wrangler process terminated before readiness" >&2
    sed -n '1,80p' "$work_dir/wrangler.log" >&2
    exit 1
  fi
  if curl --fail --silent --show-error --cacert "$cert" \
    --connect-timeout 1 --max-time 2 \
    "$base/health" >"$work_dir/health.json" 2>/dev/null; then
    ready=true
    break
  fi
  sleep 0.3
done
if [[ "$ready" != "true" ]]; then
  echo "FAIL: local HTTPS Worker did not become ready with a trusted certificate" >&2
  sed -n '1,80p' "$work_dir/wrangler.log" >&2
  exit 1
fi
jq -e '.data.status == "ok" or .status == "ok"' "$work_dir/health.json" >/dev/null
echo "PASS: local-only HTTPS Worker health"

# A successful pin and chain check must precede even a read-only MCP request.
node "$repo_root/scripts/interop/verify-local-tls.mjs" \
  --cert "$cert" --host 127.0.0.1 --port "$port" \
  | jq -e '.status == "PASS" and .code == "TLS_PIN_AND_CHAIN_VALIDATED"' >/dev/null
echo "PASS: TLS certificate fingerprint and chain verified"

# OAuth protected-resource metadata is public; no JWT or identity required.
curl --fail --silent --show-error --cacert "$cert" --max-time 10 \
  "$base/.well-known/oauth-protected-resource" \
  | jq -e --arg resource "$url" \
      '.resource == $resource and (.authorization_servers | length) == 1' >/dev/null
echo "PASS: OAuth protected-resource metadata"

# Raw wire check isolates HTTP auth from the independent MCP client behavior.
status="$(curl --silent --show-error --cacert "$cert" --max-time 10 \
  --output "$work_dir/unauthenticated.json" \
  --dump-header "$work_dir/unauthenticated.headers" \
  --write-out "%{http_code}" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  "$url")"
if [[ "$status" != "401" ]]; then
  echo "FAIL: MCP unauthenticated request expected HTTP 401; received $status" >&2
  exit 1
fi
if ! grep -qi '^www-authenticate:.*Bearer' "$work_dir/unauthenticated.headers"; then
  echo "FAIL: expected OAuth WWW-Authenticate Bearer challenge" >&2
  exit 1
fi
echo "PASS: unauthenticated MCP tool discovery denied with HTTP 401"

# The REAL upstream MCP Inspector CLI is a separate process and codebase.
# Empty isolated storage and --stored-auth-only forbid interactive OAuth and
# credential reuse. Exit 3 is the documented auth_required response.
set +e
timeout 90s npx --yes @modelcontextprotocol/inspector@2.5.0 --cli \
  "$url" --transport http --stored-auth-only --method tools/list --format json \
  >"$work_dir/inspector.json" 2>"$work_dir/inspector.stderr"
inspector_exit=$?
set -e
if [[ "$inspector_exit" -ne 3 ]]; then
  echo "FAIL: independent Inspector expected auth_required (exit 3), got exit $inspector_exit" >&2
  sed -n '1,60p' "$work_dir/inspector.stderr" >&2
  exit 1
fi
if ! grep -qi 'auth_required\|no_stored_token' \
  "$work_dir/inspector.stderr" "$work_dir/inspector.json"; then
  echo "FAIL: Inspector exit 3 lacked an auth-required diagnostic" >&2
  exit 1
fi

echo "PASS: MCP Inspector 2.5.0 real CLI correctly rejected absent OAuth credentials"
echo "RESULT: INDEPENDENT_CLIENT_UNAUTHENTICATED_SMOKE_PASS"
echo "NOTE: no JWT, tool list, authorized action, external AI vendor, or production tested."
