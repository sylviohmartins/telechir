#!/usr/bin/env bash
# CI-only: native workerd fetch() of real Keycloak RFC8414 + JWKS with TLS validation.
# Sourced after replay gate; reuses its official Keycloak, D1 and disposable CA.
set -euo pipefail
[[ "$issuer" == "https://127.0.0.1:9443/realms/telechir-phase16" ]] || exit 1
worker_url="https://127.0.0.1:8988/mcp"
worker_base="https://127.0.0.1:8988"

stop_direct_worker() {
  if [[ -n "$worker_pid" ]]; then
    pkill -TERM -P "$worker_pid" 2>/dev/null || true
    kill "$worker_pid" 2>/dev/null || true
    wait "$worker_pid" 2>/dev/null || true
    worker_pid=""
    sleep 1
  fi
}
start_direct_worker() {
  local ca_for_workerd="$1"
  local label="$2"
  (
    cd "$repo_root/apps/control-plane"
    NODE_EXTRA_CA_CERTS="$ca_for_workerd" \
      NO_PROXY="127.0.0.1,localhost" no_proxy="127.0.0.1,localhost" \
      exec ./node_modules/.bin/wrangler dev \
        test/fixtures/authenticated-inspector-worker.ts \
        --local --persist-to "$worker_state" \
        --local-protocol https \
        --https-key-path "$worker_leaf_key" --https-cert-path "$worker_cert" \
        --ip 127.0.0.1 --port 8988 \
        --var "MCP_RESOURCE_URI:$worker_url" \
        --var "OAUTH_ISSUER:$issuer" \
        --var "OAUTH_SCOPE_CLAIM:telechir_scope_fixture" \
        --var "PHASE16_TEST_DIRECT_KEYCLOAK:true" \
        --show-interactive-dev-session false --log-level warn
  ) >"$work_dir/workerd-direct-$label.log" 2>&1 &
  worker_pid=$!
  local ready=false
  for _ in $(seq 1 85); do
    if ! kill -0 "$worker_pid" 2>/dev/null; then
      echo "FAIL: Workerd direct fixture exited ($label)" >&2
      tail -n 35 "$work_dir/workerd-direct-$label.log" >&2
      exit 1
    fi
    if curl --fail --silent --cacert "$worker_ca" --max-time 2 \
      "$worker_base/health" |
      jq -e '.status=="ok" and .fixture=="phase16"' >/dev/null 2>&1; then
      ready=true
      break
    fi
    sleep 0.3
  done
  [[ "$ready" == "true" ]] || {
    echo "FAIL: Workerd direct fixture not ready ($label)" >&2
    tail -n 35 "$work_dir/workerd-direct-$label.log" >&2
    exit 1
  }
  node "$repo_root/scripts/interop/verify-local-tls.mjs" \
    --cert "$worker_cert" --ca "$worker_ca" --host 127.0.0.1 --port 8988 |
    jq -e '.status=="PASS" and .code=="TLS_PIN_AND_CHAIN_VALIDATED"' >/dev/null
}
# The replay gate just disabled the D1 principal. Restore only this disposable
# issuer to test the same JWT against an alive and correctly-linked user.
stop_direct_worker
(
  cd "$repo_root/apps/control-plane"
  ./node_modules/.bin/wrangler d1 execute DB --local \
    --persist-to "$worker_state" \
    --command "UPDATE users SET disabled_at = NULL WHERE identity_provider = '$issuer';" \
    >"$work_dir/direct-reenable.log" 2>&1 || {
      echo "FAIL: unable to restore test D1 identity" >&2
      exit 1
    }
)

# Independently pin the live Keycloak leaf and its isolated CA.
node "$repo_root/scripts/interop/verify-local-tls.mjs" \
  --cert "$work_dir/tls.crt" --ca "$work_dir/root.crt" \
  --host 127.0.0.1 --port 9443 |
  jq -e '.status=="PASS" and .code=="TLS_PIN_AND_CHAIN_VALIDATED"' >/dev/null

# Negative: Worker is given ONLY its own (different) CA and must refuse the
# token if native fetch cannot establish Keycloak's TLS trust chain.
start_direct_worker "$worker_ca" "untrusted"
token="$(jq -er '.access_token' "$work_dir/token.json")"
status="$(curl --silent --show-error --cacert "$worker_ca" --max-time 15 \
  --output "$work_dir/untrusted-direct.json" --write-out "%{http_code}" \
  -H "Authorization: Bearer $token" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  --data '{"jsonrpc":"2.0","id":91,"method":"tools/list","params":{}}' \
  "$worker_url")"
[[ "$status" == "401" ]] || {
  echo "FAIL: native Workerd accepted unknown Keycloak CA (HTTP $status)" >&2
  exit 1
}
echo "PASS: native Workerd rejects Keycloak issuer without its CA"
stop_direct_worker

# Positive: only Wrangler/Workerd receive the private temporary IdP CA.
# No global trust-store change, NODE_TLS_REJECT_UNAUTHORIZED bypass or replay.
start_direct_worker "$work_dir/root.crt" "trusted"
# Directly interrogate native workerd fetch from a read-only CI-only endpoint
# before sending the Keycloak bearer to the unchanged production verifier.
probe_status="$(curl --silent --show-error --cacert "$worker_ca" --max-time 15 \
  --output "$work_dir/direct-native-fetch-diagnostic.json" \
  --write-out "%{http_code}" "$worker_base/__phase16_direct_idp_probe")"
if [[ "$probe_status" != "200" ]] ||
   ! jq -e '.kind=="DIRECT_IDP_TLS_PASS" and .docs==2' \
     "$work_dir/direct-native-fetch-diagnostic.json" >/dev/null; then
  jq -c 'with_entries(select(.key=="kind" or .key=="reason" or .key=="status"))' \
    "$work_dir/direct-native-fetch-diagnostic.json" >&2 || true
  echo "FAIL: native Workerd could not directly fetch genuine Keycloak metadata/JWKS" >&2
  exit 1
fi
echo "PASS: native Workerd fetched live Keycloak RFC8414 metadata and JWKS over HTTPS"
NODE_EXTRA_CA_CERTS="$worker_ca" NO_PROXY="127.0.0.1,localhost" \
  no_proxy="127.0.0.1,localhost" \
  node "$repo_root/apps/control-plane/test/fixtures/keycloak-worker-mcp-probe.mjs" \
  "$work_dir" positive
(
  cd "$repo_root/apps/control-plane"
  ./node_modules/.bin/wrangler d1 execute DB --local \
    --persist-to "$worker_state" --file "$work_dir/worker-disable.sql" \
    >"$work_dir/direct-disable.log" 2>&1 || {
      echo "FAIL: direct-mode D1 user disable failed" >&2
      exit 1
    }
)
NODE_EXTRA_CA_CERTS="$worker_ca" NO_PROXY="127.0.0.1,localhost" \
  no_proxy="127.0.0.1,localhost" \
  node "$repo_root/apps/control-plane/test/fixtures/keycloak-worker-mcp-probe.mjs" \
  "$work_dir" disabled
echo "RESULT: KEYCLOAK_WORKER_DIRECT_TLS_OAUTH_JWKS_PASS"
echo "NOTE: native Workerd HTTPS discovery/JWKS with ephemeral IdP CA, no snapshot/fetch mock; local Worker and D1 only, not hosted deployment or human PKCE."
