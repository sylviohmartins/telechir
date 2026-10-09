#!/usr/bin/env bash
# Phase 16 official Codex app-server direct MCP list_devices test.
# Called by authenticated inspector smoke with pinned TLS and synthetic D1.
set -euo pipefail
command -v python3 >/dev/null || {
  echo "FAIL: Python 3 unavailable for Codex app-server JSONL" >&2
  exit 1
}
# Rust's Codex HTTPS stack may use the OS trust store instead of Node's
# NODE_EXTRA_CA_CERTS. Register only our already-pinned ephemeral localhost
# cert, and only inside the GitHub-hosted disposable Ubuntu CI environment.
# Fail closed rather than lowering TLS verification or touching the user host.
if [[ "${GITHUB_ACTIONS:-}" != "true" || "${CI:-}" != "true" ||
      "$(uname -s)" != "Linux" ]]; then
  echo "FAIL: OS trust setup restricted to disposable GitHub Actions Linux runner" >&2
  exit 1
fi
command -v sudo >/dev/null || { echo "FAIL: sudo unavailable" >&2; exit 1; }
ca_path="/usr/local/share/ca-certificates/telechir-phase16-loopback.crt"
if [[ -e "$ca_path" ]]; then
  echo "FAIL: pre-existing Telechir test CA entry; refusing to overwrite" >&2
  exit 1
fi
openssl verify -CAfile "$cert" "$cert" >/dev/null
sudo install -m 0644 "$cert" "$ca_path"
if ! sudo update-ca-certificates >"$work_dir/os-trust-install.log" 2>&1; then
  sudo rm -f "$ca_path"
  echo "FAIL: isolated test root did not install in OS trust" >&2
  exit 1
fi

# The Python harness starts the pinned official CLI distribution with a
# private CODEX_HOME; the JWT is only in the child environment, never argv.
set +e
timeout 180s python3 "$repo_root/scripts/interop/codex-app-server-readonly-probe.py" \
  "$work_dir" "$url" "$cert" "$work_dir/device-id"
codex_exit=$?
set -e
# Remove the ephemeral trust root before any subsequent integration steps.
sudo rm -f "$ca_path"
sudo update-ca-certificates >"$work_dir/os-trust-remove.log" 2>&1 || {
  echo "FAIL: disposable runner test CA cleanup did not complete" >&2
  exit 1
}
[[ "$codex_exit" -eq 0 ]] || exit "$codex_exit"
