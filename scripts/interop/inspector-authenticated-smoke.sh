#!/usr/bin/env bash
# Phase 16: REAL MCP Inspector CLI + REAL signed RS256/JWKS verifier and D1.
# Ephemeral Ubuntu runner only. No production binding, publication or real users.
set -euo pipefail
umask 077

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
work_dir="$(mktemp -d)"
worker_pid=""
port=8988
base="https://127.0.0.1:${port}"
url="${base}/mcp"
issuer="https://auth.telechir.test"
cert="${work_dir}/localhost.crt"
key="${work_dir}/localhost.key"

cleanup() {
  if [[ -n "$worker_pid" ]]; then
    kill "$worker_pid" 2>/dev/null || true
    wait "$worker_pid" 2>/dev/null || true
  fi
  rm -rf "$work_dir"
}
trap cleanup EXIT INT TERM

for command in openssl curl node npx jq timeout; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "FAIL: missing executable: $command" >&2
    exit 1
  }
done

openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
  -keyout "$key" -out "$cert" >/dev/null 2>&1

cd "$repo_root/apps/control-plane"
node test/fixtures/create-authenticated-inspector-fixture.mjs \
  "$work_dir" "$url" "$issuer"
# Private signing material never leaves RAM. All issued tokens stay inside
# the private temp directory, deleted by trap even when the smoke fails.
if ! ./node_modules/.bin/wrangler d1 migrations apply DB --local --yes \
  --persist-to "$work_dir/state" >"$work_dir/migrations.log" 2>&1; then
  echo "FAIL: isolated D1 migration did not apply" >&2
  sed -n '1,100p' "$work_dir/migrations.log" >&2
  exit 1
fi
if ! ./node_modules/.bin/wrangler d1 execute DB --local \
  --persist-to "$work_dir/state" --file "$work_dir/seed.sql" \
  >"$work_dir/seed.log" 2>&1; then
  echo "FAIL: synthetic D1 user/device could not be seeded" >&2
  sed -n '1,100p' "$work_dir/seed.log" >&2
  exit 1
fi
echo "PASS: ephemeral D1 schema and synthetic identity seeded"

mkdir -p "$work_dir/oauth-store"
export MCP_STORAGE_DIR="$work_dir/oauth-store"
export MCP_INSPECTOR_OAUTH_STATE_PATH="$work_dir/oauth-store/oauth.json"
export NODE_EXTRA_CA_CERTS="$cert"
export MCP_AUTO_OPEN_ENABLED=false
export NO_PROXY="127.0.0.1,localhost"
export no_proxy="$NO_PROXY"

./node_modules/.bin/wrangler dev \
  test/fixtures/authenticated-inspector-worker.ts \
  --local \
  --persist-to "$work_dir/state" \
  --local-protocol https \
  --https-key-path "$key" \
  --https-cert-path "$cert" \
  --ip 127.0.0.1 \
  --port "$port" \
  --var "MCP_RESOURCE_URI:$url" \
  --var "OAUTH_ISSUER:$issuer" \
  --var "PHASE16_TEST_JWKS:$(jq -c . "$work_dir/jwks.json")" \
  --show-interactive-dev-session false \
  --log-level warn >"$work_dir/wrangler.log" 2>&1 &
worker_pid=$!

ready=false
for _ in $(seq 1 60); do
  if ! kill -0 "$worker_pid" 2>/dev/null; then
    echo "FAIL: CI-only Wrangler fixture did not stay running" >&2
    sed -n '1,75p' "$work_dir/wrangler.log" >&2
    exit 1
  fi
  if curl --fail --silent --cacert "$cert" \
    --connect-timeout 1 --max-time 2 "$base/health" \
    | jq -e '.status=="ok" and .fixture=="phase16"' >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 0.3
done
[[ "$ready" == "true" ]] || {
  echo "FAIL: HTTPS fixture readiness failed" >&2
  sed -n '1,75p' "$work_dir/wrangler.log" >&2
  exit 1
}

# Fail without sending credentials if a proxy or certificate substitution
# makes our TLS peer different from the ephemeral expected public cert.
node "$repo_root/scripts/interop/verify-local-tls.mjs" \
  --cert "$cert" --host 127.0.0.1 --port "$port" \
  | jq -e '.status=="PASS" and .code=="TLS_PIN_AND_CHAIN_VALIDATED"' >/dev/null
