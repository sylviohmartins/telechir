import type { DashboardOverview } from "./types";

interface ApiEnvelope<T> {
  data?: T;
  error?: {
    code?: string;
    message?: string;
  };
}

export class DashboardApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DashboardApiError";
  }
}

async function request<T>(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  headers.set("accept", "application/json");
  if (init.body !== undefined) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(path, { ...init, headers });
  const envelope = (await response.json().catch(() => ({}))) as ApiEnvelope<T>;
  if (!response.ok || envelope.data === undefined) {
    throw new DashboardApiError(
      response.status,
      envelope.error?.code ?? "REQUEST_FAILED",
      envelope.error?.message ?? "Não foi possível concluir a solicitação.",
    );
  }
  return envelope.data;
}

export function getOverview(token: string): Promise<DashboardOverview> {
  return request<DashboardOverview>(token, "/dashboard/api/overview?limit=50");
}

export function decideApproval(
  token: string,
  approvalId: string,
  decision: "APPROVE" | "DENY",
  scope: "once" | "session" = "once",
): Promise<{ approval_id: string; decision: string; scope: string }> {
  return request(
    token,
    `/dashboard/api/approvals/${encodeURIComponent(approvalId)}/decision`,
    {
      method: "POST",
      body: JSON.stringify({ decision, scope }),
    },
  );
}

export function revokeDevice(
  token: string,
  deviceId: string,
): Promise<{ device_id: string; revoked_at: string }> {
  return request(
    token,
    `/dashboard/api/devices/${encodeURIComponent(deviceId)}/revoke`,
    {
      method: "POST",
      body: JSON.stringify({ confirm: true }),
    },
  );
}
