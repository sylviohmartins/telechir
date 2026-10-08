import { env } from "cloudflare:workers";
import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, it } from "vitest";

import type { Env } from "../src/env";
import {
  PHASE14_TOOLS,
  PHASE13_TOOLS,
  PHASE8_TOOLS,
  publicSchema,
} from "../src/mcp-catalog";
import { MCP_MAX_REQUEST_BYTES, mcpHttpRoute } from "../src/mcp-http";

const bindings = env as unknown as Env;
const resource = "https://telechir.test/mcp";

interface CapturedExchange {
  method: string | null;
  status: number;
  wwwAuthenticate: string | null;
  responseBody: unknown;
}

function wireTools(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== "object") {
    return [];
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = wireTools(item);
      if (found.length > 0) {
        return found;
      }
    }
    return [];
  }

  const object = value as Record<string, unknown>;
  if (
    Array.isArray(object.tools) &&
    object.tools.every(
      (tool) => tool && typeof tool === "object" && !Array.isArray(tool),
    )
  ) {
    return object.tools as Array<Record<string, unknown>>;
  }
  for (const child of Object.values(object)) {
    const found = wireTools(child);
    if (found.length > 0) {
      return found;
    }
  }
  return [];
}

function authInfo(
  userId: string,
  scopes = ["telechir:devices:read"],
): AuthInfo {
  return {
    token: "phase5-test-token",
    clientId: "phase5-test-client",
    scopes,
    expiresAt: Math.floor(Date.now() / 1000) + 300,
    resource: new URL(resource),
    resourceMetadataUrl:
      "https://telechir.test/.well-known/oauth-protected-resource",
    extra: { telechir_user_id: userId },
  };
}

function verifierFor(users: Record<string, AuthInfo>): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const info = users[token];
      if (!info) {
        throw new Error("invalid test token");
      }
      return info;
    },
  };
}

async function seedUser(name: string): Promise<string> {
  const id = crypto.randomUUID();
  await bindings.DB.prepare(
    `INSERT INTO users (
      id, identity_provider, provider_subject_hash, display_name,
      created_at, disabled_at
    ) VALUES (?, 'phase5-wire-test', ?, ?, ?, NULL)`,
  )
    .bind(id, `subject-${id}`, name, new Date().toISOString())
    .run();
  return id;
}

async function seedDevice(
  userId: string,
  name: string,
  revoked = false,
): Promise<string> {
  const id = crypto.randomUUID();
  await bindings.DB.prepare(
    `INSERT INTO devices (
      id, user_id, display_name, os, arch, agent_version,
      status_hint, last_seen_at, created_at, revoked_at
    ) VALUES (?, ?, ?, 'linux', 'x86_64', '0.1.0',
              'offline', NULL, ?, ?)`,
  )
    .bind(
      id,
      userId,
      name,
      new Date().toISOString(),
      revoked ? new Date().toISOString() : null,
    )
    .run();
  return id;
}

function testFetch(verifier: OAuthTokenVerifier, captured: CapturedExchange[]) {
  return async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request =
      input instanceof Request
        ? new Request(input, init)
        : new Request(input, init);

    let method: string | null = null;
    if (request.method === "POST") {
      try {
        const body = (await request.clone().json()) as {
          method?: unknown;
        };
        method = typeof body.method === "string" ? body.method : null;
      } catch {
        method = null;
      }
    }

    const response = await mcpHttpRoute(
      request,
      bindings,
      new URL(request.url),
      verifier,
    );
    if (!response) {
      return new Response("not found", { status: 404 });
    }

    let responseBody: unknown = null;
    if (response.headers.get("content-type")?.includes("application/json")) {
      responseBody = await response.clone().json();
    }
    captured.push({
      method,
      status: response.status,
      wwwAuthenticate: response.headers.get("www-authenticate"),
      responseBody,
    });
    return response;
  };
}

async function connectedClient(
  token: string,
  verifier: OAuthTokenVerifier,
  captured: CapturedExchange[],
): Promise<{
  client: Client;
  transport: StreamableHTTPClientTransport;
}> {
  const transport = new StreamableHTTPClientTransport(new URL(resource), {
    requestInit: {
      headers: {
        authorization: `Bearer ${token}`,
      },
    },
    fetch: testFetch(verifier, captured),
    onInsufficientScope: "throw",
  });
  const client = new Client(
    { name: "telechir-phase5-test", version: "1.0.0" },
    {
      versionNegotiation: { mode: "auto" },
    },
  );
  await client.connect(transport);
  return { client, transport };
}

