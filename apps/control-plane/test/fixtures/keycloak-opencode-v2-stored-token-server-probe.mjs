#!/usr/bin/env node
/**
 * Independent SERVER authorization check using a disposable access token
 * issued by real Keycloak and saved by the official OpenCode OAuth CLI.
 * It is NOT a vendor tool call. Token never leaves the CI loopback runtime,
 * is never printed, reused for other identities, or injected into OpenCode.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

const [work, mcpUrl, stage] = process.argv.slice(2);
assert.equal(process.argv.length, 5);
assert.equal(process.env.GITHUB_ACTIONS, "true", "GitHub CI only");
assert.equal(mcpUrl, "https://127.0.0.1:8988/mcp");
assert.ok(["baseline", "disabled", "reenabled"].includes(stage));

// V2 stores globally scoped OAuth credentials in the SQLite 'credential'
// table, NOT V1's mcp-auth.json. Pinning OPENCODE_DB in the CLI environment
// avoids accidental reading of any developer profile or global OAuth store.
const path = join(work, "opencode-v2-native-oauth", "opencode-v2-ci.db");
assert.ok(existsSync(path), "CI-only OpenCode V2 SQLite store missing");
const db = new DatabaseSync(path, { readOnly: true });
let credential;
try {
  const found = db.prepare("SELECT value FROM credential").all();
  const oauth = found
    .map(row => JSON.parse(row.value))
    .filter(x => x?.type === "oauth");
  assert.equal(oauth.length, 1, "Expected exactly one synthetic OpenCode OAuth account");
  credential = oauth[0];
} finally {
  db.close();
}
const token = credential.access;
assert.ok(typeof token === "string" && token.length > 80);
const parts = token.split(".");
assert.equal(parts.length, 3, "Expected real Keycloak signed JWT");
const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
assert.equal(claims.iss, "https://127.0.0.1:9443/realms/telechir-phase16");
assert.equal(claims.azp, "telechir-phase16-opencode-v2");
assert.ok(
  Array.isArray(claims.aud)
    ? claims.aud.includes(mcpUrl)
    : claims.aud === mcpUrl,
);
assert.ok(
  String(claims.telechir_scope_fixture ?? "")
    .split(" ")
    .includes("telechir:devices:read"),
  "Token does not include read-only fixture scope",
);
assert.ok(
  claims.exp > Math.floor(Date.now() / 1000) + 20,
  "Token expiration would confound disabled-user check",
);

const response = await fetch(mcpUrl, {
  method: "POST",
  redirect: "manual",
  headers: {
    Authorization: "Bearer " + token,
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 33,
    method: "tools/list",
    params: {},
  }),
  signal: AbortSignal.timeout(10000),
});
try {
  assert.equal(response.redirected, false);
  if (stage === "disabled") {
    assert.equal(
      response.status,
      401,
      "Disabled user was not denied by production MCP route",
    );
    console.log(
      "RESULT: OPENCODE_V2_STORED_OAUTH_SERVER_DISABLED_USER_DENIED_PASS",
    );
  } else {
    assert.equal(
      response.status,
      200,
      "Valid OAuth read token was not admitted",
    );
    const data = await response.text();
    assert.ok(
      data.length < 256 * 1024,
      "MCP tools/list returned oversized payload",
    );
    const payloads = response.headers
      .get("content-type")
      ?.includes("text/event-stream")
      ? data
          .split(/\r?\n/u)
          .filter((line) => line.startsWith("data:"))
          .map((line) => JSON.parse(line.slice(5).trim()))
      : [JSON.parse(data)];
    const listed = payloads.find((x) => x?.result?.tools)?.result?.tools;
    assert.ok(Array.isArray(listed), "No real MCP tools/list result");
    assert.equal(listed.length, 24, "Unexpected MCP tool registry size");
    assert.ok(listed.some((tool) => tool.name === "list_devices"));
    console.log(
      stage === "baseline"
        ? "RESULT: OPENCODE_V2_STORED_OAUTH_SERVER_BASELINE_READ_PASS"
        : "RESULT: OPENCODE_V2_STORED_OAUTH_SERVER_REENABLED_READ_PASS",
    );
  }
} catch {
  // Deliberately avoid headers/body/JWT/authorization URLs in diagnostics.
  console.error(
    "DIAG: OPENCODE_V2_SERVER_PROBE=" +
      JSON.stringify({
        stage,
        status: response.status,
        responseType: response.headers.get("content-type")?.split(";")[0],
      }),
  );
  throw new Error(
    "Production MCP authorization does not match D1 principal state",
  );
}
console.log(
  "NOTE: independent server RPC with same vendor-stored ephemeral token; NOT an OpenCode tools/call.",
);
