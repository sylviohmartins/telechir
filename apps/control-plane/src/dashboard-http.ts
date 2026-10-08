import {
  requireBearerAuth,
  type AuthInfo,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";

import { DASHBOARD_OAUTH_SCOPES } from "./dashboard-scopes";
import { DeviceToolsService } from "./device-tools";
import type { Env } from "./env";
import { failure, success } from "./http";

import {
  JwtAccessTokenVerifier,
  oauthConfigFromEnv,
  telechirUserId,
} from "./oauth";
import { revokeDeviceAndCloseRealtime } from "./realtime";

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 30;

interface SessionRow {
  id: string;
  ai_client_type: string;
  started_at: string;
  ended_at: string | null;
  last_seen_at: string;
}

interface CommandRow {
  id: string;
  device_id: string;
  device_name: string;
  session_id: string;
  workspace_id: string;
  workspace_name: string;
  workspace_fencing_token: number | null;
  tool_name: string;
  operation: string;
  risk: string;
  state: string;
  requested_at: string;
  accepted_at: string | null;
  completed_at: string | null;
  error_code: string | null;
}

interface ApprovalView {
  id: string;
  device_id: string;
  session_id: string;
  command_id: string | null;
  permission: string;
  risk: string;
  scope: "once" | "session";
  decision: "APPROVE" | "DENY" | null;
  requested_at: string;
  decided_at: string | null;
  expires_at: string;
  consumed_at: string | null;
  device_name: string;
  tool_name: string | null;
  operation: string | null;
  human_summary: string;
}

interface AuditRow {
  id: string;
  device_id: string | null;
  session_id: string | null;
  command_id: string | null;
  event_type: string;
  decision: string | null;
  risk: string | null;
  metadata_json: string;
  created_at: string;
}

function pageSize(url: URL): number {
  const raw = Number(url.searchParams.get("limit") ?? DEFAULT_PAGE_SIZE);
  if (!Number.isInteger(raw) || raw < 1) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(raw, MAX_PAGE_SIZE);
}

function safeMetadata(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function authenticate(
  request: Request,
  env: Env,
  verifier?: OAuthTokenVerifier,
): Promise<AuthInfo | Response> {
  let config;
  try {
    config = oauthConfigFromEnv(env);
  } catch {
    return failure("SERVER_ERROR", "Dashboard OAuth is not configured", 503);
  }

  const gate = requireBearerAuth({
    verifier: verifier ?? new JwtAccessTokenVerifier(env.DB, config),
    resourceMetadataUrl: config.resourceMetadataUrl,
  });
  return gate(request);
}

function requireScope(auth: AuthInfo, scope: string): Response | null {
  if (!auth.scopes.includes(scope)) {
    return failure("FORBIDDEN", "Required dashboard scope is missing", 403);
  }
  return null;
}

async function listSessions(
  db: D1Database,
  userId: string,
  limit: number,
): Promise<SessionRow[]> {
  const result = await db
    .prepare(
      `SELECT id, ai_client_type, started_at, ended_at, last_seen_at
       FROM sessions
       WHERE user_id = ?
       ORDER BY last_seen_at DESC, id DESC
       LIMIT ?`,
    )
    .bind(userId, limit)
    .all<SessionRow>();
  return result.results;
}

async function listCommands(
  db: D1Database,
  userId: string,
  limit: number,
): Promise<CommandRow[]> {
  const result = await db
    .prepare(
      `SELECT c.id, c.device_id, d.display_name AS device_name, c.session_id,
              c.workspace_id,
              COALESCE(w.display_name, c.workspace_id) AS workspace_name,
              c.workspace_fencing_token,
              c.tool_name, c.operation, c.risk, c.state, c.requested_at,
              c.accepted_at, c.completed_at, c.error_code
       FROM commands c
       JOIN sessions s ON s.id = c.session_id
       JOIN devices d ON d.id = c.device_id
       LEFT JOIN workspaces w
         ON w.id = c.workspace_id
        AND w.user_id = s.user_id
        AND w.device_id = c.device_id
       WHERE s.user_id = ?
       ORDER BY c.requested_at DESC, c.id DESC
       LIMIT ?`,
    )
    .bind(userId, limit)
    .all<CommandRow>();
  return result.results;
}

async function listApprovals(
  db: D1Database,
  userId: string,
  limit: number,
): Promise<ApprovalView[]> {
  const result = await db
    .prepare(
      `SELECT a.id, a.device_id, a.session_id, a.command_id,
              a.permission, a.risk, a.scope, a.decision,
              a.requested_at, a.decided_at, a.expires_at, a.consumed_at,
              d.display_name AS device_name,
              c.tool_name, c.operation,
              COALESCE(
                c.tool_name || ' · ' || c.operation,
                'Approval de ' || a.permission
              ) AS human_summary
       FROM approvals a
       JOIN devices d ON d.id = a.device_id
       LEFT JOIN commands c ON c.id = a.command_id
       WHERE a.user_id = ?
       ORDER BY a.requested_at DESC, a.id DESC
       LIMIT ?`,
    )
    .bind(userId, limit)
    .all<ApprovalView>();
  return result.results;
}

async function listAudit(
  db: D1Database,
  userId: string,
  limit: number,
): Promise<
  Array<Omit<AuditRow, "metadata_json"> & { metadata: Record<string, unknown> }>
> {
  const result = await db
    .prepare(
      `SELECT id, device_id, session_id, command_id, event_type, decision,
              risk, metadata_json, created_at
       FROM audit_events
       WHERE user_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .bind(userId, limit)
    .all<AuditRow>();
  return result.results.map(({ metadata_json, ...row }) => ({
    ...row,
    metadata: safeMetadata(metadata_json),
  }));
}

async function usageSummary(db: D1Database, userId: string) {
  const row = await db
    .prepare(
      `SELECT
         COUNT(*) AS tool_calls,
         SUM(CASE WHEN c.state = 'COMPLETED' THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN c.state = 'FAILED' THEN 1 ELSE 0 END) AS failed,
         AVG(
           CASE
             WHEN c.completed_at IS NOT NULL
             THEN (julianday(c.completed_at) - julianday(c.requested_at)) * 86400000.0
             ELSE NULL
           END
         ) AS avg_latency_ms
       FROM commands c
       JOIN sessions s ON s.id = c.session_id
       WHERE s.user_id = ?`,
    )
    .bind(userId)
    .first<{
      tool_calls: number;
      completed: number | null;
      failed: number | null;
      avg_latency_ms: number | null;
    }>();

  const artifacts = await db
    .prepare(
      `SELECT COALESCE(SUM(size_bytes), 0) AS bytes
       FROM artifacts
       WHERE user_id = ? AND deleted_at IS NULL`,
    )
    .bind(userId)
    .first<{ bytes: number }>();

  return {
    tool_calls: Number(row?.tool_calls ?? 0),
    completed: Number(row?.completed ?? 0),
    failed: Number(row?.failed ?? 0),
    avg_latency_ms:
      row?.avg_latency_ms === null || row?.avg_latency_ms === undefined
        ? null
        : Math.round(Number(row.avg_latency_ms)),
    artifact_bytes: Number(artifacts?.bytes ?? 0),
  };
}

async function decideApproval(
  request: Request,
  env: Env,
  userId: string,
  approvalId: string,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return failure("INVALID_ARGUMENT", "Invalid JSON body", 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return failure("INVALID_ARGUMENT", "Invalid approval decision", 400);
  }
  const input = body as Record<string, unknown>;
  if (
    (input.decision !== "APPROVE" && input.decision !== "DENY") ||
    (input.scope !== "once" && input.scope !== "session")
  ) {
    return failure("INVALID_ARGUMENT", "Invalid approval decision", 400);
  }

  const approval = await env.DB.prepare(
    `SELECT id, user_id, device_id, session_id, expires_at,
            decision, consumed_at
     FROM approvals
     WHERE id = ? AND user_id = ?`,
  )
    .bind(approvalId, userId)
    .first<{
      id: string;
      user_id: string;
      device_id: string;
      session_id: string;
      expires_at: string;
      decision: "APPROVE" | "DENY" | null;
      consumed_at: string | null;
    }>();
  if (!approval) {
    return failure("NOT_FOUND", "Approval not found", 404);
  }
  if (
    approval.decision !== null ||
    approval.consumed_at !== null ||
    approval.expires_at <= new Date().toISOString()
  ) {
    return failure("CONFLICT", "Approval cannot be decided", 409);
  }

  const coordinator = env.DEVICE_COORDINATOR.get(
    env.DEVICE_COORDINATOR.idFromName(approval.device_id),
  );
  const response = await coordinator.fetch(
    `https://device-coordinator/internal/approvals/${encodeURIComponent(approval.id)}/decision`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telechir-device-id": approval.device_id,
      },
      body: JSON.stringify({
        user_id: userId,
        session_id: approval.session_id,
        decision: input.decision,
        scope: input.scope,
      }),
    },
  );

  if (!response.ok) {
    if (response.status === 404) {
      return failure("NOT_FOUND", "Approval not found", 404);
    }
    if (response.status === 409) {
      return failure("CONFLICT", "Approval cannot be decided", 409);
    }
    return failure("INTERNAL_ERROR", "Approval decision failed", 502);
  }

  return success({
    approval_id: approval.id,
    decision: input.decision,
    scope: input.scope,
  });
}

