import {
  DEVICE_PROTOCOL_VERSION,
  HEARTBEAT_INTERVAL_SECONDS,
  MAX_FRAME_BYTES,
  DeviceProtocolError,
  parseAgentFrame,
  serverEnvelope,
} from "./device-protocol";
import type { Env } from "./env";
import { GovernanceError, GovernanceService } from "./governance";
import { failure, success } from "./http";
import { PROJECT_PHASE, SERVICE_VERSION } from "./meta";
import {
  commandArgumentDigest,
  isPermission,
  isRisk,
  type RiskLevel,
} from "./policy";

const MAX_RECENT_MESSAGE_IDS = 32;
const MAX_RECENT_CREDENTIALS = 128;
const MAX_CORRELATED_COMMANDS = 256;
const ACTIVE_DEVICE_OPERATIONS = new Set([
  "fs.list",
  "fs.stat",
  "fs.read",
  "fs.write",
  "fs.patch",
  "fs.search",
  "shell.exec",
  "process.start",
  "process.read",
  "process.write",
  "process.cancel",
  "process.list",
  "git.status",
  "git.diff",
]);
const SIDE_EFFECT_OPERATIONS = new Set([
  "fs.write",
  "fs.patch",
  "shell.exec",
  "process.start",
  "process.write",
  "process.cancel",
]);
const MAX_COMMAND_DEADLINE_MS = 130_000;
const REPLACED_CLOSE_CODE = 4001;
const PROTOCOL_CLOSE_CODE = 4002;
const REVOKED_CLOSE_CODE = 4003;

interface InternalCommandRequest {
  command_id: string;
  idempotency_key: string | null;
  operation: string;
  arguments: Record<string, unknown>;
  requested_permissions: string[];
  risk: RiskLevel;
  deadline_at: string;
  user_id: string;
  session_id: string;
  tool_name: string;
  argument_digest: string;
  approval_id?: string | null;
}

interface CorrelatedCommandState {
  command_id: string;
  message_type:
    | "command.request"
    | "command.accepted"
    | "command.chunk"
    | "command.completed"
    | "command.failed"
    | "command.cancelled"
    | "approval.request";
  message_id: string;
  sequence: number;
  received_at: string;
  payload?: Record<string, unknown>;
  request?: InternalCommandRequest;
}

interface PreparedOutboundFrame {
  encoded: string;
  messageId: string;
  sequence: number;
}

interface ConnectionAttachment {
  deviceId: string;
  deviceKeyId: string;
  credentialJti: string;
  connectionNonce: string;
  connectionId: string;
  helloReceived: boolean;
  lastInboundSequence: number;
  nextOutboundSequence: number;
  recentMessageIds: string[];
  lastHeartbeatAt: string | null;
  capabilities: string[];
}

function requiredHeader(request: Request, name: string): string {
  const value = request.headers.get(name);
  if (!value) {
    throw new Error(`missing internal header: ${name}`);
  }
  return value;
}

