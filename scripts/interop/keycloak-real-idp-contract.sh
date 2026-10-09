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
container="telechir-phase16-keycloak-$$"
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT INT TERM
mkdir -p "$tmp/import"
cp "$repo_root/scripts/interop/fixtures/keycloak-phase16-realm.json" "$tmp/import/realm.json"
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
sudo chmod 0640 "$tmp/tls.key" "$tmp/tls.crt"
chmod 0644 "$tmp/import/realm.json"
# Do not use --rm here: we need bounded logs if the container exits.
# The EXIT trap is the only cleanup owner and removes it on success/failure.
docker run -d --name "$container" --network host --memory=1200m \
  -e KC_BOOTSTRAP_ADMIN_USERNAME=phase16-ci \
  -e KC_BOOTSTRAP_ADMIN_PASSWORD=phase16-ci-fixture-not-a-real-secret \
  --mount "type=bind,src=$tmp/import,dst=/opt/keycloak/data/import,readonly" \
  --mount "type=bind,src=$tmp/tls.crt,dst=/opt/keycloak/conf/phase16-tls.crt,readonly" \
  --mount "type=bind,src=$tmp/tls.key,dst=/opt/keycloak/conf/phase16-tls.key,readonly" \
  quay.io/keycloak/keycloak:26.8.0 \
  start-dev --import-realm --hostname=https://127.0.0.1:9443 \
  --https-port=9443 \
  --https-certificate-file=/opt/keycloak/conf/phase16-tls.crt \
  --https-certificate-key-file=/opt/keycloak/conf/phase16-tls.key \
  --http-enabled=false >"$tmp/container-id"
issuer="https://127.0.0.1:9443/realms/telechir-phase16"
ready=false
for _ in $(seq 1 180); do
  if ! docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null | grep -qx true; then
    echo "FAIL: Keycloak exited before realm was ready" >&2
    # Include bounded startup diagnostics only. Test credentials are static
    # fixture values and no tokens exist prior to a successful startup.
    docker logs "$container" 2>&1 | tail -n 25 | sed -E 's/(password|secret|token)=([^ ]+)/\\1=[REDACTED]/Ig' >&2 || true
    exit 1
  fi
  if curl --fail --silent --cacert "$tmp/root.crt" --connect-timeout 2 \
    --max-time 3 "$issuer/.well-known/openid-configuration" \
    -o "$tmp/oidc.json" && jq -e --arg iss "$issuer" \
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
echo "PASS: actual Keycloak 26.8.0 HTTPS realm OIDC discovery"
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
echo "RESULT: KEYCLOAK_REAL_IDP_ISSUANCE_CONTRACT_PASS"
echo "NOTE: self-hosted IdP service-account grant; NOT browser PKCE, external tenant or Worker MCP E2E."
