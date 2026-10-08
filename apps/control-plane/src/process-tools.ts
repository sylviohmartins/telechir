import type { Env } from "./env";
import {
  GovernanceError,
  GovernanceService,
  type CallerContext,
} from "./governance";
import type { PermissionDomain } from "./policy";
import { resolveWorkspace } from "./workspace";

const DEFAULT_COMMAND_TIMEOUT_MS = 8_000;
const RUN_COMMAND_HEADROOM_MS = 5_000;
const MAX_RUN_COMMAND_WAIT_MS = 125_000;
const POLL_INTERVAL_MS = 10;
const MAX_ARGUMENT_BYTES = 240 * 1024;

export const PHASE7_PROCESS_TOOL_NAMES = [
  "run_command",
  "start_process",
  "read_process_output",
  "write_process_input",
  "cancel_process",
  "list_managed_processes",
] as const;

export type ProcessToolName = (typeof PHASE7_PROCESS_TOOL_NAMES)[number];

interface ProcessToolRuntime {
  operation:
    | "shell.exec"
    | "process.start"
    | "process.read"
    | "process.write"
    | "process.cancel"
    | "process.list";
  permissions: Array<"SHELL_SAFE" | "PROCESS_CONTROL">;
  risk: "LOW" | "MEDIUM";
  sideEffect: boolean;
}

const RUNTIME: Record<ProcessToolName, ProcessToolRuntime> = {
  run_command: {
    operation: "shell.exec",
    permissions: ["SHELL_SAFE"],
    risk: "MEDIUM",
    sideEffect: true,
  },
  start_process: {
    operation: "process.start",
    permissions: ["SHELL_SAFE", "PROCESS_CONTROL"],
    risk: "MEDIUM",
    sideEffect: true,
  },
  read_process_output: {
    operation: "process.read",
    permissions: ["PROCESS_CONTROL"],
    risk: "LOW",
    sideEffect: false,
  },
  write_process_input: {
    operation: "process.write",
    permissions: ["PROCESS_CONTROL"],
    risk: "MEDIUM",
    sideEffect: true,
  },
  cancel_process: {
    operation: "process.cancel",
    permissions: ["PROCESS_CONTROL"],
    risk: "MEDIUM",
    sideEffect: true,
  },
  list_managed_processes: {
    operation: "process.list",
    permissions: ["PROCESS_CONTROL"],
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

export class ProcessToolsError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly approvalId: string | null = null,
  ) {
    super(message);
    this.name = "ProcessToolsError";
  }
}

export class ProcessToolsService {
  constructor(
    private readonly db: D1Database,
    private readonly coordinators: DurableObjectNamespace,
  ) {}

