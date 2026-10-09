#!/usr/bin/env node
// CI-only issuer/JWKS fixture. RSA private key stays in memory.
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const [out, resource, issuer] = process.argv.slice(2);
if (
  !out ||
  resource !== "https://127.0.0.1:8988/mcp" ||
  issuer !== "https://auth.telechir.test"
) {
  throw new Error(
    "Expected private temp dir, fixed loopback MCP URL and synthetic issuer",
  );
}

const { publicKey, privateKey } = await generateKeyPair("RS256");
const kid = "phase16-inspector-fixture";
const jwk = await exportJWK(publicKey);
jwk.kid = kid;
jwk.alg = "RS256";
jwk.use = "sig";
writeFileSync(join(out, "jwks.json"), JSON.stringify({ keys: [jwk] }), {
  mode: 0o600,
});

const subject = "phase16-inspector-synthetic-subject";
const hashedSubject = createHash("sha256")
  .update(subject, "utf8")
  .digest("base64url");
const userId = randomUUID();
const deviceId = randomUUID();
const now = new Date().toISOString();
const sql = [
  `INSERT INTO users (id, identity_provider, provider_subject_hash, display_name, created_at, disabled_at) VALUES ('${userId}', '${issuer}', '${hashedSubject}', 'Synthetic Inspector User', '${now}', NULL);`,
  `INSERT INTO devices (id, user_id, display_name, os, arch, agent_version, status_hint, last_seen_at, created_at, revoked_at) VALUES ('${deviceId}', '${userId}', 'Inspector Fixture Device', 'linux', 'x86_64', '0.1.0', 'offline', NULL, '${now}', NULL);`,
];
writeFileSync(join(out, "seed.sql"), sql.join("\n"), { mode: 0o600 });
writeFileSync(join(out, "device-id"), deviceId, { mode: 0o600 });

const seconds = Math.floor(Date.now() / 1000);
async function signed(audience, scope) {
  return new SignJWT({ scope, client_id: "phase16-inspector" })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(subject)
    .setIssuedAt(seconds)
    .setNotBefore(seconds - 2)
    .setExpirationTime(seconds + 1200)
    .sign(privateKey);
}
writeFileSync(
  join(out, "valid.token"),
  await signed(resource, "telechir:devices:read"),
  { mode: 0o600 },
);
writeFileSync(
  join(out, "wrong-audience.token"),
  await signed("https://127.0.0.1:8988/not-mcp", "telechir:devices:read"),
  { mode: 0o600 },
);

console.log(
  "PASS: ephemeral public JWKS, read-only JWT, wrong-audience JWT and synthetic D1 records generated",
);
