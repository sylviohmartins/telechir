import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
  requireBearerAuth,
  requireScopes,
  type AuthInfo,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";

import {
  BrowserToolsError,
  BrowserToolsService,
  PHASE14_BROWSER_TOOL_NAMES,
  type BrowserToolName,
} from "./browser-tools";
import {
  ComputerToolsError,
  ComputerToolsService,
  PHASE13_COMPUTER_TOOL_NAMES,
  type ComputerToolName,
} from "./computer-tools";
import { DeviceToolsError, DeviceToolsService } from "./device-tools";
import type { Env } from "./env";
import type { CallerContext } from "./governance";
import {
  FilesystemToolsError,
  FilesystemToolsService,
  PHASE6_FILESYSTEM_TOOL_NAMES,
  type FilesystemToolName,
} from "./filesystem-tools";
import {
  PHASE14_TOOLS,
  publicSchema,
  type PublicToolDefinition,
} from "./mcp-catalog";
import {
  PHASE7_PROCESS_TOOL_NAMES,
  ProcessToolsError,
  ProcessToolsService,
  type ProcessToolName,
} from "./process-tools";
import {
  GitToolsError,
  GitToolsService,
  PHASE8_GIT_TOOL_NAMES,
  type GitToolName,
} from "./git-tools";
import { SERVICE_VERSION } from "./meta";
import { WorkspaceError } from "./workspace";
import {
  JwtAccessTokenVerifier,
  oauthConfigFromEnv,
  telechirUserId,
} from "./oauth";

export const MCP_MAX_REQUEST_BYTES = 256 * 1024;

