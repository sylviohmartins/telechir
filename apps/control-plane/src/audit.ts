const MAX_METADATA_DEPTH = 4;
const MAX_METADATA_KEYS = 32;
const MAX_ARRAY_ITEMS = 32;
const MAX_STRING_LENGTH = 500;

const SENSITIVE_KEY =
  /(?:authorization|bearer|token|secret|password|passwd|cookie|credential|private[_-]?key|api[_-]?key)/iu;
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu;

export interface AuditEventInput {
  userId?: string | null;
  deviceId?: string | null;
  sessionId?: string | null;
  commandId?: string | null;
  eventType: string;
  decision?: string | null;
  risk?: string | null;
  targetDigest?: string | null;
  metadata?: Record<string, unknown>;
}

function boundedString(value: string): string {
  const redacted = value.replace(BEARER_VALUE, "Bearer [REDACTED]");
  return redacted.length <= MAX_STRING_LENGTH
    ? redacted
    : `${redacted.slice(0, MAX_STRING_LENGTH)}…`;
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth >= MAX_METADATA_DEPTH) {
    return "[TRUNCATED]";
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (typeof value === "string") {
    return boundedString(value);
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => redactValue(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .slice(0, MAX_METADATA_KEYS)
      .map(([key, child]) => [
        key,
        SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactValue(child, depth + 1),
      ]);
    return Object.fromEntries(entries);
  }
  return String(value).slice(0, MAX_STRING_LENGTH);
}

export function redactAuditMetadata(
  metadata: Record<string, unknown> = {},
): Record<string, unknown> {
  const redacted = redactValue(metadata, 0);
  return redacted && typeof redacted === "object" && !Array.isArray(redacted)
    ? (redacted as Record<string, unknown>)
    : {};
}

export class AuditService {
  constructor(private readonly db: D1Database) {}

  async append(input: AuditEventInput): Promise<string> {
    const id = `audit_${crypto.randomUUID()}`;
    const metadata = redactAuditMetadata(input.metadata);

    await this.db
      .prepare(
        `INSERT INTO audit_events (
           id, user_id, device_id, session_id, command_id,
           event_type, decision, risk, target_digest, metadata_json, created_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.userId ?? null,
        input.deviceId ?? null,
        input.sessionId ?? null,
        input.commandId ?? null,
        input.eventType,
        input.decision ?? null,
        input.risk ?? null,
        input.targetDigest ?? null,
        JSON.stringify(metadata),
        new Date().toISOString(),
      )
      .run();

    return id;
  }
}