async function revokeDevice(
  env: Env,
  userId: string,
  deviceId: string,
  request: Request,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return failure("INVALID_ARGUMENT", "Invalid JSON body", 400);
  }
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    (body as Record<string, unknown>).confirm !== true
  ) {
    return failure(
      "CONFIRMATION_REQUIRED",
      "Device revocation requires explicit confirmation",
      400,
    );
  }

  const owned = await env.DB.prepare(
    "SELECT revoked_at FROM devices WHERE id = ? AND user_id = ?",
  )
    .bind(deviceId, userId)
    .first<{ revoked_at: string | null }>();
  if (!owned) {
    return failure("NOT_FOUND", "Device not found", 404);
  }
  if (owned.revoked_at) {
    return success({ device_id: deviceId, revoked_at: owned.revoked_at });
  }

  try {
    return success(await revokeDeviceAndCloseRealtime(env, userId, deviceId));
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as { code?: string }).code === "NOT_FOUND"
    ) {
      return failure("NOT_FOUND", "Device not found", 404);
    }
    return failure("INTERNAL_ERROR", "Device revocation failed", 500);
  }
}

export async function dashboardHttpRoute(
  request: Request,
  env: Env,
  url: URL,
  verifier?: OAuthTokenVerifier,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/dashboard/api/")) {
    return null;
  }

  const auth = await authenticate(request, env, verifier);
  if (auth instanceof Response) {
    return auth;
  }

  let userId: string;
  try {
    userId = telechirUserId(auth);
  } catch {
    return failure("UNAUTHENTICATED", "Authentication is required", 401);
  }

  const limit = pageSize(url);

  if (request.method === "GET" && url.pathname === "/dashboard/api/overview") {
    const denied = requireScope(auth, DASHBOARD_OAUTH_SCOPES.read);
    if (denied) {
      return denied;
    }
    const [devices, sessions, commands, approvals, audit, usage] =
      await Promise.all([
        new DeviceToolsService(env.DB, env.DEVICE_COORDINATOR).listDevices(
          userId,
          { status: "all" },
        ),
        listSessions(env.DB, userId, limit),
        listCommands(env.DB, userId, limit),
        listApprovals(env.DB, userId, limit),
        listAudit(env.DB, userId, limit),
        usageSummary(env.DB, userId),
      ]);
    return success({
      devices: devices.devices,
      sessions,
      commands,
      approvals,
      audit,
      usage,
    });
  }

  const approvalDecision = url.pathname.match(
    /^\/dashboard\/api\/approvals\/([^/]+)\/decision$/u,
  );
  if (request.method === "POST" && approvalDecision?.[1]) {
    const denied = requireScope(auth, DASHBOARD_OAUTH_SCOPES.decideApprovals);
    if (denied) {
      return denied;
    }
    return decideApproval(
      request,
      env,
      userId,
      decodeURIComponent(approvalDecision[1]),
    );
  }

  const revoke = url.pathname.match(
    /^\/dashboard\/api\/devices\/([^/]+)\/revoke$/u,
  );
  if (request.method === "POST" && revoke?.[1]) {
    const denied = requireScope(auth, DASHBOARD_OAUTH_SCOPES.revokeDevices);
    if (denied) {
      return denied;
    }
    return revokeDevice(env, userId, decodeURIComponent(revoke[1]), request);
  }

  return failure("ROUTE_NOT_FOUND", "Dashboard API route not found", 404);
}
