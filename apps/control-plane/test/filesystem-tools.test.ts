import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import type { Env } from "../src/env";
import {
  FilesystemToolsError,
  FilesystemToolsService,
} from "../src/filesystem-tools";

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
      () => reject(new Error("timed out waiting for filesystem command")),
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

async function seedDevice(capabilities: string[] | null): Promise<TestDevice> {
  const userId = crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  const now = new Date().toISOString();

  await bindings.DB.prepare(
    `INSERT INTO users (
      id, identity_provider, provider_subject_hash, display_name,
      created_at, disabled_at
    ) VALUES (?, 'phase6-test', ?, 'Filesystem User', ?, NULL)`,
  )
    .bind(userId, `subject-${userId}`, now)
    .run();
  await bindings.DB.prepare(
    `INSERT INTO devices (
      id, user_id, display_name, os, arch, agent_version,
      status_hint, last_seen_at, created_at, revoked_at
    ) VALUES (?, ?, 'Filesystem Device', 'linux', 'x86_64', '0.1.0',
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
  const knownNonce = `nonce_${crypto.randomUUID()}`;
  const second = await coordinator.fetch("https://device-coordinator/connect", {
    headers: {
      Upgrade: "websocket",
      "x-telechir-device-id": deviceId,
      "x-telechir-device-key-id": "phase6-device-key",
      "x-telechir-connection-nonce": knownNonce,
      "x-telechir-credential-jti": crypto.randomUUID(),
      "x-telechir-credential-expires-at": new Date(
        Date.now() + 60_000,
      ).toISOString(),
    },
  });
  const active = second.webSocket!;
  active.accept();
  const helloAck = nextMessage(active);
  active.send(
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
        device_key_id: "phase6-device-key",
        agent_version: "0.1.0",
        os: "linux",
        arch: "x86_64",
        supported_protocol_versions: ["0.1"],
        capabilities,
        connection_nonce: knownNonce,
      },
    }),
  );
  const ack = JSON.parse(String((await helloAck).data)) as {
    payload: { connection_id: string };
  };
  return {
    userId,
    deviceId,
    socket: active,
    connectionId: ack.payload.connection_id,
  };
}
async function respondCompleted(
  device: TestDevice,
  command: Record<string, unknown>,
  result: Record<string, unknown>,
): Promise<void> {
  const socket = device.socket!;
  const payload = command.payload as Record<string, unknown>;
  const commandId = payload.command_id as string;

  socket.send(
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
  socket.send(
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
    "SELECT id FROM users WHERE identity_provider = 'phase6-test'";
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
    `DELETE FROM devices WHERE user_id IN (${userFilter})`,
  ).run();
  await bindings.DB.prepare(
    "DELETE FROM users WHERE identity_provider = 'phase6-test'",
  ).run();
});

describe("Phase 6 filesystem dispatch", () => {
  it("dispatches a read command with the frozen permission/risk contract", async () => {
    const device = await seedDevice(["fs.read"]);
    const service = new FilesystemToolsService(
      bindings.DB,
      bindings.DEVICE_COORDINATOR,
    );

    const commandMessage = nextMessage(device.socket!);
    const execution = service.execute(device.userId, "read_file", {
      device_id: device.deviceId,
      path: "README.md",
      max_bytes: 1024,
      encoding: "utf-8",
    });

    const command = JSON.parse(String((await commandMessage).data)) as Record<
      string,
      unknown
    >;
    expect(command.message_type).toBe("command.request");
    expect(Date.parse(command.deadline_at as string)).toBeGreaterThan(
      Date.now(),
    );

    const payload = command.payload as Record<string, unknown>;
    expect(payload.operation).toBe("fs.read");
    expect(payload.requested_permissions).toEqual(["FS_READ"]);
    expect(payload.risk).toBe("LOW");
    expect(payload.idempotency_key).toBeNull();
    expect(payload.arguments).toEqual({
      path: "README.md",
      max_bytes: 1024,
      encoding: "utf-8",
    });
    expect(JSON.stringify(command)).not.toContain("phase5-test-token");

    await respondCompleted(device, command, {
      path: "/safe/README.md",
      content: "hello",
      encoding: "utf-8",
      offset: 0,
      next_offset: null,
      truncated: false,
      sha256: "abc",
    });

    await expect(execution).resolves.toMatchObject({
      content: "hello",
      truncated: false,
    });
    device.socket!.close(1000, "test complete");
  });

  it("dispatches writes with FS_WRITE, MEDIUM risk and idempotency", async () => {
    const device = await seedDevice(["fs.write"]);
    const service = new FilesystemToolsService(
      bindings.DB,
      bindings.DEVICE_COORDINATOR,
    );

    const commandMessage = nextMessage(device.socket!);
    const execution = service.execute(device.userId, "write_file", {
      device_id: device.deviceId,
      path: "notes.txt",
      content: "hello",
      encoding: "utf-8",
      expected_hash: null,
      create_if_missing: true,
    });
    const command = JSON.parse(String((await commandMessage).data)) as Record<
      string,
      unknown
    >;
    const payload = command.payload as Record<string, unknown>;

    expect(payload.operation).toBe("fs.write");
    expect(payload.requested_permissions).toEqual(["FS_WRITE"]);
    expect(payload.risk).toBe("MEDIUM");
    expect(payload.idempotency_key).toMatch(/^idem_cmd_/u);

    await respondCompleted(device, command, {
      path: "/safe/notes.txt",
      bytes_written: 5,
      sha256: "abc",
      created: true,
    });
    await expect(execution).resolves.toMatchObject({
      bytes_written: 5,
      created: true,
    });
    device.socket!.close(1000, "test complete");
  });

  it("fails before dispatch when the device is offline", async () => {
    const device = await seedDevice(null);
    const service = new FilesystemToolsService(
      bindings.DB,
      bindings.DEVICE_COORDINATOR,
    );

    await expect(
      service.execute(device.userId, "list_files", {
        device_id: device.deviceId,
        path: ".",
      }),
    ).rejects.toMatchObject({
      code: "DEVICE_OFFLINE",
    });
  });

  it("fails before dispatch when the capability is missing", async () => {
    const device = await seedDevice(["fs.read"]);
    const service = new FilesystemToolsService(
      bindings.DB,
      bindings.DEVICE_COORDINATOR,
    );

    await expect(
      service.execute(device.userId, "write_file", {
        device_id: device.deviceId,
        path: "notes.txt",
        content: "x",
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_CAPABILITY",
    });
    device.socket!.close(1000, "test complete");
  });

  it("does not reveal or dispatch a device owned by another user", async () => {
    const device = await seedDevice(["fs.read"]);
    const foreignUser = crypto.randomUUID();
    const now = new Date().toISOString();
    await bindings.DB.prepare(
      `INSERT INTO users (
        id, identity_provider, provider_subject_hash, display_name,
        created_at, disabled_at
      ) VALUES (?, 'phase6-test', ?, 'Foreign User', ?, NULL)`,
    )
      .bind(foreignUser, `subject-${foreignUser}`, now)
      .run();

    const service = new FilesystemToolsService(
      bindings.DB,
      bindings.DEVICE_COORDINATOR,
    );
    await expect(
      service.execute(foreignUser, "read_file", {
        device_id: device.deviceId,
        path: "README.md",
      }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    device.socket!.close(1000, "test complete");
  });

  it("maps device failures without exposing private paths", async () => {
    const device = await seedDevice(["fs.read"]);
    const service = new FilesystemToolsService(
      bindings.DB,
      bindings.DEVICE_COORDINATOR,
    );
    const commandMessage = nextMessage(device.socket!);
    const execution = service.execute(device.userId, "read_file", {
      device_id: device.deviceId,
      path: ".ssh/id_ed25519",
    });
    const command = JSON.parse(String((await commandMessage).data)) as Record<
      string,
      unknown
    >;
    const commandId = (command.payload as Record<string, unknown>)
      .command_id as string;

    device.socket!.send(
      agentFrame({
        deviceId: device.deviceId,
        connectionId: device.connectionId!,
        sequence: 1,
        messageType: "command.failed",
        payload: {
          command_id: commandId,
          failed_at: new Date().toISOString(),
          error: {
            code: "POLICY_DENIED",
            message:
              "filesystem path is blocked by local sensitive-path policy",
            retryable: false,
            retry_after_ms: null,
            details: null,
          },
        },
      }),
    );

    await expect(execution).rejects.toMatchObject({
      code: "POLICY_DENIED",
      message: "filesystem path is blocked by local sensitive-path policy",
    });
    device.socket!.close(1000, "test complete");
  });
});
