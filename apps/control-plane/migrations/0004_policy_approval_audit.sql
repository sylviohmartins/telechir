CREATE INDEX IF NOT EXISTS idx_policy_restrictions_scope_permission_expiry
  ON policy_restrictions(scope_type, scope_id, permission, expires_at);

CREATE INDEX IF NOT EXISTS idx_approvals_binding
  ON approvals(
    user_id,
    device_id,
    session_id,
    permission,
    risk,
    argument_digest,
    decision,
    expires_at,
    consumed_at
  );

CREATE INDEX IF NOT EXISTS idx_approvals_command
  ON approvals(command_id, requested_at);

CREATE INDEX IF NOT EXISTS idx_audit_events_command_created
  ON audit_events(command_id, created_at);
