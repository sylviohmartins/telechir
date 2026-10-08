import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import type { Env } from "../src/env";
import { GitToolsError, GitToolsService } from "../src/git-tools";

const bindings = env as unknown as Env;

interface TestDevice {
  userId: string;
  deviceId: string;
  socket: WebSocket | null;
  connectionId: string | null;
}

function nextMessage(socket: WebSocket): Promise<MessageEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out waiting for Git command")),
      2_000,
    );
    socket.addEventListener(
      "message",
      (event) => {
        clearTimeout(timer);
        resolve(event);
      },
      { once: true },
    );
  });
}

function agentFrame(input: {
  deviceId: string;
  connectionId: string;
  sequence: number;
  messageType: string;
  payload: Record<string, unknown>;
}): string {
  return JSON.stringify({
    protocol_version: "0.1",
    message_type: input.messageType,
    message_id: `msg_${crypto.randomUUID()}`,
    correlation_id: null,
    device_id: input.deviceId,
    session_id: null,
    connection_id: input.connectionId,
    sequence: input.sequence,
    sent_at: new Date().toISOString(),
    deadline_at: null,
    payload: input.payload,
  });
}

async function seedDevice(
  capabilities: string[] | null,
  userId = crypto.randomUUID(),
): Promise<TestDevice> {
  const deviceId = crypto.randomUUID();
  const now = new Date().toISOString();

  const existing = await bindings.DB.prepare(
    "SELECT id FROM users WHERE id = ?",
  )
    .bind(userId)
    .first<{ id: string }>();
  if (!existing) {
    await bindings.DB.prepare(
      `INSERT INTO users (
        id, identity_provider, provider_subject_hash, display_name,
        created_at, disabled_at
      ) VALUES (?, 'phase8-test', ?, 'Git User', ?, NULL)`,
    )
      .bind(userId, `subject-${userId}`, now)
      .run();
  }

  await bindings.DB.prepare(
    `INSERT INTO devices (
      id, user_id, display_name, os, arch, agent_version,
      status_hint, last_seen_at, created_at, revoked_at
    ) VALUES (?, ?, 'Git Device', 'linux', 'x86_64', '0.1.0',
              'offline', NULL, ?, NULL)`,
  )
    .bind(deviceId, userId, now)
    .run();

  if (capabilities === null) {
    return { userId, deviceId, socket: null, connectionId: null };
  }

  const coordinator = bindings.DEVICE_COORDINATOR.get(
    bindings.DEVICE_COORDINATOR.idFromName(deviceId),
  );
  const nonce = `nonce_${crypto.randomUUID()}`;
  const response = await coordinator.fetch(
    "https://device-coordinator/connect",
    {
      headers: {
        Upgrade: "websocket",
        "x-telechir-device-id": deviceId,
        "x-telechir-device-key-id": "phase8-device-key",
        "x-telechir-connection-nonce": nonce,
        "x-telechir-credential-jti": crypto.randomUUID(),
        "x-telechir-credential-expires-at": new Date(
          Date.now() + 60_000,
        ).toISOString(),
      },
    },
  );

  const socket = response.webSocket!;
  socket.accept();
  const helloAck = nextMessage(socket);
  socket.send(
    JSON.stringify({
      protocol_version: "0.1",
      message_type: "agent.hello",
      message_id: `msg_${crypto.randomUUID()}`,
      correlation_id: null,
      device_id: deviceId,
      session_id: null,
      connection_id: null,
      sequence: 0,
      sent_at: new Date().toISOString(),
      deadline_at: null,
      payload: {
        device_public_id: deviceId,
        device_key_id: "phase8-device-key",
        agent_version: "0.1.0",
        os: "linux",
        arch: "x86_64",
        supported_protocol_versions: ["0.1"],
        capabilities,
        connection_nonce: nonce,
      },
    }),
  );
  const ack = JSON.parse(String((await helloAck).data)) as {
    payload: { connection_id: string };
  };

  return {
    userId,
    deviceId,
    socket,
    connectionId: ack.payload.connection_id,
  };
}

async function respondCompleted(
  device: TestDevice,
  command: Record<string, unknown>,
  result: Record<string, unknown>,
): Promise<void> {
  const payload = command.payload as Record<string, unknown>;
  const commandId = payload.command_id as string;

  device.socket!.send(
    agentFrame({
      deviceId: device.deviceId,
      connectionId: device.connectionId!,
      sequence: 1,
      messageType: "command.accepted",
      payload: {
        command_id: commandId,
        accepted_at: new Date().toISOString(),
        process_id: null,
      },
    }),
  );
  device.socket!.send(
    agentFrame({
      deviceId: device.deviceId,
      connectionId: device.connectionId!,
      sequence: 2,
      messageType: "command.completed",
      payload: {
        command_id: commandId,
        completed_at: new Date().toISOString(),
        result,
      },
    }),
  );
}

