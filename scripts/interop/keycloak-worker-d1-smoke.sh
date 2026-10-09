#!/usr/bin/env bash
# Sourced by keycloak-real-idp-contract.sh after real token and TLS verification.
# Requires private temp files, real Keycloak issuer, existing trap and container.
set -euo pipefail
work_dir="$tmp"
resource="https://127.0.0.1:8988/mcp"
worker_base="https://127.0.0.1:8988"
worker_state="$work_dir/worker-state"
worker_ca="$work_dir/worker-root.crt"
worker_key="$work_dir/worker-root.key"
worker_cert="$work_dir/worker-leaf.crt"
worker_leaf_key="$work_dir/worker-leaf.key"

# Fetch the actual public metadata/JWKS over CA-validated HTTPS. Workerd gets
# read-only snapshots via CI-only fixture fetcher, NOT a direct remote IdP TLS
# connection. JWT signature, audience, issuer and D1 checks are production.
curl --fail --silent --show-error --cacert "$work_dir/root.crt" --max-time 12 \
  "https://127.0.0.1:9443/.well-known/oauth-authorization-server/realms/telechir-phase16" \
  -o "$work_dir/keycloak-rfc8414.json"
jq -e --arg issuer "$issuer" \
  '.issuer==$issuer and .jwks_uri==($issuer+"/protocol/openid-connect/certs") and (.code_challenge_methods_supported|index("S256")!=null)' \
  "$work_dir/keycloak-rfc8414.json" >/dev/null
echo "PASS: Keycloak RFC8414 public metadata fetched from real CA-verified issuer"

openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 \
  -subj "/CN=Telechir Worker Phase16 CI CA" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -keyout "$worker_key" -out "$worker_ca" >/dev/null 2>&1
openssl req -new -newkey rsa:2048 -nodes -sha256 \
  -subj "/CN=localhost" -keyout "$worker_leaf_key" \
  -out "$work_dir/worker-leaf.csr" >/dev/null 2>&1
cat >"$work_dir/worker-leaf.ext" <<'EXT'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost,IP:127.0.0.1
EXT
openssl x509 -req -in "$work_dir/worker-leaf.csr" \
  -CA "$worker_ca" -CAkey "$worker_key" -CAcreateserial \
  -out "$worker_cert" -days 1 -sha256 \
  -extfile "$work_dir/worker-leaf.ext" >/dev/null 2>&1
openssl verify -CAfile "$worker_ca" -purpose sslserver "$worker_cert" >/dev/null

(
  cd "$repo_root/apps/control-plane"
  node test/fixtures/keycloak-worker-d1-seed.mjs "$work_dir" "$issuer"
  ./node_modules/.bin/wrangler d1 migrations apply DB --local \
    --persist-to "$worker_state" >"$work_dir/worker-migrations.log" 2>&1 || {
    echo "FAIL: Keycloak Worker D1 migrations" >&2
    tail -n 30 "$work_dir/worker-migrations.log" >&2
    exit 1
  }
  ./node_modules/.bin/wrangler d1 execute DB --local \
    --persist-to "$worker_state" --file "$work_dir/worker-seed.sql" \
    >"$work_dir/worker-seed.log" 2>&1 || {
    echo "FAIL: Keycloak Worker D1 seed" >&2
    tail -n 30 "$work_dir/worker-seed.log" >&2
    exit 1
  }
)
echo "PASS: real Wrangler D1 migrated and seeded with linked and foreign Keycloak CI principals"

(
  cd "$repo_root/apps/control-plane"
  ./node_modules/.bin/wrangler dev \
    test/fixtures/authenticated-inspector-worker.ts \
    --local --persist-to "$worker_state" \
    --local-protocol https \
    --https-key-path "$worker_leaf_key" \
    --https-cert-path "$worker_cert" \
    --ip 127.0.0.1 --port 8988 \
    --var "MCP_RESOURCE_URI:$resource" \
    --var "OAUTH_ISSUER:$issuer" \
    --var "OAUTH_SCOPE_CLAIM:telechir_scope_fixture" \
    --var "PHASE16_TEST_JWKS:$(jq -c . "$work_dir/jwks.json")" \
    --var "PHASE16_TEST_AUTHORIZATION_METADATA:$(jq -c . "$work_dir/keycloak-rfc8414.json")" \
    --show-interactive-dev-session false --log-level warn
) >"$work_dir/worker-wrangler.log" 2>&1 &
worker_pid=$!

ready=false
for _ in $(seq 1 80); do
  if ! kill -0 "$worker_pid" 2>/dev/null; then
    echo "FAIL: Keycloak-backed Worker fixture stopped" >&2
    tail -n 30 "$work_dir/worker-wrangler.log" >&2
    exit 1
  fi
  if curl --fail --silent --cacert "$worker_ca" \
    --connect-timeout 1 --max-time 2 "$worker_base/health" \
    | jq -e '.status=="ok" and .fixture=="phase16"' >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 0.3
done
[[ "$ready" == "true" ]] || {
  echo "FAIL: Keycloak-backed Worker HTTPS readiness" >&2
  tail -n 30 "$work_dir/worker-wrangler.log" >&2
  exit 1
}

node "$repo_root/scripts/interop/verify-local-tls.mjs" \
  --cert "$worker_cert" --ca "$worker_ca" --host 127.0.0.1 --port 8988 \
  | jq -e '.status=="PASS" and .code=="TLS_PIN_AND_CHAIN_VALIDATED"' >/dev/null
echo "PASS: Worker HTTPS certificate leaf pinned and CA chain independently trusted"

NODE_EXTRA_CA_CERTS="$worker_ca" NO_PROXY="127.0.0.1,localhost" \
  no_proxy="127.0.0.1,localhost" \
  node "$repo_root/apps/control-plane/test/fixtures/keycloak-worker-mcp-probe.mjs" \
  "$work_dir" positive
(
  cd "$repo_root/apps/control-plane"
  ./node_modules/.bin/wrangler d1 execute DB --local \
    --persist-to "$worker_state" --file "$work_dir/worker-disable.sql" \
    >"$work_dir/worker-disable.log" 2>&1 || {
    echo "FAIL: D1 principal disable mutation" >&2
    tail -n 30 "$work_dir/worker-disable.log" >&2
    exit 1
  }
)
NODE_EXTRA_CA_CERTS="$worker_ca" NO_PROXY="127.0.0.1,localhost" \
  no_proxy="127.0.0.1,localhost" \
  node "$repo_root/apps/control-plane/test/fixtures/keycloak-worker-mcp-probe.mjs" \
  "$work_dir" disabled
echo "RESULT: KEYCLOAK_WORKER_D1_MCP_AUTHENTICATED_PASS"
echo "NOTE: real Keycloak token + real Worker route + local D1; public IdP documents are pinned HTTPS-fetched snapshots replayed by test fixture, not direct workerd IdP TLS."