  async execute(
    userId: string,
    toolName: ProcessToolName,
    input: Record<string, unknown>,
    caller?: CallerContext,
  ): Promise<Record<string, unknown>> {
    const deviceId = input.device_id;
    if (typeof deviceId !== "string" || deviceId.length < 3) {
      throw new ProcessToolsError(
        "INVALID_ARGUMENT",
        "Process tool requires a valid device_id",
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
      throw new ProcessToolsError("DEVICE_OFFLINE", "Device is offline");
    }
    if (!presence.capabilities.includes(runtime.operation)) {
      throw new ProcessToolsError(
        "UNSUPPORTED_CAPABILITY",
        "Device does not advertise the requested process capability",
      );
    }

    const executionMode =
      toolName === "run_command" || toolName === "start_process"
        ? normalizedExecutionMode(input.execution_mode)
        : null;
    if (
      executionMode === "sandbox" &&
      !presence.capabilities.includes("sandbox.docker")
    ) {
      throw new ProcessToolsError(
        "UNSUPPORTED_CAPABILITY",
        "Device does not advertise Docker sandbox capability",
      );
    }

    const publicIdempotency =
      toolName === "start_process" ? input.idempotency_key : undefined;
    if (
      toolName === "start_process" &&
      (typeof publicIdempotency !== "string" ||
        publicIdempotency.length < 8 ||
        publicIdempotency.length > 160)
    ) {
      throw new ProcessToolsError(
        "INVALID_ARGUMENT",
        "start_process requires a valid idempotency_key",
      );
    }

    const normalizedInput =
      executionMode === null
        ? input
        : {
            ...input,
            execution_mode: executionMode,
          };
    const argumentsObject = Object.fromEntries(
      Object.entries(normalizedInput).filter(
        ([key]) =>
          key !== "device_id" &&
          key !== "workspace_id" &&
          key !== "idempotency_key",
      ),
    );
    const argumentBytes = new TextEncoder().encode(
      JSON.stringify(argumentsObject),
    ).byteLength;
    if (argumentBytes > MAX_ARGUMENT_BYTES) {
      throw new ProcessToolsError(
        "INVALID_ARGUMENT",
        "Process tool arguments exceed the realtime transport limit",
      );
    }

    const commandId = `cmd_${crypto.randomUUID()}`;
    const timeoutMs = commandTimeoutMs(toolName, argumentsObject);
    const deadlineAt = new Date(Date.now() + timeoutMs).toISOString();
    const idempotencyKey = runtime.sideEffect
      ? typeof publicIdempotency === "string"
        ? publicIdempotency
        : `idem_${commandId}`
      : null;
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
        requestedPermissions: runtime.permissions as PermissionDomain[],
        risk: runtime.risk,
        idempotencyKey,
      });
    } catch (error) {
      if (error instanceof GovernanceError) {
        throw new ProcessToolsError(
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
          requested_permissions: runtime.permissions,
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
        error instanceof ProcessToolsError &&
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
      throw new ProcessToolsError("NOT_FOUND", "Device not found");
    }
  }

  private async readPresence(
    coordinator: DurableObjectStub,
  ): Promise<Presence> {
    const response = await coordinator.fetch(
      "https://device-coordinator/internal/presence",
    );
    if (!response.ok) {
      throw new ProcessToolsError(
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
          throw new ProcessToolsError(
            "INTERNAL_ERROR",
            "Device returned an invalid process result",
          );
        }
        return result as Record<string, unknown>;
      }
      if (command.message_type === "approval.request") {
        const approvalId = command.payload?.approval_id;
        throw new ProcessToolsError(
          "APPROVAL_REQUIRED",
          "The local device policy requires explicit Telechir approval",
          typeof approvalId === "string" ? approvalId : null,
        );
      }
      if (command.message_type === "command.cancelled") {
        throw new ProcessToolsError(
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
          throw new ProcessToolsError(
            typeof errorObject.code === "string"
              ? errorObject.code
              : "INTERNAL_ERROR",
            safeRemoteMessage(errorObject.message),
          );
        }
        throw new ProcessToolsError(
          "INTERNAL_ERROR",
          "Device returned an invalid process error",
        );
      }

      await wait(POLL_INTERVAL_MS);
    }

    throw new ProcessToolsError(
      "DEADLINE_EXCEEDED",
      "Process operation exceeded its command deadline",
    );
  }
}

function normalizedExecutionMode(value: unknown): "guarded_host" | "sandbox" {
  if (value === undefined || value === null || value === "guarded_host") {
    return "guarded_host";
  }
  if (value === "sandbox") {
    return "sandbox";
  }
  throw new ProcessToolsError(
    "INVALID_ARGUMENT",
    "execution_mode must be guarded_host or sandbox",
  );
}

function commandTimeoutMs(
  toolName: ProcessToolName,
  argumentsObject: Record<string, unknown>,
): number {
  if (toolName !== "run_command") {
    return DEFAULT_COMMAND_TIMEOUT_MS;
  }
  const raw = argumentsObject.timeout_seconds;
  const seconds =
    typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= 120
      ? raw
      : 30;
  return Math.min(
    MAX_RUN_COMMAND_WAIT_MS,
    seconds * 1_000 + RUN_COMMAND_HEADROOM_MS,
  );
}

function safeRemoteMessage(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    return "Process operation failed on the device";
  }
  return value.slice(0, 300);
}

async function responseError(response: Response): Promise<ProcessToolsError> {
  try {
    const body = (await response.json()) as FailureEnvelope;
    if (body && body.ok === false && typeof body.error?.code === "string") {
      return new ProcessToolsError(
        body.error.code,
        safeRemoteMessage(body.error.message),
      );
    }
  } catch {
    // Fall through to a non-sensitive generic error.
  }

  return new ProcessToolsError(
    "INTERNAL_ERROR",
    "Process command dispatch failed",
  );
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
