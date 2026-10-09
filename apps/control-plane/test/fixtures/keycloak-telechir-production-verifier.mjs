#!/usr/bin/env node
// Genuine Keycloak JWT -> unchanged Telechir production verifier.
// The identity database is intentionally an in-process adapter, NOT D1/Worker.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";

const [metadataFile, tokenFile, issuer, verifierBundle] = process.argv.slice(2);
const resourceUri = "https://127.0.0.1:8988/mcp";
if (
  process.argv.length !== 6 ||
  !metadataFile ||
  !tokenFile ||
  !verifierBundle ||
  issuer !== "https://127.0.0.1:9443/realms/telechir-phase16"
) {
  throw new Error(
    "Expected Keycloak temp metadata/token, pinned issuer and production verifier bundle",
  );
}
const metadata = JSON.parse(readFileSync(metadataFile, "utf8"));
const issued = JSON.parse(readFileSync(tokenFile, "utf8"));
const token = issued.access_token;
assert.equal(metadata.issuer, issuer);
assert.equal(typeof token, "string");
const claims = decodeJwt(token);
const header = decodeProtectedHeader(token);
assert.equal(header.alg, "RS256");
assert.equal(typeof header.kid, "string");
assert.equal(claims.iss, issuer);
assert.equal(claims.azp, "telechir-phase16-ci");
assert.equal(claims.telechir_scope_fixture, "telechir:devices:read");
assert.ok(typeof claims.sub === "string" && claims.sub.length > 0);
assert.ok([].concat(claims.aud ?? []).includes(resourceUri));
const { JwtAccessTokenVerifier } = await import(
  pathToFileURL(verifierBundle).href
);
assert.equal(typeof JwtAccessTokenVerifier, "function");

const linkedHash = createHash("sha256").update(claims.sub).digest("base64url");
const userId = "keycloak-ci-linked-user";
let linked = true;
let disabled = false;
let queries = 0;
const db = {
  prepare(sql) {
    assert.match(sql, /identity_provider\s*=\s*\?/u);
    assert.match(sql, /provider_subject_hash\s*=\s*\?/u);
    assert.match(sql, /disabled_at\s+IS\s+NULL/u);
    return {
      bind(provider, hash) {
        return {
          async first() {
            queries += 1;
            return linked &&
              !disabled &&
              provider === issuer &&
              hash === linkedHash
              ? { id: userId }
              : null;
          },
        };
      },
    };
  },
};
const config = {
  issuer,
  resourceUri,
  resourceMetadataUrl:
    "https://127.0.0.1:8988/.well-known/oauth-protected-resource",
  subjectClaim: "sub",
  scopeClaim: "telechir_scope_fixture",
};
const verifier = new JwtAccessTokenVerifier(db, config);

const allowed = await verifier.verifyAccessToken(token);
assert.equal(allowed.extra.telechir_user_id, userId);
assert.equal(allowed.clientId, "telechir-phase16-ci");
assert.equal(allowed.resource.href, resourceUri);
assert.deepEqual(allowed.scopes, ["telechir:devices:read"]);
assert.ok(!allowed.scopes.includes("telechir:files:write"));
assert.equal(allowed.token, token);
assert.ok(queries === 1);
console.log(
  "PASS: Telechir production JwtAccessTokenVerifier accepts actual Keycloak RS256 JWT with linked subject and read-only scope",
);

async function rejected(jwt, target, reason, shouldQueryDb = false) {
  const previous = queries;
  await assert.rejects(
    () => target.verifyAccessToken(jwt),
    (error) => {
      assert.ok(
        OAuthError.isInstance(error),
        "auth failures must be classified, not generic transport errors: " +
          reason,
      );
      assert.equal(error.code, OAuthErrorCode.InvalidToken);
      return true;
    },
    reason,
  );
  if (!shouldQueryDb)
    assert.equal(
      queries,
      previous,
      "invalid cryptographic JWT must fail before identity lookup: " + reason,
    );
}

// Use a genuinely Keycloak-signed token against an incorrect expected MCP audience.
const wrongAudience = new JwtAccessTokenVerifier(db, {
  ...config,
  resourceUri: "https://127.0.0.1:8988/not-mcp",
});
await rejected(token, wrongAudience, "wrong MCP audience");
console.log(
  "PASS: production verifier rejects Keycloak token for another resource",
);

const segments = token.split(".");
assert.equal(segments.length, 3);
const first = segments[2][0];
const corruptedSignature =
  segments[0] +
  "." +
  segments[1] +
  "." +
  (first === "A" ? "B" : "A") +
  segments[2].slice(1);
await rejected(corruptedSignature, verifier, "tampered RSA signature");
console.log("PASS: production verifier rejects tampered Keycloak signature");

linked = false;
await rejected(token, verifier, "unlinked IdP subject", true);
linked = true;
disabled = true;
await rejected(token, verifier, "disabled linked user", true);
console.log(
  "PASS: production verifier rejects unlinked and disabled synthetic subjects",
);

disabled = false;
const again = await verifier.verifyAccessToken(token);
assert.equal(again.extra.telechir_user_id, userId);
console.log("RESULT: KEYCLOAK_TELECHIR_PRODUCTION_VERIFIER_PASS");
console.log(
  "NOTE: real Keycloak token and production verifier; identity DB adapter is not live D1; not MCP Worker, PKCE, human login or LLM E2E",
);
