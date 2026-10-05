import path from "node:path";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    path.join(import.meta.dirname, "migrations"),
  );

  return {
    plugins: [
      cloudflareTest({
        wrangler: {
          configPath: "./wrangler.jsonc",
        },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            PAIRING_SERVER_SECRET:
              "phase3-test-secret-0123456789-abcdefghijklmnopqrstuvwxyz",
            PAIRING_VERIFICATION_URI: "https://telechir.test/pair",
            REALTIME_SERVER_SECRET:
              "phase4-test-secret-0123456789-abcdefghijklmnopqrstuvwxyz",
            MCP_RESOURCE_URI: "https://telechir.test/mcp",
            OAUTH_ISSUER: "https://auth.telechir.test",
            OAUTH_JWKS_URI: "https://auth.telechir.test/jwks.json",
            OAUTH_SUBJECT_CLAIM: "sub",
            OAUTH_SCOPE_CLAIM: "scope",
            OPENAI_APPS_CHALLENGE_TOKEN:
              "openai-phase11-domain-challenge-test-token",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/setup.ts"],
      maxWorkers: 1,
    },
  };
});
