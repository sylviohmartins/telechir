#!/usr/bin/env bash
# Sourced by inspector-authenticated-smoke.sh after the HTTPS fixture is ready.
# Real Google Gemini CLI 0.63.0, with an ephemeral, read-only signed JWT.
# Never run with real accounts, credentials, or a deployed server.
set -euo pipefail
export GEMINI_CLI_HOME="$work_dir/gemini-home"
export GEMINI_TELEMETRY_ENABLED=false
mkdir -p "$GEMINI_CLI_HOME/.gemini"

# Token is read from the temporary private file; not embedded in CLI args.
node --input-type=module - "$work_dir" "$GEMINI_CLI_HOME" "$url" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [work, home, url] = process.argv.slice(2);
const token = readFileSync(join(work, "valid.token"), "utf8").trim();
writeFileSync(
  join(home, ".gemini", "settings.json"),
  JSON.stringify({
    mcpServers: {
      "telechir-fixture": {
        httpUrl: url,
        headers: { Authorization: "Bearer " + token },
        timeout: 12000,
        trust: false,
      },
    },
  }),
  { mode: 0o600 },
);
NODE

# A management command performs remote MCP initialization/tool discovery
# without LLM inference, a Google account, or browser authorization.
cd "$work_dir"
set +e
timeout 180s npx --yes @google/gemini-cli@0.63.0 mcp list \
  >"$work_dir/gemini-list.out" 2>"$work_dir/gemini-list.err"
gemini_exit=$?
set -e
if [[ "$gemini_exit" -ne 0 ]]; then
  echo "FAIL: real Gemini CLI mcp list exited $gemini_exit" >&2
  exit 1
fi
if ! grep -Eqi 'telechir-fixture.*[[:space:]]-[[:space:]]Connected|telechir-fixture.*CONNECTED' \
  "$work_dir/gemini-list.out"; then
  echo "FAIL: real Gemini CLI did not report an authenticated MCP connection" >&2
  # No raw output: may contain synthetic credentials in config diagnostics.
  exit 1
fi
echo "PASS: real Gemini CLI 0.63.0 connected to signed-JWT Telechir MCP"
echo "RESULT: GEMINI_CLI_AUTHENTICATED_MCP_DISCOVERY_PASS"
echo "NOTE: CLI authenticated discovery only; no LLM session, OAuth PKCE, IdP or tool execution."