beforeEach(async () => {
  const userFilter =
    "SELECT id FROM users WHERE identity_provider = 'phase8-test'";
  await bindings.DB.prepare(
    `DELETE FROM audit_events WHERE user_id IN (${userFilter})`,
  ).run();
  await bindings.DB.prepare(
    `DELETE FROM approvals WHERE user_id IN (${userFilter})`,
  ).run();
  await bindings.DB.prepare(
    `DELETE FROM commands
     WHERE session_id IN (
       SELECT id FROM sessions WHERE user_id IN (${userFilter})
     )`,
  ).run();
  await bindings.DB.prepare(
    `DELETE FROM sessions WHERE user_id IN (${userFilter})`,
  ).run();
  await bindings.DB.prepare(
    `DELETE FROM workspaces WHERE user_id IN (${userFilter})`,
  ).run();
  await bindings.DB.prepare(
    `DELETE FROM devices WHERE user_id IN (${userFilter})`,
  ).run();
  await bindings.DB.prepare(
    "DELETE FROM users WHERE identity_provider = 'phase8-test'",
  ).run();
});

describe("Phase 8 Git dispatch", () => {
  it("dispatches git.status as FS_READ / LOW with no idempotency or credential material", async () => {
    const device = await seedDevice(["git.status"]);
    const service = new GitToolsService(
      bindings.DB,
      bindings.DEVICE_COORDINATOR,
    );

    const commandMessage = nextMessage(device.socket!);
    const execution = service.execute(device.userId, "get_git_status", {
      device_id: device.deviceId,
      repository_path: "repo",
    });

    const command = JSON.parse(String((await commandMessage).data)) as Record<
      string,
      unknown
    >;
    const payload = command.payload as Record<string, unknown>;

    expect(command.message_type).toBe("command.request");
    expect(payload.operation).toBe("git.status");
    expect(payload.requested_permissions).toEqual(["FS_READ"]);
    expect(payload.risk).toBe("LOW");
    expect(payload.idempotency_key).toBeNull();
    expect(payload.arguments).toEqual({ repository_path: "repo" });
    expect(JSON.stringify(command)).not.toContain("Bearer");

    await respondCompleted(device, command, {
      branch: "main",
      ahead: 0,
      behind: 0,
      files: [{ path: "README.md", status: " M" }],
    });

    await expect(execution).resolves.toMatchObject({
      branch: "main",
      ahead: 0,
      behind: 0,
    });
    device.socket!.close(1000, "test complete");
  });

  it("dispatches git.diff as read-only and preserves staged/path/max_bytes", async () => {
    const device = await seedDevice(["git.diff"]);
    const service = new GitToolsService(
      bindings.DB,
      bindings.DEVICE_COORDINATOR,
    );

    const commandMessage = nextMessage(device.socket!);
    const execution = service.execute(device.userId, "get_git_diff", {
      device_id: device.deviceId,
      repository_path: "repo",
      staged: true,
      path: "src/main.rs",
      max_bytes: 4096,
    });

    const command = JSON.parse(String((await commandMessage).data)) as Record<
      string,
      unknown
    >;
    const payload = command.payload as Record<string, unknown>;

    expect(payload.operation).toBe("git.diff");
    expect(payload.requested_permissions).toEqual(["FS_READ"]);
    expect(payload.risk).toBe("LOW");
    expect(payload.idempotency_key).toBeNull();
    expect(payload.arguments).toEqual({
      repository_path: "repo",
      staged: true,
      path: "src/main.rs",
      max_bytes: 4096,
    });

    await respondCompleted(device, command, {
      diff: "diff --git a/src/main.rs b/src/main.rs",
      truncated: false,
      artifact_id: null,
    });
    await expect(execution).resolves.toMatchObject({
      truncated: false,
    });
    device.socket!.close(1000, "test complete");
  });

  it("fails before dispatch for offline or incapable devices", async () => {
    const offline = await seedDevice(null);
    const service = new GitToolsService(
      bindings.DB,
      bindings.DEVICE_COORDINATOR,
    );

    await expect(
      service.execute(offline.userId, "get_git_status", {
        device_id: offline.deviceId,
        repository_path: "repo",
      }),
    ).rejects.toMatchObject({
      code: "DEVICE_OFFLINE",
    });

    const incapable = await seedDevice(["git.status"]);
    await expect(
      service.execute(incapable.userId, "get_git_diff", {
        device_id: incapable.deviceId,
        repository_path: "repo",
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_CAPABILITY",
    });
    incapable.socket!.close(1000, "test complete");
  });

  it("does not allow one user to route Git reads to another user's device", async () => {
    const owner = await seedDevice(["git.status"]);
    const otherUserId = crypto.randomUUID();
    await seedDevice(null, otherUserId);
    const service = new GitToolsService(
      bindings.DB,
      bindings.DEVICE_COORDINATOR,
    );

    await expect(
      service.execute(otherUserId, "get_git_status", {
        device_id: owner.deviceId,
        repository_path: "repo",
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof GitToolsError && error.code === "NOT_FOUND",
    );

    owner.socket!.close(1000, "test complete");
  });

  it("rejects arguments that cannot fit the realtime envelope", async () => {
    const device = await seedDevice(["git.diff"]);
    const service = new GitToolsService(
      bindings.DB,
      bindings.DEVICE_COORDINATOR,
    );

    await expect(
      service.execute(device.userId, "get_git_diff", {
        device_id: device.deviceId,
        repository_path: "x".repeat(250 * 1024),
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    device.socket!.close(1000, "test complete");
  });
});
