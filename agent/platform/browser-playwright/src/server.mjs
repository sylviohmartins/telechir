import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { chromium, errors as playwrightErrors } from "playwright";

import {
  NetworkPolicyError,
  createEgressProxy,
  resolvePublicTarget,
} from "./network-policy.mjs";

const require = createRequire(import.meta.url);
const PLAYWRIGHT_VERSION = require("playwright/package.json").version;
const MAX_SNAPSHOT_BYTES = 48 * 1024;
const MAX_TITLE_CHARS = 512;
const MAX_LOCATOR_VALUE_CHARS = 256;
const MAX_FILL_TEXT_CHARS = 2_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const NAVIGATION_TIMEOUT_MS = 12_000;

class AdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AdapterError";
    this.code = code;
  }
}

function parseArgs(argv) {
  const result = {
    stdio: false,
    sessionTtlSeconds: 900,
    maxSessions: 2,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--stdio") {
      result.stdio = true;
    } else if (value === "--session-ttl-seconds") {
      result.sessionTtlSeconds = Number(argv[++index]);
    } else if (value === "--max-sessions") {
      result.maxSessions = Number(argv[++index]);
    } else {
      throw new AdapterError("INVALID_ARGUMENT", "unknown adapter argument");
    }
  }
  if (
    !result.stdio ||
    !Number.isInteger(result.sessionTtlSeconds) ||
    result.sessionTtlSeconds < 30 ||
    result.sessionTtlSeconds > 3600 ||
    !Number.isInteger(result.maxSessions) ||
    result.maxSessions < 1 ||
    result.maxSessions > 4
  ) {
    throw new AdapterError("INVALID_ARGUMENT", "invalid adapter configuration");
  }
  return result;
}

function requireObject(value, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AdapterError("INVALID_ARGUMENT", message);
  }
  return value;
}

function requireExactKeys(object, allowed) {
  const allowedSet = new Set(allowed);
  if (Object.keys(object).some((key) => !allowedSet.has(key))) {
    throw new AdapterError(
      "INVALID_ARGUMENT",
      "browser request contains unsupported fields",
    );
  }
}

function boundedString(value, name, max) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    [...value].length > max ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new AdapterError(
      "INVALID_ARGUMENT",
      `${name} must be bounded non-control text`,
    );
  }
  return value;
}

function sessionId(value) {
  if (
    typeof value !== "string" ||
    value.length < 8 ||
    value.length > 96 ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new AdapterError("INVALID_ARGUMENT", "invalid browser_session_id");
  }
  return value;
}

const ALLOWED_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "checkbox",
  "radio",
  "combobox",
  "option",
  "menuitem",
  "tab",
  "heading",
  "listitem",
  "row",
  "cell",
  "switch",
  "slider",
  "spinbutton",
]);

export function validateLocatorShape(value) {
  const locator = requireObject(value, "locator must be an object");
  const kind = locator.kind;
  if (kind === "role") {
    requireExactKeys(locator, ["kind", "role", "name", "exact", "index"]);
    if (!ALLOWED_ROLES.has(locator.role)) {
      throw new AdapterError("INVALID_ARGUMENT", "role is not allowed");
    }
    boundedString(locator.name, "locator name", MAX_LOCATOR_VALUE_CHARS);
  } else if (["label", "text", "placeholder"].includes(kind)) {
    requireExactKeys(locator, ["kind", "value", "exact", "index"]);
    boundedString(locator.value, "locator value", MAX_LOCATOR_VALUE_CHARS);
  } else if (kind === "test_id") {
    requireExactKeys(locator, ["kind", "value", "index"]);
    boundedString(locator.value, "test id", MAX_LOCATOR_VALUE_CHARS);
  } else {
    throw new AdapterError("INVALID_ARGUMENT", "locator kind is not allowed");
  }
  if (locator.exact !== undefined && typeof locator.exact !== "boolean") {
    throw new AdapterError("INVALID_ARGUMENT", "locator exact must be boolean");
  }
  if (
    locator.index !== undefined &&
    (!Number.isInteger(locator.index) || locator.index < 0 || locator.index > 9)
  ) {
    throw new AdapterError(
      "INVALID_ARGUMENT",
      "locator index must be between 0 and 9",
    );
  }
  return locator;
}

