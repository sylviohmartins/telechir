import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import type { Env } from "../src/env";
import { AuditService, redactAuditMetadata } from "../src/audit";
import { GovernanceError, GovernanceService } from "../src/governance";

const bindings = env as unknown as Env;
const PROVIDER = "phase9-governance-test";

interface Fixture {
  userId: string;
  deviceId: string;
}

async function seedFixture(): Promise<Fixture> {
  const userId = crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  const now = new Date().toISOString();

  await bindings.DB.prepare(
    `INSERT INTO users (
       id, identity_provider, provider_subject_hash, display_name,
       created_at, disabled_at
     ) VALUES (?, ?, ?, 'Phase 9 User', ?, NULL)`,
  )
    .bind(userId, PROVIDER, `subject-${userId}`, now)
    .run();

  await bindings.DB.prepare(
    `INSERT INTO devices (
       id, user_id, display_name, os, arch, agent_version,
       status_hint, last_seen_at, created_at, revoked_at
     ) VALUES (?, ?, 'Phase 9 Device', 'linux', 'x86_64', '0.1.0',
               'offline', NULL, ?, NULL)`,
  )
    .bind(deviceId, userId, now)
    .run();

  return { userId, deviceId };
}

async function cleanup(): Promise<void> {
  const users = `SELECT id FROM users WHERE identity_provider = '${PROVIDER}'`;
  await bindings.DB.prepare(
    `DELETE FROM audit_events WHERE user_id IN (${users})`,
  ).run();
  await bindings.DB.prepare(
    `DELETE FROM approvals WHERE user_id IN (${users})`,
  ).run();
  await bindings.DB.prepare(
    `DELETE FROM commands
     WHERE session_id IN (
       SELECT id FROM sessions WHERE user_id IN (${users})
     )`,
  ).run();
  await bindings.DB.prepare(
    `DELETE FROM policy_restrictions
     WHERE scope_id IN (${users})
        OR scope_id IN (
          SELECT id FROM devices WHERE user_id IN (${users})
        )
        OR scope_id IN (
          SELECT id FROM sessions WHERE user_id IN (${users})
        )`,
  ).run();
  await bindings.DB.prepare(
    `DELETE FROM sessions WHERE user_id IN (${users})`,
  ).run();
  await bindings.DB.prepare(
    `DELETE FROM devices WHERE user_id IN (${users})`,
  ).run();
  await bindings.DB.prepare(
    `DELETE FROM users WHERE identity_provider = '${PROVIDER}'`,
  ).run();
}

function input(fixture: Fixture, commandId: string) {
  return {
    commandId,
    userId: fixture.userId,
    caller: { clientId: "phase9-client", expiresAt: 1_900_000_000 },
    deviceId: fixture.deviceId,
    toolName: "write_file",
    operation: "fs.write",
    arguments: {
      path: "notes.txt",
      content: "safe payload",
      encoding: "utf-8",
    },
    requestedPermissions: ["FS_WRITE"] as const,
    risk: "MEDIUM" as const,
    idempotencyKey: `idem_${commandId}`,
  };
}

beforeEach(cleanup);

