#!/usr/bin/env node
/**
 * Phase 16: Official MCP Inspector CLI owns genuine OAuth authorization.
 * This external Playwright driver ONLY operates Keycloak login/consent DOM.
 * The Inspector owns discovery, state, PKCE verifier, loopback callback,
 * code exchange, token storage, retry, and MCP tools/call.
 *
 * All credentials, callback codes, URLs, tokens and Inspector stderr stay
 * private/in memory; stdout reveals only boolean PASS markers.
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const [temp, issuer, mcpUrl] = process.argv.slice(2);
assert.equal(process.argv.length, 5);
assert.equal(process.env.GITHUB_ACTIONS, "true", "CI-only real client");
assert.equal(issuer, "https://127.0.0.1:9443/realms/telechir-phase16");
assert.equal(mcpUrl, "https://127.0.0.1:8988/mcp");
const callback = "http://127.0.0.1:6276/oauth/callback";
const clientId = "telechir-phase16-inspector";
const root = join(temp, "inspector-oauth");
const home = join(root, "browser-home");
const storage = join(root, "inspector-storage");
const expectedDevice = readFileSync(join(temp, "pkce", "worker-device-id"), "utf8");
const foreignDevice = readFileSync(join(temp, "worker-device-id"), "utf8");
mkdirSync(storage, { recursive: true, mode: 0o700 });
for (const relative of [".pki/nssdb", ".local/share/pki/nssdb"]) {
  const path = join(home, relative);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  execFileSync("certutil", ["-N", "--empty-password", "-d", "sql:" + path], {
    stdio: "pipe",
  });
  execFileSync(
    "certutil",
    [
      "-A", "-d", "sql:" + path, "-n", "telechir-phase16-issuer-ca",
      "-t", "C,,", "-i", join(temp, "root.crt"),
    ],
    { stdio: "pipe" },
  );
}
const chrome = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--no-first-run", "--no-default-browser-check"],
  env: { ...process.env, HOME: home },
});
const ctx = await chrome.newContext({
  ignoreHTTPSErrors: false,
  serviceWorkers: "block",
  acceptDownloads: false,
  permissions: [],
});
await ctx.route("**/*", (route) => {
  const url = new URL(route.request().url());
  if (url.origin + url.pathname === callback) return route.continue();
  if (
    url.origin === new URL(issuer).origin &&
    url.pathname.startsWith(new URL(issuer).pathname + "/")
  ) return route.continue();
  return route.abort("blockedbyclient");
});
const cliEnv = {
  ...process.env,
  MCP_AUTO_OPEN_ENABLED: "true",
  MCP_INSPECTOR_SECRET_STORE: "file",
  MCP_STORAGE_DIR: storage,
  MCP_INSPECTOR_OAUTH_STATE_PATH: join(storage, "oauth.json"),
  MCP_OAUTH_CALLBACK_URL: callback,
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost",
  // Do not spawn an unrelated interactive desktop browser in the CI runner.
  BROWSER: "/bin/true",
  DISPLAY: "",
  XDG_CONFIG_HOME: join(root, "cli-config"),
  XDG_DATA_HOME: join(root, "cli-data"),
};
const args = [
  "--yes",
  "@modelcontextprotocol/inspector@2.5.0",
  "--cli",
  mcpUrl,
  "--transport",
  "http",
  "--client-id",
  clientId,
  "--callback-url",
  callback,
  "--connect-timeout",
  "12000",
  "--method",
  "tools/call",
  "--tool-name",
  "list_devices",
  "--tool-args-json",
  '{"status":"all"}',
  "--format",
  "json",
];
const authPattern = /https:\/\/127\.0\.0\.1:9443\/realms\/telechir-phase16\/protocol\/openid-connect\/auth\?[^\s\x1b<>"']+/u;
const maxOutput = 192 * 1024;
function startInspector() {
  const child = spawn("npx", args, {
    cwd: join(process.cwd(), "apps", "control-plane"),
    env: cliEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let settled = false;
  let authSeen = false;
  let authResolve;
  let authReject;
  const authPromise = new Promise((resolve, reject) => {
    authResolve = resolve;
    authReject = reject;
  });
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
    if (stdout.length > maxOutput) child.kill("SIGTERM");
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
    if (stderr.length > maxOutput) child.kill("SIGTERM");
    if (!authSeen) {
      const match = stderr.match(authPattern);
      if (match) {
        authSeen = true;
        authResolve(match[0]);
      }
    }
  });
  const completion = new Promise((resolve, reject) => {
    child.once("error", (e) => {
      if (!authSeen) authReject(new Error("Inspector process cannot start"));
      reject(e);
    });
    child.once("close", (code, signal) => {
      settled = true;
      if (!authSeen) authReject(new Error("Inspector exited without OAuth URL: exit " + code));
      resolve({ code, signal, stdout, stderr });
    });
  });
  const abort = () => { if (!settled) child.kill("SIGTERM"); };
  return { authPromise, completion, abort };
}
function checkJson(raw) {
  const output = JSON.parse(raw);
  const read = output.result;
  assert.ok(read, "real Inspector CLI must deliver MCP result");
  assert.notEqual(read.isError, true, "read tool must not error");
  assert.ok(Array.isArray(read.structuredContent?.devices), "MCP structuredContent missing");
  assert.equal(read.structuredContent.devices.length, 1, "foreign devices visible");
  assert.equal(read.structuredContent.devices[0].device_id, expectedDevice);
  assert.ok(read.structuredContent.devices.every((d) => d.device_id !== foreignDevice));
}
const inspector = startInspector();
try {
  const authUrl = await Promise.race([
    inspector.authPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Inspector never initiated OAuth")), 45000)),
  ]);
  const url = new URL(authUrl);
  assert.equal(url.origin, new URL(issuer).origin);
  assert.equal(url.pathname, new URL(issuer).pathname + "/protocol/openid-connect/auth");
  assert.equal(url.searchParams.get("client_id"), clientId);
  assert.equal(url.searchParams.get("redirect_uri"), callback);
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.match(url.searchParams.get("code_challenge") ?? "", /^[A-Za-z0-9_-]{43}$/u);
  assert.ok((url.searchParams.get("state") ?? "").length >= 16);
  console.log("PASS: independent official MCP Inspector initiated OAuth with own PKCE S256 and loopback callback");

  const page = await ctx.newPage();
  await page.goto(authUrl, { timeout: 18000 });
  assert.equal(new URL(page.url()).origin, new URL(issuer).origin);
  await page.locator("#username").fill("phase16-user-ci");
  await page.locator("#password").fill("phase16-ci-browser-only-not-a-real-secret");
  await page.locator("#kc-login").click();
  await page.locator('[name="accept"]').waitFor({ state: "visible", timeout: 14000 });
  await Promise.all([
    page.waitForURL((u) => u.origin + u.pathname === callback, { timeout: 16000 }),
    page.locator('[name="accept"]').click(),
  ]);
  assert.equal(new URL(page.url()).origin + new URL(page.url()).pathname, callback);
  console.log("PASS: real Chrome drove official Keycloak login and consent to Inspector-owned callback");

  const outcome = await Promise.race([
    inspector.completion,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Inspector did not return MCP result after OAuth")), 35000)),
  ]);
  if (outcome.code !== 0) {
    // Only a restricted error CLASS — never print stderr, which can include
    // OAuth URLs, codes, state or tokens.
    const flags = {
      exit: outcome.code,
      containsUnauthorized: /unauthoriz|auth_required/iu.test(outcome.stderr),
      containsInvalidScope: /invalid.scope/iu.test(outcome.stderr),
      containsInvalidClient: /invalid.client/iu.test(outcome.stderr),
      containsCallbackError: /callback|timeout/iu.test(outcome.stderr),
    };
    throw new Error("real Inspector OAuth client failed: " + JSON.stringify(flags));
  }
  checkJson(outcome.stdout);
  console.log("RESULT: KEYCLOAK_REAL_INSPECTOR_INTERACTIVE_OAUTH_MCP_PASS");
} finally {
  inspector.abort();
  await ctx.close();
  await chrome.close();
}
