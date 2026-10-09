import { env } from "cloudflare:workers";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeEach, describe, expect, it } from "vitest";

import type { Env } from "../src/env";
import { PHASE14_TOOLS } from "../src/mcp-catalog";
import { mcpHttpRoute } from "../src/mcp-http";
import {
  clearOAuthDocumentCachesForTests,
  JwtAccessTokenVerifier,
  oauthConfigFromEnv,
} from "../src/oauth";
import { toBase64Url } from "../src/pairing-crypto";

const bindings = env as unknown as Env;
const config = oauthConfigFromEnv(bindings);
const issuer = config.issuer;
const resource = config.resourceUri;
const kid = "phase16-signed-client-fixture";

async function linkUser(
  subject: string,
): Promise<{ userId: string; deviceId: string }> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(subject),
  );
  const userId = crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  const now = new Date().toISOString();
  await bindings.DB.prepare(
    `INSERT INTO users
       (id, identity_provider, provider_subject_hash, display_name, created_at, disabled_at)
     VALUES (?, ?, ?, ?, ?, NULL)`,
  )
    .bind(
      userId,
      issuer,
      toBase64Url(new Uint8Array(digest)),
      "Phase 16 User",
      now,
    )
    .run();
  await bindings.DB.prepare(
    `INSERT INTO devices
       (id, user_id, display_name, os, arch, agent_version, status_hint,
        last_seen_at, created_at, revoked_at)
     VALUES (?, ?, ?, 'linux', 'x86_64', '0.1.0', 'offline', NULL, ?, NULL)`,
  )
    .bind(deviceId, userId, "Synthetic Device", now)
    .run();
  return { userId, deviceId };
}

async function signedMaterial() {
  const pair = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(pair.publicKey);
  jwk.kid = kid;
  jwk.alg = "RS256";
  jwk.use = "sig";
  return { privateKey: pair.privateKey, jwks: { keys: [jwk] } };
}

async function signedToken(
  privateKey: CryptoKey,
  subject: string,
  scope = "telechir:devices:read",
  aud = resource,
) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ scope, client_id: "phase16-independent-sdk" })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(issuer)
    .setAudience(aud)
    .setSubject(subject)
    .setIssuedAt(now)
    .setNotBefore(now - 1)
    .setExpirationTime(now + 300)
    .sign(privateKey);
}

