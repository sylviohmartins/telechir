#!/usr/bin/env bash
# Phase 16: real Claude Code CLI's own MCP connection probe, no LLM inference.
# Sourced by the successful authenticated Inspector + Gemini fixture.
set -euo pipefail

# Set aside all CLI state, history and credentials into a private temp HOME.
# This runner has no Anthropic user login or secret API key.
claude_home="$work_dir/claude-home"
mkdir -p "$claude_home/.claude"
chmod 700 "$claude_home" "$claude_home/.claude"
export HOME="$claude_home"
export CLAUDE_CONFIG_DIR="$claude_home/.claude"
export DISABLE_TELEMETRY=1

# The real Claude Code CLI reads user-scoped MCP definitions from .claude.json.
# Write a synthetic read-only Bearer header in private, ephemeral HOME, not
# the checked-out repo or command line. Parent trap removes it on any exit.
node --input-type=module - "$work_dir" "$claude_home" "$url" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [work, home, url] = process.argv.slice(2);
const token = readFileSync(join(work, "valid.token"), "utf8").trim();
const config = {
  mcpServers: {
    "telechir-fixture": {
      type: "http",
      url,
      headers: { Authorization: "Bearer " + token },
    },
  },
};
writeFileSync(join(home, ".claude.json"), JSON.stringify(config), { mode: 0o600 });
NODE

cd "$work_dir"
set +e
timeout 180s npx --yes --package=@anthropic-ai/claude-code@2.1.295 claude mcp list \
  >"$work_dir/claude-mcp.out" 2>"$work_dir/claude-mcp.err"
claude_exit=$?
set -e

if [[ "$claude_exit" -ne 0 ]]; then
  echo "FAIL: Claude Code CLI mcp list returned exit $claude_exit" >&2
  # No raw stderr: third-party CLIs may echo header configuration.
  exit 1
fi
# The vendor docs state "claude mcp list" reports connection status (as
# opposed to "mcp add", which only writes the configuration).
if ! grep -Eqi 'telechir-fixture.*(✔[[:space:]]*Connected|Connected)' \
  "$work_dir/claude-mcp.out" "$work_dir/claude-mcp.err"; then
  echo "FAIL: Claude Code CLI did not report real MCP Connected status" >&2
  node --input-type=module - "$work_dir" <<'NODE'
import { readFileSync } from "node:fs";
import { join } from "node:path";
const [dir] = process.argv.slice(2);
const out = readFileSync(join(dir, "claude-mcp.out"), "utf8");
const err = readFileSync(join(dir, "claude-mcp.err"), "utf8");
console.error("DIAG: " + JSON.stringify({
  stdout_alias: out.includes("telechir-fixture"),
  stderr_alias: err.includes("telechir-fixture"),
  connected: /connected/i.test(out + err),
  failed: /failed|couldn.t connect/i.test(out + err),
  needs_auth: /needs authentication|auth required/i.test(out + err),
  config: /config|setting|mcpServers/i.test(out + err),
  stdout_bytes: out.length,
  stderr_bytes: err.length,
}));
NODE
  exit 1
fi

echo "PASS: real Claude Code 2.1.295 CLI reports Connected to signed-JWT Telechir MCP"
echo "RESULT: CLAUDE_CODE_AUTHENTICATED_MCP_DISCOVERY_PASS"
echo "NOTE: vendor CLI connection check only, not agent model usage, OAuth PKCE or tool calls."
