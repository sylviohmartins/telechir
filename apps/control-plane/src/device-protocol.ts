import { isPermission, isRisk } from "./policy";

export const DEVICE_PROTOCOL_VERSION = "0.1";
export const MAX_FRAME_BYTES = 256 * 1024;
export const HEARTBEAT_INTERVAL_SECONDS = 30;

const AGENT_MESSAGE_TYPES = new Set([
  "agent.hello",
  "heartbeat",
  "capabilities.changed",
  "command.accepted",
  "command.chunk",
  "command.completed",
  "command.failed",
  "command.cancelled",
  "approval.request",
  "protocol.error",
]);

export interface DeviceEnvelope {
  protocol_version: string;
  message_type: string;
  message_id: string;
  correlation_id?: string | null;
  device_id: string;
  session_id?: string | null;
  connection_id?: string | null;
  sequence: number;
  sent_at: string;
  deadline_at?: string | null;
  payload: Record<string, unknown>;
}

export class DeviceProtocolError extends Error {}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DeviceProtocolError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringField(
  value: Record<string, unknown>,
  name: string,
  min = 1,
  max = 2048,
): string {
  const field = value[name];
  if (typeof field !== "string" || field.length < min || field.length > max) {
    throw new DeviceProtocolError(
      `${name} must be a string with length ${min}..${max}`,
    );
  }
  return field;
}

function nonNegativeInteger(
  value: Record<string, unknown>,
  name: string,
): number {
  const field = value[name];
  if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) {
    throw new DeviceProtocolError(
      `${name} must be a non-negative safe integer`,
    );
  }
  return field;
}

function timestamp(value: Record<string, unknown>, name: string): string {
  const field = stringField(value, name, 1, 64);
  if (!Number.isFinite(Date.parse(field))) {
    throw new DeviceProtocolError(`${name} must be RFC3339-compatible`);
  }
  return field;
}
function stringArray(
  value: Record<string, unknown>,
  name: string,
  allowEmpty = true,
): string[] {
  const field = value[name];
  if (
    !Array.isArray(field) ||
    (!allowEmpty && field.length === 0) ||
    field.some((item) => typeof item !== "string")
  ) {
    throw new DeviceProtocolError(`${name} must be an array of strings`);
  }
  if (new Set(field).size !== field.length) {
    throw new DeviceProtocolError(`${name} must contain unique values`);
  }
  return field as string[];
}

function validatePayload(
  messageType: string,
  payload: Record<string, unknown>,
): void {
  switch (messageType) {
    case "agent.hello":
      stringField(payload, "device_public_id", 3, 128);
      stringField(payload, "device_key_id", 3, 128);
      stringField(payload, "agent_version", 1, 64);
      stringField(payload, "os", 1, 64);
      stringField(payload, "arch", 1, 64);
      stringArray(payload, "supported_protocol_versions", false);
      stringArray(payload, "capabilities");
      stringField(payload, "connection_nonce", 16, 128);
      return;
    case "heartbeat":
      timestamp(payload, "agent_time");
      nonNegativeInteger(payload, "last_received_sequence");
      return;
    case "capabilities.changed":
      stringArray(payload, "capabilities");
      if (
        payload.agent_version !== undefined &&
        payload.agent_version !== null
      ) {
        stringField(payload, "agent_version", 1, 64);
      }
      if (payload.reason !== undefined && payload.reason !== null) {
        stringField(payload, "reason", 1, 500);
      }
      return;
    case "command.accepted":
    case "command.chunk":
    case "command.completed":
    case "command.failed":
    case "command.cancelled":
      stringField(payload, "command_id", 1, 160);
      return;
    case "approval.request": {
      stringField(payload, "approval_id", 8, 160);
      stringField(payload, "command_id", 1, 160);
      if (!isPermission(payload.permission)) {
        throw new DeviceProtocolError(
          "permission must be a known permission domain",
        );
      }
      if (!isRisk(payload.risk)) {
        throw new DeviceProtocolError("risk must be a known risk level");
      }
      const digest = stringField(payload, "argument_digest", 43, 43);
      if (!/^[A-Za-z0-9_-]{43}$/u.test(digest)) {
        throw new DeviceProtocolError(
          "argument_digest must be a SHA-256 base64url digest",
        );
      }
      timestamp(payload, "expires_at");
      if (
        payload.human_summary !== undefined &&
        payload.human_summary !== null &&
        (typeof payload.human_summary !== "string" ||
          payload.human_summary.length > 2000)
      ) {
        throw new DeviceProtocolError(
          "human_summary must be a string with at most 2000 characters",
        );
      }
      return;
    }
    case "protocol.error":
      object(payload.error, "error");
      return;
    default:
      throw new DeviceProtocolError(
        `message_type ${messageType} is not valid from agent to server`,
      );
  }
}

export function parseAgentFrame(raw: string): DeviceEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DeviceProtocolError("frame must contain valid JSON");
  }

  const envelope = object(parsed, "frame");
  const protocolVersion = stringField(envelope, "protocol_version", 1, 16);
  if (protocolVersion !== DEVICE_PROTOCOL_VERSION) {
    throw new DeviceProtocolError("unsupported protocol version");
  }

  const messageType = stringField(envelope, "message_type", 1, 64);
  if (!AGENT_MESSAGE_TYPES.has(messageType)) {
    throw new DeviceProtocolError(
      `message_type ${messageType} is not valid from agent to server`,
    );
  }

  const messageId = stringField(envelope, "message_id", 8, 128);
  const deviceId = stringField(envelope, "device_id", 3, 128);
  const sequence = nonNegativeInteger(envelope, "sequence");
  const sentAt = timestamp(envelope, "sent_at");
  const payload = object(envelope.payload, "payload");
  validatePayload(messageType, payload);

  return {
    protocol_version: protocolVersion,
    message_type: messageType,
    message_id: messageId,
    correlation_id:
      envelope.correlation_id === null || envelope.correlation_id === undefined
        ? null
        : stringField(envelope, "correlation_id", 8, 128),
    device_id: deviceId,
    session_id:
      envelope.session_id === null || envelope.session_id === undefined
        ? null
        : stringField(envelope, "session_id", 1, 128),
    connection_id:
      envelope.connection_id === null || envelope.connection_id === undefined
        ? null
        : stringField(envelope, "connection_id", 1, 128),
    sequence,
    sent_at: sentAt,
    deadline_at:
      envelope.deadline_at === null || envelope.deadline_at === undefined
        ? null
        : timestamp(envelope, "deadline_at"),
    payload,
  };
}
export function serverEnvelope(input: {
  messageType: string;
  deviceId: string;
  connectionId: string;
  sequence: number;
  correlationId?: string | null;
  sessionId?: string | null;
  deadlineAt?: string | null;
  payload: Record<string, unknown>;
}): DeviceEnvelope {
  return {
    protocol_version: DEVICE_PROTOCOL_VERSION,
    message_type: input.messageType,
    message_id: `msg_${crypto.randomUUID()}`,
    correlation_id: input.correlationId ?? null,
    device_id: input.deviceId,
    session_id: input.sessionId ?? null,
    connection_id: input.connectionId,
    sequence: input.sequence,
    sent_at: new Date().toISOString(),
    deadline_at: input.deadlineAt ?? null,
    payload: input.payload,
  };
}
