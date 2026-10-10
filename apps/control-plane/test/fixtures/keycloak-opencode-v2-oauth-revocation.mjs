#!/usr/bin/env node
/**
 * Official OpenCode 2.0.24 MCP connection after synthetic owner disable/re-enable.
 * Uses its OWN stored OAuth credentials; never accesses or injects a bearer.
 * No provider credentials, inference, hosted services or production accounts.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [work, mcpUrl, stage] = process.argv.slice(2);
assert.equal(process.env.GITHUB_ACTIONS, "true", "CI-only isolated experiment");
assert.equal(process.argv.length, 5);
assert.equal(mcpUrl, "https://127.0.0.1:8988/mcp");
assert.ok(["disabled", "reenabled"].includes(stage));

const alias = "telechir-opencode-v2-ci";
const root = join(work, "opencode-v2-native-oauth");
const configFile = join(root, "opencode.json");
assert.ok(existsSync(configFile), "Existing vendor OAuth config missing");
const config = JSON.parse(readFileSync(configFile, "utf8"));
assert.deepEqual(Object.keys(config.mcp.servers), [alias]);
const settings = config.mcp.servers[alias];
assert.equal(settings.type, "remote");
assert.equal(settings.url, mcpUrl);
assert.equal(settings.oauth.client_id, "telechir-phase16-opencode-v2");
assert.equal(settings.oauth.scope, "telechir:devices:read");
assert.equal(settings.headers, undefined, "Injected bearer header forbidden");
assert.equal(settings.oauth.client_secret, undefined);
const env = {
  ...process.env,
  HOME: root,
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"),
  OPENCODE_DISABLE_AUTOUPDATE: "true",
  OPENCODE_DISABLE_TELEMETRY: "true",
  BROWSER: "/bin/true",
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost",
};
for (const key of [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "CODEX_API_KEY",
  "OPENCODE_API_KEY",
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
  ["--yes", "--package=@opencode/cli@2.0.24", "opencode", "mcp", "list"],
  { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] },
);
let stdout = "",
  stderr = "",
  sizeExceeded = false;
for (const [stream, isError] of [
  [cli.stdout, false],
  [cli.stderr, true],
]) {
  stream.on("data", (bytes) => {
    if (isError) stderr += String(bytes);
    else stdout += String(bytes);
    if (stdout.length + stderr.length > 64 * 1024) {
      sizeExceeded = true;
      cli.kill("SIGTERM");
    }
  });
}
const result = await new Promise((resolve, reject) => {
  cli.once("error", reject);
  cli.once("close", (code, signal) => resolve({ code, signal }));
});
assert.equal(sizeExceeded, false, "Vendor CLI output exceeded hard limit");
const output = (stdout + "\n" + stderr)
  .replace(/\x1b\[[0-9;]*[A-Za-z]/gu, "")
  .replace(/\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/gu, "");
const lines = output.split(/\r?\n/u).filter((x) => x.includes(alias));
const knownRefusal =
  /failed|error|disconnected|unauthori[sz]ed|needs?\s+auth|auth(?:entication)?\s+required|401|invalid[\s_-]*token|not connected|denied/iu;
const hasConnected = (line) =>
  /\bconnected\b/iu.test(line) && !knownRefusal.test(line);
const flags = {
  exitCode: result.code,
  hasAlias: lines.length > 0,
  aliasStatusCount: lines.length,
  connected: lines.some(hasConnected),
  explicitRefusal: lines.some((line) => knownRefusal.test(line)),
  stdoutBytes: stdout.length,
  stderrBytes: stderr.length,
  signal: result.signal ?? null,
};
try {
  assert.equal(
    lines.length,
    1,
    "Expected one OpenCode MCP status line for Telechir",
  );
  if (stage === "disabled") {
    assert.ok([0, 1].includes(result.code), "Unexpected CLI failure");
    if (flags.connected) {
      // The vendor's list status is an MCP transport/initialization signal,
      // not an authorization check for protected tools/list. Do not claim
      // revocation PASS when OpenCode still displays Connected.
      assert.equal(flags.explicitRefusal, false);
      console.log(
        "OBSERVED: OPENCODE_V2_MCP_LIST_CONNECTED_AFTER_DISABLED_USER_NOT_CERTIFIED",
      );
    } else {
      assert.equal(flags.explicitRefusal, true, "No explicit vendor MCP refusal");
      console.log(
        "RESULT: OPENCODE_V2_OFFICIAL_OAUTH_DISABLED_USER_MCP_REFUSED_PASS",
      );
    }
  } else {
    assert.equal(
      result.code,
      0,
      "OpenCode failed to list restored MCP connection",
    );
    assert.equal(
      flags.connected,
      true,
      "OpenCode failed to reconnect after D1 enable",
    );
    assert.equal(flags.explicitRefusal, false);
    console.log(
      "RESULT: OPENCODE_V2_OFFICIAL_OAUTH_REENABLED_USER_MCP_CONNECTED_PASS",
    );
  }
} catch {
  // Exclude vendor stdout/stderr: they may contain authorization URLs and tokens.
  console.error("DIAG: OPENCODE_V2_REVOCATION_FLAGS=" + JSON.stringify(flags));
  throw new Error("OpenCode official MCP status does not match D1 user state");
}
console.log(
  "NOTE: OAuth-authenticated new MCP connection; no tool call, model or physical device.",
);
