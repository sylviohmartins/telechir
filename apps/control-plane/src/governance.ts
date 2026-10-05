import { AuditService } from "./audit";
import {
  commandArgumentDigest,
  sha256Base64Url,
  strongestRestriction,
  type PermissionDomain,
  type PolicyRestrictionRow,
  type RiskLevel,
} from "./policy";

const APPROVAL_TTL_MS = 60_000;

export interface CallerContext {
  clientId?: string;
  expiresAt?: number;
}

export interface GovernedCommandInput {
  commandId: string;
  userId: string;
  caller?: CallerContext;
  deviceId: string;
  toolName: string;
  operation: string;
  arguments: Record<string, unknown>;
  requestedPermissions: readonly PermissionDomain[];
  risk: RiskLevel;
  idempotencyKey: string | null;
}

export interface GovernedCommand {
  commandId: string;
  sessionId: string;
  argumentDigest: string;
  approvalId: string | null;
  policyRevision: string | null;
}

export interface ApprovalRow {
  id: string;
  user_id: string;
  device_id: string;
  session_id: string;
  command_id: string | null;
  permission: string;
  risk: RiskLevel;
  scope: "once" | "session";
  argument_digest: string;
  decision: "APPROVE" | "DENY" | null;
  requested_at: string;
  decided_at: string | null;
  expires_at: string;
  consumed_at: string | null;
}

interface CommandContextRow {
  user_id: string;
  device_id: string;
  session_id: string;
  risk: string;
  argument_digest: string;
}

export class GovernanceError extends Error {
  constructor(
    public readonly code:
      | "POLICY_DENIED"
      | "APPROVAL_REQUIRED"
      | "CONFLICT"
      | "NOT_FOUND"
      | "INTERNAL_ERROR",
    message: string,
    public readonly approvalId: string | null = null,
  ) {
    super(message);
    this.name = "GovernanceError";
  }
}

export class GovernanceService {
  private readonly audit: AuditService;

  constructor(private readonly db: D1Database) {
    this.audit = new AuditService(db);
  }

  async prepareCommand(input: GovernedCommandInput): Promise<GovernedCommand> {
    const now = new Date();
    const nowIso = now.toISOString();
    const sessionId = await this.ensureSession(
      input.userId,
      input.caller,
      nowIso,
    );
    const argumentDigest = await commandArgumentDigest({
      operation: input.operation,
      arguments: input.arguments,
      requestedPermissions: input.requestedPermissions,
    });
    const idempotencyHash = input.idempotencyKey
      ? await sha256Base64Url(input.idempotencyKey)
      : null;

    await this.db
      .prepare(
        `INSERT INTO commands (
           id, device_id, session_id, tool_name, operation,
           idempotency_key_hash, argument_digest, risk, state, requested_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'REQUESTED', ?)`,
      )
      .bind(
        input.commandId,
        input.deviceId,
        sessionId,
        input.toolName,
        input.operation,
        idempotencyHash,
        argumentDigest,
        input.risk,
        nowIso,
      )
      .run();

    const restrictions = await this.restrictionsFor(
      input.userId,
      input.deviceId,
      sessionId,
      input.requestedPermissions,
      nowIso,
    );
    const strongest = strongestRestriction(restrictions);
    const policyRevision =
      restrictions.length === 0
        ? null
        : [...new Set(restrictions.map((row) => row.revision))]
            .sort()
            .join(",");

    if (strongest?.effect === "DENY") {
      await this.failCommand(input.commandId, "POLICY_DENIED", {
        eventType: "POLICY_DENIED",
        decision: "DENY",
        metadata: {
          permission: strongest.permission,
          policy_revision: policyRevision,
          restriction_id: strongest.id,
        },
      });
      throw new GovernanceError(
        "POLICY_DENIED",
        "Remote policy restriction denied this operation",
      );
    }

    let remoteApprovalId: string | null = null;
    if (strongest?.effect === "ASK") {
      remoteApprovalId = await this.findApprovedRemoteGrant({
        userId: input.userId,
        deviceId: input.deviceId,
        sessionId,
        permission: strongest.permission,
        risk: input.risk,
        argumentDigest,
        nowIso,
      });
      if (!remoteApprovalId) {
        remoteApprovalId = await this.ensurePendingRemoteApproval({
          commandId: input.commandId,
          userId: input.userId,
          deviceId: input.deviceId,
          sessionId,
          permission: strongest.permission,
          risk: input.risk,
          argumentDigest,
          now,
        });
        await this.db
          .prepare(
            "UPDATE commands SET state = 'WAITING_APPROVAL' WHERE id = ?",
          )
          .bind(input.commandId)
          .run();
        await this.audit.append({
          userId: input.userId,
          deviceId: input.deviceId,
          sessionId,
          commandId: input.commandId,
          eventType: "APPROVAL_REQUESTED",
          decision: "ASK",
          risk: input.risk,
          targetDigest: argumentDigest,
          metadata: {
            approval_id: remoteApprovalId,
            permission: strongest.permission,
            policy_revision: policyRevision,
            source: "remote_policy",
          },
        });
        throw new GovernanceError(
          "APPROVAL_REQUIRED",
          "Remote policy requires an approval before dispatch",
          remoteApprovalId,
        );
      }
    }

    await this.audit.append({
      userId: input.userId,
      deviceId: input.deviceId,
      sessionId,
      commandId: input.commandId,
      eventType: "COMMAND_AUTHORIZED",
      decision: "ALLOW",
      risk: input.risk,
      targetDigest: argumentDigest,
      metadata: {
        remote_approval_id: remoteApprovalId,
        policy_revision: policyRevision,
        tool_name: input.toolName,
        operation: input.operation,
      },
    });

    return {
      commandId: input.commandId,
      sessionId,
      argumentDigest,
      // Remote approvals only remove cloud-side restrictions. They are never
      // forwarded as local authority to the agent.
      approvalId: null,
      policyRevision,
    };
  }

