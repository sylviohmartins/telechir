import type { Env } from "./env";
import {
  GovernanceError,
  GovernanceService,
  type CallerContext,
} from "./governance";
import type { PermissionDomain } from "./policy";
import { resolveWorkspace } from "./workspace";

const COMMAND_TIMEOUT_MS = 8_000;
const POLL_INTERVAL_MS = 10;
const MAX_ARGUMENT_BYTES = 240 * 1024;

export const PHASE6_FILESYSTEM_TOOL_NAMES = [
  "list_files",
  "get_file_metadata",
  "read_file",
  "write_file",
  "patch_file",
  "search_files",
] as const;

export type FilesystemToolName = (typeof PHASE6_FILESYSTEM_TOOL_NAMES)[number];

interface FilesystemToolRuntime {
  operation:
    "fs.list" | "fs.stat" | "fs.read" | "fs.write" | "fs.patch" | "fs.search";
  permission: "FS_READ" | "FS_WRITE";
  risk: "LOW" | "MEDIUM";
  sideEffect: boolean;
}

const RUNTIME: Record<FilesystemToolName, FilesystemToolRuntime> = {
  list_files: {
    operation: "fs.list",
    permission: "FS_READ",
    risk: "LOW",
    sideEffect: false,
  },
  get_file_metadata: {
    operation: "fs.stat",
    permission: "FS_READ",
    risk: "LOW",
    sideEffect: false,
  },
  read_file: {
    operation: "fs.read",
    permission: "FS_READ",
    risk: "LOW",
    sideEffect: false,
  },
  write_file: {
    operation: "fs.write",
    permission: "FS_WRITE",
    risk: "MEDIUM",
    sideEffect: true,
  },
  patch_file: {
    operation: "fs.patch",
    permission: "FS_WRITE",
    risk: "MEDIUM",
    sideEffect: true,
  },
  search_files: {
    operation: "fs.search",
    permission: "FS_READ",
    risk: "LOW",
    sideEffect: false,
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

export class FilesystemToolsError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly approvalId: string | null = null,
  ) {
    super(message);
    this.name = "FilesystemToolsError";
  }
}

export class FilesystemToolsService {
  constructor(
    private readonly db: D1Database,
    private readonly coordinators: DurableObjectNamespace,
  ) {}

