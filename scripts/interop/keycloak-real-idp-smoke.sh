#!/usr/bin/env bash
# PHASE 16: genuine self-hosted Keycloak IdP -> production Telechir JWT verifier.
# Disposable GitHub-hosted Linux CI ONLY. No production data/accounts/deploy.
set -euo pipefail
umask 077

[[ "${GITHUB_ACTIONS:-}" == "true" && "${CI:-}" == "true" &&
   "$(uname -s)" == "Linux" ]] || {
  echo "FAIL: real IdP fixture requires disposable GitHub Actions Linux runner" >&2
  exit 1
}
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
work_dir="$(mktemp -d)"
container_name="telechir-keycloak-phase16-${GITHUB_RUN_ID:?}"
bundle="$repo_root/apps/control-plane/node_modules/.cache/phase16-keycloak-${GITHUB_RUN_ID}.mjs"
cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  rm -f "$bundle"
  rm -rf "$work_dir"
}
trap cleanup EXIT INT TERM

for executable in docker openssl curl node jq timeout; do
  command -v "$executable" >/dev/null 2>&1 || {
    echo "FAIL: executable $executable unavailable" >&2
    exit 1
  }
done
mkdir -p "$work_dir/certs" "$work_dir/import"
# Docker's non-root Keycloak process must read ONLY this disposable mount.
chmod 755 "$work_dir/certs" "$work_dir/import"
root_ca="$work_dir/certs/root-ca.crt"
root_key="$work_dir/certs/root-ca.key"
leaf="$work_dir/certs/server.crt"
leaf_key="$work_dir/certs/server.key"
csr="$work_dir/certs/server.csr"

openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 \
  -subj "/CN=Telechir Phase16 Keycloak Loopback CA" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -keyout "$root_key" -out "$root_ca" >/dev/null 2>&1
openssl req -new -newkey rsa:2048 -nodes -sha256 \
  -subj "/CN=localhost" -keyout "$leaf_key" -out "$csr" >/dev/null 2>&1
cat >"$work_dir/certs/server.ext" <<'EXT'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost,IP:127.0.0.1
EXT
openssl x509 -req -in "$csr" -CA "$root_ca" -CAkey "$root_key" \
  -CAcreateserial -out "$leaf" -days 1 -sha256 \
  -extfile "$work_dir/certs/server.ext" >/dev/null 2>&1
openssl verify -CAfile "$root_ca" -purpose sslserver "$leaf" >/dev/null
# A disposable container cannot read 0600 host-owned files; only synthetic
# private material in its read-only volume is made container-readable.
chmod 644 "$leaf" "$leaf_key" "$root_ca"
cd "$repo_root/apps/control-plane"
node test/fixtures/create-keycloak-realm.mjs "$work_dir"
chmod 644 "$work_dir/import/telechir-phase16-realm.json"

# Pin vendor tag, container memory and 127.0.0.1 binding. No privileged or
# persistent mounts, no real admin credential, no external application users.
docker run --detach --rm --name "$container_name" \
  --memory 1536m \
  --publish 127.0.0.1:8844:8443 \
  --volume "$work_dir/certs:/opt/keycloak/certs:ro" \
  --volume "$work_dir/import:/opt/keycloak/data/import:ro" \
  --env "KC_HOSTNAME=https://127.0.0.1:8844" \
  --env "KC_HTTPS_CERTIFICATE_FILE=/opt/keycloak/certs/server.crt" \
  --env "KC_HTTPS_CERTIFICATE_KEY_FILE=/opt/keycloak/certs/server.key" \
  --env "JAVA_OPTS_KC_HEAP=-XX:MaxRAMPercentage=55" \
  quay.io/keycloak/keycloak:26.8.0 \
  start-dev --import-realm --http-enabled=false \
  >"$work_dir/docker-id" 2>"$work_dir/docker-start.err" || {
    echo "FAIL: pinned official Keycloak container failed to start" >&2
    exit 1
  }

export NO_PROXY="127.0.0.1,localhost"
export no_proxy="$NO_PROXY"
export NODE_EXTRA_CA_CERTS="$root_ca"
issuer="https://127.0.0.1:8844/realms/telechir-phase16"
discovery="https://127.0.0.1:8844/.well-known/oauth-authorization-server/realms/telechir-phase16"

ready=false
for _ in $(seq 1 130); do
  if ! docker ps -q --filter "name=^/$container_name$" | grep -q .; then
    echo "FAIL: Keycloak process exited during start" >&2
    exit 1
  fi
  if curl --fail --silent --cacert "$root_ca" --max-time 4 \
    "$discovery" |
      jq -e --arg issuer "$issuer" '.issuer==$issuer' >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 2
done
[[ "$ready" == "true" ]] || {
  echo "FAIL: real Keycloak RFC8414 HTTPS issuer was not ready" >&2
  exit 1
}

# Do not send client secrets until the pinned leaf AND independently trusted
# issuer chain pass TLS preflight. Never use insecure curl or Node TLS bypass.
node "$repo_root/scripts/interop/verify-local-tls.mjs" \
  --cert "$leaf" --ca "$root_ca" --host 127.0.0.1 --port 8844 |
  jq -e '.status=="PASS" and .code=="TLS_PIN_AND_CHAIN_VALIDATED"' >/dev/null
echo "PASS: Keycloak 26.8.0 HTTPS, pinned TLS leaf and CA chain"

mkdir -p "$(dirname "$bundle")"
./node_modules/.bin/esbuild src/oauth.ts --bundle --platform=node --format=esm \
  --packages=external --outfile="$bundle" --log-level=error
timeout 90s node test/fixtures/keycloak-real-idp-verify.mjs "$work_dir" "$bundle"
