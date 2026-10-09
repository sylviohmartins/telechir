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
  # Emit only Boolean classifications; NEVER print raw CLI output or tokens.
  node --input-type=module - "$work_dir" <<'NODE'
import { readFileSync } from "node:fs";
import { join } from "node:path";
const [dir] = process.argv.slice(2);
const plain = readFileSync(join(dir, "gemini-list.out"), "utf8")
  .replace(/\x1b\[[0-9;]*m/g, "");
const stderr = readFileSync(join(dir, "gemini-list.err"), "utf8");
console.error("DIAG: " + JSON.stringify({
  stdout_has_alias: plain.includes("telechir-fixture"),
  stdout_has_connected: /\bconnected\b/i.test(plain),
  stdout_has_disconnected: /\bdisconnected\b/i.test(plain),
  stdout_has_no_servers: /no.*servers|no.*configured/i.test(plain),
  stderr_has_auth: /authenticat|authorization/i.test(stderr),
  stderr_has_tls: /certificate|tls|ssl/i.test(stderr),
  stderr_has_config: /settings|config/i.test(stderr),
  stdout_bytes: plain.length,
  stderr_bytes: stderr.length,
}));
NODE
  # No raw output: may contain synthetic credentials in config diagnostics.
  exit 1
fi
echo "PASS: real Gemini CLI 0.63.0 connected to signed-JWT Telechir MCP"
echo "RESULT: GEMINI_CLI_AUTHENTICATED_MCP_DISCOVERY_PASS"
echo "NOTE: CLI authenticated discovery only; no LLM session, OAuth PKCE, IdP or tool execution."
