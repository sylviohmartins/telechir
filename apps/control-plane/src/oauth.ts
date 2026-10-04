import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import {
  createLocalJWKSet,
  decodeProtectedHeader,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
} from "jose";

import type { Env } from "./env";
import { PHASE8_OAUTH_SCOPES } from "./mcp-catalog";
import { toBase64Url } from "./pairing-crypto";

const ALLOWED_JWT_ALGORITHMS = ["RS256", "ES256"] as const;
const REMOTE_DOCUMENT_MAX_BYTES = 256 * 1024;
const REMOTE_CACHE_TTL_MS = 5 * 60 * 1000;
const REMOTE_FETCH_TIMEOUT_MS = 5_000;
const MAX_CACHE_ENTRIES = 4;

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

interface AuthorizationServerMetadata {
  issuer: string;
  jwks_uri: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  code_challenge_methods_supported?: string[];
}

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

const metadataCache = new Map<
  string,
  CacheEntry<AuthorizationServerMetadata>
>();
const jwksCache = new Map<string, CacheEntry<JSONWebKeySet>>();

export interface OAuthResourceConfig {
  issuer: string;
  resourceUri: string;
  resourceMetadataUrl: string;
  explicitJwksUri?: string;
  subjectClaim: string;
  scopeClaim: string;
}

export class OAuthConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthConfigurationError";
  }
}

function httpsUrl(value: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OAuthConfigurationError(`${name} must be an absolute URL`);
  }
  if (url.protocol !== "https:") {
    throw new OAuthConfigurationError(`${name} must use HTTPS`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new OAuthConfigurationError(
      `${name} must not contain credentials, query, or fragment`,
    );
  }
  return url;
}

function canonicalIssuer(value: string): string {
  const url = httpsUrl(value, "OAUTH_ISSUER");
  const pathname =
    url.pathname === "/" ? "" : url.pathname.replace(/\/+$/u, "");
  return `${url.origin}${pathname}`;
}

export function oauthConfigFromEnv(env: Env): OAuthResourceConfig {
  if (!env.MCP_RESOURCE_URI || !env.OAUTH_ISSUER) {
    throw new OAuthConfigurationError(
      "MCP_RESOURCE_URI and OAUTH_ISSUER are required",
    );
  }

  const resource = httpsUrl(env.MCP_RESOURCE_URI, "MCP_RESOURCE_URI");
  if (resource.pathname !== "/mcp") {
    throw new OAuthConfigurationError(
      "MCP_RESOURCE_URI must identify the /mcp endpoint",
    );
  }

  const issuer = canonicalIssuer(env.OAUTH_ISSUER);
  const explicitJwksUri = env.OAUTH_JWKS_URI
    ? httpsUrl(env.OAUTH_JWKS_URI, "OAUTH_JWKS_URI").href
    : undefined;

  return {
    issuer,
    resourceUri: resource.href,
    resourceMetadataUrl: new URL(
      "/.well-known/oauth-protected-resource",
      resource.origin,
    ).href,
    ...(explicitJwksUri ? { explicitJwksUri } : {}),
    subjectClaim: env.OAUTH_SUBJECT_CLAIM?.trim() || "sub",
    scopeClaim: env.OAUTH_SCOPE_CLAIM?.trim() || "scope",
  };
}

export function protectedResourceMetadata(config: OAuthResourceConfig) {
  return {
    resource: config.resourceUri,
    authorization_servers: [config.issuer],
    scopes_supported: PHASE8_OAUTH_SCOPES,
  };
}

export function protectedResourceMetadataResponse(
  env: Env,
  request: Request,
): Response {
  if (request.method !== "GET") {
    return new Response(null, {
      status: 405,
      headers: { allow: "GET" },
    });
  }

  try {
    const config = oauthConfigFromEnv(env);
    return Response.json(protectedResourceMetadata(config), {
      headers: {
        "cache-control": "public, max-age=300",
        "content-type": "application/json; charset=utf-8",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return Response.json(
      {
        error: "server_error",
        error_description: "OAuth resource server is not configured",
      },
      {
        status: 503,
        headers: {
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
        },
      },
    );
  }
}

function authorizationServerMetadataUrl(issuer: string): string {
  const url = new URL(issuer);
  const suffix = url.pathname === "/" ? "" : url.pathname;
  return new URL(`/.well-known/oauth-authorization-server${suffix}`, url.origin)
    .href;
}

function setBoundedCache<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  entry: CacheEntry<T>,
): void {
  if (!cache.has(key) && cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest) {
      cache.delete(oldest);
    }
  }
  cache.set(key, entry);
}

async function fetchJson(
  fetcher: Fetcher,
  url: string,
): Promise<Record<string, unknown>> {
  const response = await fetcher(url, {
    method: "GET",
    headers: {
      accept: "application/json",
    },
    redirect: "error",
    signal: AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`remote OAuth document returned ${response.status}`);
  }

  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > REMOTE_DOCUMENT_MAX_BYTES) {
    throw new Error("remote OAuth document is too large");
  }

  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("remote OAuth document must be an object");
  }
  return parsed as Record<string, unknown>;
}

