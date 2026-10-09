/**
 * PHASE 16 CI-ONLY WORKER ENTRYPOINT.
 * Never import this fixture in src/index.ts or package as a production worker.
 *
 * HTTPS MCP traffic uses mcpHttpRoute and the production JwtAccessTokenVerifier.
 * Default fixture replays public OAuth documents, whereas explicit real-IdP
 * CI mode exercises production native fetch directly over verified TLS.
 */
import type { Env } from "../../src/env";
import { mcpHttpRoute } from "../../src/mcp-http";
import {
  JwtAccessTokenVerifier,
  oauthConfigFromEnv,
  protectedResourceMetadataResponse,
} from "../../src/oauth";

export { DeviceCoordinator } from "../../src/device-coordinator";

type FixtureEnv = Env & {
  PHASE16_TEST_JWKS?: string;
  PHASE16_TEST_AUTHORIZATION_METADATA?: string;
  PHASE16_TEST_DIRECT_KEYCLOAK?: string;
};

function testOnlyDocuments(
  issuer: string,
  publicJwks: string,
  realMetadata?: string,
) {
  const parsed: unknown = JSON.parse(publicJwks);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("keys" in parsed) ||
    !Array.isArray(parsed.keys) ||
    parsed.keys.length < 1 ||
    parsed.keys.length > 32
  ) {
    throw new Error("Fixture requires a bounded public JWKS");
  }
  for (const key of parsed.keys) {
    if (
      !key ||
      typeof key !== "object" ||
      !("kid" in key) ||
      typeof key.kid !== "string" ||
      !("kty" in key) ||
      !(
        (key.kty === "RSA" &&
          "n" in key &&
          typeof key.n === "string" &&
          "e" in key &&
          typeof key.e === "string") ||
        (key.kty === "EC" &&
          "x" in key &&
          typeof key.x === "string" &&
          "y" in key &&
          typeof key.y === "string")
      ) ||
      ["d", "p", "q", "dp", "dq", "qi", "oth", "k"].some((name) => name in key)
    ) {
      throw new Error("Fixture JWKS must contain public asymmetric keys only");
    }
  }

  const issuerUrl = new URL(issuer);
  const suffix = issuerUrl.pathname === "/" ? "" : issuerUrl.pathname;
  const metadataUrl = new URL(
    `/.well-known/oauth-authorization-server${suffix}`,
    issuerUrl.origin,
  ).href;
  const synthetic = {
    issuer,
    jwks_uri: `${issuer}/jwks.json`,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    code_challenge_methods_supported: ["S256"],
  };
  let metadata = synthetic;
  if (realMetadata) {
    // CI-only laboratory replay of documents actually fetched and TLS-verified
    // from Keycloak. No claim that workerd performs a direct IdP TLS handshake.
    if (issuer !== "https://127.0.0.1:9443/realms/telechir-phase16") {
      throw new Error("Real IdP fixture issuer is not a pinned CI loopback");
    }
    const candidate: unknown = JSON.parse(realMetadata);
    if (
      !candidate ||
      typeof candidate !== "object" ||
      !("issuer" in candidate) ||
      candidate.issuer !== issuer ||
      !("jwks_uri" in candidate) ||
      candidate.jwks_uri !== `${issuer}/protocol/openid-connect/certs` ||
      !("authorization_endpoint" in candidate) ||
      candidate.authorization_endpoint !==
        `${issuer}/protocol/openid-connect/auth` ||
      !("token_endpoint" in candidate) ||
      candidate.token_endpoint !== `${issuer}/protocol/openid-connect/token` ||
      !("code_challenge_methods_supported" in candidate) ||
      !Array.isArray(candidate.code_challenge_methods_supported) ||
      !candidate.code_challenge_methods_supported.includes("S256")
    ) {
      throw new Error(
        "Real IdP OAuth metadata does not match the pinned issuer",
      );
    }
    metadata = candidate as typeof synthetic;
  }

  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url === metadataUrl) return Response.json(metadata);
    if (url === metadata.jwks_uri) return Response.json(parsed);
    return new Response("Not found", { status: 404 });
  };
}
export default {
  async fetch(request: Request, env: FixtureEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({ status: "ok", fixture: "phase16" });
    }
    if (url.pathname === "/.well-known/oauth-protected-resource") {
      return protectedResourceMetadataResponse(env, request);
    }
    if (url.pathname !== "/mcp") {
      return new Response(null, { status: 404 });
    }
    const directKeycloak = env.PHASE16_TEST_DIRECT_KEYCLOAK === "true";
    if (!directKeycloak && !env.PHASE16_TEST_JWKS) {
      return new Response(null, { status: 503 });
    }
    try {
      const config = oauthConfigFromEnv(env);
      const { explicitJwksUri: _omitted, ...discovered } = config;
      if (
        directKeycloak &&
        (discovered.issuer !==
          "https://127.0.0.1:9443/realms/telechir-phase16" ||
          env.PHASE16_TEST_JWKS ||
          env.PHASE16_TEST_AUTHORIZATION_METADATA)
      ) {
        // Never silently fall back to trusted snapshots in direct mode.
        return new Response(null, { status: 503 });
      }
      const verifier = directKeycloak
        ? new JwtAccessTokenVerifier(env.DB, discovered)
        : new JwtAccessTokenVerifier(
            env.DB,
            discovered,
            testOnlyDocuments(
              discovered.issuer,
              env.PHASE16_TEST_JWKS!,
              env.PHASE16_TEST_AUTHORIZATION_METADATA,
            ),
          );
      return (
        (await mcpHttpRoute(request, env, url, verifier)) ??
        new Response(null, { status: 404 })
      );
    } catch {
      return new Response(null, { status: 503 });
    }
  },
} satisfies ExportedHandler<FixtureEnv>;
