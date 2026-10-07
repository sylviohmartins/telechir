import http from "node:http";
import assert from "node:assert/strict";

import { BrowserAdapter } from "../src/server.mjs";

let fixturePort = 0;
let protectedHits = 0;
let websocketUpgrades = 0;

const fixture = http.createServer((request, response) => {
  if (request.url === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
      <html>
        <head><title>Telechir fixture</title></head>
        <body>
          <label>Email <input aria-label="Email"></label>
          <button type="button" onclick="document.querySelector('#result').textContent='clicked'">Save</button>
          <p id="result">idle</p>
        </body>
      </html>`);
    return;
  }
  if (request.url === "/redirect-private") {
    response.writeHead(302, {
      location: `http://localhost:${fixturePort}/protected`,
    });
    response.end();
    return;
  }
  if (request.url === "/subresource-private") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
      <html>
        <head><title>Subresource fixture</title></head>
        <body>
          <img src="http://localhost:${fixturePort}/protected" alt="blocked">
        </body>
      </html>`);
    return;
  }
  if (request.url === "/websocket-private") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
      <html>
        <head><title>WebSocket fixture</title></head>
        <body>
          <script>
            try {
              const socket = new WebSocket("ws://localhost:${fixturePort}/ws");
              socket.addEventListener("error", () => {});
            } catch {}
          </script>
        </body>
      </html>`);
    return;
  }
  if (request.url === "/protected") {
    protectedHits += 1;
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("should never be reached");
    return;
  }
  response.writeHead(404);
  response.end();
});

fixture.on("upgrade", (_request, socket) => {
  websocketUpgrades += 1;
  socket.destroy();
});

await new Promise((resolve, reject) => {
  fixture.once("error", reject);
  fixture.listen(0, "127.0.0.1", resolve);
});

const address = fixture.address();
if (!address || typeof address === "string") {
  throw new Error("fixture did not bind");
}
fixturePort = address.port;

const adapter = new BrowserAdapter({
  allowLoopbackForTest: true,
  sessionTtlSeconds: 60,
  maxSessions: 1,
});

try {
  const health = await adapter.health();
  assert.equal(health.adapter, "playwright");
  assert.equal(health.ready, true);
  assert.equal(health.persistent_profile, false);

  const opened = await adapter.execute("browser.session.open", {});
  assert.equal(opened.isolated, true);
  assert.equal(opened.persistent, false);

  const id = opened.browser_session_id;
  const navigated = await adapter.execute("browser.navigate", {
    browser_session_id: id,
    url: `http://127.0.0.1:${address.port}/`,
  });
  assert.equal(navigated.title, "Telechir fixture");

  const before = await adapter.execute("browser.snapshot", {
    browser_session_id: id,
  });
  assert.match(before.snapshot, /Email/u);
  assert.match(before.snapshot, /Save/u);
  assert.equal(before.untrusted, true);

  await adapter.execute("browser.fill", {
    browser_session_id: id,
    locator: { kind: "label", value: "Email", exact: true },
    text: "person@example.com",
  });
  await adapter.execute("browser.click", {
    browser_session_id: id,
    locator: {
      kind: "role",
      role: "button",
      name: "Save",
      exact: true,
    },
  });

  const after = await adapter.execute("browser.snapshot", {
    browser_session_id: id,
  });
  assert.match(after.snapshot, /clicked/u);

  await assert.rejects(
    () =>
      adapter.execute("browser.navigate", {
        browser_session_id: id,
        url: `http://127.0.0.1:${address.port}/redirect-private`,
      }),
    (error) => error?.code === "POLICY_DENIED",
  );
  assert.equal(protectedHits, 0, "redirect must not reach localhost target");

  const subresource = await adapter.execute("browser.navigate", {
    browser_session_id: id,
    url: `http://127.0.0.1:${address.port}/subresource-private`,
  });
  assert.equal(subresource.title, "Subresource fixture");
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(
    protectedHits,
    0,
    "subresource request must not bypass the egress proxy",
  );

  const websocketPage = await adapter.execute("browser.navigate", {
    browser_session_id: id,
    url: `http://127.0.0.1:${address.port}/websocket-private`,
  });
  assert.equal(websocketPage.title, "WebSocket fixture");
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(
    websocketUpgrades,
    0,
    "WebSocket request must be blocked before reaching the target server",
  );

  const closed = await adapter.execute("browser.session.close", {
    browser_session_id: id,
  });
  assert.equal(closed.closed, true);
  assert.equal(closed.already_closed, false);

  const secondClose = await adapter.execute("browser.session.close", {
    browser_session_id: id,
  });
  assert.equal(secondClose.already_closed, true);

  console.log(
    JSON.stringify({
      smoke: "PASS",
      isolated: true,
      persistent_profile: false,
      redirect_private_blocked: true,
      subresource_private_blocked: true,
      websocket_blocked: true,
      protected_hits: protectedHits,
      websocket_upgrades: websocketUpgrades,
    }),
  );
} finally {
  await adapter.shutdown();
  await new Promise((resolve) => fixture.close(resolve));
}