function playwrightLocator(page, shape) {
  const locator = validateLocatorShape(shape);
  let result;
  if (locator.kind === "role") {
    result = page.getByRole(locator.role, {
      name: locator.name,
      exact: locator.exact ?? false,
    });
  } else if (locator.kind === "label") {
    result = page.getByLabel(locator.value, {
      exact: locator.exact ?? false,
    });
  } else if (locator.kind === "text") {
    result = page.getByText(locator.value, {
      exact: locator.exact ?? false,
    });
  } else if (locator.kind === "placeholder") {
    result = page.getByPlaceholder(locator.value, {
      exact: locator.exact ?? false,
    });
  } else {
    result = page.getByTestId(locator.value);
  }
  return locator.index === undefined ? result : result.nth(locator.index);
}

async function requireUniqueLocator(page, shape) {
  const locator = playwrightLocator(page, shape);
  if (shape.index === undefined) {
    const count = await locator.count();
    if (count !== 1) {
      throw new AdapterError(
        "CONFLICT",
        "browser locator must resolve to exactly one element",
      );
    }
  }
  return locator;
}

export function truncateUtf8(value, maxBytes) {
  const source = Buffer.from(value, "utf8");
  if (source.length <= maxBytes) {
    return { value, truncated: false };
  }
  let end = maxBytes;
  while (end > 0 && (source[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return {
    value: source.subarray(0, Math.max(0, end)).toString("utf8"),
    truncated: true,
  };
}

function safeTitle(value) {
  return [...String(value)].slice(0, MAX_TITLE_CHARS).join("");
}

function safeError(error) {
  if (error instanceof AdapterError || error instanceof NetworkPolicyError) {
    return { code: error.code ?? "POLICY_DENIED", message: error.message };
  }
  if (error instanceof playwrightErrors.TimeoutError) {
    return { code: "TIMEOUT", message: "browser action timed out" };
  }
  return {
    code: "INTERNAL_ERROR",
    message: "browser adapter operation failed",
  };
}

export class BrowserAdapter {
  constructor({
    sessionTtlSeconds = 900,
    maxSessions = 2,
    allowLoopbackForTest = false,
  } = {}) {
    this.sessionTtlMs = sessionTtlSeconds * 1000;
    this.maxSessions = maxSessions;
    this.allowLoopbackForTest = allowLoopbackForTest;
    this.sessions = new Map();
    this.browser = null;
    this.proxy = null;
  }

  async health() {
    try {
      await this.ensureBrowser();
      return {
        adapter: "playwright",
        version: PLAYWRIGHT_VERSION,
        browser: "chromium",
        ready: true,
        persistent_profile: false,
      };
    } catch {
      return {
        adapter: "playwright",
        version: PLAYWRIGHT_VERSION,
        browser: "chromium",
        ready: false,
        persistent_profile: false,
      };
    }
  }

  async ensureBrowser() {
    if (this.browser?.isConnected()) {
      return this.browser;
    }
    if (!this.proxy) {
      this.proxy = await createEgressProxy({
        allowLoopbackForTest: this.allowLoopbackForTest,
      });
    }
    this.browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
      proxy: { server: this.proxy.url },
      args: [
        "--disable-quic",
        "--dns-prefetch-disable",
        "--disable-features=WebTransport",
      ],
    });
    this.browser.on("disconnected", () => {
      this.sessions.clear();
      this.browser = null;
    });
    return this.browser;
  }

  async cleanupExpired() {
    const now = Date.now();
    const expired = [...this.sessions.entries()].filter(
      ([, session]) => session.expiresAt <= now,
    );
    for (const [id, session] of expired) {
      this.sessions.delete(id);
      await session.context.close().catch(() => {});
    }
  }

  async open() {
    await this.cleanupExpired();
    if (this.sessions.size >= this.maxSessions) {
      throw new AdapterError(
        "RATE_LIMITED",
        "browser session concurrency limit reached",
      );
    }
    const browser = await this.ensureBrowser();
    const context = await browser.newContext({
      acceptDownloads: false,
      serviceWorkers: "block",
      ignoreHTTPSErrors: false,
      javaScriptEnabled: true,
      viewport: { width: 1280, height: 720 },
    });
    await context.routeWebSocket("**", async (webSocket) => {
      await webSocket.close({
        code: 1008,
        reason: "WebSocket disabled by Telechir Phase 14 policy",
      });
    });
    await context.addInitScript(() => {
      for (const key of [
        "RTCPeerConnection",
        "webkitRTCPeerConnection",
        "WebTransport",
      ]) {
        try {
          Object.defineProperty(globalThis, key, {
            value: undefined,
            configurable: false,
            writable: false,
          });
        } catch {}
      }
    });
    context.on("dialog", (dialog) => {
      void dialog.dismiss().catch(() => {});
    });
    context.on("download", (download) => {
      void download.cancel().catch(() => {});
    });
    const page = await context.newPage();
    page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    context.on("page", (candidate) => {
      if (candidate !== page) {
        void candidate.close().catch(() => {});
      }
    });

    const id = `browser_${randomUUID().replaceAll("-", "")}`;
    const now = Date.now();
    const session = {
      id,
      context,
      page,
      createdAt: now,
      expiresAt: now + this.sessionTtlMs,
    };
    this.sessions.set(id, session);
    return {
      browser_session_id: id,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(session.expiresAt).toISOString(),
      isolated: true,
      persistent: false,
    };
  }

  async session(argumentsObject) {
    await this.cleanupExpired();
    const args = requireObject(
      argumentsObject,
      "browser arguments must be object",
    );
    const id = sessionId(args.browser_session_id);
    const session = this.sessions.get(id);
    if (!session) {
      throw new AdapterError(
        "NOT_FOUND",
        "browser session was not found or expired",
      );
    }
    if (!session.page || session.page.isClosed()) {
      this.sessions.delete(id);
      await session.context.close().catch(() => {});
      throw new AdapterError("NOT_FOUND", "browser session page is closed");
    }
    return session;
  }

  async snapshot(argumentsObject) {
    requireExactKeys(argumentsObject, ["browser_session_id"]);
    const session = await this.session(argumentsObject);
    const raw = await session.page.locator("body").ariaSnapshot({
      timeout: DEFAULT_TIMEOUT_MS,
    });
    const snapshot = truncateUtf8(raw, MAX_SNAPSHOT_BYTES);
    return {
      browser_session_id: session.id,
      url: session.page.url(),
      title: safeTitle(await session.page.title()),
      snapshot: snapshot.value,
      captured_at: new Date().toISOString(),
      untrusted: true,
      truncated: snapshot.truncated,
    };
  }

  async navigate(argumentsObject) {
    requireExactKeys(argumentsObject, ["browser_session_id", "url"]);
    const session = await this.session(argumentsObject);
    const target = boundedString(argumentsObject.url, "url", 4096);
    await resolvePublicTarget(target, {
      allowLoopbackForTest: this.allowLoopbackForTest,
    });
    const response = await session.page.goto(target, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    });
    await resolvePublicTarget(session.page.url(), {
      allowLoopbackForTest: this.allowLoopbackForTest,
    });
    const denied = response
      ? await response.headerValue("x-telechir-policy-denied")
      : null;
    if (denied === "1") {
      throw new AdapterError(
        "POLICY_DENIED",
        "browser navigation was blocked by egress policy",
      );
    }
    return {
      browser_session_id: session.id,
      url: session.page.url(),
      title: safeTitle(await session.page.title()),
      completed_at: new Date().toISOString(),
      untrusted: true,
    };
  }

  async click(argumentsObject) {
    requireExactKeys(argumentsObject, ["browser_session_id", "locator"]);
    const session = await this.session(argumentsObject);
    const locatorShape = requireObject(
      argumentsObject.locator,
      "locator must be object",
    );
    const locator = await requireUniqueLocator(session.page, locatorShape);
    await locator.click({ timeout: DEFAULT_TIMEOUT_MS });
    return {
      accepted: true,
      browser_session_id: session.id,
      url: session.page.url(),
      completed_at: new Date().toISOString(),
    };
  }

  async fill(argumentsObject) {
    requireExactKeys(argumentsObject, [
      "browser_session_id",
      "locator",
      "text",
    ]);
    const session = await this.session(argumentsObject);
    const text = boundedString(
      argumentsObject.text,
      "fill text",
      MAX_FILL_TEXT_CHARS,
    );
    const locatorShape = requireObject(
      argumentsObject.locator,
      "locator must be object",
    );
    const locator = await requireUniqueLocator(session.page, locatorShape);
    await locator.fill(text, { timeout: DEFAULT_TIMEOUT_MS });
    return {
      accepted: true,
      browser_session_id: session.id,
      url: session.page.url(),
      completed_at: new Date().toISOString(),
    };
  }

  async close(argumentsObject) {
    requireExactKeys(argumentsObject, ["browser_session_id"]);
    const args = requireObject(
      argumentsObject,
      "browser arguments must be object",
    );
    const id = sessionId(args.browser_session_id);
    const session = this.sessions.get(id);
    if (!session) {
      return {
        closed: true,
        already_closed: true,
        browser_session_id: id,
        completed_at: new Date().toISOString(),
      };
    }
    this.sessions.delete(id);
    await session.context.close().catch(() => {});
    return {
      closed: true,
      already_closed: false,
      browser_session_id: id,
      completed_at: new Date().toISOString(),
    };
  }

  async execute(operation, argumentsObject) {
    const args = requireObject(
      argumentsObject,
      "browser arguments must be object",
    );
    switch (operation) {
      case "health":
        requireExactKeys(args, []);
        return this.health();
      case "browser.session.open":
        requireExactKeys(args, []);
        return this.open();
      case "browser.snapshot":
        return this.snapshot(args);
      case "browser.navigate":
        return this.navigate(args);
      case "browser.click":
        return this.click(args);
      case "browser.fill":
        return this.fill(args);
      case "browser.session.close":
        return this.close(args);
      default:
        throw new AdapterError(
          "UNSUPPORTED_CAPABILITY",
          "browser operation is not supported",
        );
    }
  }

  async shutdown() {
    for (const session of this.sessions.values()) {
      await session.context.close().catch(() => {});
    }
    this.sessions.clear();
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
    if (this.proxy) {
      await this.proxy.close().catch(() => {});
      this.proxy = null;
    }
  }
}

