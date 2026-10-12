#!/usr/bin/env node
/**
 * Real OpenCode V2 CLI owns OAuth authorization, PKCE, code exchange and
 * persistent token storage. Chrome only drives real Keycloak login/consent.
 * No LLM inference, user account, injected bearer or production endpoint.
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const [work, issuer, mcpUrl] = process.argv.slice(2);
assert.equal(process.argv.length, 5);
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(issuer, "https://127.0.0.1:9443/realms/telechir-phase16");
assert.equal(mcpUrl, "https://127.0.0.1:8988/mcp");
const clientId = "telechir-phase16-opencode-v2";
const alias = "telechir-opencode-v2-ci";
const callback = "http://127.0.0.1:19876/mcp/oauth/callback";
const root = join(work, "opencode-v2-native-oauth");
const configHome = join(root, "config");
const dataHome = join(root, "data");
const browserHome = join(root, "chrome-home");
const config = {
  autoupdate: false,
  mcp: {
    servers: {
      [alias]: {
        type: "remote",
        url: mcpUrl,
        oauth: {
          client_id: clientId,
          scope: "telechir:devices:read",
          callback_port: 19876,
          redirect_uri: callback,
        },
      },
    },
  },
};
for (const dir of [root, configHome, dataHome, browserHome]) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}
writeFileSync(join(root, "opencode.json"), JSON.stringify(config), {
  mode: 0o600,
});
for (const relative of [".pki/nssdb", ".local/share/pki/nssdb"]) {
  const store = join(browserHome, relative);
  mkdirSync(store, { recursive: true, mode: 0o700 });
  execFileSync("certutil", ["-N", "--empty-password", "-d", "sql:" + store], {
    stdio: "pipe",
  });
  execFileSync(
    "certutil",
    [
      "-A",
      "-d",
      "sql:" + store,
      "-n",
      "telechir-opencode-v2-keycloak-ca",
      "-t",
      "C,,",
      "-i",
      join(work, "root.crt"),
    ],
    { stdio: "pipe" },
  );
}
const chrome = await chromium.launch({
  channel: "chrome",
  headless: true,
  env: { ...process.env, HOME: browserHome },
  args: ["--no-first-run", "--no-default-browser-check"],
});
const ctx = await chrome.newContext({
  ignoreHTTPSErrors: false,
  serviceWorkers: "block",
  acceptDownloads: false,
  permissions: [],
});
const issuerBase = new URL(issuer);
const callbackBase = new URL(callback);
await ctx.route("**/*", (route) => {
  const u = new URL(route.request().url());
  if (
    u.origin === callbackBase.origin &&
    u.pathname === callbackBase.pathname
  ) {
    return route.continue();
  }
  if (
    u.origin === issuerBase.origin &&
    u.pathname.startsWith(issuerBase.pathname + "/")
  ) {
    return route.continue();
  }
  return route.abort("blockedbyclient");
});
const env = {
  ...process.env,
  HOME: root,
  XDG_CONFIG_HOME: configHome,
  XDG_DATA_HOME: dataHome,
  OPENCODE_DISABLE_AUTOUPDATE: "true",
  // V2 credentials live in SQLite; pin a CI-only DB outside vendor defaults.
  OPENCODE_DB: join(root, "opencode-v2-ci.db"),
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
const cli = ["--yes", "--package=@opencode/cli@2.0.24", "opencode"];
let output = "";
let errorOutput = "";
let closed = false;
let resolveAuth, rejectAuth;
let gotAuth = false;
const authUrl = new Promise((resolve, reject) => {
  resolveAuth = resolve;
  rejectAuth = reject;
});
const urlPattern =
  /https:\/\/127\.0\.0\.1:9443\/realms\/telechir-phase16\/protocol\/openid-connect\/auth\?[^\s\x1b<>"']+/u;
const stripAnsi = (raw) =>
  raw
    .replace(/\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/gu, "")
    .replace(/\x1b\[[0-9;]*[A-Za-z]/gu, "");
const p = spawn("npx", [...cli, "mcp", "auth", alias], {
  cwd: root,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
function consume(x, isErr) {
  if (isErr) errorOutput += String(x);
  else output += String(x);
  if (output.length + errorOutput.length > 170 * 1024) p.kill("SIGTERM");
  if (!gotAuth) {
    const m = stripAnsi(output + "\n" + errorOutput).match(urlPattern);
    if (m) {
      gotAuth = true;
      resolveAuth(m[0]);
    }
  }
}
p.stdout.on("data", (x) => consume(x, false));
p.stderr.on("data", (x) => consume(x, true));
const completion = new Promise((resolve, reject) => {
  p.once("error", (e) => {
    if (!gotAuth) rejectAuth(new Error("OpenCode CLI did not start"));
    reject(e);
  });
  p.once("close", (code, signal) => {
    closed = true;
    if (!gotAuth) rejectAuth(new Error("OpenCode CLI exited before OAuth URL"));
    resolve({ code, signal });
  });
});
async function bounded(promise, ms, description) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(description)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function flags() {
  const raw = output + "\n" + errorOutput;
  return {
    cliExitCode: p.exitCode,
    outputBytes: output.length,
    errorBytes: errorOutput.length,
    vendorAuthUrl: gotAuth,
    cliUnknownCommand:
      /unknown command|unknown subcommand|unknown option/iu.test(raw),
    missingConfig: /unknown server|not found|no mcp server/iu.test(raw),
    tlsError: /certificate|ssl|tls|unable to verify/iu.test(raw),
    invalidClient: /invalid_client|invalid_request|invalid_scope/iu.test(raw),
    needsModel: /model provider|api key required|no provider/iu.test(raw),
  };
}
try {
  const rawUrl = await bounded(
    authUrl,
    65000,
    "OpenCode official CLI did not generate OAuth URL",
  );
  const auth = new URL(rawUrl);
  assert.equal(auth.origin, issuerBase.origin);
  assert.equal(
    auth.pathname,
    issuerBase.pathname + "/protocol/openid-connect/auth",
  );
  assert.equal(auth.searchParams.get("response_type"), "code");
  assert.equal(auth.searchParams.get("client_id"), clientId);
  assert.equal(auth.searchParams.get("redirect_uri"), callback);
  assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
  assert.match(
    auth.searchParams.get("code_challenge") ?? "",
    /^[A-Za-z0-9_-]{43}$/u,
  );
  assert.ok((auth.searchParams.get("state") ?? "").length >= 16);
  assert.ok(
    (auth.searchParams.get("scope") ?? "")
      .split(" ")
      .includes("telechir:devices:read"),
  );
  assert.deepEqual(auth.searchParams.getAll("resource"), [mcpUrl]);
  console.log(
    "PASS: official OpenCode V2 initiates native Keycloak OAuth PKCE S256 and scoped loopback callback",
  );
  const page = await ctx.newPage();
  await page.goto(rawUrl, { timeout: 22000 });
  assert.equal(new URL(page.url()).origin, issuerBase.origin);
  await page.locator("#username").fill("phase16-user-ci");
  await page
    .locator("#password")
    .fill("phase16-ci-browser-only-not-a-real-secret");
  await page.locator("#kc-login").click();
  await page
    .locator('[name="accept"]')
    .waitFor({ state: "visible", timeout: 18000 });
  await Promise.all([
    page.waitForURL(
      (u) =>
        u.origin === callbackBase.origin &&
        u.pathname === callbackBase.pathname,
      { timeout: 22000 },
    ),
    page.locator('[name="accept"]').click(),
  ]);
  assert.equal(
    new URL(page.url()).searchParams.get("state"),
    auth.searchParams.get("state"),
  );
  assert.ok(new URL(page.url()).searchParams.get("code"));
  const finished = await bounded(
    completion,
    33000,
    "OpenCode CLI failed to complete its own OAuth code exchange",
  );
  assert.equal(
    finished.code,
    0,
    "Official OpenCode CLI did not complete OAuth login",
  );
  console.log(
    "PASS: Chrome Keycloak consent and native OpenCode code exchange completed",
  );
  const list = spawn("npx", [...cli, "mcp", "list"], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let listOut = "",
    listErr = "";
  for (const [stream, isError] of [
    [list.stdout, false],
    [list.stderr, true],
  ]) {
    stream.on("data", (x) => {
      if (isError) listErr += String(x);
      else listOut += String(x);
      if (listOut.length + listErr.length > 64 * 1024) list.kill("SIGTERM");
    });
  }
  const listEnd = await bounded(
    new Promise((resolve, reject) => {
      list.once("error", reject);
      list.once("close", (code, signal) => resolve({ code, signal }));
    }),
    55000,
    "OpenCode official CLI did not report post-OAuth MCP status",
  );
  assert.equal(listEnd.code, 0);
  assert.match(
    listOut + "\n" + listErr,
    /telechir-opencode-v2-ci[^\r\n]*(?:connected|✓)/iu,
    "OpenCode did not connect with own stored OAuth",
  );
  console.log("RESULT: KEYCLOAK_OPENCODE_V2_OFFICIAL_OAUTH_MCP_CONNECTED_PASS");
  console.log(
    "NOTE: Native vendor OAuth and MCP connection only; not tool call, LLM, account, or physical device.",
  );
} catch {
  console.error("DIAG: OPENCODE_NATIVE_OAUTH_FLAGS=" + JSON.stringify(flags()));
  throw new Error(
    "Official OpenCode V2 OAuth connection gate failed; no credential material printed",
  );
} finally {
  if (!closed) p.kill("SIGTERM");
  await ctx.close();
  await chrome.close();
}
