#!/usr/bin/env node
/**
 * Phase 16: official Keycloak real issuer -> production Telechir verifier.
 * Executes a genuine OAuth 2.0 client_credentials grant and consumes the
 * real RFC 8414 metadata and public JWKS over validated/pinned loopback TLS.
 * The D1 query is a deliberate in-process fake: this is NOT a Cloudflare
 * Worker/MCP end-to-end test and does not certify Authorization Code + PKCE.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { decodeJwt, decodeProtectedHeader } from "jose";

const [out, verifierModule] = process.argv.slice(2);
if (!out || !verifierModule || process.argv.length !== 4) {
  throw new Error("Usage: keycloak-real-idp-verify.mjs <private-temp-dir> <bundled-verifier.mjs>");
}
const issuer = "https://127.0.0.1:8844/realms/telechir-phase16";
const resourceUri = "https://127.0.0.1:8988/mcp";
const metadataUrl =
  "https://127.0.0.1:8844/.well-known/oauth-authorization-server/realms/telechir-phase16";
const { JwtAccessTokenVerifier } = await import(pathToFileURL(verifierModule).href);

async function readJson(url, init) {
  const response = await fetch(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json();
  return { status: response.status, body };
}

// Fail closed on metadata substitution, unexpected issuer and non-TLS URLs.
const { status, body: metadata } = await readJson(metadataUrl);
assert.equal(status, 200, "actual Keycloak must expose RFC8414 metadata");
assert.equal(metadata.issuer, issuer);
assert.ok(metadata.jwks_uri?.startsWith("https://127.0.0.1:8844/"));
assert.ok(metadata.authorization_endpoint?.startsWith("https://127.0.0.1:8844/"));
assert.ok(metadata.token_endpoint?.startsWith("https://127.0.0.1:8844/"));
assert.ok(metadata.code_challenge_methods_supported?.includes("S256"));
const { status: jwksStatus, body: jwks } = await readJson(metadata.jwks_uri);
assert.equal(jwksStatus, 200);
assert.ok(Array.isArray(jwks.keys) && jwks.keys.length > 0);
for (const key of jwks.keys) {
  assert.equal(key.kty, "RSA", "Keycloak fixture must issue RS256 keys");
  assert.equal(key.d, undefined, "Keycloak JWKS must publish only public keys");
}
console.log("PASS: actual Keycloak RFC8414 discovery, HTTPS endpoints and public JWKS");

async function grant(clientId) {
  const secret = readFileSync(join(out, clientId + ".secret"), "utf8").trim();
  assert.ok(secret.length >= 32);
  const { status: code, body } = await readJson(metadata.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: secret,
    }),
  });
  assert.equal(code, 200, "Keycloak OAuth client credentials grant must succeed");
  assert.equal(body.token_type?.toLowerCase(), "bearer");
  assert.equal(typeof body.access_token, "string");
  assert.ok(body.expires_in > 0);
  return body.access_token;
}

const token = await grant("telechir-phase16-service");
const claims = decodeJwt(token);
const jwtHeader = decodeProtectedHeader(token);
assert.equal(claims.iss, issuer);
assert.equal(jwtHeader.alg, "RS256");
assert.ok(
  typeof claims.aud === "string"
    ? claims.aud === resourceUri
    : Array.isArray(claims.aud) && claims.aud.includes(resourceUri),
  "Keycloak must mint a resource-bound audience claim",
);
assert.ok(
  typeof claims.scope === "string" &&
  claims.scope.split(/\s+/u).includes("telechir:devices:read"),
  "Keycloak must issue Telechir's least-privilege read scope",
);
assert.equal(typeof claims.sub, "string");
console.log("PASS: actual Keycloak client_credentials grant issued signed resource-bound read JWT");

// This D1 adapter is scoped to subject-link verification, with the precise
// SQL constraint asserted so no test can bypass linked-user disable behavior.
// It is NOT a live D1/Worker test (those are separately covered by CI).
let disabled = false;
const expectedSubjectHash = createHash("sha256")
  .update(claims.sub)
  .digest("base64url");
const linkedUserId = "phase16-keycloak-service-account";
const db = {
  prepare(statement) {
    assert.match(statement, /identity_provider\s*=\s*\?/u);
    assert.match(statement, /provider_subject_hash\s*=\s*\?/u);
    assert.match(statement, /disabled_at\s+IS\s+NULL/u);
    return {
      bind(foundIssuer, subjectHash) {
        return {
          async first() {
            return (
              !disabled &&
              foundIssuer === issuer &&
              subjectHash === expectedSubjectHash
            ) ? { id: linkedUserId } : null;
          },
        };
      },
    };
  },
};
const verifier = new JwtAccessTokenVerifier(db, {
  issuer,
  resourceUri,
  resourceMetadataUrl: "https://127.0.0.1:8988/.well-known/oauth-protected-resource",
  subjectClaim: "sub",
  scopeClaim: "scope",
});

const verified = await verifier.verifyAccessToken(token);
assert.equal(verified.extra.telechir_user_id, linkedUserId);
assert.ok(verified.scopes.includes("telechir:devices:read"));
assert.equal(verified.resource.href, resourceUri);
assert.equal(verified.token, token);
console.log("PASS: Telechir PRODUCTION JwtAccessTokenVerifier validates real Keycloak JWT and linked subject");

async function expectInvalid(bearer, reason) {
  let rejected = false;
  try {
    await verifier.verifyAccessToken(bearer);
  } catch {
    rejected = true;
  }
  assert.ok(rejected, "Telechir production verifier must deny " + reason);
}

const wrongAudienceToken = await grant("telechir-phase16-wrong-audience");
assert.ok(
  ![].concat(decodeJwt(wrongAudienceToken).aud ?? []).includes(resourceUri),
  "Negative fixture must have genuinely wrong aud",
);
await expectInvalid(wrongAudienceToken, "validly signed Keycloak token with wrong audience");
console.log("PASS: production verifier denies real Keycloak JWT with incorrect audience");

const parts = token.split(".");
assert.equal(parts.length, 3);
const last = parts[2].slice(-1);
const mutated = parts[2].slice(0, -1) + (last === "A" ? "B" : "A");
await expectInvalid(parts[0] + "." + parts[1] + "." + mutated, "modified Keycloak signature");
console.log("PASS: production verifier denies JWT with changed signature");

disabled = true;
await expectInvalid(token, "deactivated linked synthetic principal");
console.log("PASS: production verifier denies still-unexpired Keycloak JWT after linked-user disable");
disabled = false;
const reenabled = await verifier.verifyAccessToken(token);
assert.equal(reenabled.extra.telechir_user_id, linkedUserId);
console.log("PASS: synthetic linked user re-enable restores valid Keycloak token verification");

console.log("RESULT: REAL_KEYCLOAK_IDP_PRODUCTION_JWT_VERIFIER_PASS");
console.log("NOTE: genuine IdP/metadata/JWKS/token; in-process D1 adapter; no browser PKCE, LLM client or production endpoint");
