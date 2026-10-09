#!/usr/bin/env node
// Official Keycloak-issued service-account token, using LIVE OIDC discovery/JWKS
// fetched over verified HTTPS by the shell harness. No signing fixtures.
import { readFileSync } from "node:fs";
import { jwtVerify, createLocalJWKSet, decodeProtectedHeader } from "jose";

const [metadataFile, jwksFile, tokenFile, issuer] = process.argv.slice(2);
if (
  !metadataFile ||
  !jwksFile ||
  !tokenFile ||
  issuer !== "https://127.0.0.1:9443/realms/telechir-phase16"
) {
  throw new Error("Keycloak issuer and temporary input files required");
}
const meta = JSON.parse(readFileSync(metadataFile, "utf8"));
const jwks = JSON.parse(readFileSync(jwksFile, "utf8"));
const issued = JSON.parse(readFileSync(tokenFile, "utf8"));
const audience = "https://127.0.0.1:8988/mcp";
if (
  meta.issuer !== issuer ||
  meta.jwks_uri !== issuer + "/protocol/openid-connect/certs" ||
  !Array.isArray(jwks.keys) ||
  !jwks.keys.length ||
  typeof issued.access_token !== "string"
) {
  throw new Error("Live Keycloak metadata/JWKS/token mismatch");
}
const header = decodeProtectedHeader(issued.access_token);
if (header.alg !== "RS256" || typeof header.kid !== "string") {
  throw new Error("Keycloak issued unexpected JWT signing algorithm");
}
const { payload } = await jwtVerify(
  issued.access_token,
  createLocalJWKSet(jwks),
  { issuer, audience, algorithms: ["RS256"] },
);
if (
  !payload.sub ||
  typeof payload.sub !== "string" ||
  payload.azp !== "telechir-phase16-ci" ||
  payload.telechir_scope_fixture !== "telechir:devices:read" ||
  typeof payload.exp !== "number" ||
  payload.exp <= Date.now() / 1000
) {
  throw new Error(
    "Real Keycloak token missing required sub, scope, client or expiry",
  );
}
console.log("PASS: real Keycloak RS256 token verified against live HTTPS JWKS");
console.log(
  "PASS: exact Telechir resource audience, linked subject, scope mapper, expiry and azp",
);
let wrongAudienceDenied = false;
try {
  await jwtVerify(issued.access_token, createLocalJWKSet(jwks), {
    issuer,
    audience: "https://127.0.0.1:8988/not-mcp",
    algorithms: ["RS256"],
  });
} catch {
  wrongAudienceDenied = true;
}
if (!wrongAudienceDenied)
  throw new Error("wrong resource audience not rejected");
console.log("PASS: real Keycloak token fails closed with wrong MCP audience");
console.log("RESULT: KEYCLOAK_LIVE_JWKS_RESOURCE_AUDIENCE_PASS");
