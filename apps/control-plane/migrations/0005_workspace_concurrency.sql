ALTER TABLE workspaces
  ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0
  CHECK (is_default IN (0, 1));

INSERT OR IGNORE INTO workspaces (
  id, user_id, device_id, display_name, created_at, archived_at, is_default
)
SELECT
  'workspace_' || id,
  user_id,
  id,
  'Default workspace',
  created_at,
  NULL,
  1
FROM devices;

UPDATE workspaces
SET is_default = 1
WHERE id = 'workspace_' || device_id
  AND archived_at IS NULL;

CREATE UNIQUE INDEX idx_workspaces_device_default
  ON workspaces(device_id)
  WHERE is_default = 1 AND archived_at IS NULL;

CREATE INDEX idx_workspaces_user_device_active
  ON workspaces(user_id, device_id, archived_at);

CREATE TRIGGER trg_devices_default_workspace
AFTER INSERT ON devices
BEGIN
  INSERT INTO workspaces (
    id, user_id, device_id, display_name, created_at, archived_at, is_default
  )
  VALUES (
    'workspace_' || NEW.id,
    NEW.user_id,
    NEW.id,
    'Default workspace',
    NEW.created_at,
    NULL,
    1
  );
END;

ALTER TABLE commands
  ADD COLUMN workspace_id TEXT
  REFERENCES workspaces(id);

UPDATE commands
SET workspace_id = (
  SELECT w.id
  FROM workspaces w
  WHERE w.device_id = commands.device_id
    AND w.is_default = 1
    AND w.archived_at IS NULL
  LIMIT 1
)
WHERE workspace_id IS NULL;

CREATE INDEX idx_commands_workspace_requested
  ON commands(workspace_id, requested_at);

ALTER TABLE approvals
  ADD COLUMN workspace_id TEXT
  REFERENCES workspaces(id);

UPDATE approvals
SET workspace_id = (
  SELECT c.workspace_id
  FROM commands c
  WHERE c.id = approvals.command_id
)
WHERE workspace_id IS NULL
  AND command_id IS NOT NULL;

CREATE INDEX idx_approvals_workspace_expiry_consumed
  ON approvals(workspace_id, expires_at, consumed_at);

ALTER TABLE commands
  ADD COLUMN workspace_fencing_token INTEGER
  CHECK (workspace_fencing_token IS NULL OR workspace_fencing_token > 0);