async function requestBodyExceedsLimit(request: Request): Promise<boolean> {
  if (request.method !== "POST") {
    return false;
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const parsed = Number(contentLength);
    if (Number.isFinite(parsed) && parsed > MCP_MAX_REQUEST_BYTES) {
      return true;
    }
  }

  const body = request.clone().body;
  if (!body) {
    return false;
  }

  const reader = body.getReader();
  let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        return false;
      }
      total += chunk.value.byteLength;
      if (total > MCP_MAX_REQUEST_BYTES) {
        await reader.cancel();
        return true;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function jsonText(value: unknown): string {
  return JSON.stringify(value);
}

function callerContext(authInfo: AuthInfo | undefined): CallerContext {
  return {
    ...(authInfo?.clientId ? { clientId: authInfo.clientId } : {}),
    ...(typeof authInfo?.expiresAt === "number"
      ? { expiresAt: authInfo.expiresAt }
      : {}),
  };
}

function scopedChallenge(scopes: string[]) {
  const [first, ...rest] = scopes;
  if (!first) {
    throw new Error("OAuth tool scope list must not be empty");
  }
  return requireScopes(first, ...rest);
}

function toolFailure(error: unknown) {
  if (error instanceof WorkspaceError) {
    const text =
      error.code === "NOT_FOUND"
        ? "The selected workspace was not found for this device."
        : error.code === "INVALID_ARGUMENT"
          ? "The workspace identifier is invalid."
          : "The device workspace could not be resolved.";
    return {
      content: [{ type: "text" as const, text }],
      isError: true,
    };
  }

  if (error instanceof DeviceToolsError && error.code === "NOT_FOUND") {
    return {
      content: [{ type: "text" as const, text: "Device not found." }],
      isError: true,
    };
  }

  if (error instanceof FilesystemToolsError) {
    const safe = new Map<string, string>([
      ["NOT_FOUND", "Filesystem target or device was not found."],
      ["DEVICE_OFFLINE", "The selected device is offline."],
      [
        "UNSUPPORTED_CAPABILITY",
        "The selected device does not support this filesystem operation.",
      ],
      [
        "POLICY_DENIED",
        "The local device policy denied this filesystem operation.",
      ],
      [
        "APPROVAL_REQUIRED",
        "This filesystem operation requires explicit Telechir approval.",
      ],
      [
        "CONFLICT",
        "The filesystem operation conflicted with current file state.",
      ],
      [
        "IDEMPOTENCY_CONFLICT",
        "The filesystem operation conflicts with a previous idempotent request.",
      ],
      ["DEADLINE_EXCEEDED", "The filesystem operation exceeded its deadline."],
      ["TIMEOUT", "The filesystem operation timed out on the device."],
      ["INVALID_ARGUMENT", "The filesystem request is invalid."],
    ]);
    return {
      content: [
        {
          type: "text" as const,
          text:
            safe.get(error.code) ??
            "The Telechir filesystem operation could not be completed.",
        },
      ],
      isError: true,
    };
  }

  if (error instanceof ProcessToolsError) {
    const safe = new Map<string, string>([
      ["NOT_FOUND", "The managed process or device was not found."],
      ["DEVICE_OFFLINE", "The selected device is offline."],
      [
        "UNSUPPORTED_CAPABILITY",
        "The selected device does not support this process operation.",
      ],
      [
        "POLICY_DENIED",
        "The local device policy denied this process operation.",
      ],
      [
        "APPROVAL_REQUIRED",
        "This process operation requires explicit Telechir approval.",
      ],
      ["CONFLICT", "The managed process is not in a compatible state."],
      [
        "IDEMPOTENCY_CONFLICT",
        "The process operation conflicts with a previous idempotent request.",
      ],
      ["DEADLINE_EXCEEDED", "The process operation exceeded its deadline."],
      ["TIMEOUT", "The process operation timed out on the device."],
      ["RATE_LIMITED", "The local managed-process limit has been reached."],
      ["INVALID_ARGUMENT", "The process request is invalid."],
    ]);
    return {
      content: [
        {
          type: "text" as const,
          text:
            safe.get(error.code) ??
            "The Telechir process operation could not be completed.",
        },
      ],
      isError: true,
    };
  }

  if (error instanceof BrowserToolsError) {
    const safe = new Map<string, string>([
      ["NOT_FOUND", "The browser session or device was not found."],
      ["DEVICE_OFFLINE", "The selected device is offline."],
      [
        "UNSUPPORTED_CAPABILITY",
        "The selected device does not support this browser operation.",
      ],
      ["POLICY_DENIED", "The local browser policy denied this operation."],
      [
        "APPROVAL_REQUIRED",
        "This browser operation requires explicit Telechir approval.",
      ],
      ["CONFLICT", "The browser state changed before the action completed."],
      ["OUTPUT_TRUNCATED", "The browser result exceeded its bounded limit."],
      ["DEADLINE_EXCEEDED", "The browser operation exceeded its deadline."],
      ["TIMEOUT", "The browser operation timed out on the device."],
      ["RATE_LIMITED", "The local browser session limit has been reached."],
      ["INVALID_ARGUMENT", "The browser request is invalid."],
    ]);
    return {
      content: [
        {
          type: "text" as const,
          text:
            safe.get(error.code) ??
            "The Telechir browser operation could not be completed.",
        },
      ],
      isError: true,
    };
  }

  if (error instanceof ComputerToolsError) {
    const safe = new Map<string, string>([
      ["NOT_FOUND", "The device was not found."],
      ["DEVICE_OFFLINE", "The selected device is offline."],
      [
        "UNSUPPORTED_CAPABILITY",
        "The selected device does not support this computer-use operation.",
      ],
      [
        "POLICY_DENIED",
        "The local device policy or local user denied this computer-use operation.",
      ],
      [
        "APPROVAL_REQUIRED",
        "This computer-use request requires explicit Telechir approval; remote approval never replaces local CRITICAL confirmation when input control is requested.",
      ],
      [
        "CONFLICT",
        "The computer state changed before the action could complete.",
      ],
      [
        "OUTPUT_TRUNCATED",
        "The screen capture exceeded the bounded output limit.",
      ],
      [
        "DEADLINE_EXCEEDED",
        "The computer-use operation exceeded its deadline.",
      ],
      ["INVALID_ARGUMENT", "The computer-use request is invalid."],
    ]);
    return {
      content: [
        {
          type: "text" as const,
          text:
            safe.get(error.code) ??
            "The Telechir computer-use operation could not be completed.",
        },
      ],
      isError: true,
    };
  }

  if (error instanceof GitToolsError) {
    const safe = new Map<string, string>([
      ["NOT_FOUND", "The Git repository or device was not found."],
      ["DEVICE_OFFLINE", "The selected device is offline."],
      [
        "UNSUPPORTED_CAPABILITY",
        "The selected device does not support this Git operation.",
      ],
      [
        "POLICY_DENIED",
        "The local device policy denied this Git read operation.",
      ],
      [
        "APPROVAL_REQUIRED",
        "This Git operation requires explicit Telechir approval.",
      ],
      ["CONFLICT", "The Git repository state could not be read."],
      ["OUTPUT_TRUNCATED", "The Git status exceeds the bounded output limit."],
      ["DEADLINE_EXCEEDED", "The Git operation exceeded its deadline."],
      ["TIMEOUT", "The Git operation timed out on the device."],
      ["INVALID_ARGUMENT", "The Git request is invalid."],
    ]);
    return {
      content: [
        {
          type: "text" as const,
          text:
            safe.get(error.code) ??
            "The Telechir Git operation could not be completed.",
        },
      ],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: "text" as const,
        text: "The Telechir control plane could not complete this request.",
      },
    ],
    isError: true,
  };
}

