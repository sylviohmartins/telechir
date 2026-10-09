#!/usr/bin/env bash
# Phase 16 official Codex app-server direct MCP list_devices test.
# Called by authenticated inspector smoke with pinned TLS and synthetic D1.
set -euo pipefail
command -v python3 >/dev/null || {
  echo "FAIL: Python 3 unavailable for Codex app-server JSONL" >&2
  exit 1
}
# The Python harness starts the actual pinned official CLI distribution,
# configures its private CODEX_HOME and supplies bearer only in child env.
# No model invocation/API key required by the app-server's MCP direct-call API.
timeout 180s python3 "$repo_root/scripts/interop/codex-app-server-readonly-probe.py" \
  "$work_dir" "$url" "$cert" "$work_dir/device-id"