  async execute(
    userId: string,
    toolName: FilesystemToolName,
    input: Record<string, unknown>,
    caller?: CallerContext,
  ): Promise<Record<string, unknown>> {
    const deviceId = input.device_id;
    if (typeof deviceId !== "string" || deviceId.length < 3) {
      throw new FilesystemToolsError(
        "INVALID_ARGUMENT",
        "Filesystem tool requires a valid device_id",
      );
    }

    await this.requireOwnedActiveDevice(userId, deviceId);
    const workspace = await resolveWorkspace(
      this.db,
      userId,
      deviceId,
      input.workspace_id,
    );

    const runtime = RUNTIME[toolName];
    const coordinator = this.coordinators.get(
      this.coordinators.idFromName(deviceId),
    );
    const presence = await this.readPresence(coordinator);
    if (!presence.online) {
      throw new FilesystemToolsError("DEVICE_OFFLINE", "Device is offline");
    }
    if (!presence.capabilities.includes(runtime.operation)) {
      throw new FilesystemToolsError(
        "UNSUPPORTED_CAPABILITY",
        "Device does not advertise the requested filesystem capability",
      );
    }

    const argumentsObject = Object.fromEntries(
      Object.entries(input).filter(
        ([key]) => key !== "device_id" && key !== "workspace_id",
      ),
    );
    const argumentBytes = new TextEncoder().encode(
      JSON.stringify(argumentsObject),
    ).byteLength;
    if (argumentBytes > MAX_ARGUMENT_BYTES) {
      throw new FilesystemToolsError(
        "INVALID_ARGUMENT",
        "Filesystem tool arguments exceed the realtime transport limit",
      );
    }

    const commandId = `cmd_${crypto.randomUUID()}`;
    const deadlineAt = new Date(Date.now() + COMMAND_TIMEOUT_MS).toISOString();
    const idempotencyKey = runtime.sideEffect ? `idem_${commandId}` : null;
    const governance = new GovernanceService(this.db);

    let governed;
    try {
      governed = await governance.prepareCommand({
        commandId,
        userId,
        ...(caller ? { caller } : {}),
        deviceId,
        workspaceId: workspace.id,
        toolName,
        operation: runtime.operation,
        arguments: argumentsObject,
        requestedPermissions: [runtime.permission as PermissionDomain],
        risk: runtime.risk,
        idempotencyKey,
      });
    } catch (error) {
      if (error instanceof GovernanceError) {
        throw new FilesystemToolsError(
          error.code,
          error.message,
          error.approvalId,
        );
      }
      throw error;
    }

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
          idempotency_key: idempotencyKey,
          operation: runtime.operation,
          arguments: argumentsObject,
          requested_permissions: [runtime.permission],
          risk: runtime.risk,
          deadline_at: deadlineAt,
          user_id: userId,
          workspace_id: governed.workspaceId,
          session_id: governed.sessionId,
          tool_name: toolName,
          argument_digest: governed.argumentDigest,
          approval_id: governed.approvalId,
        }),
      },
    );
    if (!dispatch.ok) {
      throw await responseError(dispatch);
    }

    let retainCorrelation = false;
    try {
      return await this.awaitResult(coordinator, commandId, deadlineAt);
    } catch (error) {
      retainCorrelation =
        error instanceof FilesystemToolsError &&
        error.code === "APPROVAL_REQUIRED";
      throw error;
    } finally {
      if (!retainCorrelation) {
        await coordinator.fetch(
          `https://device-coordinator/internal/commands/${commandId}`,
          { method: "DELETE" },
        );
      }
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
      throw new FilesystemToolsError("NOT_FOUND", "Device not found");
    }
  }

  private async readPresence(
    coordinator: DurableObjectStub,
  ): Promise<Presence> {
    const response = await coordinator.fetch(
      "https://device-coordinator/internal/presence",
    );
    if (!response.ok) {
      throw new FilesystemToolsError(
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
          throw new FilesystemToolsError(
            "INTERNAL_ERROR",
            "Device returned an invalid filesystem result",
          );
        }
        return result as Record<string, unknown>;
      }
      if (command.message_type === "approval.request") {
        const approvalId = command.payload?.approval_id;
        throw new FilesystemToolsError(
          "APPROVAL_REQUIRED",
          "The local device policy requires explicit Telechir approval",
          typeof approvalId === "string" ? approvalId : null,
        );
      }
      if (command.message_type === "command.cancelled") {
        throw new FilesystemToolsError(
          "CONFLICT",
          "Command was cancelled on the device",
        );
      }
      if (command.message_type === "command.failed") {
        const remoteError = command.payload?.error;
        if (
          remoteError &&
          typeof remoteError === "object" &&
          !Array.isArray(remoteError)
        ) {
          const errorObject = remoteError as Record<string, unknown>;
          throw new FilesystemToolsError(
            typeof errorObject.code === "string"
              ? errorObject.code
              : "INTERNAL_ERROR",
            safeRemoteMessage(errorObject.message),
          );
        }
        throw new FilesystemToolsError(
          "INTERNAL_ERROR",
          "Device returned an invalid filesystem error",
        );
      }

      await wait(POLL_INTERVAL_MS);
    }

    throw new FilesystemToolsError(
      "DEADLINE_EXCEEDED",
      "Filesystem operation exceeded its command deadline",
    );
  }
}

function safeRemoteMessage(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    return "Filesystem operation failed on the device";
  }
  return value.slice(0, 300);
}

async function responseError(
  response: Response,
): Promise<FilesystemToolsError> {
  try {
    const body = (await response.json()) as FailureEnvelope;
    if (body && body.ok === false && typeof body.error?.code === "string") {
      return new FilesystemToolsError(
        body.error.code,
        safeRemoteMessage(body.error.message),
      );
    }
  } catch {
    // Fall through to a non-sensitive generic error.
  }

  return new FilesystemToolsError(
    "INTERNAL_ERROR",
    "Filesystem command dispatch failed",
  );
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
