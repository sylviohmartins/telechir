import type { Env } from "./env";

const DEFAULT_COMMAND_TIMEOUT_MS = 8_000;
const POLL_INTERVAL_MS = 10;
const MAX_ARGUMENT_BYTES = 240 * 1024;

export const PHASE8_GIT_TOOL_NAMES = [
  "get_git_status",
  "get_git_diff",
] as const;

export type GitToolName = (typeof PHASE8_GIT_TOOL_NAMES)[number];

interface GitToolRuntime {
  operation: "git.status" | "git.diff";
  permissions: ["FS_READ"];
  risk: "LOW";
}

const RUNTIME: Record<GitToolName, GitToolRuntime> = {
  get_git_status: {
    operation: "git.status",
    permissions: ["FS_READ"],
    risk: "LOW",
  },
  get_git_diff: {
    operation: "git.diff",
    permissions: ["FS_READ"],
    risk: "LOW",
  },
};

interface DeviceRow {
  id: string;
}

interface Presence {
  online: boolean;
  capabilities: string[];
}

interface CorrelatedCommand {
  command_id: string;
  message_type: string;
  payload?: Record<string, unknown>;
}

interface SuccessEnvelope<T> {
  ok: true;
  data: T;
}

interface FailureEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

export class GitToolsError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GitToolsError";
  }
}

export class GitToolsService {
  constructor(
    private readonly db: D1Database,
    private readonly coordinators: DurableObjectNamespace,
  ) {}

  async execute(
    userId: string,
    toolName: GitToolName,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const deviceId = input.device_id;
    if (typeof deviceId !== "string" || deviceId.length < 3) {
      throw new GitToolsError(
        "INVALID_ARGUMENT",
        "Git tool requires a valid device_id",
      );
    }

    await this.requireOwnedActiveDevice(userId, deviceId);

    const runtime = RUNTIME[toolName];
    const coordinator = this.coordinators.get(
      this.coordinators.idFromName(deviceId),
    );
    const presence = await this.readPresence(coordinator);
    if (!presence.online) {
      throw new GitToolsError("DEVICE_OFFLINE", "Device is offline");
    }
    if (!presence.capabilities.includes(runtime.operation)) {
      throw new GitToolsError(
        "UNSUPPORTED_CAPABILITY",
        "Device does not advertise the requested Git capability",
      );
    }

    const argumentsObject = Object.fromEntries(
      Object.entries(input).filter(([key]) => key !== "device_id"),
    );
    const argumentBytes = new TextEncoder().encode(
      JSON.stringify(argumentsObject),
    ).byteLength;
    if (argumentBytes > MAX_ARGUMENT_BYTES) {
      throw new GitToolsError(
        "INVALID_ARGUMENT",
        "Git tool arguments exceed the realtime transport limit",
      );
    }

    const commandId = `cmd_${crypto.randomUUID()}`;
    const deadlineAt = new Date(
      Date.now() + DEFAULT_COMMAND_TIMEOUT_MS,
    ).toISOString();

    const dispatch = await coordinator.fetch(
      "https://device-coordinator/internal/commands",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telechir-device-id": deviceId,
        },
        body: JSON.stringify({
          command_id: commandId,
          idempotency_key: null,
          operation: runtime.operation,
          arguments: argumentsObject,
          requested_permissions: runtime.permissions,
          risk: runtime.risk,
          deadline_at: deadlineAt,
        }),
      },
    );
    if (!dispatch.ok) {
      throw await responseError(dispatch);
    }

    try {
      return await this.awaitResult(coordinator, commandId, deadlineAt);
    } finally {
      await coordinator.fetch(
        `https://device-coordinator/internal/commands/${commandId}`,
        { method: "DELETE" },
      );
    }
  }

  private async requireOwnedActiveDevice(
    userId: string,
    deviceId: string,
  ): Promise<void> {
    const device = await this.db
      .prepare(
        `SELECT id
         FROM devices
         WHERE id = ?
           AND user_id = ?
           AND revoked_at IS NULL`,
      )
      .bind(deviceId, userId)
      .first<DeviceRow>();

    if (!device) {
      throw new GitToolsError("NOT_FOUND", "Device not found");
    }
  }

  private async readPresence(
    coordinator: DurableObjectStub,
  ): Promise<Presence> {
    const response = await coordinator.fetch(
      "https://device-coordinator/internal/presence",
    );
    if (!response.ok) {
      throw new GitToolsError(
        "INTERNAL_ERROR",
        "Device presence could not be resolved",
      );
    }
    const body = (await response.json()) as SuccessEnvelope<Presence>;
    return body.data;
  }

  private async awaitResult(
    coordinator: DurableObjectStub,
    commandId: string,
    deadlineAt: string,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.parse(deadlineAt);

    while (Date.now() < deadline) {
      const response = await coordinator.fetch(
        `https://device-coordinator/internal/commands/${commandId}`,
      );
      if (response.status === 404) {
        await wait(POLL_INTERVAL_MS);
        continue;
      }
      if (!response.ok) {
        throw await responseError(response);
      }

      const body =
        (await response.json()) as SuccessEnvelope<CorrelatedCommand>;
      const command = body.data;
      if (command.message_type === "command.completed") {
        const result = command.payload?.result;
        if (!result || typeof result !== "object" || Array.isArray(result)) {
          throw new GitToolsError(
            "INTERNAL_ERROR",
            "Device returned an invalid Git result",
          );
        }
        return result as Record<string, unknown>;
      }
      if (command.message_type === "command.failed") {
        const remoteError = command.payload?.error;
        if (
          remoteError &&
          typeof remoteError === "object" &&
          !Array.isArray(remoteError)
        ) {
          const errorObject = remoteError as Record<string, unknown>;
          throw new GitToolsError(
            typeof errorObject.code === "string"
              ? errorObject.code
              : "INTERNAL_ERROR",
            safeRemoteMessage(errorObject.message),
          );
        }
        throw new GitToolsError(
          "INTERNAL_ERROR",
          "Device returned an invalid Git error",
        );
      }

      await wait(POLL_INTERVAL_MS);
    }

    throw new GitToolsError(
      "DEADLINE_EXCEEDED",
      "Git operation exceeded its command deadline",
    );
  }
}

function safeRemoteMessage(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    return "Git operation failed on the device";
  }
  return value.slice(0, 300);
}

async function responseError(response: Response): Promise<GitToolsError> {
  try {
    const body = (await response.json()) as FailureEnvelope;
    if (body && body.ok === false && typeof body.error?.code === "string") {
      return new GitToolsError(
        body.error.code,
        safeRemoteMessage(body.error.message),
      );
    }
  } catch {
    // Fall through to a non-sensitive generic error.
  }

  return new GitToolsError("INTERNAL_ERROR", "Git command dispatch failed");
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