async function runStdio() {
  const options = parseArgs(process.argv.slice(2));
  const adapter = new BrowserAdapter({
    sessionTtlSeconds: options.sessionTtlSeconds,
    maxSessions: options.maxSessions,
    allowLoopbackForTest:
      process.env.TELECHIR_BROWSER_TEST_ALLOW_LOOPBACK === "true",
  });
  const input = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
    terminal: false,
  });

  for await (const line of input) {
    if (!line.trim()) {
      continue;
    }
    let id = "invalid";
    try {
      if (Buffer.byteLength(line, "utf8") > 64 * 1024) {
        throw new AdapterError(
          "INVALID_ARGUMENT",
          "browser request is too large",
        );
      }
      const request = JSON.parse(line);
      const object = requireObject(request, "browser request must be object");
      requireExactKeys(object, ["id", "operation", "arguments"]);
      id = boundedString(object.id, "request id", 96);
      const operation = boundedString(object.operation, "operation", 64);
      const data = await adapter.execute(operation, object.arguments);
      process.stdout.write(`${JSON.stringify({ id, ok: true, data })}\n`);
    } catch (error) {
      const failure = safeError(error);
      process.stdout.write(
        `${JSON.stringify({ id, ok: false, error: failure })}\n`,
      );
    }
  }
  await adapter.shutdown();
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  runStdio().catch(() => {
    process.exitCode = 1;
  });
}
