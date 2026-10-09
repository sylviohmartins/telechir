#!/usr/bin/env bash
# Official Codex 0.162.0 itself generates & exchanges PKCE with Keycloak;
# Chrome is limited to browser login/consent, no pre-injected Bearer tokens.
set -euo pipefail
[[ "$GITHUB_ACTIONS" == "true" && "$(uname -s)" == "Linux" ]] || exit 1
[[ "$issuer" == "https://127.0.0.1:9443/realms/telechir-phase16" ]] || exit 1
for binary in node certutil npx python3; do
  command -v "$binary" >/dev/null || { echo "FAIL: missing $binary" >&2; exit 1; }
done
stop_direct_worker
(
  cd "$repo_root/apps/control-plane"
  ./node_modules/.bin/wrangler d1 execute DB --local \
    --persist-to "$worker_state" --file "$work_dir/browser-pkce/seed.sql" \
    >"$work_dir/codex-reenable.log" 2>&1 || {
      echo "FAIL: Codex OAuth D1 lab subject was not re-enabled" >&2
      exit 1
    }
)
start_direct_worker "$work_dir/root.crt" "codex-cli-interactive-oauth"
node "$repo_root/scripts/interop/verify-local-tls.mjs" \
  --cert "$work_dir/tls.crt" --ca "$work_dir/root.crt" --host 127.0.0.1 --port 9443 |
  jq -e '.status=="PASS" and .code=="TLS_PIN_AND_CHAIN_VALIDATED"' >/dev/null
node "$repo_root/scripts/interop/verify-local-tls.mjs" \
  --cert "$worker_cert" --ca "$worker_ca" --host 127.0.0.1 --port 8988 |
  jq -e '.status=="PASS" and .code=="TLS_PIN_AND_CHAIN_VALIDATED"' >/dev/null
cat "$work_dir/root.crt" "$worker_ca" >"$work_dir/codex-oauth-dual-ca.crt"
chmod 0600 "$work_dir/codex-oauth-dual-ca.crt"
# Env for Codex CLI and official app-server; only prevalidated disposable CAs.
NODE_EXTRA_CA_CERTS="$work_dir/codex-oauth-dual-ca.crt" \
  CODEX_CA_CERTIFICATE="$work_dir/codex-oauth-dual-ca.crt" \
  SSL_CERT_FILE="$work_dir/codex-oauth-dual-ca.crt" \
  NO_PROXY="127.0.0.1,localhost" no_proxy="127.0.0.1,localhost" \
  timeout 140s node \
  "$repo_root/apps/control-plane/test/fixtures/keycloak-codex-cli-interactive-oauth.mjs" \
    "$work_dir" "$issuer" "$worker_url"
echo "RESULT: KEYCLOAK_CODEX_OFFICIAL_PKCE_LOGIN_PASS"
timeout 160s python3 "$repo_root/scripts/interop/codex-app-server-oauth-readonly.py" \
  "$work_dir" "$work_dir/pkce/worker-device-id" read
(
  cd "$repo_root/apps/control-plane"
  ./node_modules/.bin/wrangler d1 execute DB --local \
    --persist-to "$worker_state" --file "$work_dir/browser-pkce/disable.sql" \
    >"$work_dir/codex-disable.log" 2>&1 || {
      echo "FAIL: Codex stored OAuth D1 principal could not be disabled" >&2
      exit 1
    }
)
timeout 160s python3 "$repo_root/scripts/interop/codex-app-server-oauth-readonly.py" \
  "$work_dir" "$work_dir/pkce/worker-device-id" disabled
echo "RESULT: KEYCLOAK_CODEX_OFFICIAL_OAUTH_MCP_D1_PASS"
echo "NOTE: official Codex login + Codex app-server with same stored OAuth identity, no API account, model inference or real user."
