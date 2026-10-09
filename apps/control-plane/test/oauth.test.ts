import { env } from "cloudflare:workers";
import {
  OAuthError,
  OAuthErrorCode,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeEach, describe, expect, it } from "vitest";

import type { Env } from "../src/env";
import {
  clearOAuthDocumentCachesForTests,
  JwtAccessTokenVerifier,
  oauthConfigFromEnv,
  protectedResourceMetadata,
} from "../src/oauth";
import { toBase64Url } from "../src/pairing-crypto";

const bindings = env as unknown as Env;
const issuer = "https://auth.telechir.test";
const resource = "https://telechir.test/mcp";
const subject = "oauth-user@example.test";
const nowSeconds = Math.floor(Date.now() / 1000);

async function subjectHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return toBase64Url(new Uint8Array(digest));
}

async function seedUser(): Promise<string> {
  const id = crypto.randomUUID();
  await bindings.DB.prepare(
    `INSERT INTO users (
      id, identity_provider, provider_subject_hash, display_name,
      created_at, disabled_at
    ) VALUES (?, ?, ?, 'OAuth Test User', ?, NULL)`,
  )
    .bind(id, issuer, await subjectHash(subject), new Date().toISOString())
    .run();
  return id;
}

async function signingMaterial(): Promise<{
  privateKey: CryptoKey;
  jwks: { keys: Record<string, unknown>[] };
}> {
  const pair = await generateKeyPair("RS256", { extractable: true });
  const publicJwk = await exportJWK(pair.publicKey);
  publicJwk.kid = "phase5-test-key";
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  return {
    privateKey: pair.privateKey,
    jwks: { keys: [publicJwk] },
  };
}

async function token(
  privateKey: CryptoKey,
  overrides: {
    issuer?: string;
    audience?: string;
    subject?: string;
    exp?: number;
    nbf?: number;
    scope?: string | string[];
    kid?: string;
  } = {},
): Promise<string> {
  return new SignJWT({
    scope: overrides.scope ?? "telechir:devices:read",
    client_id: "phase5-test-client",
  })
    .setProtectedHeader({
      alg: "RS256",
      kid: overrides.kid ?? "phase5-test-key",
    })
    .setIssuer(overrides.issuer ?? issuer)
    .setAudience(overrides.audience ?? resource)
    .setSubject(overrides.subject ?? subject)
    .setIssuedAt(nowSeconds)
    .setNotBefore(overrides.nbf ?? nowSeconds - 1)
    .setExpirationTime(overrides.exp ?? nowSeconds + 300)
    .sign(privateKey);
}

function discoveredConfig() {
  const config = oauthConfigFromEnv(bindings);
  const { explicitJwksUri: _explicitJwksUri, ...discovered } = config;
  return discovered;
}

