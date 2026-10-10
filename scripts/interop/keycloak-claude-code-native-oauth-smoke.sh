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
# Revocation must affect the SAME Claude-owned OAuth credentials, without
# re-running login and without inserting a different JWT into the vendor.
(
  cd "$repo_root/apps/control-plane"
  ./node_modules/.bin/wrangler d1 execute DB --local \
    --persist-to "$worker_state" --file "$work_dir/browser-pkce/disable.sql" \
    >"$work_dir/claude-disable.log" 2>&1 || {
      echo "FAIL: cannot disable Claude OAuth synthetic principal in real local D1" >&2
      exit 1
    }
)
# Distinguish authorization refusal from an accidentally stopped Worker.
curl --fail --silent --show-error --cacert "$worker_ca" --max-time 8 \
  "$worker_base/health" |
  jq -e '.status=="ok" and .fixture=="phase16"' >/dev/null || {
    echo "FAIL: Worker health is not OK after Claude principal disable" >&2
    exit 1
  }
NODE_EXTRA_CA_CERTS="$work_dir/claude-oauth-dual-ca.crt" \
  SSL_CERT_FILE="$work_dir/claude-oauth-dual-ca.crt" \
  NO_PROXY="127.0.0.1,localhost" no_proxy="127.0.0.1,localhost" \
  timeout 80s node \
  "$repo_root/apps/control-plane/test/fixtures/keycloak-claude-code-oauth-revocation.mjs" \
    "$work_dir" "$worker_url" disabled
# Reinstate only the disposable fixture user and assert the stored OAuth
# credentials still connect. This guards against false positives from a broken
# endpoint, missing credential file, or permanent CLI configuration failure.
(
  cd "$repo_root/apps/control-plane"
  ./node_modules/.bin/wrangler d1 execute DB --local \
    --persist-to "$worker_state" --file "$work_dir/browser-pkce/seed.sql" \
    >"$work_dir/claude-reenable-after-revocation.log" 2>&1 || {
      echo "FAIL: cannot reenable Claude OAuth synthetic principal" >&2
      exit 1
    }
)
NODE_EXTRA_CA_CERTS="$work_dir/claude-oauth-dual-ca.crt" \
  SSL_CERT_FILE="$work_dir/claude-oauth-dual-ca.crt" \
  NO_PROXY="127.0.0.1,localhost" no_proxy="127.0.0.1,localhost" \
  timeout 80s node \
  "$repo_root/apps/control-plane/test/fixtures/keycloak-claude-code-oauth-revocation.mjs" \
    "$work_dir" "$worker_url" reenabled
echo "RESULT: KEYCLOAK_CLAUDE_OFFICIAL_OAUTH_USER_REVOCATION_GATE_PASS"
echo "RESULT: KEYCLOAK_CLAUDE_OFFICIAL_OAUTH_CLI_GATE_PASS"
echo "NOTE: no Anthropic model login, inference, hosted IdP, real user or device."
