import type { Env } from "./env";
import { dashboardHttpRoute } from "./dashboard-http";
import { bindingStatus, coreBindingsReady } from "./env";
import { failure, success } from "./http";
import { mcpHttpRoute } from "./mcp-http";
import { PROJECT_PHASE, SERVICE_NAME, SERVICE_VERSION } from "./meta";
import { protectedResourceMetadataResponse } from "./oauth";
import { pairingHttpRoute } from "./pairing-http";
import { realtimeHttpRoute } from "./realtime-http";

export { DeviceCoordinator } from "./device-coordinator";

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/health") {
    return success({
      service: SERVICE_NAME,
      status: "ok",
      phase: PROJECT_PHASE,
      version: SERVICE_VERSION,
    });
  }

  if (request.method === "GET" && url.pathname === "/ready") {
    const bindings = bindingStatus(env);
    const ready = coreBindingsReady(bindings);

    return success(
      {
        service: SERVICE_NAME,
        status: ready ? "ready" : "not_ready",
        bindings,
      },
      ready ? 200 : 503,
    );
  }

  if (request.method === "GET" && url.pathname === "/version") {
    return success({
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      phase: PROJECT_PHASE,
    });
  }

  if (url.pathname === "/.well-known/oauth-protected-resource") {
    return protectedResourceMetadataResponse(env, request);
  }

  const mcpResponse = await mcpHttpRoute(request, env, url);
  if (mcpResponse) {
    return mcpResponse;
  }

  const pairingResponse = await pairingHttpRoute(request, env, url);
  if (pairingResponse) {
    return pairingResponse;
  }

  const realtimeResponse = await realtimeHttpRoute(request, env, url);
  if (realtimeResponse) {
    return realtimeResponse;
  }

  const dashboardResponse = await dashboardHttpRoute(request, env, url);
  if (dashboardResponse) {
    return dashboardResponse;
  }

  return failure("ROUTE_NOT_FOUND", "Route not found", 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return route(request, env);
  },
} satisfies ExportedHandler<Env>;
