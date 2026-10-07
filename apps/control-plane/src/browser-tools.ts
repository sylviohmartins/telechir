import {
  GovernanceError,
  GovernanceService,
  type CallerContext,
} from "./governance";
import type { PermissionDomain } from "./policy";

const POLL_INTERVAL_MS = 10;
const MAX_ARGUMENT_BYTES = 32 * 1024;
const MAX_RESULT_BYTES = 160 * 1024;

export const PHASE14_BROWSER_TOOL_NAMES = [
  "open_browser_session",
  "get_browser_snapshot",
  "navigate_browser",
  "click_browser",
  "fill_browser",
  "close_browser_session",
] as const;

export type BrowserToolName = (typeof PHASE14_BROWSER_TOOL_NAMES)[number];

type BrowserOperation =
  | "browser.session.open"
  | "browser.snapshot"
  | "browser.navigate"
  | "browser.click"
  | "browser.fill"
  | "browser.session.close";

interface Runtime {
  operation: BrowserOperation;
  capability:
    | "browser.session"
    | "browser.snapshot"
    | "browser.navigate"
    | "browser.click"
    | "browser.fill";
  sideEffect: boolean;
  timeoutMs: number;
}

const RUNTIME: Record<BrowserToolName, Runtime> = {
  open_browser_session: {
    operation: "browser.session.open",
    capability: "browser.session",
    sideEffect: true,
    timeoutMs: 30_000,
  },
  get_browser_snapshot: {
    operation: "browser.snapshot",
    capability: "browser.snapshot",
    sideEffect: false,
    timeoutMs: 15_000,
  },
  navigate_browser: {
    operation: "browser.navigate",
    capability: "browser.navigate",
    sideEffect: true,
    timeoutMs: 25_000,
  },
  click_browser: {
    operation: "browser.click",
    capability: "browser.click",
    sideEffect: true,
    timeoutMs: 20_000,
  },
  fill_browser: {
    operation: "browser.fill",
    capability: "browser.fill",
    sideEffect: true,
    timeoutMs: 20_000,
  },
  close_browser_session: {
    operation: "browser.session.close",
    capability: "browser.session",
    sideEffect: true,
    timeoutMs: 12_000,
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

export class BrowserToolsError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly approvalId: string | null = null,
  ) {
    super(message);
    this.name = "BrowserToolsError";
  }
}

export class BrowserToolsService {
  constructor(
    private readonly db: D1Database,
    private readonly coordinators: DurableObjectNamespace,
  ) {}

