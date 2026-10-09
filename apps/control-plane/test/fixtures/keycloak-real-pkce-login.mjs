#!/usr/bin/env node
// Real Keycloak Authorization Code + S256 PKCE: HTTPS login-form protocol driver.
// CI-only controlled HTTP form submission, NOT a browser/LLM/user-consent E2E.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLocalJWKSet, decodeJwt, jwtVerify } from "jose";

const [temp, issuer] = process.argv.slice(2);
assert.equal(process.argv.length, 4);
assert.equal(issuer, "https://127.0.0.1:9443/realms/telechir-phase16");
const base = new URL(issuer);
const clientId = "telechir-phase16-pkce";
const callback = "http://127.0.0.1:8798/callback";
const resource = "https://127.0.0.1:8988/mcp";
const username = "phase16-user-ci";
const password = "phase16-ci-browser-only-not-a-real-secret";
const out = join(temp, "pkce");
mkdirSync(out, { recursive: false, mode: 0o700 });
const metadata = JSON.parse(readFileSync(join(temp, "oidc.json"), "utf8"));
assert.equal(metadata.issuer, issuer);
assert.equal(
  metadata.authorization_endpoint,
  issuer + "/protocol/openid-connect/auth",
);
assert.equal(
  metadata.token_endpoint,
  issuer + "/protocol/openid-connect/token",
);
assert.ok(metadata.code_challenge_methods_supported.includes("S256"));
const jwks = JSON.parse(readFileSync(join(temp, "jwks.json"), "utf8"));
const verifyKey = createLocalJWKSet(jwks);
function challenge(value) {
  return createHash("sha256").update(value, "ascii").digest("base64url");
}
function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, digest: challenge(verifier) };
}
function safeKeycloakUrl(value) {
  const url = new URL(value);
  assert.equal(url.origin, base.origin, "HTTPS IdP origin changed");
  assert.ok(
    url.pathname.startsWith(base.pathname + "/"),
    "IdP realm path changed",
  );
  assert.equal(url.protocol, "https:");
  return url;
}
function setCookies(headers, jar) {
  for (const entry of headers.getSetCookie()) {
    const cookie = entry.split(";", 1)[0];
    const pos = cookie.indexOf("=");
    if (pos > 0) jar.set(cookie.slice(0, pos), cookie.slice(pos + 1));
  }
}
async function request(target, jar, options = {}) {
  const url = safeKeycloakUrl(target);
  const headers = new Headers(options.headers ?? {});
  if (jar.size) {
    headers.set(
      "cookie",
      [...jar].map(([name, value]) => name + "=" + value).join("; "),
    );
  }
  const response = await fetch(url, {
    method: options.method ?? "GET",
    body: options.body,
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(12_000),
  });
  setCookies(response.headers, jar);
  return response;
}
function htmlAttr(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&#38;", "&")
    .replaceAll("&quot;", '"');
}
function loginAction(html) {
  const form = html.match(/<form\b[^>]*\bid=["']kc-form-login["'][^>]*>/iu);
  assert.ok(form, "expected genuine Keycloak login form");
  const action = form[0].match(/\baction=["']([^"']+)["']/iu);
  assert.ok(action, "Keycloak login action missing");
  const url = safeKeycloakUrl(htmlAttr(action[1]));
  assert.ok(
    url.pathname.includes("/login-actions/authenticate"),
    "not a Keycloak login action",
  );
  return url;
}
function validCallback(location, expectedState) {
  const url = new URL(location);
  assert.equal(url.origin + url.pathname, callback, "redirect URI mismatch");
  assert.equal(
    url.searchParams.get("state"),
    expectedState,
    "OAuth state mismatch",
  );
  const code = url.searchParams.get("code");
  assert.ok(code && code.length > 16, "authorization code missing");
  assert.equal(url.searchParams.get("error"), null, "authorization error");
  return code;
}
function authUrl({
  verifierPair = pkce(),
  challengeMethod = "S256",
  codeChallenge = verifierPair.digest,
} = {}) {
  const state = randomBytes(24).toString("base64url");
  const url = new URL(metadata.authorization_endpoint);
  for (const [name, value] of Object.entries({
    response_type: "code",
    client_id: clientId,
    redirect_uri: callback,
    scope: "openid",
    state,
    nonce: randomBytes(24).toString("base64url"),
    prompt: "login",
    code_challenge: codeChallenge,
    code_challenge_method: challengeMethod,
  })) {
    if (value != null) url.searchParams.set(name, value);
  }
  return { url, state, pair: verifierPair };
}
async function authorize(options = {}) {
  const { url: first, state, pair } = authUrl(options);
  let next = first;
  let method = "GET";
  let body;
  const jar = new Map();
  let loggedIn = false;
  for (let count = 0; count < 12; count++) {
    const response = await request(
      next,
      jar,
      method === "POST"
        ? {
            method,
            body,
            headers: { "content-type": "application/x-www-form-urlencoded" },
          }
        : {},
    );
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      assert.ok(location, "redirect lacks location");
      const target = new URL(location, next);
      await response.body?.cancel();
      if (target.origin + target.pathname === callback) {
        return { location: target.href, state, pair, loggedIn };
      }
      next = safeKeycloakUrl(target.href);
      method = "GET";
      body = undefined;
      continue;
    }
    if (response.status !== 200) {
      return {
        errorStatus: response.status,
        errorBody: (await response.text()).slice(0, 250),
        state,
      };
    }
    const html = await response.text();
    if (loggedIn) {
      // Do not print login HTML or cookies: classify structural error signals
      // only. They contain no user credentials or authentication codes.
      const errorPanel =
        html.includes('id="input-error"') ||
        html.includes('id="kc-error-message"') ||
        html.includes('class="alert-error"');
      const formKind = html.includes('id="kc-form-login"')
        ? "LOGIN_REPROMPT"
        : html.includes('kc-update-profile-form')
          ? "UPDATE_PROFILE"
          : html.includes('kc-terms-text')
            ? "TERMS"
            : "OTHER_HTML";
      const formCount = html.split("<form").length - 1;
      // Report only structural flags/counts; no HTML, cookie values or codes.
      throw new Error(
        "Keycloak login did not advance; formKind=" +
          formKind +
          "; errorPanel=" +
          errorPanel +
          "; forms=" +
          formCount +
          "; sessionCookies=" +
          jar.size,
      );
    }
    next = loginAction(html);
    loggedIn = true;
    method = "POST";
    body = new URLSearchParams({ username, password, credentialId: "" });
  }
  throw new Error("Keycloak login exceeded bounded redirects");
}
async function redeem(code, verifier, changes = {}) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: callback,
    client_id: clientId,
    code_verifier: verifier,
    ...changes,
  });
  return request(metadata.token_endpoint, new Map(), {
    method: "POST",
    body,
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
}
async function denied(response, context) {
  assert.equal(response.status, 400, context);
  const result = await response.json();
  assert.ok(
    ["invalid_grant", "invalid_request", "invalid_client"].includes(
      result.error,
    ),
    context,
  );
}
function assertNoCode(flow, label) {
  if (!flow.location) {
    assert.ok(flow.errorStatus && flow.errorStatus >= 400, label);
    return;
  }
  const url = new URL(flow.location);
  assert.equal(url.searchParams.has("code"), false, label);
  assert.ok(url.searchParams.get("error"), label + " must carry OAuth error");
}
console.log(
  "PASS: real Keycloak OIDC metadata advertises S256 and pinned endpoints",
);
for (const options of [
  { codeChallenge: null },
  { challengeMethod: "plain", codeChallenge: pkce().verifier },
]) {
  const flow = await authorize(options);
  assertNoCode(flow, "Keycloak must enforce PKCE S256");
}
console.log(
  "PASS: genuine Keycloak public client rejects missing or downgraded PKCE",
);
const invalidPair = await authorize();
assert.equal(
  invalidPair.loggedIn,
  true,
  "real Keycloak login form must authenticate",
);
const invalidCode = validCallback(invalidPair.location, invalidPair.state);
await denied(await redeem(invalidCode, pkce().verifier), "wrong S256 verifier");
console.log(
  "PASS: real Keycloak rejects wrong code_verifier at token endpoint",
);

const redirectMismatch = await authorize();
const codeRedirect = validCallback(
  redirectMismatch.location,
  redirectMismatch.state,
);
await denied(
  await redeem(codeRedirect, redirectMismatch.pair.verifier, {
    redirect_uri: "http://127.0.0.1:8798/other",
  }),
  "wrong redirect URI",
);
console.log(
  "PASS: real Keycloak rejects code exchange for a different redirect URI",
);

const good = await authorize();
assert.equal(good.loggedIn, true, "genuine login form not completed");
const code = validCallback(good.location, good.state);
const wrongState = new URL(good.location);
wrongState.searchParams.set("state", randomBytes(24).toString("base64url"));
assert.throws(
  () => validCallback(wrongState.href, good.state),
  /state mismatch/u,
);
console.log(
  "PASS: OAuth test client refuses callback state substitution before token exchange",
);
const success = await redeem(code, good.pair.verifier);
assert.equal(
  success.status,
  200,
  "Keycloak authorization-code exchange must succeed",
);
const issued = await success.json();
assert.equal(issued.token_type.toLowerCase(), "bearer");
assert.equal(typeof issued.access_token, "string");
const verified = await jwtVerify(issued.access_token, verifyKey, {
  issuer,
  audience: resource,
  algorithms: ["RS256"],
});
assert.equal(verified.payload.azp, clientId);
assert.equal(verified.payload.preferred_username, username);
assert.equal(verified.payload.telechir_scope_fixture, "telechir:devices:read");
assert.ok(
  typeof verified.payload.sub === "string" && verified.payload.sub.length > 0,
);
const service = JSON.parse(readFileSync(join(temp, "token.json"), "utf8"));
assert.notEqual(verified.payload.sub, decodeJwt(service.access_token).sub);
await assert.rejects(() =>
  jwtVerify(issued.access_token, verifyKey, {
    issuer,
    audience: "https://127.0.0.1:8988/not-mcp",
    algorithms: ["RS256"],
  }),
);
await denied(
  await redeem(code, good.pair.verifier),
  "authorization code replay",
);
console.log(
  "PASS: real Keycloak issues user RS256 JWT with exact MCP audience, read-only scope and separate human sub",
);
console.log(
  "PASS: genuine Keycloak authorization code is single use after successful exchange",
);

// Prepare real local D1 link, reusing the prior CI worker's foreign device id.
const linked = randomUUID();
const deviceId = randomUUID();
const otherDevice = readFileSync(join(temp, "worker-device-id"), "utf8");
const hash = createHash("sha256")
  .update(verified.payload.sub)
  .digest("base64url");
const now = new Date().toISOString();
const seed =
  [
    "INSERT INTO users (id, identity_provider, provider_subject_hash, display_name, created_at, disabled_at) VALUES ('" +
      linked +
      "', '" +
      issuer +
      "', '" +
      hash +
      "', 'Keycloak human PKCE CI', '" +
      now +
      "', NULL);",
    "INSERT INTO devices (id, user_id, display_name, os, arch, agent_version, status_hint, last_seen_at, created_at, revoked_at) VALUES ('" +
      deviceId +
      "', '" +
      linked +
      "', 'Human PKCE CI Device', 'linux', 'x86_64', '0.1.0', 'offline', NULL, '" +
      now +
      "', NULL);",
  ].join("\n") + "\n";
writeFileSync(join(out, "seed.sql"), seed, { mode: 0o600 });
writeFileSync(
  join(out, "disable.sql"),
  "UPDATE users SET disabled_at = CURRENT_TIMESTAMP WHERE id = '" +
    linked +
    "';\n",
  { mode: 0o600 },
);
writeFileSync(
  join(out, "token.json"),
  JSON.stringify({ access_token: issued.access_token }),
  { mode: 0o600 },
);
writeFileSync(join(out, "worker-device-id"), deviceId, { mode: 0o600 });
writeFileSync(join(out, "worker-foreign-device-id"), otherDevice, {
  mode: 0o600,
});
const segments = issued.access_token.split(".");
assert.equal(segments.length, 3);
const altered = segments[2][0] === "A" ? "B" : "A";
writeFileSync(
  join(out, "worker-tampered.token"),
  segments[0] + "." + segments[1] + "." + altered + segments[2].slice(1),
  { mode: 0o600 },
);
console.log("RESULT: KEYCLOAK_REAL_AUTHORIZATION_CODE_PKCE_S256_PASS");
console.log(
  "NOTE: scripted HTTPS login form, NOT graphical browser/consent or live commercial user; real Keycloak JWT available only in private CI temp.",
);
