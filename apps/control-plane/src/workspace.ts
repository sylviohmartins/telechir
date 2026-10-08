const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9_-]{3,160}$/u;

export interface WorkspaceRow {
  id: string;
  user_id: string;
  device_id: string;
  display_name: string;
  is_default: number;
}

export class WorkspaceError extends Error {
  constructor(
    public readonly code: "INVALID_ARGUMENT" | "NOT_FOUND" | "INTERNAL_ERROR",
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}

export function defaultWorkspaceId(deviceId: string): string {
  if (
    !/^[A-Za-z0-9_-]+$/u.test(deviceId) ||
    deviceId.length < 3 ||
    deviceId.length > 150
  ) {
    throw new WorkspaceError(
      "INVALID_ARGUMENT",
      "Device identifier cannot derive a default workspace",
    );
  }
  return `workspace_${deviceId}`;
}

export async function resolveWorkspace(
  db: D1Database,
  userId: string,
  deviceId: string,
  requestedWorkspaceId: unknown,
): Promise<WorkspaceRow> {
  if (
    requestedWorkspaceId !== undefined &&
    requestedWorkspaceId !== null &&
    (typeof requestedWorkspaceId !== "string" ||
      !WORKSPACE_ID_PATTERN.test(requestedWorkspaceId))
  ) {
    throw new WorkspaceError(
      "INVALID_ARGUMENT",
      "workspace_id is not a valid bounded workspace identifier",
    );
  }

  if (typeof requestedWorkspaceId === "string") {
    const explicit = await db
      .prepare(
        `SELECT w.id, w.user_id, w.device_id, w.display_name, w.is_default
         FROM workspaces w
         JOIN devices d ON d.id = w.device_id
         WHERE w.id = ?
           AND w.user_id = ?
           AND w.device_id = ?
           AND w.archived_at IS NULL
           AND d.revoked_at IS NULL`,
      )
      .bind(requestedWorkspaceId, userId, deviceId)
      .first<WorkspaceRow>();
    if (!explicit) {
      throw new WorkspaceError("NOT_FOUND", "Workspace not found");
    }
    return explicit;
  }

  const fallback = await db
    .prepare(
      `SELECT w.id, w.user_id, w.device_id, w.display_name, w.is_default
       FROM workspaces w
       JOIN devices d ON d.id = w.device_id
       WHERE w.user_id = ?
         AND w.device_id = ?
         AND w.is_default = 1
         AND w.archived_at IS NULL
         AND d.revoked_at IS NULL
       LIMIT 1`,
    )
    .bind(userId, deviceId)
    .first<WorkspaceRow>();

  if (!fallback) {
    throw new WorkspaceError(
      "INTERNAL_ERROR",
      "Active device has no default workspace",
    );
  }
  return fallback;
}
