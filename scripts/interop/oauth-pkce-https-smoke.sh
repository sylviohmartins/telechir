#!/usr/bin/env bash
# Phase 16 synthetic OAuth Authorization Code + PKCE, real HTTPS loopback.
# Uses NO real IdP, production accounts, stored signing keys or TLS bypass.
set -euo pipefail
umask 077
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
work_dir="$(mktemp -d)"
cleanup() { rm -rf "$work_dir"; }
trap cleanup EXIT INT TERM

for executable in openssl node; do
  command -v "$executable" >/dev/null 2>&1 || {
    echo "FAIL: missing executable $executable" >&2
    exit 1
  }
done
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
  -keyout "$work_dir/localhost.key" \
  -out "$work_dir/localhost.crt" >/dev/null 2>&1

export NODE_EXTRA_CA_CERTS="$work_dir/localhost.crt"
export NO_PROXY="127.0.0.1,localhost"
export no_proxy="$NO_PROXY"
cd "$repo_root/apps/control-plane"
node test/fixtures/oauth-pkce-https-smoke.mjs \
  "$work_dir/localhost.crt" "$work_dir/localhost.key"
