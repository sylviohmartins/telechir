#!/usr/bin/env bash
# Real upstream IdP issuing a JWT in a disposable CI environment; no production.
set -euo pipefail
umask 077
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[[ "${GITHUB_ACTIONS:-}" == "true" && "$(uname -s)" == "Linux" ]] || {
  echo "FAIL: real IdP smoke is restricted to ephemeral GitHub Actions Linux CI" >&2
  exit 1
}
for cmd in docker openssl curl node jq; do
  command -v "$cmd" >/dev/null || { echo "FAIL: missing $cmd" >&2; exit 1; }
done
tmp="$(mktemp -d)"
container="telechir-phase16-keycloak-${GITHUB_RUN_ID:?}"
bundle="$repo_root/apps/control-plane/node_modules/.cache/phase16-keycloak-verifier-${GITHUB_RUN_ID:?}.mjs"
worker_pid=""
cleanup() {
  if [[ -n "$worker_pid" ]]; then
    kill "$worker_pid" 2>/dev/null || true
    wait "$worker_pid" 2>/dev/null || true
  fi
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -f "$bundle"
  rm -rf "$tmp"
}
trap cleanup EXIT INT TERM
mkdir -p "$tmp/import"
cp "$repo_root/scripts/interop/fixtures/keycloak-phase16-realm.json" "$tmp/import/telechir-phase16-realm.json"
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 \
  -subj "/CN=Telechir Keycloak CI Issuer CA" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -keyout "$tmp/root.key" -out "$tmp/root.crt" >/dev/null 2>&1
openssl req -new -newkey rsa:2048 -nodes -sha256 \
  -subj "/CN=localhost" \
  -keyout "$tmp/tls.key" -out "$tmp/tls.csr" >/dev/null 2>&1
cat >"$tmp/leaf.ext" <<'EXT'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost,IP:127.0.0.1
EXT
openssl x509 -req -in "$tmp/tls.csr" \
  -CA "$tmp/root.crt" -CAkey "$tmp/root.key" -CAcreateserial \
  -out "$tmp/tls.crt" -days 1 -sha256 \
  -extfile "$tmp/leaf.ext" >/dev/null 2>&1
openssl verify -CAfile "$tmp/root.crt" -purpose sslserver "$tmp/tls.crt" >/dev/null

# Keycloak runs as uid 1000. Keep the key unreadable to other users
# while making the disposable mounted key accessible to that unprivileged uid.
sudo chown 1000:0 "$tmp/tls.key" "$tmp/tls.crt"
sudo chmod 0640 "$tmp/tls.key"
# The public leaf certificate is safe to read by the non-root CI verifier;
# the private key remains restricted to the Keycloak container user.
sudo chmod 0644 "$tmp/tls.crt"
# The bind-mounted import DIRECTORY must be searchable by uid 1000.\nchmod 0755 "$tmp/import"\nchmod 0644 "$tmp/import/telechir-phase16-realm.json"
# Do not use --rm here: we need bounded logs if the container exits.
# The EXIT trap is the only cleanup owner and removes it on success/failure.
docker run -d --name "$container" --network host --memory=1200m \
  -e KC_BOOTSTRAP_ADMIN_USERNAME=phase16-ci \
  -e KC_BOOTSTRAP_ADMIN_PASSWORD=phase16-ci-fixture-not-a-real-secret \
  --mount "type=bind,src=$tmp/tls.crt,dst=/opt/keycloak/conf/phase16-tls.crt,readonly" \
  --mount "type=bind,src=$tmp/tls.key,dst=/opt/keycloak/conf/phase16-tls.key,readonly" \
  quay.io/keycloak/keycloak:26.8.0 \
  start-dev --verbose --hostname=https://127.0.0.1:9443 \
  --https-port=9443 \
  --https-certificate-file=/opt/keycloak/conf/phase16-tls.crt \
  --https-certificate-key-file=/opt/keycloak/conf/phase16-tls.key \
  --http-enabled=false >"$tmp/container-id"
