import { env } from "cloudflare:workers";
import type {
  AuthInfo,
  OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it } from "vitest";

import { dashboardHttpRoute } from "../src/dashboard-http";
import { DASHBOARD_OAUTH_SCOPES } from "../src/dashboard-scopes";
import type { Env } from "../src/env";

const bindings = env as unknown as Env;
const resource = "https://telechir.test/mcp";

function authInfo(
  userId: string,
  scopes: string[] = Object.values(DASHBOARD_OAUTH_SCOPES),
): AuthInfo {
  return {
    token: "dashboard-test-token",
    clientId: "dashboard-test-client",
    scopes,
    expiresAt: Math.floor(Date.now() / 1000) + 300,
    resource: new URL(resource),
    resourceMetadataUrl:
      "https://telechir.test/.well-known/oauth-protected-resource",
    extra: { telechir_user_id: userId },
  };
}

function verifier(
  userId: string,
  scopes: string[] = Object.values(DASHBOARD_OAUTH_SCOPES),
): OAuthTokenVerifier {
  return {
    async verifyAccessToken(): Promise<AuthInfo> {
      return authInfo(userId, scopes);
    },
  };
}

async function seedUser(name: string): Promise<string> {
  const id = crypto.randomUUID();
  await bindings.DB.prepare(
    `INSERT INTO users (
       id, identity_provider, provider_subject_hash, display_name,
       created_at, disabled_at
     ) VALUES (?, 'dashboard-test', ?, ?, ?, NULL)`,
  )
    .bind(id, `subject-${id}`, name, new Date().toISOString())
    .run();
  return id;
}

async function seedDevice(userId: string, name: string): Promise<string> {
  const id = crypto.randomUUID();
  await bindings.DB.prepare(
    `INSERT INTO devices (
       id, user_id, display_name, os, arch, agent_version,
       status_hint, last_seen_at, created_at, revoked_at
     ) VALUES (?, ?, ?, 'linux', 'x86_64', '0.10.0',
               'offline', ?, ?, NULL)`,
  )
    .bind(id, userId, name, new Date().toISOString(), new Date().toISOString())
    .run();
  return id;
}

async function seedSession(userId: string): Promise<string> {
  const id = `session_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await bindings.DB.prepare(
    `INSERT INTO sessions (
       id, user_id, ai_client_type, client_instance_hash,
       started_at, ended_at, last_seen_at
     ) VALUES (?, ?, 'test-client', NULL, ?, NULL, ?)`,
  )
    .bind(id, userId, now, now)
    .run();
  return id;
}

async function seedCommand(
  deviceId: string,
  sessionId: string,
  state = "COMPLETED",
): Promise<string> {
  const id = `command_${crypto.randomUUID()}`;
  const requested = new Date(Date.now() - 100).toISOString();
  const completed = new Date().toISOString();
  await bindings.DB.prepare(
    `INSERT INTO commands (
       id, device_id, session_id, tool_name, operation,
       idempotency_key_hash, argument_digest, risk, state,
       requested_at, accepted_at, completed_at, error_code, artifact_id
     ) VALUES (?, ?, ?, 'read_file', 'fs.read', NULL, ?, 'LOW', ?,
               ?, ?, ?, NULL, NULL)`,
  )
    .bind(
      id,
      deviceId,
      sessionId,
      "digest",
      state,
      requested,
      requested,
      completed,
    )
    .run();
  return id;
}

async function seedApproval(input: {
  userId: string;
  deviceId: string;
  sessionId: string;
  commandId: string;
  expired?: boolean;
}): Promise<string> {
  const id = `approval_${crypto.randomUUID()}`;
  const now = new Date();
  const expires = new Date(
    now.getTime() + (input.expired ? -60_000 : 60_000),
  ).toISOString();
  await bindings.DB.prepare(
    `INSERT INTO approvals (
       id, user_id, device_id, session_id, command_id,
       permission, risk, scope, argument_digest, decision,
       requested_at, decided_at, expires_at, consumed_at
     ) VALUES (?, ?, ?, ?, ?, 'FS_READ', 'LOW', 'once', ?,
               NULL, ?, NULL, ?, NULL)`,
  )
    .bind(
      id,
      input.userId,
      input.deviceId,
      input.sessionId,
      input.commandId,
      "digest",
      now.toISOString(),
      expires,
    )
    .run();
  return id;
}

async function call(
  userId: string,
  path: string,
  init: RequestInit = {},
  scopes: string[] = Object.values(DASHBOARD_OAUTH_SCOPES),
): Promise<Response> {
  const request = new Request(`https://telechir.test${path}`, {
    ...init,
    headers: {
      authorization: "Bearer dashboard-test-token",
      ...(init.headers ?? {}),
    },
  });
  const response = await dashboardHttpRoute(
    request,
    bindings,
    new URL(request.url),
    verifier(userId, scopes),
  );
  if (!response) {
    throw new Error("dashboard route did not handle request");
  }
  return response;
}

