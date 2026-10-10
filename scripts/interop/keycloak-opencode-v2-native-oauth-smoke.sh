#!/usr/bin/env bash
# Official OpenCode V2 CLI owns authorization, PKCE and OAuth code exchange.
# CI uses disposable Keycloak and Workerd/D1; no real model or device.
set -euo pipefail
[[ "$GITHUB_ACTIONS" == "true" && "$(uname -s)" == "Linux" ]] || exit 1
[[ "$issuer" == "https://127.0.0.1:9443/realms/telechir-phase16" ]] || exit 1
for binary in node npx certutil jq curl; do
  command -v "$binary" >/dev/null || { echo "FAIL: missing OpenCode dependency $binary" >&2; exit 1; }
done
stop_direct_worker
(
  cd "$repo_root/apps/control-plane"
  ./node_modules/.bin/wrangler d1 execute DB --local \
    --persist-to "$worker_state" --file "$work_dir/browser-pkce/seed.sql" \
    >"$work_dir/opencode-reenable.log" 2>&1 || {
      echo "FAIL: cannot restore disposable D1 user for OpenCode" >&2
      exit 1
    }
)
start_direct_worker "$work_dir/root.crt" "opencode-v2-native-oauth"
node "$repo_root/scripts/interop/verify-local-tls.mjs" \
  --cert "$work_dir/tls.crt" --ca "$work_dir/root.crt" --host 127.0.0.1 --port 9443 |
  jq -e '.status=="PASS" and .code=="TLS_PIN_AND_CHAIN_VALIDATED"' >/dev/null
node "$repo_root/scripts/interop/verify-local-tls.mjs" \
  --cert "$worker_cert" --ca "$worker_ca" --host 127.0.0.1 --port 8988 |
  jq -e '.status=="PASS" and .code=="TLS_PIN_AND_CHAIN_VALIDATED"' >/dev/null
cat "$work_dir/root.crt" "$worker_ca" >"$work_dir/opencode-v2-dual-ca.crt"
chmod 0600 "$work_dir/opencode-v2-dual-ca.crt"
NODE_EXTRA_CA_CERTS="$work_dir/opencode-v2-dual-ca.crt" \
  SSL_CERT_FILE="$work_dir/opencode-v2-dual-ca.crt" \
  NO_PROXY="127.0.0.1,localhost" no_proxy="127.0.0.1,localhost" \
  timeout 210s node \
  "$repo_root/apps/control-plane/test/fixtures/keycloak-opencode-v2-native-oauth.mjs" \
  "$work_dir" "$issuer" "$worker_url"
# Independent reference: read the official OpenCode CI credential store only in
# this disposable process and call the production MCP route directly. This is
# NOT a vendor tools/call; the CLI itself is never given an injected bearer.
NODE_EXTRA_CA_CERTS="$work_dir/opencode-v2-dual-ca.crt" \
  SSL_CERT_FILE="$work_dir/opencode-v2-dual-ca.crt" \
  NO_PROXY="127.0.0.1,localhost" no_proxy="127.0.0.1,localhost" \
  timeout 30s node \
  "$repo_root/apps/control-plane/test/fixtures/keycloak-opencode-v2-stored-token-server-probe.mjs" \
  "$work_dir" "$worker_url" baseline
# The SAME OpenCode-stored OAuth session must be refused when D1 disables its
# linked subject. Never replace the vendor token, perform a second OAuth
# login, or downgrade/disable TLS in this adversarial test.
(
  cd "$repo_root/apps/control-plane"
  ./node_modules/.bin/wrangler d1 execute DB --local \
    --persist-to "$worker_state" --file "$work_dir/browser-pkce/disable.sql" \
    >"$work_dir/opencode-disabled.log" 2>&1 || {
      echo "FAIL: unable to disable OpenCode synthetic user in real D1" >&2
      exit 1
    }
)
# Fail closed if a general Worker outage could explain the denied connection.
curl --fail --silent --show-error --cacert "$worker_ca" --max-time 8 \
  "$worker_base/health" |
  jq -e '.status=="ok" and .fixture=="phase16"' >/dev/null || {
    echo "FAIL: Worker unavailable during OpenCode disabled-user gate" >&2
    exit 1
  }
NODE_EXTRA_CA_CERTS="$work_dir/opencode-v2-dual-ca.crt" \
  SSL_CERT_FILE="$work_dir/opencode-v2-dual-ca.crt" \
  NO_PROXY="127.0.0.1,localhost" no_proxy="127.0.0.1,localhost" \
  timeout 80s node \
  "$repo_root/apps/control-plane/test/fixtures/keycloak-opencode-v2-oauth-revocation.mjs" \
  "$work_dir" "$worker_url" disabled
# Server authorization, unlike the OpenCode connection label, must reject
# the same OAuth token at the production tools/list boundary while disabled.
NODE_EXTRA_CA_CERTS="$work_dir/opencode-v2-dual-ca.crt" \
  SSL_CERT_FILE="$work_dir/opencode-v2-dual-ca.crt" \
  NO_PROXY="127.0.0.1,localhost" no_proxy="127.0.0.1,localhost" \
  timeout 30s node \
  "$repo_root/apps/control-plane/test/fixtures/keycloak-opencode-v2-stored-token-server-probe.mjs" \
  "$work_dir" "$worker_url" disabled

# Recovery with the SAME OAuth credential rules out a broken CLI profile,
# TLS regression or a permanently inaccessible fixture as the failure cause.
(
  cd "$repo_root/apps/control-plane"
  ./node_modules/.bin/wrangler d1 execute DB --local \
    --persist-to "$worker_state" --file "$work_dir/browser-pkce/seed.sql" \
    >"$work_dir/opencode-reenabled-after-disable.log" 2>&1 || {
      echo "FAIL: unable to restore OpenCode synthetic user in real D1" >&2
      exit 1
    }
)
NODE_EXTRA_CA_CERTS="$work_dir/opencode-v2-dual-ca.crt" \
  SSL_CERT_FILE="$work_dir/opencode-v2-dual-ca.crt" \
  NO_PROXY="127.0.0.1,localhost" no_proxy="127.0.0.1,localhost" \
  timeout 80s node \
  "$repo_root/apps/control-plane/test/fixtures/keycloak-opencode-v2-oauth-revocation.mjs" \
  "$work_dir" "$worker_url" reenabled
NODE_EXTRA_CA_CERTS="$work_dir/opencode-v2-dual-ca.crt" \
  SSL_CERT_FILE="$work_dir/opencode-v2-dual-ca.crt" \
  NO_PROXY="127.0.0.1,localhost" no_proxy="127.0.0.1,localhost" \
  timeout 30s node \
  "$repo_root/apps/control-plane/test/fixtures/keycloak-opencode-v2-stored-token-server-probe.mjs" \
  "$work_dir" "$worker_url" reenabled
echo "RESULT: KEYCLOAK_OPENCODE_V2_SERVER_SCOPE_REVOCATION_REFERENCE_PASS"\necho "NOT_CERTIFIED: official OpenCode mcp list may remain connected during D1 disable; no vendor tool invocation proven"
echo "RESULT: KEYCLOAK_OPENCODE_V2_VENDOR_OAUTH_GATE_PASS"
echo "NOTE: vendor-owned login and reconnect only; no LLM inference or tool execution."
