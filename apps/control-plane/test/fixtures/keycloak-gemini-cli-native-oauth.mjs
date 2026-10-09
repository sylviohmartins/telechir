#!/usr/bin/env node
/**
 * CI-only Gemini CLI OAuth experiment. The official vendor binary starts the
 * flow; Playwright only operates the real Keycloak browser UI. No model login,
 * real accounts or pre-supplied Bearer credentials.
 * Never print auth URLs, codes, state, JWTs, cookies or process raw output.
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const [work, issuer, resource] = process.argv.slice(2);
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(issuer, "https://127.0.0.1:9443/realms/telechir-phase16");
assert.equal(resource, "https://127.0.0.1:8988/mcp");
const alias = "telechir-gemini-phase16-ci";
const home = join(work, "gemini-native-oauth");
const geminiHome = join(home, ".gemini");
const chromeHome = join(home, "chrome-home");
const urlFile = join(home, "browser-url");
const binDir = join(home, "bin");
mkdirSync(geminiHome, { recursive: true, mode: 0o700 });
mkdirSync(binDir, { recursive: true, mode: 0o700 });
const settings = JSON.parse(
  readFileSync(
    join(work, "browser-pkce", "gemini-oauth-settings-ci.json"),
    "utf8",
  ),
);
assert.equal(settings.mcpServers[alias].httpUrl, resource);
assert.equal(
  settings.mcpServers[alias].oauth.clientId,
  "telechir-phase16-gemini",
);
assert.deepEqual(settings.mcpServers[alias].oauth.scopes, [
  "telechir:devices:read",
]);
assert.equal(
  settings.mcpServers[alias].oauth.redirectUri,
  "http://127.0.0.1:8777/oauth/callback",
);
assert.equal(settings.mcpServers[alias].trust, false);
writeFileSync(join(geminiHome, "settings.json"), JSON.stringify(settings), {
  mode: 0o600,
});

// Intercept only the OS browser launcher, never the OAuth client or HTTP flow.
// The official Gemini CLI owns S256, state, listener, exchange and token store.
// Chrome will deliver the callback through the real loopback listener.
const browserShim = join(binDir, "xdg-open");
writeFileSync(
  browserShim,
  [
    "#!/bin/sh",
    "set -eu",
    "umask 077",
    'case "${1:-}" in https://127.0.0.1:9443/realms/telechir-phase16/*) printf \'%s\' "$1" > "$TELECHIR_BROWSER_URL_FILE";; *) exit 80;; esac',
    "",
  ].join("\n"),
  { mode: 0o700 },
);
chmodSync(browserShim, 0o700);

for (const relative of [".pki/nssdb", ".local/share/pki/nssdb"]) {
  const store = join(chromeHome, relative);
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
      "telechir-gemini-ci-ca",
      "-t",
      "C,,",
      "-i",
      join(work, "root.crt"),
    ],
    { stdio: "pipe" },
  );
}
const browser = await chromium.launch({
  headless: true,
  channel: "chrome",
  env: { ...process.env, HOME: chromeHome },
  args: ["--no-first-run", "--no-default-browser-check"],
});
const ctx = await browser.newContext({
  ignoreHTTPSErrors: false,
  serviceWorkers: "block",
  acceptDownloads: false,
  permissions: [],
});
const callbackOrigin = "http://127.0.0.1:8777";
await ctx.route("**/*", (route) => {
  const u = new URL(route.request().url());
  if (u.origin === callbackOrigin && u.pathname === "/oauth/callback")
    return route.continue();
  const base = new URL(issuer);
  if (u.origin === base.origin && u.pathname.startsWith(base.pathname + "/"))
    return route.continue();
  return route.abort("blockedbyclient");
});
const env = {
  ...process.env,
  HOME: home,
  GEMINI_CLI_HOME: home,
  GEMINI_CLI_TRUST_WORKSPACE: "true",
  GEMINI_TELEMETRY_ENABLED: "false",
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost",
  BROWSER: browserShim,
  PATH: binDir + ":" + process.env.PATH,
  TELECHIR_BROWSER_URL_FILE: urlFile,
};
for (const key of [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "OPENAI_API_KEY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
])
  delete env[key];
