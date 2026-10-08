import assert from "node:assert/strict";
import { test } from "node:test";

import {
  fingerprintsMatch,
  LOOPBACK_HOSTS,
  parseArgs,
} from "./verify-local-tls.mjs";

test("accepts only loopback TLS endpoints and a public certificate", () => {
  for (const host of LOOPBACK_HOSTS) {
    const parsed = parseArgs([
      "--cert",
      "synthetic-local-cert.pem",
      "--host",
      host,
      "--port",
      "8987",
    ]);
    assert.equal(parsed.host, host);
    assert.equal(parsed.port, 8987);
  }
  for (const host of [
    "telechir.test",
    "example.com",
    "0.0.0.0",
    "192.168.1.10",
  ]) {
    assert.throws(
      () => parseArgs(["--cert", "test.crt", "--host", host]),
      /loopback/,
    );
  }
});

test("rejects invalid endpoints and missing certificate", () => {
  assert.throws(() => parseArgs([]), /certificate/);
  assert.throws(() => parseArgs(["--port", "8987"]), /certificate/);
  assert.throws(() => parseArgs(["--cert", "test.crt", "--port", "0"]), /port/);
  assert.throws(
    () => parseArgs(["--cert", "test.crt", "--port", "65536"]),
    /port/,
  );
  assert.throws(
    () => parseArgs(["--cert", "test.crt", "--timeout-ms", "20000"]),
    /Timeout/,
  );
  assert.throws(
    () => parseArgs(["--cert", "test.crt", "--insecure", "true"]),
    /Usage/,
  );
});

test("detects substituted certificates using SHA-256 fingerprint", () => {
  assert.equal(fingerprintsMatch("AA:BB:12", "aa:bb:12"), true);
  assert.equal(fingerprintsMatch("AA:BB:13", "AA:BB:12"), false);
  assert.equal(fingerprintsMatch(undefined, "AA:BB:12"), false);
});