function registerListDevices(
  server: McpServer,
  env: Env,
  tool: PublicToolDefinition,
): void {
  const scopes = tool.securitySchemes.flatMap((scheme) => scheme.scopes);
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: fromJsonSchema(publicSchema(tool.input_schema_ref)),
      outputSchema: fromJsonSchema(publicSchema(tool.output_schema_ref)),
      annotations: tool.annotations,
      _meta: {
        securitySchemes: tool.securitySchemes,
      },
      scopeChallenge: scopedChallenge(scopes),
    },
    async (args, ctx) => {
      try {
        const userId = telechirUserId(ctx.http?.authInfo);
        const input =
          args && typeof args === "object"
            ? (args as { status?: "online" | "offline" | "all" })
            : {};
        const output = await new DeviceToolsService(
          env.DB,
          env.DEVICE_COORDINATOR,
        ).listDevices(userId, input);
        return {
          content: [{ type: "text", text: jsonText(output) }],
          structuredContent: output,
        };
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
}

function registerGetDevice(
  server: McpServer,
  env: Env,
  tool: PublicToolDefinition,
): void {
  const scopes = tool.securitySchemes.flatMap((scheme) => scheme.scopes);
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: fromJsonSchema(publicSchema(tool.input_schema_ref)),
      outputSchema: fromJsonSchema(publicSchema(tool.output_schema_ref)),
      annotations: tool.annotations,
      _meta: {
        securitySchemes: tool.securitySchemes,
      },
      scopeChallenge: scopedChallenge(scopes),
    },
    async (args, ctx) => {
      try {
        const userId = telechirUserId(ctx.http?.authInfo);
        const input = args as { device_id: string };
        const output = await new DeviceToolsService(
          env.DB,
          env.DEVICE_COORDINATOR,
        ).getDevice(userId, input);
        return {
          content: [{ type: "text", text: jsonText(output) }],
          structuredContent: output,
        };
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
}

function registerFilesystemTool(
  server: McpServer,
  env: Env,
  tool: PublicToolDefinition,
): void {
  if (!PHASE6_FILESYSTEM_TOOL_NAMES.includes(tool.name as FilesystemToolName)) {
    throw new Error(`unexpected filesystem tool: ${tool.name}`);
  }

  const scopes = tool.securitySchemes.flatMap((scheme) => scheme.scopes);
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: fromJsonSchema(publicSchema(tool.input_schema_ref)),
      outputSchema: fromJsonSchema(publicSchema(tool.output_schema_ref)),
      annotations: tool.annotations,
      _meta: {
        securitySchemes: tool.securitySchemes,
      },
      scopeChallenge: scopedChallenge(scopes),
    },
    async (args, ctx) => {
      try {
        const userId = telechirUserId(ctx.http?.authInfo);
        if (!args || typeof args !== "object" || Array.isArray(args)) {
          throw new FilesystemToolsError(
            "INVALID_ARGUMENT",
            "Filesystem tool arguments must be an object",
          );
        }

        const output = await new FilesystemToolsService(
          env.DB,
          env.DEVICE_COORDINATOR,
        ).execute(
          userId,
          tool.name as FilesystemToolName,
          args as Record<string, unknown>,
          callerContext(ctx.http?.authInfo),
        );
        return {
          content: [{ type: "text", text: jsonText(output) }],
          structuredContent: output,
        };
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
}

function registerProcessTool(
  server: McpServer,
  env: Env,
  tool: PublicToolDefinition,
): void {
  if (!PHASE7_PROCESS_TOOL_NAMES.includes(tool.name as ProcessToolName)) {
    throw new Error(`unexpected process tool: ${tool.name}`);
  }

  const scopes = tool.securitySchemes.flatMap((scheme) => scheme.scopes);
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: fromJsonSchema(publicSchema(tool.input_schema_ref)),
      outputSchema: fromJsonSchema(publicSchema(tool.output_schema_ref)),
      annotations: tool.annotations,
      _meta: {
        securitySchemes: tool.securitySchemes,
      },
      scopeChallenge: scopedChallenge(scopes),
    },
    async (args, ctx) => {
      try {
        const userId = telechirUserId(ctx.http?.authInfo);
        if (!args || typeof args !== "object" || Array.isArray(args)) {
          throw new ProcessToolsError(
            "INVALID_ARGUMENT",
            "Process tool arguments must be an object",
          );
        }

        const output = await new ProcessToolsService(
          env.DB,
          env.DEVICE_COORDINATOR,
        ).execute(
          userId,
          tool.name as ProcessToolName,
          args as Record<string, unknown>,
          callerContext(ctx.http?.authInfo),
        );
        return {
          content: [{ type: "text", text: jsonText(output) }],
          structuredContent: output,
        };
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
}

function registerComputerTool(
  server: McpServer,
  env: Env,
  tool: PublicToolDefinition,
): void {
  if (!PHASE13_COMPUTER_TOOL_NAMES.includes(tool.name as ComputerToolName)) {
    throw new Error(`unexpected computer-use tool: ${tool.name}`);
  }

  const scopes = tool.securitySchemes.flatMap((scheme) => scheme.scopes);
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: fromJsonSchema(publicSchema(tool.input_schema_ref)),
      outputSchema: fromJsonSchema(publicSchema(tool.output_schema_ref)),
      annotations: tool.annotations,
      _meta: {
        securitySchemes: tool.securitySchemes,
      },
      scopeChallenge: scopedChallenge(scopes),
    },
    async (args, ctx) => {
      try {
        const userId = telechirUserId(ctx.http?.authInfo);
        if (!args || typeof args !== "object" || Array.isArray(args)) {
          throw new ComputerToolsError(
            "INVALID_ARGUMENT",
            "Computer-use tool arguments must be an object",
          );
        }

        const output = await new ComputerToolsService(
          env.DB,
          env.DEVICE_COORDINATOR,
        ).execute(
          userId,
          tool.name as ComputerToolName,
          args as Record<string, unknown>,
          callerContext(ctx.http?.authInfo),
        );

        if (tool.name === "capture_screen") {
          const data = output.data_base64;
          const mediaType = output.media_type;
          if (typeof data !== "string" || typeof mediaType !== "string") {
            throw new ComputerToolsError(
              "INTERNAL_ERROR",
              "Screen capture result is missing bounded image content",
            );
          }
          const { data_base64: _omittedImagePayload, ...metadata } = output;
          return {
            content: [
              {
                type: "image" as const,
                data,
                mimeType: mediaType,
              },
            ],
            structuredContent: metadata,
          };
        }

        return {
          content: [{ type: "text", text: jsonText(output) }],
          structuredContent: output,
        };
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
}

function registerBrowserTool(
  server: McpServer,
  env: Env,
  tool: PublicToolDefinition,
): void {
  if (!PHASE14_BROWSER_TOOL_NAMES.includes(tool.name as BrowserToolName)) {
    throw new Error(`unexpected browser tool: ${tool.name}`);
  }

  const scopes = tool.securitySchemes.flatMap((scheme) => scheme.scopes);
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: fromJsonSchema(publicSchema(tool.input_schema_ref)),
      outputSchema: fromJsonSchema(publicSchema(tool.output_schema_ref)),
      annotations: tool.annotations,
      _meta: {
        securitySchemes: tool.securitySchemes,
      },
      scopeChallenge: scopedChallenge(scopes),
    },
    async (args, ctx) => {
      try {
        const userId = telechirUserId(ctx.http?.authInfo);
        if (!args || typeof args !== "object" || Array.isArray(args)) {
          throw new BrowserToolsError(
            "INVALID_ARGUMENT",
            "Browser tool arguments must be an object",
          );
        }

        const output = await new BrowserToolsService(
          env.DB,
          env.DEVICE_COORDINATOR,
        ).execute(
          userId,
          tool.name as BrowserToolName,
          args as Record<string, unknown>,
          callerContext(ctx.http?.authInfo),
        );
        return {
          content: [{ type: "text", text: jsonText(output) }],
          structuredContent: output,
        };
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
}

function registerGitTool(
  server: McpServer,
  env: Env,
  tool: PublicToolDefinition,
): void {
  if (!PHASE8_GIT_TOOL_NAMES.includes(tool.name as GitToolName)) {
    throw new Error(`unexpected Git tool: ${tool.name}`);
  }

  const scopes = tool.securitySchemes.flatMap((scheme) => scheme.scopes);
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: fromJsonSchema(publicSchema(tool.input_schema_ref)),
      outputSchema: fromJsonSchema(publicSchema(tool.output_schema_ref)),
      annotations: tool.annotations,
      _meta: {
        securitySchemes: tool.securitySchemes,
      },
      scopeChallenge: scopedChallenge(scopes),
    },
    async (args, ctx) => {
      try {
        const userId = telechirUserId(ctx.http?.authInfo);
        if (!args || typeof args !== "object" || Array.isArray(args)) {
          throw new GitToolsError(
            "INVALID_ARGUMENT",
            "Git tool arguments must be an object",
          );
        }

        const output = await new GitToolsService(
          env.DB,
          env.DEVICE_COORDINATOR,
        ).execute(
          userId,
          tool.name as GitToolName,
          args as Record<string, unknown>,
          callerContext(ctx.http?.authInfo),
        );
        return {
          content: [{ type: "text", text: jsonText(output) }],
          structuredContent: output,
        };
      } catch (error) {
        return toolFailure(error);
      }
    },
  );
}

export function createTelechirMcpServer(env: Env): McpServer {
  const server = new McpServer({
    name: "telechir",
    version: SERVICE_VERSION,
    title: "Telechir",
  });

  for (const tool of PHASE14_TOOLS) {
    switch (tool.name) {
      case "list_devices":
        registerListDevices(server, env, tool);
        break;
      case "get_device":
        registerGetDevice(server, env, tool);
        break;
      case "list_files":
      case "get_file_metadata":
      case "read_file":
      case "write_file":
      case "patch_file":
      case "search_files":
        registerFilesystemTool(server, env, tool);
        break;
      case "run_command":
      case "start_process":
      case "read_process_output":
      case "write_process_input":
      case "cancel_process":
      case "list_managed_processes":
        registerProcessTool(server, env, tool);
        break;
      case "get_git_status":
      case "get_git_diff":
        registerGitTool(server, env, tool);
        break;
      case "capture_screen":
      case "control_computer":
        registerComputerTool(server, env, tool);
        break;
      case "open_browser_session":
      case "get_browser_snapshot":
      case "navigate_browser":
      case "click_browser":
      case "fill_browser":
      case "close_browser_session":
        registerBrowserTool(server, env, tool);
        break;
      default:
        throw new Error(`unexpected enabled MCP tool: ${tool.name}`);
    }
  }

  return server;
}

async function materializeOpenAiSecuritySchemes(
  response: Response,
): Promise<Response> {
  if (
    !response.ok ||
    !response.headers.get("content-type")?.includes("application/json")
  ) {
    return response;
  }

  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return response;
  }

  const catalogByName = new Map(
    PHASE14_TOOLS.map((tool) => [tool.name, tool.securitySchemes]),
  );

  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") {
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }

    const object = value as Record<string, unknown>;
    if (Array.isArray(object.tools)) {
      for (const candidate of object.tools) {
        if (!candidate || typeof candidate !== "object") {
          continue;
        }
        const tool = candidate as Record<string, unknown>;
        if (typeof tool.name !== "string") {
          continue;
        }
        const securitySchemes = catalogByName.get(tool.name);
        if (securitySchemes) {
          tool.securitySchemes = securitySchemes;
        }
      }
    }

    for (const child of Object.values(object)) {
      visit(child);
    }
  };
  visit(body);

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("cache-control", "no-store");
  return Response.json(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function sameConfiguredOrigin(
  request: Request,
  resourceUri: string,
): Response | null {
  const resource = new URL(resourceUri);
  const requestUrl = new URL(request.url);

  if (requestUrl.origin !== resource.origin) {
    return Response.json(
      { error: "invalid_request", error_description: "Host is not allowed" },
      { status: 421 },
    );
  }

  const origin = request.headers.get("origin");
  if (origin && origin !== resource.origin) {
    return Response.json(
      {
        error: "invalid_request",
        error_description: "Origin is not allowed",
      },
      { status: 403 },
    );
  }

  return null;
}

export async function mcpHttpRoute(
  request: Request,
  env: Env,
  url: URL,
  verifier?: OAuthTokenVerifier,
): Promise<Response | null> {
  if (url.pathname !== "/mcp") {
    return null;
  }

  let config;
  try {
    config = oauthConfigFromEnv(env);
  } catch {
    return Response.json(
      {
        error: "server_error",
        error_description: "MCP OAuth resource server is not configured",
      },
      {
        status: 503,
        headers: { "cache-control": "no-store" },
      },
    );
  }

  const rejected = sameConfiguredOrigin(request, config.resourceUri);
  if (rejected) {
    return rejected;
  }

  const tokenVerifier = verifier ?? new JwtAccessTokenVerifier(env.DB, config);
  const gate = requireBearerAuth({
    verifier: tokenVerifier,
    resourceMetadataUrl: config.resourceMetadataUrl,
  });
  const auth = await gate(request);
  if (auth instanceof Response) {
    return auth;
  }

  if (await requestBodyExceedsLimit(request)) {
    return Response.json(
      {
        error: "request_too_large",
        error_description: "MCP request body exceeds the configured limit",
      },
      {
        status: 413,
        headers: {
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      },
    );
  }

  const handler = createMcpHandler(() => createTelechirMcpServer(env), {
    legacy: "stateless",
  });

  const response = await handler.fetch(request, {
    authInfo: auth as AuthInfo,
  });
  return materializeOpenAiSecuritySchemes(response);
}
