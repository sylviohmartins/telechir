#!/usr/bin/env node
/**
 * Official Claude Code CLI owns the OAuth auth request, S256 PKCE, state,
 * code exchange and credential storage; Chromium only drives real Keycloak UI.
 * GitHub Actions disposable Keycloak/Workerd/D1; no Anthropic login or LLM.
 * OAuth URLs, codes, cookies, tokens and raw vendor output stay private.
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const [work, issuer, resource] = process.argv.slice(2);
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.argv.length, 5);
assert.equal(issuer, "https://127.0.0.1:9443/realms/telechir-phase16");
assert.equal(resource, "https://127.0.0.1:8988/mcp");
const alias = "telechir-claude-ci";
const clientId = "telechir-phase16-claude";
const callback = "http://localhost:18888/callback";
const root = join(work, "claude-native-oauth");
const home = join(root, "claude-home");
const chromeHome = join(root, "chrome-home");
mkdirSync(home, { recursive: true, mode: 0o700 });
const config = {
  mcpServers: {
    [alias]: {
      type: "http",
      url: resource,
      oauth: {
        clientId,
        callbackPort: 18888,
        scopes: "telechir:devices:read",
      },
    },
  },
};
writeFileSync(join(home, ".claude.json"), JSON.stringify(config), { mode: 0o600 });

for (const relative of [".pki/nssdb", ".local/share/pki/nssdb"]) {
  const store = join(chromeHome, relative);
  mkdirSync(store, { recursive: true, mode: 0o700 });
  execFileSync("certutil", ["-N", "--empty-password", "-d", "sql:" + store], { stdio: "pipe" });
  execFileSync("certutil", ["-A", "-d", "sql:" + store, "-n", "telechir-claude-ci-issuer", "-t", "C,,", "-i", join(work, "root.crt")], { stdio: "pipe" });
}
const chrome = await chromium.launch({
  channel: "chrome",
  headless: true,
  env: { ...process.env, HOME: chromeHome },
  args: ["--no-first-run", "--no-default-browser-check"],
});
const ctx = await chrome.newContext({
  ignoreHTTPSErrors: false,
  serviceWorkers: "block",
  permissions: [],
  acceptDownloads: false,
});
const base = new URL(issuer);
await ctx.route("**/*", route => {
  const url = new URL(route.request().url());
  if (url.origin + url.pathname === callback) {
    return route.fulfill({
      status: 200,
      contentType: "text/html",
      headers: {
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "content-security-policy": "default-src 'none'",
      },
      body: "<!doctype html><title>CI-only OAuth callback</title>",
    });
  }
  if (url.origin === base.origin && url.pathname.startsWith(base.pathname + "/")) {
    return route.continue();
  }
  return route.abort("blockedbyclient");
});
const env = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: join(root, "xdg-config"),
  XDG_DATA_HOME: join(root, "xdg-data"),
  DISABLE_TELEMETRY: "1",
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost",
  BROWSER: "/bin/true",
  TERM: "xterm-256color",
};
for (const key of [
  "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_API_KEY", "OPENAI_API_KEY",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
  "http_proxy", "https_proxy", "all_proxy",
]) delete env[key];