beforeEach(async () => {
  await bindings.DB.exec(
    `DELETE FROM audit_events;
     DELETE FROM approvals;
     DELETE FROM commands;
     DELETE FROM sessions;
     DELETE FROM pairings;
     DELETE FROM device_keys;
     DELETE FROM workspaces;
     DELETE FROM devices;
     DELETE FROM users;`,
  );
});

describe("dashboard HTTP API", () => {
  it("returns only state owned by the authenticated user", async () => {
    const userA = await seedUser("User A");
    const userB = await seedUser("User B");
    const deviceA = await seedDevice(userA, "Device A");
    const deviceB = await seedDevice(userB, "Device B");
    const sessionA = await seedSession(userA);
    const sessionB = await seedSession(userB);
    await seedCommand(deviceA, sessionA);
    await seedCommand(deviceB, sessionB);

    const response = await call(userA, "/dashboard/api/overview");
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      data: {
        devices: Array<{ device_id: string }>;
        sessions: Array<{ id: string }>;
        commands: Array<{ device_id: string }>;
      };
    };
    expect(body.data.devices.map((item) => item.device_id)).toEqual([deviceA]);
    expect(body.data.sessions.map((item) => item.id)).toEqual([sessionA]);
    expect(body.data.commands.map((item) => item.device_id)).toEqual([deviceA]);
  });

  it("does not reveal another user's approval identifier", async () => {
    const owner = await seedUser("Owner");
    const attacker = await seedUser("Attacker");
    const device = await seedDevice(owner, "Owner Device");
    const session = await seedSession(owner);
    const command = await seedCommand(device, session, "WAITING_APPROVAL");
    const approval = await seedApproval({
      userId: owner,
      deviceId: device,
      sessionId: session,
      commandId: command,
    });

    const response = await call(
      attacker,
      `/dashboard/api/approvals/${approval}/decision`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "APPROVE", scope: "once" }),
      },
    );
    expect(response.status).toBe(404);
  });

  it("rejects an expired approval before contacting the device", async () => {
    const user = await seedUser("Owner");
    const device = await seedDevice(user, "Device");
    const session = await seedSession(user);
    const command = await seedCommand(device, session, "WAITING_APPROVAL");
    const approval = await seedApproval({
      userId: user,
      deviceId: device,
      sessionId: session,
      commandId: command,
      expired: true,
    });

    const response = await call(
      user,
      `/dashboard/api/approvals/${approval}/decision`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "APPROVE", scope: "once" }),
      },
    );
    expect(response.status).toBe(409);
  });

  it("requires explicit confirmation before device revocation", async () => {
    const user = await seedUser("Owner");
    const device = await seedDevice(user, "Device");

    const response = await call(
      user,
      `/dashboard/api/devices/${device}/revoke`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: false }),
      },
    );
    expect(response.status).toBe(400);

    const row = await bindings.DB.prepare(
      "SELECT revoked_at FROM devices WHERE id = ?",
    )
      .bind(device)
      .first<{ revoked_at: string | null }>();
    expect(row?.revoked_at).toBeNull();
  });

  it("rejects dashboard access when the required scope is absent", async () => {
    const user = await seedUser("Scoped User");

    const response = await call(user, "/dashboard/api/overview", {}, [
      "telechir:devices:read",
    ]);

    expect(response.status).toBe(403);
  });

  it("rejects a second approval decision before dispatching again", async () => {
    const user = await seedUser("Owner");
    const device = await seedDevice(user, "Device");
    const session = await seedSession(user);
    const command = await seedCommand(device, session, "WAITING_APPROVAL");
    const approval = await seedApproval({
      userId: user,
      deviceId: device,
      sessionId: session,
      commandId: command,
    });
    await bindings.DB.prepare(
      "UPDATE approvals SET decision = 'APPROVE', decided_at = ? WHERE id = ?",
    )
      .bind(new Date().toISOString(), approval)
      .run();

    const response = await call(
      user,
      `/dashboard/api/approvals/${approval}/decision`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "APPROVE", scope: "once" }),
      },
    );

    expect(response.status).toBe(409);
  });

  it("does not reveal or revoke another user's device", async () => {
    const owner = await seedUser("Owner");
    const attacker = await seedUser("Attacker");
    const device = await seedDevice(owner, "Owner Device");

    const response = await call(
      attacker,
      `/dashboard/api/devices/${device}/revoke`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      },
    );

    expect(response.status).toBe(404);
    const row = await bindings.DB.prepare(
      "SELECT revoked_at FROM devices WHERE id = ?",
    )
      .bind(device)
      .first<{ revoked_at: string | null }>();
    expect(row?.revoked_at).toBeNull();
  });
});
