#!/usr/bin/env node
/**
 * Run the published Gemini CLI REPL in a disposable CI PTY.
 * No real Google/API credentials, no production devices, no model inference.
 * A fake model key allows testing CLI startup, not model authorization.
 * Keycloak + Chromium handle ONLY real browser consent, never token exchange.
 * No raw CLI output, OAuth URLs, tokens or callbacks in CI logs.
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const [work, issuer, resource] = process.argv.slice(2);
assert.equal(process.argv.length, 5);
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(issuer, "https://127.0.0.1:9443/realms/telechir-phase16");
assert.equal(resource, "https://127.0.0.1:8988/mcp");
const alias = "telechir-gemini-phase16-ci";
const home = join(work, "gemini-repl-probe");
const settingsDir = join(home, ".gemini");
const chromeHome = join(home, "chrome-home");
const launchFile = join(home, "browser-url");
const binDir = join(home, "bin");
for (const p of [home, settingsDir, chromeHome, binDir]) {
  mkdirSync(p, { recursive: true, mode: 0o700 });
}
const original = JSON.parse(
  readFileSync(
    join(work, "browser-pkce", "gemini-oauth-settings-ci.json"),
    "utf8",
  ),
);
assert.equal(original.mcpServers[alias].httpUrl, resource);
assert.equal(
  original.mcpServers[alias].oauth.clientId,
  "telechir-phase16-gemini",
);
assert.deepEqual(original.mcpServers[alias].oauth.scopes, [
  "telechir:devices:read",
]);
assert.equal(original.mcpServers[alias].trust, false);
const settings = {
  ...original,
  security: { auth: { selectedType: "gemini-api-key" } },
};
writeFileSync(join(settingsDir, "settings.json"), JSON.stringify(settings), {
  mode: 0o600,
});
// The shim only captures an official browser launch; it does not alter OAuth
// code, state, exchange, verifier or the loopback HTTP callback listener.
const opener = join(binDir, "xdg-open");
writeFileSync(
  opener,
  `#!/bin/sh
set -eu
umask 077
case "\${1:-}" in
  https://127.0.0.1:9443/realms/telechir-phase16/*)
    printf '%s' "$1" > "$TELECHIR_BROWSER_URL_FILE";;
  *) exit 81;;
esac
`,
  { mode: 0o700 },
);
for (const relative of [".pki/nssdb", ".local/share/pki/nssdb"]) {
  const path = join(chromeHome, relative);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  execFileSync("certutil", ["-N", "--empty-password", "-d", "sql:" + path], {
    stdio: "pipe",
  });
  execFileSync(
    "certutil",
    [
      "-A",
      "-d",
      "sql:" + path,
      "-n",
      "telechir-gemini-repl-test-ca",
      "-t",
      "C,,",
      "-i",
      join(work, "root.crt"),
    ],
    { stdio: "pipe" },
  );
}
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  env: { ...process.env, HOME: chromeHome },
  args: ["--no-first-run", "--no-default-browser-check"],
});
const context = await browser.newContext({
  ignoreHTTPSErrors: false,
  serviceWorkers: "block",
  acceptDownloads: false,
  permissions: [],
});
const callbackOrigin = "http://127.0.0.1:8777";
await context.route("**/*", (route) => {
  const u = new URL(route.request().url());
  if (u.origin === callbackOrigin && u.pathname === "/oauth/callback")
    return route.continue();
  const issuerBase = new URL(issuer);
  if (
    u.origin === issuerBase.origin &&
    u.pathname.startsWith(issuerBase.pathname + "/")
  ) {
    return route.continue();
  }
  return route.abort("blockedbyclient");
});

const cliBin = process.env.TELECHIR_GEMINI_BIN;
assert.ok(
  typeof cliBin === "string" &&
    cliBin.startsWith(join(home, "npm-cache", "_npx") + "/") &&
    existsSync(cliBin),
  "Gemini CLI binary must be preloaded inside disposable npm cache",
);
const env = {
  ...process.env,
  HOME: home,
  GEMINI_CLI_HOME: home,
  GEMINI_CLI_TRUST_WORKSPACE: "true",
  GEMINI_TELEMETRY_ENABLED: "false",
  GEMINI_API_KEY: "telechir-phase16-ci-dummy-key-not-valid-with-google",
  // Fail closed for vendor model endpoints: only Keycloak/Worker loopback
  // should be contacted while testing the interactive slash command.
  HTTPS_PROXY: "http://127.0.0.1:9",
  HTTP_PROXY: "http://127.0.0.1:9",
  ALL_PROXY: "http://127.0.0.1:9",
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost",
  PATH: binDir + ":" + process.env.PATH,
  BROWSER: opener,
  TELECHIR_BROWSER_URL_FILE: launchFile,
};
for (const k of [
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "CODEX_API_KEY",
])
  delete env[k];
const child = spawn(
  "script",
  [
    "--quiet",
    "--return",
    "--command",
    'stty -echo && exec "$TELECHIR_GEMINI_BIN" --screen-reader',
    "/dev/null",
  ],
  { cwd: home, env, stdio: ["pipe", "pipe", "pipe"] },
);
let out = "",
  err = "",
  closed = false,
  result = null;
