import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { BrowserToolsError, BrowserToolsService } from "../src/browser-tools";
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
      reject(new Error("timed out waiting for browser command"));
    }, 2_000);
    const listener = (event: MessageEvent) => {
      clearTimeout(timer);
      socket.removeEventListener("message", listener);
      resolve(event);
    };
    socket.addEventListener("message", listener);
  });
}

function frame(input: {
  deviceId: string;
  connectionId: string;
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
}): string {
  return JSON.stringify({
    protocol_version: "0.1",
    message_type: input.type,
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
    ) VALUES (?, 'phase14-test', ?, 'Browser User', ?, NULL)`,
  )
    .bind(userId, `subject-${userId}`, now)
    .run();
  await bindings.DB.prepare(
    `INSERT INTO devices (
      id, user_id, display_name, os, arch, agent_version,
      status_hint, last_seen_at, created_at, revoked_at
    ) VALUES (?, ?, 'Browser Device', 'windows', 'x86_64', '0.1.0',
              'offline', NULL, ?, NULL)`,
  )
    .bind(deviceId, userId, now)
    .run();

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
        "x-telechir-device-key-id": "phase14-device-key",
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
        device_key_id: "phase14-device-key",
        agent_version: "0.1.0",
        os: "windows",
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
  return { userId, deviceId, socket, connectionId: ack.payload.connection_id };
}

async function complete(
  device: TestDevice,
  command: Record<string, unknown>,
  result: Record<string, unknown>,
): Promise<void> {
  const payload = command.payload as Record<string, unknown>;
  const commandId = payload.command_id as string;
  device.socket.send(
    frame({
      deviceId: device.deviceId,
      connectionId: device.connectionId,
      sequence: 1,
      type: "command.accepted",
      payload: {
        command_id: commandId,
        accepted_at: new Date().toISOString(),
        process_id: null,
      },
    }),
  );
  device.socket.send(
    frame({
      deviceId: device.deviceId,
      connectionId: device.connectionId,
      sequence: 2,
      type: "command.completed",
      payload: {
        command_id: commandId,
        completed_at: new Date().toISOString(),
        result,
      },
    }),
  );
}

beforeEach(async () => {
  const users = "SELECT id FROM users WHERE identity_provider = 'phase14-test'";
  await bindings.DB.prepare(
    `DELETE FROM audit_events WHERE user_id IN (${users})`,
  ).run();
  await bindings.DB.prepare(
    `DELETE FROM approvals WHERE user_id IN (${users})`,
  ).run();
  await bindings.DB.prepare(
    `DELETE FROM commands WHERE session_id IN (
      SELECT id FROM sessions WHERE user_id IN (${users})
    )`,
  ).run();
  await bindings.DB.prepare(
    `DELETE FROM sessions WHERE user_id IN (${users})`,
  ).run();
  await bindings.DB.prepare(
    `DELETE FROM workspaces WHERE user_id IN (${users})`,
  ).run();
  await bindings.DB.prepare(
    `DELETE FROM devices WHERE user_id IN (${users})`,
  ).run();
  await bindings.DB.prepare(
    "DELETE FROM users WHERE identity_provider = 'phase14-test'",
  ).run();
});

describe("Phase 14 browser dispatch", () => {
  it("dispatches navigation as HIGH BROWSER with caller idempotency", async () => {
    const device = await seedDevice(["browser.playwright", "browser.navigate"]);
    const service = new BrowserToolsService(
      bindings.DB,
      bindings.DEVICE_COORDINATOR,
    );
    const message = nextMessage(device.socket);
    const execution = service.execute(device.userId, "navigate_browser", {
      device_id: device.deviceId,
      idempotency_key: "phase14_nav_0001",
      browser_session_id: "browser_session_01",
      url: "https://example.com/",
    });
    const command = JSON.parse(String((await message).data)) as Record<
      string,
      unknown
    >;
    const payload = command.payload as Record<string, unknown>;
    expect(payload.operation).toBe("browser.navigate");
    expect(payload.requested_permissions).toEqual(["BROWSER"]);
    expect(payload.risk).toBe("HIGH");
    expect(payload.idempotency_key).toBe("phase14_nav_0001");
    expect(payload.arguments).toEqual({
      browser_session_id: "browser_session_01",
      url: "https://example.com/",
    });

    await complete(device, command, {
      browser_session_id: "browser_session_01",
      url: "https://example.com/",
      title: "Example",
      completed_at: new Date().toISOString(),
      untrusted: true,
    });
    await expect(execution).resolves.toMatchObject({
      browser_session_id: "browser_session_01",
      untrusted: true,
    });

    const audit = await bindings.DB.prepare(
      "SELECT metadata_json FROM audit_events WHERE command_id = ?",
    )
      .bind(payload.command_id)
      .all<{ metadata_json: string | null }>();
    expect(JSON.stringify(audit.results)).not.toContain("example.com");
    expect(JSON.stringify(audit.results)).not.toContain("phase14_nav_0001");
    device.socket.close(1000, "test complete");
  });

  it("dispatches snapshot read without idempotency and validates bounded untrusted result", async () => {
    const device = await seedDevice(["browser.playwright", "browser.snapshot"]);
    const service = new BrowserToolsService(
      bindings.DB,
      bindings.DEVICE_COORDINATOR,
    );
    const message = nextMessage(device.socket);
    const execution = service.execute(device.userId, "get_browser_snapshot", {
      device_id: device.deviceId,
      browser_session_id: "browser_session_02",
    });

    const command = JSON.parse(String((await message).data)) as Record<
      string,
      unknown
    >;
    const payload = command.payload as Record<string, unknown>;
    expect(payload.operation).toBe("browser.snapshot");
    expect(payload.requested_permissions).toEqual(["BROWSER"]);
    expect(payload.risk).toBe("HIGH");
    expect(payload.idempotency_key).toBeNull();

    await complete(device, command, {
      browser_session_id: "browser_session_02",
      url: "https://example.com/",
      title: "Example",
      snapshot: '- heading "Example"',
      captured_at: new Date().toISOString(),
      untrusted: true,
      truncated: false,
    });
    await expect(execution).resolves.toMatchObject({
      untrusted: true,
      truncated: false,
    });
    device.socket.close(1000, "test complete");
  });

  it("fails before dispatch when the complete capability set is absent", async () => {
    const device = await seedDevice(["browser.navigate"]);
    const service = new BrowserToolsService(
      bindings.DB,
      bindings.DEVICE_COORDINATOR,
    );
    await expect(
      service.execute(device.userId, "navigate_browser", {
        device_id: device.deviceId,
        idempotency_key: "phase14_nav_0002",
        browser_session_id: "browser_session_03",
        url: "https://example.com/",
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    device.socket.close(1000, "test complete");
  });

  it("rejects raw selectors, credential URLs, unsupported fields, and weak idempotency", async () => {
    const device = await seedDevice([
      "browser.playwright",
      "browser.click",
      "browser.navigate",
    ]);
    const service = new BrowserToolsService(
      bindings.DB,
      bindings.DEVICE_COORDINATOR,
    );

    await expect(
      service.execute(device.userId, "click_browser", {
        device_id: device.deviceId,
        idempotency_key: "phase14_click_01",
        browser_session_id: "browser_session_04",
        locator: { kind: "css", value: "#submit" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    await expect(
      service.execute(device.userId, "navigate_browser", {
        device_id: device.deviceId,
        idempotency_key: "short",
        browser_session_id: "browser_session_04",
        url: "https://user:secret@example.com/",
      }),
    ).rejects.toBeInstanceOf(BrowserToolsError);

    device.socket.close(1000, "test complete");
  });
});
