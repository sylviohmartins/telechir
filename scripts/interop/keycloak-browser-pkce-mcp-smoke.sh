#!/usr/bin/env bash
# CI-only real Chromium browser against disposable Keycloak with NSS CA trust.
set -euo pipefail
[[ "$GITHUB_ACTIONS" == "true" && "$(uname -s)" == "Linux" ]] || exit 1
[[ "$issuer" == "https://127.0.0.1:9443/realms/telechir-phase16" ]] || exit 1
for executable in certutil node openssl; do
  command -v "$executable" >/dev/null || { echo "FAIL: missing $executable" >&2; exit 1; }
done
node "$repo_root/scripts/interop/verify-local-tls.mjs" \
  --cert "$work_dir/tls.crt" --ca "$work_dir/root.crt" \
  --host 127.0.0.1 --port 9443 |
  jq -e '.status=="PASS" and .code=="TLS_PIN_AND_CHAIN_VALIDATED"' >/dev/null
stop_direct_worker
NODE_EXTRA_CA_CERTS="$work_dir/root.crt" \
  NO_PROXY="127.0.0.1,localhost" no_proxy="127.0.0.1,localhost" \
  node "$repo_root/apps/control-plane/test/fixtures/keycloak-browser-pkce.mjs" \
    "$work_dir" "$issuer"
(
  cd "$repo_root/apps/control-plane"
  ./node_modules/.bin/wrangler d1 execute DB --local \
    --persist-to "$worker_state" --file "$work_dir/browser-pkce/seed.sql" \
    >"$work_dir/browser-pkce-d1-seed.log" 2>&1 || {
      echo "FAIL: browser PKCE D1 seed rejected" >&2
      tail -n 22 "$work_dir/browser-pkce-d1-seed.log" >&2
      exit 1
    }
)
echo "PASS: Chromium login human subject linked to isolated D1 device"
start_direct_worker "$work_dir/root.crt" "chromium-browser-pkce"
NODE_EXTRA_CA_CERTS="$worker_ca" NO_PROXY="127.0.0.1,localhost" \
  no_proxy="127.0.0.1,localhost" \
  node "$repo_root/apps/control-plane/test/fixtures/keycloak-worker-mcp-probe.mjs" \
    "$work_dir/browser-pkce" positive
(
  cd "$repo_root/apps/control-plane"
  ./node_modules/.bin/wrangler d1 execute DB --local \
    --persist-to "$worker_state" --file "$work_dir/browser-pkce/disable.sql" \
    >"$work_dir/browser-pkce-d1-disable.log" 2>&1 || {
      echo "FAIL: browser PKCE user disable D1 failed" >&2
      tail -n 22 "$work_dir/browser-pkce-d1-disable.log" >&2
      exit 1
    }
)
NODE_EXTRA_CA_CERTS="$worker_ca" NO_PROXY="127.0.0.1,localhost" \
  no_proxy="127.0.0.1,localhost" \
  node "$repo_root/apps/control-plane/test/fixtures/keycloak-worker-mcp-probe.mjs" \
    "$work_dir/browser-pkce" disabled
echo "RESULT: KEYCLOAK_CHROMIUM_BROWSER_PKCE_MCP_D1_PASS"
echo "NOTE: real Chromium UI and consent against official Keycloak with isolated NSS CA; no production tenant, model LLM, published Worker or real person."
