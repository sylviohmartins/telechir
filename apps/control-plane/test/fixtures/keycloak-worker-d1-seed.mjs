#!/usr/bin/env node
// Generate disposable SQLite D1 identities from a genuinely Keycloak-issued JWT.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeJwt } from "jose";

const [temp, issuer] = process.argv.slice(2);
assert.equal(process.argv.length, 4);
assert.equal(issuer, "https://127.0.0.1:9443/realms/telechir-phase16");
const { access_token: token } = JSON.parse(
  readFileSync(join(temp, "token.json"), "utf8"),
);
assert.equal(typeof token, "string");
const claims = decodeJwt(token);
assert.equal(claims.iss, issuer);
assert.ok(typeof claims.sub === "string" && claims.sub.length > 0);
const subjectHash = createHash("sha256")
  .update(claims.sub)
  .digest("base64url");
const linkedId = randomUUID();
const foreignId = randomUUID();
const deviceId = randomUUID();
const foreignDevice = randomUUID();
const foreignSubjectHash = createHash("sha256")
  .update("other-Keycloak-lab-principal")
  .digest("base64url");
const now = new Date().toISOString();
// All SQL interpolations are either validated pinned issuer, Base64URL digests,
// UUIDs, or generated ISO timestamps; never interpolate untrusted JWT claims.
const seed = [
  `INSERT INTO users (id, identity_provider, provider_subject_hash, display_name, created_at, disabled_at) VALUES ('${linkedId}', '${issuer}', '${subjectHash}', 'Keycloak CI linked principal', '${now}', NULL);`,
  `INSERT INTO users (id, identity_provider, provider_subject_hash, display_name, created_at, disabled_at) VALUES ('${foreignId}', '${issuer}', '${foreignSubjectHash}', 'Keycloak CI foreign principal', '${now}', NULL);`,
  `INSERT INTO devices (id, user_id, display_name, os, arch, agent_version, status_hint, last_seen_at, created_at, revoked_at) VALUES ('${deviceId}', '${linkedId}', 'Keycloak CI device', 'linux', 'x86_64', '0.1.0', 'offline', NULL, '${now}', NULL);`,
  `INSERT INTO devices (id, user_id, display_name, os, arch, agent_version, status_hint, last_seen_at, created_at, revoked_at) VALUES ('${foreignDevice}', '${foreignId}', 'Other-owner CI device', 'linux', 'x86_64', '0.1.0', 'offline', NULL, '${now}', NULL);`,
];
writeFileSync(join(temp, "worker-seed.sql"), seed.join("\n") + "\n", { mode: 0o600 });
writeFileSync(join(temp, "worker-disable.sql"),
  `UPDATE users SET disabled_at = CURRENT_TIMESTAMP WHERE id = '${linkedId}';\n`,
  { mode: 0o600 });
writeFileSync(join(temp, "worker-device-id"), deviceId, { mode: 0o600 });
writeFileSync(join(temp, "worker-foreign-device-id"), foreignDevice, { mode: 0o600 });
const parts = token.split(".");
assert.equal(parts.length, 3);
const first = parts[2][0];
const tampered =
  parts[0] + "." + parts[1] + "." +
  (first === "A" ? "B" : "A") + parts[2].slice(1);
writeFileSync(join(temp, "worker-tampered.token"), tampered, { mode: 0o600 });
console.log("PASS: isolated D1 seed prepared for genuine Keycloak subject plus foreign-owner device");