issuer="https://127.0.0.1:9443/realms/telechir-phase16"
# The upstream Keycloak realm import bootstrap cannot be trusted on an
# ephemeral bind mount across non-root UIDs. Provision the same test realm via
# its official, authenticated Admin REST API after master realm boots.
master_issuer="https://127.0.0.1:9443/realms/master"
ready=false
for _ in $(seq 1 180); do
  if ! docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null | grep -qx true; then
    echo "FAIL: Keycloak exited before realm was ready" >&2
    # Include bounded startup diagnostics only. Test credentials are static
    # fixture values and no tokens exist prior to a successful startup.
    docker logs "$container" 2>&1 | grep -Ei 'ERROR|Caused by|FileNotFound|directory|Import|Permission|could not|NoSuchFile' | head -n 24 | sed -E 's/(password|secret|token)=([^ ]+)/\\1=[REDACTED]/Ig' >&2 || true
    exit 1
  fi
  if curl --fail --silent --cacert "$tmp/root.crt" --connect-timeout 2 \
    --max-time 3 "$master_issuer/.well-known/openid-configuration" \
    -o "$tmp/oidc.json" && jq -e --arg iss "$master_issuer" \
    '.issuer == $iss and .jwks_uri and .token_endpoint' "$tmp/oidc.json" \
    >/dev/null; then
    ready=true
    break
  fi
  sleep 2
done
[[ "$ready" == "true" ]] || {
  echo "FAIL: real HTTPS Keycloak realm not ready" >&2; exit 1;
}
echo "PASS: actual Keycloak 26.8.0 master realm HTTPS OIDC discovery"
# Validate BOTH the expected server leaf and its independent ephemeral CA
# before sending any CI-only OAuth client or admin credentials.
node "$repo_root/scripts/interop/verify-local-tls.mjs" \
  --cert "$tmp/tls.crt" --ca "$tmp/root.crt" --host 127.0.0.1 --port 9443 |
  jq -e '.status=="PASS" and .code=="TLS_PIN_AND_CHAIN_VALIDATED"' >/dev/null
# Admin credentials are CI-only fixtures, never valid outside this container.
curl --fail --silent --show-error --cacert "$tmp/root.crt" --max-time 12 \
  -X POST "$master_issuer/protocol/openid-connect/token" \
  --data-urlencode 'grant_type=password' \
  --data-urlencode 'client_id=admin-cli' \
  --data-urlencode 'username=phase16-ci' \
  --data-urlencode 'password=phase16-ci-fixture-not-a-real-secret' \
  -o "$tmp/admin-token.json"
admin_token="$(jq -er '.access_token' "$tmp/admin-token.json")" || {
  echo "FAIL: Keycloak CI admin token unavailable" >&2
  exit 1
}
create_code="$(curl --silent --show-error --cacert "$tmp/root.crt" \
  --max-time 20 --output "$tmp/create-realm.json" --write-out "%{http_code}" \
  -X POST "https://127.0.0.1:9443/admin/realms" \
  -H "Authorization: Bearer $admin_token" \
  -H "Content-Type: application/json" \
  --data-binary "@$tmp/import/telechir-phase16-realm.json")"
[[ "$create_code" == "201" ]] || {
  unset admin_token
  echo "FAIL: Keycloak Admin API realm creation returned HTTP $create_code" >&2
  exit 1
}
# Realm creation does not guarantee the embedded users array was provisioned.
# Use the official authenticated Admin REST endpoint for a deterministic CI
# human principal. Credentials are disposable fixture values only.
pkce_user_code="$(curl --silent --show-error --cacert "$tmp/root.crt" \
  --max-time 20 --output "$tmp/create-pkce-user.json" --write-out "%{http_code}" \
  -X POST "https://127.0.0.1:9443/admin/realms/telechir-phase16/users" \
  -H "Authorization: Bearer $admin_token" \
  -H "Content-Type: application/json" \
  --data-binary "@$repo_root/scripts/interop/fixtures/keycloak-phase16-user.json")"
[[ "$pkce_user_code" == "201" ]] || {
  unset admin_token
  echo "FAIL: Keycloak Admin REST PKCE test-user creation HTTP $pkce_user_code" >&2
  exit 1
}
echo "PASS: official Keycloak Admin REST created disposable human PKCE account"

