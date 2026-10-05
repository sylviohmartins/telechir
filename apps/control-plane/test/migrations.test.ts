import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import type { Env } from "../src/env";

describe("D1 conceptual model migration", () => {
  it("materializes every Phase 0 entity", async () => {
    const bindings = env as unknown as Env;
    const result = await bindings.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all<{ name: string }>();

    const names = new Set(result.results.map((row) => row.name));
    const expected = [
      "users",
      "devices",
      "device_keys",
      "pairings",
      "workspaces",
      "policy_restrictions",
      "sessions",
      "approvals",
      "commands",
      "processes",
      "artifacts",
      "audit_events",
    ];

    for (const table of expected) {
      expect(names.has(table), `missing table: ${table}`).toBe(true);
    }
  });

  it("materializes every mandatory conceptual index", async () => {
    const bindings = env as unknown as Env;
    const result = await bindings.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index'",
    ).all<{ name: string }>();

    const names = new Set(result.results.map((row) => row.name));
    const expected = [
      "idx_users_identity_subject",
      "idx_devices_user_revoked",
      "idx_device_keys_device_revoked",
      "idx_pairings_code_expiry",
      "idx_pairings_installation_state_created",
      "idx_pairings_device_key_state",
      "idx_pairings_activated_device",
      "idx_sessions_user_started",
      "idx_commands_device_requested",
      "idx_commands_session_requested",
      "idx_approvals_device_expiry_consumed",
      "idx_audit_events_device_created",
      "idx_artifacts_user_created",
      "idx_policy_restrictions_scope_permission_expiry",
      "idx_approvals_binding",
      "idx_approvals_command",
      "idx_audit_events_command_created",
    ];

    for (const index of expected) {
      expect(names.has(index), `missing index: ${index}`).toBe(true);
    }
  });

  it("materializes the Phase 3 pre-activation pairing fields", async () => {
    const bindings = env as unknown as Env;
    const columns = await bindings.DB.prepare(
      "PRAGMA table_info(pairings)",
    ).all<{ name: string }>();
    const names = new Set(columns.results.map((row) => row.name));

    for (const column of [
      "public_key",
      "algorithm",
      "fingerprint",
      "device_installation_id",
      "display_name",
      "os",
      "arch",
      "agent_version",
      "challenge_used_at",
      "verification_attempts",
      "proof_attempts",
      "proved_at",
      "activated_device_id",
    ]) {
      expect(names.has(column), `missing pairing column: ${column}`).toBe(true);
    }

    const legacy = await bindings.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pairings_phase0'",
    ).first<{ name: string }>();
    expect(legacy).toBeNull();
  });
});
