#!/usr/bin/env node
/**
 * Phase 16: executable, loopback-only OAuth Authorization Code + PKCE S256
 * integration fixture. This is a SYNTHETIC issuer, not a commercial IdP.
 *
 * One process contains a real Node HTTPS authorization server and a separate
 * HTTP OAuth test client. All exchanges traverse verified HTTPS sockets.
 * RSA signing keys and authorization codes exist only in memory.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from "jose";

const CERT = process.argv[2];
const KEY = process.argv[3];
if (process.argv.length !== 4 || !CERT || !KEY) {
  throw new Error("Usage: oauth-pkce-https-smoke.mjs <public-cert> <ephemeral-key>");
}
const resource = "https://127.0.0.1:8988/mcp";
const clientId = "phase16-pkce-fixture-client";
const redirectUri = "http://127.0.0.1:8798/callback";
const subject = "phase16-pkce-synthetic-subject";
const scope = "telechir:devices:read";
const keyId = "phase16-pkce-ephemeral";
const codes = new Map();
const pair = await generateKeyPair("RS256");
const publicJwk = await exportJWK(pair.publicKey);
publicJwk.kid = keyId;
publicJwk.alg = "RS256";
publicJwk.use = "sig";
let issuer = "";
const execFileAsync = promisify(execFile);

const sha256Url = (value) =>
  createHash("sha256").update(value, "ascii").digest("base64url");
const bad = (res, error, status = 400) =>
  sendJson(res, status, { error });
function sendJson(res, status, obj) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(obj));
}
function validateCodeVerifier(value) {
  return typeof value === "string" && /^[A-Za-z0-9._~-]{43,128}$/.test(value);
}
function issueCode(params, res) {
  const challenge = params.get("code_challenge");
  if (
    params.get("response_type") !== "code" ||
    params.get("client_id") !== clientId ||
    params.get("redirect_uri") !== redirectUri ||
    params.get("resource") !== resource ||
    params.get("scope") !== scope ||
    params.get("code_challenge_method") !== "S256" ||
    !challenge ||
    !/^[A-Za-z0-9_-]{43}$/.test(challenge) ||
    !params.get("state")
  ) {
    return bad(res, "invalid_request");
  }
  const code = randomBytes(32).toString("base64url");
  codes.set(code, {
    challenge,
    clientId,
    redirectUri,
    resource,
    expires: Date.now() + 60_000,
  });
  const callback = new URL(redirectUri);
  callback.searchParams.set("code", code);
  callback.searchParams.set("state", params.get("state"));
  res.writeHead(302, {
    location: callback.href,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  res.end();
}
async function exchangeCode(req, res) {
  if (!req.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")) {
    return bad(res, "invalid_request");
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.byteLength;
    if (length > 4096) return bad(res, "invalid_request", 413);
    chunks.push(chunk);
  }
  const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  const code = params.get("code");
  const stored = code ? codes.get(code) : undefined;
  // Consume before checking other inputs; wrong verifier cannot be retried.
  if (code) codes.delete(code);
  if (!stored || stored.expires < Date.now()) return bad(res, "invalid_grant");
  const verifier = params.get("code_verifier");
  if (
    params.get("grant_type") !== "authorization_code" ||
    params.get("client_id") !== stored.clientId ||
    params.get("redirect_uri") !== stored.redirectUri ||
    params.get("resource") !== stored.resource ||
    !validateCodeVerifier(verifier)
  ) {
    return bad(res, "invalid_grant");
  }
  const actual = Buffer.from(sha256Url(verifier));
  const expected = Buffer.from(stored.challenge);
  if (
    actual.length !== expected.length ||
    !timingSafeEqual(actual, expected)
  ) {
    return bad(res, "invalid_grant");
  }
  const now = Math.floor(Date.now() / 1000);
  const accessToken = await new SignJWT({
    scope,
    client_id: clientId,
  })
    .setProtectedHeader({ alg: "RS256", kid: keyId })
    .setIssuer(issuer)
    .setAudience(stored.resource)
    .setSubject(subject)
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + 300)
    .sign(pair.privateKey);
  sendJson(res, 200, {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 300,
    scope,
  });
}
const server = createServer(
  { cert: readFileSync(CERT), key: readFileSync(KEY) },
  (req, res) => {
    const url = new URL(req.url ?? "/", issuer);
    if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
      sendJson(res, 200, {
        issuer,
        authorization_endpoint: issuer + "/authorize",
        token_endpoint: issuer + "/token",
        jwks_uri: issuer + "/jwks.json",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"],
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/jwks.json") {
      sendJson(res, 200, { keys: [publicJwk] });
      return;
    }
    if (req.method === "GET" && url.pathname === "/authorize") {
      issueCode(url.searchParams, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/token") {
      exchangeCode(req, res).catch(() => bad(res, "server_error", 500));
      return;
    }
    bad(res, "invalid_request", 404);
  },
);
server.requestTimeout = 8_000;
server.headersTimeout = 10_000;
server.maxRequestsPerSocket = 24;

function pkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: sha256Url(verifier) };
}
async function request(url, init = {}) {
  return fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(7_000),
    ...init,
  });
}
function authorizeUrl(fields = {}) {
  const url = new URL(issuer + "/authorize");
  const pkce = fields.pkce ?? pkcePair();
  const data = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    resource,
    scope,
    state: randomBytes(20).toString("base64url"),
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    ...fields,
  };
  delete data.pkce;
  for (const [key, value] of Object.entries(data)) {
    if (value !== null) url.searchParams.set(key, value);
  }
  return { url, pkce, data };
}
async function authorize(fields = {}) {
  const { url, pkce, data } = authorizeUrl(fields);
  const result = await request(url);
  if (result.status !== 302) return { result, pkce, data };
  const callback = new URL(result.headers.get("location"));
  assert.equal(callback.origin, new URL(redirectUri).origin);
  assert.equal(callback.pathname, "/callback");
  assert.equal(callback.searchParams.get("state"), data.state);
  return { result, pkce, data, code: callback.searchParams.get("code") };
}
async function redeem(code, verifier, fields = {}) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    resource,
    code_verifier: verifier,
    ...fields,
  });
  return request(issuer + "/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}
async function errorIs(response, expected) {
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, expected);
}

try {
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  issuer = "https://127.0.0.1:" + address.port;

  // The first request is made only after the exact expected certificate is
  // pinned and its chain verified; there is no TLS verification bypass.
  const preflightPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../scripts/interop/verify-local-tls.mjs",
  );
  const { stdout } = await execFileAsync(process.execPath, [
    preflightPath, "--cert", CERT, "--host", "127.0.0.1",
    "--port", String(address.port),
  ]);
  const checked = JSON.parse(stdout);
  assert.equal(checked.status, "PASS");
  assert.equal(checked.code, "TLS_PIN_AND_CHAIN_VALIDATED");
  console.log("PASS: OAuth issuer loopback HTTPS certificate pin and chain");

  const metadataResponse = await request(issuer + "/.well-known/oauth-authorization-server");
  assert.equal(metadataResponse.status, 200);
  const metadata = await metadataResponse.json();
  assert.equal(metadata.issuer, issuer);
  assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
  assert.equal(metadata.token_endpoint, issuer + "/token");
  const jwksResponse = await request(metadata.jwks_uri);
  assert.equal(jwksResponse.status, 200);
  const jwks = await jwksResponse.json();
  assert.equal(jwks.keys.length, 1);
  assert.equal(jwks.keys[0].kty, "RSA");
  assert.equal(jwks.keys[0].d, undefined);
  console.log("PASS: OAuth authorization-server metadata and public JWKS over HTTPS");

  for (const fields of [
    { code_challenge_method: "plain" },
    { code_challenge: null },
    { resource: null },
    { resource: "https://evil.example/mcp" },
    { scope: "telechir:files:write" },
    { redirect_uri: "https://evil.example/callback" },
    { client_id: "unregistered-client" },
    { response_type: "token" },
  ]) {
    await errorIs((await authorize(fields)).result, "invalid_request");
  }
  console.log("PASS: PKCE downgrade, missing resource, scope/redirect/client mismatches rejected");

  const wrongVerifier = await authorize();
  assert.equal(wrongVerifier.result.status, 302);
  await errorIs(
    await redeem(wrongVerifier.code, pkcePair().verifier),
    "invalid_grant",
  );
  await errorIs(
    await redeem(wrongVerifier.code, wrongVerifier.pkce.verifier),
    "invalid_grant",
  );
  console.log("PASS: incorrect PKCE verifier invalidates and consumes authorization code");

  for (const modified of [
    { client_id: "other-client" },
    { resource: "https://evil.example/mcp" },
    { redirect_uri: "http://127.0.0.1:8798/other" },
    { resource: "" },
  ]) {
    const { code, pkce, result } = await authorize();
    assert.equal(result.status, 302);
    await errorIs(await redeem(code, pkce.verifier, modified), "invalid_grant");
  }
  console.log("PASS: token exchange binds code to client, redirect and resource");

  const success = await authorize();
  assert.equal(success.result.status, 302);
  const response = await redeem(success.code, success.pkce.verifier);
  assert.equal(response.status, 200);
  const tokens = await response.json();
  assert.equal(tokens.token_type, "Bearer");
  assert.equal(tokens.scope, scope);
  assert.equal(tokens.expires_in, 300);
  assert.equal(tokens.refresh_token, undefined);
  const { importJWK } = await import("jose");
  const publicKey = await importJWK(jwks.keys[0], "RS256");
  const valid = await jwtVerify(tokens.access_token, publicKey, {
    issuer,
    audience: resource,
    algorithms: ["RS256"],
  });
  assert.equal(valid.payload.sub, subject);
  assert.equal(valid.payload.scope, scope);
  assert.equal(valid.payload.client_id, clientId);
  await assert.rejects(
    jwtVerify(tokens.access_token, publicKey, {
      issuer,
      audience: "https://evil.example/mcp",
      algorithms: ["RS256"],
    }),
  );
  await errorIs(
    await redeem(success.code, success.pkce.verifier),
    "invalid_grant",
  );
  console.log("PASS: complete Authorization Code + S256 PKCE, resource-bound RS256 token");
  console.log("PASS: token audience validation and single-use code replay defense");
  console.log("RESULT: ISOLATED_PKCE_HTTPS_PROTOCOL_SMOKE_PASS");
  console.log("NOTE: synthetic IdP; not external IdP, browser consent, refresh or commercial MCP client certification");
} finally {
  codes.clear();
  server.closeAllConnections();
  await new Promise((resolveClose) => server.close(resolveClose));
}