function fetcher(
  jwks: { keys: Record<string, unknown>[] },
  pkceMethods: string[] = ["S256"],
) {
  const calls: string[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // Workerd does not implement redirect="error"; manual is fail-closed.
    expect(init?.redirect).toBe("manual");
    const url = String(input);
    calls.push(url);
    if (
      url ===
      "https://auth.telechir.test/.well-known/oauth-authorization-server"
    ) {
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks.json`,
        code_challenge_methods_supported: pkceMethods,
      });
    }
    if (url === `${issuer}/jwks.json`) {
      return Response.json(jwks);
    }
    return new Response("not found", { status: 404 });
  };
  return { fetch, calls };
}

beforeEach(async () => {
  clearOAuthDocumentCachesForTests();
  // prettier-ignore
  await bindings.DB.prepare(
    "DELETE FROM users WHERE identity_provider = ?",
  )
    .bind(issuer)
    .run();
});

describe("OAuth resource server", () => {
  it("publishes protected-resource metadata from canonical config", () => {
    const config = oauthConfigFromEnv(bindings);
    expect(protectedResourceMetadata(config)).toEqual({
      resource,
      authorization_servers: [issuer],
      scopes_supported: [
        "telechir:approvals:decide",
        "telechir:browser:use",
        "telechir:dashboard:read",
        "telechir:devices:read",
        "telechir:devices:revoke",
        "telechir:files:read",
        "telechir:files:write",
        "telechir:git:read",
        "telechir:input:write",
        "telechir:processes:read",
        "telechir:processes:write",
        "telechir:screen:read",
      ],
    });
  });

  it("verifies a signed access token and binds it to a Telechir user", async () => {
    const userId = await seedUser();
    const material = await signingMaterial();
    const remote = fetcher(material.jwks);
    const config = discoveredConfig();
    const verifier = new JwtAccessTokenVerifier(
      bindings.DB,
      config,
      remote.fetch,
    );

    const auth = await verifier.verifyAccessToken(
      await token(material.privateKey),
    );

    expect(auth).toMatchObject({
      clientId: "phase5-test-client",
      scopes: ["telechir:devices:read"],
      expiresAt: nowSeconds + 300,
      extra: { telechir_user_id: userId },
    });
    expect(auth.resource?.href).toBe(resource);
    expect(remote.calls).toEqual([
      "https://auth.telechir.test/.well-known/oauth-authorization-server",
      "https://auth.telechir.test/jwks.json",
    ]);
  });

  it.each([
    ["wrong issuer", { issuer: "https://evil.example" }],
    ["wrong audience", { audience: "https://telechir.test/not-mcp" }],
    ["expired", { exp: nowSeconds - 60 }],
    ["future nbf", { nbf: nowSeconds + 60 }],
    ["unknown subject", { subject: "unknown@example.test" }],
    ["unknown signing key", { kid: "unknown-key" }],
  ] as const)("rejects %s tokens fail-closed", async (_name, overrides) => {
    await seedUser();
    const material = await signingMaterial();
    const remote = fetcher(material.jwks);
    const verifier = new JwtAccessTokenVerifier(
      bindings.DB,
      discoveredConfig(),
      remote.fetch,
    );

    const promise = verifier.verifyAccessToken(
      await token(material.privateKey, overrides),
    );

    await expect(promise).rejects.toSatisfy((error: unknown) => {
      return (
        OAuthError.isInstance(error) &&
        error.code === OAuthErrorCode.InvalidToken
      );
    });
  });

  it("rejects OAuth metadata redirects without following the untrusted Location", async () => {
    await seedUser();
    const material = await signingMaterial();
    const received: string[] = [];
    const noRedirectFetch = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      received.push(String(input));
      expect(init?.redirect).toBe("manual");
      return new Response(null, {
        status: 302,
        headers: { location: "https://untrusted.example/jwks.json" },
      });
    };
    const verifier = new JwtAccessTokenVerifier(
      bindings.DB,
      discoveredConfig(),
      noRedirectFetch,
    );
    await expect(
      verifier.verifyAccessToken(await token(material.privateKey)),
    ).rejects.toSatisfy(
      (error: unknown) =>
        OAuthError.isInstance(error) &&
        error.code === OAuthErrorCode.InvalidToken,
    );
    expect(received).toEqual([
      "https://auth.telechir.test/.well-known/oauth-authorization-server",
    ]);
  });

  it("rejects an authorization server that does not advertise PKCE S256", async () => {
    await seedUser();
    const material = await signingMaterial();
    const remote = fetcher(material.jwks, ["plain"]);
    const verifier = new JwtAccessTokenVerifier(
      bindings.DB,
      discoveredConfig(),
      remote.fetch,
    );

    await expect(
      verifier.verifyAccessToken(await token(material.privateKey)),
    ).rejects.toSatisfy((error: unknown) => {
      return (
        OAuthError.isInstance(error) &&
        error.code === OAuthErrorCode.InvalidToken
      );
    });
  });

  it("caches trusted authorization metadata and JWKS for repeated verification", async () => {
    await seedUser();
    const material = await signingMaterial();
    const remote = fetcher(material.jwks);
    const verifier = new JwtAccessTokenVerifier(
      bindings.DB,
      discoveredConfig(),
      remote.fetch,
    );
    const signed = await token(material.privateKey);

    await verifier.verifyAccessToken(signed);
    await verifier.verifyAccessToken(signed);

    expect(remote.calls).toHaveLength(2);
  });

  it("rejects signed tokens after the matching local account is disabled", async () => {
    const userId = await seedUser();
    const material = await signingMaterial();
    const signed = await token(material.privateKey);
    await bindings.DB.prepare("UPDATE users SET disabled_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), userId)
      .run();
    const verifier = new JwtAccessTokenVerifier(
      bindings.DB,
      discoveredConfig(),
      fetcher(material.jwks).fetch,
    );

    await expect(verifier.verifyAccessToken(signed)).rejects.toSatisfy(
      (error: unknown) =>
        OAuthError.isInstance(error) &&
        error.code === OAuthErrorCode.InvalidToken,
    );
  });

  it("normalizes duplicate scopes in strings and arrays without granting others", async () => {
    const userId = await seedUser();
    const material = await signingMaterial();
    const verifier = new JwtAccessTokenVerifier(
      bindings.DB,
      discoveredConfig(),
      fetcher(material.jwks).fetch,
    );

    const stringToken = await token(material.privateKey, {
      scope: "telechir:devices:read  telechir:devices:read telechir:files:read",
    });
    const arrayToken = await token(material.privateKey, {
      scope: [
        "telechir:devices:read",
        "telechir:devices:read",
        "telechir:files:read",
      ],
    });
    const expectedScopes = ["telechir:devices:read", "telechir:files:read"];
    expect(await verifier.verifyAccessToken(stringToken)).toMatchObject({
      scopes: expectedScopes,
      extra: { telechir_user_id: userId },
    });
    expect(await verifier.verifyAccessToken(arrayToken)).toMatchObject({
      scopes: expectedScopes,
      extra: { telechir_user_id: userId },
    });
  });

  it("rejects malformed and unsecured access tokens before remote JWKS lookup", async () => {
    await seedUser();
    const material = await signingMaterial();
    const remote = fetcher(material.jwks);
    const verifier = new JwtAccessTokenVerifier(
      bindings.DB,
      discoveredConfig(),
      remote.fetch,
    );
    const unsignedHeader = toBase64Url(
      new TextEncoder().encode(JSON.stringify({ alg: "none", kid: "test" })),
    );
    const unsignedPayload = toBase64Url(
      new TextEncoder().encode(JSON.stringify({ sub: subject, iss: issuer })),
    );
    const invalidTokens = [
      "not-a-jwt",
      `${unsignedHeader}.${unsignedPayload}.not-a-signature`,
    ];
    for (const invalidToken of invalidTokens) {
      await expect(verifier.verifyAccessToken(invalidToken)).rejects.toSatisfy(
        (error: unknown) =>
          OAuthError.isInstance(error) &&
          error.code === OAuthErrorCode.InvalidToken,
      );
    }
    expect(remote.calls).toEqual([]);
  });
});
