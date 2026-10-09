#!/usr/bin/env node
// Raw HTTPS JSON-RPC probe of production MCP route with genuine Keycloak JWT.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [temp, phase] = process.argv.slice(2);
if (!temp || !["positive", "disabled"].includes(phase)) {
  throw new Error("Usage: keycloak-worker-mcp-probe.mjs <private-temp-dir> <positive|disabled>");
}
const url = "https://127.0.0.1:8988/mcp";
const issuer = "https://127.0.0.1:9443/realms/telechir-phase16";
const token = JSON.parse(readFileSync(join(temp, "token.json"), "utf8"))
  .access_token;
assert.equal(typeof token, "string");
const tampered = readFileSync(join(temp, "worker-tampered.token"), "utf8");
const expected = readFileSync(join(temp, "worker-device-id"), "utf8");
const foreign = readFileSync(join(temp, "worker-foreign-device-id"), "utf8");

function mcpBody(method, params = {}) {
  return JSON.stringify({ jsonrpc: "2.0", id: 76, method, params });
}
async function call(method, params, bearer) {
  const headers = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  };
  if (bearer !== null) headers.authorization = `Bearer ${bearer}`;
  return fetch(url, {
    method: "POST",
    headers,
    body: mcpBody(method, params),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
}
async function result(response) {
  assert.equal(response.status, 200);
  const data = await response.text();
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const decoded = data.split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice(5).trim()));
    const payload = decoded.find((x) => x.id === 76 && x.result);
    assert.ok(payload, "SSE response must include matching JSON-RPC tool result");
    return payload.result;
  }
  const payload = JSON.parse(data);
  assert.equal(payload.id, 76);
  assert.ok(payload.result, "JSON-RPC response must contain a result");
  return payload.result;
}
async function status(request, expectedStatus, description) {
  const response = await request;
  assert.equal(response.status, expectedStatus, description);
  await response.body?.cancel();
  return response;
}
const meta = await fetch(
  "https://127.0.0.1:8988/.well-known/oauth-protected-resource",
  { signal: AbortSignal.timeout(12_000), redirect: "error" },
);
assert.equal(meta.status, 200);
const protectedMeta = await meta.json();
assert.equal(protectedMeta.resource, url);
assert.deepEqual(protectedMeta.authorization_servers, [issuer]);

if (phase === "disabled") {
  await status(
    call("tools/call", { name: "list_devices", arguments: { status: "all" } }, token),
    401,
    "D1-disabled user must not call a tool using an unexpired Keycloak JWT",
  );
  console.log("RESULT: KEYCLOAK_WORKER_D1_DISABLED_USER_PASS");
} else {
  await status(call("tools/list", {}, null), 401, "Missing bearer must be denied");
  await status(
    call("tools/call", { name: "list_devices", arguments: { status: "all" } }, tampered),
    401,
    "Modified Keycloak RS256 signature must be denied",
  );
  const listed = await result(await call("tools/list", {}, token));
  assert.equal(listed.tools?.length, 24, "Production MCP must enumerate all public tools");
  const read = await result(await call(
    "tools/call",
    { name: "list_devices", arguments: { status: "all" } },
    token,
  ));
  assert.notEqual(read.isError, true, "Valid Keycloak bearer must execute read");
  const devices = read.structuredContent?.devices;
  assert.ok(Array.isArray(devices), "Expected genuine MCP tool structuredContent");
  assert.equal(devices.length, 1, "Foreign device must not be visible");
  assert.equal(devices[0].device_id, expected);
  assert.ok(devices.every((device) => device.device_id !== foreign));
  const denied = await call(
    "tools/call",
    { name: "write_file", arguments: {} },
    token,
  );
  assert.equal(denied.status, 403, "Keycloak read-only JWT must not grant file writes");
  assert.match(
    denied.headers.get("www-authenticate") ?? "",
    /telechir:files:write/u,
    "Scope denial must disclose the required scope, not a transport error",
  );
  await denied.body?.cancel();
  console.log("PASS: Worker production MCP lists 24 tools and reads only linked D1 device");
  console.log("PASS: real Keycloak JWT denied without Bearer, with tampered signature and with insufficient write scope");
  console.log("RESULT: KEYCLOAK_WORKER_D1_MCP_READONLY_PASS");
}
console.log("NOTE: official Keycloak token; Worker + D1 are real local runtime; IdP discovery/JWKS replayed from TLS-validated snapshots; no model or user login");
