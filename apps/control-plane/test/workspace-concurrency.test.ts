import { env } from "cloudflare:test";
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
  socket: WebSocket;
  connectionId: string;
  nextInboundSequence: number;
}

function nextMessage(socket: WebSocket): Promise<MessageEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out waiting for workspace command")),
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

function noMessageWithin(
  socket: WebSocket,
  milliseconds: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const listener = () => {
      clearTimeout(timer);
      socket.removeEventListener("message", listener);
      resolve(false);
    };
    const timer = setTimeout(() => {
      socket.removeEventListener("message", listener);
      resolve(true);
    }, milliseconds);
    socket.addEventListener("message", listener);
  });
}

function frame(
  device: TestDevice,
  type: string,
  payload: Record<string, unknown>,
): string {
  const sequence = device.nextInboundSequence++;
  return JSON.stringify({
    protocol_version: "0.1",
    message_type: type,
    message_id: `msg_${crypto.randomUUID()}`,
    correlation_id: null,
    device_id: device.deviceId,
    session_id: null,
    connection_id: device.connectionId,
    sequence,
    sent_at: new Date().toISOString(),
    deadline_at: null,
    payload,
  });
}

async function seedUser(): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await bindings.DB.prepare(
    `INSERT INTO users (
      id, identity_provider, provider_subject_hash, display_name,
      created_at, disabled_at
    ) VALUES (?, 'phase15-test', ?, 'Concurrency User', ?, NULL)`,
  )
    .bind(id, `subject-${id}`, now)
    .run();
  return id;
}

async function seedDevice(
  userId: string,
  capabilities: string[],
): Promise<TestDevice> {
  const deviceId = crypto.randomUUID();
  const now = new Date().toISOString();
  await bindings.DB.prepare(
    `INSERT INTO devices (
      id, user_id, display_name, os, arch, agent_version,
      status_hint, last_seen_at, created_at, revoked_at
    ) VALUES (?, ?, 'Concurrency Device', 'linux', 'x86_64', '0.1.0',
              'offline', NULL, ?, NULL)`,
  )
    .bind(deviceId, userId, now)
    .run();
  return connectDevice(userId, deviceId, capabilities);
}

async function connectDevice(
  userId: string,
  deviceId: string,
  capabilities: string[],
): Promise<TestDevice> {
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
        "x-telechir-device-key-id": "phase15-device-key",
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

  const ackPromise = nextMessage(socket);
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
        device_key_id: "phase15-device-key",
        agent_version: "0.1.0",
        os: "linux",
        arch: "x86_64",
        supported_protocol_versions: ["0.1"],
        capabilities,
        connection_nonce: nonce,
      },
    }),
  );
  const ack = JSON.parse(String((await ackPromise).data)) as {
    payload: { connection_id: string };
  };
  return {
    userId,
    deviceId,
    socket,
    connectionId: ack.payload.connection_id,
    nextInboundSequence: 1,
  };
}

async function complete(
  device: TestDevice,
  command: Record<string, unknown>,
  result: Record<string, unknown>,
): Promise<void> {
  const commandId = (command.payload as Record<string, unknown>)
    .command_id as string;
  device.socket.send(
    frame(device, "command.accepted", {
      command_id: commandId,
      accepted_at: new Date().toISOString(),
      process_id: null,
    }),
  );
  device.socket.send(
    frame(device, "command.completed", {
      command_id: commandId,
      completed_at: new Date().toISOString(),
      result,
    }),
  );
}

function writeInput(deviceId: string, workspaceId?: string) {
  return {
    device_id: deviceId,
    ...(workspaceId ? { workspace_id: workspaceId } : {}),
    path: "notes.txt",
    content: "hello",
    encoding: "utf-8",
    expected_hash: null,
    create_if_missing: true,
  };
}

function readInput(deviceId: string, workspaceId?: string) {
  return {
    device_id: deviceId,
    ...(workspaceId ? { workspace_id: workspaceId } : {}),
    path: "README.md",
    max_bytes: 1024,
    encoding: "utf-8",
  };
}

const writeResult = {
  path: "/safe/notes.txt",
  bytes_written: 5,
  sha256: "abc",
  created: true,
};

const readResult = {
  path: "/safe/README.md",
  content: "hello",
  encoding: "utf-8",
  offset: 0,
  next_offset: null,
  truncated: false,
  sha256: "abc",
};

beforeEach(async () => {
  const users = "SELECT id FROM users WHERE identity_provider = 'phase15-test'";
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
    "DELETE FROM users WHERE identity_provider = 'phase15-test'",
  ).run();
});