  async execute(
    userId: string,
    toolName: BrowserToolName,
    input: Record<string, unknown>,
    caller?: CallerContext,
  ): Promise<Record<string, unknown>> {
    const deviceId = input.device_id;
    if (typeof deviceId !== "string" || deviceId.length < 3) {
      throw new BrowserToolsError(
        "INVALID_ARGUMENT",
        "Browser tool requires a valid device_id",
      );
    }
    await this.requireOwnedActiveDevice(userId, deviceId);

    const runtime = RUNTIME[toolName];
    const coordinator = this.coordinators.get(
      this.coordinators.idFromName(deviceId),
    );
    const presence = await this.readPresence(coordinator);
    if (!presence.online) {
      throw new BrowserToolsError("DEVICE_OFFLINE", "Device is offline");
    }

    const requiredCapabilities = [
      "browser.playwright",
      runtime.capability,
      runtime.operation,
    ];
    if (
      requiredCapabilities.some(
        (capability) => !presence.capabilities.includes(capability),
      )
    ) {
      throw new BrowserToolsError(
        "UNSUPPORTED_CAPABILITY",
        "Device does not advertise the complete browser capability set",
      );
    }

    validateInput(toolName, input);
    const publicIdempotency = input.idempotency_key;
    if (
      runtime.sideEffect &&
      (typeof publicIdempotency !== "string" ||
        publicIdempotency.length < 8 ||
        publicIdempotency.length > 160)
    ) {
      throw new BrowserToolsError(
        "INVALID_ARGUMENT",
        `${toolName} requires a valid idempotency_key`,
      );
    }

    const argumentsObject = Object.fromEntries(
      Object.entries(input).filter(
        ([key]) => key !== "device_id" && key !== "idempotency_key",
      ),
    );
    if (
      new TextEncoder().encode(JSON.stringify(argumentsObject)).byteLength >
      MAX_ARGUMENT_BYTES
    ) {
      throw new BrowserToolsError(
        "INVALID_ARGUMENT",
        "Browser arguments exceed the bounded transport limit",
      );
    }

    const commandId = `cmd_${crypto.randomUUID()}`;
    const idempotencyKey = runtime.sideEffect
      ? (publicIdempotency as string)
      : null;
    const deadlineAt = new Date(Date.now() + runtime.timeoutMs).toISOString();
    const governance = new GovernanceService(this.db);

    let governed;
    try {
      governed = await governance.prepareCommand({
        commandId,
        userId,
        ...(caller ? { caller } : {}),
        deviceId,
        toolName,
        operation: runtime.operation,
        arguments: argumentsObject,
        requestedPermissions: ["BROWSER"] as PermissionDomain[],
        risk: "HIGH",
        idempotencyKey,
      });
    } catch (error) {
      if (error instanceof GovernanceError) {
        throw new BrowserToolsError(
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
          requested_permissions: ["BROWSER"],
          risk: "HIGH",
          deadline_at: deadlineAt,
          user_id: userId,
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
      return await this.awaitResult(
        coordinator,
        toolName,
        commandId,
        deadlineAt,
      );
    } catch (error) {
      retainCorrelation =
        error instanceof BrowserToolsError &&
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
      throw new BrowserToolsError("NOT_FOUND", "Device not found");
    }
  }

  private async readPresence(
    coordinator: DurableObjectStub,
  ): Promise<Presence> {
    const response = await coordinator.fetch(
      "https://device-coordinator/internal/presence",
    );
    if (!response.ok) {
      throw new BrowserToolsError(
        "INTERNAL_ERROR",
        "Device presence could not be resolved",
      );
    }
    const body = (await response.json()) as SuccessEnvelope<Presence>;
    return body.data;
  }

  private async awaitResult(
    coordinator: DurableObjectStub,
    toolName: BrowserToolName,
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
          throw new BrowserToolsError(
            "INTERNAL_ERROR",
            "Device returned an invalid browser result",
          );
        }
        return validateResult(toolName, result as Record<string, unknown>);
      }
      if (command.message_type === "approval.request") {
        const approvalId = command.payload?.approval_id;
        throw new BrowserToolsError(
          "APPROVAL_REQUIRED",
          "The local device policy requires explicit Telechir approval",
          typeof approvalId === "string" ? approvalId : null,
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
          throw new BrowserToolsError(
            typeof object.code === "string" ? object.code : "INTERNAL_ERROR",
            safeRemoteMessage(object.message),
          );
        }
        throw new BrowserToolsError(
          "INTERNAL_ERROR",
          "Device returned an invalid browser error",
        );
      }
      await wait(POLL_INTERVAL_MS);
    }

    throw new BrowserToolsError(
      "DEADLINE_EXCEEDED",
      "Browser operation exceeded its command deadline",
    );
  }
}

function validateInput(
  toolName: BrowserToolName,
  input: Record<string, unknown>,
): void {
  switch (toolName) {
    case "open_browser_session":
      requireExactKeys(input, ["device_id", "idempotency_key"]);
      return;
    case "get_browser_snapshot":
      requireExactKeys(input, ["device_id", "browser_session_id"]);
      validateSessionId(input.browser_session_id);
      return;
    case "navigate_browser":
      requireExactKeys(input, [
        "device_id",
        "idempotency_key",
        "browser_session_id",
        "url",
      ]);
      validateSessionId(input.browser_session_id);
      validateUrl(input.url);
      return;
    case "click_browser":
      requireExactKeys(input, [
        "device_id",
        "idempotency_key",
        "browser_session_id",
        "locator",
      ]);
      validateSessionId(input.browser_session_id);
      validateLocator(input.locator);
      return;
    case "fill_browser":
      requireExactKeys(input, [
        "device_id",
        "idempotency_key",
        "browser_session_id",
        "locator",
        "text",
      ]);
      validateSessionId(input.browser_session_id);
      validateLocator(input.locator);
      validateText(input.text, 2_000, "fill text");
      return;
    case "close_browser_session":
      requireExactKeys(input, [
        "device_id",
        "idempotency_key",
        "browser_session_id",
      ]);
      validateSessionId(input.browser_session_id);
      return;
  }
}

function validateSessionId(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < 8 ||
    value.length > 96 ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new BrowserToolsError(
      "INVALID_ARGUMENT",
      "browser_session_id must be a bounded opaque identifier",
    );
  }
}