export class DeviceCoordinator {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    void this.env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return success({
        component: "device-coordinator",
        status: "ready",
        phase: PROJECT_PHASE,
        version: SERVICE_VERSION,
        realtime: true,
        active_connections: this.state.getWebSockets("active").length,
      });
    }

    if (request.method === "GET" && url.pathname === "/internal/presence") {
      const sockets = this.state.getWebSockets("active");
      const attachment = sockets[0]?.deserializeAttachment() as
        ConnectionAttachment | undefined;
      return success({
        online: sockets.some((socket) => socket.readyState === WebSocket.OPEN),
        connection_id: attachment?.connectionId ?? null,
        last_heartbeat_at: attachment?.lastHeartbeatAt ?? null,
        capabilities: attachment?.capabilities ?? [],
      });
    }

    if (request.method === "POST" && url.pathname === "/internal/revoke") {
      const expectedDeviceId = requiredHeader(request, "x-telechir-device-id");
      for (const socket of this.state.getWebSockets()) {
        const attachment =
          socket.deserializeAttachment() as ConnectionAttachment | null;
        if (!attachment || attachment.deviceId === expectedDeviceId) {
          socket.close(REVOKED_CLOSE_CODE, "device revoked");
        }
      }
      await this.state.storage.put("revoked", true);
      return success({ revoked: true, active_connections: 0 });
    }

    if (request.method === "GET" && url.pathname === "/connect") {
      return this.acceptConnection(request);
    }

    if (request.method === "POST" && url.pathname === "/internal/commands") {
      return this.dispatchCommand(request);
    }

    const commandMatch = /^\/internal\/commands\/([^/]+)$/u.exec(url.pathname);
    if (commandMatch && request.method === "GET") {
      const command = await this.state.storage.get<CorrelatedCommandState>(
        `command:${commandMatch[1]!}`,
      );
      return command
        ? success(command)
        : failure("NOT_FOUND", "Command correlation not found", 404);
    }
    if (commandMatch && request.method === "DELETE") {
      await this.state.storage.delete(`command:${commandMatch[1]!}`);
      return success({ deleted: true });
    }

    const approvalDecisionMatch =
      /^\/internal\/approvals\/([^/]+)\/decision$/u.exec(url.pathname);
    if (approvalDecisionMatch && request.method === "POST") {
      return this.decideApproval(request, approvalDecisionMatch[1]!);
    }

    return failure("ROUTE_NOT_FOUND", "Route not found", 404);
  }
  async webSocketMessage(
    socket: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (typeof message !== "string") {
      socket.close(PROTOCOL_CLOSE_CODE, "binary frames unsupported");
      return;
    }
    if (new TextEncoder().encode(message).byteLength > MAX_FRAME_BYTES) {
      socket.close(1009, "frame exceeds negotiated limit");
      return;
    }

    let frame;
    try {
      frame = parseAgentFrame(message);
    } catch (error) {
      const reason =
        error instanceof DeviceProtocolError
          ? error.message
          : "invalid protocol frame";
      socket.close(PROTOCOL_CLOSE_CODE, reason.slice(0, 120));
      return;
    }

    const attachment =
      socket.deserializeAttachment() as ConnectionAttachment | null;
    if (!attachment) {
      socket.close(PROTOCOL_CLOSE_CODE, "missing connection attachment");
      return;
    }

    if (frame.device_id !== attachment.deviceId) {
      socket.close(PROTOCOL_CLOSE_CODE, "device_id mismatch");
      return;
    }
    if (frame.sequence <= attachment.lastInboundSequence) {
      socket.close(PROTOCOL_CLOSE_CODE, "non-monotonic sequence");
      return;
    }
    if (attachment.recentMessageIds.includes(frame.message_id)) {
      socket.close(PROTOCOL_CLOSE_CODE, "duplicate message_id");
      return;
    }

    attachment.lastInboundSequence = frame.sequence;
    attachment.recentMessageIds.push(frame.message_id);
    if (attachment.recentMessageIds.length > MAX_RECENT_MESSAGE_IDS) {
      attachment.recentMessageIds.shift();
    }

    if (!attachment.helloReceived) {
      if (frame.message_type !== "agent.hello") {
        socket.close(PROTOCOL_CLOSE_CODE, "agent.hello required first");
        return;
      }
      const hello = frame.payload;
      if (
        hello.device_public_id !== attachment.deviceId ||
        hello.device_key_id !== attachment.deviceKeyId ||
        hello.connection_nonce !== attachment.connectionNonce
      ) {
        socket.close(PROTOCOL_CLOSE_CODE, "agent.hello identity mismatch");
        return;
      }
      const versions = hello.supported_protocol_versions as string[];
      if (!versions.includes(DEVICE_PROTOCOL_VERSION)) {
        socket.close(PROTOCOL_CLOSE_CODE, "unsupported protocol version");
        return;
      }

      attachment.helloReceived = true;
      attachment.capabilities = hello.capabilities as string[];
      this.send(socket, attachment, "agent.hello_ack", frame.message_id, {
        connection_id: attachment.connectionId,
        selected_protocol_version: DEVICE_PROTOCOL_VERSION,
        server_time: new Date().toISOString(),
        heartbeat_interval_seconds: HEARTBEAT_INTERVAL_SECONDS,
        limits: {
          max_frame_bytes: MAX_FRAME_BYTES,
          max_output_chunk_bytes: 64 * 1024,
          process_ring_buffer_bytes: 4 * 1024 * 1024,
          max_inline_result_bytes: 256 * 1024,
        },
        policy_revision: null,
      });
      socket.serializeAttachment(attachment);
      return;
    }

    switch (frame.message_type) {
      case "heartbeat":
        attachment.lastHeartbeatAt = new Date().toISOString();
        this.send(socket, attachment, "heartbeat_ack", frame.message_id, {
          server_time: new Date().toISOString(),
          last_received_sequence: frame.sequence,
        });
        break;
      case "capabilities.changed":
        attachment.capabilities = frame.payload.capabilities as string[];
        break;
      case "command.accepted":
      case "command.chunk":
      case "command.completed":
      case "command.failed":
      case "command.cancelled":
      case "approval.request": {
        const commandId = frame.payload.command_id as string;
        const storageKey = `command:${commandId}`;
        const previous =
          await this.state.storage.get<CorrelatedCommandState>(storageKey);
        const correlated: CorrelatedCommandState = {
          command_id: commandId,
          message_type:
            frame.message_type as CorrelatedCommandState["message_type"],
          message_id: frame.message_id,
          sequence: frame.sequence,
          received_at: new Date().toISOString(),
          ...(previous?.request ? { request: previous.request } : {}),
        };
        if (
          frame.message_type === "command.completed" ||
          frame.message_type === "command.failed" ||
          frame.message_type === "approval.request"
        ) {
          correlated.payload = frame.payload;
        }

        const governance = new GovernanceService(this.env.DB);
        try {
          if (frame.message_type === "command.accepted") {
            const acceptedAt = frame.payload.accepted_at;
            if (typeof acceptedAt === "string") {
              await governance.markAccepted(commandId, acceptedAt);
            }
          } else if (frame.message_type === "command.completed") {
            const completedAt = frame.payload.completed_at;
            if (typeof completedAt === "string") {
              await governance.markCompleted(commandId, completedAt);
            }
          } else if (frame.message_type === "command.cancelled") {
            const cancelledAt = frame.payload.cancelled_at;
            await governance.markCancelled(
              commandId,
              typeof cancelledAt === "string"
                ? cancelledAt
                : new Date().toISOString(),
            );
          } else if (frame.message_type === "command.failed") {
            const failedAt = frame.payload.failed_at;
            const remoteError = frame.payload.error;
            const code =
              remoteError &&
              typeof remoteError === "object" &&
              !Array.isArray(remoteError) &&
              typeof (remoteError as Record<string, unknown>).code === "string"
                ? ((remoteError as Record<string, unknown>).code as string)
                : "INTERNAL_ERROR";
            await governance.markFailed(
              commandId,
              code,
              typeof failedAt === "string"
                ? failedAt
                : new Date().toISOString(),
            );
          } else if (frame.message_type === "approval.request") {
            const requestContext = previous?.request;
            const approvalId = frame.payload.approval_id;
            const permission = frame.payload.permission;
            const risk = frame.payload.risk;
            const argumentDigest = frame.payload.argument_digest;
            const expiresAt = frame.payload.expires_at;
            if (
              !requestContext ||
              typeof approvalId !== "string" ||
              !isPermission(permission) ||
              !requestContext.requested_permissions.includes(permission) ||
              !isRisk(risk) ||
              typeof argumentDigest !== "string" ||
              typeof expiresAt !== "string"
            ) {
              throw new GovernanceError(
                "CONFLICT",
                "Agent approval request is missing bound command metadata",
              );
            }
            await governance.recordAgentApprovalRequest({
              approvalId,
              commandId,
              userId: requestContext.user_id,
              deviceId: attachment.deviceId,
              sessionId: requestContext.session_id,
              permission,
              risk,
              argumentDigest,
              expiresAt,
            });
          }
        } catch {
          socket.close(
            PROTOCOL_CLOSE_CODE,
            "governance validation failed for agent message",
          );
          return;
        }

        await this.state.storage.put(storageKey, correlated);
        break;
      }
      case "protocol.error":
        break;
      default:
        socket.close(PROTOCOL_CLOSE_CODE, "unsupported agent message");
        return;
    }

    socket.serializeAttachment(attachment);
  }
  webSocketClose(socket: WebSocket, code: number, reason: string): void {
    void socket;
    void code;
    void reason;
  }

  webSocketError(socket: WebSocket, error: unknown): void {
    void error;
    socket.close(1011, "realtime channel error");
  }

  private async dispatchCommand(request: Request): Promise<Response> {
    if (await this.state.storage.get<boolean>("revoked")) {
      return failure("DEVICE_REVOKED", "Device is revoked", 403);
    }

    const expectedDeviceId = request.headers.get("x-telechir-device-id");
    if (!expectedDeviceId) {
      return failure(
        "UNAUTHENTICATED",
        "Internal device identity missing",
        401,
      );
    }

    let command: InternalCommandRequest;
    try {
      const parsed = (await request.json()) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("command must be an object");
      }
      command = parsed as InternalCommandRequest;
    } catch {
      return failure(
        "INVALID_ARGUMENT",
        "Invalid internal command request",
        400,
      );
    }

    if (
      typeof command.command_id !== "string" ||
      command.command_id.length < 8 ||
      command.command_id.length > 160 ||
      !ACTIVE_DEVICE_OPERATIONS.has(command.operation) ||
      !command.arguments ||
      typeof command.arguments !== "object" ||
      Array.isArray(command.arguments) ||
      !Array.isArray(command.requested_permissions) ||
      !command.requested_permissions.every(isPermission) ||
      !isRisk(command.risk) ||
      typeof command.user_id !== "string" ||
      command.user_id.length < 3 ||
      command.user_id.length > 128 ||
      typeof command.session_id !== "string" ||
      command.session_id.length < 3 ||
      command.session_id.length > 128 ||
      typeof command.tool_name !== "string" ||
      command.tool_name.length < 1 ||
      command.tool_name.length > 128 ||
      typeof command.argument_digest !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(command.argument_digest) ||
      (command.approval_id !== null &&
        command.approval_id !== undefined &&
        (typeof command.approval_id !== "string" ||
          command.approval_id.length < 8 ||
          command.approval_id.length > 160))
    ) {
      return failure(
        "INVALID_ARGUMENT",
        "Internal command contract is invalid",
        400,
      );
    }

    const computedArgumentDigest = await commandArgumentDigest({
      operation: command.operation,
      arguments: command.arguments,
      requestedPermissions: command.requested_permissions,
    });
    if (computedArgumentDigest !== command.argument_digest) {
      return failure(
        "INVALID_ARGUMENT",
        "Command argument digest does not match the normalized payload",
        400,
      );
    }

    const sideEffect = SIDE_EFFECT_OPERATIONS.has(command.operation);
    if (
      (sideEffect &&
        (typeof command.idempotency_key !== "string" ||
          command.idempotency_key.length < 8 ||
          command.idempotency_key.length > 160)) ||
      (!sideEffect &&
        command.idempotency_key !== null &&
        command.idempotency_key !== undefined)
    ) {
      return failure(
        "INVALID_ARGUMENT",
        "Command idempotency contract is invalid",
        400,
      );
    }

    const deadline = Date.parse(command.deadline_at);
    const now = Date.now();
    if (
      !Number.isFinite(deadline) ||
      deadline <= now ||
      deadline > now + MAX_COMMAND_DEADLINE_MS
    ) {
      return failure("INVALID_ARGUMENT", "Command deadline is invalid", 400);
    }

    const sockets = this.state
      .getWebSockets("active")
      .filter((socket) => socket.readyState === WebSocket.OPEN);
    const active = sockets.find((socket) => {
      const attachment =
        socket.deserializeAttachment() as ConnectionAttachment | null;
      return (
        attachment?.helloReceived === true &&
        attachment.deviceId === expectedDeviceId
      );
    });
    if (!active) {
      return failure("DEVICE_OFFLINE", "Device is offline", 409);
    }

    const attachment =
      active.deserializeAttachment() as ConnectionAttachment | null;
    if (!attachment || attachment.deviceId !== expectedDeviceId) {
      return failure("DEVICE_OFFLINE", "Device is offline", 409);
    }
    if (!attachment.capabilities.includes(command.operation)) {
      return failure(
        "UNSUPPORTED_CAPABILITY",
        "Device does not advertise the requested capability",
        409,
      );
    }

    const existing = await this.state.storage.get(
      `command:${command.command_id}`,
    );
    if (existing) {
      return failure("CONFLICT", "Command identifier already exists", 409);
    }
    const correlated = await this.state.storage.list({
      prefix: "command:",
      limit: MAX_CORRELATED_COMMANDS + 1,
    });
    if (correlated.size >= MAX_CORRELATED_COMMANDS) {
      return failure("RATE_LIMITED", "Too many correlated commands", 429);
    }

    const payload: Record<string, unknown> = {
      command_id: command.command_id,
      idempotency_key: command.idempotency_key,
      operation: command.operation,
      arguments: command.arguments,
      requested_permissions: command.requested_permissions,
      risk: command.risk,
      workspace_id: null,
      approval_id: command.approval_id ?? null,
    };

    let outbound: PreparedOutboundFrame;
    try {
      outbound = this.prepareOutboundFrame(
        attachment,
        "command.request",
        null,
        payload,
        command.deadline_at,
        command.session_id,
      );
    } catch {
      return failure(
        "INVALID_ARGUMENT",
        "Command request exceeds the realtime frame limit",
        413,
      );
    }

    // Persist correlation before releasing a side effect to the device. If
    // Durable Object storage fails, no command frame has been sent.
    await this.state.storage.put<CorrelatedCommandState>(
      `command:${command.command_id}`,
      {
        command_id: command.command_id,
        message_type: "command.request",
        message_id: outbound.messageId,
        sequence: outbound.sequence,
        received_at: new Date().toISOString(),
        request: command,
      },
    );
    attachment.nextOutboundSequence += 1;
    active.serializeAttachment(attachment);
    active.send(outbound.encoded);

    return success({
      command_id: command.command_id,
      state: "dispatched",
    });
  }

  private async decideApproval(
    request: Request,
    approvalId: string,
  ): Promise<Response> {
    const expectedDeviceId = request.headers.get("x-telechir-device-id");
    if (!expectedDeviceId) {
      return failure(
        "UNAUTHENTICATED",
        "Internal device identity missing",
        401,
      );
    }

    let body: {
      user_id?: unknown;
      session_id?: unknown;
      decision?: unknown;
      scope?: unknown;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return failure("INVALID_ARGUMENT", "Invalid approval decision", 400);
    }

    if (
      typeof body.user_id !== "string" ||
      typeof body.session_id !== "string" ||
      (body.decision !== "APPROVE" && body.decision !== "DENY") ||
      (body.scope !== "once" && body.scope !== "session")
    ) {
      return failure("INVALID_ARGUMENT", "Invalid approval decision", 400);
    }

    const governance = new GovernanceService(this.env.DB);
    const existing = await governance.approval(approvalId);
    if (
      !existing ||
      existing.device_id !== expectedDeviceId ||
      existing.user_id !== body.user_id ||
      existing.session_id !== body.session_id
    ) {
      return failure("NOT_FOUND", "Approval not found", 404);
    }

    const commandState = existing.command_id
      ? await this.state.storage.get<CorrelatedCommandState>(
          `command:${existing.command_id}`,
        )
      : undefined;

    // Agent-issued approvals require the original bounded command context.
    if (commandState?.request) {
      const original = commandState.request;
      if (
        original.user_id !== existing.user_id ||
        original.session_id !== existing.session_id ||
        original.argument_digest !== existing.argument_digest ||
        original.command_id !== existing.command_id
      ) {
        return failure(
          "CONFLICT",
          "Approval does not match the correlated command",
          409,
        );
      }
    }

    const sockets = this.state
      .getWebSockets("active")
      .filter((socket) => socket.readyState === WebSocket.OPEN);
    const active = sockets.find((socket) => {
      const attachment =
        socket.deserializeAttachment() as ConnectionAttachment | null;
      return (
        attachment?.helloReceived === true &&
        attachment.deviceId === expectedDeviceId
      );
    });

    // A remote-policy-only approval does not need a live device. The next
    // tool attempt will consume it before any local dispatch.
    if (commandState?.request && !active) {
      return failure("DEVICE_OFFLINE", "Device is offline", 409);
    }

    let decided;
    try {
      decided = await governance.decideApproval({
        approvalId,
        userId: body.user_id,
        deviceId: expectedDeviceId,
        sessionId: body.session_id,
        decision: body.decision,
        scope: body.scope,
      });
    } catch (error) {
      if (error instanceof GovernanceError) {
        return failure(error.code, error.message, 409);
      }
      return failure("INTERNAL_ERROR", "Approval decision failed", 500);
    }

    if (!commandState?.request) {
      if (body.decision === "APPROVE" && existing.command_id) {
        await governance.markApprovalGrantedForRetry(existing.command_id);
      } else if (body.decision === "DENY" && existing.command_id) {
        await governance.markFailed(
          existing.command_id,
          "POLICY_DENIED",
          decided.decided_at ?? new Date().toISOString(),
        );
      }
      return success({
        approval_id: approvalId,
        decision: decided.decision,
        state:
          body.decision === "APPROVE"
            ? "remote_policy_retry_required"
            : "denied",
      });
    }

    const attachment =
      active!.deserializeAttachment() as ConnectionAttachment | null;
    if (!attachment || attachment.deviceId !== expectedDeviceId) {
      return failure("DEVICE_OFFLINE", "Device is offline", 409);
    }

    if (body.decision === "APPROVE") {
      try {
        await governance.consumeApproval(approvalId);
      } catch (error) {
        if (error instanceof GovernanceError) {
          return failure(error.code, error.message, 409);
        }
        return failure("INTERNAL_ERROR", "Approval consumption failed", 500);
      }
    }

    this.send(
      active!,
      attachment,
      "approval.decision",
      commandState.message_id,
      {
        approval_id: approvalId,
        decision: body.decision,
        decided_at: decided.decided_at,
        scope: body.scope,
      },
      null,
      decided.session_id,
    );

    if (body.decision === "DENY") {
      await governance.markFailed(
        commandState.command_id,
        "POLICY_DENIED",
        decided.decided_at ?? new Date().toISOString(),
      );
      await this.state.storage.put<CorrelatedCommandState>(
        `command:${commandState.command_id}`,
        {
          ...commandState,
          message_type: "command.failed",
          received_at: new Date().toISOString(),
          payload: {
            command_id: commandState.command_id,
            failed_at: decided.decided_at ?? new Date().toISOString(),
            error: {
              code: "POLICY_DENIED",
              message: "Approval was denied",
              retryable: false,
              retry_after_ms: null,
              details: null,
            },
          },
        },
      );
      active!.serializeAttachment(attachment);
      return success({
        approval_id: approvalId,
        decision: body.decision,
        state: "denied",
      });
    }

    const now = Date.now();
    const expiry = Date.parse(decided.expires_at);
    if (!Number.isFinite(expiry) || expiry <= now) {
      return failure("CONFLICT", "Approval expired before dispatch", 409);
    }

    const approvedCommand: InternalCommandRequest = {
      ...commandState.request,
      approval_id: approvalId,
      deadline_at: new Date(
        Math.min(expiry, now + MAX_COMMAND_DEADLINE_MS),
      ).toISOString(),
    };
    const payload: Record<string, unknown> = {
      command_id: approvedCommand.command_id,
      idempotency_key: approvedCommand.idempotency_key,
      operation: approvedCommand.operation,
      arguments: approvedCommand.arguments,
      requested_permissions: approvedCommand.requested_permissions,
      risk: approvedCommand.risk,
      workspace_id: null,
      approval_id: approvalId,
    };

    const outbound = this.prepareOutboundFrame(
      attachment,
      "command.request",
      null,
      payload,
      approvedCommand.deadline_at,
      approvedCommand.session_id,
    );

    // Approval consumption already happened above. Persist the redispatch
    // correlation before releasing the approved side effect to the device.
    await this.state.storage.put<CorrelatedCommandState>(
      `command:${approvedCommand.command_id}`,
      {
        command_id: approvedCommand.command_id,
        message_type: "command.request",
        message_id: outbound.messageId,
        sequence: outbound.sequence,
        received_at: new Date().toISOString(),
        request: approvedCommand,
      },
    );
    attachment.nextOutboundSequence += 1;
    active!.serializeAttachment(attachment);
    active!.send(outbound.encoded);
    return success({
      approval_id: approvalId,
      decision: body.decision,
      state: "redispatched",
      command_id: approvedCommand.command_id,
    });
  }

  private async acceptConnection(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return failure("INVALID_ARGUMENT", "WebSocket upgrade required", 426);
    }
    if (await this.state.storage.get<boolean>("revoked")) {
      return failure("DEVICE_REVOKED", "Device is revoked", 403);
    }

    let deviceId: string;
    let deviceKeyId: string;
    let connectionNonce: string;
    let credentialJti: string;
    let credentialExpiresAt: string;
    try {
      deviceId = requiredHeader(request, "x-telechir-device-id");
      deviceKeyId = requiredHeader(request, "x-telechir-device-key-id");
      connectionNonce = requiredHeader(request, "x-telechir-connection-nonce");
      credentialJti = requiredHeader(request, "x-telechir-credential-jti");
      credentialExpiresAt = requiredHeader(
        request,
        "x-telechir-credential-expires-at",
      );
    } catch {
      return failure("UNAUTHENTICATED", "Internal identity missing", 401);
    }

    const now = Date.now();
    const expiresAt = Date.parse(credentialExpiresAt);
    if (!Number.isFinite(expiresAt) || now >= expiresAt) {
      return failure("UNAUTHENTICATED", "Credential expired", 401);
    }

    const used =
      (await this.state.storage.get<Record<string, number>>(
        "used_credentials",
      )) ?? {};
    for (const [jti, expiry] of Object.entries(used)) {
      if (expiry <= now) {
        delete used[jti];
      }
    }
    if (used[credentialJti] !== undefined) {
      return failure("CONFLICT", "Credential replay detected", 409);
    }
    if (Object.keys(used).length >= MAX_RECENT_CREDENTIALS) {
      return failure(
        "RATE_LIMITED",
        "Too many recent connection credentials",
        429,
      );
    }
    used[credentialJti] = expiresAt;
    await this.state.storage.put("used_credentials", used);

    for (const existing of this.state.getWebSockets("active")) {
      if (existing.readyState === WebSocket.OPEN) {
        existing.close(REPLACED_CLOSE_CODE, "connection replaced");
      }
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const attachment: ConnectionAttachment = {
      deviceId,
      deviceKeyId,
      credentialJti,
      connectionNonce,
      connectionId: `conn_${crypto.randomUUID()}`,
      helloReceived: false,
      lastInboundSequence: -1,
      nextOutboundSequence: 0,
      recentMessageIds: [],
      lastHeartbeatAt: null,
      capabilities: [],
    };
    server.serializeAttachment(attachment);
    this.state.acceptWebSocket(server, ["active"]);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private prepareOutboundFrame(
    attachment: ConnectionAttachment,
    messageType: string,
    correlationId: string | null,
    payload: Record<string, unknown>,
    deadlineAt: string | null = null,
    sessionId: string | null = null,
  ): PreparedOutboundFrame {
    const sequence = attachment.nextOutboundSequence;
    const envelope = serverEnvelope({
      messageType,
      deviceId: attachment.deviceId,
      connectionId: attachment.connectionId,
      sequence,
      correlationId,
      sessionId,
      deadlineAt,
      payload,
    });
    const encoded = JSON.stringify(envelope);
    if (new TextEncoder().encode(encoded).byteLength > MAX_FRAME_BYTES) {
      throw new Error("outbound protocol frame exceeds configured limit");
    }
    return {
      encoded,
      messageId: envelope.message_id,
      sequence,
    };
  }

  private send(
    socket: WebSocket,
    attachment: ConnectionAttachment,
    messageType: string,
    correlationId: string | null,
    payload: Record<string, unknown>,
    deadlineAt: string | null = null,
    sessionId: string | null = null,
  ): string {
    const outbound = this.prepareOutboundFrame(
      attachment,
      messageType,
      correlationId,
      payload,
      deadlineAt,
      sessionId,
    );
    attachment.nextOutboundSequence += 1;
    socket.send(outbound.encoded);
    return outbound.messageId;
  }
}
