import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import type { Env } from "../src/env";
import { ProcessToolsError, ProcessToolsService } from "../src/process-tools";

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
      () => reject(new Error("timed out waiting for process command")),
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
    ) VALUES (?, 'phase7-test', ?, 'Process User', ?, NULL)`,
  )
    .bind(userId, `subject-${userId}`, now)
    .run();
  await bindings.DB.prepare(
    `INSERT INTO devices (
      id, user_id, display_name, os, arch, agent_version,
      status_hint, last_seen_at, created_at, revoked_at
    ) VALUES (?, ?, 'Process Device', 'linux', 'x86_64', '0.1.0',
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
  const response = await coordinator.fetch(
    "https://device-coordinator/connect",
    {
      headers: {
        Upgrade: "websocket",
        "x-telechir-device-id": deviceId,
        "x-telechir-device-key-id": "phase7-device-key",
        "x-telechir-connection-nonce": knownNonce,
        "x-telechir-credential-jti": crypto.randomUUID(),
        "x-telechir-credential-expires-at": new Date(
          Date.now() + 60_000,
        ).toISOString(),
      },
    },
  );
  const active = response.webSocket!;
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
        device_key_id: "phase7-device-key",
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
  await bindings.DB.prepare(
    "DELETE FROM devices WHERE user_id IN (SELECT id FROM users WHERE identity_provider = 'phase7-test')",
  ).run();
  await bindings.DB.prepare(
    "DELETE FROM users WHERE identity_provider = 'phase7-test'",
  ).run();
});