describe("Phase 15 workspace concurrency", () => {
  it("materializes the default workspace and rejects cross-device workspace substitution", async () => {
    const userId = await seedUser();
    const deviceA = await seedDevice(userId, ["fs.read"]);
    const deviceB = await seedDevice(userId, ["fs.read"]);
    const defaultA = `workspace_${deviceA.deviceId}`;
    const defaultB = `workspace_${deviceB.deviceId}`;

    const rows = await bindings.DB.prepare(
      `SELECT id, device_id, is_default
       FROM workspaces
       WHERE user_id = ?
       ORDER BY device_id`,
    )
      .bind(userId)
      .all<{ id: string; device_id: string; is_default: number }>();
    expect(rows.results).toEqual(
      expect.arrayContaining([
        { id: defaultA, device_id: deviceA.deviceId, is_default: 1 },
        { id: defaultB, device_id: deviceB.deviceId, is_default: 1 },
      ]),
    );

    const service = new FilesystemToolsService(
      bindings.DB,
      bindings.DEVICE_COORDINATOR,
    );
    const message = nextMessage(deviceA.socket);
    const execution = service.execute(
      userId,
      "read_file",
      readInput(deviceA.deviceId),
    );
    const command = JSON.parse(String((await message).data)) as Record<
      string,
      unknown
    >;
    expect((command.payload as Record<string, unknown>).workspace_id).toBe(
      defaultA,
    );
    await complete(deviceA, command, readResult);
    await expect(execution).resolves.toMatchObject({ content: "hello" });

    await expect(
      service.execute(
        userId,
        "read_file",
        readInput(deviceA.deviceId, defaultB),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    deviceA.socket.close(1000, "test complete");
    deviceB.socket.close(1000, "test complete");
  });

  it("AB-028 serializes side effects in one workspace while reads continue and fencing advances", async () => {
    const userId = await seedUser();
    const device = await seedDevice(userId, ["fs.read", "fs.write"]);
    const service = new FilesystemToolsService(
      bindings.DB,
      bindings.DEVICE_COORDINATOR,
    );

    const firstMessage = nextMessage(device.socket);
    const first = service.execute(
      userId,
      "write_file",
      writeInput(device.deviceId),
    );
    const firstCommand = JSON.parse(
      String((await firstMessage).data),
    ) as Record<string, unknown>;
    const firstId = (firstCommand.payload as Record<string, unknown>)
      .command_id as string;

    await expect(
      service.execute(userId, "write_file", {
        ...writeInput(device.deviceId),
        path: "second.txt",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const readMessage = nextMessage(device.socket);
    const read = service.execute(
      userId,
      "read_file",
      readInput(device.deviceId),
    );
    const readCommand = JSON.parse(String((await readMessage).data)) as Record<
      string,
      unknown
    >;
    await complete(device, readCommand, readResult);
    await expect(read).resolves.toMatchObject({ content: "hello" });

    await complete(device, firstCommand, writeResult);
    await expect(first).resolves.toMatchObject({ bytes_written: 5 });

    const nextMessagePromise = nextMessage(device.socket);
    const next = service.execute(userId, "write_file", {
      ...writeInput(device.deviceId),
      path: "third.txt",
    });
    const nextCommand = JSON.parse(
      String((await nextMessagePromise).data),
    ) as Record<string, unknown>;
    const nextId = (nextCommand.payload as Record<string, unknown>)
      .command_id as string;

    const tokens = await bindings.DB.prepare(
      `SELECT id, workspace_fencing_token
       FROM commands
       WHERE id IN (?, ?)
       ORDER BY requested_at ASC`,
    )
      .bind(firstId, nextId)
      .all<{ id: string; workspace_fencing_token: number }>();
    expect(tokens.results).toHaveLength(2);
    expect(tokens.results[0]!.workspace_fencing_token).toBeGreaterThan(0);
    expect(tokens.results[1]!.workspace_fencing_token).toBeGreaterThan(
      tokens.results[0]!.workspace_fencing_token,
    );

    await complete(device, nextCommand, writeResult);
    await expect(next).resolves.toMatchObject({ bytes_written: 5 });
    device.socket.close(1000, "test complete");
  });

  it("does not serialize side effects across distinct workspaces on one device", async () => {
    const userId = await seedUser();
    const device = await seedDevice(userId, ["fs.write"]);
    const alternate = `workspace_alt_${crypto.randomUUID().replaceAll("-", "")}`;
    await bindings.DB.prepare(
      `INSERT INTO workspaces (
        id, user_id, device_id, display_name, created_at, archived_at, is_default
      ) VALUES (?, ?, ?, 'Alternate', ?, NULL, 0)`,
    )
      .bind(alternate, userId, device.deviceId, new Date().toISOString())
      .run();

    const service = new FilesystemToolsService(
      bindings.DB,
      bindings.DEVICE_COORDINATOR,
    );
    const firstMessage = nextMessage(device.socket);
    const first = service.execute(
      userId,
      "write_file",
      writeInput(device.deviceId),
    );
    const firstCommand = JSON.parse(
      String((await firstMessage).data),
    ) as Record<string, unknown>;

    const secondMessage = nextMessage(device.socket);
    const second = service.execute(
      userId,
      "write_file",
      writeInput(device.deviceId, alternate),
    );
    const secondCommand = JSON.parse(
      String((await secondMessage).data),
    ) as Record<string, unknown>;

    expect(
      (firstCommand.payload as Record<string, unknown>).workspace_id,
    ).not.toBe((secondCommand.payload as Record<string, unknown>).workspace_id);

    await complete(device, firstCommand, writeResult);
    await complete(device, secondCommand, writeResult);
    await expect(first).resolves.toMatchObject({ bytes_written: 5 });
    await expect(second).resolves.toMatchObject({ bytes_written: 5 });
    device.socket.close(1000, "test complete");
  });

  it("does not serialize side effects across devices owned by the same user", async () => {
    const userId = await seedUser();
    const deviceA = await seedDevice(userId, ["fs.write"]);
    const deviceB = await seedDevice(userId, ["fs.write"]);
    const service = new FilesystemToolsService(
      bindings.DB,
      bindings.DEVICE_COORDINATOR,
    );

    const messageA = nextMessage(deviceA.socket);
    const first = service.execute(
      userId,
      "write_file",
      writeInput(deviceA.deviceId),
    );
    const commandA = JSON.parse(String((await messageA).data)) as Record<
      string,
      unknown
    >;

    const messageB = nextMessage(deviceB.socket);
    const second = service.execute(
      userId,
      "write_file",
      writeInput(deviceB.deviceId),
    );
    const commandB = JSON.parse(String((await messageB).data)) as Record<
      string,
      unknown
    >;

    await complete(deviceA, commandA, writeResult);
    await complete(deviceB, commandB, writeResult);
    await expect(first).resolves.toMatchObject({ bytes_written: 5 });
    await expect(second).resolves.toMatchObject({ bytes_written: 5 });

    deviceA.socket.close(1000, "test complete");
    deviceB.socket.close(1000, "test complete");
  });

  it("AB-029 reconnect preserves accepted state and lease without replaying the command", async () => {
    const userId = await seedUser();
    const original = await seedDevice(userId, ["fs.write"]);
    const service = new FilesystemToolsService(
      bindings.DB,
      bindings.DEVICE_COORDINATOR,
    );

    const message = nextMessage(original.socket);
    const execution = service.execute(
      userId,
      "write_file",
      writeInput(original.deviceId),
    );
    const command = JSON.parse(String((await message).data)) as Record<
      string,
      unknown
    >;
    const commandId = (command.payload as Record<string, unknown>)
      .command_id as string;

    original.socket.send(
      frame(original, "command.accepted", {
        command_id: commandId,
        accepted_at: new Date().toISOString(),
        process_id: null,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    original.socket.close(1000, "reconnect");

    const replacement = await connectDevice(userId, original.deviceId, [
      "fs.write",
    ]);
    await expect(noMessageWithin(replacement.socket, 150)).resolves.toBe(true);

    const stored = await bindings.DB.prepare(
      "SELECT state, workspace_id, workspace_fencing_token FROM commands WHERE id = ?",
    )
      .bind(commandId)
      .first<{
        state: string;
        workspace_id: string;
        workspace_fencing_token: number;
      }>();
    expect(stored?.state).toBe("ACCEPTED");
    expect(stored?.workspace_fencing_token).toBeGreaterThan(0);

    await expect(
      service.execute(userId, "write_file", {
        ...writeInput(original.deviceId),
        path: "duplicate-after-reconnect.txt",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    replacement.socket.send(
      frame(replacement, "command.cancelled", {
        command_id: commandId,
        cancelled_at: new Date().toISOString(),
      }),
    );
    await expect(execution).rejects.toBeInstanceOf(FilesystemToolsError);

    const afterCancel = nextMessage(replacement.socket);
    const next = service.execute(userId, "write_file", {
      ...writeInput(original.deviceId),
      path: "after-cancel.txt",
    });
    const nextCommand = JSON.parse(String((await afterCancel).data)) as Record<
      string,
      unknown
    >;
    await complete(replacement, nextCommand, writeResult);
    await expect(next).resolves.toMatchObject({ bytes_written: 5 });

    replacement.socket.close(1000, "test complete");
  });
});
