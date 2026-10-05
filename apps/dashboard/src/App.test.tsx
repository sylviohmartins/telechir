import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import * as api from "./api";
import type { DashboardOverview } from "./types";

vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    ...actual,
    getOverview: vi.fn(),
    decideApproval: vi.fn(),
    revokeDevice: vi.fn(),
  };
});

const overview: DashboardOverview = {
  devices: [
    {
      device_id: "device-1",
      name: "Predator",
      status: "online",
      os: "windows",
      arch: "x86_64",
      agent_version: "0.10.0",
      last_seen: "2026-10-05T19:00:00.000Z",
    },
  ],
  sessions: [
    {
      id: "session-1",
      ai_client_type: "chatgpt",
      started_at: "2026-10-05T18:00:00.000Z",
      ended_at: null,
      last_seen_at: "2026-10-05T19:00:00.000Z",
    },
  ],
  commands: [
    {
      id: "command-1",
      device_id: "device-1",
      device_name: "Predator",
      session_id: "session-1",
      tool_name: "read_file",
      operation: "fs.read",
      risk: "LOW",
      state: "COMPLETED",
      requested_at: "2026-10-05T18:59:59.000Z",
      accepted_at: "2026-10-05T18:59:59.100Z",
      completed_at: "2026-10-05T19:00:00.000Z",
      error_code: null,
    },
  ],
  approvals: [
    {
      id: "approval-1",
      device_id: "device-1",
      session_id: "session-1",
      command_id: "command-2",
      permission: "SHELL_SAFE",
      risk: "HIGH",
      scope: "once",
      decision: null,
      requested_at: "2026-10-05T19:00:00.000Z",
      decided_at: null,
      expires_at: "2099-10-05T19:01:00.000Z",
      consumed_at: null,
      device_name: "Predator",
      tool_name: "run_command",
      operation: "process.run",
      human_summary: "run_command · process.run",
    },
  ],
  audit: [
    {
      id: "audit-1",
      device_id: "device-1",
      session_id: "session-1",
      command_id: "command-1",
      event_type: "COMMAND_COMPLETED",
      decision: "ALLOW",
      risk: "LOW",
      metadata: {},
      created_at: "2026-10-05T19:00:00.000Z",
    },
  ],
  usage: {
    tool_calls: 1,
    completed: 1,
    failed: 0,
    avg_latency_ms: 1000,
    artifact_bytes: 2048,
  },
};

describe("Dashboard App", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.mocked(api.getOverview).mockReset();
    vi.mocked(api.decideApproval).mockReset();
    vi.mocked(api.revokeDevice).mockReset();
    vi.mocked(api.getOverview).mockResolvedValue(overview);
    vi.mocked(api.decideApproval).mockResolvedValue({
      approval_id: "approval-1",
      decision: "APPROVE",
      scope: "once",
    });
  });

  it("keeps the bearer token masked and only for the tab session", async () => {
    render(<App />);

    const input = screen.getByLabelText("Access token");
    expect(input).toHaveAttribute("type", "password");

    fireEvent.change(input, { target: { value: "secret-test-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Abrir dashboard" }));

    await screen.findByText("Operations dashboard");
    expect(sessionStorage.getItem("telechir.dashboard.access_token")).toBe(
      "secret-test-token",
    );
    expect(screen.queryByText("secret-test-token")).not.toBeInTheDocument();
  });

  it("renders operational state and sends a bounded once approval", async () => {
    sessionStorage.setItem(
      "telechir.dashboard.access_token",
      "secret-test-token",
    );
    render(<App />);

    await screen.findByRole("heading", { level: 3, name: "Predator" });
    expect(screen.getByText("1 pendentes")).toBeInTheDocument();
    expect(screen.getByText("COMMAND_COMPLETED")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Aprovar uma vez" }));

    await waitFor(() => {
      expect(api.decideApproval).toHaveBeenCalledWith(
        "secret-test-token",
        "approval-1",
        "APPROVE",
        "once",
      );
    });
  });
});
