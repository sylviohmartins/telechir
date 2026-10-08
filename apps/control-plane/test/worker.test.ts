import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import type { Env } from "../src/env";
import worker from "../src/index";

const bindings = env as unknown as Env;

function fetch(path: string): Promise<Response> | Response {
  return worker.fetch(new Request(`https://telechir.test${path}`), bindings);
}

describe("control-plane worker", () => {
  it("reports liveness without touching remote resources", async () => {
    const response = await fetch("/health");
    const body = (await response.json()) as {
      ok: boolean;
      data: Record<string, unknown>;
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data).toMatchObject({
      service: "telechir-control-plane",
      status: "ok",
      phase: "phase15-workspace-concurrency",
      version: "0.1.0",
    });
  });

  it("reports readiness from configured core bindings", async () => {
    const response = await fetch("/ready");
    const body = (await response.json()) as {
      data: {
        status: string;
        bindings: Record<string, boolean>;
      };
    };

    expect(response.status).toBe(200);
    expect(body.data.status).toBe("ready");
    expect(body.data.bindings).toMatchObject({
      d1: true,
      durableObjects: true,
      pairingServerSecret: true,
      pairingVerificationUri: true,
      realtimeServerSecret: true,
      mcpResourceUri: true,
      oauthIssuer: true,
      r2: false,
      analyticsEngine: false,
      queues: false,
    });
  });

  it("reports the control-plane skeleton version", async () => {
    const response = await fetch("/version");
    const body = (await response.json()) as {
      data: Record<string, unknown>;
    };

    expect(response.status).toBe(200);
    expect(body.data).toEqual({
      service: "telechir-control-plane",
      version: "0.1.0",
      phase: "phase15-workspace-concurrency",
    });
  });

  it("keeps legacy public product routes closed in Phase 10", async () => {
    for (const route of ["/devices", "/pairing", "/ws"]) {
      const response = await fetch(route);
      expect(response.status).toBe(404);
    }
  });

  it("serves the OpenAI domain challenge as exact plain text", async () => {
    const response = await fetch("/.well-known/openai-apps-challenge");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.text()).resolves.toBe(
      "openai-phase11-domain-challenge-test-token",
    );
  });

  it("preserves the exact OpenAI domain challenge token without assuming URL-safe characters", async () => {
    const exact = "openai.challenge+abc/xyz==";
    const configured = {
      ...bindings,
      OPENAI_APPS_CHALLENGE_TOKEN: exact,
    } as unknown as Env;

    const response = await worker.fetch(
      new Request("https://telechir.test/.well-known/openai-apps-challenge"),
      configured,
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(exact);
  });

  it("fails the OpenAI domain challenge closed when the token is unavailable or malformed", async () => {
    for (const token of [
      undefined,
      "invalid\ntoken-value-that-is-long-enough",
    ]) {
      const incomplete = {
        ...bindings,
        OPENAI_APPS_CHALLENGE_TOKEN: token,
      } as unknown as Env;

      const response = await worker.fetch(
        new Request("https://telechir.test/.well-known/openai-apps-challenge"),
        incomplete,
      );

      expect(response.status).toBe(404);
      await expect(response.text()).resolves.toBe("Not found");
    }
  });

  it("allows only GET for the OpenAI domain challenge", async () => {
    const response = await worker.fetch(
      new Request("https://telechir.test/.well-known/openai-apps-challenge", {
        method: "POST",
      }),
      bindings,
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  });

  it("does not expose the OpenAI domain challenge token through health or version", async () => {
    const [health, version] = await Promise.all([
      fetch("/health"),
      fetch("/version"),
    ]);

    expect(await health.text()).not.toContain(
      "openai-phase11-domain-challenge-test-token",
    );
    expect(await version.text()).not.toContain(
      "openai-phase11-domain-challenge-test-token",
    );
  });

  it("publishes OAuth protected-resource metadata", async () => {
    const response = await fetch("/.well-known/oauth-protected-resource");
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toEqual({
      resource: "https://telechir.test/mcp",
      authorization_servers: ["https://auth.telechir.test"],
      scopes_supported: [
        "telechir:approvals:decide",
        "telechir:browser:use",
        "telechir:dashboard:read",
        "telechir:devices:read",
        "telechir:devices:revoke",
        "telechir:files:read",
        "telechir:files:write",
        "telechir:git:read",
        "telechir:input:write",
        "telechir:processes:read",
        "telechir:processes:write",
        "telechir:screen:read",
      ],
    });
  });

  it("protects the MCP endpoint with OAuth", async () => {
    const response = await fetch("/mcp");

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      "resource_metadata=",
    );
  });

  it("protects the Dashboard API with OAuth", async () => {
    const response = await fetch("/dashboard/api/overview");

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      "resource_metadata=",
    );
  });

  it("fails readiness closed when pairing secrets are unavailable", async () => {
    const incomplete = {
      ...bindings,
      PAIRING_SERVER_SECRET: undefined,
    } as unknown as Env;

    const response = await worker.fetch(
      new Request("https://telechir.test/ready"),
      incomplete,
    );
    const body = (await response.json()) as {
      data: { status: string; bindings: Record<string, boolean> };
    };

    expect(response.status).toBe(503);
    expect(body.data.status).toBe("not_ready");
    expect(body.data.bindings.pairingServerSecret).toBe(false);
  });

  it("fails readiness closed when realtime credentials cannot be issued", async () => {
    const incomplete = {
      ...bindings,
      REALTIME_SERVER_SECRET: undefined,
    } as unknown as Env;

    const response = await worker.fetch(
      new Request("https://telechir.test/ready"),
      incomplete,
    );
    const body = (await response.json()) as {
      data: { status: string; bindings: Record<string, boolean> };
    };

    expect(response.status).toBe(503);
    expect(body.data.status).toBe("not_ready");
    expect(body.data.bindings.realtimeServerSecret).toBe(false);
  });

  it("fails readiness closed when MCP OAuth configuration is unavailable", async () => {
    const incomplete = {
      ...bindings,
      OAUTH_ISSUER: undefined,
    } as unknown as Env;

    const response = await worker.fetch(
      new Request("https://telechir.test/ready"),
      incomplete,
    );
    const body = (await response.json()) as {
      data: { status: string; bindings: Record<string, boolean> };
    };

    expect(response.status).toBe(503);
    expect(body.data.status).toBe("not_ready");
    expect(body.data.bindings.oauthIssuer).toBe(false);
  });
});