async function authorizationMetadata(
  config: OAuthResourceConfig,
  fetcher: Fetcher,
  now: number,
): Promise<AuthorizationServerMetadata> {
  const key = config.issuer;
  const cached = metadataCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const raw = await fetchJson(
    fetcher,
    authorizationServerMetadataUrl(config.issuer),
  );
  if (
    raw.issuer !== config.issuer ||
    typeof raw.jwks_uri !== "string" ||
    typeof raw.authorization_endpoint !== "string" ||
    typeof raw.token_endpoint !== "string" ||
    !Array.isArray(raw.code_challenge_methods_supported) ||
    !raw.code_challenge_methods_supported.every(
      (value) => typeof value === "string",
    ) ||
    !raw.code_challenge_methods_supported.includes("S256")
  ) {
    throw new Error(
      "authorization server metadata is inconsistent or lacks PKCE S256",
    );
  }

  const jwksUrl = httpsUrl(raw.jwks_uri, "authorization server jwks_uri");
  const authorizationEndpoint = httpsUrl(
    raw.authorization_endpoint,
    "authorization server authorization_endpoint",
  );
  const tokenEndpoint = httpsUrl(
    raw.token_endpoint,
    "authorization server token_endpoint",
  );
  const metadata: AuthorizationServerMetadata = {
    issuer: raw.issuer,
    jwks_uri: jwksUrl.href,
    authorization_endpoint: authorizationEndpoint.href,
    token_endpoint: tokenEndpoint.href,
    code_challenge_methods_supported:
      raw.code_challenge_methods_supported as string[],
  };

  setBoundedCache(metadataCache, key, {
    expiresAt: now + REMOTE_CACHE_TTL_MS,
    value: metadata,
  });
  return metadata;
}

function validJwks(value: Record<string, unknown>): JSONWebKeySet {
  if (!Array.isArray(value.keys) || value.keys.length === 0) {
    throw new Error("JWKS must contain at least one key");
  }
  if (value.keys.length > 32) {
    throw new Error("JWKS contains too many keys");
  }
  return value as unknown as JSONWebKeySet;
}

async function remoteJwks(
  config: OAuthResourceConfig,
  fetcher: Fetcher,
  now: number,
): Promise<JSONWebKeySet> {
  const metadata = await authorizationMetadata(config, fetcher, now);
  const uri = config.explicitJwksUri ?? metadata.jwks_uri;

  const cached = jwksCache.get(uri);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const jwks = validJwks(await fetchJson(fetcher, uri));
  setBoundedCache(jwksCache, uri, {
    expiresAt: now + REMOTE_CACHE_TTL_MS,
    value: jwks,
  });
  return jwks;
}

function claimString(payload: JWTPayload, name: string): string {
  const value = payload[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`required JWT claim is missing: ${name}`);
  }
  return value;
}

function scopesFromClaim(payload: JWTPayload, name: string): string[] {
  const value = payload[name];
  if (typeof value === "string") {
    return [...new Set(value.split(/\s+/u).filter(Boolean))];
  }
  if (
    Array.isArray(value) &&
    value.every((scope) => typeof scope === "string")
  ) {
    return [...new Set(value)];
  }
  return [];
}

async function subjectHash(subject: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(subject),
  );
  return toBase64Url(new Uint8Array(digest));
}

export class JwtAccessTokenVerifier implements OAuthTokenVerifier {
  constructor(
    private readonly db: D1Database,
    private readonly config: OAuthResourceConfig,
    private readonly fetcher: Fetcher = fetch,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    try {
      if (token.length < 20 || token.length > 16 * 1024) {
        throw new Error("access token length is invalid");
      }

      const protectedHeader = decodeProtectedHeader(token);
      if (
        typeof protectedHeader.kid !== "string" ||
        protectedHeader.kid.length === 0 ||
        !ALLOWED_JWT_ALGORITHMS.includes(
          protectedHeader.alg as (typeof ALLOWED_JWT_ALGORITHMS)[number],
        )
      ) {
        throw new Error("access token header is not allowed");
      }

      const now = this.clock();
      const jwks = await remoteJwks(this.config, this.fetcher, now);
      if (
        !jwks.keys.some(
          (key) =>
            key.kid === protectedHeader.kid &&
            (!key.alg || key.alg === protectedHeader.alg),
        )
      ) {
        throw new Error("access token kid does not resolve in trusted JWKS");
      }

      const verified = await jwtVerify(token, createLocalJWKSet(jwks), {
        issuer: this.config.issuer,
        audience: this.config.resourceUri,
        algorithms: [...ALLOWED_JWT_ALGORITHMS],
        clockTolerance: 5,
      });

      const payload = verified.payload;
      if (typeof payload.exp !== "number") {
        throw new Error("access token must contain exp");
      }

      const subject = claimString(payload, this.config.subjectClaim);
      const hash = await subjectHash(subject);
      const user = await this.db
        .prepare(
          `SELECT id
           FROM users
           WHERE identity_provider = ?
             AND provider_subject_hash = ?
             AND disabled_at IS NULL`,
        )
        .bind(this.config.issuer, hash)
        .first<{ id: string }>();

      if (!user) {
        throw new Error("access token subject is not linked");
      }

      const scopes = scopesFromClaim(payload, this.config.scopeClaim);
      const clientId =
        (typeof payload.client_id === "string" && payload.client_id) ||
        (typeof payload.azp === "string" && payload.azp) ||
        "oauth2-client";

      return {
        token,
        clientId,
        scopes,
        expiresAt: payload.exp,
        resource: new URL(this.config.resourceUri),
        resourceMetadataUrl: this.config.resourceMetadataUrl,
        extra: {
          telechir_user_id: user.id,
        },
      };
    } catch (error) {
      if (OAuthError.isInstance(error)) {
        throw error;
      }
      throw new OAuthError(
        OAuthErrorCode.InvalidToken,
        "Access token is invalid",
      );
    }
  }
}

export function telechirUserId(authInfo: AuthInfo | undefined): string {
  const value = authInfo?.extra?.telechir_user_id;
  if (typeof value !== "string" || value.length === 0) {
    throw new OAuthError(
      OAuthErrorCode.InvalidToken,
      "Authenticated Telechir user is unavailable",
    );
  }
  return value;
}

export function clearOAuthDocumentCachesForTests(): void {
  metadataCache.clear();
  jwksCache.clear();
}
