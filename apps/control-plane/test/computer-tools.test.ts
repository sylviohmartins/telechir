import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  ComputerToolsError,
  ComputerToolsService,
} from "../src/computer-tools";
import type { Env } from "../src/env";

const bindings = env as unknown as Env;

interface TestDevice {
  userId: string;
  deviceId: string;
  socket: WebSocket;
  connectionId: string;
}

function nextMessage(socket: WebSocket): Promise<MessageEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeEventListener("message", listener);
      reject(new Error("timed out waiting for computer-use command"));
    }, 2_000);
    const listener = (event: MessageEvent) => {
      clearTimeout(timer);
      socket.removeEventListener("message", listener);
      resolve(event);
    };
    socket.addEventListener("message", listener);
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

async function seedDevice(capabilities: string[]): Promise<TestDevice> {
  const userId = crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  const now = new Date().toISOString();

  await bindings.DB.prepare(
    `INSERT INTO users (
      id, identity_provider, provider_subject_hash, display_name,
      created_at, disabled_at
    ) VALUES (?, 'phase13-test', ?, 'Computer User', ?, NULL)`,
  )
    .bind(userId, `subject-${userId}`, now)
    .run();
  await bindings.DB.prepare(
    `INSERT INTO devices (
      id, user_id, display_name, os, arch, agent_version,
      status_hint, last_seen_at, created_at, revoked_at
    ) VALUES (?, ?, 'Computer Device', 'windows', 'x86_64', '0.1.0',
              'offline', NULL, ?, NULL)`,
  )
    .bind(deviceId, userId, now)
    .run();

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
        "x-telechir-device-key-id": "phase13-device-key",
        "x-telechir-connection-nonce": knownNonce,
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
        device_key_id: "phase13-device-key",
        agent_version: "0.1.0",
        os: "windows",
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
  device.socket.send(
    agentFrame({
      deviceId: device.deviceId,
      connectionId: device.connectionId,
      sequence: 1,
      messageType: "command.accepted",
      payload: {
        command_id: commandId,
        accepted_at: new Date().toISOString(),
        process_id: null,
      },
    }),
  );
  device.socket.send(
    agentFrame({
      deviceId: device.deviceId,
      connectionId: device.connectionId,
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
    "SELECT id FROM users WHERE identity_provider = 'phase13-test'";
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
    "DELETE FROM users WHERE identity_provider = 'phase13-test'",
  ).run();
});

describe("Phase 13 computer-use dispatch", () => {
  it("dispatches bounded screen capture as HIGH SCREEN_READ without idempotency", async () => {
    const device = await seedDevice([
      "screen.capture",
      "computer.screen.capture",
    ]);
    const service = new ComputerToolsService(
      bindings.DB,
      bindings.DEVICE_COORDINATOR,
    );
    const message = nextMessage(device.socket);
    const execution = service.execute(device.userId, "capture_screen", {
      device_id: device.deviceId,
      max_width: 256,
      max_height: 144,
    });

    const command = JSON.parse(String((await message).data)) as Record<
      string,
      unknown
    >;
    const payload = command.payload as Record<string, unknown>;
    expect(payload.operation).toBe("screen.capture");
    expect(payload.requested_permissions).toEqual(["SCREEN_READ"]);
    expect(payload.risk).toBe("HIGH");
    expect(payload.idempotency_key).toBeNull();
    expect(payload.arguments).toEqual({ max_width: 256, max_height: 144 });

    await respondCompleted(device, command, {
      media_type: "image/png",
      data_base64: "iVBORw0KGgo=",
      width: 1,
      height: 1,
      captured_at: new Date().toISOString(),
      source: "virtual_desktop",
      untrusted: true,
    });
    await expect(execution).resolves.toMatchObject({
      media_type: "image/png",
      untrusted: true,
    });
    device.socket.close(1000, "test complete");
  });

  it("dispatches one CRITICAL INPUT_CONTROL action with caller idempotency", async () => {
    const device = await seedDevice(["computer.input"]);
    const service = new ComputerToolsService(
      bindings.DB,
      bindings.DEVICE_COORDINATOR,
    );
    const message = nextMessage(device.socket);
    const execution = service.execute(device.userId, "control_computer", {
      device_id: device.deviceId,
      idempotency_key: "phase13_click_0001",
      action: {
        kind: "click",
        x: 100,
        y: 200,
        button: "left",
        click_count: 1,
      },
    });

    const command = JSON.parse(String((await message).data)) as Record<
      string,
      unknown
    >;
    const payload = command.payload as Record<string, unknown>;
    expect(payload.operation).toBe("computer.input");
    expect(payload.requested_permissions).toEqual(["INPUT_CONTROL"]);
    expect(payload.risk).toBe("CRITICAL");
    expect(payload.idempotency_key).toBe("phase13_click_0001");
    expect(payload.arguments).toEqual({
      action: {
        kind: "click",
        x: 100,
        y: 200,
        button: "left",
        click_count: 1,
      },
    });

    await respondCompleted(device, command, {
      accepted: true,
      action: "click",
      completed_at: new Date().toISOString(),
    });
    await expect(execution).resolves.toMatchObject({
      accepted: true,
      action: "click",
    });

    const stored = await bindings.DB.prepare(
      "SELECT risk, argument_digest FROM commands WHERE id = ?",
    )
      .bind(payload.command_id)
      .first<{ risk: string; argument_digest: string }>();
    expect(stored?.risk).toBe("CRITICAL");
    expect(stored?.argument_digest).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    const audit = await bindings.DB.prepare(
      "SELECT metadata_json FROM audit_events WHERE command_id = ?",
    )
      .bind(payload.command_id)
      .all<{ metadata_json: string | null }>();
    expect(JSON.stringify(audit.results)).not.toContain("click_count");
    expect(JSON.stringify(audit.results)).not.toContain("phase13_click_0001");
    device.socket.close(1000, "test complete");
  });

  it("fails before dispatch when the advertised computer capability is absent", async () => {
    const device = await seedDevice(["screen.capture"]);
    const service = new ComputerToolsService(
      bindings.DB,
      bindings.DEVICE_COORDINATOR,
    );
    await expect(
      service.execute(device.userId, "capture_screen", {
        device_id: device.deviceId,
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_CAPABILITY",
    });
    device.socket.close(1000, "test complete");
  });

  it("rejects generic confirmation flags, malformed actions, and weak idempotency", async () => {
    const device = await seedDevice(["computer.input"]);
    const service = new ComputerToolsService(
      bindings.DB,
      bindings.DEVICE_COORDINATOR,
    );

    await expect(
      service.execute(device.userId, "control_computer", {
        device_id: device.deviceId,
        idempotency_key: "short",
        confirm: true,
        action: { kind: "type_text", text: "hello" },
      }),
    ).rejects.toBeInstanceOf(ComputerToolsError);

    await expect(
      service.execute(device.userId, "control_computer", {
        device_id: device.deviceId,
        idempotency_key: "phase13_text_0001",
        action: {
          kind: "type_text",
          text: "line one\nline two",
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    device.socket.close(1000, "test complete");
  });
});