const done = new Promise((resolve) => {
  child.once("error", (e) => {
    closed = true;
    result = { exit: -1, kind: e.code ?? "SPAWN_ERROR" };
    resolve();
  });
  child.once("close", (code, signal) => {
    closed = true;
    result = { exit: code, signal };
    resolve();
  });
});
for (const [stream, type] of [
  [child.stdout, "out"],
  [child.stderr, "err"],
]) {
  stream.on("data", (x) => {
    if (type === "out") out += String(x);
    else err += String(x);
    if (out.length + err.length > 128 * 1024) child.kill("SIGTERM");
  });
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tokenPath = join(settingsDir, "mcp-oauth-tokens.json");
function oauthUrl() {
  if (existsSync(launchFile)) return readFileSync(launchFile, "utf8").trim();
  const m = (out + "\n" + err).match(
    /https:\/\/127\.0\.0\.1:9443\/realms\/telechir-phase16\/protocol\/openid-connect\/auth\?[^\s\x1b<>"']+/u,
  );
  return m?.[0] ?? null;
}
function flags() {
  const text = out + "\n" + err;
  return {
    cliExited: closed,
    cliExitCode: result?.exit ?? null,
    bytes: text.length,
    oauthStarted: !!oauthUrl(),
    redirectedBrowser: existsSync(launchFile),
    cliAuthPrompt: /authenticate|sign in|auth method|gemini api key/iu.test(
      text,
    ),
    authRejected:
      /invalid api key|api key not valid|unauthorized|permission denied/iu.test(
        text,
      ),
    mcpAuthPrompt: /oauth|mcp auth|authorization/iu.test(text),
    tlsError: /certificate.*error|tls.*error/iu.test(text),
    startupOrPackageError:
      /npm error|module_not_found|unknown option|unknown argument|no such file|cannot find package/iu.test(
        text,
      ),
    storedMcpToken: existsSync(tokenPath),
  };
}
try {
  // Give the published REPL time to render or open an auth selector.
  await Promise.race([done, sleep(12000)]);
  if (!closed) child.stdin.write("/mcp auth " + alias + "\r");
  let url = null;
  for (let i = 0; i < 75; i++) {
    url = oauthUrl();
    if (url || closed) break;
    await sleep(500);
  }
  if (!url) {
    const diag = flags();
    if (
      diag.startupOrPackageError ||
      (closed && result?.exit !== 0 && !diag.authRejected)
    ) {
      console.error(
        "DIAG: GEMINI_REPL_UNEXPECTED_STARTUP_FAILURE=" + JSON.stringify(diag),
      );
      throw new Error(
        "Official Gemini CLI REPL failed before a meaningful OAuth precondition check",
      );
    }
    assert.equal(
      existsSync(tokenPath),
      false,
      "Unexpected Gemini credentials without OAuth",
    );
    console.log(
      "DIAG: GEMINI_REPL_OAUTH_PRECONDITIONS=" + JSON.stringify(flags()),
    );
    console.log("RESULT: GEMINI_CLI_REPL_OAUTH_NOT_OBSERVED_NOT_CERTIFIED");
    console.log(
      "NOT_TESTED: Gemini /mcp auth did not emit authorization URL in account-free CI REPL",
    );
  } else {
    const auth = new URL(url);
    assert.equal(auth.origin, new URL(issuer).origin);
    assert.equal(auth.searchParams.get("response_type"), "code");
    assert.equal(auth.searchParams.get("client_id"), "telechir-phase16-gemini");
    assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
    assert.match(
      auth.searchParams.get("code_challenge") ?? "",
      /^[A-Za-z0-9_-]{43}$/u,
    );
    assert.ok((auth.searchParams.get("state") ?? "").length >= 16);
    assert.ok(
      (auth.searchParams.get("scope") ?? "").includes("telechir:devices:read"),
    );
    assert.equal(
      new URL(auth.searchParams.get("redirect_uri") ?? "").origin,
      callbackOrigin,
    );
    console.log(
      "PASS: official Gemini CLI REPL generated its own OAuth PKCE authorization",
    );
    const page = await context.newPage();
    await page.goto(url, { timeout: 22000 });
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
        { timeout: 18000 },
      ),
      page.locator('[name="accept"]').click(),
    ]);
    const returned = new URL(page.url());
    assert.equal(
      returned.searchParams.get("state"),
      auth.searchParams.get("state"),
    );
    assert.ok(returned.searchParams.get("code"));
    for (let i = 0; i < 40 && !existsSync(tokenPath); i++) await sleep(500);
    assert.ok(
      existsSync(tokenPath),
      "Gemini did not store its own OAuth token",
    );
    child.stdin.write("/mcp list\r");
    await sleep(1500);
    console.log("RESULT: KEYCLOAK_GEMINI_REPL_VENDOR_OWNED_OAUTH_LOGIN_PASS");
    console.log(
      "LIMIT: no LLM inference or device tool invocation certified by this gate",
    );
  }
} catch (e) {
  console.error("DIAG: GEMINI_REPL_FAILURE_FLAGS=" + JSON.stringify(flags()));
  throw new Error(
    "Gemini REPL lab failed safe: " +
      String(e.message).replace(/https?:\/\/\S+/gu, "[URL]"),
  );
} finally {
  if (!closed) {
    child.stdin.write("\x03");
    child.kill("SIGTERM");
  }
  await Promise.race([done, sleep(1800)]);
  await context.close();
  await browser.close();
}
