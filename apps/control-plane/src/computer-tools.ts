import {
  GovernanceError,
  GovernanceService,
  type CallerContext,
} from "./governance";
import type { PermissionDomain } from "./policy";
import { resolveWorkspace } from "./workspace";

const CAPTURE_TIMEOUT_MS = 12_000;
const INPUT_TIMEOUT_MS = 40_000;
const POLL_INTERVAL_MS = 10;
const MAX_ARGUMENT_BYTES = 32 * 1024;

export const PHASE13_COMPUTER_TOOL_NAMES = [
  "capture_screen",
  "control_computer",
] as const;

export type ComputerToolName = (typeof PHASE13_COMPUTER_TOOL_NAMES)[number];

interface Runtime {
  operation: "screen.capture" | "computer.input";
  permission: "SCREEN_READ" | "INPUT_CONTROL";
  risk: "HIGH" | "CRITICAL";
  capability: "computer.screen.capture" | "computer.input";
  sideEffect: boolean;
}

const RUNTIME: Record<ComputerToolName, Runtime> = {
  capture_screen: {
    operation: "screen.capture",
    permission: "SCREEN_READ",
    risk: "HIGH",
    capability: "computer.screen.capture",
    sideEffect: false,
  },
  control_computer: {
    operation: "computer.input",
    permission: "INPUT_CONTROL",
    risk: "CRITICAL",
    capability: "computer.input",
    sideEffect: true,
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
  error: { code: string; message: string };
}

export interface CaptureScreenResult extends Record<string, unknown> {
  media_type: string;
  data_base64: string;
  width: number;
  height: number;
  captured_at: string;
  source: string;
  untrusted: boolean;
}

export class ComputerToolsError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly approvalId: string | null = null,
  ) {
    super(message);
    this.name = "ComputerToolsError";
  }
}

export class ComputerToolsService {
  constructor(
    private readonly db: D1Database,
    private readonly coordinators: DurableObjectNamespace,
  ) {}

  async execute(
    userId: string,
    toolName: ComputerToolName,
    input: Record<string, unknown>,
    caller?: CallerContext,
  ): Promise<Record<string, unknown>> {
    const deviceId = input.device_id;
    if (typeof deviceId !== "string" || deviceId.length < 3) {
      throw new ComputerToolsError(
        "INVALID_ARGUMENT",
        "Computer-use tool requires a valid device_id",
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
      throw new ComputerToolsError("DEVICE_OFFLINE", "Device is offline");
    }
    if (!presence.capabilities.includes(runtime.capability)) {
      throw new ComputerToolsError(
        "UNSUPPORTED_CAPABILITY",
        "Device does not advertise the requested computer-use capability",
      );
    }

    validateInput(toolName, input);
    const publicIdempotency =
      toolName === "control_computer" ? input.idempotency_key : undefined;
    if (
      toolName === "control_computer" &&
      (typeof publicIdempotency !== "string" ||
        publicIdempotency.length < 8 ||
        publicIdempotency.length > 160)
    ) {
      throw new ComputerToolsError(
        "INVALID_ARGUMENT",
        "control_computer requires a valid idempotency_key",
      );
    }

    const argumentsObject = Object.fromEntries(
      Object.entries(input).filter(
        ([key]) =>
          key !== "device_id" &&
          key !== "workspace_id" &&
          key !== "idempotency_key",
      ),
    );
    if (
      new TextEncoder().encode(JSON.stringify(argumentsObject)).byteLength >
      MAX_ARGUMENT_BYTES
    ) {
      throw new ComputerToolsError(
        "INVALID_ARGUMENT",
        "Computer-use arguments exceed the bounded transport limit",
      );
    }

    const commandId = `cmd_${crypto.randomUUID()}`;
    const idempotencyKey = runtime.sideEffect
      ? (publicIdempotency as string)
      : null;
    const deadlineAt = new Date(
      Date.now() +
        (toolName === "control_computer"
          ? INPUT_TIMEOUT_MS
          : CAPTURE_TIMEOUT_MS),
    ).toISOString();
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
        requestedPermissions: [runtime.permission] as PermissionDomain[],
        risk: runtime.risk,
        idempotencyKey,
      });
    } catch (error) {
      if (error instanceof GovernanceError) {
        throw new ComputerToolsError(
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
        error instanceof ComputerToolsError &&
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
      throw new ComputerToolsError("NOT_FOUND", "Device not found");
    }
  }

  private async readPresence(
    coordinator: DurableObjectStub,
  ): Promise<Presence> {
    const response = await coordinator.fetch(
      "https://device-coordinator/internal/presence",
    );
    if (!response.ok) {
      throw new ComputerToolsError(
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
          throw new ComputerToolsError(
            "INTERNAL_ERROR",
            "Device returned an invalid computer-use result",
          );
        }
        return validateResult(result as Record<string, unknown>);
      }
      if (command.message_type === "approval.request") {
        const approvalId = command.payload?.approval_id;
        throw new ComputerToolsError(
          "APPROVAL_REQUIRED",
          "The local device policy requires explicit Telechir approval",
          typeof approvalId === "string" ? approvalId : null,
        );
      }
      if (command.message_type === "command.cancelled") {
        throw new ComputerToolsError(
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
          const object = remoteError as Record<string, unknown>;
          throw new ComputerToolsError(
            typeof object.code === "string" ? object.code : "INTERNAL_ERROR",
            safeRemoteMessage(object.message),
          );
        }
        throw new ComputerToolsError(
          "INTERNAL_ERROR",
          "Device returned an invalid computer-use error",
        );
      }
      await wait(POLL_INTERVAL_MS);
    }

    throw new ComputerToolsError(
      "DEADLINE_EXCEEDED",
      "Computer-use operation exceeded its command deadline",
    );
  }
}