# Do not embed clientScopes in RealmRepresentation: doing so replaces Keycloak
# built-in realm scopes (profile/email), removing preferred_username from
# PREVIOUSLY CERTIFIED PKCE JWTs. Add the one optional test scope separately
# via authenticated, CA-verified Admin REST after realm initialization.
inspector_scope_code="$(curl --silent --show-error --cacert "$tmp/root.crt" \
  --max-time 20 --output "$tmp/create-inspector-scope.json" \
  --write-out "%{http_code}" \
  -X POST "https://127.0.0.1:9443/admin/realms/telechir-phase16/client-scopes" \
  -H "Authorization: Bearer $admin_token" \
  -H "Content-Type: application/json" \
  --data-binary "@$repo_root/scripts/interop/fixtures/keycloak-inspector-read-scope.json")"
[[ "$inspector_scope_code" == "201" ]] || {
  unset admin_token
  echo "FAIL: cannot create optional Keycloak Inspector scope (HTTP $inspector_scope_code)" >&2
  exit 1
}
curl --fail --silent --show-error --cacert "$tmp/root.crt" --max-time 12 \
  -H "Authorization: Bearer $admin_token" \
  "https://127.0.0.1:9443/admin/realms/telechir-phase16/client-scopes" \
  -o "$tmp/inspector-scopes.json"
inspector_scope_id="$(jq -er \
  '[.[] | select(.name=="telechir:devices:read")] | if length==1 then .[0].id else error("Inspector scope not unique") end' \
  "$tmp/inspector-scopes.json")"
curl --fail --silent --show-error --cacert "$tmp/root.crt" --max-time 12 \
  -H "Authorization: Bearer $admin_token" \
  "https://127.0.0.1:9443/admin/realms/telechir-phase16/clients?clientId=telechir-phase16-inspector" \
  -o "$tmp/inspector-client.json"
inspector_client_uuid="$(jq -er \
  '[.[] | select(.clientId=="telechir-phase16-inspector")] | if length==1 then .[0].id else error("Inspector client not unique") end' \
  "$tmp/inspector-client.json")"
inspector_scope_link_code="$(curl --silent --show-error --cacert "$tmp/root.crt" \
  --max-time 20 --output "$tmp/link-inspector-scope.json" \
  --write-out "%{http_code}" \
  -X PUT "https://127.0.0.1:9443/admin/realms/telechir-phase16/clients/$inspector_client_uuid/optional-client-scopes/$inspector_scope_id" \
  -H "Authorization: Bearer $admin_token")"
[[ "$inspector_scope_link_code" == "204" ]] || {
  unset admin_token
  echo "FAIL: unable to link optional read-only Inspector scope (HTTP $inspector_scope_link_code)" >&2
  exit 1
}
echo "PASS: Keycloak Admin REST created and assigned Inspector devices:read without altering built-in realm defaults"
# Reuse the exact same optional read-only scope for the separate Gemini CI
# client; do not change realm defaults or attach write-capable scopes.
curl --fail --silent --show-error --cacert "$tmp/root.crt" --max-time 12 \
  -H "Authorization: Bearer $admin_token" \
  "https://127.0.0.1:9443/admin/realms/telechir-phase16/clients?clientId=telechir-phase16-gemini" \
  -o "$tmp/gemini-client.json"
gemini_client_uuid="$(jq -er \
  '[.[] | select(.clientId=="telechir-phase16-gemini")] | if length==1 then .[0].id else error("Gemini client not unique") end' \
  "$tmp/gemini-client.json")"
gemini_scope_link_code="$(curl --silent --show-error --cacert "$tmp/root.crt" \
  --max-time 20 --output "$tmp/link-gemini-scope.json" \
  --write-out "%{http_code}" \
  -X PUT "https://127.0.0.1:9443/admin/realms/telechir-phase16/clients/$gemini_client_uuid/optional-client-scopes/$inspector_scope_id" \
  -H "Authorization: Bearer $admin_token")"
unset admin_token
[[ "$gemini_scope_link_code" == "204" ]] || {
  echo "FAIL: unable to link read-only Gemini scope (HTTP $gemini_scope_link_code)" >&2
  exit 1
}
echo "PASS: Gemini public OAuth test client registered with optional read-only scope; built-in Keycloak scopes unchanged"
curl --fail --silent --show-error --cacert "$tmp/root.crt" --max-time 10 \
  "$issuer/.well-known/openid-configuration" -o "$tmp/oidc.json"
