#!/usr/bin/env bash
# Sourced after strict native Workerd → Keycloak TLS gate.
# Executes a scripted real user login form over validated HTTPS, then real D1/MCP.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == "true" && "$(uname -s)" == "Linux" ]] || {
  echo "FAIL: PKCE real IdP gate is Linux CI only" >&2
  exit 1
}
[[ "$issuer" == "https://127.0.0.1:9443/realms/telechir-phase16" ]] || exit 1
node "$repo_root/scripts/interop/verify-local-tls.mjs" \
  --cert "$work_dir/tls.crt" --ca "$work_dir/root.crt" --host 127.0.0.1 --port 9443 \
  | jq -e '.status=="PASS" and .code=="TLS_PIN_AND_CHAIN_VALIDATED"' >/dev/null
stop_direct_worker
NODE_EXTRA_CA_CERTS="$work_dir/root.crt" NO_PROXY="127.0.0.1,localhost" \
  no_proxy="127.0.0.1,localhost" \
  node "$repo_root/apps/control-plane/test/fixtures/keycloak-real-pkce-login.mjs" \
    "$work_dir" "$issuer"
(
  cd "$repo_root/apps/control-plane"
  ./node_modules/.bin/wrangler d1 execute DB --local \
    --persist-to "$worker_state" --file "$work_dir/pkce/seed.sql" \
    >"$work_dir/pkce-d1-seed.log" 2>&1 || {
    echo "FAIL: real Keycloak PKCE principal could not be linked in D1" >&2
    tail -n 20 "$work_dir/pkce-d1-seed.log" >&2
    exit 1
  }
)
echo "PASS: genuine Keycloak user sub linked to new owner/device in persisted Wrangler D1"
start_direct_worker "$work_dir/root.crt" "human-pkce"
NODE_EXTRA_CA_CERTS="$worker_ca" NO_PROXY="127.0.0.1,localhost" \
  no_proxy="127.0.0.1,localhost" \
  node "$repo_root/apps/control-plane/test/fixtures/keycloak-worker-mcp-probe.mjs" \
    "$work_dir/pkce" positive
(
  cd "$repo_root/apps/control-plane"
  ./node_modules/.bin/wrangler d1 execute DB --local \
    --persist-to "$worker_state" --file "$work_dir/pkce/disable.sql" \
    >"$work_dir/pkce-d1-disable.log" 2>&1 || {
    echo "FAIL: real Keycloak PKCE D1 disabled-at mutation failed" >&2
    tail -n 20 "$work_dir/pkce-d1-disable.log" >&2
    exit 1
  }
)
NODE_EXTRA_CA_CERTS="$worker_ca" NO_PROXY="127.0.0.1,localhost" \
  no_proxy="127.0.0.1,localhost" \
  node "$repo_root/apps/control-plane/test/fixtures/keycloak-worker-mcp-probe.mjs" \
    "$work_dir/pkce" disabled
echo "RESULT: KEYCLOAK_REAL_PKCE_MCP_D1_HUMAN_USER_PASS"
echo "NOTE: official Keycloak public client + actual login form over CA-verified HTTPS, not graphical browser or consent. Worker/D1 are local CI only."