  async recordAgentApprovalRequest(input: {
    approvalId: string;
    commandId: string;
    userId: string;
    deviceId: string;
    sessionId: string;
    permission: string;
    risk: RiskLevel;
    argumentDigest: string;
    expiresAt: string;
  }): Promise<void> {
    const command = await this.commandContext(input.commandId);
    if (
      !command ||
      command.user_id !== input.userId ||
      command.device_id !== input.deviceId ||
      command.session_id !== input.sessionId ||
      command.argument_digest !== input.argumentDigest
    ) {
      throw new GovernanceError(
        "CONFLICT",
        "Agent approval request does not match the correlated command",
      );
    }

    const nowIso = new Date().toISOString();
    if (
      !Number.isFinite(Date.parse(input.expiresAt)) ||
      input.expiresAt <= nowIso
    ) {
      throw new GovernanceError(
        "CONFLICT",
        "Agent approval request has an invalid expiry",
      );
    }

    await this.db
      .prepare(
        `INSERT OR IGNORE INTO approvals (
           id, user_id, device_id, session_id, command_id,
           permission, risk, scope, argument_digest, decision,
           requested_at, decided_at, expires_at, consumed_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, 'once', ?, NULL, ?, NULL, ?, NULL)`,
      )
      .bind(
        input.approvalId,
        input.userId,
        input.deviceId,
        input.sessionId,
        input.commandId,
        input.permission,
        input.risk,
        input.argumentDigest,
        nowIso,
        input.expiresAt,
      )
      .run();

    const persisted = await this.approval(input.approvalId);
    if (
      !persisted ||
      persisted.user_id !== input.userId ||
      persisted.device_id !== input.deviceId ||
      persisted.session_id !== input.sessionId ||
      persisted.command_id !== input.commandId ||
      persisted.permission !== input.permission ||
      persisted.risk !== input.risk ||
      persisted.argument_digest !== input.argumentDigest ||
      persisted.expires_at !== input.expiresAt ||
      persisted.decision !== null ||
      persisted.consumed_at !== null
    ) {
      throw new GovernanceError(
        "CONFLICT",
        "Approval identifier is already bound to different authority metadata",
      );
    }

    await this.db
      .prepare("UPDATE commands SET state = 'WAITING_APPROVAL' WHERE id = ?")
      .bind(input.commandId)
      .run();

    await this.audit.append({
      userId: input.userId,
      deviceId: input.deviceId,
      sessionId: input.sessionId,
      commandId: input.commandId,
      eventType: "APPROVAL_REQUESTED",
      decision: "ASK",
      risk: input.risk,
      targetDigest: input.argumentDigest,
      metadata: {
        approval_id: input.approvalId,
        permission: input.permission,
        source: "local_agent",
      },
    });
  }

