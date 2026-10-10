#!/usr/bin/env bash
# Keycloak/Workerd lab: real Gemini CLI initiates OAuth, never a fixture Bearer.
# Sourced only by the ephemeral Linux GitHub Actions Keycloak harness.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == "true" && "$(uname -s)" == "Linux" ]] || exit 1
[[ "$issuer" == "https://127.0.0.1:9443/realms/telechir-phase16" ]] || exit 1
for binary in node certutil npx jq; do command -v "$binary" >/dev/null || exit 1; done
stop_direct_worker
(
  cd "$repo_root/apps/control-plane"
  ./node_modules/.bin/wrangler d1 execute DB --local \
    --persist-to "$worker_state" --file "$work_dir/browser-pkce/seed.sql" \
    >"$work_dir/gemini-reenable.log" 2>&1 || {
      echo "FAIL: Gemini OAuth D1 subject not enabled" >&2
      exit 1
    }
)
start_direct_worker "$work_dir/root.crt" "gemini-cli-native-oauth"
node "$repo_root/scripts/interop/verify-local-tls.mjs" \
  --cert "$work_dir/tls.crt" --ca "$work_dir/root.crt" --host 127.0.0.1 --port 9443 |
  jq -e '.status=="PASS" and .code=="TLS_PIN_AND_CHAIN_VALIDATED"' >/dev/null
node "$repo_root/scripts/interop/verify-local-tls.mjs" \
  --cert "$worker_cert" --ca "$worker_ca" --host 127.0.0.1 --port 8988 |
  jq -e '.status=="PASS" and .code=="TLS_PIN_AND_CHAIN_VALIDATED"' >/dev/null
cat "$work_dir/root.crt" "$worker_ca" >"$work_dir/gemini-native-dual-ca.crt"
chmod 0600 "$work_dir/gemini-native-dual-ca.crt"
NODE_EXTRA_CA_CERTS="$work_dir/gemini-native-dual-ca.crt" \
  SSL_CERT_FILE="$work_dir/gemini-native-dual-ca.crt" \
  NO_PROXY="127.0.0.1,localhost" no_proxy="127.0.0.1,localhost" \
  timeout 130s node \
  "$repo_root/apps/control-plane/test/fixtures/keycloak-gemini-cli-native-oauth.mjs" \
  "$work_dir" "$issuer" "$worker_url"
# This probe may legitimately report NOT_TESTED if 'gemini mcp list' does not
# start OAuth. Only the Node harness may emit a bounded vendor-OAuth PASS.
echo "RESULT: GEMINI_CLI_MANAGEMENT_AUTH_PROBE_COMPLETED_NOT_A_CERTIFICATION"
