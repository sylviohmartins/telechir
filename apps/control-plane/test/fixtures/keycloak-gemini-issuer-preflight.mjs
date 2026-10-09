#!/usr/bin/env node
/**
 * Gemini CLI RFC9207 preflight, using evidence from a GENUINE Keycloak
 * authorization response in real Chrome. Never handles code, token, state.
 * This does not pretend to execute the Gemini /mcp auth UI.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir, issuer, resource] = process.argv.slice(2);
assert.equal(process.argv.length, 5);
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(issuer, "https://127.0.0.1:9443/realms/telechir-phase16");
assert.equal(resource, "https://127.0.0.1:8988/mcp");
const evidence = JSON.parse(
  readFileSync(
    join(dir, "browser-pkce", "gemini-issuer-preflight.json"),
    "utf8",
  ),
);
const metadata = JSON.parse(readFileSync(join(dir, "oidc.json"), "utf8"));
assert.equal(metadata.issuer, issuer);
assert.equal(evidence.keycloakBrowserCallbackObserved, true);
assert.equal(typeof evidence.authorizationResponseIssuerPresent, "boolean");
assert.equal(typeof evidence.issuerMatchesExpected, "boolean");
const advertised = evidence.authorizationResponseIssuerAdvertised;
assert.ok(advertised == null || typeof advertised === "boolean");
if (evidence.authorizationResponseIssuerPresent) {
  assert.equal(evidence.issuerMatchesExpected, true);
}
if (advertised === true) {
  assert.equal(evidence.authorizationResponseIssuerPresent, true);
}
const requiresIssCompatibilityOverride =
  !evidence.authorizationResponseIssuerPresent;
function geminiIssuerGuard({ iss, expected, allowsMissing }) {
  // Contract of CI fixture: matching iss succeeds; substituted iss is NEVER
  // accepted, even if the IdP omits the iss field in an older flow.
  if (iss == null) return allowsMissing;
  return iss === expected;
}
assert.equal(
  geminiIssuerGuard({
    iss: "https://malicious.example.invalid/realms/other",
    expected: issuer,
    allowsMissing: requiresIssCompatibilityOverride,
  }),
  false,
);
assert.equal(
  geminiIssuerGuard({
    iss: issuer,
    expected: issuer,
    allowsMissing: requiresIssCompatibilityOverride,
  }),
  true,
);
assert.equal(
  geminiIssuerGuard({
    iss: null,
    expected: issuer,
    allowsMissing: requiresIssCompatibilityOverride,
  }),
  requiresIssCompatibilityOverride,
);
const config = {
  mcpServers: {
    "telechir-gemini-phase16-ci": {
      httpUrl: resource,
      timeout: 12000,
      trust: false,
      oauth: {
        enabled: true,
        clientId: "telechir-phase16-gemini",
        issuer,
        authorizationUrl: metadata.authorization_endpoint,
        tokenUrl: metadata.token_endpoint,
        redirectUri: "http://127.0.0.1:8777/oauth/callback",
        scopes: ["telechir:devices:read"],
        ...(requiresIssCompatibilityOverride
          ? { authorizationResponseIssParameterSupported: false }
          : {}),
      },
    },
  },
};
// Config contains public endpoints + public client ID ONLY. Never credentials,
// Bearer token, refresh token or storage from a real Gemini installation.
writeFileSync(
  join(dir, "browser-pkce", "gemini-oauth-settings-ci.json"),
  JSON.stringify(config, null, 2) + "\n",
  { mode: 0o600 },
);
assert.equal(config.mcpServers["telechir-gemini-phase16-ci"].trust, false);
assert.deepEqual(config.mcpServers["telechir-gemini-phase16-ci"].oauth.scopes, [
  "telechir:devices:read",
]);
console.log(
  "PASS: real Keycloak issuer response classified against Gemini CLI RFC9207 rules and exact read-only OAuth client",
);
console.log("RESULT: KEYCLOAK_GEMINI_CLI_RFC9207_OAUTH_PREFLIGHT_PASS");
console.log(
  "NOTE: vendor OAuth compatibility preflight only; Gemini CLI /mcp auth, browser session, login callback and MCP tool call NOT certified here",
);
