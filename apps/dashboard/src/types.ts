export interface DeviceSummary {
  device_id: string;
  name: string;
  status: "online" | "offline";
  os: string;
  arch: string;
  agent_version: string;
  last_seen: string | null;
}

export interface SessionSummary {
  id: string;
  ai_client_type: string;
  started_at: string;
  ended_at: string | null;
  last_seen_at: string;
}

export interface CommandSummary {
  id: string;
  device_id: string;
  device_name: string;
  session_id: string;
  tool_name: string;
  operation: string;
  risk: string;
  state: string;
  requested_at: string;
  accepted_at: string | null;
  completed_at: string | null;
  error_code: string | null;
}

export interface ApprovalSummary {
  id: string;
  device_id: string;
  session_id: string;
  command_id: string | null;
  permission: string;
  risk: string;
  scope: "once" | "session";
  decision: "APPROVE" | "DENY" | null;
  requested_at: string;
  decided_at: string | null;
  expires_at: string;
  consumed_at: string | null;
  device_name: string;
  tool_name: string | null;
  operation: string | null;
  human_summary: string;
}

export interface AuditSummary {
  id: string;
  device_id: string | null;
  session_id: string | null;
  command_id: string | null;
  event_type: string;
  decision: string | null;
  risk: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface UsageSummary {
  tool_calls: number;
  completed: number;
  failed: number;
  avg_latency_ms: number | null;
  artifact_bytes: number;
}

export interface DashboardOverview {
  devices: DeviceSummary[];
  sessions: SessionSummary[];
  commands: CommandSummary[];
  approvals: ApprovalSummary[];
  audit: AuditSummary[];
  usage: UsageSummary;
}