function validateInput(
  toolName: ComputerToolName,
  input: Record<string, unknown>,
): void {
  if (toolName === "capture_screen") {
    requireExactKeys(input, ["device_id", "max_width", "max_height"]);
    for (const [name, value, max] of [
      ["max_width", input.max_width, 320],
      ["max_height", input.max_height, 240],
    ] as const) {
      if (
        value !== undefined &&
        (typeof value !== "number" ||
          !Number.isInteger(value) ||
          value < 64 ||
          value > max)
      ) {
        throw new ComputerToolsError(
          "INVALID_ARGUMENT",
          `${name} must be an integer within the bounded screen-capture range`,
        );
      }
    }
    return;
  }

  requireExactKeys(input, ["device_id", "idempotency_key", "action"]);
  const action = input.action;
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    throw new ComputerToolsError(
      "INVALID_ARGUMENT",
      "control_computer requires one typed action object",
    );
  }

  const object = action as Record<string, unknown>;
  const kind = object.kind;
  if (typeof kind !== "string") {
    throw new ComputerToolsError(
      "INVALID_ARGUMENT",
      "control_computer action kind is not supported",
    );
  }

  switch (kind) {
    case "move_pointer":
      requireExactKeys(object, ["kind", "x", "y"]);
      validateCoordinates(object.x, object.y);
      return;
    case "click":
      requireExactKeys(object, ["kind", "x", "y", "button", "click_count"]);
      validateCoordinates(object.x, object.y);
      if (!["left", "right", "middle"].includes(String(object.button))) {
        throw new ComputerToolsError(
          "INVALID_ARGUMENT",
          "click button must be left, right, or middle",
        );
      }
      if (
        object.click_count !== undefined &&
        (typeof object.click_count !== "number" ||
          !Number.isInteger(object.click_count) ||
          object.click_count < 1 ||
          object.click_count > 2)
      ) {
        throw new ComputerToolsError(
          "INVALID_ARGUMENT",
          "click_count must be 1 or 2",
        );
      }
      return;
    case "scroll":
      requireExactKeys(object, ["kind", "x", "y", "delta_y"]);
      validateCoordinates(object.x, object.y);
      if (
        typeof object.delta_y !== "number" ||
        !Number.isInteger(object.delta_y) ||
        object.delta_y === 0 ||
        Math.abs(object.delta_y) > 1_200
      ) {
        throw new ComputerToolsError(
          "INVALID_ARGUMENT",
          "scroll delta_y must be a non-zero integer within -1200..1200",
        );
      }
      return;
    case "key": {
      requireExactKeys(object, ["kind", "key", "modifiers"]);
      if (typeof object.key !== "string" || !isAllowedKey(object.key)) {
        throw new ComputerToolsError(
          "INVALID_ARGUMENT",
          "key must be a bounded named key, A-Z, 0-9, or F1-F12",
        );
      }
      const modifiers = object.modifiers ?? [];
      if (
        !Array.isArray(modifiers) ||
        modifiers.length > 4 ||
        !modifiers.every(
          (modifier) =>
            typeof modifier === "string" &&
            ["ctrl", "alt", "shift", "meta"].includes(modifier),
        ) ||
        new Set(modifiers).size !== modifiers.length
      ) {
        throw new ComputerToolsError(
          "INVALID_ARGUMENT",
          "key modifiers must be unique values from ctrl, alt, shift, meta",
        );
      }
      return;
    }
    case "type_text":
      requireExactKeys(object, ["kind", "text"]);
      if (
        typeof object.text !== "string" ||
        object.text.length === 0 ||
        [...object.text].length > 2_000 ||
        /[\u0000-\u001f\u007f]/u.test(object.text)
      ) {
        throw new ComputerToolsError(
          "INVALID_ARGUMENT",
          "type_text must contain 1..2000 non-control characters",
        );
      }
      return;
    default:
      throw new ComputerToolsError(
        "INVALID_ARGUMENT",
        "control_computer action kind is not supported",
      );
  }
}