echo "PASS: loopback-only HTTPS, pinned peer certificate and chain"

curl --fail --silent --show-error --cacert "$cert" --max-time 8 \
  "$base/.well-known/oauth-protected-resource" \
  | jq -e --arg resource "$url" --arg issuer "$issuer" \
    '.resource==$resource and .authorization_servers==[$issuer]' >/dev/null
echo "PASS: protected resource OAuth metadata"

valid_token="$(cat "$work_dir/valid.token")"
bad_token="$(cat "$work_dir/wrong-audience.token")"
expected_device="$(cat "$work_dir/device-id")"

# Test the raw OAuth boundary independently from Inspector behavior.
status="$(curl --silent --show-error --cacert "$cert" --max-time 10 \
  --output "$work_dir/no-auth.json" --write-out "%{http_code}" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' "$url")"
[[ "$status" == "401" ]] || { echo "FAIL: missing bearer returned $status" >&2; exit 1; }

status="$(curl --silent --show-error --cacert "$cert" --max-time 10 \
  --output "$work_dir/bad-aud.json" --write-out "%{http_code}" \
  -H "Authorization: Bearer $bad_token" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' "$url")"
[[ "$status" == "401" ]] || { echo "FAIL: wrong-audience JWT returned $status" >&2; exit 1; }

status="$(curl --silent --show-error --cacert "$cert" --max-time 10 \
  --output "$work_dir/denied.json" --dump-header "$work_dir/denied.headers" \
  --write-out "%{http_code}" \
  -H "Authorization: Bearer $valid_token" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"write_file","arguments":{}}}' "$url")"
[[ "$status" == "403" ]] || { echo "FAIL: read-only JWT write attempt returned $status" >&2; exit 1; }
grep -qi 'scope="telechir:files:write"' "$work_dir/denied.headers" || {
  echo "FAIL: denied write did not challenge required scope" >&2
  exit 1
}
echo "PASS: 401 no bearer, 401 wrong audience and 403 insufficient signed JWT scope"

# Inspector runs as an INDEPENDENT PROCESS and never sees the RSA private key.
# Credentials are synthetic, isolated and never printed or uploaded.
inspector() {
  timeout 90s npx --yes @modelcontextprotocol/inspector@2.5.0 --cli \
    "$url" --transport http --stored-auth-only --connect-timeout 10000 \
    --header "Authorization: Bearer $valid_token" --format json "$@"
}
inspector --method initialize >"$work_dir/initialize.json" 2>"$work_dir/initialize.err"
jq -e '.result.serverInfo.name=="telechir"' "$work_dir/initialize.json" >/dev/null
echo "PASS: authenticated real Inspector MCP initialize"

inspector --method tools/list >"$work_dir/tools.json" 2>"$work_dir/tools.err"
jq -e '.result.tools | length==24' "$work_dir/tools.json" >/dev/null
jq -e '.result.tools | map(.name) | index("list_devices")!=null' \
  "$work_dir/tools.json" >/dev/null
jq -e '.result.tools | map(.name) | index("write_file")!=null' \
  "$work_dir/tools.json" >/dev/null
echo "PASS: authenticated real Inspector lists all 24 MCP tools"

inspector --method tools/call --tool-name list_devices \
  --tool-args-json '{"status":"all"}' \
  >"$work_dir/list.json" 2>"$work_dir/list.err"
jq -e --arg id "$expected_device" \
  '.result.isError != true and (.result.structuredContent.devices | any(.device_id==$id))' \
  "$work_dir/list.json" >/dev/null
echo "PASS: authenticated real Inspector reads only seeded synthetic device"

# Validate refusal through the Inspector CLI itself in addition to raw HTTP.
set +e
inspector --method tools/call --tool-name write_file \
  --tool-args-json '{}' >"$work_dir/write.json" 2>"$work_dir/write.err"
write_exit=$?
set -e
[[ "$write_exit" -eq 3 ]] || {
  echo "FAIL: Inspector wrong-scope write exit was $write_exit (expected 3)" >&2
  exit 1
}
echo "PASS: Inspector surfaces OAuth 403 escalation as auth_required (exit 3)"
echo "RESULT: INDEPENDENT_AUTHENTICATED_INSPECTOR_SMOKE_PASS"
echo "NOTE: provider documents/JWKS synthetic, no browser OAuth PKCE or commercial client certified."