const cliArgs = [
  "--yes", "--package=@anthropic-ai/claude-code@2.1.295",
  "claude", "mcp", "login", alias, "--no-browser",
];
const command = "stty -echo && exec npx " + cliArgs.join(" ");
const proc = spawn(
  "script",
  ["--quiet", "--return", "--command", command, "/dev/null"],
  { cwd: home, env, stdio: ["pipe", "pipe", "pipe"] },
);
let output = "", errors = "", closed = false, resolveAuth, rejectAuth;
let matched = false;
const seenAuth = new Promise((resolve, reject) => {
  resolveAuth = resolve; rejectAuth = reject;
});
const authPattern = /https:\/\/127\.0\.0\.1:9443\/realms\/telechir-phase16\/protocol\/openid-connect\/auth\?[^\s\x1b<>"']+/u;
const cleanAnsi = value => value
  .replace(/\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/gu, "")
  .replace(/\x1b\[[0-9;]*[A-Za-z]/gu, "");
function consume(chunk, isErr) {
  if (isErr) errors += String(chunk); else output += String(chunk);
  const total = output.length + errors.length;
  if (total > 160 * 1024) proc.kill("SIGTERM");
  if (!matched) {
    const hit = cleanAnsi(output + "\n" + errors).match(authPattern);
    if (hit) {
      matched = true; resolveAuth(hit[0]);
    }
  }
}
proc.stdout.on("data", data => consume(data, false));
proc.stderr.on("data", data => consume(data, true));
const exited = new Promise((resolve, reject) => {
  proc.once("error", err => {
    if (!matched) rejectAuth(new Error("Official Claude process failed to start"));
    reject(err);
  });
  proc.once("close", (code, signal) => {
    closed = true;
    if (!matched) rejectAuth(new Error("Official Claude Code did not initiate OAuth"));
    resolve({ code, signal });
  });
});
async function bounded(promise, ms, name) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(name)), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}
function flags() {
  const raw = output + "\n" + errors;
  return {
    processExitCode: proc.exitCode,
    stdoutBytes: output.length,
    stderrBytes: errors.length,
    hasAuthUrl: matched,
    unknownCommand: /unknown command|unknown subcommand|unrecognized command/iu.test(raw),
    invalidOption: /unknown option|unexpected argument|unrecognized option/iu.test(raw),
    missingConfig: /no mcp server|not found|unknown server|no server named/iu.test(raw),
    requiresAccount: /login to claude|sign in to claude|not logged in|anthropic account/iu.test(raw),
    tls: /tls|ssl|certificate|unable to verify/iu.test(raw),
    refusedByIdP: /invalid_scope|invalid_request|invalid_client/iu.test(raw),
    oauthMentioned: /oauth|authoriz|authenticate/iu.test(raw),
  };
}
try {
  const authRaw = await bounded(seenAuth, 65000, "Claude Code did not start browser OAuth");
  const auth = new URL(authRaw);
  assert.equal(auth.origin, base.origin);
  assert.equal(auth.pathname, base.pathname + "/protocol/openid-connect/auth");
  assert.equal(auth.searchParams.get("response_type"), "code");
  assert.equal(auth.searchParams.get("client_id"), clientId);
  assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
  assert.match(auth.searchParams.get("code_challenge") ?? "", /^[A-Za-z0-9_-]{43}$/u);
  assert.ok((auth.searchParams.get("state") ?? "").length >= 16);
  assert.equal(auth.searchParams.get("redirect_uri"), callback);
  assert.ok((auth.searchParams.get("scope") ?? "").split(" ").includes("telechir:devices:read"));
  assert.equal(auth.searchParams.getAll("resource").length, 1);
  assert.deepEqual(auth.searchParams.getAll("resource"), [resource]);
  console.log("PASS: official Claude Code 2.1.295 initiates read-only Keycloak OAuth with own S256 PKCE, state and fixed loopback callback");

  const page = await ctx.newPage();
  await page.goto(authRaw, { timeout: 20000 });
  assert.equal(new URL(page.url()).origin, base.origin);
  await page.locator("#username").fill("phase16-user-ci");
  await page.locator("#password").fill("phase16-ci-browser-only-not-a-real-secret");
  await page.locator("#kc-login").click();
  await page.locator('[name="accept"]').waitFor({ state: "visible", timeout: 15000 });
  await Promise.all([
    page.waitForURL(u => u.origin + u.pathname === callback, { timeout: 16000 }),
    page.locator('[name="accept"]').click(),
  ]);
  const returned = new URL(page.url());
  assert.equal(returned.searchParams.get("state"), auth.searchParams.get("state"));
  assert.ok(returned.searchParams.get("code") && !returned.searchParams.get("error"));
  console.log("PASS: Chrome/Keycloak consent returned Claude-owned code, state and callback");
  // Official --no-browser paste mode owns validation and PKCE exchange.
  // Never print or persist the sensitive redirect URL.
  proc.stdin.write(returned.href + "\n");
  proc.stdin.end();
  const status = await bounded(exited, 32000, "Claude Code did not complete its own code exchange");
  assert.equal(status.code, 0, "Claude Code did not report successful OAuth login");
  console.log("PASS: Claude Code completed vendor-owned OAuth login");

  // Independent invocation of the SAME published Claude binary reloads its own
  // stored OAuth credentials, not a harness-injected bearer.
  const connection = spawn(
    "npx",
    ["--yes", "--package=@anthropic-ai/claude-code@2.1.295", "claude", "mcp", "list"],
    { cwd: home, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let connOut = "", connErr = "";
  for (const [stream, isErr] of [[connection.stdout, false], [connection.stderr, true]]) {
    stream.on("data", x => {
      if (isErr) connErr += String(x); else connOut += String(x);
      if (connOut.length + connErr.length > 64 * 1024) connection.kill("SIGTERM");
    });
  }
  const connExit = await bounded(new Promise((resolve, reject) => {
    connection.once("error", reject);
    connection.once("close", (code, signal) => resolve({ code, signal }));
  }), 55000, "Claude did not finish stored-OAuth MCP connection");
  assert.equal(connExit.code, 0, "Claude mcp list failed after OAuth");
  assert.match(connOut + connErr, /telechir-claude-ci[^\r\n]*(?:Connected|✔)/iu, "Claude did not connect with own OAuth credential");
  console.log("RESULT: KEYCLOAK_CLAUDE_CODE_OFFICIAL_OAUTH_MCP_CONNECTED_PASS");
  console.log("NOTE: vendor OAuth login + real MCP connection; no LLM, host tool execution or real device certified.");
} catch (err) {
  console.error("DIAG: sanitized Claude OAuth failure flags=" + JSON.stringify(flags()));
  throw new Error("Claude Code native OAuth gate failed; see classified flags and PASS markers");
} finally {
  if (!closed) proc.kill("SIGTERM");
  await ctx.close();
  await chrome.close();
}
