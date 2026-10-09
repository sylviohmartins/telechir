#!/usr/bin/env node
/**
 * Phase 16: generate an exclusively disposable Keycloak realm import.
 * No credentials, realm fixture secrets, signing material or user identity
 * in git. Keycloak itself generates/holds the actual signing private key.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [out] = process.argv.slice(2);
if (!out || process.argv.length !== 3) {
  throw new Error("Expected isolated Keycloak fixture output directory");
}
const issuer = "https://127.0.0.1:8844/realms/telechir-phase16";
const resource = "https://127.0.0.1:8988/mcp";
const scope = "telechir:devices:read";
const directory = join(out, "import");
mkdirSync(directory, { recursive: true, mode: 0o700 });

function client(clientId, audience) {
  const secret = randomBytes(32).toString("base64url");
  writeFileSync(join(out, `${clientId}.secret`), secret, { mode: 0o600 });
  return {
    clientId,
    name: "Telechir ephemeral CI service principal",
    enabled: true,
    protocol: "openid-connect",
    publicClient: false,
    secret,
    serviceAccountsEnabled: true,
    standardFlowEnabled: false,
    implicitFlowEnabled: false,
    directAccessGrantsEnabled: false,
    defaultClientScopes: [scope],
    protocolMappers: [
      {
        name: "telechir-audience",
        protocol: "openid-connect",
        protocolMapper: "oidc-audience-mapper",
        consentRequired: false,
        config: {
          "included.custom.audience": audience,
          "access.token.claim": "true",
          "id.token.claim": "false",
        },
      },
    ],
  };
}
const realm = {
  realm: "telechir-phase16",
  enabled: true,
  sslRequired: "all",
  accessTokenLifespan: 900,
  clientScopes: [
    {
      name: scope,
      protocol: "openid-connect",
      attributes: { "include.in.token.scope": "true" },
    },
  ],
  clients: [
    client("telechir-phase16-service", resource),
    client("telechir-phase16-wrong-audience", "https://127.0.0.1:8988/not-mcp"),
  ],
};
writeFileSync(
  join(directory, "telechir-phase16-realm.json"),
  JSON.stringify(realm),
  { mode: 0o600 },
);
console.log("PASS: disposable Keycloak realm and two ephemeral OAuth clients generated");
console.log("NOTE: secrets remain on CI runner and are never printed");
