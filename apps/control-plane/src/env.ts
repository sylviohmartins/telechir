export interface Env {
  DB: D1Database;
  DEVICE_COORDINATOR: DurableObjectNamespace;
  PAIRING_SERVER_SECRET?: string;
  PAIRING_VERIFICATION_URI?: string;
  REALTIME_SERVER_SECRET?: string;
  MCP_RESOURCE_URI?: string;
  OAUTH_ISSUER?: string;
  OAUTH_JWKS_URI?: string;
  OAUTH_SUBJECT_CLAIM?: string;
  OAUTH_SCOPE_CLAIM?: string;
  OPENAI_APPS_CHALLENGE_TOKEN?: string;
  ARTIFACTS?: R2Bucket;
  TELEMETRY?: AnalyticsEngineDataset;
  ASYNC_TASKS?: Queue;
}

export interface BindingStatus {
  d1: boolean;
  durableObjects: boolean;
  pairingServerSecret: boolean;
  pairingVerificationUri: boolean;
  realtimeServerSecret: boolean;
  mcpResourceUri: boolean;
  oauthIssuer: boolean;
  r2: boolean;
  analyticsEngine: boolean;
  queues: boolean;
}

export function bindingStatus(env: Env): BindingStatus {
  return {
    d1: env.DB !== undefined,
    durableObjects: env.DEVICE_COORDINATOR !== undefined,
    pairingServerSecret:
      typeof env.PAIRING_SERVER_SECRET === "string" &&
      env.PAIRING_SERVER_SECRET.length >= 32,
    pairingVerificationUri:
      typeof env.PAIRING_VERIFICATION_URI === "string" &&
      env.PAIRING_VERIFICATION_URI.length > 0,
    realtimeServerSecret:
      typeof env.REALTIME_SERVER_SECRET === "string" &&
      env.REALTIME_SERVER_SECRET.length >= 32,
    mcpResourceUri:
      typeof env.MCP_RESOURCE_URI === "string" &&
      env.MCP_RESOURCE_URI.startsWith("https://") &&
      env.MCP_RESOURCE_URI.endsWith("/mcp"),
    oauthIssuer:
      typeof env.OAUTH_ISSUER === "string" &&
      env.OAUTH_ISSUER.startsWith("https://"),
    r2: env.ARTIFACTS !== undefined,
    analyticsEngine: env.TELEMETRY !== undefined,
    queues: env.ASYNC_TASKS !== undefined,
  };
}

export function coreBindingsReady(status: BindingStatus): boolean {
  return (
    status.d1 &&
    status.durableObjects &&
    status.pairingServerSecret &&
    status.pairingVerificationUri &&
    status.realtimeServerSecret &&
    status.mcpResourceUri &&
    status.oauthIssuer
  );
}
