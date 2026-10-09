#!/usr/bin/env bash
# CI-only: independently published MCP Inspector itself starts OAuth against
# genuine Keycloak and resumes MCP after Chrome drives the IdP login UI.
# This is not a replayed token, mocked OAuth server or injected Bearer header.
set -euo pipefail
[[ "$GITHUB_ACTIONS" == "true" && "$(uname -s)" == "Linux" ]] || exit 1
[[ "$issuer" == "https://127.0.0.1:9443/realms/telechir-phase16" ]] || exit 1
for executable in node certutil npx; do
  command -v "$executable" >/dev/null || { echo "FAIL: missing $executable" >&2; exit 1; }
done
stop_direct_worker
# Restore the existing human subject after browser gate disabled it, preserving
# unique (issuer, sub_hash) identity across all three OAuth public clients.
(
  cd "$repo_root/apps/control-plane"
  ./node_modules/.bin/wrangler d1 execute DB --local \
    --persist-to "$worker_state" --file "$work_dir/browser-pkce/seed.sql" \
    >"$work_dir/inspector-reenable.log" 2>&1 || {
      echo "FAIL: unable to restore existing Keycloak laboratory user" >&2
      exit 1
    }
)
start_direct_worker "$work_dir/root.crt" "inspector-interactive-oauth"
# Node's independently published Inspector requires BOTH pinned ephemeral CAs:
# Keycloak OIDC discovery, code exchange, JWKS and Workerd MCP server.
# No system trust changes or global TLS verification bypass.
cat "$work_dir/root.crt" "$worker_ca" >"$work_dir/inspector-client-ca-bundle.crt"
chmod 0600 "$work_dir/inspector-client-ca-bundle.crt"
node "$repo_root/scripts/interop/verify-local-tls.mjs" \
  --cert "$worker_cert" --ca "$worker_ca" --host 127.0.0.1 --port 8988 |
  jq -e '.status=="PASS" and .code=="TLS_PIN_AND_CHAIN_VALIDATED"' >/dev/null
node "$repo_root/scripts/interop/verify-local-tls.mjs" \
  --cert "$work_dir/tls.crt" --ca "$work_dir/root.crt" --host 127.0.0.1 --port 9443 |
  jq -e '.status=="PASS" and .code=="TLS_PIN_AND_CHAIN_VALIDATED"' >/dev/null
NODE_EXTRA_CA_CERTS="$work_dir/inspector-client-ca-bundle.crt" \
  NO_PROXY="127.0.0.1,localhost" no_proxy="127.0.0.1,localhost" \
  timeout 150s node \
    "$repo_root/apps/control-plane/test/fixtures/keycloak-inspector-interactive-oauth.mjs" \
    "$work_dir" "$issuer" "$worker_url"
echo "RESULT: KEYCLOAK_INSPECTOR_EXTERNAL_OAUTH_CLIENT_PASS"
echo "NOTE: official MCP Inspector 2.5.0 independently initiates OAuth PKCE, browser completes real Keycloak UI; local Worker/D1 synthetic identity only."
