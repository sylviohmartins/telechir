#!/usr/bin/env bash
# Genuine official Claude Code CLI owns OAuth PKCE; Chrome only operates Keycloak
# login/consent. Private disposable Linux CI only; no Anthropic account or LLM.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == "true" && "$(uname -s)" == "Linux" ]] || exit 1
[[ "$issuer" == "https://127.0.0.1:9443/realms/telechir-phase16" ]] || exit 1
for binary in node npx certutil script stty jq; do
  command -v "$binary" >/dev/null || { echo "FAIL: missing Claude OAuth dependency $binary" >&2; exit 1; }
done
stop_direct_worker
(
  cd "$repo_root/apps/control-plane"
  ./node_modules/.bin/wrangler d1 execute DB --local \
    --persist-to "$worker_state" --file "$work_dir/browser-pkce/seed.sql" \
    >"$work_dir/claude-reenable.log" 2>&1 || {
      echo "FAIL: cannot reenable Keycloak synthetic owner for Claude CI" >&2
      exit 1
    }
)
start_direct_worker "$work_dir/root.crt" "claude-cli-native-oauth"
node "$repo_root/scripts/interop/verify-local-tls.mjs" \
  --cert "$work_dir/tls.crt" --ca "$work_dir/root.crt" --host 127.0.0.1 --port 9443 |
  jq -e '.status=="PASS" and .code=="TLS_PIN_AND_CHAIN_VALIDATED"' >/dev/null
node "$repo_root/scripts/interop/verify-local-tls.mjs" \
  --cert "$worker_cert" --ca "$worker_ca" --host 127.0.0.1 --port 8988 |
  jq -e '.status=="PASS" and .code=="TLS_PIN_AND_CHAIN_VALIDATED"' >/dev/null
cat "$work_dir/root.crt" "$worker_ca" >"$work_dir/claude-oauth-dual-ca.crt"
chmod 0600 "$work_dir/claude-oauth-dual-ca.crt"
NODE_EXTRA_CA_CERTS="$work_dir/claude-oauth-dual-ca.crt" \
  SSL_CERT_FILE="$work_dir/claude-oauth-dual-ca.crt" \
  NO_PROXY="127.0.0.1,localhost" no_proxy="127.0.0.1,localhost" \
  timeout 180s node \
  "$repo_root/apps/control-plane/test/fixtures/keycloak-claude-code-native-oauth.mjs" \
    "$work_dir" "$issuer" "$worker_url"
echo "RESULT: KEYCLOAK_CLAUDE_OFFICIAL_OAUTH_CLI_GATE_PASS"
echo "NOTE: no Anthropic model login, inference, hosted IdP, real user or device."