beforeEach(async () => {
  await bindings.DB.prepare(
    "DELETE FROM workspaces WHERE user_id IN (SELECT id FROM users WHERE identity_provider = 'phase5-wire-test')",
  ).run();
  await bindings.DB.prepare(
    "DELETE FROM devices WHERE user_id IN (SELECT id FROM users WHERE identity_provider = 'phase5-wire-test')",
  ).run();
  await bindings.DB.prepare(
    "DELETE FROM users WHERE identity_provider = 'phase5-wire-test'",
  ).run();
});

describe("Remote MCP 2026-07-28", () => {
  it("negotiates server/discover and advertises exactly the Phase 14 tool surface while preserving prior snapshots", async () => {
    const userId = await seedUser("MCP User");
    await seedDevice(userId, "Device A");
    const captured: CapturedExchange[] = [];
    const verifier = verifierFor({
      "phase5-test-token": authInfo(userId),
    });
    const { client } = await connectedClient(
      "phase5-test-token",
      verifier,
      captured,
    );

    expect(client.getDiscoverResult()).toBeDefined();
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      "cancel_process",
      "capture_screen",
      "click_browser",
      "close_browser_session",
      "control_computer",
      "fill_browser",
      "get_browser_snapshot",
      "get_device",
      "get_file_metadata",
      "get_git_diff",
      "get_git_status",
      "list_devices",
      "list_files",
      "list_managed_processes",
      "navigate_browser",
      "open_browser_session",
      "patch_file",
      "read_file",
      "read_process_output",
      "run_command",
      "search_files",
      "start_process",
      "write_file",
      "write_process_input",
    ]);
    expect(
      captured.some((exchange) => exchange.method === "server/discover"),
    ).toBe(true);
    expect(PHASE8_TOOLS.map((tool) => tool.name).sort()).toEqual([
      "cancel_process",
      "get_device",
      "get_file_metadata",
      "get_git_diff",
      "get_git_status",
      "list_devices",
      "list_files",
      "list_managed_processes",
      "patch_file",
      "read_file",
      "read_process_output",
      "run_command",
      "search_files",
      "start_process",
      "write_file",
      "write_process_input",
    ]);

    await client.close();
  });

  it("materializes schemas and OpenAI security schemes from the frozen catalog", async () => {
    const userId = await seedUser("Descriptor User");
    const captured: CapturedExchange[] = [];
    const verifier = verifierFor({
      "phase5-test-token": authInfo(userId),
    });
    const { client } = await connectedClient(
      "phase5-test-token",
      verifier,
      captured,
    );

    await client.listTools();
    const toolExchange = captured.find(
      (exchange) => exchange.method === "tools/list",
    );
    expect(toolExchange).toBeDefined();

    const descriptors = wireTools(toolExchange?.responseBody);
    expect(descriptors).toHaveLength(24);

    for (const tool of PHASE14_TOOLS) {
      const descriptor = descriptors.find(
        (candidate) => candidate.name === tool.name,
      );
      expect(descriptor).toBeDefined();
      expect(descriptor?.securitySchemes).toEqual(tool.securitySchemes);
      expect(descriptor?.annotations).toEqual(tool.annotations);
      expect(typeof tool.annotations.readOnlyHint).toBe("boolean");
      expect(typeof tool.annotations.destructiveHint).toBe("boolean");
      expect(typeof tool.annotations.openWorldHint).toBe("boolean");
      expect(
        (descriptor?._meta as Record<string, unknown> | undefined)
          ?.securitySchemes,
      ).toEqual(tool.securitySchemes);
      expect(descriptor?.inputSchema).toMatchObject(
        publicSchema(tool.input_schema_ref),
      );
      expect(descriptor?.outputSchema).toMatchObject(
        publicSchema(tool.output_schema_ref),
      );
    }

    await client.close();
  });

  it("publishes execution_mode as a closed guarded_host or sandbox enum", () => {
    for (const ref of [
      "public-tools.schema.json#/$defs/run_command_input",
      "public-tools.schema.json#/$defs/start_process_input",
    ]) {
      const schema = publicSchema(ref) as {
        properties: Record<string, Record<string, unknown>>;
      };
      expect(schema.properties.execution_mode).toEqual({
        type: "string",
        enum: ["guarded_host", "sandbox"],
        default: "guarded_host",
      });
    }
  });

  it("lists and reads only devices owned by the authenticated user", async () => {
    const userA = await seedUser("User A");
    const userB = await seedUser("User B");
    const deviceA = await seedDevice(userA, "Device A");
    const deviceB = await seedDevice(userB, "Device B");
    await seedDevice(userA, "Revoked A", true);

    const captured: CapturedExchange[] = [];
    const verifier = verifierFor({
      "phase5-test-token": authInfo(userA),
    });
    const { client } = await connectedClient(
      "phase5-test-token",
      verifier,
      captured,
    );

    const list = await client.callTool({
      name: "list_devices",
      arguments: { status: "all" },
    });
    expect(list.isError).not.toBe(true);
    const structured = list.structuredContent as {
      devices: Array<{ device_id: string; name: string }>;
    };
    expect(structured.devices).toEqual([
      expect.objectContaining({
        device_id: deviceA,
        name: "Device A",
      }),
    ]);

    const own = await client.callTool({
      name: "get_device",
      arguments: { device_id: deviceA },
    });
    expect(own.isError).not.toBe(true);
    expect(own.structuredContent).toMatchObject({
      device_id: deviceA,
      name: "Device A",
      status: "offline",
      capabilities: [],
      policy_summary: null,
    });

    const foreign = await client.callTool({
      name: "get_device",
      arguments: { device_id: deviceB },
    });
    expect(foreign.isError).toBe(true);
    expect(JSON.stringify(foreign.content)).not.toContain(deviceB);

    await client.close();
  });

  it("advertises Phase 14 browser tools but keeps unimplemented later tools unavailable", async () => {
    const userId = await seedUser("Boundary User");
    const captured: CapturedExchange[] = [];
    const verifier = verifierFor({
      "phase5-test-token": authInfo(userId),
    });
    const { client } = await connectedClient(
      "phase5-test-token",
      verifier,
      captured,
    );

    const tools = await client.listTools();
    expect(tools.tools.some((tool) => tool.name === "read_file")).toBe(true);
    expect(tools.tools.some((tool) => tool.name === "run_command")).toBe(true);
    expect(tools.tools.some((tool) => tool.name === "get_git_status")).toBe(
      true,
    );
    expect(tools.tools.some((tool) => tool.name === "get_git_diff")).toBe(true);
    expect(tools.tools.some((tool) => tool.name === "capture_screen")).toBe(
      true,
    );
    expect(tools.tools.some((tool) => tool.name === "control_computer")).toBe(
      true,
    );
    expect(
      tools.tools.some((tool) => tool.name === "open_browser_session"),
    ).toBe(true);
    expect(
      tools.tools.some((tool) => tool.name === "get_browser_snapshot"),
    ).toBe(true);
    expect(tools.tools.some((tool) => tool.name === "navigate_browser")).toBe(
      true,
    );
    expect(tools.tools.some((tool) => tool.name === "click_browser")).toBe(
      true,
    );
    expect(tools.tools.some((tool) => tool.name === "fill_browser")).toBe(true);
    expect(
      tools.tools.some((tool) => tool.name === "close_browser_session"),
    ).toBe(true);
    expect(tools.tools.some((tool) => tool.name === "get_system_metrics")).toBe(
      false,
    );

    await expect(
      client.callTool({
        name: "get_system_metrics",
        arguments: {
          device_id: "device",
        },
      }),
    ).rejects.toThrow();

    await client.close();
  });

  it("rejects oversized MCP request bodies before protocol dispatch", async () => {
    const userId = await seedUser("Body Limit User");
    const verifier = verifierFor({
      "phase5-test-token": authInfo(userId),
    });
    const request = new Request(resource, {
      method: "POST",
      headers: {
        authorization: "Bearer phase5-test-token",
        "content-type": "application/json",
      },
      body: "x".repeat(MCP_MAX_REQUEST_BYTES + 1),
    });

    const response = await mcpHttpRoute(
      request,
      bindings,
      new URL(request.url),
      verifier,
    );

    expect(response?.status).toBe(413);
    await expect(response?.json()).resolves.toMatchObject({
      error: "request_too_large",
    });
  });

  it("translates invalid bearer tokens into an OAuth 401 challenge", async () => {
    const invalidVerifier: OAuthTokenVerifier = {
      async verifyAccessToken(): Promise<AuthInfo> {
        throw new OAuthError(
          OAuthErrorCode.InvalidToken,
          "Access token is invalid",
        );
      },
    };
    const request = new Request(resource, {
      method: "POST",
      headers: {
        authorization: "Bearer invalid-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "server/discover",
        params: {},
      }),
    });

    const response = await mcpHttpRoute(
      request,
      bindings,
      new URL(request.url),
      invalidVerifier,
    );

    expect(response?.status).toBe(401);
    expect(response?.headers.get("www-authenticate")).toContain(
      'error="invalid_token"',
    );
    expect(response?.headers.get("www-authenticate")).toContain(
      "resource_metadata=",
    );
  });

  it("enforces filesystem read/write scopes before device dispatch", async () => {
    const userId = await seedUser("Filesystem Scope User");
    const captured: CapturedExchange[] = [];
    const verifier = verifierFor({
      "phase6-read-only": authInfo(userId, ["telechir:files:read"]),
    });
    const { client } = await connectedClient(
      "phase6-read-only",
      verifier,
      captured,
    );

    const read = await client.callTool({
      name: "read_file",
      arguments: {
        device_id: crypto.randomUUID(),
        path: "README.md",
      },
    });
    expect(read.isError).toBe(true);
    expect(JSON.stringify(read.content)).toContain("not found");

    await expect(
      client.callTool({
        name: "write_file",
        arguments: {
          device_id: crypto.randomUUID(),
          path: "notes.txt",
          content: "denied",
          encoding: "utf-8",
          expected_hash: null,
          create_if_missing: true,
        },
      }),
    ).rejects.toThrow();

    const writeCall = [...captured]
      .reverse()
      .find((exchange) => exchange.method === "tools/call");
    expect(writeCall?.status).toBe(403);
    expect(writeCall?.wwwAuthenticate).toContain(
      'scope="telechir:files:write"',
    );

    await client.close();
  });

  it("enforces process read/write scopes before device dispatch", async () => {
    const userId = await seedUser("Process Scope User");
    const captured: CapturedExchange[] = [];
    const verifier = verifierFor({
      "phase7-process-read-only": authInfo(userId, ["telechir:processes:read"]),
    });
    const { client } = await connectedClient(
      "phase7-process-read-only",
      verifier,
      captured,
    );

    const read = await client.callTool({
      name: "list_managed_processes",
      arguments: {
        device_id: crypto.randomUUID(),
      },
    });
    expect(read.isError).toBe(true);
    expect(JSON.stringify(read.content)).toContain("not found");

    await expect(
      client.callTool({
        name: "run_command",
        arguments: {
          device_id: crypto.randomUUID(),
          command: "echo denied",
          timeout_seconds: 1,
          env_refs: [],
        },
      }),
    ).rejects.toThrow();

    const writeCall = [...captured]
      .reverse()
      .find((exchange) => exchange.method === "tools/call");
    expect(writeCall?.status).toBe(403);
    expect(writeCall?.wwwAuthenticate).toContain(
      'scope="telechir:processes:write"',
    );

    await client.close();
  });

  it("enforces Git read scope before device dispatch", async () => {
    const userId = await seedUser("Git Scope User");
    const captured: CapturedExchange[] = [];
    const verifier = verifierFor({
      "phase8-no-git-scope": authInfo(userId, ["telechir:devices:read"]),
    });
    const { client } = await connectedClient(
      "phase8-no-git-scope",
      verifier,
      captured,
    );

    await expect(
      client.callTool({
        name: "get_git_status",
        arguments: {
          device_id: crypto.randomUUID(),
          repository_path: ".",
        },
      }),
    ).rejects.toThrow();

    const call = [...captured]
      .reverse()
      .find((exchange) => exchange.method === "tools/call");
    expect(call?.status).toBe(403);
    expect(call?.wwwAuthenticate).toContain('scope="telechir:git:read"');

    await client.close();
  });

  it("enforces OAuth scope challenge at tool-call time", async () => {
    const userId = await seedUser("Scope User");
    const captured: CapturedExchange[] = [];
    const verifier = verifierFor({
      "phase5-no-scope": authInfo(userId, []),
    });
    const { client } = await connectedClient(
      "phase5-no-scope",
      verifier,
      captured,
    );

    await expect(
      client.callTool({
        name: "list_devices",
        arguments: {},
      }),
    ).rejects.toThrow();

    const call = captured.find((exchange) => exchange.method === "tools/call");
    expect(call?.status).toBe(403);
    expect(JSON.stringify(call?.responseBody)).toContain("insufficient_scope");
    expect(call?.wwwAuthenticate).toContain('scope="telechir:devices:read"');

    await client.close();
  });
});