function verifier(jwks: { keys: Record<string, unknown>[] }) {
  // The issuer is synthetic and contains no accounts or network service.
  // Exercise production JWT/JWKS cryptography with deterministic HTTPS
  // discovery documents, not an AuthInfo fake or a real external IdP.
  const { explicitJwksUri: _ignored, ...configWithoutExplicitJwks } = config;
  const requests: string[] = [];
  const documentFetcher = async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (url === `${issuer}/.well-known/oauth-authorization-server`) {
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks.json`,
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url === `${issuer}/jwks.json`) return Response.json(jwks);
    return new Response("Not found", { status: 404 });
  };
  return {
    verifier: new JwtAccessTokenVerifier(
      bindings.DB,
      configWithoutExplicitJwks,
      documentFetcher,
    ),
    requests,
  };
}

function signedClient(
  token: string,
  authVerifier: JwtAccessTokenVerifier,
  mode: "legacy" | "auto",
) {
  const statuses: number[] = [];
  const transport = new StreamableHTTPClientTransport(new URL(resource), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    onInsufficientScope: "throw",
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const response = await mcpHttpRoute(
        request,
        bindings,
        new URL(request.url),
        authVerifier,
      );
      if (!response) throw new Error("Unexpected route");
      statuses.push(response.status);
      return response;
    },
  });
  const client = new Client(
    { name: "phase16-signed-jwt-sdk", version: "1.0.0" },
    { versionNegotiation: { mode } },
  );
  return { client, transport, statuses };
}

beforeEach(async () => {
  clearOAuthDocumentCachesForTests();
  // Only synthetic issuer-linked test users are in scope. Clean child
  // records first to respect D1 foreign keys and keep tests independent.
  await bindings.DB.prepare(
    "DELETE FROM workspaces WHERE user_id IN (SELECT id FROM users WHERE identity_provider = ?)",
  )
    .bind(issuer)
    .run();
  await bindings.DB.prepare(
    "DELETE FROM devices WHERE user_id IN (SELECT id FROM users WHERE identity_provider = ?)",
  )
    .bind(issuer)
    .run();
  await bindings.DB.prepare("DELETE FROM users WHERE identity_provider = ?")
    .bind(issuer)
    .run();
});

describe("Phase 16 — signed JWT with official MCP client transport", () => {
  it("negotiates modern and legacy clients with two distinct linked identities and 24 tools", async () => {
    const a = await linkUser("phase16-alice@example.test");
    const b = await linkUser("phase16-bob@example.test");
    const material = await signedMaterial();
    const { verifier: authVerifier, requests } = verifier(material.jwks);
    const modern = signedClient(
      await signedToken(material.privateKey, "phase16-alice@example.test"),
      authVerifier,
      "auto",
    );
    const legacy = signedClient(
      await signedToken(material.privateKey, "phase16-bob@example.test"),
      authVerifier,
      "legacy",
    );
    try {
      await Promise.all([
        modern.client.connect(modern.transport),
        legacy.client.connect(legacy.transport),
      ]);
      expect(modern.client.getDiscoverResult()).toBeDefined();
      expect(legacy.client.getDiscoverResult()).toBeUndefined();
      const [modernTools, legacyTools] = await Promise.all([
        modern.client.listTools(),
        legacy.client.listTools(),
      ]);
      const expected = PHASE14_TOOLS.map((tool) => tool.name).sort();
      expect(modernTools.tools.map((tool) => tool.name).sort()).toEqual(
        expected,
      );
      expect(legacyTools.tools.map((tool) => tool.name).sort()).toEqual(
        expected,
      );
      expect(expected).toHaveLength(24);

      const [listA, listB] = await Promise.all([
        modern.client.callTool({
          name: "list_devices",
          arguments: { status: "all" },
        }),
        legacy.client.callTool({
          name: "list_devices",
          arguments: { status: "all" },
        }),
      ]);
      expect(listA.isError).not.toBe(true);
      expect(listB.isError).not.toBe(true);
      expect(listA.structuredContent).toMatchObject({
        devices: [{ device_id: a.deviceId }],
      });
      expect(listB.structuredContent).toMatchObject({
        devices: [{ device_id: b.deviceId }],
      });

      const foreign = await modern.client.callTool({
        name: "get_device",
        arguments: { device_id: b.deviceId },
      });
      expect(foreign.isError).toBe(true);
      expect(JSON.stringify(foreign.content)).not.toContain(b.deviceId);
      expect(modern.statuses).not.toContain(401);
      expect(legacy.statuses).not.toContain(401);
      expect(modern.statuses).toContain(200);
      expect(legacy.statuses).toContain(200);
      expect(modern.statuses.every((status) => status < 500)).toBe(true);
      expect(legacy.statuses.every((status) => status < 500)).toBe(true);
      expect(requests).toContain(
        `${issuer}/.well-known/oauth-authorization-server`,
      );
      expect(requests).toContain(`${issuer}/jwks.json`);
    } finally {
      await Promise.allSettled([modern.client.close(), legacy.client.close()]);
    }
  });

  it("rejects a write scope elevation with a genuine read-only JWT", async () => {
    await linkUser("phase16-readonly@example.test");
    const material = await signedMaterial();
    const { verifier: authVerifier } = verifier(material.jwks);
    const readonly = signedClient(
      await signedToken(
        material.privateKey,
        "phase16-readonly@example.test",
        "telechir:devices:read",
      ),
      authVerifier,
      "legacy",
    );
    try {
      await readonly.client.connect(readonly.transport);
      await expect(
        readonly.client.callTool({
          name: "write_file",
          arguments: {},
        }),
      ).rejects.toThrow();
      expect(readonly.statuses).toContain(403);
    } finally {
      await readonly.client.close();
    }
  });

  it("refuses a signed JWT with a wrong audience before MCP handshake", async () => {
    await linkUser("phase16-audience@example.test");
    const material = await signedMaterial();
    const { verifier: authVerifier } = verifier(material.jwks);
    const invalid = signedClient(
      await signedToken(
        material.privateKey,
        "phase16-audience@example.test",
        "telechir:devices:read",
        "https://telechir.test/not-the-mcp-resource",
      ),
      authVerifier,
      "legacy",
    );
    try {
      await expect(invalid.client.connect(invalid.transport)).rejects.toThrow();
      expect(invalid.statuses).toContain(401);
      expect(invalid.statuses).not.toContain(200);
    } finally {
      await invalid.client.close().catch(() => undefined);
    }
  });
});