describe("Phase 7 process dispatch", () => {
  it("dispatches short commands with SHELL_SAFE, bounded deadline, and no credential material", async () => {
    const device = await seedDevice(["shell.exec"]);
    const service = new ProcessToolsService(
      bindings.DB,
      bindings.DEVICE_COORDINATOR,
    );

    const commandMessage = nextMessage(device.socket!);
    const execution = service.execute(device.userId, "run_command", {
      device_id: device.deviceId,
      command: "echo telechir",
      cwd: ".",
      timeout_seconds: 1,
      env_refs: [],
    });

    const command = JSON.parse(String((await commandMessage).data)) as Record<
      string,
      unknown
    >;
    const payload = command.payload as Record<string, unknown>;

    expect(command.message_type).toBe("command.request");
    expect(payload.operation).toBe("shell.exec");
    expect(payload.requested_permissions).toEqual(["SHELL_SAFE"]);
    expect(payload.risk).toBe("MEDIUM");
    expect(payload.idempotency_key).toMatch(/^idem_cmd_/u);
    expect(payload.arguments).toEqual({
      command: "echo telechir",
      cwd: ".",
      timeout_seconds: 1,
      env_refs: [],
    });
    expect(JSON.stringify(command)).not.toContain("phase7-test-token");
    const deadlineMs = Date.parse(command.deadline_at as string) - Date.now();
    expect(deadlineMs).toBeGreaterThan(4_000);
    expect(deadlineMs).toBeLessThanOrEqual(6_000);

    await respondCompleted(device, command, {
      exit_code: 0,
      stdout: "telechir\n",
      stderr: "",
      truncated: false,
      artifact_id: null,
    });
    await expect(execution).resolves.toMatchObject({
      exit_code: 0,
      stdout: "telechir\n",
      truncated: false,
    });

    device.socket!.close(1000, "test complete");
  });

  it("preserves start_process public idempotency while stripping routing-only fields from arguments", async () => {
    const device = await seedDevice(["process.start"]);
    const service = new ProcessToolsService(
      bindings.DB,
      bindings.DEVICE_COORDINATOR,
    );

    const commandMessage = nextMessage(device.socket!);
    const execution = service.execute(device.userId, "start_process", {
      device_id: device.deviceId,
      command: "mvn test",
      cwd: ".",
      idempotency_key: "public_idem_phase7_01",
      env_refs: [],
    });

    const command = JSON.parse(String((await commandMessage).data)) as Record<
      string,
      unknown
    >;
    const payload = command.payload as Record<string, unknown>;

    expect(payload.operation).toBe("process.start");
    expect(payload.requested_permissions).toEqual([
      "SHELL_SAFE",
      "PROCESS_CONTROL",
    ]);
    expect(payload.risk).toBe("MEDIUM");
    expect(payload.idempotency_key).toBe("public_idem_phase7_01");
    expect(payload.arguments).toEqual({
      command: "mvn test",
      cwd: ".",
      env_refs: [],
    });
    expect(JSON.stringify(payload.arguments)).not.toContain(device.deviceId);
    expect(JSON.stringify(payload.arguments)).not.toContain(
      "public_idem_phase7_01",
    );

    await respondCompleted(device, command, {
      process_id: "proc_test_phase7",
      state: "running",
      started_at: new Date().toISOString(),
    });
    await expect(execution).resolves.toMatchObject({
      process_id: "proc_test_phase7",
      state: "running",
    });
    device.socket!.close(1000, "test complete");
  });

  it("dispatches read/list as PROCESS_CONTROL read operations", async () => {
    const device = await seedDevice(["process.read", "process.list"]);
    const service = new ProcessToolsService(
      bindings.DB,
      bindings.DEVICE_COORDINATOR,
    );

    const readMessage = nextMessage(device.socket!);
    const read = service.execute(device.userId, "read_process_output", {
      device_id: device.deviceId,
      process_id: "proc_test_phase7",
      cursor: null,
      max_bytes: 1024,
    });
    const readCommand = JSON.parse(String((await readMessage).data)) as Record<
      string,
      unknown
    >;
    const readPayload = readCommand.payload as Record<string, unknown>;
    expect(readPayload.operation).toBe("process.read");
    expect(readPayload.requested_permissions).toEqual(["PROCESS_CONTROL"]);
    expect(readPayload.risk).toBe("LOW");
    expect(readPayload.idempotency_key).toBeNull();

    await respondCompleted(device, readCommand, {
      process_id: "proc_test_phase7",
      state: "running",
      stdout: "ok",
      stderr: "",
      next_cursor: "cursor",
      exit_code: null,
      truncated: false,
      artifact_id: null,
    });
    await expect(read).resolves.toMatchObject({ state: "running" });
    device.socket!.close(1000, "test complete");
  });

  it("fails before dispatch when device is offline or capability is missing", async () => {
    const offline = await seedDevice(null);
    const service = new ProcessToolsService(
      bindings.DB,
      bindings.DEVICE_COORDINATOR,
    );
    await expect(
      service.execute(offline.userId, "run_command", {
        device_id: offline.deviceId,
        command: "echo test",
      }),
    ).rejects.toMatchObject({ code: "DEVICE_OFFLINE" });

    const device = await seedDevice(["process.read"]);
    await expect(
      service.execute(device.userId, "run_command", {
        device_id: device.deviceId,
        command: "echo test",
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    device.socket!.close(1000, "test complete");
  });

  it("does not reveal or dispatch a device owned by another user", async () => {
    const device = await seedDevice(["shell.exec"]);
    const foreignUser = crypto.randomUUID();
    const now = new Date().toISOString();
    await bindings.DB.prepare(
      `INSERT INTO users (
        id, identity_provider, provider_subject_hash, display_name,
        created_at, disabled_at
      ) VALUES (?, 'phase7-test', ?, 'Foreign User', ?, NULL)`,
    )
      .bind(foreignUser, `subject-${foreignUser}`, now)
      .run();

    const service = new ProcessToolsService(
      bindings.DB,
      bindings.DEVICE_COORDINATOR,
    );
    await expect(
      service.execute(foreignUser, "run_command", {
        device_id: device.deviceId,
        command: "echo hidden",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    device.socket!.close(1000, "test complete");
  });

  it("maps fail-closed local policy results without exposing private command data", async () => {
    const device = await seedDevice(["shell.exec"]);
    const service = new ProcessToolsService(
      bindings.DB,
      bindings.DEVICE_COORDINATOR,
    );
    const commandMessage = nextMessage(device.socket!);
    const execution = service.execute(device.userId, "run_command", {
      device_id: device.deviceId,
      command: "python private-script.py",
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
            code: "APPROVAL_REQUIRED",
            message:
              "command is outside the Phase 7 SHELL_SAFE allowlist and requires later policy support",
            retryable: false,
            retry_after_ms: null,
            details: null,
          },
        },
      }),
    );

    await expect(execution).rejects.toMatchObject({
      code: "APPROVAL_REQUIRED",
    });
    device.socket!.close(1000, "test complete");
  });

  it("validates start_process idempotency before realtime dispatch", async () => {
    const device = await seedDevice(["process.start"]);
    const service = new ProcessToolsService(
      bindings.DB,
      bindings.DEVICE_COORDINATOR,
    );

    await expect(
      service.execute(device.userId, "start_process", {
        device_id: device.deviceId,
        command: "mvn test",
        idempotency_key: "short",
      }),
    ).rejects.toBeInstanceOf(ProcessToolsError);

    device.socket!.close(1000, "test complete");
  });
});