  async decideApproval(input: {
    approvalId: string;
    userId: string;
    deviceId: string;
    sessionId: string;
    decision: "APPROVE" | "DENY";
    scope: "once" | "session";
    decidedAt?: string;
  }): Promise<ApprovalRow> {
    const decidedAt = input.decidedAt ?? new Date().toISOString();
    const result = await this.db
      .prepare(
        `UPDATE approvals
         SET decision = ?, scope = ?, decided_at = ?
         WHERE id = ?
           AND user_id = ?
           AND device_id = ?
           AND session_id = ?
           AND decision IS NULL
           AND consumed_at IS NULL
           AND expires_at > ?`,
      )
      .bind(
        input.decision,
        input.scope,
        decidedAt,
        input.approvalId,
        input.userId,
        input.deviceId,
        input.sessionId,
        decidedAt,
      )
      .run();

    if (Number(result.meta?.changes ?? 0) !== 1) {
      throw new GovernanceError(
        "CONFLICT",
        "Approval is missing, expired, already decided, or already consumed",
      );
    }

    const approval = await this.approval(input.approvalId);
    if (!approval) {
      throw new GovernanceError(
        "INTERNAL_ERROR",
        "Approval disappeared after decision",
      );
    }

    await this.audit.append({
      userId: approval.user_id,
      deviceId: approval.device_id,
      sessionId: approval.session_id,
      commandId: approval.command_id,
      eventType:
        input.decision === "APPROVE" ? "APPROVAL_APPROVED" : "APPROVAL_DENIED",
      decision: input.decision === "APPROVE" ? "ALLOW" : "DENY",
      risk: approval.risk,
      targetDigest: approval.argument_digest,
      metadata: {
        approval_id: approval.id,
        permission: approval.permission,
        scope: input.scope,
      },
    });

    return approval;
  }

  async consumeApproval(
    approvalId: string,
    nowIso = new Date().toISOString(),
  ): Promise<void> {
    const approval = await this.approval(approvalId);
    if (!approval || approval.decision !== "APPROVE") {
      throw new GovernanceError("CONFLICT", "Approval is not approved");
    }
    if (approval.expires_at <= nowIso) {
      throw new GovernanceError("CONFLICT", "Approval has expired");
    }
    if (approval.scope === "session") {
      return;
    }

    const result = await this.db
      .prepare(
        `UPDATE approvals
         SET consumed_at = ?
         WHERE id = ?
           AND decision = 'APPROVE'
           AND scope = 'once'
           AND consumed_at IS NULL
           AND expires_at > ?`,
      )
      .bind(nowIso, approvalId, nowIso)
      .run();
    if (Number(result.meta?.changes ?? 0) !== 1) {
      throw new GovernanceError(
        "CONFLICT",
        "One-time approval was already consumed or expired",
      );
    }

    await this.audit.append({
      userId: approval.user_id,
      deviceId: approval.device_id,
      sessionId: approval.session_id,
      commandId: approval.command_id,
      eventType: "APPROVAL_CONSUMED",
      decision: "ALLOW",
      risk: approval.risk,
      targetDigest: approval.argument_digest,
      metadata: {
        approval_id: approval.id,
        permission: approval.permission,
        scope: approval.scope,
      },
    });
  }

