#!/usr/bin/env bash
# Phase 16 official Codex app-server direct MCP list_devices test.
# Called by authenticated inspector smoke with pinned TLS and synthetic D1.
set -euo pipefail
command -v python3 >/dev/null || {
  echo "FAIL: Python 3 unavailable for Codex app-server JSONL" >&2
  exit 1
}
# Codex uses its own custom CA bundle parameter, rather than Node trust.
# The subprocess sets CODEX_CA_CERTIFICATE only for its own lifetime.
# No global Linux CA installation and no TLS verification bypass.
# A successful read first proves transport, identity and TLS work before
# evaluating negative outcomes (otherwise an outage could masquerade as denial).
# Each scenario has a new process, ephemeral thread and separate CODEX_HOME.
for scenario in read no-token wrong-audience malformed write-denied; do
  timeout 180s python3 "$repo_root/scripts/interop/codex-app-server-readonly-probe.py" \
    "$work_dir" "$url" "$ca_cert" "$work_dir/device-id" "$scenario"
done