function requireExactKeys(
  object: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(object).some((key) => !allowedSet.has(key))) {
    throw new ComputerToolsError(
      "INVALID_ARGUMENT",
      "computer-use request contains unsupported fields",
    );
  }
}

function validateCoordinates(x: unknown, y: unknown): void {
  for (const [name, value] of [
    ["x", x],
    ["y", y],
  ] as const) {
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < -100_000 ||
      value > 100_000
    ) {
      throw new ComputerToolsError(
        "INVALID_ARGUMENT",
        `${name} must be an integer within the bounded coordinate envelope`,
      );
    }
  }
}

function isAllowedKey(value: string): boolean {
  const normalized = value.trim().toUpperCase();
  if (/^[A-Z0-9]$/u.test(normalized)) {
    return true;
  }
  return [
    "ENTER",
    "TAB",
    "ESCAPE",
    "BACKSPACE",
    "DELETE",
    "SPACE",
    "ARROWUP",
    "ARROWDOWN",
    "ARROWLEFT",
    "ARROWRIGHT",
    "HOME",
    "END",
    "PAGEUP",
    "PAGEDOWN",
    "F1",
    "F2",
    "F3",
    "F4",
    "F5",
    "F6",
    "F7",
    "F8",
    "F9",
    "F10",
    "F11",
    "F12",
  ].includes(normalized);
}

function validateResult(
  result: Record<string, unknown>,
): Record<string, unknown> {
  if ("data_base64" in result) {
    if (
      typeof result.data_base64 !== "string" ||
      result.data_base64.length > 246 * 1024 ||
      typeof result.media_type !== "string" ||
      typeof result.width !== "number" ||
      typeof result.height !== "number"
    ) {
      throw new ComputerToolsError(
        "OUTPUT_TRUNCATED",
        "Device returned an invalid or oversized screen capture",
      );
    }
  }
  return result;
}

function safeRemoteMessage(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    return "Computer-use operation failed on the device";
  }
  return value.slice(0, 300);
}

async function responseError(response: Response): Promise<ComputerToolsError> {
  try {
    const body = (await response.json()) as FailureEnvelope;
    if (body && body.ok === false && typeof body.error?.code === "string") {
      return new ComputerToolsError(
        body.error.code,
        safeRemoteMessage(body.error.message),
      );
    }
  } catch {
    // Fall through to a non-sensitive generic error.
  }
  return new ComputerToolsError(
    "INTERNAL_ERROR",
    "Computer-use command dispatch failed",
  );
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