function validateUrl(value: unknown): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) {
    throw new BrowserToolsError(
      "INVALID_ARGUMENT",
      "Browser URL must be a bounded absolute URL",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new BrowserToolsError(
      "INVALID_ARGUMENT",
      "Browser URL must be absolute",
    );
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new BrowserToolsError(
      "POLICY_DENIED",
      "Browser URL scheme is not allowed",
    );
  }
  if (parsed.username || parsed.password) {
    throw new BrowserToolsError(
      "POLICY_DENIED",
      "Browser URL cannot embed credentials",
    );
  }
}

function validateLocator(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrowserToolsError(
      "INVALID_ARGUMENT",
      "Browser locator must be an object",
    );
  }
  const locator = value as Record<string, unknown>;
  const kind = locator.kind;
  if (kind === "role") {
    requireExactKeys(locator, ["kind", "role", "name", "exact", "index"]);
    if (
      typeof locator.role !== "string" ||
      ![
        "button",
        "link",
        "textbox",
        "checkbox",
        "radio",
        "combobox",
        "option",
        "menuitem",
        "tab",
        "heading",
        "listitem",
        "row",
        "cell",
        "switch",
        "slider",
        "spinbutton",
      ].includes(locator.role)
    ) {
      throw new BrowserToolsError(
        "INVALID_ARGUMENT",
        "Browser role is outside the Phase 14 allowlist",
      );
    }
    validateText(locator.name, 256, "locator name");
  } else if (
    kind === "label" ||
    kind === "text" ||
    kind === "placeholder" ||
    kind === "test_id"
  ) {
    const allowed =
      kind === "test_id"
        ? ["kind", "value", "index"]
        : ["kind", "value", "exact", "index"];
    requireExactKeys(locator, allowed);
    validateText(locator.value, 256, "locator value");
  } else {
    throw new BrowserToolsError(
      "INVALID_ARGUMENT",
      "Browser locator kind is not supported",
    );
  }

  if (locator.exact !== undefined && typeof locator.exact !== "boolean") {
    throw new BrowserToolsError(
      "INVALID_ARGUMENT",
      "Browser locator exact must be boolean",
    );
  }
  if (
    locator.index !== undefined &&
    (typeof locator.index !== "number" ||
      !Number.isInteger(locator.index) ||
      locator.index < 0 ||
      locator.index > 9)
  ) {
    throw new BrowserToolsError(
      "INVALID_ARGUMENT",
      "Browser locator index must be between 0 and 9",
    );
  }
}

function validateText(value: unknown, max: number, name: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    [...value].length > max ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new BrowserToolsError(
      "INVALID_ARGUMENT",
      `${name} must contain 1..${max} non-control characters`,
    );
  }
}

function requireExactKeys(
  object: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(object).some((key) => !allowedSet.has(key))) {
    throw new BrowserToolsError(
      "INVALID_ARGUMENT",
      "Browser request contains unsupported fields",
    );
  }
}

function validateResult(
  toolName: BrowserToolName,
  result: Record<string, unknown>,
): Record<string, unknown> {
  if (
    new TextEncoder().encode(JSON.stringify(result)).byteLength >
    MAX_RESULT_BYTES
  ) {
    throw new BrowserToolsError(
      "OUTPUT_TRUNCATED",
      "Device browser result exceeds the bounded result limit",
    );
  }

  if (toolName === "get_browser_snapshot") {
    if (
      typeof result.browser_session_id !== "string" ||
      typeof result.url !== "string" ||
      typeof result.title !== "string" ||
      typeof result.snapshot !== "string" ||
      typeof result.captured_at !== "string" ||
      result.untrusted !== true ||
      typeof result.truncated !== "boolean"
    ) {
      throw new BrowserToolsError(
        "INTERNAL_ERROR",
        "Device returned an invalid browser snapshot",
      );
    }
    if (new TextEncoder().encode(result.snapshot).byteLength > 48 * 1024) {
      throw new BrowserToolsError(
        "OUTPUT_TRUNCATED",
        "Browser snapshot exceeds the bounded semantic snapshot limit",
      );
    }
  }
  return result;
}

function safeRemoteMessage(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    return "Browser operation failed on the device";
  }
  return value.replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, 300);
}

async function responseError(response: Response): Promise<BrowserToolsError> {
  try {
    const body = (await response.json()) as FailureEnvelope;
    if (body && body.ok === false && typeof body.error?.code === "string") {
      return new BrowserToolsError(
        body.error.code,
        safeRemoteMessage(body.error.message),
      );
    }
  } catch {
    // Fall through to a generic non-sensitive error.
  }
  return new BrowserToolsError(
    "INTERNAL_ERROR",
    "Browser command dispatch failed",
  );
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
