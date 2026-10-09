#!/usr/bin/env node
/**
 * Actual official Codex CLI owns OAuth state, PKCE and code exchange.
 * Chromium ONLY drives official Keycloak GUI; callback URL is pasted into
 * Codex via its documented --no-browser interactive mode.
 * No Codex/ChatGPT account or inference; synthetic CI user and D1 only.
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const [tmp, issuer, mcp] = process.argv.slice(2);
assert.equal(process.argv.length, 5);
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(issuer, "https://127.0.0.1:9443/realms/telechir-phase16");
assert.equal(mcp, "https://127.0.0.1:8988/mcp");
const clientId = "telechir-phase16-codex";
const alias = "telechir_ci";
const callbackHost = "http://127.0.0.1:1455";
const codexHome = join(tmp, "codex-interactive");
const chromeHome = join(codexHome, "chrome-home");
mkdirSync(codexHome, { recursive: true, mode: 0o700 });
const config = [
  'mcp_oauth_credentials_store = "file"',
  "mcp_oauth_callback_port = 1455",
  "[mcp_servers." + alias + "]",
  'url = "' + mcp + '"',
  'oauth_client_id = "' + clientId + '"',
  'oauth_resource = "' + mcp + '"',
  "startup_timeout_sec = 20",
  "tool_timeout_sec = 20",
  "",
].join("\n");
writeFileSync(join(codexHome, "config.toml"), config, { mode: 0o600 });

for (const relative of [".pki/nssdb", ".local/share/pki/nssdb"]) {
  const location = join(chromeHome, relative);
  mkdirSync(location, { recursive: true, mode: 0o700 });
  execFileSync(
    "certutil",
    ["-N", "--empty-password", "-d", "sql:" + location],
    {
      stdio: "pipe",
    },
  );
  execFileSync(
    "certutil",
    [
      "-A",
      "-d",
      "sql:" + location,
      "-n",
      "telechir-phase16-codex-ci-ca",
      "-t",
      "C,,",
      "-i",
      join(tmp, "root.crt"),
    ],
    { stdio: "pipe" },
  );
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
  acceptDownloads: false,
  permissions: [],
});
await ctx.route("**/*", (route) => {
  const url = new URL(route.request().url());
  if (url.origin === callbackHost && url.pathname.startsWith("/callback")) {
    return route.fulfill({
      status: 200,
      contentType: "text/html",
      headers: {
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "content-security-policy": "default-src 'none'",
      },
      body: "<!doctype html><title>CI-only callback captured locally</title>",
    });
  }
  const base = new URL(issuer);
  if (
    url.origin === base.origin &&
    url.pathname.startsWith(base.pathname + "/")
  ) {
    return route.continue();
  }
  return route.abort("blockedbyclient");
});
const childEnv = {
  ...process.env,
  CODEX_HOME: codexHome,
  HOME: codexHome,
  CODEX_DISABLE_TELEMETRY: "1",
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost",
  XDG_CONFIG_HOME: join(codexHome, "xdg-config"),
  XDG_DATA_HOME: join(codexHome, "xdg-data"),
  BROWSER: "/bin/true",
};
for (const key of [
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
]) {
  delete childEnv[key];
}
const args = [
  "--yes",
  "@openai/codex@0.162.0",
  "mcp",
  "login",
  alias,
  "--no-browser",
  "--scopes",
  "telechir:devices:read",
];
const urlPattern =
  /https:\/\/127\.0\.0\.1:9443\/realms\/telechir-phase16\/protocol\/openid-connect\/auth\?[^\s\x1b<>"']+/u;
const stdoutMax = 128 * 1024;
let out = "",
  err = "";
let seen = false,
  settled = false;
let resolveAuth, rejectAuth;
const auth = new Promise((resolve, reject) => {
  resolveAuth = resolve;
  rejectAuth = reject;
});
const child = spawn("npx", args, {
  cwd: codexHome,
  env: childEnv,
  stdio: ["pipe", "pipe", "pipe"],
});
function consume(data, isErr) {
  if (isErr) err += String(data);
  else out += String(data);
  if (out.length + err.length > stdoutMax) child.kill("SIGTERM");
  if (!seen) {
    const url = (out + "\n" + err).match(urlPattern);
    if (url) {
      seen = true;
      resolveAuth(url[0]);
    }
  }
}
child.stdout.on("data", (x) => consume(x, false));
child.stderr.on("data", (x) => consume(x, true));
const done = new Promise((resolve, reject) => {
  child.once("error", (error) => {
    if (!seen) rejectAuth(error);
    reject(error);
  });
  child.once("close", (code, signal) => {
    settled = true;
    if (!seen)
      rejectAuth(new Error("Codex did not initiate authorization URL"));
    resolve({ code, signal });
  });
});
async function bounded(p, ms, name) {
  let timer;
  try {
    return await Promise.race([
      p,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(name)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
try {
  const raw = await bounded(auth, 35000, "Codex CLI did not start OAuth");
  const authorize = new URL(raw);
  assert.equal(authorize.origin, new URL(issuer).origin);
  assert.equal(
    authorize.pathname,
    new URL(issuer).pathname + "/protocol/openid-connect/auth",
  );
  assert.equal(authorize.searchParams.get("response_type"), "code");
  assert.equal(authorize.searchParams.get("client_id"), clientId);
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  assert.match(
    authorize.searchParams.get("code_challenge") ?? "",
    /^[A-Za-z0-9_-]{43}$/u,
  );
  assert.ok((authorize.searchParams.get("state") ?? "").length >= 16);
  assert.equal(authorize.searchParams.get("scope"), "telechir:devices:read");
  const callback = new URL(authorize.searchParams.get("redirect_uri") ?? "");
  assert.equal(callback.origin, callbackHost);
  assert.ok(
    callback.pathname.startsWith("/callback"),
    "unexpected Codex callback path",
  );
  console.log(
    "PASS: official Codex CLI generated OAuth URL, S256 challenge, state and read-only scope; no injected token",
  );

  const page = await ctx.newPage();
  await page.goto(raw, { timeout: 19000 });
  const landed = new URL(page.url());
  assert.equal(
    landed.origin,
    new URL(issuer).origin,
    "Keycloak authorization refused before login",
  );
  await page.locator("#username").fill("phase16-user-ci");
  await page
    .locator("#password")
    .fill("phase16-ci-browser-only-not-a-real-secret");
  await page.locator("#kc-login").click();
  await page
    .locator('[name="accept"]')
    .waitFor({ state: "visible", timeout: 14000 });
  await Promise.all([
    page.waitForURL(
      (u) => u.origin === callbackHost && u.pathname.startsWith("/callback"),
      { timeout: 16000 },
    ),
    page.locator('[name="accept"]').click(),
  ]);
  const returned = new URL(page.url());
  assert.equal(
    returned.origin + returned.pathname,
    callback.origin + callback.pathname,
  );
  assert.equal(
    returned.searchParams.get("state"),
    authorize.searchParams.get("state"),
  );
  assert.ok(returned.searchParams.get("code"));
  console.log(
    "PASS: real Chrome accepted Keycloak consent for actual Codex-owned authorization code",
  );
  // Codex --no-browser explicitly accepts the *entire* callback URL over
  // stdin. Codex, not this harness, verifies state, exchanges PKCE and stores
  // the credential. Never print this URL, even on errors.
  child.stdin.write(returned.href + "\n");
  child.stdin.end();
  const result = await bounded(
    done,
    25000,
    "Codex did not finish OAuth token exchange",
  );
  assert.equal(result.code, 0, "Codex OAuth CLI did not exit successfully");
  assert.ok(
    /Successfully logged in to MCP server|OAuth login successful/iu.test(
      out + err,
    ),
    "Codex CLI did not confirm its own OAuth login",
  );
  console.log("RESULT: KEYCLOAK_REAL_CODEX_CLI_INTERACTIVE_OAUTH_LOGIN_PASS");
} catch (e) {
  // No child stdout/stderr printed: they may contain bearer values/codes.
  // Classify both streams without printing raw CLI data (which may contain
  // full authorization URLs, state, callback codes, tokens or private paths).
  const combined = out + "\n" + err;
  const diagnostic = {
    codexExit: child.exitCode,
    stdoutBytes: out.length,
    stderrBytes: err.length,
    unknownServer: /No MCP server named|No such MCP server/iu.test(combined),
    missingConfig:
      /config(uration)?.*(missing|not found|invalid|load)|parse config/iu.test(
        combined,
      ),
    noBrowserUnsupported:
      /unexpected argument|unrecognized|unknown argument|unknown option/iu.test(
        combined,
      ),
    unknownSubcommand: /unrecognized subcommand|invalid subcommand/iu.test(
      combined,
    ),
    noAuthSupport: /no authorization support|unsupported.*oauth/iu.test(
      combined,
    ),
    terminalRequired: /terminal|tty|stdin|interactive/iu.test(combined),
    registryIssue: /npm error|npm ERR|ENOENT|E404/iu.test(combined),
    keycloakUrlPresent: combined.includes("https://127.0.0.1:9443"),
    authPromptPresent: /paste.*callback|paste.*redirect|visit.*http/iu.test(
      combined,
    ),
    oauthError: /invalid_scope|invalid_client|invalid_request/iu.test(combined),
    tls: /certificate|tls|ssl|unknown issuer|certificate verify/iu.test(
      combined,
    ),
    otherCliError: /error:/iu.test(combined),
  };
  console.error(
    "DIAG: official Codex login sanitized flags=" + JSON.stringify(diagnostic),
  );
  throw new Error(
    "Codex OAuth gate rejected; check sanitized failure flags and step markers",
  );
} finally {
  if (!settled) child.kill("SIGTERM");
  await ctx.close();
  await chrome.close();
}