describe("Phase 9 governance", () => {
  it("remote ALLOW never becomes local authority", async () => {
    const fixture = await seedFixture();
    await bindings.DB.prepare(
      `INSERT INTO policy_restrictions (
         id, scope_type, scope_id, permission, effect,
         constraint_json, revision, created_at, expires_at
       ) VALUES (?, 'device', ?, 'FS_WRITE', 'ALLOW', '{}', 'remote-v1', ?, NULL)`,
    )
      .bind(
        `restriction_${crypto.randomUUID()}`,
        fixture.deviceId,
        new Date().toISOString(),
      )
      .run();

    const governed = await new GovernanceService(bindings.DB).prepareCommand(
      input(fixture, `cmd_${crypto.randomUUID()}`),
    );

    expect(governed.approvalId).toBeNull();
    expect(governed.policyRevision).toBe("remote-v1");
  });

  it("remote DENY fails closed before dispatch", async () => {
    const fixture = await seedFixture();
    await bindings.DB.prepare(
      `INSERT INTO policy_restrictions (
         id, scope_type, scope_id, permission, effect,
         constraint_json, revision, created_at, expires_at
       ) VALUES (?, 'device', ?, 'FS_WRITE', 'DENY', '{}', 'deny-v1', ?, NULL)`,
    )
      .bind(
        `restriction_${crypto.randomUUID()}`,
        fixture.deviceId,
        new Date().toISOString(),
      )
      .run();

    await expect(
      new GovernanceService(bindings.DB).prepareCommand(
        input(fixture, `cmd_${crypto.randomUUID()}`),
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  });

  it("remote ASK requires approval but never forwards it as agent authority", async () => {
    const fixture = await seedFixture();
    await bindings.DB.prepare(
      `INSERT INTO policy_restrictions (
         id, scope_type, scope_id, permission, effect,
         constraint_json, revision, created_at, expires_at
       ) VALUES (?, 'device', ?, 'FS_WRITE', 'ASK', '{}', 'ask-v1', ?, NULL)`,
    )
      .bind(
        `restriction_${crypto.randomUUID()}`,
        fixture.deviceId,
        new Date().toISOString(),
      )
      .run();

    const service = new GovernanceService(bindings.DB);
    const commandId = `cmd_${crypto.randomUUID()}`;
    let approvalId = "";
    try {
      await service.prepareCommand(input(fixture, commandId));
      throw new Error("expected APPROVAL_REQUIRED");
    } catch (error) {
      expect(error).toBeInstanceOf(GovernanceError);
      const governanceError = error as GovernanceError;
      expect(governanceError.code).toBe("APPROVAL_REQUIRED");
      approvalId = governanceError.approvalId ?? "";
    }
    expect(approvalId).toMatch(/^approval_/u);

    const approval = await service.approval(approvalId);
    expect(approval).not.toBeNull();
    await service.decideApproval({
      approvalId,
      userId: fixture.userId,
      deviceId: fixture.deviceId,
      sessionId: approval!.session_id,
      decision: "APPROVE",
      scope: "once",
    });

    const retried = await service.prepareCommand(
      input(fixture, `cmd_${crypto.randomUUID()}`),
    );
    expect(retried.approvalId).toBeNull();

    const consumed = await service.approval(approvalId);
    expect(consumed?.consumed_at).not.toBeNull();
  });

  it("expired approvals and double consumption are rejected", async () => {
    const fixture = await seedFixture();
    const service = new GovernanceService(bindings.DB);
    const now = new Date();
    const sessionId = `session_${crypto.randomUUID()}`;

    await bindings.DB.prepare(
      `INSERT INTO sessions (
         id, user_id, ai_client_type, client_instance_hash,
         started_at, ended_at, last_seen_at
       ) VALUES (?, ?, 'test', NULL, ?, NULL, ?)`,
    )
      .bind(sessionId, fixture.userId, now.toISOString(), now.toISOString())
      .run();

    const expiredId = `approval_${crypto.randomUUID()}`;
    await bindings.DB.prepare(
      `INSERT INTO approvals (
         id, user_id, device_id, session_id, command_id,
         permission, risk, scope, argument_digest, decision,
         requested_at, decided_at, expires_at, consumed_at
       ) VALUES (?, ?, ?, ?, NULL, 'FS_WRITE', 'MEDIUM', 'once',
                 ?, NULL, ?, NULL, ?, NULL)`,
    )
      .bind(
        expiredId,
        fixture.userId,
        fixture.deviceId,
        sessionId,
        "A".repeat(43),
        new Date(now.getTime() - 120_000).toISOString(),
        new Date(now.getTime() - 60_000).toISOString(),
      )
      .run();

    await expect(
      service.decideApproval({
        approvalId: expiredId,
        userId: fixture.userId,
        deviceId: fixture.deviceId,
        sessionId,
        decision: "APPROVE",
        scope: "once",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const onceId = `approval_${crypto.randomUUID()}`;
    await bindings.DB.prepare(
      `INSERT INTO approvals (
         id, user_id, device_id, session_id, command_id,
         permission, risk, scope, argument_digest, decision,
         requested_at, decided_at, expires_at, consumed_at
       ) VALUES (?, ?, ?, ?, NULL, 'FS_WRITE', 'MEDIUM', 'once',
                 ?, 'APPROVE', ?, ?, ?, NULL)`,
    )
      .bind(
        onceId,
        fixture.userId,
        fixture.deviceId,
        sessionId,
        "B".repeat(43),
        now.toISOString(),
        now.toISOString(),
        new Date(now.getTime() + 60_000).toISOString(),
      )
      .run();

    await expect(service.consumeApproval(onceId)).resolves.toBeUndefined();
    await expect(service.consumeApproval(onceId)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("agent approval id collision with different binding fails closed", async () => {
    const fixture = await seedFixture();
    const service = new GovernanceService(bindings.DB);
    const commandId = `cmd_${crypto.randomUUID()}`;
    const governed = await service.prepareCommand(input(fixture, commandId));
    const approvalId = `approval_${crypto.randomUUID()}`;
    const expiresAt = new Date(Date.now() + 60_000).toISOString();

    await service.recordAgentApprovalRequest({
      approvalId,
      commandId,
      userId: fixture.userId,
      deviceId: fixture.deviceId,
      sessionId: governed.sessionId,
      permission: "FS_WRITE",
      risk: "MEDIUM",
      argumentDigest: governed.argumentDigest,
      expiresAt,
    });

    await expect(
      service.recordAgentApprovalRequest({
        approvalId,
        commandId,
        userId: fixture.userId,
        deviceId: fixture.deviceId,
        sessionId: governed.sessionId,
        permission: "FS_WRITE",
        risk: "HIGH",
        argumentDigest: governed.argumentDigest,
        expiresAt,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("Phase 9 audit redaction", () => {
  it("redacts sensitive keys and bearer values before persistence", async () => {
    const redacted = redactAuditMetadata({
      authorization: "Bearer secret-token-value",
      nested: {
        api_key: "abc123",
        note: "prefix Bearer abcdefghijklmnopqrstuvwxyz suffix",
      },
    });
    expect(redacted.authorization).toBe("[REDACTED]");
    expect(redacted.nested).toEqual({
      api_key: "[REDACTED]",
      note: "prefix Bearer [REDACTED] suffix",
    });

    const eventId = await new AuditService(bindings.DB).append({
      eventType: "REDACTION_TEST",
      metadata: {
        token: "must-not-persist",
        note: "Bearer abcdefghijklmnopqrstuvwxyz",
      },
    });
    const row = await bindings.DB.prepare(
      "SELECT metadata_json FROM audit_events WHERE id = ?",
    )
      .bind(eventId)
      .first<{ metadata_json: string }>();
    expect(row?.metadata_json).not.toContain("must-not-persist");
    expect(row?.metadata_json).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });
});
