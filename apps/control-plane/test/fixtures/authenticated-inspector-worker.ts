/**
 * PHASE 16 CI-ONLY WORKER ENTRYPOINT.
 * Never import this fixture in src/index.ts or package as a production worker.
 *
 * HTTPS MCP traffic uses mcpHttpRoute and the production JwtAccessTokenVerifier.
 * Only remote OAuth discovery/JWKS responses are synthetic.
 */
import type { Env } from "../../src/env";
import { mcpHttpRoute } from "../../src/mcp-http";
import {
  JwtAccessTokenVerifier,
  oauthConfigFromEnv,
  protectedResourceMetadataResponse,
} from "../../src/oauth";

export { DeviceCoordinator } from "../../src/device-coordinator";

type FixtureEnv = Env & { PHASE16_TEST_JWKS?: string };

function testOnlyDocuments(issuer: string, publicJwks: string) {
  const parsed: unknown = JSON.parse(publicJwks);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("keys" in parsed) ||
    !Array.isArray(parsed.keys) ||
    parsed.keys.length !== 1
  ) {
    throw new Error("Fixture requires exactly one public JWK");
  }
  const jwk: unknown = parsed.keys[0];
  if (
    !jwk ||
    typeof jwk !== "object" ||
    !("kty" in jwk) ||
    jwk.kty !== "RSA" ||
    !("n" in jwk) ||
    typeof jwk.n !== "string" ||
    !("e" in jwk) ||
    typeof jwk.e !== "string" ||
    "d" in jwk
  ) {
    throw new Error("Fixture JWKS must contain only an RSA public key");
  }

  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url === `${issuer}/.well-known/oauth-authorization-server`) {
      return Response.json({
        issuer,
        jwks_uri: `${issuer}/jwks.json`,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url === `${issuer}/jwks.json`) return Response.json(parsed);
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
    if (!env.PHASE16_TEST_JWKS) {
      return new Response(null, { status: 503 });
    }
    try {
      const config = oauthConfigFromEnv(env);
      const { explicitJwksUri: _omitted, ...discovered } = config;
      const verifier = new JwtAccessTokenVerifier(
        env.DB,
        discovered,
        testOnlyDocuments(discovered.issuer, env.PHASE16_TEST_JWKS),
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
