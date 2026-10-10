#!/usr/bin/env bash
# CI-only experiment: official Gemini CLI REPL slash command /mcp auth.
# No real Gemini API key/account, no model inference, no bearer injection.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == "true" && "$(uname -s)" == "Linux" ]] || exit 1
[[ "$issuer" == "https://127.0.0.1:9443/realms/telechir-phase16" ]] || exit 1
for binary in script stty node certutil npx; do
  command -v "$binary" >/dev/null || { echo "Missing prerequisite: $binary" >&2; exit 1; }
done
[[ -f "$work_dir/browser-pkce/gemini-oauth-settings-ci.json" ]] || exit 1
[[ -f "$work_dir/root.crt" && -f "$work_dir/gemini-native-dual-ca.crt" ]] || exit 1
NODE_EXTRA_CA_CERTS="$work_dir/gemini-native-dual-ca.crt" \
  SSL_CERT_FILE="$work_dir/gemini-native-dual-ca.crt" \
  NO_PROXY="127.0.0.1,localhost" no_proxy="127.0.0.1,localhost" \
  timeout 125s node \
  "$repo_root/apps/control-plane/test/fixtures/keycloak-gemini-cli-repl-oauth.mjs" \
  "$work_dir" "$issuer" "$worker_url"
echo "RESULT: GEMINI_CLI_REPL_OAUTH_PREFLIGHT_EXECUTED_NOT_FULL_CERTIFICATION"