  async markAccepted(commandId: string, acceptedAt: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE commands
         SET state = 'ACCEPTED', accepted_at = COALESCE(accepted_at, ?)
         WHERE id = ?`,
      )
      .bind(acceptedAt, commandId)
      .run();
    await this.auditCommand(commandId, {
      eventType: "COMMAND_ACCEPTED",
      decision: "ALLOW",
    });
  }

  async markCompleted(commandId: string, completedAt: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE commands
         SET state = 'COMPLETED', completed_at = ?, error_code = NULL
         WHERE id = ?`,
      )
      .bind(completedAt, commandId)
      .run();
    await this.auditCommand(commandId, {
      eventType: "COMMAND_COMPLETED",
      decision: "ALLOW",
    });
  }

  async markCancelled(commandId: string, completedAt: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE commands
         SET state = 'CANCELLED', completed_at = ?, error_code = NULL
         WHERE id = ?`,
      )
      .bind(completedAt, commandId)
      .run();
    await this.auditCommand(commandId, {
      eventType: "COMMAND_CANCELLED",
      decision: "ALLOW",
    });
  }

  async markApprovalGrantedForRetry(commandId: string): Promise<void> {
    await this.db
      .prepare(
        "UPDATE commands SET state = 'APPROVED_RETRY_REQUIRED' WHERE id = ?",
      )
      .bind(commandId)
      .run();
    await this.auditCommand(commandId, {
      eventType: "APPROVAL_GRANTED_RETRY_REQUIRED",
      decision: "ALLOW",
    });
  }

  async markFailed(
    commandId: string,
    errorCode: string,
    completedAt: string,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE commands
         SET state = 'FAILED', completed_at = ?, error_code = ?
         WHERE id = ?`,
      )
      .bind(completedAt, errorCode.slice(0, 80), commandId)
      .run();
    await this.auditCommand(commandId, {
      eventType: "COMMAND_FAILED",
      decision: errorCode === "POLICY_DENIED" ? "DENY" : null,
      metadata: { error_code: errorCode.slice(0, 80) },
    });
  }

  async failCommand(
    commandId: string,
    errorCode: string,
    audit: {
      eventType?: string;
      decision?: string | null;
      metadata?: Record<string, unknown>;
    } = {},
  ): Promise<void> {
    await this.markFailed(commandId, errorCode, new Date().toISOString());
    if (audit.eventType && audit.eventType !== "COMMAND_FAILED") {
      await this.auditCommand(commandId, {
        eventType: audit.eventType,
        decision: audit.decision ?? null,
        ...(audit.metadata ? { metadata: audit.metadata } : {}),
      });
    }
  }

  async approval(approvalId: string): Promise<ApprovalRow | null> {
    return this.db
      .prepare(
        `SELECT id, user_id, device_id, session_id, command_id,
                permission, risk, scope, argument_digest, decision,
                requested_at, decided_at, expires_at, consumed_at
         FROM approvals
         WHERE id = ?`,
      )
      .bind(approvalId)
      .first<ApprovalRow>();
  }

  private async findApprovedRemoteGrant(input: {
    userId: string;
    deviceId: string;
    sessionId: string;
    permission: string;
    risk: RiskLevel;
    argumentDigest: string;
    nowIso: string;
  }): Promise<string | null> {
    const approval = await this.db
      .prepare(
        `SELECT id, user_id, device_id, session_id, command_id,
                permission, risk, scope, argument_digest, decision,
                requested_at, decided_at, expires_at, consumed_at
         FROM approvals
         WHERE user_id = ?
           AND device_id = ?
           AND session_id = ?
           AND permission = ?
           AND risk = ?
           AND argument_digest = ?
           AND decision = 'APPROVE'
           AND expires_at > ?
           AND (scope = 'session' OR consumed_at IS NULL)
         ORDER BY decided_at DESC
         LIMIT 1`,
      )
      .bind(
        input.userId,
        input.deviceId,
        input.sessionId,
        input.permission,
        input.risk,
        input.argumentDigest,
        input.nowIso,
      )
      .first<ApprovalRow>();

    if (!approval) {
      return null;
    }
    if (approval.scope === "once") {
      await this.consumeApproval(approval.id, input.nowIso);
    }
    return approval.id;
  }

  private async ensurePendingRemoteApproval(input: {
    commandId: string;
    userId: string;
    deviceId: string;
    sessionId: string;
    permission: string;
    risk: RiskLevel;
    argumentDigest: string;
    now: Date;
  }): Promise<string> {
    const nowIso = input.now.toISOString();
    const existing = await this.db
      .prepare(
        `SELECT id
         FROM approvals
         WHERE user_id = ?
           AND device_id = ?
           AND session_id = ?
           AND permission = ?
           AND risk = ?
           AND argument_digest = ?
           AND decision IS NULL
           AND consumed_at IS NULL
           AND expires_at > ?
         ORDER BY requested_at DESC
         LIMIT 1`,
      )
      .bind(
        input.userId,
        input.deviceId,
        input.sessionId,
        input.permission,
        input.risk,
        input.argumentDigest,
        nowIso,
      )
      .first<{ id: string }>();
    if (existing) {
      return existing.id;
    }

    const approvalId = `approval_${crypto.randomUUID()}`;
    const expiresAt = new Date(
      input.now.getTime() + APPROVAL_TTL_MS,
    ).toISOString();
    await this.db
      .prepare(
        `INSERT INTO approvals (
           id, user_id, device_id, session_id, command_id,
           permission, risk, scope, argument_digest, decision,
           requested_at, decided_at, expires_at, consumed_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, 'once', ?, NULL, ?, NULL, ?, NULL)`,
      )
      .bind(
        approvalId,
        input.userId,
        input.deviceId,
        input.sessionId,
        input.commandId,
        input.permission,
        input.risk,
        input.argumentDigest,
        nowIso,
        expiresAt,
      )
      .run();
    return approvalId;
  }

  private async restrictionsFor(
    userId: string,
    deviceId: string,
    sessionId: string,
    permissions: readonly PermissionDomain[],
    nowIso: string,
  ): Promise<PolicyRestrictionRow[]> {
    if (permissions.length === 0) {
      return [];
    }
    const placeholders = permissions.map(() => "?").join(", ");
    const result = await this.db
      .prepare(
        `SELECT id, permission, effect, revision, scope_type, scope_id
         FROM policy_restrictions
         WHERE permission IN (${placeholders})
           AND (expires_at IS NULL OR expires_at > ?)
           AND (
             (scope_type = 'account' AND scope_id = ?)
             OR (scope_type = 'device' AND scope_id = ?)
             OR (scope_type = 'session' AND scope_id = ?)
           )`,
      )
      .bind(...permissions, nowIso, userId, deviceId, sessionId)
      .all<PolicyRestrictionRow>();
    return result.results;
  }

  private async ensureSession(
    userId: string,
    caller: CallerContext | undefined,
    nowIso: string,
  ): Promise<string> {
    const clientId = caller?.clientId?.trim().slice(0, 128) || "mcp-client";
    const expiresAt =
      typeof caller?.expiresAt === "number" && Number.isFinite(caller.expiresAt)
        ? Math.floor(caller.expiresAt)
        : 0;
    const digest = await sha256Base64Url(
      `${userId}\u0000${clientId}\u0000${expiresAt}`,
    );
    const sessionId = `session_${digest.slice(0, 40)}`;
    const clientHash = await sha256Base64Url(clientId);

    await this.db
      .prepare(
        `INSERT INTO sessions (
           id, user_id, ai_client_type, client_instance_hash,
           started_at, ended_at, last_seen_at
         )
         VALUES (?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      )
      .bind(sessionId, userId, clientId, clientHash, nowIso, nowIso)
      .run();

    return sessionId;
  }

  private async commandContext(
    commandId: string,
  ): Promise<CommandContextRow | null> {
    return this.db
      .prepare(
        `SELECT s.user_id, c.device_id, c.session_id, c.risk, c.argument_digest
         FROM commands c
         JOIN sessions s ON s.id = c.session_id
         WHERE c.id = ?`,
      )
      .bind(commandId)
      .first<CommandContextRow>();
  }

  private async auditCommand(
    commandId: string,
    input: {
      eventType: string;
      decision?: string | null;
      metadata?: Record<string, unknown>;
    },
  ): Promise<void> {
    const context = await this.commandContext(commandId);
    if (!context) {
      return;
    }
    await this.audit.append({
      userId: context.user_id,
      deviceId: context.device_id,
      sessionId: context.session_id,
      commandId,
      eventType: input.eventType,
      decision: input.decision ?? null,
      risk: context.risk,
      targetDigest: context.argument_digest,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    });
  }
}