jq -e --arg iss "$issuer" '.issuer==$iss' "$tmp/oidc.json" >/dev/null
echo "PASS: real Keycloak realm provisioned through authenticated Admin REST API"
token_url="$(jq -r '.token_endpoint' "$tmp/oidc.json")"
jwks_url="$(jq -r '.jwks_uri' "$tmp/oidc.json")"
[[ "$token_url" == "$issuer/protocol/openid-connect/token" ]] || {
  echo "FAIL: unexpected token endpoint" >&2; exit 1;
}
[[ "$jwks_url" == "$issuer/protocol/openid-connect/certs" ]] || {
  echo "FAIL: unexpected JWKS endpoint" >&2; exit 1;
}
curl --fail --silent --show-error --cacert "$tmp/root.crt" --max-time 10 \
  "$jwks_url" -o "$tmp/jwks.json"
curl --fail --silent --show-error --cacert "$tmp/root.crt" --max-time 12 \
  -X POST "$token_url" \
  --data-urlencode 'grant_type=client_credentials' \
  --data-urlencode 'client_id=telechir-phase16-ci' \
  --data-urlencode 'client_secret=phase16-ci-fixture-not-a-real-secret' \
  -o "$tmp/token.json"
jq -e '.access_token and (.token_type | ascii_downcase=="bearer")' \
  "$tmp/token.json" >/dev/null || {
    echo "FAIL: real Keycloak service account token not issued" >&2; exit 1;
  }
node "$repo_root/apps/control-plane/test/fixtures/keycloak-real-idp-contract.mjs" \
  "$tmp/oidc.json" "$tmp/jwks.json" "$tmp/token.json" "$issuer"
# Bundle unchanged production OAuth verifier. External dependencies resolve
# within the ignored node_modules subtree; the temporary bundle is deleted.
mkdir -p "$(dirname "$bundle")"
(
  cd "$repo_root/apps/control-plane"
  ./node_modules/.bin/esbuild src/oauth.ts --bundle --platform=node \
    --format=esm --packages=external --outfile="$bundle" --log-level=error
)
# Node uses only this ephemeral trust anchor; no global TLS relaxation.
NODE_EXTRA_CA_CERTS="$tmp/root.crt" NO_PROXY="127.0.0.1,localhost" \
  no_proxy="127.0.0.1,localhost" \
  node "$repo_root/apps/control-plane/test/fixtures/keycloak-telechir-production-verifier.mjs" \
  "$tmp/oidc.json" "$tmp/token.json" "$issuer" "$bundle"
# Additional independent HTTP/D1 proof (no extra IdP or credential fixtures).
source "$repo_root/scripts/interop/keycloak-worker-d1-smoke.sh"
# Separate strict gate: native Workerd fetch + real Keycloak HTTPS trust.
source "$repo_root/scripts/interop/keycloak-workerd-direct-tls-smoke.sh"
# Separate OAuth Authorization Code + PKCE S256 with a real human test account.
source "$repo_root/scripts/interop/keycloak-real-pkce-mcp-smoke.sh"
# Real headless Chromium UI with separately configured consent-required public client.
source "$repo_root/scripts/interop/keycloak-browser-pkce-mcp-smoke.sh"
# Provider-specific RFC9207 preflight only; not a Gemini interactive auth claim.
NODE_EXTRA_CA_CERTS="$work_dir/root.crt" node "$repo_root/apps/control-plane/test/fixtures/keycloak-gemini-issuer-preflight.mjs" "$work_dir" "$issuer" "$worker_url"
# Independent published MCP Inspector CLI performs its OWN interactive OAuth.
source "$repo_root/scripts/interop/keycloak-inspector-interactive-oauth-smoke.sh"
echo "RESULT: KEYCLOAK_REAL_IDP_ISSUANCE_CONTRACT_PASS"
echo "NOTE: Keycloak credentials, scripted PKCE, headless Chromium login and consent tested against local Worker/D1; no production hosted tenant/Worker, model-initiated UI or real-world user."
