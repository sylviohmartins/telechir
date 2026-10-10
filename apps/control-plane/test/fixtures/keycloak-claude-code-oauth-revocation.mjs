#!/usr/bin/env node
/**
 * Phase 16 Claude Code 2.1.295: real MCP health probe after D1 user disable
 * and subsequent re-enable, using ONLY the vendor's stored OAuth login.
 * No token copying, Bearer injection, Anthropic account or model inference.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [work, mcp, stage] = process.argv.slice(2);
assert.equal(process.argv.length, 5);
assert.equal(
  process.env.GITHUB_ACTIONS,
  "true",
  "Ephemeral GitHub Actions only",
);
assert.equal(mcp, "https://127.0.0.1:8988/mcp");
assert.ok(["disabled", "reenabled"].includes(stage));
const alias = "telechir-claude-ci";
const root = join(work, "claude-native-oauth");
const home = join(root, "claude-home");
const configFile = join(home, ".claude.json");
assert.ok(existsSync(configFile), "Real Claude OAuth configuration missing");
const config = JSON.parse(readFileSync(configFile, "utf8"));
assert.deepEqual(Object.keys(config.mcpServers), [alias]);
assert.equal(config.mcpServers[alias].url, mcp);
assert.equal(
  config.mcpServers[alias].oauth.clientId,
  "telechir-phase16-claude",
);
assert.equal(config.mcpServers[alias].oauth.scopes, "telechir:devices:read");
assert.equal(
  config.mcpServers[alias].headers,
  undefined,
  "Bearer injection is forbidden",
);

const env = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: join(root, "xdg-config"),
  XDG_DATA_HOME: join(root, "xdg-data"),
  DISABLE_TELEMETRY: "1",
  BROWSER: "/bin/true",
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost",
};
for (const key of [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_API_KEY",
  "OPENAI_API_KEY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
])
  delete env[key];

const cli = spawn(
  "npx",
  [
    "--yes",
    "--package=@anthropic-ai/claude-code@2.1.295",
    "claude",
    "mcp",
    "list",
  ],
  { cwd: home, env, stdio: ["ignore", "pipe", "pipe"] },
);
let stdout = "";
let stderr = "";
const maxOutput = 64 * 1024;
let limited = false;
for (const [stream, isError] of [
  [cli.stdout, false],
  [cli.stderr, true],
]) {
  stream.on("data", (chunk) => {
    if (isError) stderr += String(chunk);
    else stdout += String(chunk);
    if (stdout.length + stderr.length > maxOutput) {
      limited = true;
      cli.kill("SIGTERM");
    }
  });
}
const status = await new Promise((resolve, reject) => {
  cli.once("error", reject);
  cli.once("close", (code, signal) => resolve({ code, signal }));
});
assert.equal(limited, false, "Claude output exceeded guarded limit");
assert.equal(
  status.code,
  0,
  "Claude mcp list failed instead of reporting status",
);
const output = stdout + "\n" + stderr;
const aliasLines = output
  .split(/\r?\n/u)
  .filter(
    (line) =>
      line.includes(alias) &&
      /Connected|Failed|Needs authentication|Connection error/iu.test(line),
  );
const flags = {
  aliasPresent: output.includes(alias),
  hasConnected: aliasLines.some(
    (line) => /Connected/iu.test(line) && !/Failed to connect/iu.test(line),
  ),
  hasAuthRequired: aliasLines.some((line) =>
    /Needs authentication/iu.test(line),
  ),
  hasFailure: aliasLines.some((line) =>
    /Failed to connect|Connection error/iu.test(line),
  ),
  hasHttp401: aliasLines.some((line) => /\b401\b/u.test(line)),
  aliasStatusCount: aliasLines.length,
  stdoutBytes: stdout.length,
  stderrBytes: stderr.length,
};
try {
  assert.equal(
    aliasLines.length,
    1,
    "Expected exactly one real Claude MCP status line",
  );
  if (stage === "disabled") {
    assert.equal(
      flags.hasConnected,
      false,
      "Disabled user remains connected in Claude Code",
    );
    assert.ok(
      flags.hasFailure || flags.hasAuthRequired,
      "Claude did not refuse disabled D1 user",
    );
    console.log("RESULT: CLAUDE_OFFICIAL_OAUTH_DISABLED_USER_MCP_REFUSED_PASS");
  } else {
    assert.equal(
      flags.hasConnected,
      true,
      "Claude failed to reconnect after D1 user re-enable",
    );
    assert.equal(flags.hasFailure || flags.hasAuthRequired, false);
    console.log(
      "RESULT: CLAUDE_OFFICIAL_OAUTH_REENABLED_USER_MCP_CONNECTED_PASS",
    );
  }
} catch {
  console.error("DIAG: CLAUDE_OAUTH_REVOCATION_FLAGS=" + JSON.stringify(flags));
  throw new Error("Official Claude MCP status did not match the D1 user state");
}
console.log(
  "NOTE: Vendor MCP connection status only; neither tools/call nor LLM inference was executed.",
);