const child = spawn(
  "npx",
  ["--yes", "@google/gemini-cli@0.63.0", "mcp", "list"],
  {
    cwd: home,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let out = "",
  err = "",
  exit = null;
const maxOut = 100 * 1024;
child.stdout.on("data", (data) => {
  out += String(data);
  if (out.length + err.length > maxOut) child.kill();
});
child.stderr.on("data", (data) => {
  err += String(data);
  if (out.length + err.length > maxOut) child.kill();
});
const finished = new Promise((resolve) => {
  child.once("error", (error) => {
    exit = { code: -1, kind: error.code ?? "SPAWN" };
    resolve();
  });
  child.once("close", (code, signal) => {
    exit = { code, signal };
    resolve();
  });
});
function authorizeUrl() {
  if (existsSync(urlFile)) return readFileSync(urlFile, "utf8").trim();
  // Some CLI versions display a manual browser URL instead of calling xdg-open.
  const match = (out + "\n" + err).match(
    /https:\/\/127\.0\.0\.1:9443\/realms\/telechir-phase16\/protocol\/openid-connect\/auth\?[^\s\x1b<>"']+/u,
  );
  return match?.[0] ?? null;
}
function publicDiagnostic() {
  const combined = out + "\n" + err;
  return {
    vendorExitCode: exit?.code ?? null,
    stdoutBytes: out.length,
    stderrBytes: err.length,
    browserLaunchCaptured: existsSync(urlFile),
    oauthUrlSeen: !!authorizeUrl(),
    connected: /telechir-gemini-phase16-ci[^\\r\\n]*\\bConnected\\b/iu.test(
      combined,
    ),
    disconnected: /disconnected|not authenticated/iu.test(combined),
    needsModelAccount:
      /login with google|authenticate with google|api key|select an auth method/iu.test(
        combined,
      ),
    oauthError: /oauth|authorize|authenticat/iu.test(combined),
    tlsError: /certificate|tls|ssl/iu.test(combined),
    dcrError: /dynamic client registration/iu.test(combined),
  };
}
async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
try {
  let url = null;
  for (let i = 0; i < 85; i++) {
    url = authorizeUrl();
    if (url || exit) break;
    await sleep(500);
  }
  if (!url) {
    await Promise.race([finished, sleep(3000)]);
    console.error(
      "DIAG: Gemini CLI native OAuth discovery flags=" +
        JSON.stringify(publicDiagnostic()),
    );
    throw new Error("Gemini CLI did not initiate OAuth browser authorization");
  }
  const authorize = new URL(url);
  assert.equal(authorize.origin, new URL(issuer).origin);
  assert.equal(
    authorize.pathname,
    new URL(issuer).pathname + "/protocol/openid-connect/auth",
  );
  assert.equal(
    authorize.searchParams.get("client_id"),
    "telechir-phase16-gemini",
  );
  assert.equal(authorize.searchParams.get("response_type"), "code");
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  assert.match(
    authorize.searchParams.get("code_challenge") ?? "",
    /^[A-Za-z0-9_-]{43}$/u,
  );
  assert.ok((authorize.searchParams.get("state") ?? "").length >= 16);
  assert.ok(
    (authorize.searchParams.get("scope") ?? "").includes(
      "telechir:devices:read",
    ),
  );
  assert.equal(
    new URL(authorize.searchParams.get("redirect_uri") ?? "").origin,
    callbackOrigin,
  );
  console.log(
    "PASS: official Gemini CLI generated its own S256 authorization URL and read-only scope",
  );
  const page = await ctx.newPage();
  await page.goto(url, { timeout: 22000 });
  assert.equal(new URL(page.url()).origin, new URL(issuer).origin);
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
      (u) => u.origin === callbackOrigin && u.pathname === "/oauth/callback",
      { timeout: 20000 },
    ),
    page.locator('[name="accept"]').click(),
  ]);
  const callback = new URL(page.url());
  assert.equal(
    callback.searchParams.get("state"),
    authorize.searchParams.get("state"),
  );
  assert.ok(
    callback.searchParams.has("code") && !callback.searchParams.has("error"),
  );
  // Do not send code to CLI through harness; browser navigated real callback.
  await Promise.race([finished, sleep(24000)]);
  console.log(
    "DIAG: Gemini post-browser flags=" + JSON.stringify(publicDiagnostic()),
  );
  assert.ok(
    existsSync(join(geminiHome, "mcp-oauth-tokens.json")),
    "Gemini token store missing",
  );
  assert.equal(exit?.code, 0, "Gemini CLI did not exit cleanly");
  assert.ok(
    publicDiagnostic().connected,
    "Gemini CLI did not report connected",
  );
  console.log("RESULT: KEYCLOAK_GEMINI_CLI_OWN_OAUTH_DISCOVERY_PASS");
} catch (e) {
  console.error(
    "DIAG: Gemini native OAuth attempt flags=" +
      JSON.stringify(publicDiagnostic()),
  );
  throw new Error(
    "Gemini CLI native OAuth experiment failed: " +
      e.message.replace(/https?:\/\/\S+/gu, "[URL_REDACTED]"),
  );
} finally {
  child.kill("SIGTERM");
  await Promise.race([finished, sleep(1200)]);
  await ctx.close();
  await browser.close();
}
