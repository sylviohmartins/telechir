#!/usr/bin/env node
/**
 * Phase 16 CI-only BROWSER gate, not a scripted HTTP login substitute.
 * Real Playwright Chromium drives official Keycloak UI with PKCE and consent.
 * Each browser has a disposable Linux NSS store trusting only a pinned CI CA.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { createLocalJWKSet, decodeJwt, jwtVerify } from "jose";

const [temp, issuer] = process.argv.slice(2);
assert.equal(process.argv.length, 4);
assert.equal(issuer, "https://127.0.0.1:9443/realms/telechir-phase16");
assert.equal(process.env.GITHUB_ACTIONS, "true");
const client = "telechir-phase16-browser";
const callback = "http://127.0.0.1:8798/callback";
const resource = "https://127.0.0.1:8988/mcp";
const username = "phase16-user-ci";
const password = "phase16-ci-browser-only-not-a-real-secret";
const cert = join(temp, "root.crt");
const otherCert = join(temp, "worker-root.crt");
const dir = join(temp, "browser-pkce");
mkdirSync(dir, { recursive: true, mode: 0o700 });
const metadata = JSON.parse(readFileSync(join(temp, "oidc.json"), "utf8"));
const jwks = JSON.parse(readFileSync(join(temp, "jwks.json"), "utf8"));
assert.equal(metadata.issuer, issuer);
assert.equal(metadata.authorization_endpoint, issuer + "/protocol/openid-connect/auth");
assert.equal(metadata.token_endpoint, issuer + "/protocol/openid-connect/token");
assert.ok(metadata.code_challenge_methods_supported.includes("S256"));
const pinnedKey = createLocalJWKSet(jwks);

function trustStore(home, ca) {
  for (const relative of [".pki/nssdb", ".local/share/pki/nssdb"]) {
    const store = join(home, relative);
    mkdirSync(store, { recursive: true, mode: 0o700 });
    execFileSync("certutil", ["-N", "--empty-password", "-d", "sql:" + store], { stdio: "pipe" });
    execFileSync("certutil", ["-A", "-d", "sql:" + store, "-n", "telechir-ephemeral-ci-ca", "-t", "C,,", "-i", ca], { stdio: "pipe" });
    const listed = execFileSync("certutil", ["-L", "-d", "sql:" + store], { encoding: "utf8" });
    assert.match(listed, /telechir-ephemeral-ci-ca/u);
  }
}
async function browser(home, ca) {
  trustStore(home, ca);
  // No ignoreHTTPSErrors or --ignore-certificate-errors, ever.
  return chromium.launch({
    headless: true,
    env: { ...process.env, HOME: home },
    args: ["--no-first-run", "--no-default-browser-check"],
  });
}
const wrongBrowser = await browser(join(dir, "untrusted-home"), otherCert);
try {
  const badContext = await wrongBrowser.newContext({ ignoreHTTPSErrors: false });
  try {
    await assert.rejects(
      badContext.newPage().then((page) => page.goto(issuer + "/.well-known/openid-configuration", { timeout: 12000 })),
      /ERR_CERT_AUTHORITY_INVALID|ERR_CERT_INVALID/u,
      "Chromium must reject Keycloak when the only trusted CA belongs to Worker",
    );
  } finally {
    await badContext.close();
  }
} finally {
  await wrongBrowser.close();
}
console.log("PASS: real Chromium rejects Keycloak issuer under unrelated CI CA");

const chrome = await browser(join(dir, "trusted-home"), cert);
async function context() {
  const ctx = await chrome.newContext({
    ignoreHTTPSErrors: false,
    serviceWorkers: "block",
    acceptDownloads: false,
    permissions: [],
  });
  await ctx.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.href.startsWith(callback + "?") && url.origin + url.pathname === callback) {
      return route.fulfill({ status: 200, contentType: "text/html", body: "<html><body>CI-only OAuth callback received</body></html>" });
    }
    if (url.origin === new URL(issuer).origin &&
        url.pathname.startsWith(new URL(issuer).pathname + "/")) {
      return route.continue();
    }
    return route.abort("blockedbyclient");
  });
  return ctx;
}
function pair() {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier, "ascii").digest("base64url"),
  };
}
function authorizationUrl(pkce, state) {
  const url = new URL(metadata.authorization_endpoint);
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: client,
    redirect_uri: callback,
    scope: "openid",
    state,
    nonce: randomBytes(24).toString("base64url"),
    prompt: "login",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
  })) url.searchParams.set(key, value);
  return url.href;
}
function validatedCallback(raw, state) {
  const url = new URL(raw);
  assert.equal(url.origin + url.pathname, callback);
  assert.equal(url.searchParams.get("state"), state, "OAuth callback state mismatch");
  return url;
}
async function loginToConsent() {
  const ctx = await context();
  const page = await ctx.newPage();
  const pkce = pair();
  const state = randomBytes(24).toString("base64url");
  await page.goto(authorizationUrl(pkce, state), { timeout: 20000 });
  assert.equal(new URL(page.url()).origin, new URL(issuer).origin);
  await page.locator("#username").fill(username);
  await page.locator("#password").fill(password);
  await page.locator("#kc-login").click();
  await page.locator('[name="accept"]').waitFor({ state: "visible", timeout: 12000 });
  assert.equal(new URL(page.url()).origin, new URL(issuer).origin);
  assert.equal(await page.locator('[name="cancel"]').count(), 1);
  return { ctx, page, pkce, state };
}
async function consent(decision) {
  const flow = await loginToConsent();
  const { ctx, page, pkce, state } = flow;
  try {
    const control = decision === "accept" ? '[name="accept"]' : '[name="cancel"]';
    await Promise.all([
      page.waitForURL((url) => url.origin + url.pathname === callback, { timeout: 15000 }),
      page.locator(control).click(),
    ]);
    const uri = validatedCallback(page.url(), state);
    if (decision === "cancel") {
      assert.equal(uri.searchParams.get("error"), "access_denied");
      assert.equal(uri.searchParams.has("code"), false);
    } else {
      assert.equal(uri.searchParams.get("error"), null);
      assert.ok(uri.searchParams.get("code")?.length > 16);
    }
    return { state, pkce, uri };
  } finally {
    await ctx.close();
  }
}
async function redeem(code, verifier, override = {}) {
  return fetch(metadata.token_endpoint, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client,
      redirect_uri: callback,
      code,
      code_verifier: verifier,
      ...override,
    }),
    signal: AbortSignal.timeout(12000),
  });
}
async function denied(response, why) {
  assert.equal(response.status, 400, why);
  const result = await response.json();
  assert.equal(result.error, "invalid_grant", why);
}
try {
  const declined = await consent("cancel");
  assert.equal(declined.uri.searchParams.has("code"), false);
  console.log("PASS: real Chromium Keycloak consent cancel returns access_denied without code");

  const accepted = await consent("accept");
  const fake = new URL(accepted.uri);
  fake.searchParams.set("state", randomBytes(24).toString("base64url"));
  assert.throws(() => validatedCallback(fake.href, accepted.state), /state mismatch/u);
  console.log("PASS: browser OAuth client refuses substituted state before token exchange");

  const goodCode = accepted.uri.searchParams.get("code");
  const response = await redeem(goodCode, accepted.pkce.verifier);
  assert.equal(response.status, 200, "real Chromium-issued authorization code exchange must succeed");
  const issued = await response.json();
  assert.equal(typeof issued.access_token, "string");
  const signed = await jwtVerify(issued.access_token, pinnedKey, {
    issuer, audience: resource, algorithms: ["RS256"],
  });
  assert.equal(signed.payload.azp, client);
  assert.equal(signed.payload.preferred_username, username);
  assert.equal(signed.payload.telechir_scope_fixture, "telechir:devices:read");
  assert.ok(typeof signed.payload.sub === "string" && signed.payload.sub.length > 0);
  const service = JSON.parse(readFileSync(join(temp, "token.json"), "utf8"));
  assert.notEqual(signed.payload.sub, decodeJwt(service.access_token).sub);
  await denied(await redeem(goodCode, accepted.pkce.verifier), "used authorization code replay");
  console.log("PASS: Chromium-approved Keycloak S256 code exchanges for audience-bound human JWT and forbids replay");

  // Already-consented sessions may bypass a repeat consent page. A new client
  // context still needs a real browser login. Test invalid verifier before
  // any exchange without asserting the consent screen appears a second time.
  async function anotherCode() {
    const ctx = await context();
    const page = await ctx.newPage();
    const pkce = pair();
    const state = randomBytes(24).toString("base64url");
    try {
      await page.goto(authorizationUrl(pkce, state), { timeout: 20000 });
      await page.locator("#username").fill(username);
      await page.locator("#password").fill(password);
      await Promise.all([
        page.waitForURL((url) => url.origin + url.pathname === callback, { timeout: 15000 }),
        page.locator("#kc-login").click(),
      ]);
      const uri = validatedCallback(page.url(), state);
      assert.ok(uri.searchParams.get("code"));
      return { code: uri.searchParams.get("code"), pkce };
    } finally {
      await ctx.close();
    }
  }
  const wrongVerifier = await anotherCode();
  await denied(await redeem(wrongVerifier.code, pair().verifier), "wrong PKCE verifier");
  console.log("PASS: Chromium login code rejects an unrelated S256 verifier");

  const expiring = await anotherCode();
  await new Promise((resolve) => setTimeout(resolve, 15000));
  await denied(await redeem(expiring.code, expiring.pkce.verifier), "expired authorization code");
  console.log("PASS: Keycloak refuses expired browser authorization code");

  const linked = randomUUID();
  const device = randomUUID();
  const foreign = readFileSync(join(temp, "worker-device-id"), "utf8");
  const hash = createHash("sha256").update(signed.payload.sub).digest("base64url");
  const now = new Date().toISOString();
  const seed = [
    "INSERT INTO users (id, identity_provider, provider_subject_hash, display_name, created_at, disabled_at) VALUES ('" +
      linked + "', '" + issuer + "', '" + hash + "', 'Chromium PKCE CI user', '" + now + "', NULL);",
    "INSERT INTO devices (id, user_id, display_name, os, arch, agent_version, status_hint, last_seen_at, created_at, revoked_at) VALUES ('" +
      device + "', '" + linked + "', 'Chromium PKCE CI Device', 'linux', 'x86_64', '0.1.0', 'offline', NULL, '" + now + "', NULL);",
  ].join("\n") + "\n";
  writeFileSync(join(dir, "seed.sql"), seed, { mode: 0o600 });
  writeFileSync(join(dir, "disable.sql"), "UPDATE users SET disabled_at = CURRENT_TIMESTAMP WHERE id = '" + linked + "';\n", { mode: 0o600 });
  writeFileSync(join(dir, "token.json"), JSON.stringify({ access_token: issued.access_token }), { mode: 0o600 });
  writeFileSync(join(dir, "worker-device-id"), device, { mode: 0o600 });
  writeFileSync(join(dir, "worker-foreign-device-id"), foreign, { mode: 0o600 });
  const chunks = issued.access_token.split(".");
  assert.equal(chunks.length, 3);
  writeFileSync(join(dir, "worker-tampered.token"),
    chunks[0] + "." + chunks[1] + "." + (chunks[2][0] === "A" ? "B" : "A") + chunks[2].slice(1),
    { mode: 0o600 });
  console.log("RESULT: KEYCLOAK_CHROMIUM_BROWSER_PKCE_CONSENT_PASS");
  console.log("NOTE: real headless Chromium, ephemeral per-process NSS TLS trust, genuine consent UI, no external user or production tenant");
} finally {
  await chrome.close();
}
