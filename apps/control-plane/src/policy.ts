export type PermissionDomain =
  | "FS_READ"
  | "FS_WRITE"
  | "FS_DELETE"
  | "SHELL_SAFE"
  | "SHELL_FULL"
  | "PROCESS_CONTROL"
  | "NETWORK"
  | "GIT_WRITE"
  | "GIT_REMOTE_WRITE"
  | "SCREEN_READ"
  | "INPUT_CONTROL"
  | "BROWSER"
  | "SECRET_USE"
  | "ELEVATION"
  | "ADMIN";

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type PolicyEffect = "ALLOW" | "ASK" | "DENY";

export interface PolicyRestrictionRow {
  id: string;
  permission: string;
  effect: PolicyEffect;
  revision: string;
  scope_type: "account" | "workspace" | "device" | "session";
  scope_id: string;
}

function normalizedJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizedJson);
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, normalizedJson(child)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}

function base64Url(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (const value of view) {
    binary += String.fromCharCode(value);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export async function sha256Base64Url(value: string): Promise<string> {
  return base64Url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

export async function commandArgumentDigest(input: {
  operation: string;
  arguments: Record<string, unknown>;
  requestedPermissions: readonly string[];
}): Promise<string> {
  const encoded = JSON.stringify({
    operation: input.operation,
    arguments: normalizedJson(input.arguments),
    requested_permissions: [...input.requestedPermissions].sort(),
  });
  return sha256Base64Url(encoded);
}

export function strongestRestriction(
  rows: readonly PolicyRestrictionRow[],
): PolicyRestrictionRow | null {
  const rank: Record<PolicyEffect, number> = {
    ALLOW: 0,
    ASK: 1,
    DENY: 2,
  };
  return (
    [...rows].sort((left, right) => {
      const byEffect = rank[right.effect] - rank[left.effect];
      if (byEffect !== 0) {
        return byEffect;
      }
      return left.id.localeCompare(right.id);
    })[0] ?? null
  );
}

export function isRisk(value: unknown): value is RiskLevel {
  return (
    value === "LOW" ||
    value === "MEDIUM" ||
    value === "HIGH" ||
    value === "CRITICAL"
  );
}

export function isPermission(value: unknown): value is PermissionDomain {
  return (
    typeof value === "string" &&
    new Set<string>([
      "FS_READ",
      "FS_WRITE",
      "FS_DELETE",
      "SHELL_SAFE",
      "SHELL_FULL",
      "PROCESS_CONTROL",
      "NETWORK",
      "GIT_WRITE",
      "GIT_REMOTE_WRITE",
      "SCREEN_READ",
      "INPUT_CONTROL",
      "BROWSER",
      "SECRET_USE",
      "ELEVATION",
      "ADMIN",
    ]).has(value)
  );
}
