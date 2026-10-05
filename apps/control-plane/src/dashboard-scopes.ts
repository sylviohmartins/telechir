export const DASHBOARD_OAUTH_SCOPES = {
  read: "telechir:dashboard:read",
  decideApprovals: "telechir:approvals:decide",
  revokeDevices: "telechir:devices:revoke",
} as const;

export const PHASE10_DASHBOARD_OAUTH_SCOPES = Object.values(
  DASHBOARD_OAUTH_SCOPES,
);
